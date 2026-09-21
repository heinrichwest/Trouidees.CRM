const $ = (id) => document.getElementById(id);
let step = 1;
let currentReport = null;
let apiKeyConfigured = false;
let googleMapsKeyConfigured = false;
let activeJobId = null;
let crmLeads = [];
let crmTypes = [];

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[char]);
const safeUrl = (value = "") => { try { const url = new URL(value); return ["http:","https:"].includes(url.protocol) ? escapeHtml(url.href) : ""; } catch { return ""; } };
const typeNames = () => crmTypes.map((type) => type.name);
function setTypeSelect(select, selected = "", includeAll = false) {
  const names = [...typeNames()];
  if (selected && !names.some((name) => name.toLowerCase() === selected.toLowerCase())) names.push(selected);
  select.innerHTML = `${includeAll ? '<option value="">All types</option>' : ""}${names.sort().map((name) => `<option value="${escapeHtml(name)}" ${name === selected ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}`;
}
const selectedGoal = () => document.querySelector('input[name="researchGoal"]:checked')?.value || "Sales prospect research";
const selectedMode = () => document.querySelector('input[name="researchGoal"]:checked')?.dataset.mode || "company";
const selectedFields = () => [...document.querySelectorAll(`#${selectedMode() === "discovery" ? "discoveryFieldGrid" : "companyFieldGrid"} input:checked`)].map((input) => input.value);
const customFields = () => $("customFields").value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).slice(0, 10);

function showStep(nextStep) {
  step = nextStep;
  document.querySelectorAll(".step-panel").forEach((panel) => panel.classList.toggle("hidden", Number(panel.dataset.step) !== step));
  document.querySelectorAll("[data-step-dot]").forEach((item) => {
    const itemStep = Number(item.dataset.stepDot);
    item.classList.toggle("active", itemStep === step);
    item.classList.toggle("done", itemStep < step);
  });
  $("backButton").classList.toggle("hidden", step === 1);
  $("nextButton").classList.toggle("hidden", step === 4);
  $("runButton").classList.toggle("hidden", step !== 4);
  $("formError").classList.add("hidden");
  if (step === 4) renderReview();
}

function showError(message) {
  $("formError").textContent = message;
  $("formError").classList.remove("hidden");
}

function validateStep() {
  if (step === 2 && selectedMode() === "company" && !$("website").value.trim()) return showError("Enter the company website before continuing."), false;
  if (step === 2 && selectedMode() === "discovery" && !$("searchQuery").value.trim()) return showError("Describe the businesses or professionals you want to find."), false;
  if (step === 2 && selectedMode() === "discovery" && !$("leadType").value.trim()) return showError("Enter a lead type so these results stay separate in the CRM."), false;
  if (step === 3 && selectedFields().length + customFields().length === 0) return showError("Select or add at least one result field."), false;
  if (step === 4 && !apiKeyConfigured && !$("apiKey").value.trim()) return showError("Enter your Firecrawl API key."), false;
  return true;
}

function renderReview() {
  const fields = [...selectedFields(), ...customFields()];
  const target = selectedMode() === "discovery" ? $("searchQuery").value : ($("companyName").value || $("website").value);
  const scope = selectedMode() === "discovery" && $("unlimited").checked ? `Unlimited, up to ${$("runHours").value} hours or until stopped` : `${$("maxPages").value} ${selectedMode() === "discovery" ? "leads" : "pages"}`;
  $("reviewBox").innerHTML = `<dl><dt>Objective</dt><dd>${escapeHtml(selectedGoal())}</dd>${selectedMode() === "discovery" ? `<dt>Lead type</dt><dd>${escapeHtml($("leadType").value)}</dd>` : ""}<dt>Research target</dt><dd>${escapeHtml(target)}</dd><dt>Offering</dt><dd>${escapeHtml($("offering").value || "Not specified")}</dd><dt>Result fields</dt><dd>${escapeHtml(fields.join(", "))}</dd><dt>Scope</dt><dd>${escapeHtml(scope)}</dd></dl>`;
}

function syncModeUi() {
  const discovery = selectedMode() === "discovery";
  $("discoveryFields").classList.toggle("hidden", !discovery);
  $("companyFields").classList.toggle("hidden", discovery);
  $("discoveryFieldGrid").classList.toggle("hidden", !discovery);
  $("discoveryQuality").classList.toggle("hidden", !discovery);
  $("companyFieldGrid").classList.toggle("hidden", discovery);
  $("prospectHeading").textContent = discovery ? "What should Firecrawl find?" : "Which company should we investigate?";
  $("prospectLead").textContent = discovery ? "Describe any type of business or professional; no company website is required." : "A website is enough. The other details improve relevance.";
  $("limitLabel").textContent = discovery ? "Maximum leads" : "Maximum website pages";
  $("unlimitedOption").classList.toggle("hidden", !discovery);
  if (!discovery) $("unlimited").checked = false;
  syncUnlimitedUi();
}

function syncUnlimitedUi() {
  const enabled = selectedMode() === "discovery" && $("unlimited").checked;
  $("maxPages").disabled = enabled;
  $("runHoursField").classList.toggle("hidden", !enabled);
  $("unlimitedWarning").classList.toggle("hidden", !enabled);
  if (step === 4) renderReview();
}

document.querySelectorAll('input[name="researchGoal"]').forEach((input) => input.addEventListener("change", syncModeUi));
document.querySelectorAll("[data-query]").forEach((button) => button.addEventListener("click", () => {
  $("searchQuery").value = button.dataset.query;
  $("leadType").value = button.dataset.leadType;
  if (button.dataset.education === "true") {
    $("location").value = "Africa";
    $("country").value = "ZA";
    $("professionalEmailsOnly").checked = true;
    $("individualEmailsOnly").checked = true;
    $("englishSchoolsOnly").checked = true;
    $("educationRolesOnly").checked = true;
  }
  $("searchQuery").focus();
}));
$("unlimited").addEventListener("change", syncUnlimitedUi);

$("nextButton").addEventListener("click", () => { if (validateStep()) showStep(Math.min(4, step + 1)); });
$("backButton").addEventListener("click", () => showStep(Math.max(1, step - 1)));

function payload() {
  return {
    mode: selectedMode(),
    researchGoal: `${selectedGoal()}. ${$("goalNotes").value.trim()}`.trim(),
    website: $("website").value,
    searchQuery: $("searchQuery").value,
    leadType: $("leadType").value,
    companyName: $("companyName").value,
    offering: $("offering").value,
    country: $("country").value,
    location: $("location").value,
    requestedFields: [...selectedFields(), ...customFields()],
    maxPages: Number($("maxPages").value),
    unlimited: selectedMode() === "discovery" && $("unlimited").checked,
    runHours: Number($("runHours").value),
    includeSearch: $("includeSearch").checked,
    useAgent: $("useAgent").checked,
    professionalEmailsOnly: $("professionalEmailsOnly").checked,
    individualEmailsOnly: $("individualEmailsOnly").checked,
    englishSchoolsOnly: $("englishSchoolsOnly").checked,
    educationRolesOnly: $("educationRolesOnly").checked,
    agentMaxCredits: Number($("agentMaxCredits").value),
  };
}

function showMain(view) {
  $("builderView").classList.toggle("hidden", view !== "builder");
  $("mapsView").classList.toggle("hidden", view !== "maps");
  $("loadingView").classList.toggle("hidden", view !== "loading");
  $("resultsView").classList.toggle("hidden", view !== "results");
  $("crmView").classList.toggle("hidden", view !== "crm");
  $("historySection").classList.toggle("hidden", view === "loading" || view === "crm" || view === "maps");
}

function updateProgress(progress = {}) {
  $("loadingTitle").textContent = progress.message || "Researching public sources…";
  const ratio = progress.total ? Math.min(90, 10 + (Number(progress.completed || 0) / Number(progress.total)) * 70) : progress.stage === "agent" ? 82 : 25;
  $("progressBar").style.width = `${progress.stage === "complete" ? 100 : ratio}%`;
  $("loadingDetail").textContent = progress.stage === "maps"
    ? `${progress.leadsSaved || 0} phone-qualified business leads saved · ${progress.googleRequests || 0} Google Places requests completed.`
    : progress.stage === "overnight"
    ? progress.emailLeadsSaved === undefined
      ? `${progress.leadsFound || 0} candidates held by the running job · ${progress.creditsUsed || 0} Firecrawl credits reported.`
      : `${progress.emailLeadsSaved || 0} email-qualified leads safely stored in the CRM · ${progress.leadsFound || 0} candidates checked · ${progress.creditsUsed || 0} Firecrawl credits reported.`
    : progress.stage === "agent" ? "AI synthesis is filling the requested fields and checking source evidence." : "The crawl continues in the background even when a website needs more time.";
}

async function pollJob(jobId) {
  activeJobId = jobId;
  sessionStorage.setItem("activeResearchJob", jobId);
  $("stopResearch").classList.remove("hidden");
  while (true) {
    let response;
    try {
      response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    } catch {
      updateProgress({ stage:"overnight", message:"Connection interrupted. Reconnecting to the running local job…" });
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }
    const job = await response.json();
    if (!response.ok) {
      sessionStorage.removeItem("activeResearchJob");
      throw new Error(job.error || "The server restarted. Open the CRM or Recent briefs to view the last automatic checkpoint.");
    }
    $("loadingEyebrow").textContent = job.mode === "maps" ? "Google Places is searching" : "Firecrawl is researching";
    $("stopResearch").classList.toggle("hidden", job.stoppable !== true);
    updateProgress(job.progress);
    if (job.status === "completed") {
      sessionStorage.removeItem("activeResearchJob");
      activeJobId = null;
      renderReport(job.result);
      loadHistory();
      return;
    }
    if (job.status === "failed") throw new Error(job.error || "Research failed.");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

$("researchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!validateStep()) return;
  const existingJob = sessionStorage.getItem("activeResearchJob");
  if (existingJob) {
    showMain("loading");
    await pollJob(existingJob).catch((error) => {
      sessionStorage.removeItem("activeResearchJob");
      showMain("builder");
      showStep(4);
      showError(error.message);
    });
    return;
  }
  showMain("loading");
  $("stopResearch").classList.toggle("hidden", !$("unlimited").checked);
  updateProgress({ message: "Preparing research tasks…", completed: 0, total: Number($("maxPages").value) });
  try {
    const health = await fetch("/api/health");
    if (!health.ok) throw new Error("The local server is not ready.");
    const response = await fetch("/api/research", {
      method: "POST",
      headers: { "Content-Type":"application/json", ...($("apiKey").value ? { "X-Firecrawl-Key":$("apiKey").value } : {}) },
      body: JSON.stringify(payload()),
    });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || "Research could not start.");
    await pollJob(job.id);
  } catch (error) {
    activeJobId = null;
    $("stopResearch").classList.add("hidden");
    showMain("builder");
    showStep(4);
    showError(error instanceof TypeError ? "Cannot reach the local server. Keep the PowerShell window running, then refresh this page and try again." : error.message);
  }
});

document.querySelectorAll("[data-map-category]").forEach((button) => button.addEventListener("click", () => {
  $("mapsBusinessType").value = button.dataset.mapCategory;
  $("mapsLeadType").value = button.dataset.mapType;
}));

$("mapsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const businessType = $("mapsBusinessType").value.trim();
  const leadType = $("mapsLeadType").value.trim();
  $("mapsError").classList.add("hidden");
  if (!businessType || !leadType) {
    $("mapsError").textContent = "Enter both a business category and a CRM lead type.";
    $("mapsError").classList.remove("hidden");
    return;
  }
  if (!googleMapsKeyConfigured && !$("mapsApiKey").value.trim()) {
    $("mapsError").textContent = "Enter a Google Maps API key with Places API (New) enabled.";
    $("mapsError").classList.remove("hidden");
    return;
  }
  $("loadingEyebrow").textContent = "Google Places is searching";
  showMain("loading");
  $("stopResearch").classList.remove("hidden");
  updateProgress({ stage: "maps", message: "Preparing Google Maps business searches", completed: 0, total: 1 });
  try {
    const response = await fetch("/api/maps/research", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...($("mapsApiKey").value ? { "X-Google-Maps-Key": $("mapsApiKey").value } : {}) },
      body: JSON.stringify({
        businessType,
        leadType,
        locations: $("mapsLocations").value,
        regionCode: $("mapsRegionCode").value,
        maxResults: Number($("mapsMaxResults").value),
        maxPagesPerLocation: Number($("mapsPages").value),
        phoneRequired: $("mapsPhoneRequired").checked,
      }),
    });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || "Google Maps research could not start.");
    await pollJob(job.id);
  } catch (error) {
    activeJobId = null;
    sessionStorage.removeItem("activeResearchJob");
    showMain("maps");
    $("mapsError").textContent = error instanceof TypeError ? "Cannot reach the local server. Reopen the desktop app and try again." : error.message;
    $("mapsError").classList.remove("hidden");
  }
});

$("stopResearch").addEventListener("click", async () => {
  if (!activeJobId) return;
  $("stopResearch").disabled = true;
  $("stopResearch").textContent = "Stopping after current request…";
  try {
    await fetch(`/api/jobs/${encodeURIComponent(activeJobId)}`, { method: "DELETE" });
  } finally {
    $("stopResearch").disabled = false;
  }
});

function list(items, empty = "No verified items returned.") {
  return items?.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p class="muted">${escapeHtml(empty)}</p>`;
}

function renderReport(report) {
  currentReport = report;
  const reportType = report.input?.leadType || "";
  const automaticallySaved = report.mode === "maps" || (report.mode === "discovery" && report.input?.unlimited === true);
  setTypeSelect($("saveLeadType"), reportType);
  if (["discovery", "maps"].includes(report.mode) && !crmTypes.length) {
    fetch("/api/crm/types").then((response) => response.json()).then((payload) => {
      crmTypes = payload.types || [];
      setTypeSelect($("saveLeadType"), reportType);
      const savedType = crmTypes.find((type) => type.name.toLowerCase() === reportType.toLowerCase());
      if (automaticallySaved && savedType) $("saveToCrm").textContent = `${savedType.count} ${reportType} in CRM`;
    }).catch(() => {});
  }
  $("saveToCrm").disabled = automaticallySaved;
  $("saveToCrm").textContent = automaticallySaved ? "Saved automatically to CRM" : "Save to CRM";
  $("saveLeadType").classList.toggle("hidden", report.mode !== "discovery");
  $("saveToCrm").classList.toggle("hidden", !["discovery", "maps"].includes(report.mode));
  $("stopResearch").classList.add("hidden");
  $("stopResearch").textContent = "Stop and save leads found";
  $("resultCompany").textContent = report.company?.name || "Prospect";
  $("resultSummary").textContent = report.company?.summary || "No company summary was returned.";
  $("resultScore").textContent = Number(report.qualification?.score || 0);
  $("scoreLabel").textContent = report.mode === "maps" ? "Phone coverage" : report.mode === "discovery" ? "Contact coverage" : "Evidence score";
  if (report.mode === "maps") {
    renderMapsReport(report);
    showMain("results");
    window.scrollTo({ top:0, behavior:"smooth" });
    return;
  }
  if (report.mode === "discovery") {
    renderDiscoveryReport(report);
    showMain("results");
    window.scrollTo({ top:0, behavior:"smooth" });
    return;
  }
  $("resultMeta").textContent = `${report.fieldResults?.length || 0} fields · ${report.usage?.pagesCrawled || 0} pages · ${report.qualification?.confidence || "Low"} confidence`;
  $("resultsTable").querySelector("thead").innerHTML = "<tr><th>Requested field</th><th>Result</th><th>Evidence</th><th>Source</th></tr>";
  $("resultsTable").querySelector("tbody").innerHTML = (report.fieldResults || []).map((row) => {
    const href = safeUrl(row.sourceUrl);
    return `<tr><td>${escapeHtml(row.field)}</td><td class="${row.found ? "" : "not-found"}">${escapeHtml(row.value)}</td><td>${escapeHtml(row.evidence || "—")}</td><td>${href ? `<a class="source-link" href="${href}" target="_blank" rel="noreferrer">Open source ↗</a>` : "—"}</td></tr>`;
  }).join("") || '<tr><td colspan="4" class="not-found">No requested fields were returned.</td></tr>';
  $("contactsResult").innerHTML = report.contacts?.length ? `<div class="table-scroll"><table><thead><tr><th>Name / role</th><th>Email / phone</th></tr></thead><tbody>${report.contacts.map((contact) => `<tr><td>${escapeHtml([contact.name,contact.role].filter(Boolean).join(" — ") || "Public contact")}</td><td>${escapeHtml([contact.email,contact.phone].filter(Boolean).join(" · ") || "—")}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">No public contacts found.</p>';
  $("nextStepsResult").innerHTML = list(report.nextSteps, "Review the evidence table and verify unknown fields before outreach.");
  $("warningsResult").innerHTML = list([...(report.warnings || []), ...(report.risksOrUnknowns || [])], "No processing warnings were returned. Verify all findings with the linked sources.");
  showMain("results");
  window.scrollTo({ top:0, behavior:"smooth" });
}

function renderMapsReport(report) {
  const leads = report.leads || [];
  $("resultSummary").textContent = `${leads.length} public business listings saved automatically to the ${report.input?.leadType || "selected"} CRM category. Listed numbers are not guaranteed to be mobile or owner-direct.`;
  $("resultMeta").textContent = `${leads.length} phone-qualified leads · ${report.usage?.locationsSearched || 0} areas · ${report.usage?.googleRequests || 0} API requests`;
  const columns = report.columns || [];
  $("resultsTable").querySelector("thead").innerHTML = `<tr>${columns.map((column) => `<th>${escapeHtml(column.field)}</th>`).join("")}</tr>`;
  $("resultsTable").querySelector("tbody").innerHTML = leads.length ? leads.map((lead) => `<tr>${columns.map((column) => {
    const value = lead[column.key];
    const href = ["website", "googleMapsUrl"].includes(column.key) ? safeUrl(value) : "";
    return `<td class="${value === "" || value === null || value === undefined ? "not-found" : ""}">${href ? `<a class="source-link" href="${href}" target="_blank" rel="noreferrer">Open ${column.key === "googleMapsUrl" ? "map" : "website"} ↗</a>` : escapeHtml(value ?? "Not found")}</td>`;
  }).join("")}</tr>`).join("") : '<tr><td colspan="7" class="not-found">No listings with public phone numbers were returned.</td></tr>';
  $("contactsResult").innerHTML = `<p><strong>${leads.filter((lead) => lead.phone).length}</strong> saved listings have a public business phone number. Open the CRM to track calls and feedback.</p>`;
  $("nextStepsResult").innerHTML = list(report.nextSteps);
  $("warningsResult").innerHTML = list(report.warnings, "Verify every listing before outreach.");
}

function renderDiscoveryReport(report) {
  const emailLeads = (report.leads || []).filter((lead) => String(lead.email || "").trim());
  $("resultSummary").textContent = `Showing ${emailLeads.length} leads with a public email address. Results without email are excluded.`;
  $("resultMeta").textContent = `${emailLeads.length} email-qualified leads`;
  const columns = report.columns || [];
  $("resultsTable").querySelector("thead").innerHTML = `<tr>${columns.map((column) => `<th>${escapeHtml(column.field)}</th>`).join("")}</tr>`;
  $("resultsTable").querySelector("tbody").innerHTML = emailLeads.length ? emailLeads.map((lead) => `<tr>${columns.map((column) => {
    const rawValue = column.key ? lead[column.key] : "";
    const cleanedValue = ["details", "subjectsServices"].includes(column.key) ? String(rawValue || "").replace(/!\[[^\]]*]\([^)]*\)/g, "").replace(/\[([^\]]+)]\([^)]*\)/g, "$1").replace(/[#*_`>|~-]/g, " ").replace(/\s+/g, " ").trim() : rawValue;
    const value = cleanedValue?.length > 500 ? `${cleanedValue.slice(0, 500)}…` : cleanedValue;
    const isUrl = column.key === "website" || column.key === "sourceUrl";
    const href = isUrl ? safeUrl(value) : "";
    return `<td class="${value ? "" : "not-found"}">${href ? `<a class="source-link" href="${href}" target="_blank" rel="noreferrer">${escapeHtml(value)} ↗</a>` : escapeHtml(value || "Not found")}</td>`;
  }).join("")}</tr>`).join("") : '<tr><td class="not-found">No email-qualified leads were returned.</td></tr>';
  $("contactsResult").innerHTML = `<p><strong>${emailLeads.length}</strong> leads include a public email address; ${emailLeads.filter((lead) => lead.phone).length} also include a phone number.</p>`;
  $("nextStepsResult").innerHTML = list(report.nextSteps);
  $("warningsResult").innerHTML = list([...(report.warnings || []), ...(report.risksOrUnknowns || [])], "No processing warnings returned. Verify contacts on their source pages.");
}

$("newResearch").addEventListener("click", () => { showMain("builder"); showStep(1); window.scrollTo({top:0,behavior:"smooth"}); });

$("saveToCrm").addEventListener("click", async () => {
  if (!currentReport?.id) return;
  const leadType = $("saveLeadType").value.trim();
  if (!leadType) return alert("Enter a lead type before saving.");
  const response = await fetch("/api/crm/import", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ reportId:currentReport.id, leadType }) });
  const result = await response.json();
  if (!response.ok) return alert(result.error || "Could not save leads.");
  $("saveToCrm").textContent = result.imported
    ? `${result.imported} added · ${result.skipped} already in CRM`
    : `${result.skipped} already saved in CRM`;
  await loadCrm();
});

$("openCrm").addEventListener("click", async () => { await loadCrm(); showMain("crm"); });
$("openMaps").addEventListener("click", () => { showMain("maps"); window.scrollTo({ top:0, behavior:"smooth" }); });
$("backFromMaps").addEventListener("click", () => showMain(currentReport ? "results" : "builder"));
$("backToResearch").addEventListener("click", () => showMain(currentReport ? "results" : "builder"));

async function loadCrm() {
  const [leadsResponse, typesResponse] = await Promise.all([fetch("/api/crm/leads"), fetch("/api/crm/types")]);
  if (!leadsResponse.ok || !typesResponse.ok) throw new Error("Could not load the local CRM.");
  crmLeads = (await leadsResponse.json()).leads || [];
  crmTypes = (await typesResponse.json()).types || [];
  const currentType = $("crmTypeFilter").value;
  setTypeSelect($("crmTypeFilter"), currentType, true);
  setTypeSelect($("editLeadType"), $("editLeadType").value);
  setTypeSelect($("saveLeadType"), currentReport?.mode === "discovery" ? ($("saveLeadType").value || currentReport.input?.leadType || "") : "");
  renderLeadTypes();
  renderCrm();
}

function renderLeadTypes() {
  $("leadTypeTable").querySelector("tbody").innerHTML = crmTypes.length ? crmTypes.map((type) => `<tr><td><strong>${escapeHtml(type.name)}</strong></td><td>${Number(type.count || 0)}</td><td><div class="type-actions"><button class="button secondary rename-type" data-name="${escapeHtml(type.name)}" type="button">Rename</button><button class="button secondary delete-type" data-name="${escapeHtml(type.name)}" type="button" ${type.count ? "disabled title=\"Move these leads to another type first\"" : ""}>Delete</button></div></td></tr>`).join("") : '<tr><td colspan="3" class="not-found">No lead types yet.</td></tr>';
}

function renderCrm() {
  const type = $("crmTypeFilter").value;
  const status = $("crmStatusFilter").value;
  const query = $("crmSearch").value.trim().toLowerCase();
  const leads = crmLeads.filter((lead) => (!type || lead.leadType === type) && (!status || lead.status === status) && (!query || `${lead.name} ${lead.role || ""} ${lead.organization || ""} ${lead.email} ${lead.phone || ""} ${lead.location || ""} ${lead.comments} ${lead.feedback}`.toLowerCase().includes(query)));
  $("crmMeta").textContent = `${leads.length} of ${crmLeads.length} leads`;
  $("crmTable").querySelector("tbody").innerHTML = leads.length ? leads.map((lead) => `<tr><td>${escapeHtml(lead.leadType)}</td><td><strong>${escapeHtml(lead.name)}</strong><br><small>${escapeHtml([lead.role, lead.organization, lead.location].filter(Boolean).join(" · "))}</small></td><td>${escapeHtml(lead.email)}<br><small>${escapeHtml(lead.phone || "")}</small></td><td><span class="status-chip">${escapeHtml(lead.status)}</span></td><td>${escapeHtml(lead.lastContactedAt || "—")}</td><td class="notes-cell">${escapeHtml(lead.feedback || lead.comments || "—")}</td><td><button class="button secondary edit-lead" data-id="${lead.id}" type="button">Edit</button></td></tr>`).join("") : '<tr><td colspan="7" class="not-found">No leads match these filters.</td></tr>';
}

[$("crmTypeFilter"), $("crmStatusFilter")].forEach((input) => input.addEventListener("change", renderCrm));
$("crmSearch").addEventListener("input", renderCrm);
$("leadTypeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("newLeadType").value.trim();
  if (!name) return;
  const response = await fetch("/api/crm/types", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ name }) });
  const result = await response.json();
  if (!response.ok) return alert(result.error || "Could not add this lead type.");
  $("newLeadType").value = "";
  await loadCrm();
});
$("leadTypeTable").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-name]");
  if (!button) return;
  const oldName = button.dataset.name;
  let response;
  if (button.classList.contains("rename-type")) {
    const newName = prompt("Rename this lead type:", oldName)?.trim();
    if (!newName || newName === oldName) return;
    response = await fetch("/api/crm/types", { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ oldName, newName }) });
  } else {
    if (!confirm(`Delete the unused lead type “${oldName}”?`)) return;
    response = await fetch("/api/crm/types", { method:"DELETE", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ name:oldName }) });
  }
  const result = await response.json();
  if (!response.ok) return alert(result.error || "Could not update this lead type.");
  await loadCrm();
});
$("crmTable").addEventListener("click", (event) => {
  const button = event.target.closest(".edit-lead"); if (!button) return;
  const lead = crmLeads.find((item) => item.id === button.dataset.id); if (!lead) return;
  $("editLeadId").value = lead.id; $("editLeadName").textContent = lead.name; setTypeSelect($("editLeadType"), lead.leadType);
  $("editLeadStatus").value = lead.status; $("editLastContact").value = lead.lastContactedAt; $("editFeedback").value = lead.feedback; $("editComments").value = lead.comments;
  $("leadDialog").showModal();
});
$("leadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const response = await fetch(`/api/crm/leads/${encodeURIComponent($("editLeadId").value)}`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ leadType:$("editLeadType").value, status:$("editLeadStatus").value, lastContactedAt:$("editLastContact").value, feedback:$("editFeedback").value, comments:$("editComments").value }) });
  if (!response.ok) return alert("Could not update this lead.");
  $("leadDialog").close(); await loadCrm();
});
document.querySelectorAll(".close-dialog").forEach((button) => button.addEventListener("click", () => $("leadDialog").close()));

async function loadHistory() {
  try {
    const response = await fetch("/api/reports");
    const { reports } = await response.json();
    $("historyList").innerHTML = reports?.length ? reports.map((report) => `<button class="history-item" type="button" data-id="${escapeHtml(report.id)}"><span><b>${escapeHtml(report.companyName || "Untitled prospect")}</b><small>${escapeHtml(report.website || "")}</small></span><time>${escapeHtml(new Date(report.generatedAt).toLocaleDateString())}</time><strong>${Number(report.score || 0)}/100</strong></button>`).join("") : '<p class="muted">No saved reports yet.</p>';
  } catch { $("historyList").innerHTML = '<p class="muted">Could not load local reports.</p>'; }
}

$("historyList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-id]"); if (!button) return;
  const response = await fetch(`/api/reports/${encodeURIComponent(button.dataset.id)}`);
  if (response.ok) renderReport(await response.json());
});

function download(name, content, type) { const link=document.createElement("a"); link.href=URL.createObjectURL(new Blob([content],{type})); link.download=name; link.click(); URL.revokeObjectURL(link.href); }
const slug = () => (currentReport?.company?.name || "prospect").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
$("exportJson").addEventListener("click", () => currentReport && download(`${slug()}-brief.json`,JSON.stringify(currentReport,null,2),"application/json"));
$("exportCsv").addEventListener("click", () => {
  if(!currentReport)return;
  const q=(value="")=>`"${String(value).replaceAll('"','""')}"`;
  const rows=currentReport.mode==="maps"
    ? [[...(currentReport.columns||[]).map((column)=>column.field)],...(currentReport.leads||[]).map((lead)=>(currentReport.columns||[]).map((column)=>lead[column.key]??""))]
    : currentReport.mode==="discovery"
    ? [[...(currentReport.columns||[]).map((column)=>column.field)],...(currentReport.leads||[]).filter((lead)=>String(lead.email||"").trim()).map((lead)=>(currentReport.columns||[]).map((column)=>column.key?lead[column.key]:""))]
    : [["Field","Result","Evidence","Source"],...(currentReport.fieldResults||[]).map((row)=>[row.field,row.value,row.evidence,row.sourceUrl])];
  download(`${slug()}-results.csv`,rows.map((row)=>row.map(q).join(",")).join("\r\n"),"text/csv");
});
$("exportMarkdown").addEventListener("click", () => {
  if(!currentReport)return;
  const lines=currentReport.mode==="maps"
    ? [`# ${currentReport.company.name}`,"",currentReport.company.summary,"",...(currentReport.leads||[]).flatMap((lead)=>[`## ${lead.name}`,"",`Category: ${lead.role||"Not found"}`,`Phone: ${lead.phone||"Not found"}`,`Address: ${lead.location||"Not found"}`,`Website: ${lead.website||"Not found"}`,`Google Maps: ${lead.googleMapsUrl||"Not found"}`,""])]
    : currentReport.mode==="discovery"
    ? [`# ${currentReport.company.name}`,"",currentReport.company.summary,"",...(currentReport.leads||[]).filter((lead)=>String(lead.email||"").trim()).flatMap((lead)=>[`## ${lead.name}`,"",lead.details||"",`Phone: ${lead.phone||"Not found"}`,`Email: ${lead.email}`,`Website: ${lead.website||"Not found"}`,`Source: ${lead.sourceUrl||"Not found"}`,""])]
    : [`# ${currentReport.company.name} — Sales Brief`,``,`Website: ${currentReport.company.website}`,`Evidence score: ${currentReport.qualification.score}/100`,``,`## Requested results`,``,...(currentReport.fieldResults||[]).flatMap((row)=>[`### ${row.field}`,``,row.value,``,row.evidence?`Evidence: ${row.evidence}`:"",row.sourceUrl?`Source: ${row.sourceUrl}`:"",``])];
  download(`${slug()}-brief.md`,lines.join("\n"),"text/markdown");
});

fetch("/api/health").then((response)=>response.json()).then((health)=>{ apiKeyConfigured=health.apiKeyConfigured; googleMapsKeyConfigured=health.googleMapsKeyConfigured; $("keyStatus").textContent=health.apiKeyConfigured?"Firecrawl configured":"Firecrawl key entered at final step"; document.querySelector(".api-status i").classList.toggle("ready",health.apiKeyConfigured); $("apiKeyField").classList.toggle("hidden",health.apiKeyConfigured); $("mapsApiKeyField").classList.toggle("hidden",health.googleMapsKeyConfigured); }).catch(()=>{$("keyStatus").textContent="Local server unavailable";});
loadHistory();
syncModeUi();
async function resumeActiveJob() {
  let activeJob = sessionStorage.getItem("activeResearchJob");
  if (!activeJob) {
    try {
      const response = await fetch("/api/jobs");
      if (response.ok) activeJob = (await response.json()).jobs?.[0]?.id;
    } catch {}
  }
  if (!activeJob) return;
  showMain("loading");
  $("stopResearch").classList.remove("hidden");
  pollJob(activeJob).catch((error) => {
    sessionStorage.removeItem("activeResearchJob");
    showMain("builder");
    showStep(4);
    showError(error.message);
    loadHistory();
  });
}
resumeActiveJob();
