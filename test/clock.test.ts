import assert from "node:assert/strict";
import { test } from "node:test";

import { offsetOf, readOffset } from "../src/clock.ts";

test("the offset of the bar's timestamp, in minutes east of UTC", () => {
  assert.equal(offsetOf("2026-11-23T13:24:17+03:00"), 180);
  assert.equal(offsetOf("2026-11-23T05:24:17-05:00"), -300);
  assert.equal(offsetOf("2026-11-23T15:54:17+05:30"), 330);
  assert.equal(offsetOf("2026-11-23T10:24:17+00:00"), 0);
  assert.equal(offsetOf("2026-11-23T10:24:17Z"), 0);
  assert.equal(offsetOf("2026-11-23T10:24:17+0300"), 180);
  assert.equal(offsetOf("2026-11-23T10:24:17"), null);
});

test("the offset is read from the bar's clock", async () => {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    return { ok: true, status: 200, text: async () => '{"timestamp":"2026-11-23T13:24:17+03:00"}' } as unknown as Response;
  }) as typeof fetch;
  assert.equal(await readOffset(), 180);
  assert.deepEqual(asked, ["http://127.0.0.1/api/time"]);
});

test("a clock answer without a timestamp gives no offset, a failed one throws", async () => {
  globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => "{}" }) as unknown as Response) as typeof fetch;
  assert.equal(await readOffset(), null);
  globalThis.fetch = (async () => ({ ok: false, status: 500, text: async () => "" }) as unknown as Response) as typeof fetch;
  await assert.rejects(readOffset(), /time: HTTP 500/);
});
