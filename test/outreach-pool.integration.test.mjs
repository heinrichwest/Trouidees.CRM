import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NeonStore } from "../lib/neon-store.mjs";
import { AgentOutreachStore } from "../lib/agent-outreach-store.mjs";

const url = process.env.AGENT_TEST_DATABASE_URL;
test("shared pool claims are atomic, replayable and hold daily capacity", {
  skip: !url ? "Set AGENT_TEST_DATABASE_URL to a disposable database with both native CRM migrations applied." : false,
}, async () => {
  const db = new NeonStore(url);
  const actorId = randomUUID();
  const leadIds = Array.from({ length: 14 }, () => randomUUID());
  const agentA = `pool-a-${randomUUID()}`;
  const agentB = `pool-b-${randomUUID()}`;
  const now = new Date("2026-10-26T08:15:00.000Z");
  const outreach = new AgentOutreachStore(db, { now: () => now });
  const research = {
    researchedAt: "2026-10-26T08:00:00.000Z", ready: true, messageable: true,
    research: { confidence: "high", angle: "fit", dossierRef: null, facts: [{ text: "Verified source fact", sourceUrl: "https://example.test/about" }] },
  };
  const data = (id, status = "New") => ({ id, leadType: "Native outreach integration", name: id, phone: "", email: "", assignedTo: "", status, lastContactedAt: "", nextFollowUpAt: "" });

  try {
    await db.sql("INSERT INTO app_users (id,email,password_hash,role) VALUES ($1,$2,'x','admin')", [actorId, `${actorId}@example.test`]);
    for (let i = 0; i < leadIds.length; i += 1) {
      const status = i === 13 ? "Contacted" : "New";
      const doNotContact = i === 11;
      const row = data(leadIds[i], status);
      await db.sql("INSERT INTO crm_leads (id,lead_type,data,do_not_contact) VALUES ($1,$2,$3::jsonb,$4)", [leadIds[i], row.leadType, JSON.stringify(row), doNotContact]);
      const result = i === 12 ? { ...research, ready: false, messageable: false, research: { ...research.research, facts: [] } } : research;
      const published = await outreach.putResearch(leadIds[i], result, { kind: "crm", userId: actorId });
      if (i === 0) assert.equal(published.ready, true);
    }

    const unassigned = await db.sql("SELECT data->>'assignedTo' AS owner FROM crm_leads WHERE id=$1", [leadIds[0]]);
    assert.equal(unassigned[0].owner, "");
    const stale = await outreach.putResearch(leadIds[0], { ...research, researchedAt: "2026-10-25T08:00:00.000Z", research: { ...research.research, angle: "stale" } }, { kind: "crm", userId: actorId });
    assert.equal(stale.research.angle, "fit");

    const parallel = await Promise.all([
      outreach.claimNext(agentA, "initial-a"),
      outreach.claimNext(agentB, "initial-b"),
    ]);
    assert.ok(parallel.every(({ claim }) => claim));
    assert.notEqual(parallel[0].lead.id, parallel[1].lead.id);
    const first = parallel[0];
    const replay = await outreach.claimNext(agentA, "initial-a");
    assert.equal(replay.claim.id, first.claim.id);

    const more = await Promise.all(Array.from({ length: 9 }, (_, i) => outreach.claimNext(agentA, `parallel-${i}`)));
    assert.equal(more.filter(({ claim }) => claim).length, 7);
    const quota = await outreach.getQuota(agentA);
    assert.deepEqual([quota.delivered, quota.outstanding, quota.remaining], [0, 8, 0]);
    assert.equal((await outreach.claimNext(agentA, "ninth")).reason, "capacity_held");

    const nextDay = new AgentOutreachStore(db, { now: () => new Date("2026-10-27T08:15:00.000Z") });
    assert.equal((await nextDay.claimNext(agentA, "midnight")).reason, "capacity_held");

    const finalPoolClaims = await Promise.all(Array.from({ length: 3 }, (_, i) => outreach.claimNext(agentB, `finish-pool-${i}`)));
    assert.equal(finalPoolClaims.filter(({ claim }) => claim).length, 2);
    assert.equal(finalPoolClaims.at(-1).reason, "pool_empty");
    const allocated = [first, ...more, parallel[1], ...finalPoolClaims].filter(({ claim }) => claim).map(({ lead }) => lead.id);
    assert.equal(new Set(allocated).size, 11);
    assert.deepEqual(new Set(allocated), new Set(leadIds.slice(0, 11)));
    for (const { lead } of more.filter(({ claim }) => claim)) {
      const id = lead.id;
      await outreach.updateClaim((await db.sql("SELECT id FROM lead_outreach_claims WHERE agent=$1 AND lead_id=$2", [agentA, id]))[0].id,
        { state: "released", reason: "not_submitted" }, agentA);
    }

    await db.sql(`INSERT INTO lead_first_contacts (lead_id,kind,agent,effective_delivered_at,source_time_known)
      VALUES ($1,'native',$2,$3,FALSE)`, [first.lead.id, agentA, now.toISOString()]);
    await db.sql("UPDATE lead_outreach_claims SET state='delivered',updated_at=$1 WHERE id=$2", [now.toISOString(), first.claim.id]);
    await db.sql("UPDATE crm_leads SET data=jsonb_set(jsonb_set(data,'{assignedTo}','\"\"'::jsonb),'{status}','\"New\"'::jsonb) WHERE id=$1", [first.lead.id]);
    const refreshed = await outreach.putResearch(first.lead.id, { ...research, researchedAt: "2026-10-26T08:01:00.000Z" }, { kind: "crm", userId: actorId });
    assert.equal(refreshed.ready, false);
    const replacement = await outreach.claimNext(agentA, "replacement");
    assert.ok(replacement.claim);
    assert.ok(allocated.includes(replacement.lead.id));
    assert.notEqual(replacement.lead.id, first.lead.id);

    const excluded = await db.sql("SELECT id FROM crm_leads WHERE id = ANY($1::uuid[]) AND (do_not_contact OR data->>'status'='Contacted')", [[leadIds[11], leadIds[13]]]);
    assert.equal(excluded.length, 2);
  } finally {
    await db.sql("DELETE FROM app_users WHERE id=$1", [actorId]).catch(() => {});
    await db.sql("DELETE FROM crm_leads WHERE id = ANY($1::uuid[])", [leadIds]).catch(() => {});
  }
});
