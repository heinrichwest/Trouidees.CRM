import test from "node:test";
import assert from "node:assert/strict";
import { enrichLead } from "../lib/lead-enrichment.mjs";

const lead = { id: "00000000-0000-4000-8000-000000000001", name: "Cape Studio", organization: "Cape Studio", website: "https://example.test", phone: "+27 82 123 4567", email: "", assignedTo: "", status: "New", doNotContact: false, lastContactedAt: "" };

test("ready enrichment keeps each sourced fact attached to its own page", async () => {
  let optionsSeen;
  const client = { async mapAndScrape(url, maxPages, fields, progress, options) {
    optionsSeen = { url, maxPages, options };
    return { status: "completed", data: [
      { markdown: "# Services\nCape Studio provides portrait photography and family sessions for local customers.\nThe owner says, ‘Weekend sessions welcome families from across Cape Town.’", metadata: { sourceURL: "https://example.test/services" } },
      { markdown: "# Location\nThe studio is based in Sea Point and serves clients throughout Cape Town.", metadata: { sourceURL: "https://example.test/location" } },
    ], opportunities: [{ text: "inferred expansion opportunity" }], warnings: [], creditsUsed: 2, usage: { reportedTotal: 2, reportedSubtotal: 2, complete: true } };
  } };
  const result = await enrichLead(lead, { client });
  assert.equal(result.research.ready, true);
  assert.equal(result.research.messageable, true);
  assert.deepEqual(result.research.research.facts.map((fact) => fact.sourceUrl), ["https://example.test/services", "https://example.test/services", "https://example.test/location"]);
  assert.ok(!result.research.research.facts.some((fact) => fact.text.includes("inferred expansion opportunity")));
  assert.equal(result.research.research.facts.find((fact) => fact.text.includes("Weekend sessions welcome families"))?.sourceUrl, "https://example.test/services");
  assert.equal(result.creditsUsed, 2);
  assert.equal(optionsSeen.maxPages, 3);
  assert.equal(optionsSeen.options.strictAttempt, true);
  assert.equal(optionsSeen.options.reportUsage, true);
});

test("missing phone, site evidence, or sources leave the lead in needs-review state", async () => {
  let providerCalls = 0;
  const client = { async mapAndScrape() { providerCalls += 1; return { data: [{ markdown: "Navigation Home Contact", metadata: { sourceURL: "https://example.test" } }], warnings: [], usage: { reportedTotal: null, reportedSubtotal: 0, complete: false } }; } };
  const noPhone = await enrichLead({ ...lead, phone: "" }, { client });
  assert.equal(noPhone.research.ready, false);
  assert.equal(providerCalls, 1);
  const noFacts = await enrichLead(lead, { client });
  assert.equal(noFacts.research.ready, false);
  assert.ok(noFacts.reason);
  assert.equal(noFacts.creditsUsed, null);
  assert.equal(providerCalls, 2);
});

test("DNC and already-contacted leads can retain evidence but never publish as ready", async () => {
  const client = { async mapAndScrape() { return { data: [{ markdown: "Cape Studio offers family photography sessions with weekend appointments.", metadata: { sourceURL: "https://example.test/services" } }], usage: { reportedTotal: 0, reportedSubtotal: 0, complete: true } }; } };
  const dnc = await enrichLead({ ...lead, doNotContact: true }, { client });
  const contacted = await enrichLead({ ...lead, status: "Contacted" }, { client });
  assert.equal(dnc.research.ready, false);
  assert.equal(contacted.research.ready, false);
  assert.equal(dnc.research.research.facts.length, 1);
  assert.equal(dnc.creditsUsed, 0);
});
