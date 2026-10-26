import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NeonStore } from "../lib/neon-store.mjs";
import { AgentStore } from "../lib/agent-store.mjs";
import { AgentOutreachStore } from "../lib/agent-outreach-store.mjs";
import { AGENT_SCOPES, createAgentKey } from "../lib/agent-auth.mjs";
import { handleAgentRequest } from "../lib/agent-api.mjs";

const databaseUrl = process.env.AGENT_TEST_DATABASE_URL;
const salesRoot = process.env.SALES_OPS_SOURCE_ROOT;
const pluginRoot = resolve("integrations/hermes-crm-plugin");
const driver = resolve("test/fixtures/native-crm-driver.py");
const tokenScopes = AGENT_SCOPES;

function runDriver(input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("python3", [driver], { stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONPATH: [pluginRoot, salesRoot].filter(Boolean).join(":"),
        CRM_PLUGIN_SOURCE_ROOT: pluginRoot, SALES_OPS_SOURCE_ROOT: salesRoot || "" } });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise(JSON.parse(stdout)) : reject(new Error(stderr || `driver exited ${code}`)));
    child.stdin.end(JSON.stringify(input));
  });
}

test("two agents research, claim, replay delivery, and classify no reply across CRM and SALES", {
  skip: !databaseUrl ? "Set AGENT_TEST_DATABASE_URL to a disposable database with the CRM migrations applied." : false,
}, async () => {
  assert.ok(salesRoot, "Set SALES_OPS_SOURCE_ROOT to the isolated SALES checkout for cross-ledger acceptance.");
  const neon = new NeonStore(databaseUrl);
  const store = new AgentStore(neon);
  const outreach = new AgentOutreachStore(neon);
  const server = createServer((request, response) => {
    handleAgentRequest({ request, response, store }).catch((error) => {
      if (!response.headersSent) response.writeHead(error.status || 500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error.message || "request failed" }));
    });
  });
  const temporary = await mkdtemp(join(tmpdir(), "native-crm-flow-"));
  const agentA = `flow-a-${randomUUID()}`;
  const agentB = `flow-b-${randomUUID()}`;
  const actorId = randomUUID();
  const leadIds = Array.from({ length: 10 }, () => randomUUID());
  const keys = [];
  let baseUrl;
  let lostPatch = false;
  let acknowledgedCursor = 0;
  const previousNativeFlag = process.env.AGENT_NATIVE_OUTREACH_ENABLED;
  const plainRequest = async (secret, method, path, body) => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: {
      authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}),
    }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  try {
    process.env.AGENT_NATIVE_OUTREACH_ENABLED = "1";
    await store.ready();
    await neon.sql("INSERT INTO app_users (id,email,password_hash,role) VALUES ($1,$2,'x','admin')",
      [actorId, `${actorId}@example.test`]);
    const createdA = await createAgentKey(store, { label: agentA, scopes: tokenScopes, createdBy: null });
    const createdB = await createAgentKey(store, { label: agentB, scopes: tokenScopes, createdBy: null });
    keys.push(createdA.key.id, createdB.key.id);
    await new Promise((resolvePromise, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolvePromise()));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    server.on("request", (request, response) => {
      if (request.method === "PATCH" && /^\/api\/agent\/leads\/[0-9a-f-]+$/.test(request.url) && !lostPatch) {
        response.end = (...args) => { lostPatch = true; response.socket.destroy(); return response; };
      }
    });

    const researchDoc = { researchedAt: "2026-10-26T08:00:00.000Z", ready: true, messageable: true,
      research: { confidence: "high", angle: "maths tutoring", dossierRef: null,
        facts: [{ text: "Offers maths tutoring", sourceUrl: "https://example.test/about" }] } };
    for (const [index, leadId] of leadIds.entries()) {
      const data = { id: leadId, leadType: "Native flow integration", name: `Flow Lead ${index}`,
        phone: `2780000${String(index).padStart(4, "0")}`, email: "", assignedTo: "",
        status: index === 9 ? "Contacted" : "New", lastContactedAt: "", nextFollowUpAt: "" };
      await neon.sql("INSERT INTO crm_leads (id,lead_type,phone,data) VALUES ($1,$2,$3,$4::jsonb)",
        [leadId, data.leadType, data.phone, JSON.stringify(data)]);
      await outreach.putResearch(leadId, researchDoc, { kind: "crm", userId: actorId });
    }

    const [claimAResponse, claimBResponse] = await Promise.all([
      plainRequest(createdA.secret, "POST", "/api/agent/outreach/claim", { requestKey: `first-${randomUUID()}` }),
      plainRequest(createdB.secret, "POST", "/api/agent/outreach/claim", { requestKey: `first-${randomUUID()}` }),
    ]);
    assert.equal(claimAResponse.status, 200);
    assert.equal(claimBResponse.status, 200);
    const claimA = claimAResponse.body;
    const claimB = claimBResponse.body;
    assert.ok(claimA.claim && claimB.claim);
    assert.notEqual(claimA.lead.id, claimB.lead.id);
    assert.equal(claimA.lead.assignedTo, agentA);
    assert.equal(claimB.lead.assignedTo, agentB);
    assert.ok(claimA.research.research.facts.length);

    const requestA = `native-outreach:${claimA.claim.id}`;
    const requestB = `native-outreach:${claimB.claim.id}`;
    for (const [created, claim, jobKey] of [[createdA, claimA, requestA], [createdB, claimB, requestB]]) {
      const response = await plainRequest(created.secret, "PATCH", `/api/agent/outreach/claims/${claim.claim.id}`,
        { state: "submitted", jobKey });
      assert.equal(response.status, 200);
    }

    const statePath = join(temporary, "native_delivery.sqlite3");
    const deliveryRequest = { baseUrl, apiKey: createdA.secret, statePath, namespace: "test-native-flow",
      account: "test-account", speaker: agentA,
      event: { id: randomUUID(), outbox_id: randomUUID(), state: "delivered", text: "Exact rendered opener 🛰️",
        request_id: requestA, job: { id: "job-flow-a", lead_id: claimA.lead.id } },
      binding: { lead_id: claimA.lead.id, claim_id: claimA.claim.id } };
    await assert.rejects(runDriver(deliveryRequest));
    let counts = await neon.sql(`SELECT
      (SELECT COUNT(*)::int FROM lead_conversations WHERE lead_id=$1) AS conversations,
      (SELECT COUNT(*)::int FROM lead_first_contacts WHERE lead_id=$1) AS first_contacts`, [claimA.lead.id]);
    assert.deepEqual([counts[0].conversations, counts[0].first_contacts], [1, 1]);
    const replay = await runDriver(deliveryRequest);
    assert.equal(replay.applied, true);
    counts = await neon.sql(`SELECT
      (SELECT COUNT(*)::int FROM lead_conversations WHERE lead_id=$1) AS conversations,
      (SELECT COUNT(*)::int FROM lead_first_contacts WHERE lead_id=$1) AS first_contacts`, [claimA.lead.id]);
    assert.deepEqual([counts[0].conversations, counts[0].first_contacts], [1, 1]);
    acknowledgedCursor = 1;
    assert.deepEqual({ conversationCount: counts[0].conversations, firstContactCount: counts[0].first_contacts, acknowledgedCursor },
      { conversationCount: 1, firstContactCount: 1, acknowledgedCursor: 1 });
    const accepted = await runDriver({ ...deliveryRequest, event: { ...deliveryRequest.event, state: "accepted" } });
    assert.equal(accepted.ignored, true);
    assert.equal((await neon.sql("SELECT COUNT(*)::int AS n FROM lead_conversations WHERE lead_id=$1", [claimA.lead.id]))[0].n, 1);

    // Persisted delivery receipt is dated to the exact Friday boundary for the no-reply decision.
    await neon.sql("UPDATE lead_first_contacts SET effective_delivered_at='2026-10-16T08:15:00Z',source_time_known=TRUE WHERE lead_id=$1", [claimA.lead.id]);
    const inbound = await plainRequest(createdA.secret, "POST", `/api/agent/leads/${claimA.lead.id}/conversations`, {
      segmentId: `reply-${randomUUID()}`, idempotencyKey: `reply-${randomUUID()}`, channel: "whatsapp",
      summary: "Lead replied.", messages: [{ direction: "incoming", speaker: "contact", body: "Thanks", timestamp: "2026-10-26T08:16:00Z" }],
    });
    assert.equal(inbound.status, 200);
    const veto = await plainRequest(createdA.secret, "POST", `/api/agent/leads/${claimA.lead.id}/no-reply`,
      { firstConversationId: (await neon.sql("SELECT first_conversation_id AS id FROM lead_first_contacts WHERE lead_id=$1", [claimA.lead.id]))[0].id });
    assert.equal(veto.status, 200);
    assert.equal(veto.body.reason, "replied");

    // Deliver the second agent's claim and age only its verified first-contact clock for this test.
    const requestBResult = await runDriver({ ...deliveryRequest, apiKey: createdB.secret, speaker: agentB,
      event: { ...deliveryRequest.event, id: randomUUID(), outbox_id: randomUUID(), request_id: requestB,
        job: { id: "job-flow-b", lead_id: claimB.lead.id } },
      binding: { lead_id: claimB.lead.id, claim_id: claimB.claim.id } });
    assert.equal(requestBResult.applied, true);
    await neon.sql("UPDATE lead_first_contacts SET effective_delivered_at='2026-10-16T08:15:00Z',source_time_known=TRUE WHERE lead_id=$1", [claimB.lead.id]);
    const reportingProfile = join(temporary, "sales-profile");
    await mkdir(reportingProfile, { recursive: true });
    await writeFile(join(reportingProfile, "sales-ops.json"), JSON.stringify({ profile: reportingProfile, agent_name: agentB,
      manager_name: "Manager", product_name: "Product", crm_plugin: pluginRoot }));
    await writeFile(join(reportingProfile, ".env"), `CRM_API_BASE_URL=${baseUrl}\nCRM_AGENT_API_KEY=${createdB.secret}\n`);
    const report = await runDriver({ mode: "sync_no_reply", baseUrl, apiKey: createdB.secret, profile: reportingProfile,
      agent: agentB, now: "2026-10-26T10:15:00+02:00" });
    assert.equal(report.result.recorded, 1);
    assert.equal(report.reportOutcome.outcome, "no_reply");
    assert.ok(report.reportOutcome.crm_outcome_id);
    const activity = await plainRequest(createdB.secret, "GET", `/api/agent/leads/${claimB.lead.id}/activity`);
    assert.equal(activity.status, 200);
    assert.ok(activity.body.activity.some((entry) => entry.type === "outcome" && entry.outcome === "no_reply"));

    const claims = [claimA, claimB];
    for (let i = 0; i < 7; i += 1) {
      const next = await plainRequest(createdA.secret, "POST", "/api/agent/outreach/claim", { requestKey: `a-more-${i}-${randomUUID()}` });
      assert.ok(next.body.claim);
      claims.push(next.body);
    }
    const ninth = await plainRequest(createdA.secret, "POST", "/api/agent/outreach/claim", { requestKey: `a-ninth-${randomUUID()}` });
    assert.equal(ninth.body.claim, null);
    assert.equal(ninth.body.reason, "capacity_held");
    assert.ok(!claims.some(({ lead }) => lead.id === leadIds[9]), "previously contacted lead must stay outside the ready pool");
  } finally {
    await new Promise((resolvePromise) => server.listening ? server.close(resolvePromise) : resolvePromise());
    for (const keyId of keys) await neon.sql("DELETE FROM agent_keys WHERE id=$1", [keyId]).catch(() => {});
    await neon.sql("DELETE FROM crm_leads WHERE id=ANY($1::uuid[])", [leadIds]).catch(() => {});
    await neon.sql("DELETE FROM app_users WHERE id=$1", [actorId]).catch(() => {});
    await neon.pool?.end?.();
    await rm(temporary, { recursive: true, force: true });
    if (previousNativeFlag == null) delete process.env.AGENT_NATIVE_OUTREACH_ENABLED;
    else process.env.AGENT_NATIVE_OUTREACH_ENABLED = previousNativeFlag;
  }
});
