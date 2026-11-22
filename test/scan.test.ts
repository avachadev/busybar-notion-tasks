import assert from "node:assert/strict";
import { test } from "node:test";

import { SearchScan } from "../src/scan.ts";

/** Rich text as Notion writes it, one part per string. */
const rich = (...parts: string[]) => parts.map((p) => ({
  type: "text",
  text: { content: p, link: null },
  annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
  plain_text: p,
  href: null,
}));
const user = { object: "user", id: "00000000-0000-0000-0000-0000000000aa" };
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

/** A page in the key order Notion sends (measured 22.11.2026). */
function page(n: number, parent: Record<string, unknown>, title: string[], extra: { cover?: unknown; icon?: unknown } = {}) {
  return {
    object: "page",
    id: id(n),
    created_time: "2026-11-22T15:42:00.000Z",
    last_edited_time: "2026-11-22T15:47:00.000Z",
    created_by: user,
    last_edited_by: user,
    cover: extra.cover ?? null,
    icon: extra.icon ?? null,
    parent,
    in_trash: false,
    is_archived: false,
    is_locked: false,
    properties: { Name: { id: "title", type: "title", title: rich(...title) } },
    url: `https://app.notion.com/p/${id(n).replace(/-/g, "")}`,
    public_url: null,
  };
}

function dataSource(n: number, database: number, top: boolean) {
  return {
    object: "data_source",
    id: id(n),
    cover: null,
    icon: null,
    created_time: "2026-11-22T15:41:00.000Z",
    created_by: user,
    last_edited_by: user,
    last_edited_time: "2026-11-22T15:41:00.000Z",
    title: rich("People wwww"),
    description: [],
    is_inline: false,
    properties: { Kind: { id: "k", name: "Kind", type: "select", select: { options: Array.from({ length: 40 }, (_, i) => ({ id: `o${i}`, name: `workspace ${i}`, color: "gray" })) } } },
    parent: { type: "database_id", database_id: id(database) },
    database_parent: top ? { type: "workspace", workspace: true } : { type: "page_id", page_id: id(9) },
    url: `https://app.notion.com/p/${id(database).replace(/-/g, "")}`,
  };
}

const WORKSPACE = { type: "workspace", workspace: true };
const longUrl = "https://www.example.com/" + "w".repeat(700) + ".png";

const ANSWER = JSON.stringify({
  object: "list",
  results: [
    page(1, { type: "page_id", page_id: id(2) }, ["A row about the workspace"]),
    page(2, WORKSPACE, ["Списки дел"]),
    page(3, { type: "data_source_id", data_source_id: id(8), database_id: id(7) }, ["wow"]),
    page(4, WORKSPACE, ["Quotes \"here\" and \\ slash ", "and a second part"], { cover: { type: "external", external: { url: longUrl } }, icon: { type: "emoji", emoji: "📄" } }),
    page(5, WORKSPACE, []),
    dataSource(6, 10, true),
    dataSource(11, 12, false),
    page(13, { type: "block_id", block_id: id(14) }, ["Workspace in a toggle"]),
  ],
  next_cursor: id(99),
  has_more: true,
  type: "page_or_data_source",
  page_or_data_source: {},
  request_id: "r",
});

const BYTES = new TextEncoder().encode(ANSWER);

function scan(bytes: Uint8Array, size: number): SearchScan {
  const s = new SearchScan();
  for (let i = 0; i < bytes.length; i += size) s.feed(bytes.subarray(i, i + size));
  s.end();
  return s;
}

const EXPECTED = [
  { kind: "page", id: id(2), title: "Списки дел", icon: "" },
  { kind: "page", id: id(4), title: "Quotes \"here\" and \\ slash and a second part", icon: "📄" },
  { kind: "page", id: id(5), title: null, icon: "" },
  { kind: "database", id: id(10), title: null, icon: "" },
];

test("top-level pages and databases are found, with their ids and the pages' titles, whatever the chunks", () => {
  for (const size of [BYTES.length, 1460, 1369, 64, 13, 7, 3, 2, 1]) {
    const s = scan(BYTES, size);
    assert.deepEqual(s.found, EXPECTED, `chunks of ${size}`);
    assert.equal(s.odd, 0);
    assert.equal(s.cursor, id(99));
    assert.equal(s.hasMore, true);
  }
});

test("the last page of results has no cursor", () => {
  const s = scan(new TextEncoder().encode(JSON.stringify({ object: "list", results: [page(1, WORKSPACE, ["Only"])], next_cursor: null, has_more: false })), 50);
  assert.deepEqual(s.found, [{ kind: "page", id: id(1), title: "Only", icon: "" }]);
  assert.equal(s.cursor, null);
  assert.equal(s.hasMore, false);
});

test("a result in a key order the scan does not expect is counted, not guessed at", () => {
  const odd = JSON.stringify({ object: "list", results: [{ parent: WORKSPACE, object: "page", id: id(1) }], next_cursor: null, has_more: false });
  const s = scan(new TextEncoder().encode(odd), 1000);
  assert.deepEqual(s.found, []);
  assert.equal(s.odd, 1);
});

test("a scan of shared data sources takes each database with its title, icon and parent, whatever the chunks", () => {
  const source = (n: number, database: number, parent: Record<string, unknown>, title: string[], icon: unknown = null) => ({
    ...dataSource(n, database, true),
    icon,
    title: rich(...title),
    // A schema full of `_`, as real ones are.
    properties: { Due_date: { id: "d_d", name: "Due_date", type: "date", date: {} }, Status: { id: "s_s", name: "Status", type: "status", status: { options: [{ id: "o_1", name: "not_started", color: "default" }] } } },
    database_parent: parent,
  });
  const answer = new TextEncoder().encode(JSON.stringify({
    object: "list",
    results: [
      source(20, 21, WORKSPACE, ["Tasks"]),
      source(22, 23, { type: "page_id", page_id: id(24) }, ["Shared \"by\" itself"], { type: "emoji", emoji: "✅" }),
      source(25, 26, { type: "block_id", block_id: id(27) }, []),
    ],
    next_cursor: null,
    has_more: false,
    type: "page_or_data_source",
    page_or_data_source: {},
  }));
  const expected = [
    { kind: "database", id: id(21), title: "Tasks", icon: "", parent: "", parentType: "" },
    { kind: "database", id: id(23), title: "Shared \"by\" itself", icon: "✅", parent: id(24), parentType: "page_id" },
    { kind: "database", id: id(26), title: null, icon: "", parent: id(27), parentType: "block_id" },
  ];
  for (const size of [answer.length, 1460, 64, 13, 3, 1]) {
    const s = new SearchScan(true);
    for (let i = 0; i < answer.length; i += size) s.feed(answer.subarray(i, i + size));
    s.end();
    assert.deepEqual(s.found, expected, `chunks of ${size}`);
    assert.equal(s.odd, 0);
    assert.equal(s.hasMore, false);
  }
});

test("a top-level page in the trash is not taken, and the first and last results' edit times are read", () => {
  const at = (p: ReturnType<typeof page>, edited: string, trashed = false) => ({ ...p, last_edited_time: edited, in_trash: trashed });
  const answer = new TextEncoder().encode(JSON.stringify({
    object: "list",
    results: [
      at(page(30, WORKSPACE, ["Trashed"]), "2026-11-22T16:05:00.000Z", true),
      at(page(31, WORKSPACE, ["Kept"]), "2026-11-22T16:01:00.000Z"),
      at(page(32, { type: "page_id", page_id: id(31) }, ["Under"]), "2026-11-22T15:10:00.000Z"),
    ],
    next_cursor: id(33),
    has_more: true,
    type: "page_or_data_source",
    page_or_data_source: {},
  }));
  for (const size of [answer.length, 1460, 100, 7]) {
    const s = new SearchScan();
    for (let i = 0; i < answer.length; i += size) s.feed(answer.subarray(i, i + size));
    s.end();
    assert.deepEqual(s.found.map((f) => f.title), ["Kept"], `chunks of ${size}`);
    assert.equal(s.lastEdited, "2026-11-22T15:10:00.000Z");
    // Found whole in one chunk only; a time split by a chunk's edge is let go.
    if (size >= 1460) assert.equal(s.firstEdited, "2026-11-22T16:05:00.000Z");
  }
});
