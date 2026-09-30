import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.AGENT_TEST_DATABASE_URL;
test("isolated Neon writeback contract", { skip: !url ? "Set AGENT_TEST_DATABASE_URL to a disposable, migrated Neon database." : false }, async () => {
  const { NeonStore } = await import("../lib/neon-store.mjs");
  const { AgentStore } = await import("../lib/agent-store.mjs");
  const neon = new NeonStore(url); const store = new AgentStore(neon); await store.ready();
  const ids = [randomUUID(), randomUUID(), randomUUID()]; const segment = `segment-${randomUUID()}`; const idem = `idem-${randomUUID()}`;
  const seed = async (id, phone, owner = "") => {
    const data = { id, leadType: "Agent integration", name: id, email: "", phone, assignedTo: owner, status: "New", feedback: "", nextFollowUpAt: "", lastContactedAt: "" };
    await neon.sql("INSERT INTO crm_leads (id, lead_type, phone, data) VALUES ($1, $2, $3, $4::jsonb)", [id, "Agent integration", phone, JSON.stringify(data)]);
  };
  try {
    await seed(ids[0], "+27 82 123 4567"); await seed(ids[1], "0821234567"); await seed(ids[2], "0829999999", "Another owner");
    const ambiguous = await store.listVisibleLeads({ query: "0821234567" });
    assert.equal(ambiguous.ambiguous, true); assert.deepEqual(new Set(ambiguous.candidates), new Set(ids.slice(0, 2)));
    const attempts = await Promise.allSettled([store.assignSelf(ids[0]), store.assignSelf(ids[0])]);
    assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 2);
    assert.equal((await neon.sql("SELECT COUNT(*)::int AS n FROM crm_leads WHERE id=$1 AND data->>'assignedTo'='Andrew'", [ids[0]]))[0].n, 1);
    assert.equal(await store.getVisibleLead(ids[2]), null);
    await assert.rejects(store.appendNote(ids[2], "should not be written"), { code: "NOT_OWNED" });
    await store.appendNote(ids[0], "Internal integration note");
    const conversation = { leadId: ids[0], segmentId: segment, channel: "WhatsApp", messages: [{ direction: "incoming", speaker: "contact", body: "Original body", timestamp: null }], summary: "Separate summary", idempotencyKey: idem };
    await store.appendConversation(conversation); await store.appendConversation(conversation);
    assert.equal((await neon.sql("SELECT COUNT(*)::int AS n FROM lead_conversations WHERE lead_id=$1 AND idempotency_key=$2", [ids[0], idem]))[0].n, 1);
    assert.equal((await store.listActivity(ids[0])).filter((item) => item.type === "note").length, 1);
    await store.updateLeadLimited(ids[0], { status: "Contacted", doNotContact: true });
    await assert.rejects(store.updateLeadLimited(ids[0], { assignedTo: "Other" }), { code: "INVALID_FIELDS" });
    await assert.rejects(store.updateLeadLimited(ids[0], { doNotContact: false }), { code: "DNC_CLEAR_FORBIDDEN" });
    assert.equal((await neon.sql("SELECT COUNT(*)::int AS n FROM lead_dnc_audit WHERE lead_id=$1 AND action='set'", [ids[0]]))[0].n, 1);
  } finally {
    await neon.sql("DELETE FROM crm_leads WHERE id = ANY($1::uuid[])", [ids]);
  }
});
