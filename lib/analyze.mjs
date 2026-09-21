const SIGNAL_TERMS = [
  ["growth", "Growth or expansion language"],
  ["expansion", "Expansion activity"],
  ["hiring", "Active hiring"],
  ["vacancies", "Recruitment activity"],
  ["learnership", "Learnership activity"],
  ["training", "Workforce training focus"],
  ["skills development", "Skills-development priority"],
  ["compliance", "Compliance requirement"],
  ["transformation", "Transformation programme"],
  ["tender", "Tender or procurement activity"],
  ["partnership", "Partnership activity"],
  ["new office", "New location"],
  ["sustainability", "Sustainability priority"],
  ["b-bbee", "B-BBEE priority"],
];

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN = /(?:\+?27|0)[\s(.-]*\d{2}[\s).-]*\d{3}[\s.-]*\d{4}\b/g;
const INTERNATIONAL_PHONE_PATTERN = /(?:\+\d{1,3}[\s(.-]*)?(?:\d[\s().-]*){7,14}\b/g;
const SOCIAL_PATTERN = /https?:\/\/(?:www\.)?(?:linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com)\/[^\s)\]>"']+/gi;
const FREE_EMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "hotmail.com", "outlook.com", "live.com", "msn.com", "icloud.com", "me.com", "aol.com", "sbcglobal.net", "proton.me", "protonmail.com"]);
const GENERIC_EMAIL_NAMES = new Set(["admin", "admissions", "careers", "contact", "director", "employment", "enquiries", "enquiry", "ethics", "hello", "hr", "info", "jobs", "office", "principal", "reception", "registrar", "sales", "school", "support", "teacher", "tutor", "vacancies"]);
const AFRICAN_COUNTRIES = ["South Africa", "Nigeria", "Ghana", "Kenya", "Uganda", "Tanzania", "Rwanda", "Botswana", "Namibia", "Zambia", "Zimbabwe", "Malawi", "Mauritius", "Seychelles", "Lesotho", "Eswatini", "Liberia", "Sierra Leone", "Gambia", "Cameroon", "Ethiopia", "Mozambique", "Angola", "Madagascar", "Mauritania"];

const array = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
const unique = (values) => [...new Set(values.filter(Boolean))];
const clean = (value = "") => String(value).replace(/\s+/g, " ").trim();
const sourceUrl = (page) => page?.metadata?.sourceURL || page?.metadata?.url || "";

function usefulText(markdown = "") {
  return markdown
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[#*_`>|~-]/g, " ")
    .split(/\r?\n/)
    .map(clean)
    .filter((line) => line.length >= 35 && line.length <= 500);
}

function inferSummary(pages) {
  const description = pages.map((page) => clean(page?.metadata?.description)).find((value) => value.length > 40);
  if (description) return description;
  return pages.flatMap((page) => usefulText(page.markdown)).find(Boolean) || "No reliable company summary was found.";
}

function inferName(pages, fallback) {
  const title = clean(pages[0]?.metadata?.title || "").split(/[|–—-]/)[0].trim();
  return title || fallback;
}

function extractSignals(pages, maxSignals = 8) {
  const findings = [];
  for (const page of pages) {
    const lines = usefulText(page.markdown);
    for (const [term, label] of SIGNAL_TERMS) {
      const evidence = lines.find((line) => line.toLowerCase().includes(term));
      if (evidence && !findings.some((finding) => finding.signal === label)) {
        findings.push({
          signal: label,
          why_it_matters: "This may indicate a timely reason for a relevant sales conversation.",
          evidence: evidence.slice(0, 280),
          source_url: sourceUrl(page),
        });
      }
      if (findings.length >= maxSignals) return findings;
    }
  }
  return findings;
}

function extractContactDetails(pages) {
  const contacts = [];
  for (const page of pages) {
    const text = page.markdown || "";
    const emails = text.match(EMAIL_PATTERN) || [];
    const phones = text.match(PHONE_PATTERN) || [];
    for (const email of emails) {
      if (!contacts.some((item) => item.email.toLowerCase() === email.toLowerCase())) {
        contacts.push({ name: "", role: "", email, phone: "", source_url: sourceUrl(page) });
      }
    }
    for (const phone of phones) {
      const normalized = clean(phone);
      if (!contacts.some((item) => item.phone === normalized)) {
        contacts.push({ name: "", role: "", email: "", phone: normalized, source_url: sourceUrl(page) });
      }
    }
  }
  return contacts.slice(0, 20);
}

function normalizeAgent(agentResult) {
  const raw = agentResult?.data || {};
  return typeof raw === "object" && raw !== null ? raw : {};
}

function mergeContacts(primary, fallback) {
  const seen = new Set();
  return [...array(primary), ...fallback].filter((contact) => {
    if (!contact || typeof contact !== "object") return false;
    const key = clean(contact.email || contact.phone || `${contact.name}|${contact.role}`).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreReport({ pages, contacts, signals, opportunities, externalResults, hasAgent }) {
  let score = pages.length ? 20 : 0;
  score += Math.min(pages.length * 2, 20);
  score += Math.min(contacts.length * 5, 15);
  score += Math.min(signals.length * 4, 20);
  score += Math.min(opportunities.length * 5, 15);
  score += Math.min(externalResults.length * 2, 5);
  if (hasAgent) score += 5;
  return Math.min(score, 100);
}

function requestedFieldRows(input, report, agent) {
  const firstSource = report.sources[0]?.url || input.website;
  const agentRows = array(agent.requested_fields);
  const findAgentRow = (label) => agentRows.find((row) => clean(row?.field).toLowerCase() === clean(label).toLowerCase());
  const contacts = report.contacts.map((item) => [item.name, item.role, item.email, item.phone].filter(Boolean).join(" — ")).join("; ");
  const standard = {
    "Company overview": [report.company.summary, firstSource],
    "Products and services": [report.company.productsServices.join("; "), firstSource],
    "Target customers": [report.company.targetCustomers.join("; "), firstSource],
    "Industries": [report.company.industries.join("; "), firstSource],
    "Locations": [report.company.locations.join("; "), firstSource],
    "Decision makers": [report.contacts.filter((item) => item.name || item.role).map((item) => `${item.name || "Unknown"}${item.role ? ` (${item.role})` : ""}`).join("; "), report.contacts.find((item) => item.source_url)?.source_url || firstSource],
    "Public contact details": [contacts, report.contacts.find((item) => item.source_url)?.source_url || firstSource],
    "Buying signals": [report.salesSignals.map((item) => item.signal).join("; "), report.salesSignals.find((item) => item.source_url)?.source_url || firstSource],
    "Likely needs": [report.likelyNeeds.join("; "), firstSource],
    "Sales opportunities": [report.opportunities.map((item) => item.opportunity).join("; "), report.opportunities.find((item) => item.source_url)?.source_url || firstSource],
    "Recent news": [report.externalResearch.map((item) => item.title).join("; "), report.externalResearch[0]?.url || ""],
    "Differentiators": [report.company.differentiators.join("; "), firstSource],
    "Size indicators": [report.company.sizeIndicators.join("; "), firstSource],
    "Social profiles": [report.company.socialLinks.join("; "), report.company.socialLinks[0] || firstSource],
  };

  return array(input.requestedFields).map((label) => {
    const agentRow = findAgentRow(label);
    const fallback = standard[label] || ["", ""];
    const value = clean(agentRow?.value || fallback[0]);
    return {
      field: label,
      value: value || "Not found in the researched public sources.",
      evidence: clean(agentRow?.evidence || ""),
      sourceUrl: agentRow?.source_url || fallback[1] || "",
      found: Boolean(value),
    };
  });
}

export function buildReport({ input, crawlResult, searchResult, agentResult, warnings = [] }) {
  const pages = array(crawlResult?.data).filter((page) => page && typeof page === "object");
  const agent = normalizeAgent(agentResult);
  const agentCompany = agent.company && typeof agent.company === "object" ? agent.company : {};
  const hostname = new URL(input.website).hostname.replace(/^www\./, "");
  const heuristicSignals = extractSignals(pages);
  const signals = array(agent.sales_signals).length ? array(agent.sales_signals) : heuristicSignals;
  const contacts = mergeContacts(agent.contacts, extractContactDetails(pages));
  const opportunities = array(agent.opportunities);
  const web = array(searchResult?.data?.web);
  const companyName = clean(agentCompany.name || input.companyName || inferName(pages, hostname));
  const socialLinks = unique(pages.flatMap((page) => (page.markdown || "").match(SOCIAL_PATTERN) || []));
  const pageSources = pages.map((page) => ({
    title: clean(page?.metadata?.title || sourceUrl(page) || "Untitled page"),
    url: sourceUrl(page),
    description: clean(page?.metadata?.description || ""),
  })).filter((source) => source.url);

  const report = {
    id: "",
    generatedAt: new Date().toISOString(),
    input,
    company: {
      name: companyName,
      website: input.website,
      summary: clean(agentCompany.summary || inferSummary(pages)),
      industries: array(agentCompany.industries),
      locations: array(agentCompany.locations),
      productsServices: array(agentCompany.products_services),
      targetCustomers: array(agentCompany.target_customers),
      differentiators: array(agentCompany.differentiators),
      sizeIndicators: array(agentCompany.size_indicators),
      socialLinks,
    },
    qualification: {
      score: 0,
      confidence: agentResult && pages.length >= 3 ? "High" : pages.length >= 3 ? "Medium" : "Low",
      rationale: "The score reflects available public evidence, contacts, sales signals and identified opportunities; it is not a prediction of purchase intent.",
    },
    contacts,
    salesSignals: signals,
    likelyNeeds: array(agent.likely_needs),
    opportunities,
    recommendedContacts: array(agent.recommended_contacts),
    outreachAngles: array(agent.outreach_angles),
    risksOrUnknowns: array(agent.risks_or_unknowns),
    nextSteps: array(agent.next_steps),
    externalResearch: web.map((item) => ({
      title: clean(item.title || "Untitled result"),
      description: clean(item.description || ""),
      url: item.url || item.metadata?.sourceURL || "",
    })).filter((item) => item.url),
    sources: pageSources,
    usage: {
      pagesCrawled: pages.length,
      crawlCredits: Number(crawlResult?.creditsUsed || 0),
      searchCredits: Number(searchResult?.creditsUsed || 0),
      agentCredits: Number(agentResult?.creditsUsed || 0),
    },
    warnings,
  };

  report.fieldResults = requestedFieldRows(input, report, agent);

  report.qualification.score = scoreReport({
    pages,
    contacts,
    signals,
    opportunities,
    externalResults: report.externalResearch,
    hasAgent: Boolean(agentResult),
  });
  return report;
}

function personNameFromEmail(email) {
  const localPart = email.split("@")[0].toLowerCase();
  if (isGenericMailbox(localPart)) return "";
  const parts = localPart.replace(/\d+/g, " ").split(/[._-]+/).map(clean).filter((part) => part.length > 1);
  return parts.slice(0, 4).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

function isGenericMailbox(localPart) {
  return GENERIC_EMAIL_NAMES.has(localPart) || localPart.split(/[._-]+/).some((part) => GENERIC_EMAIL_NAMES.has(part));
}

function inferRole(text) {
  const roles = [
    [/(?:headmaster|headmistress)/i, "Headmaster"], [/(?:head of school|school head)/i, "Head of School"],
    [/(?:vice|deputy|assistant) principal/i, "Deputy Principal"], [/principal/i, "Principal"],
    [/(?:head of|department head|hod)\s+[a-z& ]{2,35}/i, "Department Head"], [/co-?ordinator/i, "Coordinator"],
    [/(?:teacher|educator|faculty|lecturer)/i, "Teacher"], [/tutor/i, "Tutor"], [/counsell?or/i, "Counsellor"],
  ];
  return roles.find(([pattern]) => pattern.test(text))?.[1] || "Education professional";
}

function inferSchoolName(title, url) {
  const titleParts = clean(title).split(/\s+[|–—-]\s+/).map(clean).filter(Boolean);
  const namedPart = titleParts.find((part) => /\b(?:school|academy|college|institute|education centre|learning centre)\b/i.test(part));
  if (namedPart) return namedPart.slice(0, 180);
  try {
    const domain = new URL(url).hostname.replace(/^www\./, "").split(".")[0].replace(/[-_]+/g, " ");
    return domain.split(" ").map((part) => part ? part[0].toUpperCase() + part.slice(1) : "").join(" ");
  } catch {
    return titleParts.at(-1)?.slice(0, 180) || "";
  }
}

function inferSchoolType(text) {
  const levels = [];
  if (/international school|american school|british school|cambridge|\bIB\b/i.test(text)) levels.push("International");
  if (/private school|independent school/i.test(text)) levels.push("Private/independent");
  if (/public school|government school|no fee school|quintile\s*[1-5]/i.test(text)) levels.push("Public");
  if (/primary school|elementary school|junior school/i.test(text)) levels.push("Primary/elementary");
  if (/secondary school|high school|senior school/i.test(text)) levels.push("Secondary/high");
  if (/tutor|tuition|learning cent(?:er|re)/i.test(text)) levels.push("Tutoring/learning centre");
  return unique(levels).join("; ") || "School/education provider";
}

function inferCountry(text, fallback = "") {
  const country = AFRICAN_COUNTRIES.find((name) => new RegExp(`\\b${name.replace(" ", "\\s+")}\\b`, "i").test(text));
  if (country) return country;
  if (/\b(?:Johannesburg|Pretoria|Cape Town|Durban|Gqeberha|Bloemfontein|East London|Polokwane|Mbombela|Rustenburg|Kimberley|George|Stellenbosch|Pietermaritzburg|Centurion|Midrand|Sandton|Roodepoort|Soweto|Randburg|Benoni|Boksburg|Alberton|Umhlanga)\b/i.test(text)) return "South Africa";
  return fallback;
}

function inferCountryFromUrl(url) {
  const domains = {
    za: "South Africa", ng: "Nigeria", gh: "Ghana", ke: "Kenya", ug: "Uganda", tz: "Tanzania", rw: "Rwanda",
    bw: "Botswana", na: "Namibia", zm: "Zambia", zw: "Zimbabwe", mw: "Malawi", mu: "Mauritius", sc: "Seychelles",
    ls: "Lesotho", sz: "Eswatini", lr: "Liberia", sl: "Sierra Leone", gm: "Gambia", cm: "Cameroon", et: "Ethiopia",
    mz: "Mozambique", ao: "Angola", mg: "Madagascar", mr: "Mauritania",
  };
  try { return domains[new URL(url).hostname.split(".").at(-1)] || ""; } catch { return ""; }
}

function inferLanguage(text) {
  if (/english[- ]medium|english is (?:the )?language of instruction|medium of instruction (?:is )?english|language of instruction (?:is )?english|english as (?:the )?(?:primary|main) language/i.test(text)) return "English (confirmed)";
  if (/international school|american school|british school|cambridge curriculum|\bIB curriculum/i.test(text) && /\benglish\b/i.test(text)) return "English (indicated)";
  return "Not confirmed";
}

function discoveryLeadsFromSearch(item, input) {
  const markdown = item.markdown || "";
  const url = item.url || item.metadata?.sourceURL || "";
  const emails = unique((markdown.match(EMAIL_PATTERN) || []).map((value) => value.toLowerCase())).slice(0, 100);
  const lines = usefulText(markdown);
  const title = clean(item.title || item.metadata?.title || "Lead").split(/[|–—]/)[0].trim();
  const contextLines = markdown.replace(/!\[[^\]]*]\([^)]*\)/g, "").replace(/\[([^\]]+)]\([^)]*\)/g, "$1").replace(/[#*_`>|~]/g, " ").split(/\r?\n/).map(clean).filter((line) => line.length > 1 && line.length <= 500);
  const pageText = clean(`${title} ${item.description || item.metadata?.description || ""} ${contextLines.join(" ")}`);
  const schoolName = inferSchoolName(title, url);
  const schoolType = inferSchoolType(pageText);
  const language = inferLanguage(pageText);
  const looksLikeSchoolPage = schoolType !== "School/education provider" || /school|academy|college|tutor|education/i.test(`${title} ${url}`);
  const pageCountry = inferCountry(`${title} ${item.description || item.metadata?.description || ""} ${url}`, inferCountryFromUrl(url) || (input.location === "South Africa" && looksLikeSchoolPage ? "South Africa" : ""));

  return emails.map((email) => {
    const lineIndex = contextLines.findIndex((line) => line.toLowerCase().includes(email));
    const nearbyLines = lineIndex >= 0 ? contextLines.slice(Math.max(0, lineIndex - 4), lineIndex + 3) : lines.slice(0, 3);
    const context = clean(nearbyLines.join(" "));
    const phones = unique((context.match(INTERNATIONAL_PHONE_PATTERN) || []).map(clean)).slice(0, 2);
    const country = inferCountry(context, pageCountry);
    return {
      name: personNameFromEmail(email) || title,
      role: inferRole(context || pageText),
      schoolName,
      details: clean(context || item.description || item.metadata?.description || lines[0] || "").slice(0, 420),
      phone: phones.join("; "),
      email,
      location: country,
      country,
      language,
      schoolType,
      subjectsServices: clean(nearbyLines.find((line) => /subject|grade|teacher|tutor|class|mathematics|english|science/i.test(line)) || "").slice(0, 320),
      website: url,
      sourceUrl: url,
      fitNote: "",
    };
  });
}

function discoveryLeadFromAgent(item) {
  return {
    name: clean(item.name),
    role: clean(item.role),
    schoolName: clean(item.school_name),
    details: clean(item.details),
    phone: clean(item.phone),
    email: clean(item.email),
    location: clean(item.location),
    country: clean(item.country || item.location),
    language: clean(item.language),
    schoolType: clean(item.school_type),
    subjectsServices: clean(item.subjects_services),
    website: item.website || "",
    sourceUrl: item.source_url || item.website || "",
    fitNote: clean(item.fit_note),
  };
}

function mergeDiscoveryLeads(agentLeads, searchLeads) {
  const merged = [];
  const keys = new Set();
  for (const lead of [...agentLeads, ...searchLeads]) {
    if (!lead.name && !lead.website) continue;
    let hostname = "";
    try { hostname = new URL(lead.website).hostname.replace(/^www\./, ""); } catch {}
    const key = clean(lead.email || `${hostname}|${lead.name}`).toLowerCase();
    if (keys.has(key)) continue;
    keys.add(key);
    merged.push(lead);
  }
  return merged;
}

export function buildDiscoveryReport({ input, searchResult, agentResult, warnings = [] }) {
  const searchItems = array(searchResult?.data?.web);
  const agentLeads = array(agentResult?.data?.leads).map(discoveryLeadFromAgent);
  const searchLeads = searchItems.flatMap((item) => discoveryLeadsFromSearch(item, input)).map((lead) => ({
    ...lead,
    location: /south africa/i.test(`${lead.name} ${lead.details} ${lead.subjectsServices}`) ? "South Africa" : lead.location,
  }));
  const allLeads = mergeDiscoveryLeads(agentLeads, searchLeads).filter((lead) => {
    const email = clean(lead.email).toLowerCase();
    if (!email) return false;
    const [localPart, domain] = email.split("@");
    if (input.professionalEmailsOnly && FREE_EMAIL_DOMAINS.has(domain)) return false;
    if (input.individualEmailsOnly && isGenericMailbox(localPart)) return false;
    if (input.educationRolesOnly && lead.role === "Education professional") return false;
    if (/africa/i.test(input.location) && !lead.country) return false;
    if (input.englishSchoolsOnly && lead.country !== "South Africa" && lead.language === "Not confirmed") return false;
    return true;
  });
  const leads = input.unlimited ? allLeads : allLeads.slice(0, input.maxPages);
  const requested = input.requestedFields.length ? input.requestedFields : ["Name", "Details", "Phone numbers", "Email addresses", "Website"];
  const columns = requested.map((field) => ({ field, key: ({
    "Name": "name", "Role": "role", "School name": "schoolName", "Details": "details", "Phone numbers": "phone", "Email addresses": "email", "Location": "location", "Country": "country", "Language": "language", "School type": "schoolType",
    "Subjects or services": "subjectsServices", "Website": "website", "Source": "sourceUrl", "Sales fit note": "fitNote",
  })[field] || "" }));
  const contacts = leads.filter((lead) => lead.phone || lead.email).map((lead) => ({
    name: lead.name, role: lead.role || "Lead", email: lead.email, phone: lead.phone, source_url: lead.sourceUrl,
  }));
  const coverage = leads.length ? Math.round((contacts.length / leads.length) * 100) : 0;

  return {
    id: "",
    mode: "discovery",
    generatedAt: new Date().toISOString(),
    input,
    company: {
      name: input.searchQuery,
      website: "",
      summary: `Found ${leads.length} public leads for ${input.location}. Every returned lead includes a public email address.`,
    },
    qualification: {
      score: coverage,
      confidence: agentResult && searchItems.length ? "High" : leads.length ? "Medium" : "Low",
      rationale: "For discovery reports, only leads with a public email address are included.",
    },
    columns,
    leads,
    fieldResults: [],
    contacts,
    nextSteps: ["Verify each public contact detail on its linked source before outreach.", "Prioritise leads whose services and location match the sales offer."],
    risksOrUnknowns: [],
    warnings: [...warnings, ...(searchResult?.warnings || []), ...(searchResult?.stopped ? ["Overnight discovery was stopped by the user; all leads found before stopping were saved."] : [])],
    usage: {
      pagesCrawled: searchItems.filter((item) => item.markdown).length,
      crawlCredits: 0,
      searchCredits: Number(searchResult?.creditsUsed || 0),
      agentCredits: Number(agentResult?.creditsUsed || 0),
    },
  };
}
