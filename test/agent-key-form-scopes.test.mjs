import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AGENT_SCOPES } from "../lib/agent-auth.mjs";

// Every scope the server accepts must be grantable from the admin "Agent keys" form, or a key for
// a new route (such as native outreach) can only be issued by hand.
test("agent key form offers exactly the scopes the server accepts", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const offered = [...html.matchAll(/name="agentScope" value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...offered].sort(), [...AGENT_SCOPES].sort());
});
