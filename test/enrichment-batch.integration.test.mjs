import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NeonStore } from "../lib/neon-store.mjs";
import { EnrichmentBatchStore } from "../lib/enrichment-batch-store.mjs";

const url = process.env.AGENT_TEST_DATABASE_URL;
test("durable enrichment batches replay saved results and fence attempts", {
  skip: !url ? "Set AGENT_TEST_DATABASE_URL to a disposable database with native CRM migrations applied." : false,
}, async () => {
  const db = new NeonStore(url);
  const actor = randomUUID();
  const leads = [randomUUID(), randomUUID()];
  const batches = new EnrichmentBatchStore(db);
  const operationKey = randomUUID();
  try {
    await db.sql("INSERT INTO app_users (id,email,password_hash,role) VALUES ($1,$2,'x','admin')", [actor, `${actor}@example.test`]);
    for (const id of leads) {
      const data = { id, leadType: "Enrichment integration", name: id, assignedTo: "", status: "New", lastContactedAt: "", phone: "0821234567", website: "https://example.test" };
      await db.sql("INSERT INTO crm_leads (id,lead_type,data) VALUES ($1,$2,$3::jsonb)", [id, data.leadType, JSON.stringify(data)]);
    }
    const batch = await batches.create(actor, operationKey, leads);
    const secondStore = new EnrichmentBatchStore(db);
    const replay = await secondStore.create(actor, operationKey, [...leads].reverse());
    assert.equal(replay.id, batch.id);
    assert.deepEqual(replay.leadIds, leads);
    assert.ok((await secondStore.list(actor, 20)).some(({ id }) => id === batch.id));
    await assert.rejects(batches.create(actor, operationKey, [leads[1]]), { status: 409 });
    const operation = randomUUID();
    const { attempt } = await batches.claimNext(batch.id, operation);
    assert.ok(attempt);
    const overlapping = await batches.create(actor, randomUUID(), [leads[0]]);
    const overlapAttempt = await batches.claimNext(overlapping.id, randomUUID());
    assert.equal(overlapAttempt.attempt, null);
    const pendingReplay = await batches.claimNext(batch.id, operation);
    assert.equal(pendingReplay.replay, true);
    assert.equal(pendingReplay.savedResult, null);
    const result = { state: "ready", report: { sources: [] }, research: { researchedAt: new Date().toISOString(), ready: true, messageable: true, research: { confidence: "high", angle: "fit", dossierRef: null, facts: [{ text: "fact", sourceUrl: "https://example.test" }] } }, usage: { reportedTotal: 0, reportedSubtotal: 0, complete: true }, creditsUsed: 0 };
    const completed = await batches.complete(attempt.id, result);
    const operationReplay = await batches.claimNext(batch.id, operation);
    assert.equal(operationReplay.replay, true);
    assert.equal(operationReplay.result.items[0].state, "ready");
    assert.equal(completed.items[0].state, "ready");
    const second = await batches.claimNext(batch.id, randomUUID());
    assert.equal(second.attempt.leadId, leads[1]);
    const failed = await batches.complete(second.attempt.id, { state: "failed", reason: "page unavailable", creditsUsed: null, usage: { reportedTotal: null, reportedSubtotal: 0, complete: false } });
    assert.equal(failed.items[1].state, "failed");
    const leadAfterResearch = await db.sql("SELECT data->>'assignedTo' AS owner,data->>'lastContactedAt' AS contacted FROM crm_leads WHERE id=$1", [leads[0]]);
    assert.equal(leadAfterResearch[0].owner, "");
    assert.equal(leadAfterResearch[0].contacted, "");

    const eligibilityBatch = await secondStore.create(actor, randomUUID(), [leads[1]]);
    const eligibilityAttempt = await secondStore.claimNext(eligibilityBatch.id, randomUUID());
    await db.sql("UPDATE crm_leads SET do_not_contact=TRUE WHERE id=$1", [leads[1]]);
    const ineligibleResult = await secondStore.complete(eligibilityAttempt.attempt.id, { state: "ready", report: { sources: [] }, research: { researchedAt: new Date().toISOString(), ready: true, messageable: true, research: { confidence: "high", angle: "fit", dossierRef: null, facts: [{ text: "fact", sourceUrl: "https://example.test" }] } }, creditsUsed: 0, usage: { reportedTotal: 0, reportedSubtotal: 0, complete: true } });
    assert.equal(ineligibleResult.items[0].state, "needs_review");
    assert.equal(ineligibleResult.items[0].research.ready, false);

    const staleBatch = await batches.create(actor, randomUUID(), [leads[0]]);
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const beforeExpiry = new EnrichmentBatchStore(db, { now: () => startedAt });
    const staleOperation = randomUUID();
    const staleAttempt = await beforeExpiry.claimNext(staleBatch.id, staleOperation);
    assert.ok(staleAttempt.attempt);
    const afterExpiry = new EnrichmentBatchStore(db, { now: () => new Date("2026-01-01T00:11:00.000Z") });
    const expiredReplay = await afterExpiry.claimNext(staleBatch.id, staleOperation);
    assert.equal(expiredReplay.replay, true);
    assert.equal(expiredReplay.result.items[0].state, "interrupted");
    const retried = await afterExpiry.retry(staleBatch.id, [leads[0]]);
    assert.equal(retried.items[0].state, "queued");
    assert.ok((await afterExpiry.claimNext(staleBatch.id, randomUUID())).attempt);
  } finally {
    await db.sql("DELETE FROM app_users WHERE id=$1", [actor]).catch(() => {});
    await db.sql("DELETE FROM crm_leads WHERE id = ANY($1::uuid[])", [leads]).catch(() => {});
  }
});
