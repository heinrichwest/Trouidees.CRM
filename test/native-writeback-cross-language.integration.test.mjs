import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { handleAgentRequest } from "../lib/agent-api.mjs";
import { hashToken } from "../lib/auth.mjs";

const token = "d".repeat(43);
const leadId = "123e4567-e89b-42d3-a456-426614174000";
const conversationId = "323e4567-e89b-42d3-a456-426614174000";
const pluginDir = resolve("integrations/hermes-crm-plugin");
const driver = resolve("test/fixtures/native-crm-driver.py");

function runDriver(input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("python3", [driver], { stdio:["pipe", "pipe", "pipe"], env:{ ...process.env, PYTHONPATH:pluginDir } });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise(JSON.parse(stdout)) : reject(new Error(stderr || `driver exited ${code}`)));
    child.stdin.end(JSON.stringify(input));
  });
}

test("Python native adapter retries POST and repairs PATCH before cursor acknowledgment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-crm-cross-language-"));
  const statePath = join(directory, "native_delivery.sqlite3");
  const calls = []; const apiRequests=[]; const apiStatuses=[]; const apiErrors=[]; let stored; let conversationCount = 0; let firstContactCount = 0; let finalizeAttempts = 0; let acknowledgedCursor = 0; let lostPatchResponse = false;
  const store = {
    db:{ ensureSchema:async () => {}, sql:async (query, params) => {
      if (query.includes("UPDATE agent_keys SET last_used_at")) return params[0] === hashToken(token)
        ? [{ id:"11111111-1111-4111-8111-111111111111", label:"Agent A", scopes:["conversations:write","leads:update:limited","outreach:write"] }] : [];
      if (query.includes("crm_finalize_native_delivery")) {
        finalizeAttempts += 1;
        return [{ result:{ id:leadId, status:"Contacted" } }];
      }
      return [];
    } },
    ready:async () => {},
    appendConversation:async (input) => {
      calls.push({ kind:"conversation", input });
      if (stored && (stored.segmentId !== input.segmentId || JSON.stringify(stored.messages) !== JSON.stringify(input.messages))) throw Object.assign(new Error("idempotency conflict"), { status:409 });
      if (!stored) { stored = { id:conversationId, ...input }; conversationCount += 1; firstContactCount += 1; }
      return { conversation:stored, contactedAt:"2026-10-26T08:00:00.000Z", firstContact:true, allocationViolation:false };
    },
  };
  const previous = process.env.AGENT_NATIVE_OUTREACH_ENABLED; process.env.AGENT_NATIVE_OUTREACH_ENABLED="1";
  const server = createServer((request,response) => {
    apiRequests.push(`${request.method} ${request.url}`);
    const originalEnd=response.end.bind(response);
    response.end=(...args) => {
      if (request.method==="PATCH" && !lostPatchResponse) { lostPatchResponse=true; response.socket.destroy(); return response; }
      if (args[0]) { try { apiErrors.push(JSON.parse(args[0]).error); } catch {} }
      return originalEnd(...args);
    };
    const originalWriteHead=response.writeHead.bind(response);
    response.writeHead=(status,...args)=>{apiStatuses.push(status);return originalWriteHead(status,...args);};
    handleAgentRequest({ request,response,store });
  });
  try {
    await new Promise((resolvePromise,reject) => server.listen(0,"127.0.0.1",(error) => error ? reject(error) : resolvePromise()));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const request = { baseUrl,apiKey:token,statePath,namespace:"test-namespace",account:"test-account",speaker:"Agent A",
      event:{ id:"evt-1",outbox_id:"outbox-1",state:"delivered",text:"  Hello 🛰️\n",request_id:"request-1",job_id:"job-1" },
      binding:{ lead_id:leadId,claim_id:null } };
    await assert.rejects(runDriver(request));
    assert.equal(conversationCount,1,`requests: ${apiRequests.join(", ")} statuses: ${apiStatuses.join(",")} errors: ${apiErrors.join(",")}`);
    const result = await runDriver(request);
    assert.equal(result.applied,true);
    assert.deepEqual(calls.map((call)=>call.kind),["conversation","conversation"]);
    assert.equal(calls[0].input.messages[0].body,"  Hello 🛰️\n");
    assert.equal(calls[1].input.messages[0].timestamp,null);
    assert.equal(finalizeAttempts,2);
    acknowledgedCursor=1;
    assert.deepEqual({ conversationCount,firstContactCount,acknowledgedCursor },{ conversationCount:1,firstContactCount:1,acknowledgedCursor:1 });
    const ignored = await runDriver({ ...request,event:{ ...request.event,state:"accepted" } });
    assert.deepEqual(ignored,{ applied:false,ignored:true,segmentId:null });
    assert.equal(conversationCount,1);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    if (previous == null) delete process.env.AGENT_NATIVE_OUTREACH_ENABLED; else process.env.AGENT_NATIVE_OUTREACH_ENABLED=previous;
    await rm(directory,{recursive:true,force:true});
  }
});
