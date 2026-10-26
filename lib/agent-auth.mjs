import { randomBytes, randomUUID } from "node:crypto";
import { hashToken } from "./auth.mjs";

export const AGENT_SCOPES = Object.freeze([
  "leads:search", "leads:read", "leads:create", "leads:assign:self", "conversations:read", "conversations:write", "notes:write", "leads:update:limited", "dnc:set",
  "outreach:claim", "outreach:read", "outreach:write",
]);

export function parseBearer(request) {
  const header = String(request.headers?.authorization || "");
  const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(header);
  return match?.[1] || null;
}

export async function authenticateAgent(request, store) {
  const token = parseBearer(request);
  if (!token) return null;
  await store.db.ensureSchema();
  const rows = await store.db.sql("UPDATE agent_keys SET last_used_at = NOW() WHERE token_hash = $1 AND active = TRUE RETURNING id, label, scopes", [hashToken(token)]);
  if (!rows[0]) return null;
  return { id: rows[0].id, label: String(rows[0].label || "").trim() || "Andrew", scopes: rows[0].scopes };
}

export async function createAgentKey(store, { label = "Andrew", scopes = AGENT_SCOPES, createdBy }) {
  const granted = [...new Set(scopes)];
  if (!granted.length || granted.some((scope) => !AGENT_SCOPES.includes(scope))) throw Object.assign(new Error("Invalid agent-key scope."), { status: 400 });
  const secret = randomBytes(32).toString("base64url");
  const rows = await store.db.sql(`INSERT INTO agent_keys (id, label, token_hash, scopes, created_by)
    VALUES ($1, $2, $3, $4, $5) RETURNING id, label, scopes, active, created_at AS "createdAt"`, [randomUUID(), String(label).slice(0, 100), hashToken(secret), granted, createdBy]);
  return { key: rows[0], secret };
}

export async function updateAgentKey(store, id, { label, scopes } = {}) {
  const updates = [];
  const params = [];
  if (label !== undefined) {
    const clean = String(label).trim().slice(0, 100);
    if (!clean) throw Object.assign(new Error("Agent label is required."), { status: 400 });
    params.push(clean);
    updates.push(`label = $${params.length}`);
  }
  if (scopes !== undefined) {
    const granted = [...new Set(scopes)];
    if (!granted.length || granted.some((scope) => !AGENT_SCOPES.includes(scope))) throw Object.assign(new Error("Invalid agent-key scope."), { status: 400 });
    params.push(granted);
    updates.push(`scopes = $${params.length}`);
  }
  if (!updates.length) return null;
  params.push(id);
  const rows = await store.db.sql(`UPDATE agent_keys SET ${updates.join(", ")} WHERE id = $${params.length} AND active = TRUE RETURNING id, label, scopes, active, created_at AS "createdAt"`, params);
  return rows[0] || null;
}

export async function revokeAgentKey(store, id) {
  const rows = await store.db.sql("UPDATE agent_keys SET active = FALSE, revoked_at = NOW() WHERE id = $1 AND active = TRUE RETURNING id", [id]);
  return rows.length > 0;
}
