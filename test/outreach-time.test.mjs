import test from "node:test";
import assert from "node:assert/strict";
import { localDay, nextBusinessDayAt } from "../lib/outreach-time.mjs";

test("localDay uses the Johannesburg calendar date", () => {
  assert.equal(localDay(new Date("2026-10-25T22:00:00Z")), "2026-10-26");
});

test("nextBusinessDayAt preserves local wall time across Friday and Monday", () => {
  assert.equal(nextBusinessDayAt(new Date("2026-10-23T08:15:00Z")).toISOString(), "2026-10-26T08:15:00.000Z");
  assert.equal(nextBusinessDayAt(new Date("2026-10-26T08:15:00Z")).toISOString(), "2026-10-27T08:15:00.000Z");
  assert.equal(nextBusinessDayAt(new Date("2026-10-23T08:15:00.123Z")).toISOString(), "2026-10-26T08:15:00.123Z");
});

test("public holidays are treated as ordinary weekdays", () => {
  assert.equal(nextBusinessDayAt(new Date("2026-12-24T08:15:00Z")).toISOString(), "2026-12-25T08:15:00.000Z");
});

test("nextBusinessDayAt rejects invalid dates", () => {
  assert.throws(() => nextBusinessDayAt(new Date("invalid")), RangeError);
});
