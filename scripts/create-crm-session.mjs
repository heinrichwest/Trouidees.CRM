import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const prompt = createInterface({ input: stdin, output: stdout });
const email = String(process.env.ADMIN_EMAIL || await prompt.question("CRM admin email: ")).trim().toLowerCase();
prompt.close();

const password = String(process.env.ADMIN_PASSWORD || await new Promise((resolve) => {
  let value = "";
  stdout.write("CRM password: ");
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.on("data", (chunk) => {
    for (const character of chunk.toString()) {
      if (character === "\r" || character === "\n") {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdout.write("\n");
        resolve(value);
        return;
      }
      if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
      else value += character;
    }
  });
}));

const appUrl = String(process.env.APP_URL || "https://trouidees-crm.vercel.app").replace(/\/$/, "");
const response = await fetch(`${appUrl}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(payload.error || `Login failed with status ${response.status}.`);
const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
if (!cookie) throw new Error("The CRM did not return a login session.");

const logs = new URL("../data/logs/", import.meta.url);
await mkdir(logs, { recursive: true });
await writeFile(new URL("crm-session-cookie.log", logs), cookie, { mode: 0o600 });
console.log("Production CRM session created. Your password was not saved.");
