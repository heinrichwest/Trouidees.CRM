import { test, expect } from "@playwright/test";

test("renders a real saved Firecrawl discovery report", async ({ page }) => {
  test.skip(process.env.LIVE_REPORT_TEST !== "1", "Run with LIVE_REPORT_TEST=1 after a live Firecrawl request.");

  await page.goto("/");
  const latestReport = page.locator("#historyList .history-item").first();
  await expect(latestReport).toBeVisible();
  await latestReport.click();

  await expect(page.locator("#resultsView")).toBeVisible();
  await expect(page.locator("#resultsTable tbody tr")).not.toHaveCount(0);
  await expect(page.locator("#resultsTable")).toContainText(/@|\+27|0\d{2}/);
  await page.screenshot({ path: "test-results/live-firecrawl-report.png", fullPage: true });
});
