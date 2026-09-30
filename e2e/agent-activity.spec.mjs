import { test, expect } from "@playwright/test";

test("lead detail distinguishes chronological WhatsApp messages, summary, and internal notes", async ({ page }) => {
  const lead = { id: "123e4567-e89b-42d3-a456-426614174000", name: "Timeline contact", leadType: "Tutors", status: "New", priority: "Normal", assignedTo: "Andrew", lastContactedAt: "", nextFollowUpAt: "", services: "", feedback: "", comments: "", email: "test@example.com", phone: "0820000000" };
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: "admin", email: "admin@example.com", role: "admin", active: true } } }));
  await page.route("**/api/crm/leads", (route) => route.fulfill({ json: { leads: [lead] } }));
  await page.route("**/api/crm/types", (route) => route.fulfill({ json: { types: [{ name: "Tutors", count: 1 }] } }));
  await page.route(`**/api/crm/leads/${lead.id}/activity`, (route) => route.fulfill({ json: { activity: [
    { id: "m1", type: "message", direction: "incoming", speaker: "contact", body: "Hello from the contact", occurredAt: null },
    { id: "m2", type: "message", direction: "outgoing", speaker: "andrew", body: "Hello from Andrew", occurredAt: "2026-09-29T09:01:00Z" },
    { id: "s1", type: "summary", body: "They discussed tutoring availability.", occurredAt: "2026-09-29T09:02:00Z" },
    { id: "n1", type: "note", author: "Admin", body: "Internal follow-up reminder.", occurredAt: "2026-09-29T09:03:00Z" },
  ] } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Lead CRM" }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  const items = page.locator("#leadActivity .activity-item");
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toContainText("WhatsApp · Incoming");
  await expect(items.nth(1)).toContainText("WhatsApp · Outgoing");
  await expect(items.nth(2)).toContainText("Conversation summary");
  await expect(items.nth(3)).toContainText("Internal note");
  await expect(items.nth(3)).not.toContainText("WhatsApp");
  await expect(items.nth(0)).toContainText("Time unknown");
  await expect(page.locator("#leadActivity")).toContainText("Internal follow-up reminder.");
});
