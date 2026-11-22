import assert from "node:assert/strict";
import { test } from "node:test";

import { foundInSearch, hasTag, lower, mergeRoots, rootsInSearch, pickRoots, localDate, localDayStart, openFirst, plainText, queryBody, queryPath, readSchema, readViewInfo, setDoneCall, tasksFromQuery } from "../src/tasks.ts";

const rt = (s: string) => [{ type: "text", plain_text: s }];

const checkboxDb = {
  properties: {
    Name: { id: "title", name: "Name", type: "title", title: {} },
    Done: { id: "a%3Ab", name: "Done", type: "checkbox", checkbox: {} },
    Due: { id: "d%40e", name: "Due", type: "date", date: {} },
    Created: { id: "c1", name: "Created", type: "date", date: {} },
  },
};

// A Russian workspace's status property, written as escapes to keep the source ASCII:
// "Task", "Status", "Not started", "In progress", "Done", "Cancelled".
const statusDb = {
  properties: {
    "\u0417\u0430\u0434\u0430\u0447\u0430": { id: "title", name: "\u0417\u0430\u0434\u0430\u0447\u0430", type: "title", title: {} },
    "\u0421\u0442\u0430\u0442\u0443\u0441": {
      id: "st",
      name: "\u0421\u0442\u0430\u0442\u0443\u0441",
      type: "status",
      status: {
        default_option: "\u041d\u0435 \u043d\u0430\u0447\u0430\u0442\u043e",
        options: [
          { id: "o1", name: "\u041d\u0435 \u043d\u0430\u0447\u0430\u0442\u043e", color: "default" },
          { id: "o2", name: "\u0412 \u0440\u0430\u0431\u043e\u0442\u0435", color: "blue" },
          { id: "o3", name: "\u0413\u043e\u0442\u043e\u0432\u043e", color: "green" },
          { id: "o4", name: "\u041e\u0442\u043c\u0435\u043d\u0435\u043d\u043e", color: "red" },
        ],
        // Group names as an old Russian workspace keeps them: groups are told by their place.
        groups: [
          { id: "g1", name: "\u041a \u0432\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u0438\u044e", option_ids: ["o1"] },
          { id: "g2", name: "\u0412 \u0440\u0430\u0431\u043e\u0442\u0435", option_ids: ["o2"] },
          { id: "g3", name: "\u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u043e", option_ids: ["o3", "o4"] },
        ],
      },
    },
  },
};

test("a checkbox named Done and the due date win", () => {
  assert.deepEqual(readSchema(checkboxDb), { titleId: "title", done: { kind: "checkbox", id: "a%3Ab" }, dateId: "d%40e" });
});

test("a status uses its Complete group", () => {
  assert.deepEqual(readSchema(statusDb), {
    titleId: "title",
    done: {
      kind: "status",
      id: "st",
      options: [
        { name: "\u041d\u0435 \u043d\u0430\u0447\u0430\u0442\u043e", color: "default", group: "todo" },
        { name: "\u0412 \u0440\u0430\u0431\u043e\u0442\u0435", color: "blue", group: "progress" },
        { name: "\u0413\u043e\u0442\u043e\u0432\u043e", color: "green", group: "done" },
        { name: "\u041e\u0442\u043c\u0435\u043d\u0435\u043d\u043e", color: "red", group: "done" },
      ],
      doneNames: ["\u0413\u043e\u0442\u043e\u0432\u043e", "\u041e\u0442\u043c\u0435\u043d\u0435\u043d\u043e"],
      closeTo: "\u0413\u043e\u0442\u043e\u0432\u043e",
      openNames: ["\u041d\u0435 \u043d\u0430\u0447\u0430\u0442\u043e", "\u0412 \u0440\u0430\u0431\u043e\u0442\u0435"],
      openTo: "\u041d\u0435 \u043d\u0430\u0447\u0430\u0442\u043e",
      asCheckbox: false,
    },
    dateId: null,
  });
});

test("a database with nothing to tick shows its rows as pages, in every row", () => {
  const schema = readSchema({ properties: { Name: { id: "title", type: "title" } } })!;
  assert.deepEqual(schema, { titleId: "title", done: null, dateId: null });
  assert.equal(readSchema({ properties: {} }), null);
  const body = queryBody(schema, "today", "2026-11-06", START);
  assert.equal(body.filter, undefined);
  assert.equal(queryPath("ds", schema), "data_sources/ds/query?filter_properties=title");
  const rows = tasksFromQuery({ results: [{ object: "page", id: "p", properties: { Name: { id: "title", title: rt("Notes") } } }] }, schema);
  assert.deepEqual(rows, [{ kind: "page", id: "p", title: "Notes" }]);
});

test("a status row carries its option and colour; one shown as a checkbox does not", () => {
  const schema = readSchema(statusDb)!;
  assert.equal(hasTag(schema.done), true);
  const page = (name: string) => ({ object: "page", id: "p", properties: { T: { id: "title", title: rt("A") }, S: { id: "st", status: { name } } } });
  const [doing] = tasksFromQuery({ results: [page("\u0412 \u0440\u0430\u0431\u043e\u0442\u0435")] }, schema);
  assert.deepEqual(doing, { kind: "row", id: "p", title: "A", done: false, tag: "\u0412 \u0440\u0430\u0431\u043e\u0442\u0435", color: "blue" });
  const [cancelled] = tasksFromQuery({ results: [page("\u041e\u0442\u043c\u0435\u043d\u0435\u043d\u043e")] }, schema);
  assert.equal(cancelled.done, true);

  const asBox = readSchema(statusDb, { sorts: null, groupBy: null, checkboxIds: ["st"] })!;
  assert.equal(hasTag(asBox.done), false);
  assert.deepEqual(tasksFromQuery({ results: [page("\u0413\u043e\u0442\u043e\u0432\u043e")] }, asBox), [{ kind: "row", id: "p", title: "A", done: true }]);
});

test("a status is written by the option chosen", () => {
  const db = { dataSourceId: "ds", schema: readSchema(statusDb)!, sorts: null };
  const row = { kind: "row" as const, id: "p1", title: "" };
  assert.deepEqual(setDoneCall(row, db, false, "p1", "\u0412 \u0440\u0430\u0431\u043e\u0442\u0435")?.body, {
    properties: { st: { status: { name: "\u0412 \u0440\u0430\u0431\u043e\u0442\u0435" } } },
  });
});

test("the view's grouping picks the field and its sorts the order", () => {
  const db = {
    properties: {
      Name: { id: "title", name: "Name", type: "title", title: {} },
      Done: { id: "dn", name: "Done", type: "checkbox", checkbox: {} },
      Stage: { id: "sg", name: "Stage", type: "select", select: { options: [{ name: "Todo", color: "gray" }, { name: "Done", color: "green" }] } },
    },
  };
  assert.equal(readSchema(db)!.done!.kind, "checkbox");
  const sorts = [{ property: "Name", direction: "descending" }];
  const info = readViewInfo({ sorts, configuration: { group_by: { property_id: "sg" }, properties: [] } });
  assert.deepEqual(info, { sorts, groupBy: "sg", checkboxIds: [] });
  const schema = readSchema(db, info)!;
  assert.equal(schema.done!.kind, "select");
  assert.deepEqual(queryBody(schema, "all", "2026-11-06", START, info.sorts).sorts, sorts);
  assert.deepEqual(readViewInfo({ sorts: [], configuration: {} }), { sorts: null, groupBy: null, checkboxIds: [] });
});

const START = "2026-11-06T00:00:00+03:00";
const editedToday = { timestamp: "last_edited_time", last_edited_time: { on_or_after: START } };

test("the query asks for open tasks due by today or undated and the ones closed today, soonest first", () => {
  const schema = readSchema(checkboxDb)!;
  const due = { property: "d%40e", date: { on_or_before: "2026-11-06" } };
  const undated = { property: "d%40e", date: { is_empty: true } };
  const open = { property: "a%3Ab", checkbox: { equals: false } };
  const closed = { property: "a%3Ab", checkbox: { equals: true } };
  assert.deepEqual(queryBody(schema, "today", "2026-11-06", START), {
    filter: {
      or: [
        { and: [open, due] },
        { and: [open, undated] },
        { and: [closed, due, editedToday] },
        { and: [closed, undated, editedToday] },
      ],
    },
    page_size: 20,
    sorts: [
      { property: "d%40e", direction: "ascending" },
      { timestamp: "created_time", direction: "ascending" },
    ],
  });
  const all = queryBody(schema, "all", "2026-11-06", START) as { filter: { or: { and: unknown[] }[] } };
  assert.equal(all.filter.or[0].and.length, 1);
  assert.equal(queryPath("ds", schema), "data_sources/ds/query?filter_properties=title&filter_properties=a%3Ab");
});

test("a status query tells open from done by every option", () => {
  const body = queryBody(readSchema(statusDb)!, "today", "2026-11-06", START) as { filter: { or: { and: unknown[] }[] } };
  assert.deepEqual(body.filter.or[0].and, [
    { property: "st", status: { does_not_equal: "\u0413\u043e\u0442\u043e\u0432\u043e" } },
    { property: "st", status: { does_not_equal: "\u041e\u0442\u043c\u0435\u043d\u0435\u043d\u043e" } },
  ]);
  assert.deepEqual(body.filter.or[1].and, [
    { property: "st", status: { does_not_equal: "\u041d\u0435 \u043d\u0430\u0447\u0430\u0442\u043e" } },
    { property: "st", status: { does_not_equal: "\u0412 \u0440\u0430\u0431\u043e\u0442\u0435" } },
    editedToday,
  ]);
});

test("local midnight carries the bar's offset", () => {
  assert.match(localDayStart(new Date(2026, 10, 6, 15, 0)), /^2026-11-06T00:00:00[+-]\d\d:\d\d$/);
});

test("reads titles from query results", () => {
  const schema = readSchema(checkboxDb)!;
  const tasks = tasksFromQuery(
    {
      results: [
        { object: "page", id: "p1", properties: { Name: { id: "title", type: "title", title: rt("Write  brief ") }, Done: { id: "a%3Ab", type: "checkbox", checkbox: false } } },
        { object: "page", id: "p2", properties: { Name: { id: "title", type: "title", title: [] }, Done: { id: "a%3Ab", type: "checkbox", checkbox: true } } },
        { object: "page", id: "p3", in_trash: true, properties: {} },
      ],
    },
    schema,
  );
  assert.deepEqual(tasks, [
    { kind: "row", id: "p1", title: "Write brief", done: false },
    { kind: "row", id: "p2", title: "Untitled", done: true },
  ]);
});

const searchPage = (id: string, parent: Record<string, unknown>, title: string) => ({
  object: "page",
  id,
  parent,
  properties: { title: { type: "title", title: rt(title) } },
});

test("top-level pages are the ones under the workspace", () => {
  const found = foundInSearch({
    results: [
      searchPage("r", { type: "workspace", workspace: true }, "Lists"),
      searchPage("c", { type: "page_id", page_id: "r" }, "2025"),
      { object: "page", id: "t", in_trash: true, parent: { type: "workspace" }, properties: {} },
    ],
  });
  assert.deepEqual(pickRoots(found, true), [{ kind: "page", id: "r", title: "Lists" }]);
});

test("a page shared deeper down counts as top level once the search is complete", () => {
  // An internal connection shared with "Tasks", which lives under a page it cannot see.
  const found = foundInSearch({
    results: [
      searchPage("tasks", { type: "page_id", page_id: "hidden" }, "Tasks"),
      searchPage("sub", { type: "page_id", page_id: "tasks" }, "Today"),
      searchPage("row", { type: "data_source_id", data_source_id: "ds" }, "A database row"),
    ],
  });
  assert.deepEqual(pickRoots(found, true).map((e) => e.id), ["tasks"]);
  // With results left unread the parent may just be further on, so only the workspace counts.
  assert.deepEqual(pickRoots(found, false), []);
});

test("a page inside a toggle or a column is not top level: its page shows it", () => {
  const found = foundInSearch({ results: [searchPage("in-toggle", { type: "block_id", block_id: "t" }, "Notes")] });
  assert.deepEqual(pickRoots(found, true), []);
});

const selectDb = {
  properties: {
    Name: { id: "title", name: "Name", type: "title", title: {} },
    Stage: { id: "sg", name: "Stage", type: "select", select: { options: [{ name: "Todo" }, { name: "Doing" }, { name: "Done" }] } },
  },
};

test("a select with a Done option marks tasks done", () => {
  const schema = readSchema(selectDb)!;
  assert.deepEqual(schema.done, {
    kind: "select",
    id: "sg",
    options: [
      { name: "Todo", color: "default", group: "todo" },
      { name: "Doing", color: "default", group: "progress" },
      { name: "Done", color: "default", group: "done" },
    ],
    doneName: "Done",
    openTo: "Todo",
  });
  const body = queryBody(schema, "all", "2026-11-06", START) as { filter: { or: { and: unknown[] }[] } };
  assert.deepEqual(body.filter.or[0].and, [{ property: "sg", select: { does_not_equal: "Done" } }]);
  assert.deepEqual(body.filter.or[1].and[0], { property: "sg", select: { equals: "Done" } });
  const rows = tasksFromQuery({
    results: [
      { object: "page", id: "a", properties: { Name: { id: "title", title: rt("A") }, Stage: { id: "sg", select: { name: "Done" } } } },
      { object: "page", id: "b", properties: { Name: { id: "title", title: rt("B") }, Stage: { id: "sg", select: null } } },
    ],
  }, schema);
  assert.deepEqual(rows.map((r) => r.done), [true, false]);
  const db = { dataSourceId: "ds", schema, sorts: null };
  const row = { kind: "row" as const, id: "a", title: "" };
  assert.deepEqual(setDoneCall(row, db, true)?.body, { properties: { sg: { select: { name: "Done" } } } });
  assert.deepEqual(setDoneCall(row, db, false)?.body, { properties: { sg: { select: { name: "Todo" } } } });
});

test("long titles are capped", () => {
  assert.equal(plainText(rt("x".repeat(500))).length, 80);
});

test("ticking a task off and back on", () => {
  const db = { dataSourceId: "ds", schema: readSchema(statusDb)!, sorts: null };
  const row = { kind: "row" as const, id: "p1", title: "" };
  assert.deepEqual(setDoneCall(row, db, true), { path: "pages/p1", body: { properties: { st: { status: { name: "\u0413\u043e\u0442\u043e\u0432\u043e" } } } } });
  assert.deepEqual(setDoneCall(row, db, false), { path: "pages/p1", body: { properties: { st: { status: { name: "\u041d\u0435 \u043d\u0430\u0447\u0430\u0442\u043e" } } } } });
  assert.deepEqual(setDoneCall({ kind: "todo", id: "b1", title: "" }, null, false), {
    path: "blocks/b1",
    body: { to_do: { checked: false } },
  });
  assert.equal(setDoneCall({ kind: "page", id: "p", title: "" }, null, true), null);
});

test("open rows come before closed ones", () => {
  const e = (id: string, done: boolean) => ({ kind: "row" as const, id, title: id, done });
  assert.deepEqual(openFirst([e("a", true), e("b", false), e("c", true), e("d", false)]).map((x) => x.id), ["b", "d", "a", "c"]);
});

test("today is the local date", () => {
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});

test("a quick check of the top level adds new pages and databases and renames the renamed", () => {
  const found = rootsInSearch({
    results: [
      searchPage("new", { type: "workspace", workspace: true }, "Inbox"),
      searchPage("deep", { type: "page_id", page_id: "x" }, "Deep"),
      { object: "data_source", title: rt("People"), parent: { type: "database_id", database_id: "db" }, database_parent: { type: "workspace", workspace: true } },
      { object: "data_source", title: rt("Inline"), parent: { type: "database_id", database_id: "db2" }, database_parent: { type: "page_id", page_id: "p" } },
      searchPage("a", { type: "workspace", workspace: true }, "Archive 2"),
    ],
  });
  assert.deepEqual(found.map((e) => e.id), ["new", "db", "a"]);
  const roots = [{ kind: "page" as const, id: "a", title: "Archive" }, { kind: "page" as const, id: "z", title: "Zoo" }];
  assert.deepEqual(mergeRoots(roots, found).map((e) => e.title), ["Archive 2", "Inbox", "People", "Zoo"]);
});

test("Russian is lowered without the runtime's help", () => {
  // The bar's toLowerCase leaves Cyrillic as it is; the test runs where it would not, so the result is what counts.
  assert.equal(lower("\u0413\u041e\u0422\u041e\u0412\u041e \u0401 Done"), "\u0433\u043e\u0442\u043e\u0432\u043e \u0451 done");
  const db = { properties: { T: { id: "t", type: "title" }, S: { id: "s", type: "select", select: { options: [{ name: "\u0412 \u0440\u0430\u0431\u043e\u0442\u0435" }, { name: "\u0413\u043e\u0442\u043e\u0432\u043e" }] } } } };
  assert.equal(readSchema(db)!.done!.kind, "select");
});

test("a row's emoji icon comes with it; a picture icon does not", () => {
  const schema = readSchema(checkboxDb)!;
  const rows = tasksFromQuery({
    results: [
      { object: "page", id: "a", icon: { type: "emoji", emoji: "\u{1f3af}" }, properties: { Name: { id: "title", title: rt("Aim") }, Done: { id: "a%3Ab", checkbox: false } } },
      { object: "page", id: "b", icon: { type: "external", external: { url: "https://x/y.png" } }, properties: { Name: { id: "title", title: rt("Pic") }, Done: { id: "a%3Ab", checkbox: false } } },
    ],
  }, schema);
  assert.equal(rows[0].icon, "\u{1f3af}");
  assert.equal(rows[1].icon, undefined);
});
