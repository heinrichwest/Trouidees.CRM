import test from "node:test";
import assert from "node:assert/strict";
import { handleAgentRequest } from "../lib/agent-api.mjs";
import { hashToken } from "../lib/auth.mjs";
import { AgentStore } from "../lib/agent-store.mjs";

const token = "b".repeat(43);
const agentId = "11111111-1111-4111-8111-111111111111";
const leadId = "123e4567-e89b-42d3-a456-426614174000";
const claimId = "223e4567-e89b-42d3-a456-426614174000";
const scopes = ["leads:search", "leads:read", "conversations:write", "leads:update:limited", "outreach:claim", "outreach:read", "outreach:write"];
function setup({ grants = scopes, sqlResult = () => [], lead = { id:leadId, assignedTo:"Andrew" } } = {}) {
  const calls = []; const result = {};
  const db = { ensureSchema:async () => {}, sql:async (query, params) => {
    calls.push({ query, params });
    if (query.includes("UPDATE agent_keys SET last_used_at")) return params[0] === hashToken(token) ? [{ id:agentId, label:"Andrew", scopes:grants }] : [];
    return sqlResult(query, params);
  } };
  const store = {
    db, ready:async () => {},
    resolveContact:(contact, agent) => new AgentStore(db).resolveContact(contact, agent),
    appendConversation:async (input) => { calls.push({ append:input }); return { conversation:{ id:"conversation", ...input }, contactedAt:"2026-10-26T08:00:00Z", firstContact:true, allocationViolation:false }; },
    updateLeadLimited:async (...args) => ({ id:leadId, assignedTo:"Andrew", ...args[1] }),
  };
  const response = { writeHead(status) { result.status = status; }, end(text) { result.body = JSON.parse(text); } };
  const request = (method, url, body) => ({ method, url, headers:{ authorization:`Bearer ${token}`, host:"localhost" }, body });
  return { store, response, request, result, calls };
}
async function withNativeGate(value, callback) {
  const previous = process.env.AGENT_NATIVE_OUTREACH_ENABLED;
  if (value == null) delete process.env.AGENT_NATIVE_OUTREACH_ENABLED; else process.env.AGENT_NATIVE_OUTREACH_ENABLED = value;
  try { await callback(); } finally { if (previous == null) delete process.env.AGENT_NATIVE_OUTREACH_ENABLED; else process.env.AGENT_NATIVE_OUTREACH_ENABLED = previous; }
}

test("native routes require the flag and their dedicated scopes", async () => {
  await withNativeGate(undefined, async () => {
    const off = setup();
    await handleAgentRequest({ ...off, request:off.request("POST", "/api/agent/outreach/claim", { requestKey:"slot-1" }) });
    assert.equal(off.result.status, 503);
  });
  await withNativeGate("1", async () => {
    const missing = setup({ grants:["leads:search"] });
    await handleAgentRequest({ ...missing, request:missing.request("GET", "/api/agent/outreach/quota") });
    assert.equal(missing.result.status, 403);
  });
});

test("claim and claim updates reject caller identity, clock, limit, and unknown fields", async () => {
  await withNativeGate("1", async () => {
    for (const body of [{ requestKey:"slot", agent:"Other" }, { requestKey:"slot", now:"2026-10-26T08:00:00Z" }, { requestKey:"slot", limit:2 }, { requestKey:" " }]) {
      const ctx = setup();
      await handleAgentRequest({ ...ctx, request:ctx.request("POST", "/api/agent/outreach/claim", body) });
      assert.equal(ctx.result.status, 400);
    }
    const ctx = setup();
    await handleAgentRequest({ ...ctx, request:ctx.request("PATCH", `/api/agent/outreach/claims/${claimId}`, { state:"submitted", jobKey:"job-1", agent:"Other" }) });
    assert.equal(ctx.result.status, 400);
  });
});

test("claim and quota routes use the authenticated agent identity", async () => {
  await withNativeGate("1", async () => {
    const ctx = setup({ sqlResult:(query) => query.includes("crm_claim_ready_lead") ? [{ result:{ claim:{ id:claimId }, lead:{ id:leadId }, research:{ ready:true }, quota:{ agent:"Andrew", target:8 }, reason:null } }] : query.includes("SELECT\n      (SELECT COUNT(DISTINCT lead_id)") ? [{ delivered:2, outstanding:1 }] : [] });
    await handleAgentRequest({ ...ctx, request:ctx.request("POST", "/api/agent/outreach/claim", { requestKey:"slot-1" }) });
    assert.equal(ctx.result.status, 200);
    assert.equal(ctx.calls.find((call) => call.query?.includes("crm_claim_ready_lead")).params[0], "Andrew");
    await handleAgentRequest({ ...ctx, request:ctx.request("GET", "/api/agent/outreach/quota") });
    assert.equal(ctx.result.body.quota.delivered, 2);
    const claimUpdate = setup({ sqlResult:(query) => query.includes("crm_update_outreach_claim") ? [{ result:{ id:claimId, state:"submitted", jobKey:"job-1" } }] : [] });
    await handleAgentRequest({ ...claimUpdate, request:claimUpdate.request("PATCH", `/api/agent/outreach/claims/${claimId}`, { state:"submitted", jobKey:"job-1" }) });
    assert.equal(claimUpdate.result.status, 200);
    assert.equal(claimUpdate.calls.find((call) => call.query?.includes("crm_update_outreach_claim")).params[0], "Andrew");
  });
});

test("exact contact resolution returns no foreign lead identity and caps ambiguity at two", async () => {
  await withNativeGate("1", async () => {
    const cases = [
      { total:0, visible:0, leadId:null, expected:{ leadId:null, matchCount:0 } },
      { total:1, visible:1, leadId, expected:{ leadId, matchCount:1 } },
      { total:1, visible:0, leadId:null, expected:{ leadId:null, matchCount:1 } },
      { total:2, visible:1, leadId, expected:{ leadId:null, matchCount:2 } },
    ];
    for (const value of cases) {
      const matches = value.total === 0 ? [] : value.total === 1
        ? [{ id:value.leadId || leadId, owner:value.visible ? "Andrew" : "Other" }]
        : [{ id:leadId, owner:"Andrew" }, { id:"323e4567-e89b-42d3-a456-426614174000", owner:"Other" }];
      const ctx = setup({ sqlResult:(query) => query.includes("crm_normalize_za_phone") ? matches : [] });
      await handleAgentRequest({ ...ctx, request:ctx.request("GET", "/api/agent/outreach/resolve-contact?contact=%2B27%2082%20123%204567") });
      assert.equal(ctx.result.status, 200);
      assert.deepEqual(ctx.result.body, value.expected);
    }
    const invalid = setup();
    await handleAgentRequest({ ...invalid, request:invalid.request("GET", "/api/agent/outreach/resolve-contact?contact=abc") });
    assert.equal(invalid.result.status, 400);
  });
});

test("native conversation requires the native write scope and keeps the legacy body contract", async () => {
  const payload = { segmentId:"native-whatsapp:v1:hash", idempotencyKey:"native-whatsapp:v1:hash", channel:"whatsapp", summary:"WhatsApp message delivered", occurredAt:null, messages:[{ direction:"outgoing", speaker:"Andrew", body:"  Hello 🛰️\n", timestamp:null }], nativeDelivery:{ state:"delivered", claimId:null } };
  await withNativeGate(undefined, async () => {
    const ctx = setup();
    await handleAgentRequest({ ...ctx, request:ctx.request("POST", `/api/agent/leads/${leadId}/conversations`, payload) });
    assert.equal(ctx.result.status, 503);
  });
  await withNativeGate("1", async () => {
    const denied = setup({ grants:scopes.filter((scope) => scope !== "outreach:write") });
    await handleAgentRequest({ ...denied, request:denied.request("POST", `/api/agent/leads/${leadId}/conversations`, payload) });
    assert.equal(denied.result.status, 403);
    const ok = setup();
    await handleAgentRequest({ ...ok, request:ok.request("POST", `/api/agent/leads/${leadId}/conversations`, payload) });
    assert.equal(ok.result.status, 200);
    assert.equal(ok.result.body.contactedAt, "2026-10-26T08:00:00Z");
    assert.equal(ok.calls.find((call) => call.append).append.messages[0].body, "  Hello 🛰️\n");
    for (const invalid of [ { ...payload, messages:[...payload.messages, ...payload.messages] }, { ...payload, occurredAt:"2026-10-26T08:00:00Z" }, { ...payload, nativeDelivery:{ state:"accepted", claimId:null } } ]) {
      const ctx = setup();
      await handleAgentRequest({ ...ctx, request:ctx.request("POST", `/api/agent/leads/${leadId}/conversations`, invalid) });
      assert.equal(ctx.result.status, 400);
    }
    const future = new Date(Date.now() + 60_000).toISOString();
    const futureTime = setup();
    await handleAgentRequest({ ...futureTime, request:futureTime.request("POST", `/api/agent/leads/${leadId}/conversations`, { ...payload, occurredAt:future, messages:[{ ...payload.messages[0], timestamp:future }] }) });
    assert.equal(futureTime.result.status, 400);
  });
});

test("native lead repair is exclusive and needs both update and outreach scopes", async () => {
  await withNativeGate("1", async () => {
    const id = "323e4567-e89b-42d3-a456-426614174000";
    const ctx = setup();
    await handleAgentRequest({ ...ctx, request:ctx.request("PATCH", `/api/agent/leads/${leadId}`, { nativeConversationId:id, status:"Contacted" }) });
    assert.equal(ctx.result.status, 400);
    const missing = setup({ grants:scopes.filter((scope) => scope !== "outreach:write") });
    await handleAgentRequest({ ...missing, request:missing.request("PATCH", `/api/agent/leads/${leadId}`, { nativeConversationId:id }) });
    assert.equal(missing.result.status, 403);
    const success = setup({ sqlResult:(query) => query.includes("crm_finalize_native_delivery") ? [{ result:{ id:leadId, status:"Contacted", lastContactedAt:"2026-10-26T08:00:00Z", assignedTo:"Andrew" } }] : [] });
    await handleAgentRequest({ ...success, request:success.request("PATCH", `/api/agent/leads/${leadId}`, { nativeConversationId:id }) });
    assert.equal(success.result.status, 200);
    assert.equal(success.result.body.lead.status, "Contacted");
  });
});

test("legacy conversation payload remains usable while native outreach is disabled", async () => {
  await withNativeGate(undefined, async () => {
    const ctx = setup();
    await handleAgentRequest({ ...ctx, request:ctx.request("POST", `/api/agent/leads/${leadId}/conversations`, {
      segmentId:"legacy-segment", idempotencyKey:"legacy-idempotency", summary:"Legacy conversation",
      messages:[{ direction:"incoming", speaker:"contact", body:"hello", timestamp:null }],
    }) });
    assert.equal(ctx.result.status, 200);
    assert.equal(Object.hasOwn(ctx.calls.find((call) => call.append).append, "nativeDelivery"), false);
  });
});
