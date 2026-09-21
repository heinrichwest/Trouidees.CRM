import http from "node:http";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FirecrawlClient, FirecrawlError } from "./lib/firecrawl.mjs";
import { buildDiscoveryReport, buildReport } from "./lib/analyze.mjs";
import { GooglePlacesClient, placeToLead } from "./lib/google-places.mjs";
import { addLeadType, deleteCrmLead, deleteLeadType, importCrmLeads, listCrmLeads, listLeadTypes, renameLeadType, updateCrmLead } from "./lib/crm.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(root, "public");
const reportsRoot = join(root, "data", "reports");
const crmFile = join(root, "data", "crm", "leads.json");
const crmTypesFile = join(root, "data", "crm", "types.json");
const port = Number(process.env.PORT || 4173);
const jobs = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new RequestError("Request body is too large.", 413);
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new RequestError("Request body must be valid JSON.", 400);
  }
}

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function normalizeInput(body) {
  const mode = body.mode === "discovery" ? "discovery" : "company";
  let website = String(body.website || "").trim();
  const searchQuery = String(body.searchQuery || "").trim().slice(0, 500);
  if (mode === "company" && !website) throw new RequestError("Enter a company website.");
  if (mode === "discovery" && !searchQuery) throw new RequestError("Describe the leads you want Firecrawl to find.");
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;

  let parsed;
  if (website) {
    try {
      parsed = new URL(website);
    } catch {
      throw new RequestError("Enter a valid website URL.");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new RequestError("Only HTTP and HTTPS websites are supported.");
    parsed.hash = "";
  }
  const unlimited = mode === "discovery" && body.unlimited === true;
  const maxPages = unlimited ? 0 : Math.max(1, Math.min(100, Number(body.maxPages) || 10));
  const runHours = Math.max(1, Math.min(12, Number(body.runHours) || 8));
  const leadType = String(body.leadType || "").trim().slice(0, 100);
  if (mode === "discovery" && !leadType) throw new RequestError("Enter a lead type, such as Tutors, Photographers or Gift Sellers.");
  const agentMaxCredits = Math.max(5, Math.min(100, Number(body.agentMaxCredits) || 20));
  const requestedFields = Array.isArray(body.requestedFields)
    ? [...new Set(body.requestedFields.map((field) => String(field).trim().slice(0, 100)).filter(Boolean))].slice(0, 24)
    : [];
  if (!requestedFields.length) requestedFields.push("Company overview", "Products and services", "Public contact details", "Buying signals");

  return {
    mode,
    website: parsed?.toString() || "",
    searchQuery,
    companyName: String(body.companyName || "").trim().slice(0, 150),
    offering: String(body.offering || "").trim().slice(0, 1_000),
    country: String(body.country || "ZA").trim().toUpperCase().slice(0, 2) || "ZA",
    location: String(body.location || "South Africa").trim().slice(0, 150),
    maxPages,
    unlimited,
    runHours,
    leadType,
    includeSearch: body.includeSearch !== false,
    useAgent: body.useAgent === true,
    professionalEmailsOnly: body.professionalEmailsOnly === true,
    individualEmailsOnly: body.individualEmailsOnly === true,
    englishSchoolsOnly: body.englishSchoolsOnly === true,
    educationRolesOnly: body.educationRolesOnly === true,
    agentMaxCredits,
    researchGoal: String(body.researchGoal || "").trim().slice(0, 500),
    requestedFields,
  };
}

const defaultSouthAfricaLocations = [
  "Johannesburg", "Pretoria", "Cape Town", "Durban", "Gqeberha", "Bloemfontein", "East London", "Pietermaritzburg",
  "Polokwane", "Mbombela", "Kimberley", "Rustenburg", "George", "Stellenbosch", "Paarl", "Somerset West", "Centurion",
  "Midrand", "Sandton", "Roodepoort", "Boksburg", "Benoni", "Kempton Park", "Soweto", "Randburg", "Umhlanga",
];

function normalizeMapsInput(body) {
  const businessType = String(body.businessType || "").trim().replace(/\s+/g, " ").slice(0, 200);
  const leadType = String(body.leadType || businessType || "").trim().replace(/\s+/g, " ").slice(0, 100);
  if (!businessType) throw new RequestError("Enter a business category, such as coffee shops or salons.");
  if (!leadType) throw new RequestError("Enter the CRM lead type for these businesses.");
  const suppliedLocations = Array.isArray(body.locations) ? body.locations : String(body.locations || "").split(/[\r\n;,]+/);
  let locations = [...new Set(suppliedLocations.map((value) => String(value).trim()).filter(Boolean))].slice(0, 100);
  if (!locations.length) locations = [...defaultSouthAfricaLocations];
  return {
    mode: "maps",
    businessType,
    leadType,
    locations,
    regionCode: String(body.regionCode || "ZA").trim().toUpperCase().slice(0, 2) || "ZA",
    maxResults: Math.max(1, Math.min(5_000, Number(body.maxResults) || 500)),
    maxPagesPerLocation: Math.max(1, Math.min(3, Number(body.maxPagesPerLocation) || 3)),
    phoneRequired: body.phoneRequired !== false,
  };
}

function buildMapsReport(input, leads, usage, generatedAt, warnings = []) {
  const phoneCount = leads.filter((lead) => lead.phone).length;
  return {
    mode: "maps",
    generatedAt,
    input,
    company: {
      name: `${input.businessType} from Google Maps`,
      website: "",
      summary: `${leads.length} public business listings saved to the ${input.leadType} CRM category. These are business contacts; Google Places does not verify the owner’s identity.`,
    },
    qualification: { score: leads.length ? Math.round((phoneCount / leads.length) * 100) : 0, confidence: "Public listing" },
    leads,
    columns: [
      { field: "Business", key: "name" }, { field: "Category", key: "role" }, { field: "Phone", key: "phone" },
      { field: "Address", key: "location" }, { field: "Website", key: "website" }, { field: "Rating", key: "rating" },
      { field: "Google Maps", key: "googleMapsUrl" },
    ],
    usage: { googleRequests: usage.requests, placesFound: usage.placesFound, locationsSearched: usage.locationsSearched },
    warnings: [
      "Google Places provides public business listing details, not a verified owner name or a guarantee that a listed number is a mobile number.",
      ...warnings,
    ],
    nextSteps: ["Verify the business and contact details before outreach.", "Record outreach status and feedback in the Lead CRM."],
  };
}

async function research(input, apiKey, onProgress = () => {}, shouldStop = () => false, onCheckpoint = () => {}) {
  const client = new FirecrawlClient(apiKey);
  if (input.mode === "discovery") {
    const jobs = [
      ["search", input.unlimited
        ? client.discoverOvernight(input.searchQuery, { country: input.country, location: input.location, runHours: input.runHours }, onProgress, shouldStop, onCheckpoint)
        : client.discover(input.searchQuery, { country: input.country, location: input.location, limit: input.maxPages }, onProgress)],
      input.useAgent ? ["agent", client.discoveryAgent({
        query: input.searchQuery,
        location: input.location,
        offering: input.offering,
        requestedFields: input.requestedFields,
        maxCredits: input.agentMaxCredits,
        limit: input.unlimited ? 100 : input.maxPages,
      }, onProgress)] : null,
    ].filter(Boolean);
    const settled = await Promise.allSettled(jobs.map(([, promise]) => promise));
    const results = {};
    const warnings = [];
    settled.forEach((result, index) => {
      const name = jobs[index][0];
      if (result.status === "fulfilled") results[name] = result.value;
      else warnings.push(`${name}: ${result.reason?.message || "Request failed."}`);
    });
    if (!results.search && !results.agent) throw new FirecrawlError(warnings.join(" ") || "No leads were returned.", 502);
    return buildDiscoveryReport({ input, searchResult: results.search, agentResult: results.agent, warnings });
  }
  const domain = new URL(input.website).hostname.replace(/^www\./, "");
  const target = input.companyName || domain;
  const query = `"${target}" (${domain}) news OR expansion OR hiring OR partnership`;
  const jobs = [
    ["crawl", client.mapAndScrape(input.website, input.maxPages, input.requestedFields, onProgress)],
    input.includeSearch ? ["search", client.search(query, input).then((result) => {
      onProgress({ stage: "search", message: "External signal search completed" });
      return result;
    })] : null,
    input.useAgent ? ["agent", client.agent({
      url: input.website,
      companyName: input.companyName,
      offering: input.offering,
      includeExternalResearch: input.includeSearch,
      maxCredits: input.agentMaxCredits,
      requestedFields: input.requestedFields,
      researchGoal: input.researchGoal,
    }, onProgress)] : null,
  ].filter(Boolean);

  const settled = await Promise.allSettled(jobs.map(([, promise]) => promise));
  const results = {};
  const warnings = [];
  settled.forEach((result, index) => {
    const name = jobs[index][0];
    if (result.status === "fulfilled") results[name] = result.value;
    else warnings.push(`${name}: ${result.reason?.message || "Request failed."}`);
  });
  if (results.crawl?.warnings?.length) warnings.push(...results.crawl.warnings);

  if (!results.crawl && !results.agent) {
    throw new FirecrawlError(warnings.join(" ") || "Research did not return usable results.", 502);
  }

  return buildReport({
    input,
    crawlResult: results.crawl,
    searchResult: results.search,
    agentResult: results.agent,
    warnings,
  });
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    unlimited: job.input?.unlimited === true,
    mode: job.input?.mode,
    stoppable: job.input?.unlimited === true || job.input?.mode === "maps",
    progress: job.progress,
    result: job.status === "completed" ? job.result : undefined,
    partialResult: job.status === "running" ? job.partialResult : undefined,
    error: job.status === "failed" ? job.error : undefined,
  };
}

function startResearchJob(input, apiKey) {
  const id = randomUUID();
  const job = {
    id,
    input,
    status: "running",
    progress: { stage: "starting", message: "Preparing research tasks", completed: 0, total: input.maxPages },
    createdAt: Date.now(),
  };
  if (process.platform === "win32" && input.unlimited) {
    job.keepAwakeProcess = spawn("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "keep-awake.ps1"), "-Hours", String(input.runHours + 0.5),
    ], { windowsHide: true, stdio: "ignore" });
  }
  jobs.set(id, job);

  const checkpoint = async (searchResult) => {
    const report = buildDiscoveryReport({ input, searchResult, warnings: [] });
    report.generatedAt = new Date(job.createdAt).toISOString();
    const saved = await saveReport(report, job.reportId);
    job.reportId = saved.id;
    job.partialResult = saved;
    const crm = await importCrmLeads(crmFile, saved.leads || [], input.leadType, crmTypesFile);
    job.progress = {
      ...job.progress,
      message: `Checkpoint saved: ${saved.leads.length} email-qualified leads are safe in the CRM`,
      emailLeadsSaved: saved.leads.length,
      crmTotal: crm.total,
      reportId: saved.id,
    };
  };

  research(input, apiKey, (progress) => { job.progress = { ...job.progress, ...progress }; }, () => job.cancelRequested === true, input.unlimited ? checkpoint : () => {})
    .then(async (result) => {
      result.generatedAt = new Date(job.createdAt).toISOString();
      const saved = await saveReport(result, job.reportId);
      if (input.unlimited) {
        await importCrmLeads(crmFile, saved.leads || [], input.leadType, crmTypesFile);
      }
      return saved;
    })
    .then((result) => {
      job.status = "completed";
      job.progress = { ...job.progress, stage: "complete", message: "Sales brief ready" };
      job.result = result;
    })
    .catch((error) => {
      job.status = "failed";
      job.error = error.message || "Research failed.";
    })
    .finally(() => job.keepAwakeProcess?.kill());

  return job;
}

function startMapsJob(input, apiKey) {
  const id = randomUUID();
  const createdAt = Date.now();
  const generatedAt = new Date(createdAt).toISOString();
  const job = {
    id, input, status: "running", createdAt,
    progress: { stage: "maps", message: "Preparing Google Maps business searches", completed: 0, total: input.locations.length, leadsSaved: 0, googleRequests: 0 },
  };
  const client = new GooglePlacesClient(apiKey);
  jobs.set(id, job);

  (async () => {
    const leads = [];
    const seen = new Set();
    const usage = { requests: 0, placesFound: 0, locationsSearched: 0 };
    const warnings = [];
    for (let index = 0; index < input.locations.length && leads.length < input.maxResults; index += 1) {
      if (job.cancelRequested) break;
      const location = input.locations[index];
      const query = `${input.businessType} in ${location}`;
      job.progress = { ...job.progress, message: `Searching ${query}`, completed: index, currentLocation: location };
      const result = await client.searchText(query, {
        maxPages: input.maxPagesPerLocation,
        regionCode: input.regionCode,
        shouldStop: () => job.cancelRequested || leads.length >= input.maxResults,
      }, async (pagePlaces, page) => {
        usage.placesFound += pagePlaces.length;
        const newLeads = [];
        for (const place of pagePlaces) {
          const lead = placeToLead(place, location);
          const key = lead.placeId || `${lead.name.toLowerCase()}|${lead.location.toLowerCase()}`;
          if (seen.has(key) || (input.phoneRequired && !lead.phone) || leads.length >= input.maxResults) continue;
          seen.add(key);
          leads.push(lead);
          newLeads.push(lead);
        }
        if (newLeads.length) {
          await importCrmLeads(crmFile, newLeads, input.leadType, crmTypesFile, { requireEmail: false, requirePhone: input.phoneRequired });
        }
        const estimatedRequests = usage.requests + page.requests;
        const partial = buildMapsReport(input, leads, { ...usage, requests: estimatedRequests, locationsSearched: index + 1 }, generatedAt, warnings);
        const saved = await saveReport(partial, job.reportId);
        job.reportId = saved.id;
        job.partialResult = saved;
        job.progress = {
          ...job.progress,
          message: `Checkpoint saved: ${leads.length} ${input.phoneRequired ? "phone-qualified " : ""}business leads are safe in the CRM`,
          leadsSaved: leads.length,
          googleRequests: estimatedRequests,
          page: page.page,
          reportId: saved.id,
        };
      });
      usage.requests += result.requests;
      usage.locationsSearched = index + 1;
      job.progress = { ...job.progress, completed: index + 1, googleRequests: usage.requests };
    }
    return saveReport(buildMapsReport(input, leads, usage, generatedAt, warnings), job.reportId);
  })().then((result) => {
    job.status = "completed";
    job.result = result;
    job.progress = { ...job.progress, stage: "complete", message: `Google Maps search complete: ${result.leads.length} leads saved` };
  }).catch((error) => {
    job.status = "failed";
    job.error = error.message || "Google Maps research failed.";
  });

  return job;
}

function reportId(report) {
  const domain = report.input.mode === "maps"
    ? `maps-${report.input.businessType.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 50)}`
    : report.input.mode === "discovery"
    ? `discovery-${report.input.searchQuery.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 50)}`
    : new URL(report.input.website).hostname.replace(/^www\./, "").replace(/[^a-z0-9.-]/gi, "-");
  const timestamp = report.generatedAt.replace(/[:.]/g, "-");
  return `${timestamp}-${domain}`;
}

async function saveReport(report, existingId = "") {
  await mkdir(reportsRoot, { recursive: true });
  report.id = existingId || reportId(report);
  await writeFile(join(reportsRoot, `${report.id}.json`), JSON.stringify(report, null, 2), "utf8");
  return report;
}

async function listReports() {
  await mkdir(reportsRoot, { recursive: true });
  const names = (await readdir(reportsRoot)).filter((name) => name.endsWith(".json")).sort().reverse().slice(0, 30);
  const reports = await Promise.all(names.map(async (name) => {
    try {
      const report = JSON.parse(await readFile(join(reportsRoot, name), "utf8"));
      return {
        id: report.id,
        generatedAt: report.generatedAt,
        companyName: report.company?.name,
        website: report.company?.website,
        score: report.qualification?.score,
        mode: report.mode,
      };
    } catch {
      return null;
    }
  }));
  return reports.filter(Boolean);
}

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = resolve(publicRoot, requested);
  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${sep}`)) {
    throw new RequestError("Not found.", 404);
  }
  const content = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(content);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendJson(response, 200, {
        ok: true,
        apiKeyConfigured: Boolean(process.env.FIRECRAWL_API_KEY),
        googleMapsKeyConfigured: Boolean(process.env.GOOGLE_MAPS_API_KEY),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/reports") {
      return sendJson(response, 200, { reports: await listReports() });
    }

    if (request.method === "GET" && url.pathname === "/api/crm/leads") {
      return sendJson(response, 200, { leads: await listCrmLeads(crmFile) });
    }

    if (request.method === "GET" && url.pathname === "/api/crm/types") {
      return sendJson(response, 200, { types: await listLeadTypes(crmTypesFile, crmFile) });
    }

    if (request.method === "POST" && url.pathname === "/api/crm/types") {
      const requestedName = String((await readBody(request)).name || "").trim();
      if (!requestedName) throw new RequestError("Enter a lead type name.");
      const name = await addLeadType(crmTypesFile, requestedName);
      return sendJson(response, 201, { name });
    }

    if (request.method === "PATCH" && url.pathname === "/api/crm/types") {
      const body = await readBody(request);
      if (!String(body.oldName || "").trim() || !String(body.newName || "").trim()) throw new RequestError("Both lead type names are required.");
      try {
        const name = await renameLeadType(crmTypesFile, crmFile, body.oldName, body.newName);
        if (!name) throw new RequestError("Lead type not found.", 404);
        return sendJson(response, 200, { name });
      } catch (error) {
        if (error.code === "TYPE_EXISTS") throw new RequestError(error.message, 409);
        throw error;
      }
    }

    if (request.method === "DELETE" && url.pathname === "/api/crm/types") {
      const body = await readBody(request);
      if (!String(body.name || "").trim()) throw new RequestError("Choose a lead type to delete.");
      try {
        await deleteLeadType(crmTypesFile, crmFile, body.name);
        return sendJson(response, 200, { deleted: true });
      } catch (error) {
        if (error.code === "TYPE_IN_USE") throw new RequestError(error.message, 409);
        throw error;
      }
    }

    if (request.method === "POST" && url.pathname === "/api/crm/import") {
      const body = await readBody(request);
      const reportId = String(body.reportId || "");
      const leadType = String(body.leadType || "").trim().slice(0, 100);
      if (!/^[a-zA-Z0-9.-]+$/.test(reportId)) throw new RequestError("Invalid report ID.");
      if (!leadType) throw new RequestError("Choose a lead type before saving.");
      const report = JSON.parse(await readFile(join(reportsRoot, `${reportId}.json`), "utf8"));
      const options = report.mode === "maps" ? { requireEmail: false, requirePhone: report.input?.phoneRequired !== false } : {};
      return sendJson(response, 200, await importCrmLeads(crmFile, report.leads || [], leadType, crmTypesFile, options));
    }

    if (request.method === "PATCH" && url.pathname.startsWith("/api/crm/leads/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/crm/leads/".length));
      if (!/^[a-f0-9-]{36}$/i.test(id)) throw new RequestError("Invalid lead ID.");
      const lead = await updateCrmLead(crmFile, id, await readBody(request));
      if (!lead) throw new RequestError("Lead not found.", 404);
      return sendJson(response, 200, lead);
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/crm/leads/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/crm/leads/".length));
      if (!/^[a-f0-9-]{36}$/i.test(id)) throw new RequestError("Invalid lead ID.");
      if (!await deleteCrmLead(crmFile, id)) throw new RequestError("Lead not found.", 404);
      return sendJson(response, 200, { deleted: true });
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/reports/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/reports/".length));
      if (!/^[a-zA-Z0-9.-]+$/.test(id)) throw new RequestError("Invalid report ID.");
      const report = JSON.parse(await readFile(join(reportsRoot, `${id}.json`), "utf8"));
      return sendJson(response, 200, report);
    }

    if (request.method === "GET" && url.pathname === "/api/jobs") {
      const activeJobs = [...jobs.values()]
        .filter((job) => job.status === "running")
        .sort((left, right) => right.createdAt - left.createdAt)
        .map(publicJob);
      return sendJson(response, 200, { jobs: activeJobs });
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/jobs/".length));
      const job = jobs.get(id);
      if (!job) throw new RequestError("Research job not found or the local server was restarted.", 404);
      return sendJson(response, 200, publicJob(job));
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/jobs/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/jobs/".length));
      const job = jobs.get(id);
      if (!job) throw new RequestError("Research job not found.", 404);
      if (job.status === "running") {
        job.cancelRequested = true;
        job.progress = { ...job.progress, message: `Stopping after the current ${job.input?.mode === "maps" ? "Google Places" : "Firecrawl"} request…` };
      }
      return sendJson(response, 202, publicJob(job));
    }

    if (request.method === "POST" && url.pathname === "/api/research") {
      const apiKey = String(request.headers["x-firecrawl-key"] || process.env.FIRECRAWL_API_KEY || "").trim();
      if (!apiKey) throw new RequestError("Enter your Firecrawl API key or set FIRECRAWL_API_KEY.", 401);
      const input = normalizeInput(await readBody(request));
      const job = startResearchJob(input, apiKey);
      return sendJson(response, 202, publicJob(job));
    }

    if (request.method === "POST" && url.pathname === "/api/maps/research") {
      const apiKey = String(request.headers["x-google-maps-key"] || process.env.GOOGLE_MAPS_API_KEY || "").trim();
      if (!apiKey) throw new RequestError("Enter your Google Maps API key or set GOOGLE_MAPS_API_KEY.", 401);
      const input = normalizeMapsInput(await readBody(request));
      return sendJson(response, 202, publicJob(startMapsJob(input, apiKey)));
    }

    if (request.method !== "GET") throw new RequestError("Method not allowed.", 405);
    await serveStatic(url.pathname, response);
  } catch (error) {
    if (error.code === "ENOENT") return sendJson(response, 404, { error: "Not found." });
    const status = error.status || 500;
    if (status >= 500) console.error(`[${new Date().toISOString()}] ${error.name}: ${error.message}`);
    sendJson(response, status, { error: error.message || "Unexpected server error." });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Sales research workspace: http://127.0.0.1:${port}`);
  console.log(`Firecrawl key from environment: ${process.env.FIRECRAWL_API_KEY ? "configured" : "not configured"}`);
  console.log(`Google Maps key from environment: ${process.env.GOOGLE_MAPS_API_KEY ? "configured" : "not configured"}`);
});

setInterval(() => {
  const cutoff = Date.now() - 48 * 60 * 60_000;
  for (const [id, job] of jobs) if (job.status !== "running" && job.createdAt < cutoff) jobs.delete(id);
}, 60 * 60_000).unref();
