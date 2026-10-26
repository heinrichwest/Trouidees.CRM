import { AGENT_SCOPES, authenticateAgent, createAgentKey, updateAgentKey, revokeAgentKey } from "./agent-auth.mjs";
import { AgentOutreachStore } from "./agent-outreach-store.mjs";

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
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
    const outreachPath = url.pathname.startsWith("/api/agent/outreach/");
    const nativeNoReplyPath = /^\/api\/agent\/leads\/[^/]+\/no-reply$/.test(url.pathname);
    if ((outreachPath || nativeNoReplyPath) && process.env.AGENT_NATIVE_OUTREACH_ENABLED !== "1") throw error(503, "Native outreach is disabled.");
    const leadPath = /^\/api\/agent\/leads\/([^/]+)(?:\/(assign-self|conversations|notes|activity|no-reply))?$/.exec(url.pathname);
    const isMe = url.pathname === "/api/agent/me" && request.method === "GET";
    const isCreate = url.pathname === "/api/agent/leads" && request.method === "POST";
    const isStats = url.pathname === "/api/agent/stats" && request.method === "GET";
    const outreachScope = outreachPath ? (() => {
      if (url.pathname === "/api/agent/outreach/claim" && request.method === "POST") return "outreach:claim";
      if (/^\/api\/agent\/outreach\/claims\/[^/]+$/.test(url.pathname) && request.method === "PATCH") return "outreach:claim";
      if (url.pathname === "/api/agent/outreach/quota" && request.method === "GET") return "outreach:read";
      if (url.pathname === "/api/agent/outreach/no-reply-due" && request.method === "GET") return "outreach:read";
      if (url.pathname === "/api/agent/outreach/resolve-contact" && request.method === "GET") return "leads:search";
      return null;
    })() : undefined;
    const required = isMe ? null : (outreachPath ? outreachScope : scopesByMethod[route] || (() => {
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
      if (suffix === "no-reply" && request.method === "POST") return "outreach:write";
      if (!suffix && request.method === "PATCH") return "leads:update:limited";
      return null;
    })());
    if (!isMe && required === null) throw error(404, "Agent route not found.");
    if (required && !auth.scopes.includes(required)) throw error(403, `Missing scope: ${required}.`);

    if (isMe) {
      return json(response, 200, { id: auth.id, label: agent, scopes: auth.scopes });
    }

    if (outreachPath) {
      if (!required) throw error(404, "Agent route not found.");
      const outreach = new AgentOutreachStore(store.db);
      if (url.pathname === "/api/agent/outreach/claim" && request.method === "POST") {
        const body = await bodyOf(request);
        if (Object.keys(body).some((key) => key !== "requestKey") || typeof body.requestKey !== "string"
          || !body.requestKey.trim() || body.requestKey.length > 200) throw error(400, "requestKey must contain 1 to 200 nonblank characters.");
        return json(response, 200, await outreach.claimNext(agent, body.requestKey));
      }
      const claimMatch = /^\/api\/agent\/outreach\/claims\/([^/]+)$/.exec(url.pathname);
      if (claimMatch && request.method === "PATCH") {
        const claimId = decodeURIComponent(claimMatch[1]);
        if (!uuidPattern.test(claimId)) throw error(400, "Invalid claim ID.");
        const body = await bodyOf(request);
        const expected = body.state === "submitted" ? ["state", "jobKey"] : body.state === "released" ? ["state", "reason"] : [];
        if (!expected.length || Object.keys(body).some((key) => !expected.includes(key))
          || expected.some((key) => body[key] === undefined)
          || (body.state === "submitted" && (typeof body.jobKey !== "string" || !body.jobKey.trim() || body.jobKey.length > 500))
          || (body.state === "released" && !["not_submitted", "terminal_no_delivery"].includes(body.reason))) {
          throw error(400, "Unsupported claim transition.");
        }
        return json(response, 200, { claim:await outreach.updateClaim(claimId, body, agent) });
      }
      if (url.pathname === "/api/agent/outreach/quota" && request.method === "GET") {
        return json(response, 200, { quota:await outreach.getQuota(agent) });
      }
      if (url.pathname === "/api/agent/outreach/no-reply-due" && request.method === "GET") {
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit == null ? 100 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw error(400, "limit must be between 1 and 100.");
        return json(response, 200, await outreach.listNoReplyDue(agent, url.searchParams.get("cursor"), limit));
      }
      if (url.pathname === "/api/agent/outreach/resolve-contact" && request.method === "GET") {
        const contact = url.searchParams.get("contact") || "";
        if (contact.length > 100 || !/^[+()\d\s.-]+$/.test(contact) || contact.replace(/\D/g, "").length < 10) throw error(400, "Enter a valid South African phone number.");
        return json(response, 200, await store.resolveContact(contact, agent));
      }
      throw error(404, "Agent route not found.");
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

    if (url.pathname === `/api/agent/leads/${leadId}/no-reply` && request.method === "POST") {
      if (process.env.AGENT_NATIVE_OUTREACH_ENABLED !== "1") throw error(503, "Native outreach is disabled.");
      if (!auth.scopes.includes("outreach:write")) throw error(403, "Missing scope: outreach:write.");
      const body = await bodyOf(request);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1
        || !uuidPattern.test(String(body.firstConversationId || ""))) throw error(400, "firstConversationId must be a valid UUID.");
      return json(response, 200, await new AgentOutreachStore(store.db).recordNoReply(leadId, body.firstConversationId, agent));
    }

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
      const native = Object.hasOwn(body, "nativeDelivery");
      if (native && process.env.AGENT_NATIVE_OUTREACH_ENABLED !== "1") throw error(503, "Native outreach is disabled.");
      if (native && !auth.scopes.includes("outreach:write")) throw error(403, "Missing scope: outreach:write.");
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
      if (native) {
        const nativeKeys = ["segmentId", "idempotencyKey", "channel", "messages", "summary", "occurredAt", "nativeDelivery"];
        const sourceTime = body.occurredAt == null ? null : Date.parse(body.occurredAt);
        const messageTime = messages[0]?.timestamp == null ? null : Date.parse(messages[0].timestamp);
        const metadata = body.nativeDelivery;
        if (Object.keys(body).some((key) => !nativeKeys.includes(key))
          || !metadata || typeof metadata !== "object" || Array.isArray(metadata)
          || Object.keys(metadata).some((key) => !["state", "claimId"].includes(key))
          || metadata.state !== "delivered" || !(metadata.claimId === null || uuidPattern.test(String(metadata.claimId)))
          || body.channel !== "whatsapp" || summary !== "WhatsApp message delivered"
          || messages.length !== 1 || messages[0].direction !== "outgoing" || messages[0].speaker !== agent
          || sourceTime !== messageTime || (sourceTime != null && sourceTime > Date.now())) {
          throw error(400, "Native delivery must be one exact, timestamp-consistent delivered outgoing message.");
        }
      }
      const conversation = await store.appendConversation({ leadId, segmentId: body.segmentId, channel: String(body.channel || "WhatsApp").slice(0, 50), messages, summary, idempotencyKey: body.idempotencyKey, occurredAt: body.occurredAt || null, agent, ...(native ? { nativeDelivery:body.nativeDelivery } : {}) });
      if (!conversation) throw error(404, "Lead not found.");
      if (native) return json(response, 200, { conversation:conversation.conversation, contactedAt:conversation.contactedAt, firstContact:conversation.firstContact, allocationViolation:conversation.allocationViolation });
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
      if (Object.hasOwn(body, "nativeConversationId")) {
        if (process.env.AGENT_NATIVE_OUTREACH_ENABLED !== "1") throw error(503, "Native outreach is disabled.");
        if (!auth.scopes.includes("outreach:write")) throw error(403, "Missing scope: outreach:write.");
        if (Object.keys(body).length !== 1 || !uuidPattern.test(String(body.nativeConversationId || ""))) throw error(400, "Native conversation repair requires only a valid nativeConversationId.");
        const outreach = new AgentOutreachStore(store.db);
        const lead = await outreach.finalizeDelivery(leadId, body.nativeConversationId, agent);
        if (!lead) throw error(404, "Lead not found.");
        return json(response, 200, { lead });
      }
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
    const keyPatchMatch = /^\/api\/admin\/agent-keys\/([^/]+)$/.exec(url.pathname);
    if (keyPatchMatch && request.method === "PATCH") {
      const keyId = decodeURIComponent(keyPatchMatch[1]);
      if (!/^[a-f0-9-]{36}$/i.test(keyId)) throw error(400, "Invalid agent key ID.");
      const body = await bodyOf(request);
      const updated = await updateAgentKey(store, keyId, { label: body.label, scopes: body.scopes });
      if (!updated) throw error(404, "Agent key not found or already revoked.");
      return json(response, 200, { key: updated });
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
