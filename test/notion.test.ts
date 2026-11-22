import assert from "node:assert/strict";
import { test } from "node:test";

import { DroppedError, SWEEP, UPKEEP, VIEW, WRITE, call, wireIdle } from "../src/notion.ts";

/** A fake `fetch`: each request waits until the test lets it go, and the order requests start in is recorded. */
function fakeFetch() {
  const started: string[] = [];
  const pending: (() => void)[] = [];
  let inFlight = 0;
  let most = 0;
  globalThis.fetch = ((url: string) => {
    started.push(String(url).split("/v1/")[1]);
    inFlight += 1;
    most = Math.max(most, inFlight);
    return new Promise((resolve) => {
      pending.push(() => {
        inFlight -= 1;
        resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      });
    });
  }) as typeof fetch;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const release = async () => {
    const next = pending.shift();
    if (next) next();
    await tick();
    await tick();
  };
  return { started, release, most: () => most, tick };
}

test("one request at a time, the most urgent waiting one next, in the order asked within a priority", async () => {
  const f = fakeFetch();
  const done: Promise<unknown>[] = [];
  done.push(call("t", "GET", "first", undefined, { priority: SWEEP }));
  await f.tick();
  done.push(call("t", "GET", "sweep2", undefined, { priority: SWEEP }));
  done.push(call("t", "GET", "upkeep", undefined, { priority: UPKEEP }));
  done.push(call("t", "GET", "view1"));
  done.push(call("t", "GET", "view2", undefined, { priority: VIEW }));
  done.push(call("t", "PATCH", "tick", {}, { priority: WRITE }));
  assert.equal(wireIdle(), false);
  for (let i = 0; i < 6; i += 1) await f.release();
  await Promise.all(done);
  assert.deepEqual(f.started, ["first", "tick", "view1", "view2", "upkeep", "sweep2"]);
  assert.equal(f.most(), 1);
  assert.equal(wireIdle(), true);
});

test("a request no longer wanted when its turn comes is not sent", async () => {
  const f = fakeFetch();
  let wanted = true;
  const first = call("t", "GET", "busy");
  await f.tick();
  const left = assert.rejects(call("t", "GET", "left", undefined, { alive: () => wanted }), DroppedError);
  const kept = call("t", "GET", "kept");
  wanted = false;
  await f.release();
  await left;
  await f.release();
  await Promise.all([first, kept]);
  assert.deepEqual(f.started, ["busy", "kept"]);
});

test("a caller that gives up while waiting takes its request out of the queue", async () => {
  const f = fakeFetch();
  const first = call("t", "GET", "slow");
  await f.tick();
  await assert.rejects(call("t", "GET", "late", undefined, { timeoutMs: 5 }), /timeout/);
  await f.release();
  await first;
  assert.deepEqual(f.started, ["slow"]);
  assert.equal(wireIdle(), true);
});

test("after a 429 nothing starts before its retry_after has passed, a string of seconds as Notion sends it", async () => {
  const starts: number[] = [];
  let first = true;
  globalThis.fetch = (async () => {
    starts.push(Date.now());
    if (first) {
      first = false;
      return new Response(JSON.stringify({ object: "error", status: 429, code: "rate_limited", message: "slow down", additional_data: { retry_after: "0.2" } }), { status: 429 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  await assert.rejects(call("t", "GET", "a"), (err: { retryAfterMs: number }) => err.retryAfterMs === 200);
  await call("t", "GET", "b", undefined, { priority: WRITE });
  assert.ok(starts[1] - starts[0] >= 190, `waited ${starts[1] - starts[0]} ms`);
});
