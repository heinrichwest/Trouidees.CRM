import { promisify } from "node:util";
import { scrypt as scryptCallback, randomBytes } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";

const scrypt = promisify(scryptCallback);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Set DATABASE_URL to your Neon connection string.");
  process.exit(1);
}

const email = (process.argv[2] || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.argv[3] || process.env.ADMIN_PASSWORD || "";
if (!email || !password) {
  console.error("Usage: node scripts/make-admin.mjs <email> <password>  (or ADMIN_EMAIL/ADMIN_PASSWORD env)");
  process.exit(1);
}
if (password.length < 10) {
  console.error("Password must be at least 10 characters.");
  process.exit(1);
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Enter a valid email address.");
  process.exit(1);
}

async function hashPassword(value) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(value, salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString("hex")}`;
}

const sql = neon(databaseUrl);
await sql`CREATE TABLE IF NOT EXISTS app_users (
  id UUID PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'sales')), active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

const existing = await sql`SELECT id, role FROM app_users WHERE email = ${email}`;
const hash = await hashPassword(password);

if (existing.length) {
  await sql`UPDATE app_users SET role = 'admin', password_hash = ${hash}, active = TRUE, updated_at = NOW() WHERE email = ${email}`;
  console.log(`Promoted existing user ${email} to admin and reset its password.`);
} else {
  const id = randomUUID();
  await sql`INSERT INTO app_users (id, email, password_hash, role) VALUES (${id}, ${email}, ${hash}, 'admin')`;
  console.log(`Created new admin user ${email}.`);
}
console.log("Done. Sign in at the CRM with that email and password.");
