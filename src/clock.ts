/**
 * The bar's time zone. JS on the bar has none: `getTimezoneOffset()` is 0 and
 * local dates are UTC dates. The bar's own clock knows the zone set in its
 * settings: `GET /api/time` answers `{"timestamp":"2026-11-23T13:24:17+03:00"}`.
 */

const TIME_URL = "http://127.0.0.1/api/time";

/** Minutes east of UTC in an ISO timestamp's offset, or null when it has none. "Z" is 0. */
export function offsetOf(timestamp: string): number | null {
  if (/Z$/i.test(timestamp)) return 0;
  const m = /([+-])(\d\d):?(\d\d)$/.exec(timestamp);
  if (m === null) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}

/** The bar's UTC offset in minutes; null when the bar did not say. */
export async function readOffset(): Promise<number | null> {
  const response = await fetch(TIME_URL);
  const body = await response.text();
  if (!response.ok) throw new Error(`time: HTTP ${response.status}`);
  const timestamp = (JSON.parse(body) as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "string" ? offsetOf(timestamp) : null;
}
