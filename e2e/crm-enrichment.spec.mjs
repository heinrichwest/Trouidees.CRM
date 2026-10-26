import { test, expect } from "@playwright/test";

const adminId = "11111111-1111-4111-8111-111111111111";
const leads = Array.from({ length:101 }, (_, i) => ({
  id:`00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  leadType:"Tutors", name:`Tutor ${String(i + 1).padStart(3, "0")}`, email:`tutor${i + 1}@example.test`,
  phone:"+27820000000", status:"New", priority:"Normal", createdAt:new Date().toISOString(),
}));

test("admin selects a batch and resumes saved results without reprocessing completed leads", async ({ page }) => {
  const calls = [];
  const batches = new Map();
  let loseCreate = true;
  let loseFirstProcess = true;
  const operationKeys = [];
  const savedOperations = new Map();
  const processedLeadIds = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    if (url.pathname === "/api/auth/me") return route.fulfill({ json:{ user:{ id:adminId, role:"admin", active:true } } });
    if (url.pathname === "/api/health") return route.fulfill({ json:{ apiKeyConfigured:true, googleMapsKeyConfigured:false } });
    if (url.pathname === "/api/reports") return route.fulfill({ json:{ reports:[] } });
    if (url.pathname === "/api/crm/leads") return route.fulfill({ json:{ leads } });
    if (url.pathname === "/api/crm/types") return route.fulfill({ json:{ types:[{ name:"Tutors", count:101 }] } });
    if (url.pathname === "/api/crm/enrichment-batches" && method === "GET") return route.fulfill({ json:{ batches:[...batches.values()] } });
    if (url.pathname === "/api/crm/enrichment-batches" && method === "POST") {
      const body = req.postDataJSON(); calls.push({ type:"create", ...body });
      const batch = batches.get(body.requestKey) || {
        id:"22222222-2222-4222-8222-222222222222", requestKey:body.requestKey, leadIds:body.leadIds, status:"queued",
        counts:{ queued:body.leadIds.length, running:0, ready:0, needs_review:0, failed:0, interrupted:0 },
        items:body.leadIds.map((leadId) => ({ leadId, state:"queued", lead:leads.find((lead) => lead.id === leadId) })),
      };
      batches.set(body.requestKey, batch);
      if (loseCreate) { loseCreate = false; return route.abort("failed"); }
      return route.fulfill({ status:202, json:{ batch } });
    }
    const detail = url.pathname.match(/\/api\/crm\/enrichment-batches\/([^/]+)$/);
    if (detail && method === "GET") return route.fulfill({ json:{ batch:[...batches.values()].find((batch) => batch.id === detail[1]) } });
    const process = url.pathname.match(/\/api\/crm\/enrichment-batches\/([^/]+)\/process-next$/);
    if (process) {
      const body = req.postDataJSON(); operationKeys.push(body.operationKey); calls.push({ type:"process", operationKey:body.operationKey });
      const batch = [...batches.values()].find((item) => item.id === process[1]);
      if (savedOperations.has(body.operationKey)) return route.fulfill({ json:{ batch } });
      const queued = batch.items.find((item) => item.state === "queued");
      if (queued) {
        processedLeadIds.push(queued.leadId);
        queued.state = queued.leadId === leads[100].id ? "needs_review" : "ready"; queued.creditsUsed = 3;
        queued.report = { sources:[{ url:"https://example.test/source" }] };
        if (queued.state === "needs_review") { queued.reason = "Missing verified source facts."; batch.counts.needs_review += 1; }
        else batch.counts.ready += 1;
        batch.counts.queued -= 1;
        savedOperations.set(body.operationKey, true);
      }
      batch.status = batch.counts.queued ? "queued" : "completed";
      if (loseFirstProcess) { loseFirstProcess = false; return route.abort("failed"); }
      return route.fulfill({ json:{ batch } });
    }
    if (url.pathname.endsWith("/cancel") || url.pathname.endsWith("/retry")) return route.fulfill({ json:{ batch:[...batches.values()][0] } });
    return route.fulfill({ json:{} });
  });

  await page.goto("/");
  await page.getByRole("button", { name:"Lead CRM" }).click();
  await expect(page.getByRole("heading", { name:"Lead CRM" })).toBeVisible();
  await expect(page.getByRole("button", { name:"Enrich selected (0)" })).toBeVisible();
  await page.locator(".crm-enrichment-check").nth(0).check();
  await page.locator("#crmNext").click();
  await page.locator(".crm-enrichment-check").nth(0).check();
  const selectedIds = [leads[0].id, leads[100].id];
  await expect(page.getByRole("button", { name:"Enrich selected (2)" })).toBeEnabled();
  await page.locator("#crmSearch").fill("Tutor 101");
  await expect(page.getByRole("button", { name:"Enrich selected (2)" })).toBeEnabled();
  await page.locator("#crmSearch").fill("");
  await page.getByRole("button", { name:"Enrich selected (2)" }).click();
  await expect(page.locator("#enrichmentStatus")).toContainText("Creation response");
  expect(calls.filter((call) => call.type === "create")[0].leadIds).toEqual(selectedIds);

  await page.reload();
  await page.getByRole("button", { name:"Lead CRM" }).click();
  await expect(page.getByRole("heading", { name:"Enrichment batch" })).toBeVisible();
  expect(calls.filter((call) => call.type === "create").map((call) => call.requestKey)).toHaveLength(2);
  expect(calls.filter((call) => call.type === "create")[0].requestKey).toBe(calls.filter((call) => call.type === "create")[1].requestKey);
  expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
  await page.getByRole("button", { name:"Resume" }).click();
  await expect(page.locator("#enrichmentStatus")).toContainText("Progress saved. Resume to replay the same operation safely");
  await page.getByRole("button", { name:"Resume" }).click();
  await expect.poll(() => operationKeys.length).toBeGreaterThanOrEqual(2);
  expect(operationKeys[0]).toBe(operationKeys[1]);
  await expect(page.locator("#enrichmentBatches")).toContainText("1 ready · 1 needs review");
  await expect(page.locator("#enrichmentBatches")).toContainText("Missing verified source facts.");
  await expect(page.locator("#enrichmentBatches")).toContainText("completed · 1 ready · 1 needs review");
  expect(operationKeys).toHaveLength(3);
  expect(operationKeys[2]).not.toBe(operationKeys[0]);
  await expect(page.locator("#enrichmentBatches a.source-link").first()).toHaveAttribute("href", "https://example.test/source");
  const items = page.locator("#enrichmentBatches .enrichment-items li");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("3 reported credits");
  await expect(items.nth(1)).toContainText("3 reported credits");
  expect(processedLeadIds).toEqual(selectedIds);
});

test("sales users cannot see enrichment selection or controls", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json:{ user:{ id:"33333333-3333-4333-8333-333333333333", role:"sales", active:true } } }));
  await page.route("**/api/health", (route) => route.fulfill({ json:{} }));
  await page.route("**/api/reports", (route) => route.fulfill({ json:{ reports:[] } }));
  await page.route("**/api/crm/leads", (route) => route.fulfill({ json:{ leads:[leads[0]] } }));
  await page.route("**/api/crm/types", (route) => route.fulfill({ json:{ types:[] } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name:"Lead CRM" })).toBeVisible();
  await expect(page.locator("#crmEnrichmentPanel")).toBeHidden();
  await expect(page.getByRole("button", { name:/Enrich selected/ })).toHaveCount(0);
  await expect(page.locator(".crm-enrichment-check")).toHaveCount(0);
});
