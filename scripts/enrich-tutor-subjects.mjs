import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { extractTutorSubjects, htmlToText, relevantWebsiteLinks } from "../lib/tutor-subjects.mjs";

const appUrl = String(process.env.APP_URL || "https://trouidees-crm.vercel.app").replace(/\/$/, "");
const sessionUrl = new URL("../data/logs/crm-session-cookie.log", import.meta.url);
const stateUrl = new URL("../data/logs/tutor-subject-enrichment-state.log", import.meta.url);
const progressUrl = new URL("../data/logs/tutor-subject-enrichment.log", import.meta.url);
const runHours = Math.max(1, Math.min(12, Number(process.env.ENRICH_RUN_HOURS) || 6));
const concurrency = Math.max(1, Math.min(6, Number(process.env.ENRICH_CONCURRENCY) || 4));
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  await appendFile(progressUrl, `${line}\n`);
}

async function loadState() {
  try { return JSON.parse(await readFile(stateUrl, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { leads: {}, enriched: 0, noSubjects: 0, failed: 0, startedAt: new Date().toISOString() };
  }
}

let saveQueue = Promise.resolve();
function saveState(state) {
  state.updatedAt = new Date().toISOString();
  saveQueue = saveQueue.then(() => writeFile(stateUrl, JSON.stringify(state, null, 2)));
  return saveQueue;
}

function allowedWebsite(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/.test(url.protocol) || host === "localhost" || host.endsWith(".local")) return false;
    if (/^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(host)) return false;
    const private172 = host.match(/^172\.(\d+)\./);
    return !private172 || Number(private172[1]) < 16 || Number(private172[1]) > 31;
  } catch { return false; }
}

async function fetchHtml(url) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "ProspectCRM-SubjectEnrichment/1.0 (+public business research)" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new Error("Not an HTML page");
      return (await response.text()).slice(0, 2_000_000);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(1_000);
    }
  }
  throw lastError;
}

async function apiRequest(path, cookie, options = {}) {
  const response = await fetch(`${appUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Cookie: cookie, ...(options.headers || {}) },
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw new Error(payload.error || `CRM request failed with HTTP ${response.status}`);
  return payload;
}

async function inspectWebsite(website) {
  const homepage = await fetchHtml(website);
  const pages = [{ url: website, html: homepage }];
  for (const url of relevantWebsiteLinks(homepage, website)) {
    try { pages.push({ url, html: await fetchHtml(url) }); }
    catch {}
  }
  return [...new Set(pages.flatMap(({ html }) => extractTutorSubjects(htmlToText(html))))];
}

async function processLead(lead, cookie, state) {
  const previous = state.leads[lead.id] || { attempts: 0 };
  try {
    const subjects = await inspectWebsite(lead.website);
    if (subjects.length) {
      await apiRequest(`/api/crm/leads/${encodeURIComponent(lead.id)}`, cookie, {
        method: "PATCH",
        body: JSON.stringify({ services: subjects.join("; ") }),
      });
      state.enriched += 1;
      state.leads[lead.id] = { status: "enriched", attempts: previous.attempts + 1, subjects, website: lead.website, at: new Date().toISOString() };
      await log(`Enriched ${lead.name}: ${subjects.join(", ")}.`);
    } else {
      state.noSubjects += 1;
      state.leads[lead.id] = { status: "no-subjects", attempts: previous.attempts + 1, website: lead.website, at: new Date().toISOString() };
    }
  } catch (error) {
    state.failed += 1;
    state.leads[lead.id] = { status: "failed", attempts: previous.attempts + 1, website: lead.website, error: error.message, at: new Date().toISOString() };
  }
  await saveState(state);
}

async function runBatch(items, worker) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  }));
}

await mkdir(new URL("../data/logs/", import.meta.url), { recursive: true });
const cookie = String(await readFile(sessionUrl, "utf8")).trim();
if (!cookie) throw new Error("Production CRM session is missing. Run npm run crm:session first.");
const state = await loadState();
const deadline = Date.now() + runHours * 60 * 60 * 1_000;
await log(`Tutor subject enrichment started for up to ${runHours} hours with ${concurrency} workers.`);

do {
  const { leads = [] } = await apiRequest("/api/crm/leads", cookie);
  const candidates = leads.filter((lead) => {
    if (!/^Tutors\b/i.test(String(lead.leadType || "")) || !allowedWebsite(lead.website)) return false;
    const record = state.leads[lead.id];
    return !record || (record.status === "failed" && record.attempts < 3);
  });
  if (candidates.length) {
    await log(`Checking ${candidates.length} tutor websites for explicitly published subjects.`);
    await runBatch(candidates, (lead) => processLead(lead, cookie, state));
    await log(`Pass complete: ${state.enriched} enriched, ${state.noSubjects} without verified subjects, ${state.failed} failed attempts.`);
  }
  if (Date.now() < deadline) await sleep(120_000);
} while (Date.now() < deadline);

state.completedAt = new Date().toISOString();
await saveState(state);
await log(`Tutor subject enrichment stopped: ${state.enriched} enriched leads.`);
