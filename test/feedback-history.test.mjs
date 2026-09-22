import test from "node:test";
import assert from "node:assert/strict";
import { appendFeedbackHistory } from "../lib/feedback-history.mjs";

test("preserves legacy feedback when appending the first history entry", () => {
  const history = appendFeedbackHistory({
    feedback: "Initial phone conversation.",
    status: "Contacted",
    updatedAt: "2026-09-21T09:00:00.000Z",
  }, "Requested a follow-up next week.", "sales@example.com", "2026-09-22T10:00:00.000Z");

  assert.deepEqual(history.map((entry) => entry.text), ["Initial phone conversation.", "Requested a follow-up next week."]);
  assert.equal(history[0].author, "Previous CRM entry");
  assert.equal(history[1].author, "sales@example.com");
});
