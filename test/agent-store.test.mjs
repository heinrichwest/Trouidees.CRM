import test from "node:test";
import assert from "node:assert/strict";
import { AgentStore } from "../lib/agent-store.mjs";

const leadId = "123e4567-e89b-42d3-a456-426614174000";
function fakeStore(respond) {
  const calls = [];
  const store = new AgentStore({ ensureSchema: async () => {}, sql: async (query, params) => { calls.push({ query, params }); return respond(query, params); } });
  return { store, calls };
}

test("visibility paging is capped and direct foreign-owner reads are hidden", async () => {
  const { store, calls } = fakeStore((query) => query.includes("SELECT id, data, do_not_contact") ? [{ id: leadId, data: { id: leadId, assignedTo: "Andrew" }, do_not_contact: false }] : []);
  const page = await store.listVisibleLeads({ limit: 10000, cursor: "0" });
  assert.equal(calls[0].params[0], 101);
  assert.equal(page.leads[0].doNotContact, false);
  const foreign = fakeStore((query) => query.includes("SELECT data, do_not_contact") ? [{ data: { assignedTo: "Sales" }, do_not_contact: false }] : []);
  assert.equal(await foreign.store.getVisibleLead(leadId), null);
});

test("self assignment uses a conditional update and repeated Andrew assignment is idempotent", async () => {
  let updates = 0;
  const { store } = fakeStore((query) => {
    if (query.startsWith("UPDATE crm_leads")) { updates += 1; return updates === 1 ? [{ data: { id: leadId, assignedTo: "Andrew" }, do_not_contact: false }] : []; }
    return [{ data: { id: leadId, assignedTo: "Andrew" }, do_not_contact: false }];
  });
  assert.equal((await store.assignSelf(leadId)).assignedTo, "Andrew");
  assert.equal((await store.assignSelf(leadId)).assignedTo, "Andrew");
  assert.equal(updates, 2);
});

test("limited updates reject ownership changes and DNC clearing", async () => {
  const { store } = fakeStore(() => [{ owner: "Andrew", do_not_contact: true, data: { id: leadId, assignedTo: "Andrew" } }]);
  await assert.rejects(store.updateLeadLimited(leadId, { assignedTo: "Other" }), { code: "INVALID_FIELDS" });
  await assert.rejects(store.updateLeadLimited(leadId, { doNotContact: false }), { code: "DNC_CLEAR_FORBIDDEN" });
});

test("limited Andrew updates allow CRM comments while preserving the assigned lead", async () => {
  const { store, calls } = fakeStore((query) => {
    if (query.startsWith("SELECT data->>'assignedTo'")) return [{ owner: "Andrew", do_not_contact: false }];
    if (query.includes("UPDATE crm_leads")) return [{ data: { id: leadId, assignedTo: "Andrew", comments: "Call back Friday" }, do_not_contact: false }];
    return [];
  });
  const lead = await store.updateLeadLimited(leadId, { comments: "Call back Friday" });
  assert.equal(lead.comments, "Call back Friday");
  assert.equal(JSON.parse(calls[1].params[1]).comments, "Call back Friday");
});

test("activity is chronological by message timestamp, keeps ties stable, and follows transcript with summary", async () => {
  const { store } = fakeStore((query) => {
    if (query.includes("FROM crm_leads WHERE id")) return [{ data: { id: leadId }, do_not_contact: false }];
    if (query.includes("FROM lead_conversations")) return [
      { id: "conv-a", messages: [
        { direction: "incoming", speaker: "contact", body: "A1", timestamp: "2026-09-29T09:00:00Z" },
        { direction: "outgoing", speaker: "andrew", body: "A2", timestamp: "2026-09-29T10:00:00Z" },
        { direction: "incoming", speaker: "contact", body: "A3", timestamp: "2026-09-29T10:00:00Z" },
        { direction: "outgoing", speaker: "andrew", body: "A4 unknown", timestamp: null },
      ], summary: "Summary A", occurredAt: "2026-09-29T08:00:00Z", createdAt: "2026-09-29T08:00:00Z" },
      { id: "conv-b", messages: [{ direction: "incoming", speaker: "contact", body: "B1", timestamp: "2026-09-29T09:45:00Z" }], summary: "Summary B", occurredAt: "2026-09-29T08:30:00Z", createdAt: "2026-09-29T08:30:00Z" },
    ];
    if (query.includes("FROM lead_notes")) return [{ id: "note", body: "Internal", author: "Andrew", occurredAt: "2026-09-29T09:30:00Z" }];
    return [];
  });
  const activity = await store.listActivity(leadId);
  assert.deepEqual(activity.map((item) => item.body), ["A1", "Internal", "B1", "Summary B", "A2", "A3", "A4 unknown", "Summary A"]);
  assert.deepEqual(activity.filter((item) => item.body === "A2" || item.body === "A3").map((item) => item.body), ["A2", "A3"]);
  assert.equal(activity.find((item) => item.body === "A4 unknown").occurredAt, null);
  assert.equal(activity.findIndex((item) => item.body === "Summary A"), activity.findIndex((item) => item.body === "A4 unknown") + 1);
  assert.equal(activity.find((item) => item.body === "Summary A").occurredAt, null);
  assert.equal(activity.find((item) => item.body === "Internal").type, "note");
});

test("Date timestamps retain milliseconds while unknown transcript messages stay in source flow", async () => {
  const { store } = fakeStore((query) => {
    if (query.includes("FROM crm_leads WHERE id")) return [{ data: { id: leadId }, do_not_contact: false }];
    if (query.includes("FROM lead_conversations")) return [{
      id: "conv-date",
      messages: [
        { direction: "incoming", speaker: "contact", body: "Known question", timestamp: new Date("2026-09-29T09:00:00.456Z") },
        { direction: "incoming", speaker: "contact", body: "Unknown follow-up", timestamp: null },
        { direction: "outgoing", speaker: "andrew", body: "Later answer", timestamp: new Date("2026-09-29T10:00:00.123Z") },
      ],
      summary: "Date summary", occurredAt: new Date("2026-09-29T08:59:00.789Z"),
    }];
    if (query.includes("FROM lead_notes")) return [{ id: "date-note", body: "Date note", author: "Andrew", occurredAt: new Date("2026-09-29T09:30:00.321Z") }];
    return [];
  });

  const activity = await store.listActivity(leadId);
  assert.deepEqual(activity.map(({ body }) => body), ["Known question", "Date note", "Unknown follow-up", "Later answer", "Date summary"]);
  assert.equal(activity.find(({ body }) => body === "Known question").occurredAt, "2026-09-29T09:00:00.456Z");
  assert.equal(activity.find(({ body }) => body === "Date note").occurredAt, "2026-09-29T09:30:00.321Z");
  assert.equal(activity.find(({ body }) => body === "Unknown follow-up").occurredAt, null);
  assert.equal(activity.find(({ body }) => body === "Later answer").occurredAt, "2026-09-29T10:00:00.123Z");
  assert.deepEqual(activity.filter(({ type }) => type === "message").map(({ direction }) => direction), ["incoming", "incoming", "outgoing"]);
  assert.equal(activity.find(({ body }) => body === "Date summary").occurredAt, null);
});

test("regressing message timestamps preserve transcript order and timestamp compatible notes and summary", async () => {
  const { store } = fakeStore((query) => {
    if (query.includes("FROM crm_leads WHERE id")) return [{ data: { id: leadId }, do_not_contact: false }];
    if (query.includes("FROM lead_conversations")) return [{
      id: "conv-regressing",
      messages: [
        { direction: "incoming", speaker: "contact", body: "Question", timestamp: "2026-09-29T10:00:01.250Z" },
        { direction: "outgoing", speaker: "andrew", body: "Answer", timestamp: "2026-09-29T10:00:00.125Z" },
      ],
      summary: "Exchange summary", occurredAt: "2026-09-29T10:00:01.500Z",
    }];
    if (query.includes("FROM lead_notes")) return [{
      id: "intervening-note", body: "Intervening note", author: "Andrew", occurredAt: "2026-09-29T10:00:00.750Z",
    }];
    return [];
  });

  const activity = await store.listActivity(leadId);
  assert.deepEqual(activity.map(({ body }) => body), ["Intervening note", "Question", "Answer", "Exchange summary"]);
  assert.deepEqual(activity.slice(1, 3).map(({ direction }) => direction), ["incoming", "outgoing"]);
  assert.deepEqual(activity.map(({ occurredAt }) => occurredAt), [
    "2026-09-29T10:00:00.750Z",
    "2026-09-29T10:00:01.250Z",
    "2026-09-29T10:00:00.125Z",
    "2026-09-29T10:00:01.500Z",
  ]);
});

test("phone ambiguity candidates use the same bounded page and cursor", async () => {
  const queryLog = [];
  const { store } = fakeStore((query, params) => {
    queryLog.push({ query, params });
    if (query.includes("LIMIT 2")) return [{ id: "first" }, { id: "second" }];
    if (query.includes("crm_normalize_za_phone(phone) =")) return [{ id: "second" }, { id: "third" }];
    return [];
  });
  const result = await store.listVisibleLeads({ query: "0821234567", limit: 1, cursor: "1" });
  assert.equal(result.ambiguous, true);
  assert.deepEqual(result.candidates, ["second"]);
  assert.equal(result.nextCursor, "2");
  const candidatePage = queryLog.find(({ query }) => query.includes("crm_normalize_za_phone(phone) =") && query.includes("LIMIT $2"));
  assert.match(candidatePage.query, /LIMIT \$2 OFFSET \$3/);
  assert.deepEqual(candidatePage.params.slice(1), [2, 1]);
});

test("conversation history reads ownership and data in one guarded statement", async () => {
  const { store, calls } = fakeStore((query) => query.includes("lead_conversations")
    ? [{ owner: "Andrew", conversations: [{ id: "conversation" }] }]
    : []);
  assert.deepEqual(await store.listConversations(leadId), [{ id: "conversation" }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /BTRIM\(COALESCE\(leads\.data->>'assignedTo', ''\)\) = 'Andrew'/);
});

test("conversation history keeps 403 for a foreign owner and 404 semantics for a missing lead", async () => {
  const foreign = fakeStore((query) => query.includes("lead_conversations") ? [{ owner: "Other", conversations: [] }] : []);
  await assert.rejects(foreign.store.listConversations(leadId), { code: "NOT_OWNED", status: 403 });
  const missing = fakeStore(() => []);
  assert.equal(await missing.store.listConversations(leadId), null);
});

const conversationInput = (overrides = {}) => ({
  leadId, segmentId: "segment-1", channel: "WhatsApp",
  messages: [{ direction: "incoming", speaker: "contact", body: "Hello", timestamp: "2026-09-29T09:00:00Z" }],
  summary: "Discussed next steps.", idempotencyKey: "idem-1", occurredAt: "2026-09-29T09:01:00Z", ...overrides,
});
const existingConversation = (input) => ({
  id: "conversation-1", leadId: input.leadId, segmentId: input.segmentId, channel: input.channel,
  messages: input.messages, summary: input.summary, idempotencyKey: input.idempotencyKey,
  occurredAt: input.occurredAt, createdAt: "2026-09-29T09:02:00Z",
});

test("identical conversation idempotency replay returns the existing row", async () => {
  const input = conversationInput({ occurredAt: new Date("2026-09-29T09:01:00.123Z") });
  const { store, calls } = fakeStore((query) => {
    if (query.includes("SELECT data->>'assignedTo' AS owner")) return [{ owner: "Andrew" }];
    if (query.includes("INSERT INTO lead_conversations")) return [];
    if (query.includes("FROM lead_conversations conversation")) return [existingConversation({ ...input, occurredAt: new Date("2026-09-29T09:01:00.123Z") })];
    return [];
  });
  const result = await store.appendConversation(input);
  assert.equal(result.id, "conversation-1");
  assert.ok(calls.some(({ query }) => /ON CONFLICT DO NOTHING/.test(query)));
});

test("conversation replay compares Date occurredAt values at millisecond precision", async () => {
  const input = conversationInput({ occurredAt: new Date("2026-09-29T09:01:00.123Z") });
  const { store } = fakeStore((query) => {
    if (query.includes("SELECT data->>'assignedTo' AS owner")) return [{ owner: "Andrew" }];
    if (query.includes("INSERT INTO lead_conversations")) return [];
    if (query.includes("FROM lead_conversations conversation")) return [existingConversation({
      ...input, occurredAt: new Date("2026-09-29T09:01:00.456Z"),
    })];
    return [];
  });
  await assert.rejects(store.appendConversation(input), { code: "IDEMPOTENCY_CONFLICT", status: 409 });
});

test("reusing a conversation idempotency key for different payload returns 409", async () => {
  const input = conversationInput();
  const { store } = fakeStore((query) => {
    if (query.includes("SELECT data->>'assignedTo' AS owner")) return [{ owner: "Andrew" }];
    if (query.includes("INSERT INTO lead_conversations")) return [];
    if (query.includes("FROM lead_conversations conversation")) return [existingConversation({ ...input, messages: [{ ...input.messages[0], body: "Different" }] })];
    return [];
  });
  await assert.rejects(store.appendConversation(input), { code: "IDEMPOTENCY_CONFLICT", status: 409 });
});

test("reusing a conversation segment with a different idempotency key returns 409", async () => {
  const input = conversationInput();
  const { store } = fakeStore((query) => {
    if (query.includes("SELECT data->>'assignedTo' AS owner")) return [{ owner: "Andrew" }];
    if (query.includes("INSERT INTO lead_conversations")) return [];
    if (query.includes("FROM lead_conversations conversation")) return [existingConversation({ ...input, idempotencyKey: "different-key" })];
    return [];
  });
  await assert.rejects(store.appendConversation(input), { code: "IDEMPOTENCY_CONFLICT", status: 409 });
});

