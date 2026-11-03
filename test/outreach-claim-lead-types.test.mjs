import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { AgentOutreachStore } from "../lib/agent-outreach-store.mjs";
import { NeonStore } from "../lib/neon-store.mjs";

// One CRM serves agents for different markets. A claim may name the agent's lead types so a
// photographer agent is never handed a tutoring lead; without them the original behaviour stays.

class RpcDb {
  constructor(result = { claim: null, lead: null, research: null, quota: {}, reason: "pool_empty" }) { this.result = result; this.calls = []; }
  async sql(query, parameters) { this.calls.push({ query, parameters }); return [{ result: this.result }]; }
}

test("claimNext passes no lead-type filter by default", async () => {
  const db = new RpcDb();
  await new AgentOutreachStore(db).claimNext("Andrew", "slot-1");
  assert.match(db.calls[0].query, /crm_claim_ready_lead\(\$1::text, \$2::text, \$3::timestamptz, \$4::text\[\]\)/);
  assert.equal(db.calls[0].parameters[3], null);
});

test("claimNext passes trimmed, de-duplicated lead types", async () => {
  const db = new RpcDb();
  await new AgentOutreachStore(db).claimNext("Anika", "slot-1", [" Photographers - South Africa Mobile ", "Photographers - South Africa Mobile", "Photographers"]);
  assert.deepEqual(db.calls[0].parameters[3], ["Photographers - South Africa Mobile", "Photographers"]);
});

test("claimNext rejects malformed lead types before touching the database", async () => {
  for (const bad of [[], [""], ["  "], [42], "Photographers", Array.from({ length: 21 }, (_, i) => `t${i}`), ["x".repeat(101)]]) {
    const db = new RpcDb();
    await assert.rejects(new AgentOutreachStore(db).claimNext("Anika", "slot-1", bad), { status: 400, code: "INVALID_LEAD_TYPES" });
    assert.equal(db.calls.length, 0);
  }
});

test("migration scopes the ready pool by lead type and keeps three-argument callers working", async () => {
  const sql = await readFile(new URL("../scripts/migrations/2026-11-03-claim-lead-types.sql", import.meta.url), "utf8");
  assert.match(sql, /DROP FUNCTION IF EXISTS crm_claim_ready_lead\(TEXT, TEXT, TIMESTAMPTZ\);/);
  assert.match(sql, /crm_claim_ready_lead\(p_agent TEXT, p_request_key TEXT, p_now TIMESTAMPTZ, p_lead_types TEXT\[\] DEFAULT NULL\)/);
  assert.match(sql, /AND \(p_lead_types IS NULL OR leads\.lead_type = ANY\(p_lead_types\)\)/);
  assert.match(sql, /cardinality\(p_lead_types\) NOT BETWEEN 1 AND 20/);
});

const url = process.env.AGENT_TEST_DATABASE_URL;
test("lead-type claims never cross markets", {
  skip: !url ? "Set AGENT_TEST_DATABASE_URL to a disposable database with the native CRM migrations and 2026-11-03-claim-lead-types.sql applied." : false,
}, async () => {
  const db = new NeonStore(url);
  const actorId = randomUUID();
  const now = new Date("2026-11-03T08:00:00.000Z");
  const outreach = new AgentOutreachStore(db, { now: () => now });
  const tag = randomUUID().slice(0, 8);
  const tutorType = `Tutors ${tag}`;
  const photoType = `Photographers ${tag}`;
  const leads = [[tutorType, "06:01"], [photoType, "06:02"], [tutorType, "06:03"], [photoType, "06:04"]].map(([type, at]) => ({ id: randomUUID(), type, at }));
  const research = (at) => ({ researchedAt: `2026-11-03T${at}:00.000Z`, ready: true, messageable: true,
    research: { confidence: "high", angle: "fit", dossierRef: null, facts: [{ text: "Verified", sourceUrl: "https://example.test/a" }] } });
  await db.sql("INSERT INTO app_users (id,email,password_hash,role) VALUES ($1,$2,'x','admin')", [actorId, `${actorId}@example.test`]);
  for (const lead of leads) {
    await db.sql("INSERT INTO crm_leads (id,lead_type,data) VALUES ($1,$2,$3::jsonb)", [lead.id, lead.type, JSON.stringify({ id: lead.id, leadType: lead.type, name: lead.id, status: "New", assignedTo: "" })]);
    await outreach.putResearch(lead.id, research(lead.at), { kind: "crm", userId: actorId });
  }
  const agent = `photo-${tag}`;
  const first = await outreach.claimNext(agent, "p-1", [photoType]);
  assert.equal(first.lead.id, leads[1].id, "skips the older tutor lead");
  assert.equal((await outreach.claimNext(agent, "p-1", [photoType])).claim.id, first.claim.id, "replay returns the same claim");
  assert.equal((await outreach.claimNext(agent, "p-2", [photoType])).lead.id, leads[3].id);
  assert.equal((await outreach.claimNext(agent, "p-3", [photoType])).reason, "pool_empty");
});
