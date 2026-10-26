const path = "/api/crm/enrichment-batches";

const esc = (value = "") => String(value).replace(/[&<>\"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" })[c]);
const uuid = () => globalThis.crypto.randomUUID();

export function initCrmEnrichment({ root, fetchImpl = fetch, onResearchChanged = () => {} }) {
  if (!root) throw new Error("CRM enrichment root is required.");
  const adminId = root.dataset.adminId || "unknown-admin";
  const storageKey = `crm-enrichment:${adminId}`;
  let selected = new Set();
  let batches = [];
  let currentBatch = null;
  let visibleLeads = [];
  let busy = false;
  let stopRequested = false;
  let notice = "";
  const crm = root.closest("#crmView") || root;

  root.innerHTML = `<section class="enrichment-panel admin-only" aria-label="Lead enrichment"><div class="enrichment-toolbar"><div><strong id="enrichmentSelectionCount">0 selected</strong><p class="muted">Select CRM leads to research public sources. Selection is retained across pages and filters.</p></div><div class="enrichment-actions"><button id="enrichmentClear" class="button secondary" type="button">Clear selection</button><button id="enrichmentCreate" class="button primary" type="button" disabled>Enrich selected (0)</button></div></div><div id="enrichmentStatus" role="status" aria-live="polite"></div><div id="enrichmentBatches"></div></section>`;
  const store = (value) => localStorage.setItem(storageKey, JSON.stringify(value));
  const load = () => { try { return JSON.parse(localStorage.getItem(storageKey) || "{}"); } catch { return {}; } };
  const post = async (url, body) => {
    const response = await fetchImpl(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
    return payload;
  };
  const get = async (url) => {
    const response = await fetchImpl(url);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
    return payload;
  };

  function persistBatch(batch) {
    currentBatch = batch;
    const saved = load();
    saved.batchId = batch?.id || saved.batchId || null;
    store(saved);
    render();
  }

  function render() {
    root.querySelector("#enrichmentSelectionCount").textContent = `${selected.size} selected`;
    const create = root.querySelector("#enrichmentCreate");
    create.textContent = `Enrich selected (${selected.size})`;
    create.disabled = busy || selected.size < 1 || selected.size > 20 || Boolean(load().pendingCreate);
    root.querySelector("#enrichmentClear").disabled = busy || !selected.size;
    const status = root.querySelector("#enrichmentStatus");
    const host = root.querySelector("#enrichmentBatches");
    status.textContent = notice || (busy ? "Enrichment is running. Requests are processed one lead at a time." : "");
    if (!currentBatch) { host.innerHTML = batches.length ? `<h3>Recent enrichment batches</h3>${batches.map((batch) => `<button type="button" class="button secondary enrichment-open" data-batch="${esc(batch.id)}">${esc(batch.status)} · ${batch.items?.length || 0} leads</button>`).join(" ")}` : ""; return; }
    const counts = currentBatch.counts || {};
    const items = (currentBatch.items || []).map((item) => {
      const sources = (item.report?.sources || item.report?.pages || []).map((source) => source.url || source.sourceUrl).filter((url) => /^https?:\/\//i.test(url || ""));
      const facts = item.report?.facts || item.report?.fieldResults || [];
      for (const fact of facts) if (fact.sourceUrl && /^https?:\/\//i.test(fact.sourceUrl)) sources.push(fact.sourceUrl);
      const uniqueSources = [...new Set(sources)];
      return `<li><strong>${esc(item.lead?.name || item.leadId)}</strong><span class="status-chip">${esc(item.state)}</span>${item.reason ? `<p>${esc(item.reason)}</p>` : ""}${item.research?.reasons?.length ? `<p>${esc(item.research.reasons.join(" · "))}</p>` : ""}${item.creditsUsed == null ? `<small>Reported usage unavailable</small>` : `<small>${esc(item.creditsUsed)} reported credits</small>`}${uniqueSources.length ? `<p>${uniqueSources.map((url) => `<a class="source-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>`).join(" · ")}</p>` : ""}</li>`;
    }).join("");
    const unfinished = ["queued", "running"].some((state) => Number(counts[state] || 0) > 0);
    const retryable = Number(counts.failed || 0) + Number(counts.interrupted || 0) > 0;
    host.innerHTML = `<div class="enrichment-batch"><header><div><h3>Enrichment batch</h3><p>${esc(currentBatch.status)} · ${Number(counts.ready || 0)} ready · ${Number(counts.needs_review || 0)} needs review · ${Number(counts.failed || 0)} failed · ${Number(counts.interrupted || 0)} interrupted</p></div><div class="enrichment-actions">${unfinished ? `<button class="button primary" data-action="resume" type="button" ${busy ? "disabled" : ""}>Resume</button><button class="button secondary" data-action="stop" type="button" ${busy ? "" : "disabled"}>Stop</button>` : ""}${retryable ? `<button class="button secondary" data-action="retry" type="button" ${busy ? "disabled" : ""}>Retry failed</button>` : ""}<button class="button secondary" data-action="dismiss" type="button" ${busy ? "disabled" : ""}>Close</button></div></header><ul class="enrichment-items">${items}</ul></div>`;
  }

  function syncChecks() {
    root.closest("#crmView")?.querySelectorAll(".crm-enrichment-check").forEach((check) => { check.checked = selected.has(check.value); });
    render();
  }

  async function refresh() {
    const listed = await get(path);
    batches = listed.batches || [];
    const saved = load();
    if (saved.pendingCreate) {
      try {
        const created = await post(path, { requestKey:saved.pendingCreate.requestKey, leadIds:saved.pendingCreate.leadIds });
        saved.batchId = created.batch.id;
        delete saved.pendingCreate;
        store(saved);
      } catch { /* Keep the same key and selection for a later reload or explicit retry. */ }
    }
    const latest = load();
    currentBatch = latest.batchId ? await get(`${path}/${encodeURIComponent(latest.batchId)}`).then((result) => result.batch).catch(() => null) : batches[0] || null;
    if (currentBatch) { const next = load(); next.batchId = currentBatch.id; store(next); }
    render();
  }

  async function createBatch() {
    if (!selected.size || selected.size > 20 || busy) return;
    const saved = load();
    const pendingCreate = saved.pendingCreate || { requestKey:uuid(), leadIds:[...selected] };
    saved.pendingCreate = pendingCreate;
    store(saved);
    busy = true; render();
    try {
      const result = await post(path, pendingCreate);
      const next = load(); next.batchId = result.batch.id; delete next.pendingCreate; delete next.operationKey; store(next);
      selected.clear(); currentBatch = result.batch; await refresh();
    } catch (error) { notice = `Creation response was not confirmed. Reload to recover safely: ${error.message}`; }
    finally { busy = false; render(); syncChecks(); }
  }

  async function runBatch() {
    if (!currentBatch || busy) return;
    busy = true; render();
    try {
      stopRequested = false;
      while (!stopRequested && !document.hidden && currentBatch && ["queued", "running"].includes(currentBatch.status)) {
        let saved = load();
        if (!saved.operationKey) { saved.operationKey = uuid(); store(saved); }
        const { batch } = await post(`${path}/${encodeURIComponent(currentBatch.id)}/process-next`, { operationKey:saved.operationKey });
        const next = load(); delete next.operationKey; store(next);
        currentBatch = batch; render();
        if (!(batch.items || []).some((item) => ["queued", "running"].includes(item.state))) break;
        onResearchChanged(batch);
      }
      onResearchChanged(currentBatch);
    } catch (error) {
      notice = `Progress saved. Resume to replay the same operation safely: ${error.message}`;
    } finally { busy = false; render(); }
  }

  crm.addEventListener("change", (event) => {
    if (!event.target.matches(".crm-enrichment-check")) return;
    if (event.target.checked) selected.add(event.target.value); else selected.delete(event.target.value);
    syncChecks();
  });
  root.querySelector("#enrichmentCreate").addEventListener("click", createBatch);
  root.querySelector("#enrichmentClear").addEventListener("click", () => { selected.clear(); syncChecks(); });
  root.addEventListener("click", async (event) => {
    const open = event.target.closest(".enrichment-open");
    if (open) { currentBatch = (await get(`${path}/${encodeURIComponent(open.dataset.batch)}`)).batch; persistBatch(currentBatch); return; }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action || !currentBatch) return;
    if (action === "resume") return runBatch();
    if (action === "stop") { stopRequested = true; try { const { batch } = await post(`${path}/${encodeURIComponent(currentBatch.id)}/cancel`, {}); persistBatch(batch); } catch (error) { root.querySelector("#enrichmentStatus").textContent = error.message; } return; }
    if (action === "retry") {
      const leadIds = currentBatch.items.filter((item) => ["failed", "interrupted"].includes(item.state)).map((item) => item.leadId);
      const { batch } = await post(`${path}/${encodeURIComponent(currentBatch.id)}/retry`, { leadIds }); persistBatch(batch); return;
    }
    if (action === "dismiss") { currentBatch = null; render(); }
  });

  refresh().catch((error) => { root.querySelector("#enrichmentStatus").textContent = `Could not load saved enrichment batches: ${error.message}`; });
  return { setVisibleLeads(leads) { visibleLeads = leads || []; const table = crm.querySelector("#crmTable"); table?.querySelectorAll("tbody tr").forEach((row) => { const leadId = row.dataset.leadId; const cell = row.querySelector(".crm-enrichment-cell"); if (cell && leadId) cell.innerHTML = `<input class="crm-enrichment-check" type="checkbox" aria-label="Select ${esc(visibleLeads.find((lead) => lead.id === leadId)?.name || "lead")} for enrichment" value="${esc(leadId)}" ${selected.has(leadId) ? "checked" : ""}>`; }); syncChecks(); } };
}
