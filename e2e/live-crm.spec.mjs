import { test, expect } from "@playwright/test";

test("opens the real local CRM with email-qualified, typed leads", async ({ page }) => {
  test.skip(process.env.LIVE_CRM_TEST !== "1", "Set LIVE_CRM_TEST=1 to inspect local CRM data.");
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/");
  await page.getByRole("button", { name: "Lead CRM" }).click();
  await expect(page.getByRole("heading", { name: "Lead CRM" })).toBeVisible();
  await expect(page.locator("#crmTable tbody tr").first()).toBeVisible();
  await expect(page.locator("#crmTable")).toContainText("Tutors");
  const contactCells = page.locator("#crmTable tbody tr td:nth-child(3)");
  const count = await contactCells.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) await expect(contactCells.nth(index)).toContainText("@");
  expect(browserErrors).toEqual([]);
});
