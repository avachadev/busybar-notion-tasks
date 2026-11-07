import assert from "node:assert/strict";
import { test } from "node:test";

import { CancelledError, readView } from "../src/source.ts";

/** A fake Notion: every request answers with one more page of a long page's blocks. */
function fakeNotion(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const body = { results: [{ id: `b${calls.length}`, type: "child_page", child_page: { title: "x" } }], has_more: true, next_cursor: "c" };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  return { calls };
}

test("a read of a view the user has left stops at its next request", async () => {
  const notion = fakeNotion();
  let wanted = true;
  const view = { kind: "page" as const, id: "p", title: "" };
  const reading = readView("t", view, "today", new Date(), new Map(), () => {
    // The user goes up while the first request is out.
    const now = wanted;
    wanted = false;
    return now;
  });
  await assert.rejects(reading, CancelledError);
  assert.equal(notion.calls.length, 1);
});

test("a wanted read follows a long page to its end", async () => {
  const notion = fakeNotion();
  const view = { kind: "page" as const, id: "p", title: "" };
  const loaded = await readView("t", view, "today", new Date(), new Map(), () => true);
  // Four requests of 50 blocks at most.
  assert.equal(notion.calls.length, 4);
  assert.equal(loaded.entries.length, 4);
});

test("a timed-out call keeps the next one off the wire until it has finished", async () => {
  const { call } = await import("../src/notion.ts");
  let open = 0;
  let most = 0;
  globalThis.fetch = (async () => {
    open += 1;
    most = Math.max(most, open);
    await new Promise((done) => setTimeout(done, 60));
    open -= 1;
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;
  // The first caller gives up after 10 ms; its request is still out.
  await assert.rejects(call("t", "GET", "a", undefined, 10), /timeout/);
  await call("t", "GET", "b");
  assert.equal(most, 1);
});
