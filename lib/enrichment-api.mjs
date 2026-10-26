import { enrichLead } from "./lead-enrichment.mjs";
import { EnrichmentBatchStore } from "./enrichment-batch-store.mjs";

const BATCHES_PATH = "/api/crm/enrichment-batches";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) return request.body;
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 20_000) throw Object.assign(new Error("Request body is too large."), { status: 413 });
  }
  try { return JSON.parse(raw || "{}"); } catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }
}

function isRoute(path) { return path === BATCHES_PATH || path.startsWith(`${BATCHES_PATH}/`); }

export async function handleEnrichmentRequest({ request, response, user, db, client }) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (!isRoute(url.pathname)) return false;
  if (!user?.active) { sendJson(response, 401, { error: "Sign in required." }); return true; }
  if (user.role !== "admin") { sendJson(response, 403, { error: "Administrator access required." }); return true; }
  if (!db) { sendJson(response, 503, { error: "Lead enrichment requires the configured Neon database." }); return true; }
  const store = new EnrichmentBatchStore(db);
  const tail = url.pathname.slice(BATCHES_PATH.length).replace(/^\//, "");

  try {
    if (!tail && request.method === "POST") {
      const body = await readBody(request);
      if (!Array.isArray(body.leadIds) || body.leadIds.length < 1 || body.leadIds.length > 20
        || body.leadIds.some((id) => !UUID.test(String(id))) || new Set(body.leadIds).size !== body.leadIds.length) {
        throw Object.assign(new Error("Choose 1 to 20 distinct CRM leads."), { status: 400 });
      }
      const batch = await store.create(user.id, body.requestKey, body.leadIds);
      sendJson(response, 202, { batch });
      return true;
    }
    if (!tail && request.method === "GET") {
      sendJson(response, 200, { batches: await store.list(user.id, 20) });
      return true;
    }

    const match = /^([0-9a-f-]{36})(?:\/(process-next|retry|cancel))?$/i.exec(tail);
    if (!match || !UUID.test(match[1])) { sendJson(response, 404, { error: "Enrichment route not found." }); return true; }
    const [, batchId, action] = match;
    if (!action && request.method === "GET") {
      const batch = await store.get(batchId);
      if (!batch) throw Object.assign(new Error("Enrichment batch not found."), { status: 404 });
      sendJson(response, 200, { batch });
      return true;
    }
    if (action === "retry" && request.method === "POST") {
      const body = await readBody(request);
      sendJson(response, 200, { batch: await store.retry(batchId, body.leadIds) });
      return true;
    }
    if (action === "cancel" && request.method === "POST") {
      sendJson(response, 200, { batch: await store.cancel(batchId) });
      return true;
    }
    if (action === "process-next" && request.method === "POST") {
      const body = await readBody(request);
      if (!UUID.test(String(body.operationKey || ""))) throw Object.assign(new Error("operationKey must be a UUID."), { status: 400 });
      if (!client || typeof client.mapAndScrape !== "function") throw Object.assign(new Error("FIRECRAWL_API_KEY is not configured."), { status: 503 });
      const operation = await store.claimNext(batchId, body.operationKey);
      if (!operation.attempt) {
        const batch = operation.result || await store.get(batchId);
        if (!batch) throw Object.assign(new Error("Enrichment batch not found."), { status: 404 });
        sendJson(response, 200, { batch });
        return true;
      }
      const rows = await db.sql("SELECT id, data, do_not_contact FROM crm_leads WHERE id=$1", [operation.attempt.leadId]);
      if (!rows.length) {
        const batch = await store.complete(operation.attempt.id, { state: "failed", reason: "The selected lead no longer exists.", creditsUsed: null, usage: { reportedTotal: null, reportedSubtotal: 0, complete: false } });
        sendJson(response, 200, { batch });
        return true;
      }
      const lead = { ...rows[0].data, doNotContact: Boolean(rows[0].do_not_contact) };
      let result;
      try {
        const enriched = await enrichLead(lead, { client, maxPages: 3 });
        result = {
          state: enriched.research.ready ? "ready" : "needs_review",
          report: enriched.report,
          research: enriched.research,
          reason: enriched.reason,
          creditsUsed: enriched.creditsUsed,
          usage: enriched.usage,
        };
      } catch (error) {
        const interrupted = Number(error?.status) >= 500 || !Number(error?.status);
        result = {
          state: interrupted ? "interrupted" : "failed",
          reason: String(error?.message || "Research request failed.").slice(0, 1000),
          creditsUsed: null,
          usage: { reportedTotal: null, reportedSubtotal: 0, complete: false },
        };
      }
      sendJson(response, 200, { batch: await store.complete(operation.attempt.id, result) });
      return true;
    }
    sendJson(response, 405, { error: "Method not allowed." });
    return true;
  } catch (error) {
    sendJson(response, Number(error?.status) || 500, { error: error?.message || "Enrichment request failed." });
    return true;
  }
}
