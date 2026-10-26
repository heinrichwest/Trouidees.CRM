import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../scripts/migrations/2026-10-25-native-whatsapp-crm.sql", import.meta.url), "utf8");

test("native outreach migration creates durable contact, claim, readiness and outcome state", () => {
  for (const table of ["lead_research_readiness", "lead_outreach_claims", "lead_first_contacts", "lead_contact_outcomes"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /ADD COLUMN IF NOT EXISTS native_delivery JSONB/);
  assert.match(migration, /UNIQUE \(agent, request_key\)/);
  assert.match(migration, /WHERE state IN \('reserved', 'submitted'\)/);
  assert.match(migration, /native_delivery[^;]*state[^;]*delivered/is);
  assert.match(migration, /CREATE TRIGGER/i);
  assert.match(migration, /crm_claim_ready_lead\(p_agent TEXT, p_request_key TEXT, p_now TIMESTAMPTZ\)/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /FOR UPDATE OF leads SKIP LOCKED/);
  assert.match(migration, /crm_update_outreach_claim/);
  assert.match(migration, /crm_put_lead_research/);
});

test("migration preserves historical contact evidence without treating it as native delivery", () => {
  assert.match(migration, /lastContactedAt/);
  assert.match(migration, /data->>'status'/);
  assert.match(migration, /direction[^;]*outgoing/is);
  assert.match(migration, /kind[^;]*legacy/is);
  const legacyBackfill = migration.match(/SELECT leads\.id, 'legacy',[\s\S]*?ON CONFLICT \(lead_id\) DO NOTHING/)?.[0];
  assert.ok(legacyBackfill, "legacy historical evidence is backfilled");
  assert.match(legacyBackfill, /NULL,\s*COALESCE/);
  assert.match(legacyBackfill, /,\s*FALSE,\s*outgoing\.id/);
  assert.match(migration, /VALUES \(NEW\.id, 'legacy',[^\n]*NULL,/);
  assert.match(migration, /VALUES \(NEW\.lead_id, 'legacy', speaker_name, NULL,/);
  assert.doesNotMatch(migration, /NeonStore|ensureSchema|createSchema/);
});
