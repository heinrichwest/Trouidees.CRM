import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AGENT_SCOPES, updateAgentKey } from "../lib/agent-auth.mjs";
import { handleAgentAdminRequest } from "../lib/agent-api.mjs";

const keyId = "123e4567-e89b-42d3-a456-426614174000";

function fakeStore(rows = [{ id: keyId, label: "Daniel", scopes: ["leads:read"], active: true }]) {
  const calls = [];
  return { calls, ready: async () => {}, db: { ensureSchema: async () => {}, sql: async (query, params) => { calls.push({ query, params }); return rows; } } };
}

// A scope change must reach the existing key in place: keys keep their secret, so an agent never
// has to be reconfigured to gain or lose a route.
test("updateAgentKey replaces the scopes of an active key and de-duplicates them", async () => {
  const store = fakeStore();
  const key = await updateAgentKey(store, keyId, { scopes: ["leads:read", "outreach:claim", "outreach:claim"] });
  assert.equal(key.id, keyId);
  const { query, params } = store.calls[0];
  assert.match(query, /UPDATE agent_keys SET scopes = \$1 WHERE id = \$2 AND active = TRUE/);
  assert.deepEqual(params, [["leads:read", "outreach:claim"], keyId]);
});

test("updateAgentKey can change label and scopes together", async () => {
  const store = fakeStore();
  await updateAgentKey(store, keyId, { label: "  Andrew  ", scopes: ["leads:read"] });
  assert.match(store.calls[0].query, /SET label = \$1, scopes = \$2 WHERE id = \$3/);
  assert.deepEqual(store.calls[0].params, ["Andrew", ["leads:read"], keyId]);
});

test("updateAgentKey rejects unknown or empty scopes before touching the database", async () => {
  const store = fakeStore();
  await assert.rejects(updateAgentKey(store, keyId, { scopes: ["leads:delete"] }), /Invalid agent-key scope/);
  await assert.rejects(updateAgentKey(store, keyId, { scopes: [] }), /Invalid agent-key scope/);
  assert.equal(store.calls.length, 0);
});

test("updateAgentKey returns null for no change, and for a revoked or unknown key", async () => {
  assert.equal(await updateAgentKey(fakeStore(), keyId, {}), null);
  assert.equal(await updateAgentKey(fakeStore([]), keyId, { scopes: ["leads:read"] }), null);
});

function admin(store, { role = "admin", id = keyId, body = { scopes: ["leads:read", "outreach:claim"] } } = {}) {
  const result = {};
  const response = { writeHead(status) { result.status = status; }, end(text) { result.body = JSON.parse(text); } };
  const request = { method: "PATCH", url: `/api/admin/agent-keys/${id}`, headers: { host: "localhost" }, body };
  return handleAgentAdminRequest({ request, response, store, user: { id: "u1", active: true, role } }).then(() => result);
}

test("PATCH /api/admin/agent-keys/:id updates scopes for administrators only", async () => {
  const ok = await admin(fakeStore());
  assert.equal(ok.status, 200);
  assert.ok(ok.body.key);
  assert.equal((await admin(fakeStore(), { role: "sales" })).status, 403);
});

test("PATCH /api/admin/agent-keys/:id rejects a bad id, a bad scope and a missing key", async () => {
  assert.equal((await admin(fakeStore(), { id: "not-a-uuid" })).status, 400);
  assert.equal((await admin(fakeStore(), { body: { scopes: ["nope"] } })).status, 400);
  assert.equal((await admin(fakeStore([]))).status, 404);
});

// The admin page must be able to reach the endpoint above, otherwise scopes stay editable only by
// hand with curl.
test("the Agent keys table offers an Edit scopes action that PATCHes scopes", async () => {
  const js = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(js, /edit-agent-key-scopes/);
  assert.match(js, /method:\s*"PATCH"[^;]*scopes/);
  assert.match(html, /<dialog id="agentKeyScopesDialog"/);
});

test("the Edit scopes dialog is built from the create form's scope list, so the two cannot drift", async () => {
  const js = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(js, /querySelectorAll\('#agentKeyForm input\[name="agentScope"\]'\)/);
  const offered = [...html.matchAll(/name="agentScope" value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...offered].sort(), [...AGENT_SCOPES].sort());
});

// The Agent keys table was always empty: the page called GET /api/admin/agent-keys but the server
// only had POST, PATCH and DELETE for that path, so the list fell through to "Admin route not found".
test("GET /api/admin/agent-keys lists keys for administrators and never returns the token hash", async () => {
  const rows = [{ id: keyId, label: "Daniel", scopes: ["leads:read"], active: true, createdAt: "2026-09-22", lastUsedAt: null }];
  const store = fakeStore(rows);
  const call = async (role) => {
    const result = {};
    const response = { writeHead(status) { result.status = status; }, end(text) { result.body = JSON.parse(text); } };
    const request = { method: "GET", url: "/api/admin/agent-keys", headers: { host: "localhost" } };
    await handleAgentAdminRequest({ request, response, store, user: { id: "u1", active: true, role } });
    return result;
  };
  const ok = await call("admin");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.keys, rows);
  assert.doesNotMatch(store.calls[0].query, /token_hash/);
  assert.equal((await call("sales")).status, 403);
});
