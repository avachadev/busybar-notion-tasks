/**
 * What the app shows of Notion, and how a task is closed.
 *
 * The bar browses Notion like its sidebar: a page lists its subpages, the
 * databases inside it and its to-dos, in the page's own order. A database
 * lists its open rows due today or earlier, then the ones closed today.
 * Subpages and databases open; tasks tick off and back on, as in Notion.
 *
 * Everything here is pure, so it is tested off the device; `source.ts` makes the calls.
 */

import type { Json } from "./notion.ts";

/** How a database marks a task done. */
export type DoneField =
  | { readonly kind: "checkbox"; readonly id: string }
  | {
      readonly kind: "status";
      readonly id: string;
      /** Options in the status's Complete group: any of them means done. */
      readonly doneNames: readonly string[];
      /** The option a task is set to when it is closed. */
      readonly closeTo: string;
      /** Every other option: a task in any of them is open. */
      readonly openNames: readonly string[];
      /** The option a task goes back to when it is reopened. */
      readonly openTo: string;
    };

export interface Schema {
  readonly titleId: string;
  readonly done: DoneField;
  /** The due date, when the database has a date property. */
  readonly dateId: string | null;
}

/** A database, resolved once to its data source and the properties that matter. */
export interface Database {
  readonly dataSourceId: string;
  readonly schema: Schema;
}

/**
 * One line on screen. `page` and `database` open; `todo` (a to-do block on a
 * page) and `row` (a database row) tick off and back on.
 */
export interface Entry {
  readonly kind: "page" | "database" | "todo" | "row";
  /** Block id for a subpage, an inline database and a to-do; page id for a row. */
  readonly id: string;
  readonly title: string;
  /** For a task: ticked off. */
  readonly done?: boolean;
}

/** Which tasks a database list shows. */
export type Scope = "today" | "all";

/** A title longer than this cannot be read on 72 px anyway, and only costs memory. */
const MAX_TITLE = 80;

// Russian names next to the English ones, written as escapes to keep the source ASCII:
// "done", "made", "completed"; below, "deadline", "date" and "done", "finished".
const DONE_NAMES = ["done", "complete", "completed", "finished", "\u0433\u043e\u0442\u043e\u0432\u043e", "\u0441\u0434\u0435\u043b\u0430\u043d\u043e", "\u0432\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u043e"];

function record(value: unknown): Json {
  return typeof value === "object" && value !== null ? (value as Json) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Plain text of a rich text array, trimmed and capped. */
export function plainText(richText: unknown): string {
  let out = "";
  for (const part of list(richText)) {
    out += str(record(part).plain_text);
    if (out.length > MAX_TITLE) break;
  }
  return out.replace(/\s+/g, " ").trim().substring(0, MAX_TITLE);
}

/**
 * Picks the title, the done field and the due date from a data source's
 * properties. A checkbox named like "Done" wins, then a status property, then
 * any checkbox. Returns null when nothing can mark a task done.
 */
export function readSchema(dataSource: Json): Schema | null {
  const props = record(dataSource.properties);
  let titleId = "";
  let namedCheckbox = "";
  let anyCheckbox = "";
  let status: DoneField | null = null;
  let dateId: string | null = null;
  let dueDateId: string | null = null;

  for (const key of Object.keys(props)) {
    const prop = record(props[key]);
    const id = str(prop.id);
    const name = str(prop.name || key).toLowerCase();
    const type = str(prop.type);
    if (type === "title") titleId = id;
    if (type === "checkbox") {
      if (!anyCheckbox) anyCheckbox = id;
      if (!namedCheckbox && DONE_NAMES.indexOf(name) >= 0) namedCheckbox = id;
    }
    if (type === "date") {
      if (dateId === null) dateId = id;
      if (dueDateId === null && /due|date|\u0441\u0440\u043e\u043a|\u0434\u0430\u0442\u0430|when|day/.test(name)) dueDateId = id;
    }
    if (type === "status" && status === null) {
      const config = record(prop.status);
      const options = list(config.options).map(record);
      const groups = list(config.groups).map(record);
      const complete = groups.find((g) => /complete|done|\u0433\u043e\u0442\u043e\u0432\u043e|\u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u043e/i.test(str(g.name))) ?? groups[groups.length - 1];
      const ids = complete ? list(complete.option_ids).map(str) : [];
      const doneNames = options.filter((o) => ids.indexOf(str(o.id)) >= 0).map((o) => str(o.name));
      const openNames = options.filter((o) => ids.indexOf(str(o.id)) < 0).map((o) => str(o.name));
      const fallback = str(config.default_option);
      const openTo = openNames.indexOf(fallback) >= 0 ? fallback : openNames[0];
      if (doneNames.length > 0 && openTo) status = { kind: "status", id, doneNames, closeTo: doneNames[0], openNames, openTo };
    }
  }

  if (!titleId) return null;
  const done: DoneField | null = namedCheckbox
    ? { kind: "checkbox", id: namedCheckbox }
    : status ?? (anyCheckbox ? { kind: "checkbox", id: anyCheckbox } : null);
  if (!done) return null;
  return { titleId, done, dateId: dueDateId ?? dateId };
}

/** "2026-11-06", by the bar's own clock and time zone. */
export function localDate(now: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Local midnight as an ISO timestamp with the bar's UTC offset: "2026-11-06T00:00:00+03:00". */
export function localDayStart(now: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  const offset = -now.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${localDate(now)}T00:00:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** How many rows one query asks for: more would not fit the app's memory, nor anyone's day. */
export const PAGE_SIZE = 20;

/** Filters that hold for open rows, or for done ones. A status needs one per option, since a filter cannot nest deeper. */
function doneFilters(field: DoneField, done: boolean): Json[] {
  if (field.kind === "checkbox") return [{ property: field.id, checkbox: { equals: done } }];
  const names = done ? field.openNames : field.doneNames;
  return names.map((name) => ({ property: field.id, status: { does_not_equal: name } }));
}

/**
 * The query body: open rows due by today unless the scope is everything, and
 * rows closed since midnight, so a task ticked off today can be ticked back on.
 * Notion has no "closed at", so the last edit stands in for it.
 */
export function queryBody(schema: Schema, scope: Scope, today: string, dayStart: string): Json {
  const due: Json[] = scope === "today" && schema.dateId !== null
    ? [{ property: schema.dateId, date: { on_or_before: today } }]
    : [];
  const open = doneFilters(schema.done, false).concat(due);
  const closed = doneFilters(schema.done, true).concat(due, [
    { timestamp: "last_edited_time", last_edited_time: { on_or_after: dayStart } },
  ]);

  const body: Json = { filter: { or: [{ and: open }, { and: closed }] }, page_size: PAGE_SIZE };
  if (schema.dateId !== null) {
    body.sorts = [
      { property: schema.dateId, direction: "ascending" },
      { timestamp: "created_time", direction: "ascending" },
    ];
  } else {
    body.sorts = [{ timestamp: "created_time", direction: "ascending" }];
  }
  return body;
}

/** `filter_properties` for the query string: only what the screen needs comes back. */
export function queryPath(dataSourceId: string, schema: Schema): string {
  const ids = [schema.titleId, schema.done.id];
  return `data_sources/${dataSourceId}/query?${ids.map((id) => `filter_properties=${id}`).join("&")}`;
}

function propertyById(page: Json, id: string): Json {
  const props = record(page.properties);
  for (const key of Object.keys(props)) {
    const prop = record(props[key]);
    if (str(prop.id) === id) return prop;
  }
  return {};
}

export function tasksFromQuery(response: Json, schema: Schema): Entry[] {
  const tasks: Entry[] = [];
  for (const item of list(response.results)) {
    const page = record(item);
    if (page.object !== "page" || page.in_trash === true) continue;
    const title = plainText(propertyById(page, schema.titleId).title) || "Untitled";
    const field = propertyById(page, schema.done.id);
    const done = schema.done.kind === "checkbox"
      ? field.checkbox === true
      : schema.done.doneNames.indexOf(str(record(field.status).name)) >= 0;
    tasks.push({ kind: "row", id: str(page.id), title, done });
  }
  return tasks;
}

/**
 * What one page of a page's blocks adds to the screen: subpages, databases and
 * to-dos, ticked or not, in order. Nested blocks are not read: a to-do inside a
 * toggle stays hidden.
 */
export function entriesFromBlocks(response: Json): Entry[] {
  const entries: Entry[] = [];
  for (const item of list(response.results)) {
    const block = record(item);
    if (block.in_trash === true) continue;
    const id = str(block.id);
    if (block.type === "child_page") {
      entries.push({ kind: "page", id, title: str(record(block.child_page).title).trim() || "Untitled" });
    } else if (block.type === "child_database") {
      entries.push({ kind: "database", id, title: str(record(block.child_database).title).trim() || "Untitled" });
    } else if (block.type === "to_do") {
      const todo = record(block.to_do);
      const title = plainText(todo.rich_text);
      if (title) entries.push({ kind: "todo", id, title, done: todo.checked === true });
    }
  }
  return entries;
}

/** The title of a page object, from whichever property is the title. */
export function pageTitle(page: Json): string {
  const props = record(page.properties);
  for (const key of Object.keys(props)) {
    const prop = record(props[key]);
    if (prop.type === "title") return plainText(prop.title);
  }
  return "";
}

/** A page from the search, with what it hangs off. */
export interface Found {
  readonly entry: Entry;
  /** "workspace", "page_id", "block_id", "data_source_id" or "database_id". */
  readonly parentType: string;
  readonly parentId: string;
}

/** Pages in one page of search results, with their parents. */
export function foundInSearch(response: Json): Found[] {
  const found: Found[] = [];
  for (const item of list(response.results)) {
    const page = record(item);
    if (page.object !== "page" || page.in_trash === true) continue;
    const parent = record(page.parent);
    const parentType = str(parent.type);
    found.push({
      entry: { kind: "page", id: str(page.id), title: pageTitle(page) || "Untitled" },
      parentType,
      parentId: str(parent[parentType]),
    });
  }
  return found;
}

/**
 * The top level, as the sidebar shows it: pages under the workspace. An
 * internal connection may be shared with a page deeper down; its parent is
 * then out of reach and never in the results. When the search was read to its
 * end, such pages count as top level too. Database rows never do.
 */
export function pickRoots(found: readonly Found[], searchedAll: boolean): Entry[] {
  const ids = new Set(found.map((f) => f.entry.id));
  const roots: Entry[] = [];
  for (const f of found) {
    if (f.parentType === "workspace") roots.push(f.entry);
    else if (searchedAll && (f.parentType === "page_id" || f.parentType === "block_id") && !ids.has(f.parentId)) {
      roots.push(f.entry);
    }
  }
  return roots;
}

/** The call that ticks a task off, or back on when `done` is false. */
export function setDoneCall(task: Entry, database: Database | null, done: boolean): { path: string; body: Json } | null {
  if (task.kind === "todo") return { path: `blocks/${task.id}`, body: { to_do: { checked: done } } };
  if (task.kind !== "row" || !database) return null;
  const field = database.schema.done;
  const value = field.kind === "checkbox"
    ? { checkbox: done }
    : { status: { name: done ? field.closeTo : field.openTo } };
  return { path: `pages/${task.id}`, body: { properties: { [field.id]: value } } };
}

/** Open tasks first, closed ones after, each group in the order Notion gave. Pages keep their own order. */
export function openFirst(entries: readonly Entry[]): Entry[] {
  return entries.filter((e) => !e.done).concat(entries.filter((e) => e.done === true));
}

export function isTask(entry: Entry): boolean {
  return entry.kind === "todo" || entry.kind === "row";
}
