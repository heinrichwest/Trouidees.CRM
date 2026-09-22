import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { DEFAULT_LEAD_TYPES } from "./crm.mjs";
import { appendFeedbackHistory } from "./feedback-history.mjs";

let schemaPromise;

const normalizeType = (value) => String(value || "").trim().replace(/\s+/g, " ").slice(0, 100);
const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

export class NeonStore {
  constructor(connectionString = process.env.DATABASE_URL) {
    if (!connectionString) throw new Error("DATABASE_URL is not configured.");
    const client = neon(connectionString);
    this.sql = (query, parameters = []) => client.query(query, parameters);
  }

  async ensureSchema() {
    if (!schemaPromise) schemaPromise = this.createSchema().catch((error) => { schemaPromise = undefined; throw error; });
    return schemaPromise;
  }

  async createSchema() {
    await this.sql(`CREATE TABLE IF NOT EXISTS app_users (
      id UUID PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'sales')), active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await this.sql(`CREATE TABLE IF NOT EXISTS app_sessions (
      token_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await this.sql(`CREATE TABLE IF NOT EXISTS lead_types (
      name TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await this.sql(`CREATE TABLE IF NOT EXISTS crm_leads (
      id UUID PRIMARY KEY, lead_type TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
      place_id TEXT NOT NULL DEFAULT '', data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await this.sql("CREATE INDEX IF NOT EXISTS crm_leads_type_idx ON crm_leads (LOWER(lead_type))");
    await this.sql("CREATE INDEX IF NOT EXISTS crm_leads_email_idx ON crm_leads (LOWER(email)) WHERE email <> ''");
    await this.sql("CREATE INDEX IF NOT EXISTS crm_leads_place_idx ON crm_leads (place_id) WHERE place_id <> ''");
    await this.sql(`CREATE TABLE IF NOT EXISTS research_reports (
      id TEXT PRIMARY KEY, data JSONB NOT NULL, generated_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    for (const name of DEFAULT_LEAD_TYPES) await this.sql("INSERT INTO lead_types (name) VALUES ($1) ON CONFLICT DO NOTHING", [name]);
  }

  async listLeads() {
    await this.ensureSchema();
    const rows = await this.sql("SELECT data FROM crm_leads ORDER BY created_at DESC");
    return rows.map((row) => row.data);
  }

  async listMapLeads() {
    await this.ensureSchema();
    return this.sql(`SELECT
      data->>'id' AS id, data->>'leadType' AS "leadType", data->>'name' AS name,
      data->>'status' AS status, data->>'phone' AS phone, data->>'email' AS email,
      data->>'location' AS location, data->>'googleMapsUrl' AS "googleMapsUrl",
      (data->>'latitude')::DOUBLE PRECISION AS latitude,
      (data->>'longitude')::DOUBLE PRECISION AS longitude
      FROM crm_leads
      WHERE jsonb_typeof(data->'latitude') = 'number' AND jsonb_typeof(data->'longitude') = 'number'`);
  }

  async listTypes() {
    await this.ensureSchema();
    const rows = await this.sql(`SELECT types.name, COUNT(leads.id)::INT AS count
      FROM lead_types types LEFT JOIN crm_leads leads ON LOWER(leads.lead_type) = LOWER(types.name)
      GROUP BY types.name ORDER BY types.name`);
    return rows.map((row) => ({ name: row.name, count: Number(row.count) }));
  }

  async addType(name) {
    await this.ensureSchema();
    const normalized = normalizeType(name);
    if (!normalized) throw new Error("Enter a lead type name.");
    const existing = await this.sql("SELECT name FROM lead_types WHERE LOWER(name) = LOWER($1) LIMIT 1", [normalized]);
    if (existing[0]) return existing[0].name;
    await this.sql("INSERT INTO lead_types (name) VALUES ($1)", [normalized]);
    return normalized;
  }

  async renameType(oldName, newName) {
    await this.ensureSchema();
    const oldType = normalizeType(oldName);
    const newType = normalizeType(newName);
    const conflict = await this.sql("SELECT 1 FROM lead_types WHERE LOWER(name) = LOWER($1) AND LOWER(name) <> LOWER($2)", [newType, oldType]);
    if (conflict.length) { const error = new Error("That lead type already exists."); error.code = "TYPE_EXISTS"; throw error; }
    const rows = await this.sql("UPDATE lead_types SET name = $1 WHERE LOWER(name) = LOWER($2) RETURNING name", [newType, oldType]);
    if (!rows.length) return null;
    const leads = await this.sql("SELECT id, data FROM crm_leads WHERE LOWER(lead_type) = LOWER($1)", [oldType]);
    for (const row of leads) {
      const data = { ...row.data, leadType: newType, updatedAt: new Date().toISOString() };
      await this.sql("UPDATE crm_leads SET lead_type = $1, data = $2::jsonb, updated_at = NOW() WHERE id = $3", [newType, JSON.stringify(data), row.id]);
    }
    return newType;
  }

  async deleteType(name) {
    await this.ensureSchema();
    const used = await this.sql("SELECT 1 FROM crm_leads WHERE LOWER(lead_type) = LOWER($1) LIMIT 1", [name]);
    if (used.length) { const error = new Error("Move or remove the leads in this type before deleting it."); error.code = "TYPE_IN_USE"; throw error; }
    await this.sql("DELETE FROM lead_types WHERE LOWER(name) = LOWER($1)", [name]);
    return true;
  }

  async importLeads(sourceLeads, leadType, options = {}) {
    await this.ensureSchema();
    const normalizedType = await this.addType(leadType);
    let imported = 0;
    let skipped = 0;
    const now = new Date().toISOString();
    for (const source of sourceLeads) {
      const email = String(source.email || "").trim();
      const phone = String(source.phone || "").trim();
      const placeId = String(source.placeId || "").trim();
      if (options.requireEmail !== false && !email) { skipped += 1; continue; }
      if (options.requirePhone === true && !phone) { skipped += 1; continue; }
      if (!email && !phone && !String(source.website || "").trim()) { skipped += 1; continue; }
      let duplicate;
      if (placeId) duplicate = await this.sql("SELECT 1 FROM crm_leads WHERE LOWER(lead_type) = LOWER($1) AND place_id = $2 LIMIT 1", [normalizedType, placeId]);
      else if (email) duplicate = await this.sql("SELECT 1 FROM crm_leads WHERE LOWER(lead_type) = LOWER($1) AND LOWER(email) = LOWER($2) LIMIT 1", [normalizedType, email]);
      else duplicate = await this.sql("SELECT 1 FROM crm_leads WHERE LOWER(lead_type) = LOWER($1) AND regexp_replace(phone, '\\D', '', 'g') = regexp_replace($2, '\\D', '', 'g') AND LOWER(data->>'name') = LOWER($3) LIMIT 1", [normalizedType, phone, source.name || ""]);
      if (duplicate.length) { skipped += 1; continue; }
      const data = {
        id: randomUUID(), leadType: normalizedType, name: String(source.name || "Unnamed lead"), email,
        role: String(source.role || ""), organization: String(source.schoolName || source.organization || ""), phone,
        details: String(source.details || ""), location: String(source.location || ""), country: String(source.country || source.location || ""),
        language: String(source.language || ""), schoolType: String(source.schoolType || ""), services: String(source.subjectsServices || source.services || ""),
        website: String(source.website || ""), sourceUrl: String(source.sourceUrl || ""), placeId, googleMapsUrl: String(source.googleMapsUrl || ""),
        latitude: source.latitude ?? null, longitude: source.longitude ?? null, rating: source.rating ?? null, ratingCount: source.ratingCount ?? null,
        source: String(source.source || "Firecrawl"), status: String(source.status || "New"), priority: String(source.priority || "Normal"),
        assignedTo: String(source.assignedTo || ""), feedback: String(source.feedback || ""), comments: String(source.comments || ""),
        lastContactedAt: String(source.lastContactedAt || ""), nextFollowUpAt: String(source.nextFollowUpAt || ""),
        createdAt: String(source.createdAt || now), updatedAt: String(source.updatedAt || now),
      };
      await this.sql(`INSERT INTO crm_leads (id, lead_type, email, phone, place_id, data, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`, [data.id, normalizedType, email, phone, placeId, JSON.stringify(data), data.createdAt, data.updatedAt]);
      imported += 1;
    }
    const [{ count }] = await this.sql("SELECT COUNT(*)::INT AS count FROM crm_leads");
    return { imported, skipped, total: Number(count) };
  }

  async updateLead(id, changes) {
    await this.ensureSchema();
    const rows = await this.sql("SELECT data FROM crm_leads WHERE id = $1", [id]);
    if (!rows.length) return null;
    const allowed = ["leadType", "status", "priority", "assignedTo", "services", "comments", "lastContactedAt", "nextFollowUpAt"];
    const data = { ...rows[0].data };
    for (const key of allowed) if (changes[key] !== undefined) data[key] = String(changes[key]).slice(0, ["services", "feedback", "comments"].includes(key) ? 5_000 : 150);
    const updatedAt = new Date().toISOString();
    const feedbackEntry = changes.feedbackEntry !== undefined ? changes.feedbackEntry : changes.feedback;
    if (String(feedbackEntry || "").trim()) {
      data.feedbackHistory = appendFeedbackHistory(data, feedbackEntry, changes.feedbackAuthor, updatedAt);
      data.feedback = String(feedbackEntry).trim().slice(0, 5_000);
    }
    data.updatedAt = updatedAt;
    if (data.leadType) await this.addType(data.leadType);
    await this.sql("UPDATE crm_leads SET lead_type = $1, data = $2::jsonb, updated_at = NOW() WHERE id = $3", [data.leadType, JSON.stringify(data), id]);
    return data;
  }

  async deleteLead(id) {
    await this.ensureSchema();
    const rows = await this.sql("DELETE FROM crm_leads WHERE id = $1 RETURNING id", [id]);
    return rows.length > 0;
  }

  async saveReport(report) {
    await this.ensureSchema();
    await this.sql(`INSERT INTO research_reports (id, data, generated_at) VALUES ($1, $2::jsonb, $3)
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, generated_at = EXCLUDED.generated_at, updated_at = NOW()`,
    [report.id, JSON.stringify(report), report.generatedAt]);
    return report;
  }

  async listReports() {
    await this.ensureSchema();
    const rows = await this.sql("SELECT data FROM research_reports ORDER BY generated_at DESC LIMIT 30");
    return rows.map(({ data: report }) => ({ id: report.id, generatedAt: report.generatedAt, companyName: report.company?.name, website: report.company?.website, score: report.qualification?.score, mode: report.mode }));
  }

  async getReport(id) {
    await this.ensureSchema();
    const rows = await this.sql("SELECT data FROM research_reports WHERE id = $1", [id]);
    return rows[0]?.data || null;
  }

  async countUsers() { await this.ensureSchema(); const rows = await this.sql("SELECT COUNT(*)::INT AS count FROM app_users"); return Number(rows[0].count); }
  async listUsers() { await this.ensureSchema(); return this.sql("SELECT id, email, role, active, created_at AS \"createdAt\" FROM app_users ORDER BY created_at"); }
  async getUserByEmail(email) { await this.ensureSchema(); const rows = await this.sql("SELECT * FROM app_users WHERE email = $1", [normalizeEmail(email)]); return rows[0] || null; }
  async getUserById(id) { await this.ensureSchema(); const rows = await this.sql("SELECT id, email, role, active FROM app_users WHERE id = $1", [id]); return rows[0] || null; }
  async createUser({ email, passwordHash, role }) {
    await this.ensureSchema();
    const rows = await this.sql(`INSERT INTO app_users (id, email, password_hash, role) VALUES ($1, $2, $3, $4)
      RETURNING id, email, role, active, created_at AS "createdAt"`, [randomUUID(), normalizeEmail(email), passwordHash, role]);
    return rows[0];
  }
  async updateUser(id, changes) {
    await this.ensureSchema();
    const current = await this.getUserById(id); if (!current) return null;
    const role = changes.role || current.role; const active = changes.active === undefined ? current.active : Boolean(changes.active);
    if (changes.passwordHash) await this.sql("UPDATE app_users SET role = $1, active = $2, password_hash = $3, updated_at = NOW() WHERE id = $4", [role, active, changes.passwordHash, id]);
    else await this.sql("UPDATE app_users SET role = $1, active = $2, updated_at = NOW() WHERE id = $3", [role, active, id]);
    return this.getUserById(id);
  }
  async createSession(tokenHash, userId, expiresAt) { await this.ensureSchema(); await this.sql("INSERT INTO app_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [tokenHash, userId, expiresAt]); }
  async getSession(tokenHash) { await this.ensureSchema(); const rows = await this.sql(`SELECT users.id, users.email, users.role, users.active FROM app_sessions sessions JOIN app_users users ON users.id = sessions.user_id WHERE sessions.token_hash = $1 AND sessions.expires_at > NOW()`, [tokenHash]); return rows[0] || null; }
  async deleteSession(tokenHash) { await this.ensureSchema(); await this.sql("DELETE FROM app_sessions WHERE token_hash = $1", [tokenHash]); }
}
