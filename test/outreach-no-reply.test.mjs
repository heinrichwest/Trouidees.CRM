import test from "node:test";
import assert from "node:assert/strict";
import { AgentOutreachStore } from "../lib/agent-outreach-store.mjs";
import { handleAgentRequest } from "../lib/agent-api.mjs";

const token = "c".repeat(43);
const leadId = "123e4567-e89b-42d3-a456-426614174000";
const conversationId = "323e4567-e89b-42d3-a456-426614174000";

test("no-reply store encodes keyset cursors and records only the bound first conversation", async () => {
  const calls = [];
  const db = { sql:async (query, params) => { calls.push({ query, params }); if (query.includes("crm_list_no_reply_due") || query.includes("NOT first_contact.source_time_known")) return []; return [{ result:{ recorded:true, reason:"no_reply", outcomeId:"outcome-1" } }]; } };
  const store = new AgentOutreachStore(db, { now:() => new Date("2026-10-26T08:15:00Z") });
  assert.deepEqual(await store.listNoReplyDue("Andrew", null, 100), { leads:[], nextCursor:null, unknownDeliveryTimes:[] });
  assert.deepEqual(await store.recordNoReply(leadId, conversationId, "Andrew"), { recorded:true, reason:"no_reply", outcomeId:"outcome-1" });
  assert.ok(calls.some((call) => call.query.includes("crm_list_no_reply_due")));
  const recordCall = calls.find((call) => call.query.includes("crm_record_no_reply"));
  assert.deepEqual(recordCall.params.slice(0, 3), ["Andrew", leadId, conversationId]);
});

test("no-reply routes require outreach scopes and use only authenticated agent identity", async () => {
  const calls = []; const result = {};
  const db = { ensureSchema:async () => {}, sql:async (query, params) => {
    calls.push({ query, params });
    if (query.includes("UPDATE agent_keys SET last_used_at")) return [{ id:"11111111-1111-4111-8111-111111111111", label:"Andrew", scopes:["outreach:read", "outreach:write"] }];
    if (query.includes("crm_list_no_reply_due")) return [{ result:{ leads:[], nextCursor:null } }];
    return [{ result:{ recorded:false, reason:"replied", outcomeId:null } }];
  } };
  const store = { db, ready:async () => {}, visibleRow:async () => ({ data:{ assignedTo:"Andrew" } }) };
  const response = { writeHead(status) { result.status=status; }, end(text) { result.body=JSON.parse(text); } };
  const request = (method,url,body) => ({ method,url,headers:{ authorization:`Bearer ${token}`,host:"localhost" },body });
  const previous = process.env.AGENT_NATIVE_OUTREACH_ENABLED; process.env.AGENT_NATIVE_OUTREACH_ENABLED="1";
  try {
    await handleAgentRequest({ request:request("GET","/api/agent/outreach/no-reply-due?limit=20"),response,store });
    assert.equal(result.status,200);
    await handleAgentRequest({ request:request("POST",`/api/agent/leads/${leadId}/no-reply`,{ firstConversationId:conversationId }),response,store });
    assert.equal(result.status,200);
    assert.deepEqual(result.body,{ recorded:false,reason:"replied",outcomeId:null });
    assert.equal(calls.filter((call) => call.query.includes("crm_record_no_reply")).at(-1).params[0],"Andrew");
    const missingScope = { ...store, db:{ ...db, sql:async (query,params) => query.includes("UPDATE agent_keys SET last_used_at") ? [{ id:"11111111-1111-4111-8111-111111111111",label:"Andrew",scopes:[] }] : [] } };
    await handleAgentRequest({ request:request("GET","/api/agent/outreach/no-reply-due"),response,store:missingScope });
    assert.equal(result.status,403);
  } finally { if (previous == null) delete process.env.AGENT_NATIVE_OUTREACH_ENABLED; else process.env.AGENT_NATIVE_OUTREACH_ENABLED=previous; }
});
