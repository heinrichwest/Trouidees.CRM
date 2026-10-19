import { AGENT_SCOPES, authenticateAgent, createAgentKey, revokeAgentKey } from "./agent-auth.mjs";

const json = (response, status, body) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
};
const error = (status, message, code) => Object.assign(new Error(message), { status, code });
const bodyOf = async (request) => {
  if (request.body && typeof request.body === "object") return request.body;
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1_000_000) throw error(413, "Request body too large.");
    chunks.push(bytes);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw || "{}"); } catch { throw error(400, "Request body must be valid JSON."); }
};
const idPattern = /^[a-f0-9-]{36}$/i;
const scopesByMethod = {
  "GET /api/agent/leads": "leads:search",
};

export async function handleAgentRequest({ request, response, store }) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (!url.pathname.startsWith("/api/agent/")) return false;
  try {
    const auth = await authenticateAgent(request, store);
    if (!auth) throw error(401, "Valid agent bearer key required.");
    const agent = String(auth.label || "Andrew").trim() || "Andrew";
    const route = `${request.method} ${url.pathname}`;
    const leadPath = /^\/api\/agent\/leads\/([^/]+)(?:\/(assign-self|conversations|notes|activity))?$/.exec(url.pathname);
    const isMe = url.pathname === "/api/agent/me" && request.method === "GET";
    const isCreate = url.pathname === "/api/agent/leads" && request.method === "POST";
    const isStats = url.pathname === "/api/agent/stats" && request.method === "GET";
    const required = isMe ? null : (scopesByMethod[route] || (() => {
      if (url.pathname === "/api/agent/leads" && request.method === "GET") return "leads:search";
      if (isCreate) return "leads:create";
      if (isStats) return "leads:search";
      if (!leadPath) return null;
      const suffix = leadPath[2];
      if (!suffix && request.method === "GET") return "leads:read";
      if (suffix === "assign-self" && request.method === "POST") return "leads:assign:self";
      if (suffix === "conversations" && request.method === "GET") return "conversations:read";
      if (suffix === "conversations" && request.method === "POST") return "conversations:write";
      if (suffix === "notes" && request.method === "POST") return "notes:write";
      if (suffix === "activity" && request.method === "GET") return "leads:read";
      if (!suffix && request.method === "PATCH") return "leads:update:limited";
      return null;
    })());
    if (!isMe && required === null) throw error(404, "Agent route not found.");
    if (required && !auth.scopes.includes(required)) throw error(403, `Missing scope: ${required}.`);

    if (isMe) {
      return json(response, 200, { id: auth.id, label: agent, scopes: auth.scopes });
    }

    if (url.pathname === "/api/agent/leads" && request.method === "GET") {
      const rawLimit = url.searchParams.get("limit") || "25";
      const rawCursor = url.searchParams.get("cursor") || "0";
      if (!/^\d{1,4}$/.test(rawLimit) || !/^\d{1,7}$/.test(rawCursor)) throw error(400, "Invalid pagination parameters.");
      const query = url.searchParams.get("q") || "";
      if (query.length > 200) throw error(400, "Search query must be at most 200 characters.");
      const limit = Number(rawLimit);
      const result = await store.listVisibleLeads({ query, filters: { leadType: url.searchParams.get("leadType"), status: url.searchParams.get("status") }, limit, cursor: rawCursor, agent });
      return json(response, 200, result);
    }

    if (isCreate) {
      const body = await bodyOf(request);
      const name = String(body.name || "").trim();
      if (!name) throw error(400, "Lead name is required.");
      const leadType = String(body.leadType || "").trim();
      if (!leadType) throw error(400, "Lead type is required.");
      const created = await store.createLead(agent, { ...body, name, leadType });
      return json(response, created.created ? 201 : 200, created);
    }

    if (isStats) {
      const stats = await store.getAgentStats(agent);
      return json(response, 200, { stats });
    }

    if (!leadPath || !idPattern.test(decodeURIComponent(leadPath[1]))) throw error(400, "Invalid lead ID.");
    const leadId = decodeURIComponent(leadPath[1]);
    const suffix = leadPath[2];

    if (!suffix && request.method === "GET") {
      const lead = await store.getVisibleLead(leadId, agent);
      if (!lead) throw error(404, "Lead not found.");
      return json(response, 200, { lead });
    }
    if (suffix === "assign-self" && request.method === "POST") {
      const lead = await store.assignSelf(leadId, agent);
      if (!lead) throw error(404, "Lead not found.");
      return json(response, 200, { lead });
    }
    if (suffix === "conversations" && request.method === "GET") {
      const conversations = await store.listConversations(leadId, agent);
      if (conversations === null) throw error(404, "Lead not found.");
      return json(response, 200, { conversations });
    }
    if (suffix === "conversations" && request.method === "POST") {
      const body = await bodyOf(request);
      if (typeof body.segmentId !== "string" || !body.segmentId.trim() || body.segmentId.length > 200) throw error(400, "A stable segmentId is required.");
      if (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim() || body.idempotencyKey.length > 200) throw error(400, "A stable idempotencyKey is required.");
      if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 500) throw error(400, "messages must contain between 1 and 500 ordered records.");
      const messages = body.messages.map((message) => {
        if (!message || !["incoming", "outgoing"].includes(message.direction) || typeof message.body !== "string" || message.body.length > 50_000) throw error(400, "Each message needs direction, speaker, and verbatim body.");
        if (message.direction === "incoming" && message.speaker !== "contact") throw error(400, "Incoming messages must have speaker 'contact'.");
        if (message.direction === "outgoing" && (message.speaker === "contact" || typeof message.speaker !== "string" || !message.speaker.trim() || message.speaker.length > 50)) throw error(400, "Outgoing messages need a non-contact speaker name.");
        if ((message.direction === "incoming") !== (message.speaker === "contact")) throw error(400, "Message direction and speaker do not match.");
        if (message.timestamp != null && (!Number.isFinite(Date.parse(message.timestamp)) || typeof message.timestamp !== "string")) throw error(400, "Message timestamps must be valid source timestamps or null.");
        return { direction: message.direction, speaker: message.speaker, body: message.body, timestamp: message.timestamp || null };
      });
      const summary = String(body.summary || "");
      if (!summary.trim() || summary.length > 10_000) throw error(400, "A separate conversation summary is required.");
      if (body.occurredAt != null && (typeof body.occurredAt !== "string" || !Number.isFinite(Date.parse(body.occurredAt)))) throw error(400, "Conversation time must be a valid source timestamp or null.");
      const conversation = await store.appendConversation({ leadId, segmentId: body.segmentId, channel: String(body.channel || "WhatsApp").slice(0, 50), messages, summary, idempotencyKey: body.idempotencyKey, occurredAt: body.occurredAt || null, agent });
      if (!conversation) throw error(404, "Lead not found.");
      return json(response, 200, { conversation });
    }
    if (suffix === "notes" && request.method === "POST") {
      const body = await bodyOf(request); const note = String(body.body || "");
      if (!note.trim() || note.length > 10_000) throw error(400, "Note body is required and must be at most 10000 characters.");
      const created = await store.appendNote(leadId, note, agent);
      if (!created) throw error(404, "Lead not found.");
      return json(response, 201, { note: created });
    }
    if (suffix === "activity" && request.method === "GET") {
      const lead = await store.visibleRow(leadId, agent);
      if (!lead) throw error(404, "Lead not found.");
      const activity = await store.listActivity(leadId);
      if (activity === null) throw error(404, "Lead not found.");
      return json(response, 200, { activity });
    }
    if (!suffix && request.method === "PATCH") {
      const body = await bodyOf(request);
      const allowed = ["status", "feedback", "comments", "nextFollowUpAt", "lastContactedAt", "doNotContact", "dncReason", "dncWording"];
      if (Object.keys(body).some((key) => !allowed.includes(key))) throw error(400, "Unsupported lead update field.");
      if (body.doNotContact === true && !auth.scopes.includes("dnc:set")) throw error(403, "Missing scope: dnc:set.");
      if (body.doNotContact === false) throw error(403, "Agents cannot clear DNC; only an administrator may.");
      const limits = { status: 150, feedback: 5000, comments: 5000, nextFollowUpAt: 150, lastContactedAt: 150, dncReason: 2000, dncWording: 5000 };
      for (const [key, max] of Object.entries(limits)) if (body[key] !== undefined && (typeof body[key] !== "string" || body[key].length > max)) throw error(400, `${key} must be a string of at most ${max} characters.`);
      const lead = await store.updateLeadLimited(leadId, body, agent);
      if (!lead) throw error(404, "Lead not found.");
      return json(response, 200, { lead });
    }
    throw error(404, "Agent route not found.");
  } catch (cause) {
    const status = cause.status || 500;
    return json(response, status, { error: cause.message || "Agent API error.", ...(cause.code ? { code: cause.code } : {}) });
  }
}

export async function handleAgentAdminRequest({ request, response, store, user }) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const adminPath = url.pathname === "/api/admin/agent-keys" || /^\/api\/admin\/agent-keys\/[^/]+$/.test(url.pathname) || /^\/api\/admin\/leads\/[^/]+\/dnc\/clear$/.test(url.pathname);
  if (!adminPath) return false;
  try {
    if (!user?.active) throw error(401, "Sign in required.");
    if (user.role !== "admin" || !store?.db) throw error(403, "Administrator access required.");
    await store.ready();
    if (url.pathname === "/api/admin/agent-keys" && request.method === "POST") {
      const body = await bodyOf(request);
      const label = String(body.label || "").trim().slice(0, 100);
      if (!label) throw error(400, "Agent label is required.");
      const created = await createAgentKey(store, { label, scopes: body.scopes || AGENT_SCOPES, createdBy: user.id });
      return json(response, 201, created);
    }
    const keyMatch = /^\/api\/admin\/agent-keys\/([^/]+)$/.exec(url.pathname);
    if (keyMatch && request.method === "DELETE") {
      const keyId = decodeURIComponent(keyMatch[1]);
      if (!/^[a-f0-9-]{36}$/i.test(keyId)) throw error(400, "Invalid agent key ID.");
      const revoked = await revokeAgentKey(store, keyId);
      return revoked ? json(response, 200, { revoked: true }) : json(response, 404, { error: "Agent key not found or already revoked." });
    }
    const dncMatch = /^\/api\/admin\/leads\/([^/]+)\/dnc\/clear$/.exec(url.pathname);
    if (dncMatch && request.method === "POST") {
      const leadId = decodeURIComponent(dncMatch[1]);
      if (!idPattern.test(leadId)) throw error(400, "Invalid lead ID.");
      const reason = String((await bodyOf(request)).reason || "").trim();
      if (!reason || reason.length > 2000) throw error(400, "A reason of at most 2000 characters is required.");
      const cleared = await store.clearDnc(leadId, user.id, reason);
      if (!cleared) throw error(404, "Lead not found.");
      return json(response, 200, { cleared: true });
    }
    return json(response, 404, { error: "Admin route not found." });
  } catch (cause) { return json(response, cause.status || 500, { error: cause.message || "Admin API error." }); }
}
