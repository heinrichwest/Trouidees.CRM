import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "@neondatabase/serverless";

const connectionString = process.env.AGENT_TEST_DATABASE_URL;
test("migration is repeatable and never reopens contacted leads", {
  skip: !connectionString ? "Set AGENT_TEST_DATABASE_URL to a disposable, migrated Neon database." : false,
}, async () => {
  const migration = await readFile(new URL("../scripts/migrations/2026-10-25-native-whatsapp-crm.sql", import.meta.url), "utf8");
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  const leadIds = [randomUUID(), randomUUID(), randomUUID()];
  try {
    for (let i = 0; i < leadIds.length; i += 1) {
      const data = { id: leadIds[i], leadType: "Native migration integration", name: `Test ${i}`, assignedTo: "", status: i === 1 ? "Contacted" : "New", lastContactedAt: i === 0 ? "2026-10-20" : "" };
      await client.query("INSERT INTO crm_leads (id, lead_type, data) VALUES ($1, $2, $3::jsonb)", [leadIds[i], data.leadType, JSON.stringify(data)]);
    }
    await client.query("BEGIN"); await client.query(migration); await client.query("COMMIT");
    await client.query("BEGIN"); await client.query(migration); await client.query("COMMIT");
    const result = await client.query("SELECT lead_id, kind FROM lead_first_contacts WHERE lead_id = ANY($1::uuid[]) ORDER BY lead_id", [leadIds]);
    assert.equal(result.rows.length, 2);
    assert.ok(result.rows.every((row) => row.kind === "legacy"));
    await client.query("UPDATE crm_leads SET data = jsonb_set(jsonb_set(data, '{status}', '\"New\"'::jsonb), '{lastContactedAt}', '\"\"'::jsonb) WHERE id = ANY($1::uuid[])", [leadIds]);
    const retained = await client.query("SELECT COUNT(*)::int AS n FROM lead_first_contacts WHERE lead_id = ANY($1::uuid[])", [leadIds]);
    assert.equal(retained.rows[0].n, 2);
  } finally {
    await client.query("DELETE FROM crm_leads WHERE id = ANY($1::uuid[])", [leadIds]).catch(() => {});
    client.release(); await pool.end();
  }
});
