const $ = (id) => document.getElementById(id);
let step = 1;
let currentReport = null;
let apiKeyConfigured = false;
let googleMapsKeyConfigured = false;
let hostedServerless = false;
let activeJobId = null;
let crmLeads = [];
let crmTypes = [];
let signedInUser = null;
let filteredCrmLeads = [];
let crmPage = 1;
let leadMapLeads = [];
let leadMap = null;
let leadMapInfoWindow = null;
let leadMapMarkers = [];
let googleMapsPromise = null;
const crmPageSize = 100;

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[char]);
const safeUrl = (value = "") => { try { const url = new URL(value); return ["http:","https:"].includes(url.protocol) ? escapeHtml(url.href) : ""; } catch { return ""; } };
async function apiPayload(response, fallbackMessage) {
  const text = await response.text();
  if (!text) {
    if (!response.ok) throw new Error(`${fallbackMessage} (HTTP ${response.status})`);
    return {};
  }
  try { return JSON.parse(text); }
  catch {
    if (response.status >= 500) throw new Error("The hosted request timed out or was interrupted. Reduce the scope and try again.");
    throw new Error(response.ok ? fallbackMessage : `Server request failed (HTTP ${response.status}).`);
  }
}
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
  $("unlimitedOption").classList.toggle("hidden", !discovery || hostedServerless);
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
    unlimited: selectedMode() === "discovery" && $("unlimited").checked && !hostedServerless,
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
  $("loginView").classList.toggle("hidden", view !== "login");
  $("builderView").classList.toggle("hidden", view !== "builder");
  $("mapsView").classList.toggle("hidden", view !== "maps");
  $("loadingView").classList.toggle("hidden", view !== "loading");
  $("resultsView").classList.toggle("hidden", view !== "results");
  $("crmView").classList.toggle("hidden", view !== "crm");
  $("leadMapView").classList.toggle("hidden", view !== "leadMap");
  $("usersView").classList.toggle("hidden", view !== "users");
  $("historySection").classList.toggle("hidden", !signedInUser || view === "loading" || view === "crm" || view === "leadMap" || view === "maps" || view === "users" || view === "login");
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
    const job = await apiPayload(response, "Could not read the research job response.");
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
  if (hostedServerless && $("unlimited").checked) { $("unlimited").checked = false; syncUnlimitedUi(); }
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
    const job = await apiPayload(response, "Could not read the research response.");
    if (!response.ok) throw new Error(job.error || "Research could not start.");
    if (job.status === "completed") { renderReport(job.result); await loadHistory(); }
    else if (job.status === "failed") throw new Error(job.error || "Research failed.");
    else await pollJob(job.id);
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
        mobileOnly: $("mapsMobileOnly").checked,
      }),
    });
    const job = await apiPayload(response, "Could not read the Google Maps response.");
    if (!response.ok) throw new Error(job.error || "Google Maps research could not start.");
    if (job.status === "completed") { renderReport(job.result); await loadHistory(); }
    else if (job.status === "failed") throw new Error(job.error || "Google Maps research failed.");
    else await pollJob(job.id);
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

function showLeadMapError(message) {
  $("leadMapError").textContent = message;
  $("leadMapError").classList.toggle("hidden", !message);
}

function filteredLeadMapLeads() {
  const type = $("leadMapTypeFilter").value;
  const status = $("leadMapStatusFilter").value;
  const query = $("leadMapSearch").value.trim().toLowerCase();
  return leadMapLeads.filter((lead) => (!type || lead.leadType === type)
    && (!status || lead.status === status)
    && (!query || `${lead.name || ""} ${lead.location || ""} ${lead.phone || ""} ${lead.email || ""}`.toLowerCase().includes(query)));
}

function loadGoogleMaps() {
  if (window.google?.maps?.importLibrary) return Promise.resolve(window.google.maps);
  if (googleMapsPromise) return googleMapsPromise;
  googleMapsPromise = fetch("/api/maps/browser-config").then(async (response) => {
    const config = await response.json();
    if (!response.ok || !config.apiKey) throw new Error("Lead Map needs a browser-restricted Google Maps key. Add GOOGLE_MAPS_BROWSER_API_KEY in Vercel.");
    return new Promise((resolve, reject) => {
      const callback = `initLeadMap_${Date.now()}`;
      const script = document.createElement("script");
      const timeout = window.setTimeout(() => reject(new Error("Google Maps took too long to load.")), 20_000);
      window[callback] = () => {
        window.clearTimeout(timeout);
        delete window[callback];
        resolve(window.google.maps);
      };
      window.gm_authFailure = () => showLeadMapError("Google Maps could not authenticate. Enable Maps JavaScript API and restrict the browser key to this website.");
      script.async = true;
      script.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("Google Maps could not load."));
      };
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(config.apiKey)}&callback=${callback}&loading=async&v=weekly`;
      document.head.append(script);
    });
  }).catch((error) => {
    googleMapsPromise = null;
    throw error;
  });
  return googleMapsPromise;
}

function worldPixel(latitude, longitude, zoom) {
  const size = 256 * (2 ** zoom);
  const sine = Math.max(-0.9999, Math.min(0.9999, Math.sin(latitude * Math.PI / 180)));
  return { x:(longitude + 180) / 360 * size, y:(0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * size };
}

function leadMapClusters(leads) {
  const zoom = leadMap.getZoom() || 5;
  const bounds = leadMap.getBounds();
  const cellSize = zoom >= 15 ? 28 : 64;
  const groups = new Map();
  for (const lead of leads) {
    const position = { lat:Number(lead.latitude), lng:Number(lead.longitude) };
    if (bounds && !bounds.contains(position)) continue;
    const pixel = worldPixel(position.lat, position.lng, zoom);
    const key = `${Math.floor(pixel.x / cellSize)}:${Math.floor(pixel.y / cellSize)}`;
    const group = groups.get(key) || { latitude:0, longitude:0, leads:[] };
    group.latitude += position.lat;
    group.longitude += position.lng;
    group.leads.push(lead);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    leads:group.leads,
    position:{ lat:group.latitude / group.leads.length, lng:group.longitude / group.leads.length },
  }));
}

function leadMapInfo(cluster) {
  const items = cluster.leads.slice(0, 8).map((lead) => {
    const mapsUrl = safeUrl(lead.googleMapsUrl);
    return `<div class="map-info-item"><h3>${escapeHtml(lead.name)}</h3><p>${escapeHtml(lead.leadType)} · ${escapeHtml(lead.status || "New")}</p><p>${escapeHtml(lead.location || "Location not supplied")}</p>${lead.phone ? `<p><a href="tel:${escapeHtml(lead.phone.replace(/[^+\d]/g, ""))}">${escapeHtml(lead.phone)}</a></p>` : ""}${mapsUrl ? `<a href="${mapsUrl}" target="_blank" rel="noopener">Open in Google Maps</a>` : ""}</div>`;
  }).join("");
  const more = cluster.leads.length > 8 ? `<p class="map-info-more">+${cluster.leads.length - 8} more leads in this cluster</p>` : "";
  return `<div class="map-info"><div class="map-info-list">${items}</div>${more}</div>`;
}

function renderLeadMapMarkers() {
  if (!leadMap || !window.google?.maps) return;
  leadMapMarkers.forEach((marker) => marker.setMap(null));
  leadMapMarkers = [];
  const clusters = leadMapClusters(filteredLeadMapLeads());
  for (const cluster of clusters) {
    const count = cluster.leads.length;
    const marker = new google.maps.Marker({
      map:leadMap,
      position:cluster.position,
      title:count === 1 ? cluster.leads[0].name : `${count} leads`,
      label:count > 1 ? { text:String(count), color:"#ffffff", fontSize:"11px", fontWeight:"700" } : undefined,
      icon:{ path:google.maps.SymbolPath.CIRCLE, scale:Math.min(24, count === 1 ? 7 : 10 + Math.log2(count) * 2), fillColor:"#0d6849", fillOpacity:.92, strokeColor:"#ffffff", strokeWeight:2 },
    });
    marker.addListener("click", () => {
      if (count > 1 && (leadMap.getZoom() || 5) < 15) {
        const bounds = new google.maps.LatLngBounds();
        cluster.leads.forEach((lead) => bounds.extend({ lat:Number(lead.latitude), lng:Number(lead.longitude) }));
        leadMap.fitBounds(bounds, 55);
      } else {
        leadMapInfoWindow.setContent(leadMapInfo(cluster));
        leadMapInfoWindow.open({ map:leadMap, anchor:marker });
      }
    });
    leadMapMarkers.push(marker);
  }
  $("leadMapCanvas").dataset.markerCount = String(clusters.length);
}

function updateLeadMapMeta() {
  const leads = filteredLeadMapLeads();
  $("leadMapCount").textContent = leads.length.toLocaleString();
  $("leadMapMeta").textContent = `${leads.length.toLocaleString()} of ${leadMapLeads.length.toLocaleString()} leads have saved Google coordinates`;
  return leads;
}

function fitLeadMapToResults() {
  const leads = updateLeadMapMeta();
  if (!leadMap || !leads.length) return renderLeadMapMarkers();
  if (leads.length === 1) {
    leadMap.setCenter({ lat:Number(leads[0].latitude), lng:Number(leads[0].longitude) });
    leadMap.setZoom(14);
    return;
  }
  const bounds = new google.maps.LatLngBounds();
  leads.forEach((lead) => bounds.extend({ lat:Number(lead.latitude), lng:Number(lead.longitude) }));
  leadMap.fitBounds(bounds, 45);
}

async function loadLeadMap() {
  showLeadMapError("");
  $("leadMapMeta").textContent = "Loading saved Google coordinates…";
  const [leadsResponse, typesResponse] = await Promise.all([fetch("/api/crm/map-leads"), fetch("/api/crm/types")]);
  if (!leadsResponse.ok || !typesResponse.ok) throw new Error("Could not load mapped CRM leads.");
  leadMapLeads = (await leadsResponse.json()).leads || [];
  crmTypes = (await typesResponse.json()).types || crmTypes;
  setTypeSelect($("leadMapTypeFilter"), $("leadMapTypeFilter").value, true);
  updateLeadMapMeta();
  await loadGoogleMaps();
  const { Map:GoogleMap, InfoWindow } = await google.maps.importLibrary("maps");
  if (!leadMap) {
    leadMap = new GoogleMap($("leadMapCanvas"), { center:{ lat:-30.5595, lng:22.9375 }, zoom:5, mapTypeControl:false, streetViewControl:false, fullscreenControl:true });
    leadMapInfoWindow = new InfoWindow();
    leadMap.addListener("idle", renderLeadMapMarkers);
  }
  fitLeadMapToResults();
}

$("openLeadMap").addEventListener("click", async () => {
  showMain("leadMap");
  $("openLeadMap").disabled = true;
  try { await loadLeadMap(); }
  catch (error) { showLeadMapError(error.message); }
  finally { $("openLeadMap").disabled = false; }
});
$("backFromLeadMap").addEventListener("click", () => showMain("crm"));
[$("leadMapTypeFilter"), $("leadMapStatusFilter")].forEach((input) => input.addEventListener("change", fitLeadMapToResults));
$("leadMapSearch").addEventListener("input", fitLeadMapToResults);
$("fitLeadMap").addEventListener("click", fitLeadMapToResults);

$("openCrm").addEventListener("click", async () => {
  showMain("crm");
  $("crmMeta").textContent = "Loading leads…";
  $("crmTable").querySelector("tbody").innerHTML = '<tr><td colspan="8" class="muted">Loading CRM leads from Neon…</td></tr>';
  $("openCrm").disabled = true;
  try { await loadCrm(); }
  catch (error) { $("crmMeta").textContent = "Could not load leads"; alert(error.message); }
  finally { $("openCrm").disabled = false; }
});
$("openMaps").addEventListener("click", () => { showMain("maps"); window.scrollTo({ top:0, behavior:"smooth" }); });
$("backFromMaps").addEventListener("click", () => showMain(currentReport ? "results" : "builder"));
$("backToResearch").addEventListener("click", () => showMain(signedInUser?.role === "admin" ? (currentReport ? "results" : "builder") : "crm"));

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

function feedbackHistoryFor(lead) {
  const history = Array.isArray(lead.feedbackHistory) ? [...lead.feedbackHistory] : [];
  const legacy = String(lead.feedback || "").trim();
  if (legacy && !history.some((entry) => String(entry.text || "").trim() === legacy)) {
    history.push({ text: legacy, author: "Previous CRM entry", createdAt: lead.updatedAt || lead.createdAt || "", status: lead.status });
  }
  return history.filter((entry) => String(entry.text || "").trim()).sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function renderFeedbackHistory(lead) {
  const history = feedbackHistoryFor(lead);
  $("feedbackHistoryCount").textContent = `${history.length} ${history.length === 1 ? "entry" : "entries"}`;
  $("feedbackHistory").innerHTML = history.length ? history.map((entry) => {
    const date = entry.createdAt ? new Date(entry.createdAt) : null;
    const formattedDate = date && !Number.isNaN(date.getTime()) ? date.toLocaleString("en-ZA", { dateStyle:"medium", timeStyle:"short" }) : "Date unavailable";
    return `<article class="feedback-entry"><div><strong>${escapeHtml(entry.author || "Unknown user")}</strong><time>${escapeHtml(formattedDate)}</time>${entry.status ? `<span>${escapeHtml(entry.status)}</span>` : ""}</div><p>${escapeHtml(entry.text)}</p></article>`;
  }).join("") : '<p class="feedback-empty">No feedback recorded yet.</p>';
}

function renderCrm() {
  const type = $("crmTypeFilter").value;
  const status = $("crmStatusFilter").value;
  const followUp = $("crmFollowUpFilter").value;
  const sort = $("crmSort").value;
  const query = $("crmSearch").value.trim().toLowerCase();
  const localNow = new Date();
  const today = new Date(localNow.getTime() - localNow.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const week = new Date(localNow.getTime() - localNow.getTimezoneOffset() * 60_000 + 7 * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const dueMatch = (lead) => !followUp
    || (followUp === "none" && !lead.nextFollowUpAt)
    || (followUp === "scheduled" && Boolean(lead.nextFollowUpAt))
    || (followUp === "overdue" && lead.nextFollowUpAt && lead.nextFollowUpAt < today && !["Won", "Not interested"].includes(lead.status))
    || (followUp === "today" && lead.nextFollowUpAt === today)
    || (followUp === "week" && lead.nextFollowUpAt >= today && lead.nextFollowUpAt <= week);
  const leads = crmLeads.filter((lead) => (!type || lead.leadType === type) && (!status || lead.status === status) && dueMatch(lead) && (!query || `${lead.name} ${lead.role || ""} ${lead.organization || ""} ${lead.email} ${lead.phone || ""} ${lead.location || ""} ${lead.services || ""} ${lead.assignedTo || ""} ${lead.comments || ""} ${lead.feedback || ""} ${feedbackHistoryFor(lead).map((entry) => entry.text).join(" ")}`.toLowerCase().includes(query)));
  leads.sort((left, right) => sort === "name" ? left.name.localeCompare(right.name) : sort === "newest" ? String(right.createdAt || "").localeCompare(String(left.createdAt || "")) : String(left.nextFollowUpAt || "9999").localeCompare(String(right.nextFollowUpAt || "9999")));
  filteredCrmLeads = leads;
  const pageCount = Math.max(1, Math.ceil(leads.length / crmPageSize));
  crmPage = Math.min(crmPage, pageCount);
  const visibleLeads = leads.slice((crmPage - 1) * crmPageSize, crmPage * crmPageSize);
  const activeFilters = [type, status, followUp, query].filter(Boolean);
  const overdue = leads.filter((lead) => lead.nextFollowUpAt && lead.nextFollowUpAt < today && !["Won", "Not interested"].includes(lead.status)).length;
  const dueWeek = leads.filter((lead) => lead.nextFollowUpAt >= today && lead.nextFollowUpAt <= week).length;
  $("crmSummary").innerHTML = [[activeFilters.length ? "Filtered leads" : "Total leads",leads.length,""],["New",leads.filter((lead)=>lead.status==="New").length,""],["To contact",leads.filter((lead)=>lead.status==="To contact").length,""],["Overdue",overdue,"alert"],["Due in 7 days",dueWeek,""]].map(([label,value,className])=>`<div class="summary-card ${className}"><strong>${value}</strong><span>${label}</span></div>`).join("");
  $("crmFilterState").textContent = activeFilters.length ? `Active: ${[type, status, followUp, query && `Search “${query}”`].filter(Boolean).join(" · ")}` : "All leads";
  $("clearCrmFilters").classList.toggle("hidden", activeFilters.length === 0);
  $("crmMeta").textContent = `${leads.length} of ${crmLeads.length} leads`;
  $("crmPageMeta").textContent = `Page ${crmPage} of ${pageCount}`;
  $("crmPrevious").disabled = crmPage <= 1; $("crmNext").disabled = crmPage >= pageCount;
  $("crmPagination").classList.toggle("hidden", leads.length <= crmPageSize);
  $("crmTable").querySelector("tbody").innerHTML = visibleLeads.length ? visibleLeads.map((lead) => `<tr><td>${escapeHtml(lead.leadType)}</td><td><strong>${escapeHtml(lead.name)}</strong><br><small>${escapeHtml([lead.role, lead.organization, lead.location, lead.services && `Subjects/services: ${lead.services}`].filter(Boolean).join(" · "))}</small></td><td>${escapeHtml(lead.email || "—")}<br><small>${escapeHtml(lead.phone || "")}</small></td><td><span class="status-chip">${escapeHtml(lead.status)}</span><br><span class="priority-chip ${String(lead.priority || "Normal").toLowerCase()}">${escapeHtml(lead.priority || "Normal")}</span></td><td class="${lead.nextFollowUpAt && lead.nextFollowUpAt < today ? "followup-overdue" : ""}">${escapeHtml(lead.nextFollowUpAt || "—")}</td><td>${escapeHtml(lead.assignedTo || "Unassigned")}</td><td class="notes-cell">${escapeHtml(lead.feedback || lead.comments || "—")}</td><td><button class="button secondary edit-lead" data-id="${lead.id}" type="button">Edit</button></td></tr>`).join("") : '<tr><td colspan="8" class="not-found">No leads match these filters.</td></tr>';
}

[$("crmTypeFilter"), $("crmStatusFilter"), $("crmFollowUpFilter"), $("crmSort")].forEach((input) => input.addEventListener("change", () => { crmPage = 1; renderCrm(); }));
$("crmSearch").addEventListener("input", () => { crmPage = 1; renderCrm(); });
$("clearCrmFilters").addEventListener("click", () => { $("crmTypeFilter").value = ""; $("crmStatusFilter").value = ""; $("crmFollowUpFilter").value = ""; $("crmSearch").value = ""; crmPage = 1; renderCrm(); });
$("crmPrevious").addEventListener("click", () => { crmPage = Math.max(1, crmPage - 1); renderCrm(); window.scrollTo({ top:$("crmTable").offsetTop - 100, behavior:"smooth" }); });
$("crmNext").addEventListener("click", () => { crmPage += 1; renderCrm(); window.scrollTo({ top:$("crmTable").offsetTop - 100, behavior:"smooth" }); });
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
  $("editLeadStatus").value = lead.status; $("editPriority").value = lead.priority || "Normal"; $("editAssignedTo").value = lead.assignedTo || ""; $("editLastContact").value = lead.lastContactedAt; $("editNextFollowUp").value = lead.nextFollowUpAt || ""; $("editServices").value = lead.services || ""; $("editFeedback").value = ""; $("editComments").value = lead.comments;
  renderFeedbackHistory(lead);
  $("leadDialog").showModal();
});
$("leadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const response = await fetch(`/api/crm/leads/${encodeURIComponent($("editLeadId").value)}`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ leadType:$("editLeadType").value, status:$("editLeadStatus").value, priority:$("editPriority").value, assignedTo:$("editAssignedTo").value, lastContactedAt:$("editLastContact").value, nextFollowUpAt:$("editNextFollowUp").value, services:$("editServices").value, feedbackEntry:$("editFeedback").value, comments:$("editComments").value }) });
  if (!response.ok) return alert("Could not update this lead.");
  $("leadDialog").close(); await loadCrm();
});
document.querySelectorAll(".close-dialog").forEach((button) => button.addEventListener("click", () => $("leadDialog").close()));
$("deleteLead").addEventListener("click", async () => {
  if (!confirm("Permanently delete this lead?")) return;
  const response = await fetch(`/api/crm/leads/${encodeURIComponent($("editLeadId").value)}`, { method:"DELETE" });
  if (!response.ok) return alert("Could not delete this lead.");
  $("leadDialog").close(); await loadCrm();
});

$("exportCrm").addEventListener("click", () => {
  const quote = (value="") => `"${String(value).replaceAll('"','""')}"`;
  const fields = ["leadType","name","email","phone","services","status","priority","assignedTo","nextFollowUpAt","lastContactedAt","location","website","feedback","feedbackHistory","comments"];
  const csv = [fields, ...filteredCrmLeads.map((lead) => fields.map((field) => field === "feedbackHistory" ? feedbackHistoryFor(lead).map((entry) => `${entry.createdAt || ""} | ${entry.author || ""} | ${entry.status || ""} | ${entry.text}`).join("\n") : lead[field] || ""))].map((row) => row.map(quote).join(",")).join("\r\n");
  download("crm-leads.csv", csv, "text/csv");
});

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

function applyUser(user) {
  signedInUser = user;
  const admin = user?.role === "admin";
  document.querySelectorAll(".admin-only").forEach((element) => element.classList.toggle("hidden", !admin));
  $("logoutButton").classList.toggle("hidden", !user);
  $("backToResearch").textContent = admin ? "Back to research" : "Back to CRM";
}

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("loginError").classList.add("hidden");
  const response = await fetch("/api/auth/login", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ email:$("loginEmail").value, password:$("loginPassword").value }) });
  const payload = await response.json();
  if (!response.ok) { $("loginError").textContent = payload.error || "Sign in failed."; $("loginError").classList.remove("hidden"); return; }
  $("loginPassword").value = "";
  applyUser(payload.user);
  await initializeWorkspace();
});

$("logoutButton").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method:"POST" });
  signedInUser = null; currentReport = null; crmLeads = []; crmTypes = [];
  applyUser(null); showMain("login");
});

async function loadUsers() {
  const response = await fetch("/api/users");
  if (!response.ok) return;
  const { users } = await response.json();
  $("usersMeta").textContent = `${users.length} users`;
  $("usersTable").querySelector("tbody").innerHTML = users.map((user) => `<tr><td>${escapeHtml(user.email)}</td><td><select class="user-role" data-id="${user.id}"><option value="sales" ${user.role === "sales" ? "selected" : ""}>Sales</option><option value="admin" ${user.role === "admin" ? "selected" : ""}>Admin</option></select></td><td><span class="status-chip">${user.active ? "Active" : "Disabled"}</span></td><td>${escapeHtml(user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—")}</td><td><div class="type-actions"><button class="button secondary toggle-user" data-id="${user.id}" data-active="${user.active}" type="button">${user.active ? "Disable" : "Enable"}</button><button class="button secondary reset-user" data-id="${user.id}" type="button">Reset password</button></div></td></tr>`).join("");
}

$("openUsers").addEventListener("click", async () => { await loadUsers(); showMain("users"); });
$("backFromUsers").addEventListener("click", () => showMain("builder"));
$("userForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const response = await fetch("/api/users", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ email:$("newUserEmail").value, password:$("newUserPassword").value, role:$("newUserRole").value }) });
  const payload = await response.json();
  if (!response.ok) return alert(payload.error || "Could not add this user.");
  $("userForm").reset(); await loadUsers();
});
$("usersTable").addEventListener("change", async (event) => {
  if (!event.target.classList.contains("user-role")) return;
  const response = await fetch(`/api/users/${event.target.dataset.id}`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ role:event.target.value }) });
  if (!response.ok) alert("Could not change this role.");
  await loadUsers();
});
$("usersTable").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-id]"); if (!button) return;
  let changes;
  if (button.classList.contains("toggle-user")) changes = { active:button.dataset.active !== "true" };
  else { const password = prompt("Enter a new password (at least 10 characters):"); if (!password) return; changes = { password }; }
  const response = await fetch(`/api/users/${button.dataset.id}`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify(changes) });
  const payload = await response.json();
  if (!response.ok) return alert(payload.error || "Could not update this user.");
  await loadUsers();
});

async function initializeWorkspace() {
  const healthResponse = await fetch("/api/health");
  if (healthResponse.ok) {
    const health = await healthResponse.json();
    apiKeyConfigured = health.apiKeyConfigured; googleMapsKeyConfigured = health.googleMapsKeyConfigured; hostedServerless = health.serverless === true;
    $("keyStatus").textContent = health.apiKeyConfigured ? "Firecrawl configured" : "Firecrawl key entered at final step";
    document.querySelector(".api-status i").classList.toggle("ready", health.apiKeyConfigured);
    $("apiKeyField").classList.toggle("hidden", health.apiKeyConfigured); $("mapsApiKeyField").classList.toggle("hidden", health.googleMapsKeyConfigured);
    if (hostedServerless) { $("unlimited").checked = false; $("unlimitedOption").classList.add("hidden"); syncUnlimitedUi(); }
  }
  syncModeUi();
  await loadHistory();
  if (signedInUser.role === "admin") { showMain("builder"); await resumeActiveJob(); }
  else { await loadCrm(); showMain("crm"); }
}

async function initializeAuth() {
  try {
    const response = await fetch("/api/auth/me");
    if (!response.ok) throw new Error();
    applyUser((await response.json()).user);
    await initializeWorkspace();
  } catch { applyUser(null); showMain("login"); }
}

initializeAuth();
