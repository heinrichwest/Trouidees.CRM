import { randomUUID } from "node:crypto";

const PAGE_DEFAULT = 25;
const PAGE_MAX = 100;
const leadDto = (row) => row ? { ...row.data, doNotContact: Boolean(row.do_not_contact) } : null;
const failure = (code, message, status) => Object.assign(new Error(message), { code, status });
const ownership = (leadId) => failure("NOT_OWNED", `Lead ${leadId} is not assigned to Andrew.`, 403);
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
  async visibleRow(id) {
    const row = await this.lead(id);
    if (row && !["", "Andrew"].includes(String(row.data.assignedTo || "").trim())) return null;
    return row;
  }
  async ownedRow(id) {
    const row = await this.lead(id);
    if (row && String(row.data.assignedTo || "").trim() !== "Andrew") throw ownership(id);
    return row;
  }

  async listVisibleLeads({ query = "", filters = {}, limit = PAGE_DEFAULT, cursor = "" } = {}) {
    await this.ready();
    const size = Math.max(1, Math.min(PAGE_MAX, Number(limit) || PAGE_DEFAULT));
    const offset = Math.max(0, Number(cursor) || 0);
    const q = String(query).trim();
    const params = [size + 1, offset];
    const clauses = ["COALESCE(BTRIM(data->>'assignedTo'), '') IN ('', 'Andrew')"];
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
    const rows = await this.db.sql(`SELECT id, data, do_not_contact FROM crm_leads WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id LIMIT $1 OFFSET $2`, params);
    if (q.replace(/\D/g, "").length >= 7) {
      const normalized = q.replace(/\D/g, "");
      const candidateFilters = ["COALESCE(BTRIM(data->>'assignedTo'), '') IN ('', 'Andrew')"];
      const candidateParams = [normalized];
      for (const field of ["leadType", "status"]) {
        if (filters[field]) { candidateParams.push(String(filters[field]).slice(0, 100)); candidateFilters.push(`data->>'${field}' = $${candidateParams.length}`); }
      }
      const phoneMatch = `crm_normalize_za_phone(phone) = crm_normalize_za_phone($1)`;
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
    return { leads: rows.slice(0, size).map(leadDto), nextCursor: more ? String(offset + size) : null };
  }

  async getVisibleLead(id) { await this.ready(); return leadDto(await this.visibleRow(id)); }

  async assignSelf(id) {
    await this.ready();
    const rows = await this.db.sql(`UPDATE crm_leads SET data = jsonb_set(data, '{assignedTo}', '"Andrew"'::jsonb), updated_at = NOW()
      WHERE id = $1 AND COALESCE(BTRIM(data->>'assignedTo'), '') = '' RETURNING data, do_not_contact`, [id]);
    if (rows[0]) return leadDto(rows[0]);
    const current = await this.lead(id);
    if (!current) return null;
    if (String(current.data.assignedTo || "").trim() === "Andrew") return leadDto(current);
    throw failure("ASSIGNMENT_CONFLICT", "Lead is assigned to another owner.", 409);
  }

  async appendConversation({ leadId, segmentId, channel = "WhatsApp", messages, summary, idempotencyKey, occurredAt = null }) {
    await this.ready();
    const exists = await this.db.sql("SELECT data->>'assignedTo' AS owner FROM crm_leads WHERE id = $1", [leadId]);
    if (!exists.length) return null;
    if (String(exists[0].owner || "").trim() !== "Andrew") throw ownership(leadId);
    const rows = await this.db.sql(`INSERT INTO lead_conversations (id, lead_id, segment_id, channel, messages, summary, idempotency_key, occurred_at)
      SELECT $1, leads.id, $2, $3, $4::jsonb, $5, $6, $7 FROM crm_leads leads
      WHERE leads.id = $8 AND BTRIM(COALESCE(leads.data->>'assignedTo', '')) = 'Andrew'
      ON CONFLICT DO NOTHING
      RETURNING id, lead_id AS "leadId", segment_id AS "segmentId", channel, messages, summary, occurred_at AS "occurredAt", created_at AS "createdAt"`,
    [randomUUID(), segmentId, channel, JSON.stringify(messages), summary, idempotencyKey, occurredAt, leadId]);
    if (rows[0]) return rows[0];
    const existing = await this.db.sql(`SELECT leads.id AS "leadId", BTRIM(COALESCE(leads.data->>'assignedTo', '')) AS owner,
        conversation.id, conversation.segment_id AS "segmentId", conversation.channel, conversation.messages, conversation.summary,
        conversation.idempotency_key AS "idempotencyKey", conversation.occurred_at AS "occurredAt", conversation.created_at AS "createdAt"
      FROM lead_conversations conversation
      JOIN crm_leads leads ON leads.id = conversation.lead_id
      WHERE conversation.lead_id = $1
        AND BTRIM(COALESCE(leads.data->>'assignedTo', '')) = 'Andrew'
        AND (conversation.idempotency_key = $2 OR conversation.segment_id = $3)
      ORDER BY conversation.created_at, conversation.id`, [leadId, idempotencyKey, segmentId]);
    if (existing.length) {
      if (existing.length === 1 && sameConversation(existing[0], { segmentId, channel, messages, summary, idempotencyKey, occurredAt })) return existing[0];
      throw idempotencyConflict();
    }
    const current = await this.lead(leadId);
    if (!current) return null;
    if (String(current.data.assignedTo || "").trim() !== "Andrew") throw ownership(leadId);
    throw idempotencyConflict();
  }

  async listConversations(leadId) {
    await this.ready();
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
          AND BTRIM(COALESCE(leads.data->>'assignedTo', '')) = 'Andrew'
      ) history ON TRUE
      WHERE leads.id = $1`, [leadId]);
    if (!rows.length) return null;
    if (rows[0].owner !== "Andrew") throw ownership(leadId);
    return rows[0].conversations;
  }

  async appendNote(leadId, body, author = "Andrew") {
    await this.ready();
    const rows = await this.db.sql(`INSERT INTO lead_notes (id, lead_id, body, author)
      SELECT $1, id, $2, $3 FROM crm_leads WHERE id = $4 AND BTRIM(COALESCE(data->>'assignedTo', '')) = 'Andrew'
      RETURNING id, lead_id AS "leadId", body, author, occurred_at AS "occurredAt"`, [randomUUID(), body, author, leadId]);
    if (rows[0]) return rows[0];
    if (await this.lead(leadId)) throw ownership(leadId);
    return null;
  }

  async updateLeadLimited(id, patch) {
    await this.ready();
    const keys = Object.keys(patch);
    if (keys.some((key) => !["status", "feedback", "comments", "nextFollowUpAt", "lastContactedAt", "doNotContact", "dncReason", "dncWording"].includes(key))) throw failure("INVALID_FIELDS", "Unsupported lead update field.", 400);
    if (patch.doNotContact === false) throw failure("DNC_CLEAR_FORBIDDEN", "Only a human administrator can clear DNC.", 403);
    const before = await this.db.sql("SELECT data->>'assignedTo' AS owner, do_not_contact FROM crm_leads WHERE id = $1", [id]);
    if (!before.length) return null;
    if (String(before[0].owner || "").trim() !== "Andrew") throw ownership(id);
    const merged = { ...patch }; delete merged.doNotContact; delete merged.dncReason; delete merged.dncWording;
    const rows = await this.db.sql(`WITH current AS (
        SELECT id, do_not_contact FROM crm_leads WHERE id = $1 AND BTRIM(COALESCE(data->>'assignedTo', '')) = 'Andrew' FOR UPDATE
      ), updated AS (
        UPDATE crm_leads leads SET data = leads.data || $2::jsonb, do_not_contact = leads.do_not_contact OR $3, updated_at = NOW()
        FROM current WHERE leads.id = current.id
        RETURNING leads.data, leads.do_not_contact, current.do_not_contact AS prior_dnc
      ), audited AS (
        INSERT INTO lead_dnc_audit (id, lead_id, action, actor, reason, wording)
        SELECT $4, $1, 'set', 'Andrew', $5, $6 FROM updated WHERE $3 AND NOT prior_dnc RETURNING id
      ) SELECT data, do_not_contact FROM updated`, [id, JSON.stringify(merged), patch.doNotContact === true, randomUUID(), String(patch.dncReason || "Contact requested no further contact"), String(patch.dncWording || "")]);
    if (!rows[0]) throw ownership(id);
    return leadDto(rows[0]);
  }

  async setDnc(id, reason, wording = "") { return this.updateLeadLimited(id, { doNotContact: true, dncReason: reason, dncWording: wording }); }

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

