import assert from "node:assert/strict";
import { test } from "node:test";

import { Roots } from "../src/roots.ts";

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const user = { object: "user", id: id(900) };
const WORKSPACE = { type: "workspace", workspace: true };
const rich = (s: string) => [{ type: "text", text: { content: s, link: null }, annotations: {}, plain_text: s, href: null }];

function page(n: number, parent: unknown, title: string, trashed = false) {
  return {
    object: "page", id: id(n), created_time: "t", last_edited_time: "t", created_by: user, last_edited_by: user, cover: null, icon: null,
    parent, in_trash: trashed, is_archived: false, is_locked: false, properties: { Name: { id: "title", type: "title", title: rich(title) } }, url: "u",
  };
}
function dataSource(n: number, database: number) {
  return {
    object: "data_source", id: id(n), cover: null, icon: null, created_time: "t", created_by: user, last_edited_by: user, last_edited_time: "t",
    title: rich("x"), properties: {}, parent: { type: "database_id", database_id: id(database) }, database_parent: WORKSPACE, url: "u",
  };
}
const list = (results: unknown[], next: number | null) => ({ object: "list", results, next_cursor: next === null ? null : id(next), has_more: next !== null });

/** A fake Notion: answers by path and body, records what was asked. */
function fakeNotion(answer: (path: string, body: Record<string, unknown> | null) => { status?: number; json: unknown }) {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url).split("/v1/")[1];
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    asked.push(`${init?.method ?? "GET"} ${path}${body?.start_cursor ? ` @${String(body.start_cursor).slice(-3)}` : ""}`);
    const a = answer(path, body);
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200 });
  }) as typeof fetch;
  return asked;
}

const memory = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
};

const PERSONAL = { object: "user", type: "bot", bot: { owner: { type: "user" } } };
const always = () => true;

test("a sweep reads every page answer, then the data sources, and keeps only the top level", async () => {
  memory.clear();
  const asked = fakeNotion((path, body) => {
    if (path === "users/me") return { json: PERSONAL };
    if (path.startsWith("databases/")) return { json: { object: "database", title: rich("People"), parent: WORKSPACE } };
    const filter = (body?.filter ?? {}) as { value?: string };
    if (filter.value === "data_source") return { json: list([dataSource(50, 51)], null) };
    if (!body?.start_cursor) return { json: list([page(1, WORKSPACE, "Lists"), page(2, { type: "page_id", page_id: id(1) }, "Sub")], 3) };
    return { json: list([page(3, WORKSPACE, "Archive"), page(4, { type: "data_source_id", data_source_id: id(8) }, "Row")], null) };
  });
  const roots = new Roots("me");
  assert.equal(roots.sweepDue(0), false, "not before the token's kind is known");
  await roots.whoami("t", always);
  assert.equal(roots.searching, true);
  assert.equal(roots.sweepDue(0), true);
  assert.equal(await roots.sweep("t", 1000), true);
  assert.equal(await roots.sweep("t", 2000), true);
  assert.equal(await roots.sweep("t", 3000), true);
  assert.equal(roots.sweepDue(3000 + 60_000), false);
  assert.deepEqual(roots.entries().map((e) => [e.kind, e.title]), [["page", "Archive"], ["page", "Lists"], ["database", "People"]]);
  assert.deepEqual(asked, [
    "GET users/me",
    "POST search?filter_properties=title",
    "POST search?filter_properties=title @003",
    "POST search?filter_properties=title",
    `GET databases/${id(51)}`,
  ]);
  // A day later a new pass starts from the first answer.
  assert.equal(roots.sweepDue(3000 + 24 * 3600 * 1000), true);
});

test("the checks add new and renamed ones, drop trashed, moved and deleted ones", async () => {
  memory.clear();
  let renamed = false;
  fakeNotion((path, body) => {
    if (path === "users/me") return { json: PERSONAL };
    if (path.startsWith("search") && (body?.filter as { in_trash?: boolean } | undefined)?.in_trash) {
      return { json: list([page(2, WORKSPACE, "Gone", true)], null) };
    }
    if (path.startsWith("search") && !body?.filter) return { json: list([page(1, WORKSPACE, renamed ? "Lists 2" : "Lists"), page(5, WORKSPACE, "New")], null) };
    if (path.startsWith("search")) return { json: list([page(1, WORKSPACE, "Lists"), page(2, WORKSPACE, "Gone"), page(3, WORKSPACE, "Moved"), page(4, WORKSPACE, "Deleted")], null) };
    if (path === `pages/${id(3)}`) return { json: page(3, { type: "page_id", page_id: id(1) }, "Moved") };
    if (path === `pages/${id(4)}`) return { status: 404, json: { object: "error", status: 404, code: "object_not_found", message: "x" } };
    if (path === `pages/${id(1)}`) return { json: page(1, WORKSPACE, "Lists 3") };
    if (path === `pages/${id(5)}`) return { json: page(5, WORKSPACE, "New") };
    return { json: list([], null) };
  });
  const roots = new Roots("me");
  await roots.whoami("t", always);
  await roots.sweep("t", 1);
  assert.deepEqual(roots.entries().map((e) => e.title), ["Deleted", "Gone", "Lists", "Moved"]);
  renamed = true;
  assert.equal(await roots.recent("t", always), true);
  assert.deepEqual(roots.entries().map((e) => e.title), ["Deleted", "Gone", "Lists 2", "Moved", "New"]);
  assert.equal(await roots.trash("t", always), true);
  assert.deepEqual(roots.entries().map((e) => e.title), ["Deleted", "Lists 2", "Moved", "New"]);
  // One kept root a check, in turn: Lists 2 (renamed), Moved (gone), Deleted (404), New.
  const checks: boolean[] = [];
  for (let i = 0; i < 4; i += 1) checks.push(await roots.check("t", always));
  assert.deepEqual(roots.entries().map((e) => e.title).sort(), ["Lists 3", "New"]);
  assert.ok(checks.filter(Boolean).length >= 3);
});

test("the list and the sweep's place are saved, and read back for the same token only", async () => {
  memory.clear();
  fakeNotion((path) => (path === "users/me" ? { json: PERSONAL } : { json: list([page(1, WORKSPACE, "Lists")], 2) }));
  const roots = new Roots("me");
  await roots.whoami("t", always);
  await roots.sweep("t", 1);
  roots.save();
  const again = new Roots("me");
  assert.deepEqual(again.entries().map((e) => e.title), ["Lists"]);
  assert.equal(again.sweepDue(1), true, "the pass goes on from its cursor");
  assert.deepEqual(new Roots("someone else").entries(), []);
});

test("an internal connection is not swept: its top level is read the old way", async () => {
  memory.clear();
  fakeNotion(() => ({ json: { object: "user", type: "bot", bot: { owner: { type: "workspace", workspace: true } } } }));
  const roots = new Roots("me");
  assert.equal(await roots.whoami("t", always), true);
  assert.equal(roots.sweepDue(0), false);
  // Nothing shared yet: the screen says so, it does not wait for a pass that never comes.
  assert.equal(roots.searching, false);
});
