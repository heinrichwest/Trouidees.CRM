import test from "node:test";
import assert from "node:assert/strict";
import { handleAgentRequest, handleAgentAdminRequest } from "../lib/agent-api.mjs";
import { hashToken } from "../lib/auth.mjs";

const token = "a".repeat(43);
function setup({ scopes = ["leads:search", "leads:read", "leads:assign:self", "conversations:read", "conversations:write", "notes:write", "leads:update:limited", "dnc:set"], lead = { id: "123e4567-e89b-42d3-a456-426614174000", assignedTo: "" } } = {}) {
  const calls = []; const result = {};
  const store = {
    db: { ensureSchema: async () => {}, sql: async (query, params) => query.includes("UPDATE agent_keys SET last_used_at") && params[0] === hashToken(token) ? [{ id: "key", scopes }] : [] },
    listVisibleLeads: async (args) => { calls.push(["list", args]); return { leads: [lead], nextCursor: null }; },
    getVisibleLead: async (id) => id === lead.id ? lead : null,
    assignSelf: async (id) => id === lead.id ? { ...lead, assignedTo: "Andrew" } : null,
    listConversations: async (id) => { calls.push(["conversations", id]); return []; },
    appendConversation: async (data) => { calls.push(["appendConversation", data]); return data; },
    appendNote: async (...args) => { calls.push(["note", ...args]); return { id: "n", body: args[1] }; },
    updateLeadLimited: async (id, patch) => { calls.push(["update", id, patch]); return { ...lead, ...patch }; },
  };
  const response = { writeHead(status) { result.status = status; }, end(text) { result.body = JSON.parse(text); } };
  const request = (method, url, body) => ({ method, url, headers: { authorization: `Bearer ${token}`, host: "localhost" }, body });
  return { store, response, request, result, calls };
}

test("agent API enforces scope and pages within its requested limit", async () => {
  let ctx = setup({ scopes: ["leads:read"] });
  await handleAgentRequest({ ...ctx, request: ctx.request("GET", "/api/agent/leads") });
  assert.equal(ctx.result.status, 403);
  ctx = setup();
  await handleAgentRequest({ ...ctx, request: ctx.request("GET", "/api/agent/leads?limit=1000&q=smith") });
  assert.equal(ctx.result.status, 200);
  assert.equal(ctx.calls[0][1].limit, 1000); // store applies the hard maximum
  assert.equal(ctx.calls[0][1].query, "smith");
});

test("agent API validates transcript ordering fields and preserves bodies and null timestamps", async () => {
  const ctx = setup({ lead: { id: "123e4567-e89b-42d3-a456-426614174000", assignedTo: "Andrew" } });
  const good = { segmentId: "segment-1", idempotencyKey: "idem-1", summary: "Discussed the request.", messages: [
    { direction: "incoming", speaker: "contact", body: "  Please call me.  ", timestamp: null },
    { direction: "outgoing", speaker: "andrew", body: "I will follow up.", timestamp: "2026-09-29T10:00:00Z" },
  ] };
  await handleAgentRequest({ ...ctx, request: ctx.request("POST", "/api/agent/leads/123e4567-e89b-42d3-a456-426614174000/conversations", good) });
  assert.equal(ctx.result.status, 200);
  assert.equal(ctx.calls[0][1].messages[0].body, "  Please call me.  ");
  assert.equal(ctx.calls[0][1].messages[0].timestamp, null);
  const invalid = setup();
  await handleAgentRequest({ ...invalid, request: invalid.request("POST", "/api/agent/leads/123e4567-e89b-42d3-a456-426614174000/conversations", { ...good, messages: [{ ...good.messages[0], speaker: "andrew" }] }) });
  assert.equal(invalid.result.status, 400);
});

test("streamed JSON keeps emoji intact when a UTF-8 code point crosses chunk boundaries", async () => {
  const ctx = setup({ lead: { id: "123e4567-e89b-42d3-a456-426614174000", assignedTo: "Andrew" } });
  const exactBody = "Please save this 🛰️ message exactly.";
  const payload = { segmentId: "segment-utf8", idempotencyKey: "idem-utf8", summary: "UTF-8 test", messages: [
    { direction: "incoming", speaker: "contact", body: exactBody, timestamp: null },
  ] };
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const emojiStart = bytes.indexOf(Buffer.from("🛰️", "utf8"));
  const split = emojiStart + 2;
  const request = ctx.request("POST", "/api/agent/leads/123e4567-e89b-42d3-a456-426614174000/conversations");
  request[Symbol.asyncIterator] = async function* () { yield bytes.subarray(0, split); yield bytes.subarray(split); };

  await handleAgentRequest({ ...ctx, request });

  assert.equal(ctx.result.status, 200);
  assert.equal(ctx.calls[0][1].messages[0].body, exactBody);
});

test("agent API rejects assignment fields and DNC clearing", async () => {
  const ctx = setup();
  await handleAgentRequest({ ...ctx, request: ctx.request("PATCH", "/api/agent/leads/123e4567-e89b-42d3-a456-426614174000", { assignedTo: "Other" }) });
  assert.equal(ctx.result.status, 400);
  const denied = setup();
  await handleAgentRequest({ ...denied, request: denied.request("PATCH", "/api/agent/leads/123e4567-e89b-42d3-a456-426614174000", { doNotContact: false }) });
  assert.equal(denied.result.status, 403);
});

test("admin agent-key and DNC routes require an admin and a reason", async () => {
  const ctx = setup();
  await handleAgentAdminRequest({ ...ctx, request: ctx.request("POST", "/api/admin/leads/123e4567-e89b-42d3-a456-426614174000/dnc/clear", {}), user: { id: "sales", active: true, role: "sales" } });
  assert.equal(ctx.result.status, 403);
  const admin = setup(); admin.store.ready = async () => {}; admin.store.clearDnc = async (...args) => { admin.calls.push(["clear", ...args]); return true; };
  await handleAgentAdminRequest({ ...admin, request: admin.request("POST", "/api/admin/leads/123e4567-e89b-42d3-a456-426614174000/dnc/clear", { reason: "Contact confirmed the request was resolved" }), user: { id: "admin", active: true, role: "admin" } });
  assert.equal(admin.result.status, 200);
  assert.equal(admin.calls[0][3], "Contact confirmed the request was resolved");
});
