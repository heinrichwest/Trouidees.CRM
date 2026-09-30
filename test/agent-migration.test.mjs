import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../scripts/migrations/2026-09-29-andrew-crm.sql", import.meta.url), "utf8");
const runner = await readFile(new URL("../scripts/migrate-neon.mjs", import.meta.url), "utf8");

test("Andrew migration adds the writeback and consent objects", () => {
  for (const object of ["agent_keys", "lead_conversations", "lead_notes", "lead_dnc_audit", "lead_consent_attestations"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${object}`));
  }
  assert.match(migration, /ADD COLUMN IF NOT EXISTS do_not_contact BOOLEAN/);
  assert.match(migration, /crm_normalize_za_phone/);
  assert.match(migration, /UNIQUE \(lead_id, segment_id\)/);
  assert.match(migration, /UNIQUE \(lead_id, idempotency_key\)/);
});

test("phone index remains non-unique and writeback tables reference leads", () => {
  assert.match(migration, /CREATE INDEX IF NOT EXISTS crm_leads_phone_normalized_idx/);
  assert.doesNotMatch(migration, /CREATE UNIQUE INDEX[^;]*phone/i);
  assert.equal((migration.match(/lead_id UUID NOT NULL REFERENCES crm_leads\(id\)/g) || []).length, 3);
});

test("migration runner is constrained to explicit migration files and transactions", () => {
  assert.match(runner, /process\.env\.DATABASE_URL/);
  assert.match(runner, /scripts", "migrations/);
  assert.match(runner, /BEGIN/);
  assert.match(runner, /COMMIT/);
  assert.match(runner, /ROLLBACK/);
});
