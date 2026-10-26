import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ITEM_STATES = ["queued", "running", "ready", "needs_review", "failed", "interrupted", "cancelled"];
const fail = (code, message, status) => Object.assign(new Error(message), { code, status });

function mapError(error) {
  const message = String(error?.message || "");
  if (error?.code === "22023") return fail("INVALID_ENRICHMENT_REQUEST", "Enrichment request contains invalid values.", 400);
  if (message.includes("BATCH_CONFLICT")) return fail("BATCH_CONFLICT", "This request key was already used with a different selected lead list.", 409);
  if (message.includes("BATCH_NOT_FOUND")) return fail("BATCH_NOT_FOUND", "Enrichment batch was not found.", 404);
  if (message.includes("LEAD_NOT_FOUND")) return fail("LEAD_NOT_FOUND", "A selected CRM lead was not found.", 404);
  if (message.includes("RETRY_NOT_ALLOWED")) return fail("RETRY_NOT_ALLOWED", "Only failed or interrupted items can be retried.", 409);
  if (message.includes("LEAD_ALREADY_ACTIVE")) return fail("LEAD_ALREADY_ACTIVE", "A selected lead is already being researched in another batch.", 409);
  if (message.includes("ATTEMPT_NOT_FOUND")) return fail("ATTEMPT_NOT_FOUND", "Research attempt was not found.", 404);
  if (error?.constraint === "crm_enrichment_attempts_active_lead_idx") return fail("LEAD_ALREADY_ACTIVE", "A selected lead is already being researched in another batch.", 409);
  return error;
}

function parseJson(value) {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function normalizeBatch(batch, items) {
  const counts = Object.fromEntries(ITEM_STATES.map((state) => [state, 0]));
  for (const item of items) counts[item.state] = (counts[item.state] || 0) + 1;
  return {
    id: batch.id,
    requestKey: batch.requestKey,
    leadIds: batch.leadIds || [],
    status: batch.status,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    items,
    counts,
  };
}

export class EnrichmentBatchStore {
  constructor(db, { now = () => new Date() } = {}) {
    if (!db?.sql) throw new Error("EnrichmentBatchStore requires the configured Neon database.");
    this.db = db;
    this.now = now;
  }

  async create(userId, requestKey, leadIds) {
    if (!UUID.test(String(userId || ""))) throw fail("INVALID_USER", "A CRM user ID is required.", 400);
    const key = String(requestKey || "");
    if (!key.trim() || key.length > 200) throw fail("INVALID_REQUEST_KEY", "requestKey must contain 1 to 200 nonblank characters.", 400);
    if (!Array.isArray(leadIds) || leadIds.length < 1 || leadIds.length > 20
      || leadIds.some((id) => !UUID.test(String(id))) || new Set(leadIds).size !== leadIds.length) {
      throw fail("INVALID_LEAD_IDS", "Select 1 to 20 distinct CRM lead IDs.", 400);
    }
    try {
      const rows = await this.db.sql("SELECT crm_create_enrichment_batch($1::uuid,$2::text,$3::uuid[]) AS id", [userId, key, leadIds]);
      return this.get(rows[0]?.id);
    } catch (error) { throw mapError(error); }
  }

  async get(batchId) {
    if (!UUID.test(String(batchId || ""))) return null;
    const batches = await this.db.sql(`SELECT id, request_key AS "requestKey", lead_ids AS "leadIds", status,
      created_at AS "createdAt", updated_at AS "updatedAt"
      FROM crm_enrichment_batches WHERE id=$1`, [batchId]);
    if (!batches.length) return null;
    const rows = await this.db.sql(`SELECT item.lead_id AS "leadId", item.state, item.attempt_id AS "attemptId",
      item.report, item.research, item.reason, item.credits_used AS "creditsUsed", item.usage,
      lead.data AS lead
      FROM crm_enrichment_items item LEFT JOIN crm_leads lead ON lead.id=item.lead_id
      WHERE item.batch_id=$1 ORDER BY item.ordinal`, [batchId]);
    const items = rows.map((item) => ({
      leadId: item.leadId,
      state: item.state,
      attemptId: item.attemptId,
      lead: item.lead || null,
      report: parseJson(item.report) ?? null,
      research: parseJson(item.research) ?? null,
      reason: item.reason || null,
      creditsUsed: item.creditsUsed == null ? null : Number(item.creditsUsed),
      usage: parseJson(item.usage) ?? null,
    }));
    return normalizeBatch(batches[0], items);
  }

  async list(userId, limit = 20) {
    if (!UUID.test(String(userId || ""))) throw fail("INVALID_USER", "A CRM user ID is required.", 400);
    const size = Math.max(1, Math.min(20, Number(limit) || 20));
    const rows = await this.db.sql("SELECT id FROM crm_enrichment_batches WHERE creator_user_id=$1 ORDER BY created_at DESC LIMIT $2", [userId, size]);
    return Promise.all(rows.map(({ id }) => this.get(id)));
  }

  async claimNext(batchId, operationKey) {
    if (!UUID.test(String(batchId || "")) || !UUID.test(String(operationKey || ""))) throw fail("INVALID_OPERATION", "Batch and operation keys must be UUIDs.", 400);
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RangeError("now must return a valid Date.");
    try {
      const rows = await this.db.sql("SELECT crm_claim_enrichment_item($1::uuid,$2::uuid,$3::timestamptz) AS result", [batchId, operationKey, now.toISOString()]);
      const result = parseJson(rows[0]?.result) || {};
      if (result.replay) return { attempt: null, replay: true, result: await this.get(batchId), savedResult: result.result || null };
      return { attempt: result.attempt || null, replay: false, result: null };
    } catch (error) { throw mapError(error); }
  }

  async complete(attemptId, result) {
    if (!UUID.test(String(attemptId || ""))) throw fail("INVALID_ATTEMPT", "Attempt ID must be a UUID.", 400);
    if (!result || typeof result !== "object" || !["ready", "needs_review", "failed", "interrupted"].includes(result.state)) {
      throw fail("INVALID_RESULT", "Research result state is invalid.", 400);
    }
    if (["ready", "needs_review"].includes(result.state) && (!result.research || !result.report)) {
      throw fail("INVALID_RESULT", "Research and report are required for completed enrichment.", 400);
    }
    if (result.usage && result.creditsUsed !== result.usage.reportedTotal) {
      throw fail("INVALID_RESULT", "creditsUsed must match reported usage or both remain null.", 400);
    }
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RangeError("now must return a valid Date.");
    try {
      const rows = await this.db.sql("SELECT crm_complete_enrichment_attempt($1::uuid,$2::jsonb,$3::timestamptz) AS result", [attemptId, JSON.stringify(result), now.toISOString()]);
      const applied = parseJson(rows[0]?.result);
      if (applied?.applied !== true) throw fail("ATTEMPT_FENCED", "Research attempt expired; use explicit retry to start another attempt.", 409);
      return this.get(applied.batchId);
    } catch (error) { throw mapError(error); }
  }

  async retry(batchId, leadIds) {
    if (!UUID.test(String(batchId || "")) || !Array.isArray(leadIds) || !leadIds.length
      || leadIds.length > 20 || leadIds.some((id) => !UUID.test(String(id))) || new Set(leadIds).size !== leadIds.length) {
      throw fail("INVALID_RETRY", "Retry requires distinct selected lead IDs.", 400);
    }
    try {
      await this.db.sql("SELECT crm_retry_enrichment_items($1::uuid,$2::uuid[],$3::timestamptz)", [batchId, leadIds, this.now().toISOString()]);
      return this.get(batchId);
    } catch (error) { throw mapError(error); }
  }

  async cancel(batchId) {
    if (!UUID.test(String(batchId || ""))) throw fail("INVALID_BATCH", "Batch ID must be a UUID.", 400);
    try {
      await this.db.sql("SELECT crm_cancel_enrichment_batch($1::uuid,$2::timestamptz)", [batchId, this.now().toISOString()]);
      return this.get(batchId);
    } catch (error) { throw mapError(error); }
  }
}
