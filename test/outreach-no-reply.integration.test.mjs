import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.AGENT_TEST_DATABASE_URL;
test("no-reply deadline is exact and inbound append races classification safely", { skip:!url ? "Set AGENT_TEST_DATABASE_URL to a disposable database with no-reply migration applied." : false }, async () => {
  const { NeonStore } = await import("../lib/neon-store.mjs");
  const { AgentStore } = await import("../lib/agent-store.mjs");
  const { AgentOutreachStore } = await import("../lib/agent-outreach-store.mjs");
  const db = new NeonStore(url); const crm = new AgentStore(db); await crm.ready();
  const leadIds = [randomUUID(), randomUUID(), randomUUID()]; const agent = `no-reply-${randomUUID()}`;
  const outcomes = new AgentOutreachStore(db, { now:() => new Date("2026-10-26T08:14:59Z") });
  const makeDelivered = async (leadId, occurredAt, segmentId) => {
    const at = occurredAt ? new Date(occurredAt).toISOString() : null;
    const message = { direction:"outgoing", speaker:agent, body:"Delivered", timestamp:at };
    return crm.appendConversation({ leadId, segmentId, channel:"whatsapp", messages:[message], summary:"WhatsApp message delivered",
      idempotencyKey:segmentId, occurredAt:at, agent, nativeDelivery:{ state:"delivered", claimId:null } });
  };
  try {
    for (const id of leadIds) {
      const data={ id,name:id,phone:`+2782${id.replace(/\D/g,"").slice(0,7)}`,assignedTo:agent,status:"New" };
      await db.sql("INSERT INTO crm_leads(id,lead_type,phone,data) VALUES($1,'No reply integration',$2,$3::jsonb)",[id,data.phone,JSON.stringify(data)]);
    }
    const first = await makeDelivered(leadIds[0],"2026-10-23T08:15:00Z",`native-whatsapp:v1:${randomUUID()}`);
    assert.equal((await outcomes.recordNoReply(leadIds[0],first.conversation.id,agent)).reason,"not_due");
    const atDeadline = new AgentOutreachStore(db,{now:() => new Date("2026-10-26T08:15:00Z")});
    const classified = await atDeadline.recordNoReply(leadIds[0],first.conversation.id,agent);
    assert.equal(classified.reason,"no_reply"); assert.equal(classified.recorded,true);
    await crm.appendConversation({ leadId:leadIds[0],segmentId:`later-reply-${randomUUID()}`,channel:"whatsapp",
      messages:[{direction:"incoming",speaker:"contact",body:"Later reply",timestamp:"2026-10-26T09:00:00Z"}],summary:"Reply",idempotencyKey:randomUUID(),agent });
    const activity = await crm.listActivity(leadIds[0]);
    assert.equal(activity.find((row)=>row.id===classified.outcomeId).supersededAt != null,true);

    const replied = await makeDelivered(leadIds[1],"2026-10-23T08:15:00Z",`native-whatsapp:v1:${randomUUID()}`);
    await crm.appendConversation({ leadId:leadIds[1],segmentId:`incoming-${randomUUID()}`,channel:"whatsapp",
      messages:[{direction:"incoming",speaker:"contact",body:"Thanks",timestamp:"2026-10-26T08:15:00Z"}],summary:"Reply",idempotencyKey:randomUUID(),agent });
    assert.equal((await atDeadline.recordNoReply(leadIds[1],replied.conversation.id,agent)).reason,"replied");

    const unknown = await makeDelivered(leadIds[2],null,`native-whatsapp:v1:${randomUUID()}`);
    const unknownResult = await atDeadline.recordNoReply(leadIds[2],unknown.conversation.id,agent);
    assert.equal(unknownResult.reason,"unknown_delivery_time");
    assert.equal((await atDeadline.listNoReplyDue(agent)).unknownDeliveryTimes.some((row)=>row.leadId===leadIds[2]),true);
  } finally { await db.sql("DELETE FROM crm_leads WHERE id=ANY($1::uuid[])",[leadIds]); }
});
