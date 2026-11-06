import assert from "node:assert/strict";
import { test } from "node:test";

import { entriesFromBlocks, localDate, localDayStart, openFirst, plainText, queryBody, queryPath, readSchema, rootsFromSearch, setDoneCall, tasksFromQuery } from "../src/tasks.ts";

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
          { id: "o1", name: "\u041d\u0435 \u043d\u0430\u0447\u0430\u0442\u043e" },
          { id: "o2", name: "\u0412 \u0440\u0430\u0431\u043e\u0442\u0435" },
          { id: "o3", name: "\u0413\u043e\u0442\u043e\u0432\u043e" },
          { id: "o4", name: "\u041e\u0442\u043c\u0435\u043d\u0435\u043d\u043e" },
        ],
        groups: [
          { id: "g1", name: "To-do", option_ids: ["o1"] },
          { id: "g2", name: "In progress", option_ids: ["o2"] },
          { id: "g3", name: "Complete", option_ids: ["o3", "o4"] },
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
      doneNames: ["\u0413\u043e\u0442\u043e\u0432\u043e", "\u041e\u0442\u043c\u0435\u043d\u0435\u043d\u043e"],
      closeTo: "\u0413\u043e\u0442\u043e\u0432\u043e",
      openNames: ["\u041d\u0435 \u043d\u0430\u0447\u0430\u0442\u043e", "\u0412 \u0440\u0430\u0431\u043e\u0442\u0435"],
      openTo: "\u041d\u0435 \u043d\u0430\u0447\u0430\u0442\u043e",
    },
    dateId: null,
  });
});

test("nothing to tick means no schema", () => {
  assert.equal(readSchema({ properties: { Name: { id: "title", type: "title" } } }), null);
});

const START = "2026-11-06T00:00:00+03:00";
const editedToday = { timestamp: "last_edited_time", last_edited_time: { on_or_after: START } };

test("the query asks for open tasks due by today and the ones closed today, soonest first", () => {
  const schema = readSchema(checkboxDb)!;
  const due = { property: "d%40e", date: { on_or_before: "2026-11-06" } };
  assert.deepEqual(queryBody(schema, "today", "2026-11-06", START), {
    filter: {
      or: [
        { and: [{ property: "a%3Ab", checkbox: { equals: false } }, due] },
        { and: [{ property: "a%3Ab", checkbox: { equals: true } }, due, editedToday] },
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

test("a page lists its subpages, databases and to-dos, in order", () => {
  const entries = entriesFromBlocks({
    results: [
      { id: "h", type: "heading_2", heading_2: { rich_text: rt("Today") } },
      { id: "s", type: "child_page", child_page: { title: "\u0421\u0435\u043d\u0442\u044f\u0431\u0440\u044c" } },
      { id: "b1", type: "to_do", to_do: { rich_text: rt("Review PR"), checked: false } },
      { id: "b2", type: "to_do", to_do: { rich_text: rt("Done one"), checked: true } },
      { id: "b3", type: "to_do", to_do: { rich_text: [], checked: false } },
      { id: "d", type: "child_database", child_database: { title: "Tasks" } },
      { id: "x", type: "child_page", in_trash: true, child_page: { title: "Old" } },
    ],
  });
  assert.deepEqual(entries, [
    { kind: "page", id: "s", title: "\u0421\u0435\u043d\u0442\u044f\u0431\u0440\u044c" },
    { kind: "todo", id: "b1", title: "Review PR", done: false },
    { kind: "todo", id: "b2", title: "Done one", done: true },
    { kind: "database", id: "d", title: "Tasks" },
  ]);
});

test("top-level pages are the ones under the workspace", () => {
  const roots = rootsFromSearch({
    results: [
      { object: "page", id: "r", parent: { type: "workspace", workspace: true }, properties: { title: { type: "title", title: rt("\u0421\u043f\u0438\u0441\u043a\u0438 \u0434\u0435\u043b") } } },
      { object: "page", id: "c", parent: { type: "page_id", page_id: "r" }, properties: { title: { type: "title", title: rt("2025") } } },
      { object: "page", id: "t", in_trash: true, parent: { type: "workspace" }, properties: {} },
    ],
  });
  assert.deepEqual(roots, [{ kind: "page", id: "r", title: "\u0421\u043f\u0438\u0441\u043a\u0438 \u0434\u0435\u043b" }]);
});

test("long titles are capped", () => {
  assert.equal(plainText(rt("x".repeat(500))).length, 80);
});

test("ticking a task off and back on", () => {
  const db = { dataSourceId: "ds", schema: readSchema(statusDb)! };
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
