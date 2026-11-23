/**
 * What the app shows of Notion, and how a task is closed.
 *
 * The bar browses Notion like its sidebar: a page lists its subpages, the
 * databases inside it and its to-dos, in the page's own order (`markdown.ts`). A database
 * lists its open rows due today or earlier, then the ones closed today.
 * Subpages and databases open; tasks tick off and back on, as in Notion.
 *
 * Everything here is pure, so it is tested off the device; `source.ts` makes the calls.
 */

import type { Json } from "./notion.ts";

/** Where a status option sits: Notion's three groups, in their order. */
export type Group = "todo" | "progress" | "done";

/** An option of a status or a select: its name, Notion's colour name for it, and its group. */
export interface Option {
  readonly name: string;
  readonly color: string;
  readonly group: Group;
}

/** How a database marks a task done. */
export type DoneField =
  | { readonly kind: "checkbox"; readonly id: string }
  | {
      readonly kind: "status";
      readonly id: string;
      /** Every option, in the schema's order, with its group. */
      readonly options: readonly Option[];
      /** Options in the status's Complete group: any of them means done. */
      readonly doneNames: readonly string[];
      /** The option a task is set to when it is closed. */
      readonly closeTo: string;
      /** Every other option: a task in any of them is open. */
      readonly openNames: readonly string[];
      /** The option a task goes back to when it is reopened. */
      readonly openTo: string;
      /** The view shows it as a checkbox: then the row has one, and ticks between closeTo and openTo. */
      readonly asCheckbox: boolean;
    }
  | {
      readonly kind: "select";
      readonly id: string;
      readonly options: readonly Option[];
      /** The option that means done. */
      readonly doneName: string;
      /** The option a task goes back to when it is reopened; null leaves it empty. */
      readonly openTo: string | null;
    };

export interface Schema {
  readonly titleId: string;
  /** Null: nothing marks a row done, and the rows are shown as pages. */
  readonly done: DoneField | null;
  /** The due date, when the database has a date property. */
  readonly dateId: string | null;
}

/** What the app takes from a database's view (`GET /v1/views/{id}`): its order and how it shows the status. */
export interface ViewInfo {
  /** The view's sorts, as a query takes them; null when it has none (a manual order). */
  readonly sorts: Json[] | null;
  /** The property the view groups by. */
  readonly groupBy: string | null;
  /** Properties the view shows as a checkbox (`status_show_as`). */
  readonly checkboxIds: readonly string[];
}

/** A database, resolved once to its data source, the properties that matter and its view's order. */
export interface Database {
  readonly dataSourceId: string;
  readonly schema: Schema;
  readonly sorts: Json[] | null;
}

/**
 * One line on screen. `page` and `database` open; `todo` (a to-do block on a
 * page) and `row` (a database row) tick off and back on; `toggle` shows or
 * hides what is inside it; `heading` only names a part of the page.
 */
export interface Entry {
  readonly kind: "page" | "database" | "todo" | "row" | "toggle" | "heading";
  /** Block id for a subpage, an inline database and a to-do; page id for a row. */
  readonly id: string;
  readonly title: string;
  /** For a task: ticked off. */
  readonly done?: boolean;
  /** For a to-do read from a page's markdown: the page, and its place among the page's to-dos. */
  readonly page?: string;
  readonly index?: number;
  /** Its markdown line, `- [ ] ...`, when no other line of the page contains it: then it can be ticked by text. */
  readonly line?: string;
  /** How deep it sits on the page: under to-dos and inside toggles. */
  readonly depth?: number;
  /** The toggles it is inside, outermost first: it shows when all of them are open. */
  readonly toggles?: readonly string[];
  /** For a toggle: the open tasks inside it, however deep. */
  readonly count?: number;
  /** For a row of a database with a status or a select: the option it is in, and its colour name. */
  readonly tag?: string;
  readonly color?: string;
  /** For a to-do: the page or database its text links, which OK can open. */
  readonly link?: string;
  /** The page's or database's icon, when it is an emoji (drawn from `emoji.ts`'s packs). */
  readonly icon?: string;
}

/** Which tasks a database list shows. */
export type Scope = "today" | "all";

/** A title longer than this cannot be read on 72 px anyway, and only costs memory. */
export const MAX_TITLE = 80;

// Russian names next to the English ones, written as escapes to keep the source ASCII:
// "done", "made", "completed"; below, "deadline", "date" and "done", "finished".
const DONE_NAMES = ["done", "complete", "completed", "finished", "\u0433\u043e\u0442\u043e\u0432\u043e", "\u0441\u0434\u0435\u043b\u0430\u043d\u043e", "\u0432\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u043e"];

/**
 * A name meaning "done": its letters only, lower case, so "✅ Done" and
 * "Done!" count; emoji, digits, spaces and punctuation are dropped.
 */
export function doneLike(name: string): boolean {
  const l = lower(name);
  let letters = "";
  for (let i = 0; i < l.length; i += 1) {
    const c = l.charCodeAt(i);
    if ((c >= 0x61 && c <= 0x7a) || (c >= 0x430 && c <= 0x44f) || c === 0x451) letters += l.charAt(i);
  }
  return DONE_NAMES.indexOf(letters) >= 0;
}

/**
 * Lower case, Russian included. The bar's JavaScript lowers ASCII only:
 * measured 22.11.2026 on 1.4.1, "\u0413\u043e\u0442\u043e\u0432\u043e".toLowerCase() comes back unchanged.
 */
export function lower(s: string): string {
  const l = s.toLowerCase();
  if (!/[\u0400-\u042f]/.test(l)) return l;
  let out = "";
  for (let i = 0; i < l.length; i += 1) {
    const c = l.charCodeAt(i);
    out += c >= 0x410 && c <= 0x42f ? String.fromCharCode(c + 0x20) : c >= 0x400 && c <= 0x40f ? String.fromCharCode(c + 0x50) : l.charAt(i);
  }
  return out;
}

function record(value: unknown): Json {
  return typeof value === "object" && value !== null ? (value as Json) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** An object's icon when it is an emoji (`{"type":"emoji","emoji":"..."}`), else "": an uploaded or linked picture cannot be drawn on the bar. */
export function emojiOf(icon: unknown): string {
  const o = record(icon);
  return o.type === "emoji" ? str(o.emoji) : "";
}

/** The entry with its icon, when it has one: an absent field costs nothing in the saved place. */
export function withIcon<T extends Entry>(entry: T, icon: string): T {
  return icon ? { ...entry, icon } : entry;
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

/** A view's sorts and how it shows its properties; anything missing is left out. */
export function readViewInfo(view: Json): ViewInfo {
  const config = record(view.configuration);
  const sorts = Array.isArray(view.sorts) && view.sorts.length > 0 ? (view.sorts as Json[]) : null;
  const groupBy = str(record(config.group_by).property_id) || null;
  const checkboxIds: string[] = [];
  for (const p of list(config.properties)) {
    const prop = record(p);
    if (prop.status_show_as === "checkbox" && str(prop.property_id)) checkboxIds.push(str(prop.property_id));
  }
  return { sorts, groupBy, checkboxIds };
}

const GROUPS: readonly Group[] = ["todo", "progress", "done"];

/**
 * A status's options with their groups. Groups are taken by place, To-do, In
 * progress, Complete: an old database may keep their names translated.
 */
function statusField(id: string, config: Json, asCheckbox: boolean): DoneField | null {
  const groups = list(config.groups).map(record);
  const groupOf = (optionId: string): Group => {
    for (let i = 0; i < groups.length; i += 1) {
      if (list(groups[i].option_ids).map(str).indexOf(optionId) < 0) continue;
      if (groups.length >= 3) return GROUPS[Math.min(i, 2)];
      return i === groups.length - 1 ? "done" : "todo";
    }
    return "todo";
  };
  // An option named like "Done" closes a task whatever group it was left in: the API, for one, puts
  // every option of a new status in To-do (seen 22.11), and people move options around.
  const options: Option[] = list(config.options).map(record).map((o) => {
    const name = str(o.name);
    return { name, color: str(o.color) || "default", group: doneLike(name) ? "done" : groupOf(str(o.id)) };
  });
  const doneNames = options.filter((o) => o.group === "done").map((o) => o.name);
  const openNames = options.filter((o) => o.group !== "done").map((o) => o.name);
  const fallback = str(config.default_option);
  const openTo = openNames.indexOf(fallback) >= 0 ? fallback : openNames[0];
  if (doneNames.length === 0 || !openTo) return null;
  return { kind: "status", id, options, doneNames, closeTo: doneNames[0], openNames, openTo, asCheckbox };
}

/** A select with an option named like "Done": that one is done, the first other one to do, the rest in progress. */
function selectField(id: string, config: Json): DoneField | null {
  const raw = list(config.options).map(record);
  const doneName = raw.map((o) => str(o.name)).find(doneLike);
  if (!doneName) return null;
  const openTo = raw.map((o) => str(o.name)).find((n) => n !== doneName) ?? null;
  const options: Option[] = raw.map((o) => {
    const name = str(o.name);
    return { name, color: str(o.color) || "default", group: name === doneName ? "done" : name === openTo ? "todo" : "progress" };
  });
  return { kind: "select", id, options, doneName, openTo };
}

/**
 * Picks the title, the done field and the due date from a data source's
 * properties. The property the view groups by or shows as a checkbox wins; then
 * a checkbox named like "Done", a status, a select with an option named like
 * "Done", any checkbox. A database with none of them still shows its rows, as
 * pages. Null only without a title.
 */
export function readSchema(dataSource: Json, view: ViewInfo | null = null): Schema | null {
  const props = record(dataSource.properties);
  let titleId = "";
  let namedCheckbox = "";
  let anyCheckbox = "";
  let checkboxes = 0;
  let status: DoneField | null = null;
  let select: DoneField | null = null;
  let preferred: DoneField | null = null;
  let dateId: string | null = null;
  let dueDateId: string | null = null;

  for (const key of Object.keys(props)) {
    const prop = record(props[key]);
    const id = str(prop.id);
    const name = lower(str(prop.name || key));
    const type = str(prop.type);
    const chosen = view !== null && (view.groupBy === id || view.checkboxIds.indexOf(id) >= 0);
    if (type === "title") titleId = id;
    if (type === "checkbox") {
      checkboxes += 1;
      if (!anyCheckbox) anyCheckbox = id;
      if (!namedCheckbox && doneLike(name)) namedCheckbox = id;
      if (chosen && !preferred) preferred = { kind: "checkbox", id };
    }
    if (type === "date") {
      if (dateId === null) dateId = id;
      if (dueDateId === null && /due|date|\u0441\u0440\u043e\u043a|\u0434\u0430\u0442\u0430|when|day/.test(name)) dueDateId = id;
    }
    if (type === "status") {
      const field = statusField(id, record(prop.status), view !== null && view.checkboxIds.indexOf(id) >= 0);
      if (field && status === null) status = field;
      if (field && chosen && !preferred) preferred = field;
    }
    if (type === "select") {
      const field = selectField(id, record(prop.select));
      if (field && select === null) select = field;
      if (field && chosen && !preferred) preferred = field;
    }
  }

  if (!titleId) return null;
  const done: DoneField | null = preferred ?? (namedCheckbox
    ? { kind: "checkbox", id: namedCheckbox }
    // An unnamed checkbox only when it is the only one: of several, one may mean "featured" or "paid".
    : status ?? select ?? (checkboxes === 1 ? { kind: "checkbox", id: anyCheckbox } : null));
  return { titleId, done, dateId: dueDateId ?? dateId };
}

/** The option of a status or select by name. */
export function optionOf(field: DoneField | null, name: string): Option | null {
  if (!field || field.kind === "checkbox") return null;
  return field.options.find((o) => o.name === name) ?? null;
}

/** A row shows its status as a tag in two lines: a status or a select the view does not show as a checkbox. */
export function hasTag(field: DoneField | null): boolean {
  return field !== null && (field.kind === "select" || (field.kind === "status" && !field.asCheckbox));
}

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

/**
 * "2026-11-06": the date `offset` minutes east of UTC, in the bar's time zone.
 * Counted from UTC, since JS on the bar has no zone of its own (see clock.ts).
 */
export function localDate(now: Date, offset: number): string {
  const local = new Date(now.getTime() + offset * 60000);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
}

/** Midnight of that date as an ISO timestamp with the offset: "2026-11-06T00:00:00+03:00". */
export function localDayStart(now: Date, offset: number): string {
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${localDate(now, offset)}T00:00:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** How many rows one query asks for: more would not fit the app's memory, nor anyone's day. */
export const PAGE_SIZE = 20;

/** Filters that hold for open rows, or for done ones. A status needs one per option, since a filter cannot nest deeper. */
function doneFilters(field: DoneField, done: boolean): Json[] {
  if (field.kind === "checkbox") return [{ property: field.id, checkbox: { equals: done } }];
  if (field.kind === "select") return [{ property: field.id, select: done ? { equals: field.doneName } : { does_not_equal: field.doneName } }];
  const names = done ? field.openNames : field.doneNames;
  return names.map((name) => ({ property: field.id, status: { does_not_equal: name } }));
}

/**
 * The query body: open rows, then rows closed since midnight, so a task ticked
 * off today can be ticked back on. Notion has no "closed at", so the last edit
 * stands in for it. With the "today" scope a row shows when it is due by today
 * or has no date. A filter nests two levels at most, so each case is its own branch.
 */
export function queryBody(schema: Schema, scope: Scope, today: string, dayStart: string, sorts: Json[] | null = null): Json {
  const when: Json[][] = scope === "today" && schema.dateId !== null
    ? [[{ property: schema.dateId, date: { on_or_before: today } }], [{ property: schema.dateId, date: { is_empty: true } }]]
    : [[]];
  const editedToday: Json = { timestamp: "last_edited_time", last_edited_time: { on_or_after: dayStart } };
  const branches: Json[] = [];
  const field = schema.done;
  if (field) {
    for (const due of when) branches.push({ and: doneFilters(field, false).concat(due) });
    for (const due of when) branches.push({ and: doneFilters(field, true).concat(due, [editedToday]) });
  } else {
    // Nothing marks a row done: every row due by today or undated, or every row.
    for (const due of when) if (due.length > 0) branches.push({ and: due });
  }

  const body: Json = { page_size: PAGE_SIZE };
  if (branches.length > 0) body.filter = { or: branches };
  // The person's own order, from their view; without one, soonest first.
  body.sorts = sorts ?? (schema.dateId !== null
    ? [{ property: schema.dateId, direction: "ascending" }, { timestamp: "created_time", direction: "ascending" }]
    : [{ timestamp: "created_time", direction: "ascending" }]);
  return body;
}

/** `filter_properties` for the query string: only what the screen needs comes back. */
export function queryPath(dataSourceId: string, schema: Schema): string {
  const ids = schema.done ? [schema.titleId, schema.done.id] : [schema.titleId];
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
  const f = schema.done;
  const tagged = hasTag(f);
  for (const item of list(response.results)) {
    const page = record(item);
    if (page.object !== "page" || page.in_trash === true) continue;
    const title = plainText(propertyById(page, schema.titleId).title) || "Untitled";
    const id = str(page.id);
    const icon = emojiOf(page.icon);
    if (!f) {
      // A row with nothing to tick is a page.
      tasks.push(withIcon({ kind: "page", id, title }, icon));
      continue;
    }
    const field = propertyById(page, f.id);
    if (f.kind === "checkbox") {
      tasks.push(withIcon({ kind: "row", id, title, done: field.checkbox === true }, icon));
      continue;
    }
    const name = str(record(f.kind === "select" ? field.select : field.status).name);
    const option = optionOf(f, name);
    const done = option !== null && option.group === "done";
    const row: Entry = tagged ? { kind: "row", id, title, done, tag: name, color: option ? option.color : "default" } : { kind: "row", id, title, done };
    tasks.push(withIcon(row, icon));
  }
  return tasks;
}

/** A block met while looking for a to-do's id: its own id, a to-do's text, and whether to look inside it. */
export interface Walked {
  readonly id: string;
  /** The to-do's text; null for any other block. */
  readonly todo: string | null;
  readonly descend: boolean;
}

/**
 * One page of a block's children, for finding to-dos' ids in the order the
 * markdown lists them. Subpages and databases are not looked into: their
 * contents are not on this page.
 */
export function walkedBlocks(response: Json): Walked[] {
  const out: Walked[] = [];
  for (const item of list(response.results)) {
    const block = record(item);
    const type = str(block.type);
    const id = str(block.id);
    const todo = type === "to_do" ? plainText(record(block.to_do).rich_text) : null;
    const descend = block.has_children === true && type !== "child_page" && type !== "child_database";
    out.push({ id, todo, descend });
  }
  return out;
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
      entry: withIcon({ kind: "page", id: str(page.id), title: pageTitle(page) || "Untitled" }, emojiOf(page.icon)),
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
 * end, such pages count as top level too. Database rows never do, nor pages
 * inside a toggle or a column: their page shows them.
 */
export function pickRoots(found: readonly Found[], searchedAll: boolean): Entry[] {
  const ids = new Set(found.map((f) => f.entry.id));
  const roots: Entry[] = [];
  for (const f of found) {
    if (f.parentType === "workspace") roots.push(f.entry);
    else if (searchedAll && f.parentType === "page_id" && !ids.has(f.parentId)) {
      roots.push(f.entry);
    }
  }
  return roots;
}

/** Top-level pages and databases among recent search results, pages and data sources mixed. */
export function rootsInSearch(response: Json): Entry[] {
  const out: Entry[] = [];
  for (const item of list(response.results)) {
    const o = record(item);
    if (o.in_trash === true) continue;
    if (o.object === "page" && record(o.parent).type === "workspace") {
      out.push(withIcon({ kind: "page", id: str(o.id), title: pageTitle(o) || "Untitled" }, emojiOf(o.icon)));
    } else if (o.object === "data_source" && record(o.database_parent).type === "workspace") {
      const id = str(record(o.parent).database_id);
      if (id) out.push(withIcon({ kind: "database", id, title: plainText(o.title) || "Untitled" }, emojiOf(o.icon)));
    }
  }
  return out;
}

/** Sorted by title: the sidebar's own order is not in the API. */
export function byTitle(entries: Entry[]): Entry[] {
  return entries.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}

/** The top level with what a quick check found: new entries added, renamed ones renamed. */
export function mergeRoots(roots: readonly Entry[], found: readonly Entry[]): Entry[] {
  const out = roots.map((e) => {
    const f = found.find((x) => x.id === e.id);
    return f && (f.title !== e.title || f.icon !== e.icon) ? { ...e, title: f.title, icon: f.icon } : e;
  });
  for (const f of found) if (!out.some((e) => e.id === f.id)) out.push(f);
  return byTitle(out);
}

/**
 * The call that ticks a task off, or back on when `done` is false. A to-do
 * read from markdown needs its block id, found by `source.ts`.
 */
export function setDoneCall(
  task: Entry,
  database: Database | null,
  done: boolean,
  blockId = task.id,
  option: string | null = null,
): { path: string; body: Json } | null {
  if (task.kind === "todo") return { path: `blocks/${blockId}`, body: { to_do: { checked: done } } };
  if (task.kind !== "row" || !database || !database.schema.done) return null;
  const field = database.schema.done;
  // A status or a select chosen by name is written as it is; a tick goes to the done option or back.
  const value = field.kind === "checkbox"
    ? { checkbox: done }
    : field.kind === "select"
      ? { select: option !== null ? { name: option } : done ? { name: field.doneName } : field.openTo === null ? null : { name: field.openTo } }
      : { status: { name: option ?? (done ? field.closeTo : field.openTo) } };
  return { path: `pages/${task.id}`, body: { properties: { [field.id]: value } } };
}

/** Open tasks first, closed ones after, each group in the order Notion gave. Pages keep their own order. */
export function openFirst(entries: readonly Entry[]): Entry[] {
  return entries.filter((e) => !e.done).concat(entries.filter((e) => e.done === true));
}

export function isTask(entry: Entry): boolean {
  return entry.kind === "todo" || entry.kind === "row";
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Whether two entries show and act the same: every field compared. */
export function sameEntry(a: Entry, b: Entry): boolean {
  return a.kind === b.kind && a.id === b.id && a.title === b.title && a.done === b.done && a.page === b.page &&
    a.index === b.index && a.line === b.line && a.depth === b.depth && a.count === b.count && a.tag === b.tag &&
    a.color === b.color && a.link === b.link && a.icon === b.icon && sameList(a.toggles, b.toggles);
}

/**
 * A fresh read with the old entries kept where nothing in them changed, and
 * the old list itself when nothing did: the lines built for them, the list on
 * screen and the saved place all stay as they are. A refresh every few
 * seconds that finds nothing new then costs a pass of compares, not a rebuild.
 */
export function reuseEntries(old: readonly Entry[], fresh: readonly Entry[]): Entry[] {
  const byId: Record<string, Entry> = {};
  for (let i = 0; i < old.length; i += 1) byId[old[i].id] = old[i];
  const out: Entry[] = [];
  let same = old.length === fresh.length;
  for (let i = 0; i < fresh.length; i += 1) {
    const f = fresh[i];
    const o = byId[f.id];
    const kept = o !== undefined && sameEntry(o, f) ? o : f;
    if (kept !== old[i]) same = false;
    out.push(kept);
  }
  return same ? (old as Entry[]) : out;
}
