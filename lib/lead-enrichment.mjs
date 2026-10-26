import { buildReport } from "./analyze.mjs";

const nowIso = () => new Date().toISOString();
const normalizeUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!new Set(["http:", "https:"]).has(url.protocol)) return "";
    url.hash = "";
    return url.toString();
  } catch { return ""; }
};

function pageSource(page) {
  const value = page?.metadata?.sourceURL || page?.metadata?.url || page?.url || "";
  const normalized = normalizeUrl(value);
  return normalized.length <= 2000 ? normalized : "";
}

function sourcedFacts(pages) {
  const facts = [];
  const seen = new Set();
  let encodedBytes = 0;
  for (const page of pages || []) {
    const sourceUrl = pageSource(page);
    if (!sourceUrl) continue;
    const lines = String(page.markdown || page.html || "").split(/\r?\n/);
    for (const rawLine of lines) {
      const text = rawLine.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/\s+/g, " ").trim();
      if (text.length < 35 || text.length > 2000
        || /^(home|about|contact|services|menu|privacy policy|terms of service)$/i.test(text)
        || /cookie|javascript required|skip to content|all rights reserved/i.test(text)) continue;
      const identity = `${sourceUrl}\n${text}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const fact = { text, sourceUrl };
      encodedBytes += Buffer.byteLength(JSON.stringify(fact), "utf8");
      if (facts.length >= 100 || encodedBytes > 48_000) return facts;
      facts.push(fact);
    }
  }
  return facts;
}

function isMessageable(lead) {
  const digits = String(lead.phone || "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 && !/^0+$/.test(digits);
}

function ineligibleReason(lead, { hasFacts, messageable }) {
  const reasons = [];
  if (!messageable) reasons.push("A usable phone number is missing; WhatsApp reachability has not been verified.");
  if (!hasFacts) reasons.push("No relevant facts with page-level source links were found.");
  if (lead.doNotContact) reasons.push("This lead is marked do not contact.");
  if (String(lead.assignedTo || "").trim()) reasons.push("This lead is already assigned.");
  if (!new Set(["New", "To contact"]).has(String(lead.status || "New"))) reasons.push("This lead has already progressed beyond the new-contact statuses.");
  if (String(lead.lastContactedAt || "").trim()) reasons.push("This lead has prior contact history.");
  return reasons;
}

/** Research one administrator-selected CRM lead. Research never edits lead or sales fields. */
export async function enrichLead(lead, { client, maxPages = 3 } = {}) {
  if (!lead || typeof lead !== "object" || !lead.id) throw new TypeError("A CRM lead is required.");
  if (!client || typeof client.mapAndScrape !== "function") throw new TypeError("A Firecrawl client is required.");
  const website = normalizeUrl(lead.website);
  const messageable = isMessageable(lead);
  let report = null;
  let pages = [];
  let providerWarnings = [];
  let usage = { reportedTotal: 0, reportedSubtotal: 0, complete: true };

  if (!website) {
    providerWarnings.push("A valid website is missing; no research request was made.");
  } else {
    const input = {
      mode: "company", website, companyName: String(lead.organization || lead.name || "").trim(),
      requestedFields: ["Company overview", "Products and services", "Locations", "Public contact details"],
    };
    const result = await client.mapAndScrape(website, Math.max(1, Math.min(3, Number(maxPages) || 3)), input.requestedFields, () => {}, {
      strictAttempt: true, deadlineAt: Date.now() + 240_000, reportUsage: true,
    });
    pages = Array.isArray(result.data) ? result.data : [];
    providerWarnings = Array.isArray(result.warnings) ? result.warnings : [];
    usage = result.usage && typeof result.usage === "object"
      ? { reportedTotal: result.usage.reportedTotal ?? null, reportedSubtotal: Number(result.usage.reportedSubtotal) || 0, complete: result.usage.complete === true }
      : { reportedTotal: null, reportedSubtotal: 0, complete: false };
    report = buildReport({ input, crawlResult: result, warnings: providerWarnings });
  }

  const facts = sourcedFacts(pages);
  const reasons = ineligibleReason(lead, { hasFacts: facts.length > 0, messageable });
  if (!website) reasons.unshift("A valid website is required for sourced lead research.");
  const eligible = reasons.length === 0;
  const research = {
    researchedAt: nowIso(),
    ready: eligible,
    messageable,
    research: {
      confidence: facts.length >= 3 ? "high" : facts.length ? "medium" : "low",
      angle: facts.length ? "Review these sourced facts to choose a relevant outreach angle." : "No verified outreach angle is available yet.",
      dossierRef: null,
      facts,
    },
  };
  const reason = reasons.length ? reasons.join(" ") : null;
  const allWarnings = [...providerWarnings, ...(reason ? [reason] : [])];
  if (report) {
    report.id = String(lead.id);
    report.warnings = allWarnings;
    report.usage = { ...report.usage, enrichment: usage };
  } else {
    report = { id: String(lead.id), generatedAt: nowIso(), company: { name: lead.organization || lead.name || "", website }, sources: [], warnings: allWarnings, usage: { enrichment: usage } };
  }
  return { report, research, reason, creditsUsed: usage.reportedTotal, usage };
}
