import { randomBytes, randomUUID } from "node:crypto";
import { hashToken } from "./auth.mjs";

export const AGENT_SCOPES = Object.freeze([
  "leads:search", "leads:read", "leads:assign:self", "conversations:read", "conversations:write", "notes:write", "leads:update:limited", "dnc:set",
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
  return rows[0] || null;
}

export async function createAgentKey(store, { label = "Andrew", scopes = AGENT_SCOPES, createdBy }) {
  const granted = [...new Set(scopes)];
  if (!granted.length || granted.some((scope) => !AGENT_SCOPES.includes(scope))) throw Object.assign(new Error("Invalid agent-key scope."), { status: 400 });
  const secret = randomBytes(32).toString("base64url");
  const rows = await store.db.sql(`INSERT INTO agent_keys (id, label, token_hash, scopes, created_by)
    VALUES ($1, $2, $3, $4, $5) RETURNING id, label, scopes, active, created_at AS "createdAt"`, [randomUUID(), String(label).slice(0, 100), hashToken(secret), granted, createdBy]);
  return { key: rows[0], secret };
}

export async function revokeAgentKey(store, id) {
  const rows = await store.db.sql("UPDATE agent_keys SET active = FALSE, revoked_at = NOW() WHERE id = $1 AND active = TRUE RETURNING id", [id]);
  return rows.length > 0;
}
