import assert from "node:assert/strict";
import { test } from "node:test";

import { entriesFromMarkdown } from "../src/markdown.ts";
import { CancelledError, MovedError, readView, setDone } from "../src/source.ts";

/** A fake Notion: every request answers with one more page of a long search. */
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
  const reading = readView("t", { kind: "root" }, "today", new Date(), new Map(), () => {
    // The user goes up while the first request is out.
    const now = wanted;
    wanted = false;
    return now;
  });
  await assert.rejects(reading, CancelledError);
  // The queue asks again when the request's turn comes: by then the user has left, and nothing is sent.
  assert.equal(notion.calls.length, 0);
});

test("a page is one markdown request", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const body = JSON.stringify({ object: "page_markdown", markdown: "- [ ] A\n  - [x] B" });
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body } as unknown as Response;
  }) as typeof fetch;
  const loaded = await readView("t", { kind: "page", id: "p", title: "" }, "today", new Date(), new Map(), () => true);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /pages\/p\/markdown\?markdown_version=v2$/);
  assert.deepEqual(loaded.entries.map((e) => [e.title, e.done]), [["A", false], ["B", true]]);
});

test("a long page shows its first screen once, while the rest is read", async () => {
  const md = Array.from({ length: 30 }, (_, i) => `- [ ] Task ${i}`).join("\n");
  const body = JSON.stringify({ object: "page_markdown", markdown: md });
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body }) as unknown as Response) as typeof fetch;
  const firsts: number[] = [];
  const loaded = await readView("t", { kind: "page", id: "p", title: "" }, "today", new Date(), new Map(), () => true, (list) => firsts.push(list.length));
  assert.deepEqual(firsts, [8]);
  assert.equal(loaded.entries.length, 30);
});

test("ticking a to-do from markdown walks the blocks to it once, depth first", async () => {
  const children: Record<string, unknown[]> = {
    pg: [
      { id: "t0", type: "to_do", to_do: { rich_text: [{ plain_text: "First" }] }, has_children: true },
      { id: "tg", type: "toggle", has_children: true },
      { id: "sub", type: "child_page", has_children: true },
      { id: "t3", type: "to_do", to_do: { rich_text: [{ plain_text: "Last" }] } },
    ],
    t0: [{ id: "t1", type: "to_do", to_do: { rich_text: [{ plain_text: "Child" }] } }],
    tg: [{ id: "t2", type: "to_do", to_do: { rich_text: [{ plain_text: "In toggle" }] } }],
  };
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    const m = /blocks\/([^/]+)\/children/.exec(String(url));
    const body = m ? { results: children[m[1]] ?? [], has_more: false } : {};
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  const todo = (title: string, index: number) => ({ kind: "todo" as const, id: `pg/1/${title}`, title, page: "pg", index });
  await setDone("t", todo("In toggle", 2), null, true);
  assert.deepEqual(calls.map((u) => u.replace(/.*v1\//, "").replace(/\?.*/, "")), [
    "blocks/pg/children", "blocks/t0/children", "blocks/tg/children", "blocks/t2",
  ]);
  calls.length = 0;
  // Walked already: straight to the block.
  await setDone("t", todo("Child", 1), null, false);
  assert.deepEqual(calls.map((u) => u.replace(/.*v1\//, "").replace(/\?.*/, "")), ["blocks/t1"]);
  // The page changed: the walk is done again, and a to-do no longer there is refused.
  calls.length = 0;
  await assert.rejects(setDone("t", todo("Gone", 0), null, true), MovedError);
});

test("a to-do whose line is unique is ticked by editing the page's markdown, else by its block", async () => {
  const sent: { url: string; body: unknown }[] = [];
  let refuse = false;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url).replace(/.*v1\//, ""), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (refuse && String(url).indexOf("/markdown") >= 0) {
      return { ok: false, status: 400, json: async () => ({ code: "validation_error", message: "no match" }) } as unknown as Response;
    }
    const m = /blocks\/([^/]+)\/children/.exec(String(url));
    const body = m ? { results: [{ id: "b0", type: "to_do", to_do: { rich_text: [{ plain_text: "Pay rent" }] } }], has_more: false } : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as typeof fetch;
  const [todo] = entriesFromMarkdown("pg", "- [ ] Pay <b>rent</b>");
  await setDone("t", todo, null, true);
  assert.deepEqual(sent, [{
    url: "pages/pg/markdown",
    body: { markdown_version: "v2", type: "update_content", update_content: { content_updates: [{ old_str: "- [ ] Pay <b>rent</b>", new_str: "- [x] Pay <b>rent</b>" }] } },
  }]);
  // Back on, from the line as read before the tick.
  sent.length = 0;
  await setDone("t", todo, null, false);
  assert.deepEqual((sent[0].body as { update_content: unknown }).update_content, {
    content_updates: [{ old_str: "- [x] Pay <b>rent</b>", new_str: "- [ ] Pay <b>rent</b>" }],
  });
  // Notion finds no such line any more: the block is looked up instead.
  sent.length = 0;
  refuse = true;
  await setDone("t", todo, null, true);
  assert.deepEqual(sent.map((c) => c.url.replace(/\?.*/, "")), ["pages/pg/markdown", "blocks/pg/children", "blocks/b0"]);
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
  await assert.rejects(call("t", "GET", "a", undefined, { timeoutMs: 10 }), /timeout/);
  await call("t", "GET", "b");
  assert.equal(most, 1);
});

test("the walk to a to-do stops at it: what lies after is not read", async () => {
  const children: Record<string, unknown[]> = {
    pg2: [
      { id: "a0", type: "to_do", to_do: { rich_text: [{ plain_text: "First" }] }, has_children: true },
      { id: "a1", type: "to_do", to_do: { rich_text: [{ plain_text: "Second" }] } },
    ],
    a0: [{ id: "a2", type: "to_do", to_do: { rich_text: [{ plain_text: "Under first" }] } }],
  };
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url).replace(/.*v1\//, "").replace(/\?.*/, ""));
    const m = /blocks\/([^/]+)\/children/.exec(String(url));
    const body = m ? { results: children[m[1]] ?? [], has_more: false } : {};
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  await setDone("t", { kind: "todo", id: "pg2/0/First", title: "First", page: "pg2", index: 0 }, null, true);
  assert.deepEqual(calls, ["blocks/pg2/children", "blocks/a0"]);
});

test("a start page that is a database is opened once: five requests, its rows read", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const path = String(url).replace(/.*v1\//, "").replace(/\?.*/, "");
    calls.push(path);
    let body: unknown = {};
    if (path === "databases/db") body = { object: "database", title: [{ plain_text: "Tasks" }], data_sources: [{ id: "ds" }] };
    else if (path === "views") body = { results: [{ object: "view", id: "v" }] };
    else if (path === "views/v") body = { object: "view", id: "v", type: "table", data_source_id: "ds", sorts: null };
    else if (path === "data_sources/ds") {
      body = { object: "data_source", id: "ds", properties: { Name: { id: "title", name: "Name", type: "title" }, Done: { id: "d", name: "Done", type: "checkbox" } } };
    } else if (path === "data_sources/ds/query") body = { results: [{ object: "page", id: "r1", properties: { Name: { id: "title", title: [{ plain_text: "Row" }] }, Done: { id: "d", checkbox: false } } }], has_more: false };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  const loaded = await readView("t", { kind: "start", id: "db" }, "all", new Date(), new Map(), () => true);
  assert.deepEqual(calls, ["databases/db", "views", "views/v", "data_sources/ds", "data_sources/ds/query"]);
  assert.equal(loaded.view.kind, "database");
  assert.deepEqual(loaded.entries.map((e) => e.title), ["Row"]);
});
