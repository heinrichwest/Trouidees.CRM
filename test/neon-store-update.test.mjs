import test from "node:test";
import assert from "node:assert/strict";
import { updateLeadWithJsonMerge } from "../lib/neon-lead-update.mjs";

test("sales-field update atomically merges against current JSONB and preserves a concurrent Andrew assignment", async () => {
  let data = { id: "lead-1", status: "New", assignedTo: "" };
  const calls = [];
  const sql = async (query, parameters) => {
    calls.push({ query, parameters });
    assert.match(query, /data = data \|\| \$3::jsonb/);
    assert.doesNotMatch(query, /SELECT data FROM crm_leads/);
    // Simulate Andrew claiming after the caller begins its update but before the SQL update executes.
    data = { ...data, assignedTo: "Andrew" };
    data = { ...data, ...JSON.parse(parameters[2]) };
    return [{ data }];
  };
  const result = await updateLeadWithJsonMerge({
    sql, ensureSchema: async () => {}, addType: async () => {},
  }, "lead-1", { status: "Contacted" });
  assert.equal(calls.length, 1);
  assert.equal(result.status, "Contacted");
  assert.equal(result.assignedTo, "Andrew");
});
