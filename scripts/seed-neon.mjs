import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { hashPassword } from "../lib/auth.mjs";
import { NeonStore } from "../lib/neon-store.mjs";

const prompt = createInterface({ input: stdin, output: stdout });
const email = String(process.env.ADMIN_EMAIL || await prompt.question("Admin email: ")).trim().toLowerCase();
const password = String(process.env.ADMIN_PASSWORD || await prompt.question("Admin password: "));
prompt.close();

let localLeads = [];
try { localLeads = JSON.parse(await readFile(new URL("../data/crm/leads.json", import.meta.url), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
const grouped = localLeads.reduce((groups, lead) => {
  const leadType = lead.leadType || "Uncategorised";
  if (!groups.has(leadType)) groups.set(leadType, []);
  groups.get(leadType).push(lead);
  return groups;
}, new Map());
const reportsDirectory = new URL("../data/reports/", import.meta.url);
const reports = [];
try {
  for (const filename of await readdir(reportsDirectory)) {
    if (!filename.endsWith(".json")) continue;
    const report = JSON.parse(await readFile(new URL(filename, reportsDirectory), "utf8"));
    if (report.id && report.generatedAt) reports.push(report);
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }

let imported = 0;
let skipped = 0;
if (process.env.DATABASE_URL && process.env.DATABASE_URL !== "[SENSITIVE]") {
  const store = new NeonStore(process.env.DATABASE_URL);
  await store.ensureSchema();
  const existingAdmin = await store.getUserByEmail(email);
  const passwordHash = await hashPassword(password);
  if (existingAdmin) await store.updateUser(existingAdmin.id, { role: "admin", active: true, passwordHash });
  else await store.createUser({ email, role: "admin", passwordHash });
  for (const [leadType, leads] of grouped) {
    const result = await store.importLeads(leads, leadType, { requireEmail: false });
    imported += result.imported; skipped += result.skipped;
  }
  for (const report of reports) await store.saveReport(report);
} else {
  const appUrl = String(process.env.APP_URL || "").replace(/\/$/, "");
  if (!appUrl) throw new Error("Set APP_URL when DATABASE_URL is unavailable locally.");
  const login = await fetch(`${appUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!login.ok) throw new Error(`Admin login failed: ${(await login.json().catch(() => ({}))).error || login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  for (let index = 0; index < localLeads.length; index += 75) {
    const response = await fetch(`${appUrl}/api/admin/import`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ leads: localLeads.slice(index, index + 75) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(`Lead import failed: ${result.error || response.status}`);
    imported += result.imported; skipped += result.skipped;
  }
  for (const report of reports) {
    const encoded = JSON.stringify({ report });
    if (Buffer.byteLength(encoded) > 900_000) continue;
    const response = await fetch(`${appUrl}/api/admin/import`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: encoded });
    if (!response.ok) throw new Error(`Report import failed with status ${response.status}.`);
  }
}

console.log(`Neon seed complete: ${imported} leads imported, ${skipped} duplicates skipped, admin account ready.`);
