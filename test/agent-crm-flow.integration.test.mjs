import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AgentStore } from "../lib/agent-store.mjs";
import { AGENT_SCOPES, createAgentKey } from "../lib/agent-auth.mjs";
import { handleAgentRequest } from "../lib/agent-api.mjs";
import { NeonStore } from "../lib/neon-store.mjs";

const databaseUrl = process.env.AGENT_TEST_DATABASE_URL;

test("Andrew API searches contact details, claims a lead, and writes CRM follow-up activity", {
  skip: !databaseUrl ? "Set AGENT_TEST_DATABASE_URL to a disposable, migrated Neon database." : false,
}, async () => {
  const neon = new NeonStore(databaseUrl);
  const store = new AgentStore(neon);
  const leadId = randomUUID();
  let keyId;
  const data = {
    id: leadId,
    leadType: "Agent integration",
    name: "Integration Contact",
    role: "Owner",
    organization: "Test Studio",
    email: "integration@example.test",
    phone: "0827654321",
    assignedTo: "",
    status: "New",
    feedback: "",
    comments: "",
    nextFollowUpAt: "",
    lastContactedAt: "",
  };

  try {
    await store.ready();
    await neon.sql("INSERT INTO crm_leads (id, lead_type, phone, data) VALUES ($1, $2, $3, $4::jsonb)", [
      leadId, "Agent integration", data.phone, JSON.stringify(data),
    ]);
    const created = await createAgentKey(store, { label: "Andrew integration test", scopes: AGENT_SCOPES, createdBy: null });
    keyId = created.key.id;

    const request = (method, path, body) => ({
      method,
      url: path,
      headers: { host: "localhost", authorization: `Bearer ${created.secret}` },
      body,
    });
    const call = async (method, path, body) => {
      const response = {
        writeHead(status) { this.status = status; },
        end(serialized) { this.body = JSON.parse(serialized); },
      };
      await handleAgentRequest({ request: request(method, path, body), response, store });
      return response;
    };

    const search = await call("GET", `/api/agent/leads?q=${encodeURIComponent(data.phone)}&limit=10&cursor=0`);
    assert.equal(search.status, 200);
    assert.equal(search.body.leads[0].phone, data.phone);
    assert.equal(search.body.leads[0].name, data.name);

    const detail = await call("GET", `/api/agent/leads/${leadId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.lead.email, data.email);
    assert.equal(detail.body.lead.organization, data.organization);

    const assigned = await call("POST", `/api/agent/leads/${leadId}/assign-self`, {});
    assert.equal(assigned.status, 200);
    assert.equal(assigned.body.lead.assignedTo, "Andrew");

    const update = await call("PATCH", `/api/agent/leads/${leadId}`, {
      status: "Contacted",
      feedback: "Asked for the service list by email.",
      nextFollowUpAt: "2026-10-07",
      lastContactedAt: "2026-09-30",
    });
    assert.equal(update.status, 200);
    assert.equal(update.body.lead.feedback, "Asked for the service list by email.");
    assert.equal(update.body.lead.status, "Contacted");

    const note = await call("POST", `/api/agent/leads/${leadId}/notes`, { body: "Follow up next week." });
    assert.equal(note.status, 201);
    assert.equal(note.body.note.body, "Follow up next week.");

    const conversationPayload = {
      segmentId: `integration-${leadId}`,
      idempotencyKey: `integration-${leadId}`,
      channel: "WhatsApp",
      summary: "The contact requested the service list and agreed to a follow-up.",
      messages: [
        { direction: "incoming", speaker: "contact", body: "Please email me the service list.", timestamp: "2026-09-30T08:00:00Z" },
        { direction: "outgoing", speaker: "andrew", body: "I will send it shortly.", timestamp: "2026-09-30T08:01:00Z" },
      ],
    };
    const conversation = await call("POST", `/api/agent/leads/${leadId}/conversations`, conversationPayload);
    assert.equal(conversation.status, 200);
    assert.equal(conversation.body.conversation.messages[0].body, conversationPayload.messages[0].body);
    assert.equal(conversation.body.conversation.summary, conversationPayload.summary);

    const history = await call("GET", `/api/agent/leads/${leadId}/conversations`);
    assert.equal(history.status, 200);
    assert.equal(history.body.conversations.length, 1);
    assert.equal(history.body.conversations[0].messages.length, 2);
  } finally {
    if (keyId) await neon.sql("DELETE FROM agent_keys WHERE id = $1", [keyId]);
    await neon.sql("DELETE FROM crm_leads WHERE id = $1", [leadId]);
    await neon.pool?.end?.();
  }
});

