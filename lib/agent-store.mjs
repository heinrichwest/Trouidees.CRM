import { randomUUID } from "node:crypto";

const PAGE_DEFAULT = 25;
const PAGE_MAX = 100;
const leadDto = (row) => row ? { ...row.data, doNotContact: Boolean(row.do_not_contact) } : null;
const failure = (code, message, status) => Object.assign(new Error(message), { code, status });
const ownership = (leadId, agent) => failure("NOT_OWNED", `Lead ${leadId} is not assigned to ${agent}.`, 403);
const idempotencyConflict = () => failure("IDEMPOTENCY_CONFLICT", "Conversation segment or idempotency key was already used with different content.", 409);
const stableJson = (value) => Array.isArray(value) ? `[${value.map(stableJson).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const instantMilliseconds = (value) => value instanceof Date ? value.getTime() : Date.parse(value);
const sameInstant = (left, right) => (left == null && right == null)
  || (left != null && right != null && Number.isFinite(instantMilliseconds(left)) && Number.isFinite(instantMilliseconds(right)) && instantMilliseconds(left) === instantMilliseconds(right));
const sameConversation = (row, input) => row.segmentId === input.segmentId
  && row.idempotencyKey === input.idempotencyKey
  && row.channel === input.channel
  && row.summary === input.summary
  && stableJson(row.messages) === stableJson(input.messages)
  && sameInstant(row.occurredAt, input.occurredAt);

const agentName = (value) => String(value || "Andrew").trim() || "Andrew";

const LEAD_FIELDS = new Set(["id", "name", "email", "phone", "status", "priority", "nextFollowUpAt", "lastContactedAt", "assignedTo", "leadType", "organization"]);
const pickLeadFields = (lead, fields) => {
  if (!lead) return lead;
  let fieldList = fields;
  if (typeof fieldList === "string") fieldList = fieldList.split(",").map((item) => item.trim()).filter(Boolean);
  if (!Array.isArray(fieldList) || !fieldList.length) return lead;
  const requested = [...new Set(fieldList)].filter((field) => LEAD_FIELDS.has(field));
  const out = { id: lead.id };
  for (const field of requested) if (Object.prototype.hasOwnProperty.call(lead, field)) out[field] = lead[field];
  return out;
};
export class AgentStore {
  constructor(neonStore) {
    if (!neonStore?.sql) throw new Error("AgentStore requires the configured Neon store.");
    this.db = neonStore;
  }

  async ready() { await this.db.ensureSchema(); }
  async lead(id) {
    const rows = await this.db.sql("SELECT data, do_not_contact FROM crm_leads WHERE id = $1", [id]);
    return rows[0] || null;
  }
  async visibleRow(id, agent = "Andrew") {
    const name = agentName(agent);
    const row = await this.lead(id);
    if (row && ![ "", name ].includes(String(row.data.assignedTo || "").trim())) return null;
    return row;
  }
  async ownedRow(id, agent = "Andrew") {
    const name = agentName(agent);
    const row = await this.lead(id);
    if (row && String(row.data.assignedTo || "").trim() !== name) throw ownership(id, name);
    return row;
  }

  async listVisibleLeads({ query = "", filters = {}, limit = PAGE_DEFAULT, cursor = "", agent = "Andrew", fields = null } = {}) {
    await this.ready();
    const size = Math.max(1, Math.min(PAGE_MAX, Number(limit) || PAGE_DEFAULT));
    const offset = Math.max(0, Number(cursor) || 0);
    const q = String(query).trim();
    const name = agentName(agent);
    let fieldList = fields;
    if (typeof fieldList === "string") fieldList = fieldList.split(",").map((item) => item.trim()).filter(Boolean);
    const params = [size + 1, offset, name];
    const clauses = ["COALESCE(BTRIM(data->>'assignedTo'), '') IN ('', $3)"];
    if (q) {
      const digits = q.replace(/\D/g, "");
      if (digits.length >= 7) {
        params.push(digits);
        clauses.push(`crm_normalize_za_phone(phone) LIKE '%' || crm_normalize_za_phone($${params.length}) || '%'`);
      } else {
        params.push(`%${q}%`);
        const n = params.length;
        clauses.push(`(data->>'name' ILIKE $${n} OR data->>'email' ILIKE $${n} OR data->>'organization' ILIKE $${n} OR data->>'leadType' ILIKE $${n} OR data->>'phone' ILIKE $${n})`);
      }
    }
    for (const field of ["leadType", "status"]) {
      if (filters[field]) { params.push(String(filters[field]).slice(0, 100)); clauses.push(`data->>'${field}' = $${params.length}`); }
    }
    if (filters.assignedTo) { params.push(String(filters.assignedTo).slice(0, 100)); clauses.push(`data->>'assignedTo' = $${params.length}`); }
    if (filters.unassigned === true) { clauses.push(`COALESCE(BTRIM(data->>'assignedTo'), '') = ''`); }
    const rows = await this.db.sql(`SELECT id, data, do_not_contact FROM crm_leads WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id LIMIT $1 OFFSET $2`, params);
    if (q.replace(/\D/g, "").length >= 7) {
      const normalized = q.replace(/\D/g, "");
      const candidateFilters = ["COALESCE(BTRIM(data->>'assignedTo'), '') IN ('', $1)"];
      const candidateParams = [name];
      for (const field of ["leadType", "status"]) {
        if (filters[field]) { candidateParams.push(String(filters[field]).slice(0, 100)); candidateFilters.push(`data->>'${field}' = $${candidateParams.length}`); }
      }
      if (filters.assignedTo) { candidateParams.push(String(filters.assignedTo).slice(0, 100)); candidateFilters.push(`data->>'assignedTo' = $${candidateParams.length}`); }
      if (filters.unassigned === true) { candidateFilters.push(`COALESCE(BTRIM(data->>'assignedTo'), '') = ''`); }
      const phoneMatch = `crm_normalize_za_phone(phone) = crm_normalize_za_phone($${candidateParams.length + 1})`;
      candidateParams.push(normalized);
      const where = [...candidateFilters, phoneMatch].join(" AND ");
      const duplicateProbe = await this.db.sql(`SELECT id FROM crm_leads WHERE ${where} ORDER BY created_at DESC, id LIMIT 2`, candidateParams);
      if (duplicateProbe.length > 1) {
        const pageParams = [...candidateParams, size + 1, offset];
        const matches = await this.db.sql(`SELECT id FROM crm_leads WHERE ${where} ORDER BY created_at DESC, id LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`, pageParams);
        const hasMore = matches.length > size;
        return { ambiguous: true, candidates: matches.slice(0, size).map((row) => row.id), leads: [], nextCursor: hasMore ? String(offset + size) : null };
      }
    }
    const more = rows.length > size;
    return { leads: rows.slice(0, size).map(leadDto).map((lead) => pickLeadFields(lead, fieldList)), nextCursor: more ? String(offset + size) : null };
  }

  async getVisibleLead(id, agentOrOptions = "Andrew", fieldsArg = null) {
    let agent = "Andrew";
    let fields = fieldsArg;
    if (agentOrOptions && typeof agentOrOptions === "object" && !Array.isArray(agentOrOptions)) {
      agent = agentOrOptions.agent || agentOrOptions.agentName || "Andrew";
      if (fields === null && agentOrOptions.fields != null) fields = agentOrOptions.fields;
    } else if (typeof agentOrOptions === "string") {
      agent = agentOrOptions;
    }
    await this.ready();
    const lead = leadDto(await this.visibleRow(id, agent));
    if (!lead) return null;
    return pickLeadFields(lead, fields);
  }

  async assignSelf(id, agent = "Andrew") {
    await this.ready();
    const name = agentName(agent);
    const rows = await this.db.sql(`UPDATE crm_leads SET data = jsonb_set(data, '{assignedTo}', to_jsonb($2::text)), updated_at = NOW()
      WHERE id = $1 AND COALESCE(BTRIM(data->>'assignedTo'), '') = '' RETURNING data, do_not_contact`, [id, name]);
    if (rows[0]) return leadDto(rows[0]);
    const current = await this.lead(id);
    if (!current) return null;
    if (String(current.data.assignedTo || "").trim() === name) return leadDto(current);
    throw failure("ASSIGNMENT_CONFLICT", "Lead is assigned to another owner.", 409);
  }

  async appendConversation({ leadId, segmentId, channel = "WhatsApp", messages, summary, idempotencyKey, occurredAt = null, agent }) {
    await this.ready();
    const name = agentName(agent);
    const exists = await this.db.sql("SELECT data->>'assignedTo' AS owner FROM crm_leads WHERE id = $1", [leadId]);
    if (!exists.length) return null;
    if (String(exists[0].owner || "").trim() !== name) throw ownership(leadId, name);
    const rows = await this.db.sql(`INSERT INTO lead_conversations (id, lead_id, segment_id, channel, messages, summary, idempotency_key, occurred_at)
      SELECT $1, leads.id, $2, $3, $4::jsonb, $5, $6, $7 FROM crm_leads leads
      WHERE leads.id = $8 AND BTRIM(COALESCE(leads.data->>'assignedTo', '')) = $9
      ON CONFLICT DO NOTHING
      RETURNING id, lead_id AS "leadId", segment_id AS "segmentId", channel, messages, summary, occurred_at AS "occurredAt", created_at AS "createdAt"`,
    [randomUUID(), segmentId, channel, JSON.stringify(messages), summary, idempotencyKey, occurredAt, leadId, name]);
    if (rows[0]) return rows[0];
    const existing = await this.db.sql(`SELECT leads.id AS "leadId", BTRIM(COALESCE(leads.data->>'assignedTo', '')) AS owner,
        conversation.id, conversation.segment_id AS "segmentId", conversation.channel, conversation.messages, conversation.summary,
        conversation.idempotency_key AS "idempotencyKey", conversation.occurred_at AS "occurredAt", conversation.created_at AS "createdAt"
      FROM lead_conversations conversation
      JOIN crm_leads leads ON leads.id = conversation.lead_id
      WHERE conversation.lead_id = $1
        AND BTRIM(COALESCE(leads.data->>'assignedTo', '')) = $2
        AND (conversation.idempotency_key = $3 OR conversation.segment_id = $4)
      ORDER BY conversation.created_at, conversation.id`, [leadId, name, idempotencyKey, segmentId]);
    if (existing.length) {
      if (existing.length === 1 && sameConversation(existing[0], { segmentId, channel, messages, summary, idempotencyKey, occurredAt })) return existing[0];
      throw idempotencyConflict();
    }
    const current = await this.lead(leadId);
    if (!current) return null;
    if (String(current.data.assignedTo || "").trim() !== name) throw ownership(leadId, name);
    throw idempotencyConflict();
  }

  async listConversations(leadId, agent = "Andrew") {
    await this.ready();
    const name = agentName(agent);
    const rows = await this.db.sql(`SELECT leads.id, BTRIM(COALESCE(leads.data->>'assignedTo', '')) AS owner,
        COALESCE(history.items, '[]'::jsonb) AS conversations
      FROM crm_leads leads
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'id', conversation.id, 'segmentId', conversation.segment_id, 'channel', conversation.channel,
          'messages', conversation.messages, 'summary', conversation.summary,
          'occurredAt', conversation.occurred_at, 'createdAt', conversation.created_at
        ) ORDER BY COALESCE(conversation.occurred_at, conversation.created_at), conversation.created_at, conversation.id) AS items
        FROM lead_conversations conversation
        WHERE conversation.lead_id = leads.id
          AND BTRIM(COALESCE(leads.data->>'assignedTo', '')) = $2
      ) history ON TRUE
      WHERE leads.id = $1`, [leadId, name]);
    if (!rows.length) return null;
    if (rows[0].owner !== name) throw ownership(leadId, name);
    return rows[0].conversations;
  }

  async appendNote(leadId, body, author = "Andrew", agent) {
    await this.ready();
    const name = agentName(agent || author);
    const rows = await this.db.sql(`INSERT INTO lead_notes (id, lead_id, body, author)
      SELECT $1, id, $2, $3 FROM crm_leads WHERE id = $4 AND BTRIM(COALESCE(data->>'assignedTo', '')) = $5
      RETURNING id, lead_id AS "leadId", body, author, occurred_at AS "occurredAt"`, [randomUUID(), body, author, leadId, name]);
    if (rows[0]) return rows[0];
    if (await this.lead(leadId)) throw ownership(leadId, name);
    return null;
  }

  async updateLeadLimited(id, patch, agent = "Andrew") {
    await this.ready();
    const name = agentName(agent);
    const keys = Object.keys(patch);
    if (keys.some((key) => !["status", "feedback", "comments", "nextFollowUpAt", "lastContactedAt", "doNotContact", "dncReason", "dncWording"].includes(key))) throw failure("INVALID_FIELDS", "Unsupported lead update field.", 400);
    if (patch.doNotContact === false) throw failure("DNC_CLEAR_FORBIDDEN", "Only a human administrator can clear DNC.", 403);
    const before = await this.db.sql("SELECT data->>'assignedTo' AS owner, do_not_contact FROM crm_leads WHERE id = $1", [id]);
    if (!before.length) return null;
    if (String(before[0].owner || "").trim() !== name) throw ownership(id, name);
    const merged = { ...patch }; delete merged.doNotContact; delete merged.dncReason; delete merged.dncWording;
    const rows = await this.db.sql(`WITH current AS (
        SELECT id, do_not_contact FROM crm_leads WHERE id = $1 AND BTRIM(COALESCE(data->>'assignedTo', '')) = $8 FOR UPDATE
      ), updated AS (
        UPDATE crm_leads leads SET data = leads.data || $2::jsonb, do_not_contact = leads.do_not_contact OR $3, updated_at = NOW()
        FROM current WHERE leads.id = current.id
        RETURNING leads.data, leads.do_not_contact, current.do_not_contact AS prior_dnc
      ), audited AS (
        INSERT INTO lead_dnc_audit (id, lead_id, action, actor, reason, wording)
        SELECT $4, $1, 'set', $9, $5, $6 FROM updated WHERE $3 AND NOT prior_dnc RETURNING id
      ) SELECT data, do_not_contact FROM updated`, [id, JSON.stringify(merged), patch.doNotContact === true, randomUUID(), String(patch.dncReason || "Contact requested no further contact"), String(patch.dncWording || ""), name, name, name]);
    if (!rows[0]) throw ownership(id, name);
    return leadDto(rows[0]);
  }

  async setDnc(id, reason, wording = "") { return this.updateLeadLimited(id, { doNotContact: true, dncReason: reason, dncWording: wording }); }

  async bulkUpdateLeads(agent, ids, patch = {}) {
    await this.ready();
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50) throw failure("INVALID_IDS", "ids must be an array of 1 to 50 lead IDs.", 400);
    const cleanPatch = patch && typeof patch === "object" ? patch : {};
    const keys = Object.keys(cleanPatch);
    const allowed = ["status", "feedback", "comments", "nextFollowUpAt", "lastContactedAt", "doNotContact", "dncReason", "dncWording"];
    if (keys.some((key) => !allowed.includes(key))) throw failure("INVALID_FIELDS", "Unsupported lead update field.", 400);
    if (cleanPatch.doNotContact === false) throw failure("DNC_CLEAR_FORBIDDEN", "Only a human administrator can clear DNC.", 403);
    let updated = 0;
    const failed = [];
    for (const id of ids) {
      try {
        const lead = await this.updateLeadLimited(id, cleanPatch, agent);
        if (!lead) failed.push({ id, error: "Lead not found." });
        else updated += 1;
      } catch (cause) {
        failed.push({ id, error: cause?.message || "Update failed." });
      }
    }
    return { updated, failed };
  }

  async transferLead(id, fromAgentOrToLabel, toLabelMaybe, actor = "admin") {
    await this.ready();
    // Support transferLead(id, toLabel) and transferLead(id, fromAgent, toLabel).
    let fromAgent = null;
    let toLabel = toLabelMaybe;
    if (toLabel === undefined) {
      toLabel = fromAgentOrToLabel;
      fromAgent = null;
    } else {
      fromAgent = fromAgentOrToLabel;
    }
    const cleanTo = String(toLabel || "").trim().slice(0, 100);
    if (!cleanTo) throw failure("INVALID_LABEL", "A target agent label is required.", 400);
    const current = await this.lead(id);
    if (!current) return null;
    const from = fromAgent != null ? String(fromAgent).trim() : String(current.data?.assignedTo || "").trim() || "Unassigned";
    const rows = await this.db.sql(`UPDATE crm_leads SET data = jsonb_set(data, '{assignedTo}', to_jsonb($2::text)), updated_at = NOW() WHERE id = $1 RETURNING data, do_not_contact`, [id, cleanTo]);
    if (!rows[0]) return null;
    await this.db.sql(`INSERT INTO lead_notes (id, lead_id, body, author) VALUES ($1, $2, $3, $4)`, [randomUUID(), id, `Transferred from ${from} to ${cleanTo} by admin`, String(actor || "admin")]);
    return leadDto(rows[0]);
  }
  async clearDnc(id, adminId, reason) {
    await this.ready();
    const rows = await this.db.sql(`WITH cleared AS (
        UPDATE crm_leads SET do_not_contact = FALSE, updated_at = NOW() WHERE id = $1 AND do_not_contact = TRUE RETURNING id
      ), audited AS (
        INSERT INTO lead_dnc_audit (id, lead_id, action, actor, reason)
        SELECT $2, id, 'clear', $3, $4 FROM cleared RETURNING id
      ) SELECT id FROM cleared`, [id, randomUUID(), adminId, reason]);
    if (!rows.length) return Boolean(await this.lead(id));
    return true;
  }

  async createLead(agent, data = {}) {
    await this.ready();
    const name = agentName(agent);
    const leadName = String(data.name || "").trim().slice(0, 200);
    if (!leadName) throw failure("INVALID_NAME", "Lead name is required.", 400);
    const leadType = String(data.leadType || "").trim().slice(0, 100);
    if (!leadType) throw failure("INVALID_LEAD_TYPE", "Lead type is required.", 400);
    const email = String(data.email || "").trim();
    const phone = String(data.phone || "").trim();
    // dedup within the same lead type
    if (email) {
      const dup = await this.db.sql("SELECT id FROM crm_leads WHERE LOWER(lead_type) = LOWER($1) AND LOWER(email) = LOWER($2) LIMIT 1", [leadType, email]);
      if (dup.length) {
        const row = await this.db.sql("SELECT data, do_not_contact FROM crm_leads WHERE id = $1", [dup[0].id]);
        return { lead: leadDto(row[0]), created: false };
      }
    } else if (phone) {
      const dup = await this.db.sql("SELECT id FROM crm_leads WHERE LOWER(lead_type) = LOWER($1) AND regexp_replace(phone, '\\D', '', 'g') = regexp_replace($2, '\\D', '', 'g') LIMIT 1", [leadType, phone]);
      if (dup.length) {
        const row = await this.db.sql("SELECT data, do_not_contact FROM crm_leads WHERE id = $1", [dup[0].id]);
        return { lead: leadDto(row[0]), created: false };
      }
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const leadData = {
      id, leadType, name, email, role: String(data.role || "").slice(0, 100),
      organization: String(data.organization || "").slice(0, 200), phone,
      details: String(data.details || "").slice(0, 2000), location: String(data.location || "").slice(0, 200),
      country: String(data.country || "").slice(0, 100), language: String(data.language || "").slice(0, 100),
      schoolType: String(data.schoolType || "").slice(0, 100), services: String(data.services || "").slice(0, 500),
      website: String(data.website || "").slice(0, 500), sourceUrl: String(data.sourceUrl || "").slice(0, 500),
      placeId: String(data.placeId || "").slice(0, 200), googleMapsUrl: String(data.googleMapsUrl || "").slice(0, 500),
      latitude: data.latitude ?? null, longitude: data.longitude ?? null,
      rating: data.rating ?? null, ratingCount: data.ratingCount ?? null,
      source: String(data.source || "Agent").slice(0, 100), status: String(data.status || "New").slice(0, 150),
      priority: String(data.priority || "Normal").slice(0, 50), assignedTo: name,
      feedback: String(data.feedback || "").slice(0, 5000), comments: String(data.comments || "").slice(0, 5000),
      lastContactedAt: String(data.lastContactedAt || "").slice(0, 150),
      nextFollowUpAt: String(data.nextFollowUpAt || "").slice(0, 150),
      createdAt: now, updatedAt: now, doNotContact: false,
    };
    await this.db.sql(`INSERT INTO crm_leads (id, lead_type, email, phone, place_id, data, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [id, leadType, email, phone, String(data.placeId || ""), JSON.stringify(leadData), now, now]);
    await this.db.sql("INSERT INTO lead_types (name) VALUES ($1) ON CONFLICT DO NOTHING", [leadType]);
    return { lead: leadData, created: true };
  }

  async getAgentStats(agent) {
    await this.ready();
    const name = agentName(agent);
    const rows = await this.db.sql(`SELECT data->>'status' AS status, COUNT(*)::INT AS count FROM crm_leads WHERE COALESCE(BTRIM(data->>'assignedTo'), '') = $1 GROUP BY data->>'status' ORDER BY count DESC`, [name]);
    const byStatus = {};
    let total = 0;
    for (const row of rows) { byStatus[row.status || "Unknown"] = Number(row.count); total += Number(row.count); }
    return { agent: name, total, byStatus };
  }

  async listActivity(leadId) {
    await this.ready();
    if (!await this.lead(leadId)) return null;
    const [conversations, notes] = await Promise.all([
      this.db.sql("SELECT id, messages, summary, occurred_at AS \"occurredAt\" FROM lead_conversations WHERE lead_id = $1 ORDER BY occurred_at NULLS LAST, id", [leadId]),
      this.db.sql("SELECT id, body, author, occurred_at AS \"occurredAt\" FROM lead_notes WHERE lead_id = $1 ORDER BY occurred_at, id", [leadId]),
    ]);
    const activity = [];
    let sequence = 0;
    const addActivity = (item) => {
      const event = { ...item, _sequence: sequence++, _indegree: 0, _after: [] };
      activity.push(event);
      return event;
    };
    const requireBefore = (before, after) => {
      before._after.push(after);
      after._indegree += 1;
    };
    const validTime = (value) => {
      if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
      return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
    };
    for (const conversation of conversations) {
      const messages = conversation.messages.map((message, index) => ({ ...message, timestamp: validTime(message.timestamp), index }));
      const hasUnknownMessageTime = messages.some((message) => !message.timestamp);
      const messageTimes = messages.map((message) => message.timestamp).filter(Boolean);
      const latestMessageTime = messageTimes.reduce((latest, value) => !latest || Date.parse(value) > Date.parse(latest) ? value : latest, null);
      const exchangeTime = validTime(conversation.occurredAt);
      const summaryTime = hasUnknownMessageTime ? null
        : [latestMessageTime, exchangeTime].filter(Boolean).reduce((latest, value) => !latest || Date.parse(value) > Date.parse(latest) ? value : latest, null);
      const messageEvents = messages.map((message) => {
        if (message.timestamp) return addActivity({ id: `${conversation.id}:message:${message.index}`, type: "message", occurredAt: message.timestamp, direction: message.direction, speaker: message.speaker, body: message.body, _sortAt: Date.parse(message.timestamp) });
        const next = messages.slice(message.index + 1).find((candidate) => candidate.timestamp);
        const previous = messages.slice(0, message.index).reverse().find((candidate) => candidate.timestamp);
        const anchorTime = (next || previous)?.timestamp;
        return addActivity({ id: `${conversation.id}:message:${message.index}`, type: "message", occurredAt: null, direction: message.direction, speaker: message.speaker, body: message.body, _sortAt: anchorTime ? Date.parse(anchorTime) : Infinity });
      });
      const summarySortAt = summaryTime ? Date.parse(summaryTime) : latestMessageTime ? Date.parse(latestMessageTime) : Infinity;
      const summary = addActivity({ id: `${conversation.id}:summary`, type: "summary", occurredAt: summaryTime, body: conversation.summary, _sortAt: summarySortAt });
      for (let index = 1; index < messageEvents.length; index += 1) requireBefore(messageEvents[index - 1], messageEvents[index]);
      if (messageEvents.length) requireBefore(messageEvents.at(-1), summary);
    }
    for (const note of notes) {
      const occurredAt = validTime(note.occurredAt);
      addActivity({ id: note.id, type: "note", occurredAt, body: note.body, author: note.author, _sortAt: occurredAt ? Date.parse(occurredAt) : Infinity });
    }
    const ready = activity.filter((event) => event._indegree === 0);
    const ordered = [];
    while (ready.length) {
      ready.sort((left, right) => left._sortAt - right._sortAt || left._sequence - right._sequence);
      const event = ready.shift();
      ordered.push(event);
      for (const following of event._after) {
        following._indegree -= 1;
        if (following._indegree === 0) ready.push(following);
      }
    }
    return ordered.map(({ _sortAt, _sequence, _indegree, _after, ...item }) => item);
  }
}

export { PAGE_DEFAULT, PAGE_MAX };
