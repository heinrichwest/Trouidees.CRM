const UPDATE_FIELDS = ["leadType", "status", "priority", "assignedTo", "services", "feedback", "comments", "lastContactedAt", "nextFollowUpAt"];
const LONG_FIELDS = ["services", "feedback", "comments"];

export async function updateLeadWithJsonMerge(store, id, changes) {
  await store.ensureSchema();
  const patch = {};
  for (const key of UPDATE_FIELDS) {
    if (changes[key] !== undefined) patch[key] = String(changes[key]).slice(0, LONG_FIELDS.includes(key) ? 5_000 : 150);
  }
  patch.updatedAt = new Date().toISOString();
  const requestedType = Object.hasOwn(patch, "leadType") ? patch.leadType : null;
  const rows = await store.sql(`UPDATE crm_leads
    SET lead_type = COALESCE($2, lead_type), data = data || $3::jsonb, updated_at = NOW()
    WHERE id = $1 RETURNING data`, [id, requestedType, JSON.stringify(patch)]);
  if (!rows.length) return null;
  if (requestedType) await store.addType(requestedType);
  return rows[0].data;
}
