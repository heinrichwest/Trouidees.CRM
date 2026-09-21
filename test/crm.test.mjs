import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addLeadType, deleteCrmLead, deleteLeadType, importCrmLeads, listCrmLeads, listLeadTypes, renameLeadType, updateCrmLead } from "../lib/crm.mjs";

test("CRM saves only email-qualified leads and tracks sales follow-up", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lead-crm-"));
  const leadsFile = join(directory, "leads.json");
  const typesFile = join(directory, "types.json");

  try {
    await addLeadType(typesFile, "Florists");
    const imported = await importCrmLeads(leadsFile, [
      { name: "Cape Flowers", email: "hello@flowers.example", phone: "+27 21 555 0101" },
      { name: "Phone Only", phone: "+27 11 555 0102" },
    ], "Florists", typesFile);

    assert.deepEqual(imported, { imported: 1, skipped: 1, total: 1 });
    let leads = await listCrmLeads(leadsFile);
    assert.equal(leads[0].leadType, "Florists");
    assert.equal(leads[0].status, "New");

    const updated = await updateCrmLead(leadsFile, leads[0].id, {
      status: "Contacted",
      feedback: "Asked for a catalogue.",
      comments: "Follow up on Monday.",
      lastContactedAt: "2026-09-10",
    });
    assert.equal(updated.status, "Contacted");
    assert.equal(updated.feedback, "Asked for a catalogue.");

    await renameLeadType(typesFile, leadsFile, "Florists", "Event Florists");
    leads = await listCrmLeads(leadsFile);
    assert.equal(leads[0].leadType, "Event Florists");
    const types = await listLeadTypes(typesFile, leadsFile);
    assert.equal(types.find((type) => type.name === "Event Florists").count, 1);
    await assert.rejects(deleteLeadType(typesFile, leadsFile, "Event Florists"), { code: "TYPE_IN_USE" });
    assert.equal(await deleteCrmLead(leadsFile, leads[0].id), true);
    await deleteLeadType(typesFile, leadsFile, "Event Florists");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CRM can save and deduplicate phone-qualified Google Places leads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "maps-crm-"));
  const leadsFile = join(directory, "leads.json");
  const typesFile = join(directory, "types.json");
  const mapLead = { name: "Cape Coffee", phone: "+27 21 555 0199", placeId: "place-123", source: "Google Places" };

  try {
    const first = await importCrmLeads(leadsFile, [mapLead, { name: "No phone", website: "https://example.com" }], "Coffee Shops", typesFile, { requireEmail: false, requirePhone: true });
    const second = await importCrmLeads(leadsFile, [mapLead], "Coffee Shops", typesFile, { requireEmail: false, requirePhone: true });
    const leads = await listCrmLeads(leadsFile);

    assert.deepEqual(first, { imported: 1, skipped: 1, total: 1 });
    assert.deepEqual(second, { imported: 0, skipped: 1, total: 1 });
    assert.equal(leads[0].placeId, "place-123");
    assert.equal(leads[0].email, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
