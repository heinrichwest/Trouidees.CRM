import test from "node:test";
import assert from "node:assert/strict";
import { handleEnrichmentRequest } from "../lib/enrichment-api.mjs";

function harness({ method = "POST", path = "/api/crm/enrichment-batches", body = {}, user = { id: "admin-1", role: "admin", active: true }, db = { sql: async () => [] }, client = {} } = {}) {
  const request = { method, url: path, headers: { host: "localhost" }, body };
  const response = { writeHead(status) { this.status = status; }, end(serialized) { this.body = JSON.parse(serialized); } };
  return { request, response, user, db, client };
}

class BatchDb {
  constructor(leads) { this.leads = new Map(leads.map((lead) => [lead.id, lead])); this.batches = new Map(); this.operations = new Map(); this.attempts = new Map(); }
  async sql(query, parameters) {
    if (query.includes("crm_create_enrichment_batch")) {
      const [userId, requestKey, leadIds] = parameters;
      let batch = [...this.batches.values()].find((item) => item.userId === userId && item.requestKey === requestKey);
      if (batch && (batch.leadIds.length !== leadIds.length || leadIds.some((id) => !batch.leadIds.includes(id)))) throw Object.assign(new Error("BATCH_CONFLICT"), { status: 409 });
      if (!batch) {
        batch = { id: "10000000-0000-4000-8000-000000000001", userId, requestKey, leadIds: [...leadIds], status: "queued", items: leadIds.map((leadId) => ({ leadId, state: "queued", attemptId: null, report: null, research: null, reason: null, creditsUsed: null, usage: null })) };
        this.batches.set(batch.id, batch);
      }
      return [{ id: batch.id }];
    }
    if (query.includes("crm_claim_enrichment_item")) {
      const [batchId, operationKey] = parameters;
      const operationKeyFull = `${batchId}:${operationKey}`;
      if (this.operations.has(operationKeyFull)) return [{ result: { attempt: null, replay: true, result: this.operations.get(operationKeyFull).result } }];
      const batch = this.batches.get(batchId);
      if (batch.items.some((item) => item.state === "running")) return [{ result: { attempt: null, replay: false, result: null } }];
      const item = batch.items.find(({ state }) => state === "queued");
      if (!item) return [{ result: { attempt: null, replay: false, result: null } }];
      const started = new Date();
      const attempt = { id: `20000000-0000-4000-8000-${String(this.attempts.size + 1).padStart(12, "0")}`, batchId, leadId: item.leadId, startedAt: started.toISOString(), leaseUntil: new Date(started.getTime() + 10 * 60_000).toISOString() };
      item.state = "running"; item.attemptId = attempt.id; batch.status = "running";
      this.attempts.set(attempt.id, { item, batch, operationKeyFull });
      this.operations.set(operationKeyFull, { result: null });
      return [{ result: { attempt, replay: false, result: null } }];
    }
    if (query.includes("SELECT id, data, do_not_contact FROM crm_leads")) {
      const lead = this.leads.get(parameters[0]);
      return lead ? [{ id: lead.id, data: lead, do_not_contact: Boolean(lead.doNotContact) }] : [];
    }
    if (query.includes("crm_complete_enrichment_attempt")) {
      const [attemptId, raw] = parameters;
      const result = JSON.parse(raw);
      const context = this.attempts.get(attemptId);
      Object.assign(context.item, { state: result.state, report: result.report || null, research: result.research || null, reason: result.reason || null, creditsUsed: result.creditsUsed, usage: result.usage });
      context.batch.status = context.batch.items.some((item) => item.state === "queued") ? "queued" : "completed";
      this.operations.get(context.operationKeyFull).result = result;
      return [{ result: { batchId: context.batch.id, applied: true } }];
    }
    if (query.includes("FROM crm_enrichment_batches WHERE id=$1")) {
      const batch = this.batches.get(parameters[0]);
      return batch ? [{ id: batch.id, requestKey: batch.requestKey, leadIds: batch.leadIds, status: batch.status, createdAt: "2026-10-26T08:00:00Z", updatedAt: "2026-10-26T08:00:00Z" }] : [];
    }
    if (query.includes("FROM crm_enrichment_items item")) {
      const batch = this.batches.get(parameters[0]);
      return batch.items.map((item) => ({ ...item, lead: this.leads.get(item.leadId) }));
    }
    throw new Error(`Unexpected query: ${query}`);
  }
}

test("batch start requires admin before touching the CRM store", async () => {
  let calls = 0;
  const args = harness({ user: { id: "sales-1", role: "sales", active: true }, db: { sql: async () => { calls += 1; return []; } } });
  assert.equal(await handleEnrichmentRequest(args), true);
  assert.equal(args.response.status, 403);
  assert.equal(calls, 0);
});

test("batch start reports an actionable error when Neon enrichment migrations are missing", async () => {
  const db = {
    async sql() {
      throw Object.assign(new Error("function crm_create_enrichment_batch(uuid, text, uuid[]) does not exist"), { code: "42883" });
    },
  };
  const request = harness({
    body: {
      requestKey: "missing-migration",
      leadIds: ["20000000-0000-4000-8000-000000000001"],
    },
    user: { id: "10000000-0000-4000-8000-000000000001", role: "admin", active: true },
    db,
  });

  await handleEnrichmentRequest(request);

  assert.equal(request.response.status, 503);
  assert.equal(request.response.body.error, "CRM enrichment database schema is missing. Apply the Neon migrations, then retry.");
});

test("batch start rejects duplicate or excessive selections before persistence", async () => {
  let calls = 0;
  const args = harness({ body: { requestKey: "request-1", leadIds: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"] }, db: { sql: async () => { calls += 1; return []; } } });
  await handleEnrichmentRequest(args);
  assert.equal(args.response.status, 400);
  assert.equal(calls, 0);
});

test("missing Neon database returns a service-unavailable response", async () => {
  const args = harness({ db: null });
  await handleEnrichmentRequest(args);
  assert.equal(args.response.status, 503);
});

test("ordinary CRM imports do not invoke the explicit enrichment workflow", async () => {
  let providerCalls = 0;
  const args = harness({ method: "POST", path: "/api/crm/import", client: { async mapAndScrape() { providerCalls += 1; } } });
  assert.equal(await handleEnrichmentRequest(args), false);
  assert.equal(providerCalls, 0);
});

test("only selected IDs are enriched and a lost result response does not repeat provider work", async () => {
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
  const db = new BatchDb(ids.map((id) => ({ id, name: id, organization: "Studio", website: `https://${id}.example.test`, phone: "0821234567", assignedTo: "", status: "New" })));
  let providerCalls = 0;
  const client = { async mapAndScrape(url) {
    providerCalls += 1;
    return { data: [{ markdown: `The studio at ${url} provides portrait photography and weekend family sessions.`, metadata: { sourceURL: url } }], warnings: [], creditsUsed: 0, usage: { reportedTotal: 0, reportedSubtotal: 0, complete: true } };
  } };
  const user = { id: "00000000-0000-4000-8000-000000000099", role: "admin", active: true };
  const created = harness({ body: { requestKey: "selected-1", leadIds: [ids[1]] }, user, db, client });
  await handleEnrichmentRequest(created);
  assert.deepEqual(created.response.body.batch.leadIds, [ids[1]]);
  const operationKey = "30000000-0000-4000-8000-000000000001";
  const process = harness({ path: `/api/crm/enrichment-batches/${created.response.body.batch.id}/process-next`, body: { operationKey }, user, db, client });
  await handleEnrichmentRequest(process);
  assert.equal(process.response.body.batch.items[0].leadId, ids[1]);
  assert.equal(process.response.body.batch.items[0].state, "ready");
  assert.equal(providerCalls, 1);
  const replay = harness({ path: `/api/crm/enrichment-batches/${created.response.body.batch.id}/process-next`, body: { operationKey }, user, db, client });
  await handleEnrichmentRequest(replay);
  assert.equal(replay.response.body.batch.items[0].state, "ready");
  assert.equal(providerCalls, 1);
});

test("one provider failure is saved and a later selected lead can still complete", async () => {
  const ids = ["00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004"];
  const db = new BatchDb(ids.map((id) => ({ id, name: id, website: `https://${id}.example.test`, phone: "0821234567", assignedTo: "", status: "New" })));
  let calls = 0;
  const client = { async mapAndScrape(url) {
    calls += 1;
    if (url.includes(ids[0])) throw Object.assign(new Error("provider timeout"), { status: 504 });
    return { data: [{ markdown: "The studio offers local photography sessions and school portraits.", metadata: { sourceURL: url } }], usage: { reportedTotal: 1, reportedSubtotal: 1, complete: true } };
  } };
  const user = { id: "00000000-0000-4000-8000-000000000099", role: "admin", active: true };
  const create = harness({ body: { requestKey: "two-leads", leadIds: ids }, user, db, client });
  await handleEnrichmentRequest(create);
  const batchId = create.response.body.batch.id;
  const first = harness({ path: `/api/crm/enrichment-batches/${batchId}/process-next`, body: { operationKey: "30000000-0000-4000-8000-000000000002" }, user, db, client });
  await handleEnrichmentRequest(first);
  assert.equal(first.response.status, 200, JSON.stringify(first.response.body));
  assert.equal(first.response.body.batch.items[0].state, "interrupted");
  const second = harness({ path: `/api/crm/enrichment-batches/${batchId}/process-next`, body: { operationKey: "30000000-0000-4000-8000-000000000003" }, user, db, client });
  await handleEnrichmentRequest(second);
  assert.equal(second.response.body.batch.items[1].state, "ready");
  assert.equal(calls, 2);
});
