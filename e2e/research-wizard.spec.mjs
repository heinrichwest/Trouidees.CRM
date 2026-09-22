import { test, expect } from "@playwright/test";

const completedReport = {
  id: "test-report",
  generatedAt: "2026-09-10T10:00:00.000Z",
  company: { name: "Tutor SA", website: "https://www.tutorssa.co.za/", summary: "A tutoring provider serving South African learners." },
  qualification: { score: 78, confidence: "High" },
  fieldResults: [
    { field: "Company overview", value: "South African tutoring provider", evidence: "Tutoring services for learners", sourceUrl: "https://www.tutorssa.co.za/", found: true },
    { field: "Number of tutors", value: "Not published", evidence: "No verified total found", sourceUrl: "https://www.tutorssa.co.za/", found: false },
  ],
  contacts: [{ name: "Sales team", role: "Enquiries", email: "hello@example.test", phone: "", source_url: "https://www.tutorssa.co.za/contact" }],
  nextSteps: ["Confirm the tutor network size before outreach."],
  warnings: [],
  risksOrUnknowns: ["Tutor count is not publicly stated."],
  usage: { pagesCrawled: 8, crawlCredits: 8, searchCredits: 1, agentCredits: 10 },
};

test("guides the user, submits exact fields and renders an evidence table", async ({ page }) => {
  let submittedPayload;
  let pollCount = 0;

  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true, apiKeyConfigured: false } }));
  await page.route("**/api/reports", (route) => route.fulfill({ json: { reports: [] } }));
  await page.route("**/api/research", async (route) => {
    submittedPayload = route.request().postDataJSON();
    await route.fulfill({ status: 202, json: { id: "e2e-job", status: "running" } });
  });
  await page.route("**/api/jobs/e2e-job", async (route) => {
    pollCount += 1;
    await route.fulfill({ json: pollCount === 1
      ? { id: "e2e-job", status: "running", progress: { stage: "crawl", message: "Crawled 4 of 8 pages", completed: 4, total: 8 } }
      : { id: "e2e-job", status: "completed", progress: { stage: "complete", message: "Sales brief ready" }, result: completedReport } });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What do you want this research to achieve?" })).toBeVisible();
  await page.getByText("Qualify one prospect", { exact: true }).click();
  await page.getByLabel("Anything specific the researcher should focus on?").fill("Find school tutors, email addresses and published network size.");
  await page.getByRole("button", { name: /Continue/ }).click();

  await page.getByLabel("Company website").fill("https://www.tutorssa.co.za/");
  await page.getByLabel("What are you selling to them?").fill("School partnership services");
  await page.getByRole("button", { name: /Continue/ }).click();

  await page.locator("#customFields").fill("Number of tutors\nEmail addresses");
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(page.getByText("Number of tutors", { exact: false })).toBeVisible();

  await page.getByLabel("Firecrawl API key").fill("test-firecrawl-key");
  await page.getByRole("button", { name: /Run research/ }).click();

  await expect(page.getByRole("heading", { name: "Tutor SA" })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByRole("heading", { name: "Evidence table" })).toBeVisible();
  await expect(page.locator("#resultsTable tbody tr")).toHaveCount(2);
  await expect(page.locator("#resultsTable")).toContainText("South African tutoring provider");
  await expect(page.locator("#resultsTable")).toContainText("Not published");
  expect(submittedPayload.requestedFields).toContain("Number of tutors");
  expect(submittedPayload.researchGoal).toContain("Find school tutors");
  expect(submittedPayload.useAgent).toBe(false);

  await page.screenshot({ path: "test-results/research-results.png", fullPage: true });
});

test("discovers multiple tutors without requiring a company website", async ({ page }) => {
  let submittedPayload;
  let savedChanges;
  let crmLeads = [];
  const crmTypes = [{ name: "Tutors", count: 0 }, { name: "Photographers", count: 0 }, { name: "Gift Sellers", count: 0 }];
  const discoveryReport = {
    id: "discovery-test",
    mode: "discovery",
    generatedAt: "2026-09-10T10:00:00.000Z",
    input: { leadType: "Tutors" },
    company: { name: "Tutors in South Africa", website: "", summary: "Found 2 tutor leads; both have public contact details." },
    qualification: { score: 100, confidence: "Medium" },
    columns: [
      { field: "Name", key: "name" }, { field: "Details", key: "details" }, { field: "Phone numbers", key: "phone" },
      { field: "Email addresses", key: "email" }, { field: "Website", key: "website" },
    ],
    leads: [
      { name: "Cape Tutors", details: "Maths and science tutoring", phone: "+27 21 555 0101", email: "hello@cape.example", website: "https://cape.example/", sourceUrl: "https://cape.example/" },
      { name: "Jozi Tutors", details: "School tutoring", phone: "011 555 0102", email: "info@jozi.example", website: "https://jozi.example/", sourceUrl: "https://jozi.example/" },
    ],
    contacts: [{ name: "Cape Tutors" }, { name: "Jozi Tutors" }], nextSteps: ["Verify contacts."], warnings: [], risksOrUnknowns: [], usage: { pagesCrawled: 2 },
  };

  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true, apiKeyConfigured: false } }));
  await page.route("**/api/reports", (route) => route.fulfill({ json: { reports: [] } }));
  await page.route("**/api/research", async (route) => {
    submittedPayload = route.request().postDataJSON();
    await route.fulfill({ status: 202, json: { id: "discovery-job", status: "running" } });
  });
  await page.route("**/api/jobs/discovery-job", (route) => route.fulfill({ json: { id: "discovery-job", status: "completed", progress: { stage: "complete" }, result: discoveryReport } }));
  await page.route("**/api/crm/import", async (route) => {
    crmLeads = discoveryReport.leads.map((lead, index) => ({ ...lead, id: `00000000-0000-4000-8000-00000000000${index}`, leadType: "Tutors", status: "New", feedback: "", comments: "", lastContactedAt: "" }));
    await route.fulfill({ json: { imported: 2, skipped: 0, total: 2 } });
  });
  await page.route("**/api/crm/leads/*", async (route) => {
    savedChanges = route.request().postDataJSON();
    const feedbackHistory = savedChanges.feedbackEntry ? [{ text: savedChanges.feedbackEntry, author: "sales@example.com", createdAt: "2026-09-22T10:00:00.000Z", status: savedChanges.status }] : [];
    crmLeads[0] = { ...crmLeads[0], ...savedChanges, feedback: savedChanges.feedbackEntry || crmLeads[0].feedback, feedbackHistory };
    await route.fulfill({ json: crmLeads[0] });
  });
  await page.route("**/api/crm/leads", (route) => route.fulfill({ json: { leads: crmLeads } }));
  await page.route("**/api/crm/types", async (route) => {
    if (route.request().method() === "POST") {
      const { name } = route.request().postDataJSON();
      crmTypes.push({ name, count: 0 });
      return route.fulfill({ status: 201, json: { name } });
    }
    crmTypes[0].count = crmLeads.length;
    return route.fulfill({ json: { types: crmTypes } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(page.getByRole("heading", { name: "What should Firecrawl find?" })).toBeVisible();
  await page.locator("#searchQuery").fill("Maths and science tutors in South Africa");
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(page.getByText("Phone numbers", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByLabel("Unlimited overnight mode").check();
  await expect(page.locator("#maxPages")).toBeDisabled();
  await page.locator("#runHours").fill("1");
  await page.getByLabel("Firecrawl API key").fill("test-firecrawl-key");
  await page.getByRole("button", { name: /Run research/ }).click();

  await expect(page.getByRole("heading", { name: "Tutors in South Africa" })).toBeVisible();
  await expect(page.locator("#resultsTable tbody tr")).toHaveCount(2);
  await expect(page.locator("#resultsTable")).toContainText("hello@cape.example");
  await expect(page.locator("#resultsTable tbody tr").filter({ hasText: "@" })).toHaveCount(2);
  expect(submittedPayload.mode).toBe("discovery");
  expect(submittedPayload.website).toBe("");
  expect(submittedPayload.searchQuery).toContain("Maths and science tutors");
  expect(submittedPayload.leadType).toBe("Tutors");
  expect(submittedPayload.unlimited).toBe(true);

  await page.getByRole("button", { name: "Save to CRM" }).click();
  await expect(page.getByRole("button", { name: /2 added/ })).toBeVisible();
  await page.getByRole("button", { name: "Lead CRM" }).click();
  await expect(page.getByRole("heading", { name: "Lead CRM" })).toBeVisible();
  await page.getByLabel("New lead type").fill("Florists");
  await page.getByRole("button", { name: "Add type" }).click();
  await expect(page.locator("#leadTypeTable")).toContainText("Florists");
  await expect(page.locator("#crmTable tbody tr")).toHaveCount(2);
  await page.locator("#crmTable .edit-lead").first().click();
  await page.locator("#editLeadStatus").selectOption("Contacted");
  await page.getByLabel("Add feedback update").fill("Requested a proposal next week.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("#crmTable")).toContainText("Contacted");
  await expect(page.locator("#crmTable")).toContainText("Requested a proposal next week.");
  expect(savedChanges.feedbackEntry).toBe("Requested a proposal next week.");
  await page.locator("#crmTable .edit-lead").first().click();
  await expect(page.locator("#feedbackHistory")).toContainText("Requested a proposal next week.");
  await expect(page.locator("#feedbackHistory")).toContainText("sales@example.com");
});

test("hides overnight mode on hosted deployments and explains plain-text timeouts", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({ json: { ok: true, apiKeyConfigured: true, serverless: true } }));
  await page.route("**/api/reports", (route) => route.fulfill({ json: { reports: [] } }));
  await page.route("**/api/research", (route) => route.fulfill({
    status: 504,
    contentType: "text/plain",
    body: "An error occurred with your deployment",
  }));

  await page.goto("/");
  await expect(page.getByLabel("Unlimited overnight mode")).toBeHidden();
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.locator("#searchQuery").fill("Tutors in South Africa");
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByRole("button", { name: /Run research/ }).click();

  await expect(page.locator("#formError")).toContainText("hosted request timed out or was interrupted");
  await expect(page.locator("#formError")).not.toContainText("not valid JSON");
});
