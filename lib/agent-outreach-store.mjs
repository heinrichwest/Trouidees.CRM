import { localDay } from "./outreach-time.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})$/i;
const fail = (code, message, status) => Object.assign(new Error(message), { code, status });

/** @typedef {{researchedAt:string,ready:boolean,messageable:boolean,research:{confidence:string,angle:string,dossierRef:string|null,facts:Array<{text:string,sourceUrl:string}>}}} ResearchInput */
/** @typedef {ResearchInput & {leadId:string,readyAt:string|null}} ResearchDTO */
/** @typedef {{id:string,leadId:string,requestKey:string,state:'reserved'|'submitted'|'delivered'|'released',jobKey:string|null}} Claim */
/** @typedef {{agent:string,day:string,timezone:'Africa/Johannesburg',target:8,delivered:number,outstanding:number,remaining:number}} Quota */
/** @typedef {Record<string,unknown>&{id:string,doNotContact:boolean}} LeadDTO */
/** @typedef {{claim:Claim|null,lead:LeadDTO|null,research:ResearchDTO|null,quota:Quota,reason:null|'pool_empty'|'capacity_held'|'daily_cap'}} ClaimResult */

function normalizeResearchInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("INVALID_RESEARCH", "Research must be an object.", 400);
  if (typeof input.researchedAt !== "string" || !ISO_INSTANT.test(input.researchedAt) || !Number.isFinite(Date.parse(input.researchedAt))) {
    throw fail("INVALID_RESEARCH", "researchedAt must be an ISO timestamp.", 400);
  }
  const calendarDate = input.researchedAt.slice(0, 10);
  const [year, month, day] = calendarDate.split("-").map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== calendarDate) {
    throw fail("INVALID_RESEARCH", "researchedAt must contain a valid calendar date.", 400);
  }
  if (typeof input.ready !== "boolean" || typeof input.messageable !== "boolean") throw fail("INVALID_RESEARCH", "ready and messageable must be booleans.", 400);
  const source = input.research;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw fail("INVALID_RESEARCH", "research must be an object.", 400);
  if (typeof source.confidence !== "string" || source.confidence.length > 50
    || typeof source.angle !== "string" || source.angle.length > 200
    || !(source.dossierRef === null || (typeof source.dossierRef === "string" && source.dossierRef.length <= 1000))
    || !Array.isArray(source.facts) || source.facts.length > 100) {
    throw fail("INVALID_RESEARCH", "Research fields exceed the supported shape.", 400);
  }
  const facts = source.facts.map((fact) => {
    if (!fact || typeof fact.text !== "string" || !fact.text.trim() || fact.text.length > 2000
      || typeof fact.sourceUrl !== "string" || fact.sourceUrl.length > 2000) {
      throw fail("INVALID_RESEARCH", "Each fact needs text and a source URL.", 400);
    }
    let url;
    try { url = new URL(fact.sourceUrl); } catch { throw fail("INVALID_RESEARCH", "Fact source URLs must be HTTP(S).", 400); }
    if (!new Set(["http:", "https:"]).has(url.protocol)) throw fail("INVALID_RESEARCH", "Fact source URLs must be HTTP(S).", 400);
    return { text: fact.text, sourceUrl: fact.sourceUrl };
  });
  if (input.ready && (!input.messageable || facts.length === 0)) throw fail("INVALID_RESEARCH", "Ready research must be messageable and include a sourced fact.", 400);
  const research = { confidence: source.confidence, angle: source.angle, dossierRef: source.dossierRef, facts };
  const normalized = { researchedAt: input.researchedAt, ready: input.ready, messageable: input.messageable, research };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > 50_000) throw fail("INVALID_RESEARCH", "Research exceeds 50,000 UTF-8 bytes.", 400);
  return normalized;
}

function readResult(row) {
  if (!row) return null;
  const result = row.result;
  return typeof result === "string" ? JSON.parse(result) : result;
}

function mapSqlError(error) {
  const message = String(error?.message || "");
  if (message.includes("RESEARCH_CONFLICT")) return fail("RESEARCH_CONFLICT", "Research with this timestamp already has different content.", 409);
  if (message.includes("LEAD_NOT_FOUND")) return fail("LEAD_NOT_FOUND", "Lead was not found.", 404);
  if (message.includes("CLAIM_CONFLICT")) return fail("CLAIM_CONFLICT", "Claim has already been submitted or released with different values.", 409);
  if (message.includes("CLAIM_NOT_FOUND")) return fail("CLAIM_NOT_FOUND", "Claim was not found.", 404);
  if (message.includes("CLAIM_FORBIDDEN")) return fail("CLAIM_FORBIDDEN", "Claim belongs to a different agent.", 403);
  if (message.includes("NOT_OWNED")) return fail("NOT_OWNED", "The lead is not assigned to this agent.", 403);
  if (message.includes("NATIVE_CONVERSATION_NOT_FOUND")) return fail("NATIVE_CONVERSATION_NOT_FOUND", "A delivered native conversation for this lead was not found.", 404);
  return error;
}

/**
 * Shared DTO definitions: ResearchInput, ResearchDTO, Claim, ClaimResult, Quota and LeadDTO
 * are JSON contracts returned by the CRM's atomic PostgreSQL procedures.
 */
export class AgentOutreachStore {
  constructor(db, { now = () => new Date() } = {}) {
    if (!db?.sql) throw new Error("AgentOutreachStore requires the configured CRM database.");
    this.db = db;
    this.now = now;
  }

  async putResearch(leadId, input, actor) {
    if (!UUID.test(String(leadId))) throw fail("INVALID_LEAD_ID", "leadId must be a UUID.", 400);
    if (!actor || actor.kind !== "crm") throw fail("FORBIDDEN", "Only CRM users may publish lead research.", 403);
    if (!UUID.test(String(actor.userId || ""))) throw fail("INVALID_ACTOR", "A CRM user ID is required.", 400);
    const normalized = normalizeResearchInput(input);
    try {
      const rows = await this.db.sql(`SELECT crm_put_lead_research($1::uuid, $2::jsonb, $3::boolean, $4::boolean, $5::timestamptz, $6::uuid) AS result`, [
        leadId, JSON.stringify(normalized.research), normalized.messageable, normalized.ready, normalized.researchedAt, actor.userId,
      ]);
      return readResult(rows[0]);
    } catch (error) { throw mapSqlError(error); }
  }

  async claimNext(agent, requestKey) {
    const name = String(agent || "").trim();
    const key = String(requestKey || "");
    if (!name || name.length > 200) throw fail("INVALID_AGENT", "Authenticated agent label is required.", 400);
    if (key.length < 1 || key.length > 200) throw fail("INVALID_REQUEST_KEY", "requestKey must contain 1 to 200 characters.", 400);
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RangeError("now must return a valid Date.");
    try {
      const rows = await this.db.sql("SELECT crm_claim_ready_lead($1::text, $2::text, $3::timestamptz) AS result", [name, key, now.toISOString()]);
      return readResult(rows[0]);
    } catch (error) { throw mapSqlError(error); }
  }

  async updateClaim(id, action, agent) {
    if (!UUID.test(String(id))) throw fail("INVALID_CLAIM_ID", "claim ID must be a UUID.", 400);
    const name = String(agent || "").trim();
    if (!name) throw fail("INVALID_AGENT", "Authenticated agent label is required.", 400);
    if (!action || typeof action !== "object" || Array.isArray(action)) throw fail("INVALID_ACTION", "Claim action is required.", 400);
    let normalized;
    if (action.state === "submitted" && typeof action.jobKey === "string" && action.jobKey.trim()) {
      normalized = { state: "submitted", jobKey: action.jobKey.trim() };
    } else if (action.state === "released" && ["not_submitted", "terminal_no_delivery"].includes(action.reason)) {
      normalized = { state: "released", reason: action.reason };
    } else throw fail("INVALID_ACTION", "Unsupported claim transition.", 400);
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RangeError("now must return a valid Date.");
    try {
      const rows = await this.db.sql("SELECT crm_update_outreach_claim($1::text, $2::uuid, $3::jsonb, $4::timestamptz) AS result", [name, id, JSON.stringify(normalized), now.toISOString()]);
      return readResult(rows[0]);
    } catch (error) { throw mapSqlError(error); }
  }

  async getQuota(agent) {
    const name = String(agent || "").trim();
    if (!name || name.length > 200) throw fail("INVALID_AGENT", "Authenticated agent label is required.", 400);
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RangeError("now must return a valid Date.");
    const day = localDay(now);
    const rows = await this.db.sql(`SELECT
      (SELECT COUNT(DISTINCT lead_id)::int FROM lead_first_contacts
        WHERE kind = 'native' AND agent = $1 AND (effective_delivered_at AT TIME ZONE 'Africa/Johannesburg')::date = $2::date) AS delivered,
      (SELECT COUNT(*)::int FROM lead_outreach_claims WHERE agent = $1 AND state IN ('reserved', 'submitted')) AS outstanding`, [name, day]);
    const delivered = Number(rows[0]?.delivered || 0);
    const outstanding = Number(rows[0]?.outstanding || 0);
    return { agent: name, day, timezone: "Africa/Johannesburg", target: 8, delivered, outstanding, remaining: Math.max(0, 8 - delivered - outstanding) };
  }

  async finalizeDelivery(leadId, conversationId, agent) {
    if (!UUID.test(String(leadId || "")) || !UUID.test(String(conversationId || ""))) {
      throw fail("INVALID_DELIVERY", "Lead and conversation IDs must be UUIDs.", 400);
    }
    const name = String(agent || "").trim();
    if (!name || name.length > 200) throw fail("INVALID_AGENT", "Authenticated agent label is required.", 400);
    try {
      const rows = await this.db.sql("SELECT crm_finalize_native_delivery($1::text,$2::uuid,$3::uuid) AS result", [name, leadId, conversationId]);
      return readResult(rows[0]);
    } catch (error) { throw mapSqlError(error); }
  }

  async listNoReplyDue(agent, cursor = null, limit = 100) {
    const name = String(agent || "").trim();
    if (!name || name.length > 200) throw fail("INVALID_AGENT", "Authenticated agent label is required.", 400);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail("INVALID_LIMIT", "limit must be between 1 and 100.", 400);
    let afterAt = null; let afterLeadId = null;
    if (cursor != null) {
      try {
        if (String(cursor).length > 512) throw new Error();
        const decoded = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
        if (typeof decoded.dueAt !== "string" || !Number.isFinite(Date.parse(decoded.dueAt)) || !UUID.test(decoded.leadId)) throw new Error();
        afterAt = new Date(decoded.dueAt).toISOString(); afterLeadId = decoded.leadId;
      } catch { throw fail("INVALID_CURSOR", "cursor is invalid.", 400); }
    }
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RangeError("now must return a valid Date.");
    const [rows, unknownRows] = await Promise.all([
      this.db.sql("SELECT * FROM crm_list_no_reply_due($1::text,$2::timestamptz,$3::timestamptz,$4::uuid,$5::int)", [name, now.toISOString(), afterAt, afterLeadId, limit + 1]),
      this.db.sql(`SELECT first_contact.lead_id, lead.phone, first_contact.first_conversation_id
        FROM lead_first_contacts first_contact JOIN crm_leads lead ON lead.id=first_contact.lead_id
        WHERE NOT first_contact.source_time_known AND first_contact.first_conversation_id IS NOT NULL
          AND BTRIM(COALESCE(lead.data->>'assignedTo',''))=$1
          AND NOT EXISTS (SELECT 1 FROM lead_contact_outcomes outcome WHERE outcome.lead_id=lead.id
            AND outcome.first_conversation_id=first_contact.first_conversation_id AND outcome.outcome='no_reply' AND outcome.superseded_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM lead_conversations incoming_conversation
            CROSS JOIN LATERAL jsonb_array_elements(incoming_conversation.messages) message
            WHERE incoming_conversation.lead_id=lead.id AND message->>'direction' IN ('incoming','inbound')
              AND COALESCE(NULLIF(message->>'timestamp','')::timestamptz,incoming_conversation.occurred_at,incoming_conversation.created_at) >= first_contact.effective_delivered_at)
        ORDER BY lead.id LIMIT 100`, [name]),
    ]);
    const leads = rows.slice(0, limit).map((row) => ({ leadId:row.lead_id, phone:row.phone, firstConversationId:row.first_conversation_id, firstDeliveredAt:row.first_delivered_at, dueAt:row.due_at }));
    const nextCursor = rows.length > limit && leads.length
      ? Buffer.from(JSON.stringify({ dueAt:leads.at(-1).dueAt, leadId:leads.at(-1).leadId }), "utf8").toString("base64url") : null;
    const unknownDeliveryTimes = unknownRows.map((row) => ({ leadId:row.lead_id, phone:row.phone,
      firstConversationId:row.first_conversation_id, firstDeliveredAt:null, dueAt:null, unknownDeliveryTime:true }));
    return { leads, nextCursor, unknownDeliveryTimes };
  }

  async recordNoReply(leadId, firstConversationId, agent) {
    if (!UUID.test(String(leadId || "")) || !UUID.test(String(firstConversationId || ""))) throw fail("INVALID_DELIVERY", "Lead and conversation IDs must be UUIDs.", 400);
    const name = String(agent || "").trim();
    if (!name || name.length > 200) throw fail("INVALID_AGENT", "Authenticated agent label is required.", 400);
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RangeError("now must return a valid Date.");
    try {
      const rows = await this.db.sql("SELECT crm_record_no_reply($1::text,$2::uuid,$3::uuid,$4::timestamptz) AS result", [name, leadId, firstConversationId, now.toISOString()]);
      return readResult(rows[0]);
    } catch (error) { throw mapSqlError(error); }
  }
}
