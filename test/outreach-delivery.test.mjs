import test from "node:test";
import assert from "node:assert/strict";
import { AgentStore } from "../lib/agent-store.mjs";
import { AgentOutreachStore } from "../lib/agent-outreach-store.mjs";

const leadId = "123e4567-e89b-42d3-a456-426614174000";
const claimId = "223e4567-e89b-42d3-a456-426614174000";
const conversationId = "323e4567-e89b-42d3-a456-426614174000";
const deliveredInput = (overrides = {}) => ({
  leadId, segmentId:"native-whatsapp:v1:hash", channel:"whatsapp",
  messages:[{ direction:"outgoing", speaker:"Andrew", body:"  Hello 🛰️\n", timestamp:null }],
  summary:"WhatsApp message delivered", idempotencyKey:"native-whatsapp:v1:hash", occurredAt:null, agent:"Andrew",
  nativeDelivery:{ state:"delivered", claimId }, ...overrides,
});

function fakeDb(reply = {}) {
  const calls = [];
  return { calls, ensureSchema:async () => {}, sql:async (query, params) => { calls.push({ query, params }); return reply(query, params); } };
}

test("native delivery persists verbatim outgoing text and delegates atomic first-contact insertion", async () => {
  const db = fakeDb((query) => query.includes("crm_append_native_conversation") ? [{ result:{
    conversation:{ id:conversationId, leadId, messages:deliveredInput().messages, occurredAt:null }, contactedAt:"2026-10-26T08:00:00.000Z", firstContact:true, allocationViolation:false,
  } }] : []);
  const store = new AgentStore(db);
  const result = await store.appendConversation(deliveredInput());
  assert.equal(result.conversation.messages[0].body, "  Hello 🛰️\n");
  assert.equal(result.contactedAt, "2026-10-26T08:00:00.000Z");
  assert.equal(result.firstContact, true);
  assert.equal(result.allocationViolation, false);
  assert.match(db.calls[0].query, /crm_append_native_conversation/);
});

test("native delivery accepts only one outgoing message and delivered metadata", async () => {
  const store = new AgentStore(fakeDb(() => []));
  await assert.rejects(store.appendConversation(deliveredInput({ nativeDelivery:{ state:"accepted", claimId } })), { code:"INVALID_NATIVE_DELIVERY", status:400 });
  await assert.rejects(store.appendConversation(deliveredInput({ messages:[{ direction:"outgoing", speaker:"Andrew", body:"one" }, { direction:"outgoing", speaker:"Andrew", body:"two" }] })), { code:"INVALID_NATIVE_DELIVERY", status:400 });
  await assert.rejects(store.appendConversation(deliveredInput({ messages:[{ direction:"incoming", speaker:"contact", body:"not delivered" }] })), { code:"INVALID_NATIVE_DELIVERY", status:400 });
  await assert.rejects(store.appendConversation(deliveredInput({ occurredAt:"2026-10-26T08:00:00Z" })), { code:"INVALID_NATIVE_DELIVERY", status:400 });
});

test("native first-contact finalization delegates ownership and monotonic repair to SQL", async () => {
  const db = fakeDb((query) => query.includes("crm_finalize_native_delivery") ? [{ result:{ id:leadId, status:"Contacted", lastContactedAt:"2026-10-26T08:00:00.000Z", assignedTo:"Andrew", doNotContact:false } }] : []);
  const outreach = new AgentOutreachStore(db);
  const lead = await outreach.finalizeDelivery(leadId, conversationId, "Andrew");
  assert.equal(lead.status, "Contacted");
  assert.equal(lead.lastContactedAt, "2026-10-26T08:00:00.000Z");
  assert.match(db.calls[0].query, /crm_finalize_native_delivery/);
  assert.deepEqual(db.calls[0].params.slice(0, 2), ["Andrew", leadId]);
});

test("delivery finalization rejects invalid IDs and an empty authenticated label", async () => {
  const outreach = new AgentOutreachStore(fakeDb(() => []));
  await assert.rejects(outreach.finalizeDelivery("bad", conversationId, "Andrew"), { status:400 });
  await assert.rejects(outreach.finalizeDelivery(leadId, conversationId, " "), { status:400 });
});
