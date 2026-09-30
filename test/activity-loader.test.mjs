import test from "node:test";
import assert from "node:assert/strict";
import { createSelectedActivityLoader } from "../public/activity-loader.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("only the currently selected lead's activity request can render", async () => {
  const loadActivity = createSelectedActivityLoader();
  const responses = new Map([["lead-a", deferred()], ["lead-b", deferred()]]);
  const rendered = [];
  let selectedLeadId = "lead-a";
  const load = (leadId) => loadActivity({
    leadId,
    selectedLeadId: () => selectedLeadId,
    fetchActivity: (id) => responses.get(id).promise,
    render: (activity) => rendered.push(activity),
    onError: (error) => { throw error; },
  });

  const firstRequest = load("lead-a");
  selectedLeadId = "lead-b";
  const secondRequest = load("lead-b");
  responses.get("lead-b").resolve(["activity-b"]);
  await secondRequest;
  responses.get("lead-a").resolve(["activity-a"]);
  await firstRequest;

  assert.deepEqual(rendered, [["activity-b"]]);
});

test("selected lead identity invalidates a response even before another fetch starts", async () => {
  const loadActivity = createSelectedActivityLoader();
  const response = deferred();
  const rendered = [];
  let selectedLeadId = "lead-a";
  const request = loadActivity({
    leadId: "lead-a",
    selectedLeadId: () => selectedLeadId,
    fetchActivity: () => response.promise,
    render: (activity) => rendered.push(activity),
    onError: (error) => { throw error; },
  });

  selectedLeadId = "lead-b";
  response.resolve(["stale activity"]);
  await request;

  assert.deepEqual(rendered, []);
});
