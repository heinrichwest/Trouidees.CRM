import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("no-reply migration serializes inbound appends and classification on the lead row", async () => {
  const sql = await readFile(new URL("../scripts/migrations/2026-10-26-native-no-reply.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE OR REPLACE FUNCTION crm_no_reply_due_at/);
  assert.match(sql, /EXTRACT\(ISODOW FROM due_day\) IN \(6, 7\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION crm_record_no_reply/);
  assert.match(sql, /FROM crm_leads WHERE id=p_lead_id FOR UPDATE/);
  assert.match(sql, /CREATE TRIGGER crm_conversation_lead_lock BEFORE INSERT ON lead_conversations/);
  assert.match(sql, /CREATE TRIGGER crm_conversation_supersede_no_reply AFTER INSERT ON lead_conversations/);
  assert.match(sql, /unknown_delivery_time/);
  assert.match(sql, /first_contact\.source_time_known/);
});
