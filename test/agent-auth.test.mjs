import test from "node:test";
import assert from "node:assert/strict";
import { hashToken } from "../lib/auth.mjs";
import { AGENT_SCOPES, authenticateAgent, createAgentKey, parseBearer } from "../lib/agent-auth.mjs";

test("bearer parsing rejects absent, malformed, and short credentials", () => {
  assert.equal(parseBearer({ headers: {} }), null);
  assert.equal(parseBearer({ headers: { authorization: "Basic abc" } }), null);
  assert.equal(parseBearer({ headers: { authorization: "Bearer short" } }), null);
  assert.equal(parseBearer({ headers: { authorization: `Bearer ${"a".repeat(43)}` } }), "a".repeat(43));
});

test("authentication hashes tokens and only accepts active key records", async () => {
  const secret = "s".repeat(43); const calls = [];
  const store = { db: { ensureSchema: async () => {}, sql: async (query, params) => { calls.push({ query, params }); return params[0] === hashToken(secret) ? [{ id: "key", scopes: ["leads:search"] }] : []; } } };
  assert.equal((await authenticateAgent({ headers: { authorization: `Bearer ${secret}` } }, store)).id, "key");
  assert.equal(calls[0].params[0], hashToken(secret));
  assert.notEqual(calls[0].params[0], secret);
  assert.equal(await authenticateAgent({ headers: { authorization: `Bearer ${"x".repeat(43)}` } }, store), null);
  assert.match(calls[0].query, /active = TRUE/);
});

test("key creation returns a one-time 32-byte secret and stores its hash and explicit scopes", async () => {
  let parameters;
  const store = { db: { sql: async (_query, values) => { parameters = values; return [{ id: values[0], label: values[1], scopes: values[3], active: true }]; } } };
  const created = await createAgentKey(store, { createdBy: "admin-id" });
  assert.equal(Buffer.from(created.secret, "base64url").length, 32);
  assert.equal(parameters[2], hashToken(created.secret));
  assert.deepEqual(created.key.scopes, AGENT_SCOPES);
  await assert.rejects(createAgentKey(store, { scopes: ["leads:delete"] }), /Invalid agent-key scope/);
});
