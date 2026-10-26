import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.AGENT_TEST_DATABASE_URL;
test("native deliveries persist first-contact evidence once and repair CRM fields", { skip: !url ? "Set AGENT_TEST_DATABASE_URL to a disposable database with native CRM migrations applied." : false }, async () => {
  const { NeonStore } = await import("../lib/neon-store.mjs");
  const { AgentStore } = await import("../lib/agent-store.mjs");
  const { AgentOutreachStore } = await import("../lib/agent-outreach-store.mjs");
  const neon = new NeonStore(url); const crm = new AgentStore(neon); const outreach = new AgentOutreachStore(neon);
  await crm.ready();
  const ids = [randomUUID(), randomUUID()];
  const claimId = randomUUID(); const agent = `delivery-${randomUUID()}`;
  const insertLead = async (id, status = "New", lastContactedAt = "") => {
    const data = { id, leadType:"Native delivery integration", name:id, phone:"+27820000000", assignedTo:agent, status, lastContactedAt };
    await neon.sql("INSERT INTO crm_leads (id, lead_type, phone, data) VALUES ($1,'Native delivery integration',$2,$3::jsonb)", [id, data.phone, JSON.stringify(data)]);
  };
  const makeInput = (leadId, segmentId, overrides = {}) => ({
    leadId, segmentId, channel:"whatsapp", messages:[{ direction:"outgoing", speaker:agent, body:"  Hello 🛰️\n", timestamp:null }],
    summary:"WhatsApp message delivered", idempotencyKey:segmentId, occurredAt:null, agent,
    nativeDelivery:{ state:"delivered", claimId:null }, ...overrides,
  });
  try {
    await insertLead(ids[0]); await insertLead(ids[1]);
    await neon.sql("INSERT INTO lead_outreach_claims (id,agent,lead_id,request_key,state) VALUES ($1,$2,$3,$4,'reserved')", [claimId, agent, ids[0], `request-${randomUUID()}`]);
    const firstInput = makeInput(ids[0], `native-whatsapp:v1:${randomUUID()}`, { nativeDelivery:{ state:"delivered", claimId } });
    const saved = await crm.appendConversation(firstInput);
    assert.equal(saved.conversation.messages[0].body, "  Hello 🛰️\n");
    assert.equal(saved.firstContact, true); assert.equal(saved.allocationViolation, false);
    const replay = await crm.appendConversation(firstInput);
    assert.equal(replay.conversation.id, saved.conversation.id); assert.equal(replay.contactedAt, saved.contactedAt);
    await assert.rejects(crm.appendConversation({ ...firstInput, messages:[{ ...firstInput.messages[0], body:"changed" }] }), { status:409 });
    assert.equal((await neon.sql("SELECT COUNT(*)::int AS count FROM lead_first_contacts WHERE lead_id=$1", [ids[0]]))[0].count, 1);
    assert.equal((await neon.sql("SELECT state FROM lead_outreach_claims WHERE id=$1", [claimId]))[0].state, "delivered");
    const repaired = await outreach.finalizeDelivery(ids[0], saved.conversation.id, agent);
    assert.equal(repaired.status, "Contacted");
    await neon.sql("UPDATE crm_leads SET data=jsonb_set(data,'{status}','\"Interested\"'::jsonb) WHERE id=$1", [ids[0]]);
    assert.equal((await outreach.finalizeDelivery(ids[0], saved.conversation.id, agent)).status, "Interested");

    const followup = await crm.appendConversation(makeInput(ids[0], `native-whatsapp:v1:${randomUUID()}`));
    assert.equal(followup.firstContact, false); assert.equal(followup.allocationViolation, false);
    assert.equal((await outreach.getQuota(agent)).delivered, 1);

    const rogue = await crm.appendConversation(makeInput(ids[1], `native-whatsapp:v1:${randomUUID()}`));
    assert.equal(rogue.firstContact, true); assert.equal(rogue.allocationViolation, true);
    await assert.rejects(crm.appendConversation(makeInput(ids[1], firstInput.segmentId)), { status:409 });
  } finally {
    await neon.sql("DELETE FROM crm_leads WHERE id = ANY($1::uuid[])", [ids]);
  }
});
