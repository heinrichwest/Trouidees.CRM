import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "@neondatabase/serverless";

const root = fileURLToPath(new URL("../", import.meta.url));
const migrationsRoot = resolve(root, "scripts", "migrations");
const requested = process.argv[2];
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
if (!requested) throw new Error("Usage: node scripts/migrate-neon.mjs <migration-file>");
const migrationPath = resolve(requested);
if (!migrationPath.startsWith(`${migrationsRoot}${sep}`) || !migrationPath.endsWith(".sql")) {
  throw new Error("Migration files must be SQL files inside scripts/migrations.");
}
const sql = await readFile(migrationPath, "utf8");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(sql);
  await client.query("COMMIT");
  console.log(`Applied migration ${migrationPath.slice(migrationsRoot.length + 1)}.`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw new Error(`Migration failed (${error.code || error.name}).`);
} finally {
  client.release();
  await pool.end();
}
