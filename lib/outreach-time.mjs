const TIME_ZONE = "Africa/Johannesburg";
const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function wallParts(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new RangeError("A valid Date is required.");
  return Object.fromEntries(formatter.formatToParts(date).filter(({ type }) => type !== "literal").map(({ type, value }) => [type, Number(value)]));
}

function wallClockToInstant(parts) {
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
  let instant = wallAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = wallParts(new Date(instant));
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second, new Date(instant).getUTCMilliseconds());
    instant += wallAsUtc - actualAsUtc;
  }
  return new Date(instant);
}

/** Return the calendar date in the CRM's Johannesburg business timezone. */
export function localDay(at) {
  const parts = wallParts(at);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** Return the same Johannesburg wall-clock time on the next Monday-Friday. */
export function nextBusinessDayAt(at) {
  const parts = wallParts(at);
  const milliseconds = at.getUTCMilliseconds();
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  do {
    date.setUTCDate(date.getUTCDate() + 1);
  } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return wallClockToInstant({ ...parts, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), millisecond: milliseconds });
}
