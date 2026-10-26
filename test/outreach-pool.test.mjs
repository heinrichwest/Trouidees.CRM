import test from "node:test";
import assert from "node:assert/strict";
import { AgentOutreachStore } from "../lib/agent-outreach-store.mjs";

const leadId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000099";
const researchInput = {
  researchedAt: "2026-10-26T08:15:00.000Z", ready: true, messageable: true,
  research: { confidence: "high", angle: "local fit", dossierRef: null, facts: [{ text: "Verified fact", sourceUrl: "https://example.test/about" }] },
};

class RpcDb {
  constructor(result) { this.result = result; this.calls = []; }
  async sql(query, parameters) { this.calls.push({ query, parameters }); return [{ result: this.result }]; }
}

test("claim result preserves the atomic CRM DTO", async () => {
  const expected = { claim: { id: leadId, leadId, requestKey: "request-1", state: "reserved", jobKey: null }, lead: { id: leadId, assignedTo: "Agent A", doNotContact: false }, research: { leadId, ...researchInput, readyAt: "2026-10-26T08:15:00.000Z" }, quota: { agent: "Agent A", day: "2026-10-26", timezone: "Africa/Johannesburg", target: 8, delivered: 0, outstanding: 1, remaining: 7 }, reason: null };
  const db = new RpcDb(expected);
  assert.deepEqual(await new AgentOutreachStore(db).claimNext("Agent A", "request-1"), expected);
  assert.match(db.calls[0].query, /crm_claim_ready_lead/);
  assert.deepEqual(db.calls[0].parameters.slice(0, 2), ["Agent A", "request-1"]);
});

test("research is sent only through the CRM procedure and requires an audited actor", async () => {
  const expected = { leadId, ...researchInput, readyAt: "2026-10-26T08:15:00.000Z" };
  const db = new RpcDb(expected);
  assert.deepEqual(await new AgentOutreachStore(db).putResearch(leadId, researchInput, { kind: "crm", userId: agentId }), expected);
  assert.match(db.calls[0].query, /crm_put_lead_research/);
  assert.equal(db.calls[0].parameters[5], agentId);
});

test("research input rejects invalid sources and unaudited actors", async () => {
  const store = new AgentOutreachStore(new RpcDb(null));
  await assert.rejects(store.putResearch(leadId, { ...researchInput, research: { ...researchInput.research, facts: [] } }, { kind: "crm", userId: agentId }), { status: 400 });
  await assert.rejects(store.putResearch(leadId, { ...researchInput, research: { ...researchInput.research, facts: [{ text: "Fact", sourceUrl: "file:///private/report" }] } }, { kind: "crm", userId: agentId }), { status: 400 });
  await assert.rejects(store.putResearch(leadId, { ...researchInput, researchedAt: "2026-02-31T08:15:00Z" }, { kind: "crm", userId: agentId }), { status: 400 });
  await assert.rejects(store.putResearch(leadId, researchInput, { kind: "agent", userId: agentId }), { status: 403 });
});

test("claim transitions are delegated with only supported release reasons", async () => {
  const db = new RpcDb({ id: leadId, leadId, requestKey: "request-1", state: "submitted", jobKey: "job-1" });
  const store = new AgentOutreachStore(db);
  await store.updateClaim(leadId, { state: "submitted", jobKey: "job-1" }, "Agent A");
  assert.match(db.calls[0].query, /crm_update_outreach_claim/);
  assert.equal(JSON.parse(db.calls[0].parameters[2]).jobKey, "job-1");
  await assert.rejects(store.updateClaim(leadId, { state: "released", reason: "unknown" }, "Agent A"), { status: 400 });
});

test("quota is tied to the authenticated label and Johannesburg day", async () => {
  const db = new RpcDb([{ delivered: "3", outstanding: "2" }]);
  db.sql = async (query, parameters) => { db.calls.push({ query, parameters }); return [{ delivered: "3", outstanding: "2" }]; };
  const quota = await new AgentOutreachStore(db, { now: () => new Date("2026-10-25T22:00:00Z") }).getQuota(" Agent A ");
  assert.deepEqual(quota, { agent: "Agent A", day: "2026-10-26", timezone: "Africa/Johannesburg", target: 8, delivered: 3, outstanding: 2, remaining: 3 });
  assert.deepEqual(db.calls[0].parameters, ["Agent A", "2026-10-26"]);
});
