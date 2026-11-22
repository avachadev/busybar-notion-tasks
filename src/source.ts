/** Reads what one screen of the app shows, and closes tasks. */

import { PageReader, sameText } from "./markdown.ts";
import { DroppedError, type Json, type Turn, NotionError, WRITE, call, stream } from "./notion.ts";
import { SearchScan } from "./scan.ts";
import { MarkdownLines } from "./stream.ts";
import {
  type Database,
  type Entry,
  type Scope,
  foundInSearch,
  localDate,
  localDayStart,
  plainText,
  queryBody,
  queryPath,
  readSchema,
  readViewInfo,
  byTitle,
  openFirst,
  optionOf,
  pickRoots,
  withIcon,
  rootsInSearch,
  setDoneCall,
  tasksFromQuery,
  walkedBlocks,
} from "./tasks.ts";

/** None of the database's data sources could be read as a list: no title property. */
export class NoDoneFieldError extends Error {}

/**
 * The read was given up because the user left the view: before a request, or
 * by the queue when the request's turn came (the same error, so one test fits both).
 */
export const CancelledError = DroppedError;

/** A to-do's block was not where the page's markdown put it: the page changed meanwhile. */
export class MovedError extends Error {}

/** Tells a read whether it is still wanted; checked before every request. */
export type Alive = () => boolean;

function check(alive: Alive): void {
  if (!alive()) throw new CancelledError("left the view");
}

/** A read for the view on screen: dropped from the queue if the user has left by its turn. */
const reading = (alive: Alive): Turn => ({ alive });
/** A tick or a status: before anything else. */
const writing: Turn = { priority: WRITE };

/**
 * Where the user is. `root` is the top level; `start` is the page or database
 * from the settings, until the first read tells which it is.
 */
export type View =
  | { readonly kind: "root" }
  | { readonly kind: "start"; readonly id: string; readonly title?: string; readonly icon?: string }
  | { readonly kind: "page"; readonly id: string; readonly title: string; readonly icon?: string }
  | { readonly kind: "database"; readonly id: string; readonly title: string; readonly icon?: string };

export interface Loaded {
  readonly entries: Entry[];
  /** The view as it turned out: a `start` becomes a page or a database. */
  readonly view: View;
  readonly database: Database | null;
}

/** Search results per request, and how many requests a root read may make, for pages and for databases. */
const SEARCH_PER_PAGE = 20;
const MAX_PAGE_SEARCHES = 5;
const DATABASES_PER_SEARCH = 100;
const MAX_DATABASE_SEARCHES = 1;
/**
 * A database's schema and view are looked up again after this long, so options
 * added or renamed in Notion show; at once when a row has an option it does not know.
 */
const SCHEMA_MS = 10 * 60 * 1000;
const openedAt = new Map<string, number>();

/** Whether a row shows a status or a select option the schema does not have. */
function hasUnknownOption(rows: readonly Entry[], schema: Database["schema"]): boolean {
  const f = schema.done;
  if (!f || f.kind === "checkbox") return false;
  for (let i = 0; i < rows.length; i += 1) {
    const tag = rows[i].tag;
    if (tag && optionOf(f, tag) === null) return true;
  }
  return false;
}

/** A database's data sources tried for one with a done field. */
const MAX_SOURCES = 3;
/**
 * Lines a page shows before the rest of it is read: a long page takes seconds
 * to read on the bar, and the first screen needs only a few.
 */
const FIRST_SCREEN = 8;

/** Blocks per request when looking for a to-do's id: an answer of 100 blocks can run to 50 KB. */
const WALK_PAGE_SIZE = 25;

function list(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

/** Views looked at for one that shows a data source: a dashboard view shows none. */
const MAX_VIEWS = 3;

/**
 * The database's first view that shows a data source, for its order and how
 * it shows its status (`GET /v1/views`, from 19.03.2026). The API does not
 * promise the order of the tabs; the list's first is taken as the first tab.
 * Null when Notion gives none: the database is then shown in the app's own order.
 */
async function firstView(token: string, id: string, alive: Alive): Promise<Json | null> {
  try {
    check(alive);
    const views = list((await call(token, "GET", `views?database_id=${id}`, undefined, reading(alive))).results);
    for (let i = 0; i < views.length && i < MAX_VIEWS; i += 1) {
      const viewId = typeof views[i].id === "string" ? (views[i].id as string) : "";
      if (!viewId) continue;
      check(alive);
      const view = await call(token, "GET", `views/${viewId}`, undefined, reading(alive));
      if (typeof view.data_source_id === "string" && view.data_source_id) return view;
    }
    return null;
  } catch (err) {
    if (err instanceof NotionError && err.status !== 401 && err.status !== 429 && err.status < 500) return null;
    throw err;
  }
}

/**
 * The database's data source with a done field, the view's own first; else the
 * first that has a title, whose rows are then shown as pages.
 */
async function openDatabase(token: string, id: string, alive: Alive): Promise<{ database: Database; title: string }> {
  check(alive);
  const db = await call(token, "GET", `databases/${id}`, undefined, reading(alive));
  const view = await firstView(token, id, alive);
  const info = view ? readViewInfo(view) : null;
  const viewSource = view && typeof view.data_source_id === "string" ? view.data_source_id : "";
  const sources = list(db.data_sources).filter((s) => typeof s.id === "string").slice(0, MAX_SOURCES);
  sources.sort((a, b) => (a.id === viewSource ? -1 : b.id === viewSource ? 1 : 0));
  let fallback: Database | null = null;
  for (const source of sources) {
    const sourceId = source.id as string;
    const own = !viewSource || sourceId === viewSource;
    check(alive);
    let answer: Json;
    try {
      answer = await call(token, "GET", `data_sources/${sourceId}`, undefined, reading(alive));
    } catch (err) {
      // A source the connection cannot read is listed all the same: the next one may do.
      if (err instanceof NotionError && (err.status === 403 || err.status === 404)) continue;
      throw err;
    }
    const schema = readSchema(answer, own ? info : null);
    if (!schema) continue;
    const database: Database = { dataSourceId: sourceId, schema, sorts: own && info ? info.sorts : null };
    if (schema.done) return { database, title: plainText(db.title) };
    if (!fallback) fallback = database;
  }
  if (fallback) return { database: fallback, title: plainText(db.title) };
  throw new NoDoneFieldError("no data source with a title");
}

/**
 * A page, read as its markdown arrives (`stream.ts`): the answer is never held
 * whole, and reading stops once MAX_ENTRIES lines are kept.
 */
async function readPage(token: string, id: string, alive: Alive, onFirst?: (entries: Entry[]) => void): Promise<Entry[]> {
  check(alive);
  const reader = new PageReader(id);
  let shown = false;
  const lines = new MarkdownLines((line) => {
    reader.push(line);
    if (onFirst && !shown && reader.entries.length >= FIRST_SCREEN) {
      shown = true;
      onFirst(reader.snapshot());
    }
    // A page the user has left is not read on.
    return !reader.full && alive();
  });
  await stream(token, `pages/${id}/markdown?markdown_version=v2`, (bytes) => lines.feed(bytes), reading(alive));
  check(alive);
  lines.end();
  return reader.finish();
}

/** Search answers carry only the title of a page's properties: an answer of 20 is then about 30 KB. */
const SEARCH_TITLES = "search?filter_properties=title";

/**
 * The API has no call for the sidebar, so the top level is picked out of
 * searches: pages under the workspace, then databases under it. Sorted by
 * title: the sidebar's own order is not in the API either.
 *
 * This is the read for an internal connection (`roots.ts` sweeps for a
 * personal token). It sees only what is shared with it, so a page or a
 * database whose parent page it cannot see is top level too, once all pages
 * were searched. Data sources are scanned as they arrive, never parsed: each
 * carries its whole schema, up to 24 KB, which `filter_properties` does not trim.
 */
async function readRoot(token: string, alive: Alive): Promise<Entry[]> {
  let found: ReturnType<typeof foundInSearch> = [];
  let cursor = "";
  let searchedAll = false;
  for (let i = 0; i < MAX_PAGE_SEARCHES; i += 1) {
    const body: Json = { filter: { property: "object", value: "page" }, page_size: SEARCH_PER_PAGE };
    if (cursor) body.start_cursor = cursor;
    check(alive);
    const response = await call(token, "POST", SEARCH_TITLES, body, reading(alive));
    found = found.concat(foundInSearch(response));
    if (response.has_more !== true || typeof response.next_cursor !== "string") {
      searchedAll = true;
      break;
    }
    cursor = response.next_cursor;
  }
  const roots = pickRoots(found, searchedAll);
  const pages = new Set<string>();
  for (const f of found) pages.add(f.entry.id);
  const have = new Set<string>();
  for (const e of roots) have.add(e.id);

  cursor = "";
  for (let i = 0; i < MAX_DATABASE_SEARCHES; i += 1) {
    const body: Json = { filter: { property: "object", value: "data_source" }, page_size: DATABASES_PER_SEARCH };
    if (cursor) body.start_cursor = cursor;
    check(alive);
    const scan = new SearchScan(true);
    await stream(token, "search", (bytes) => {
      scan.feed(bytes);
      return alive();
    }, reading(alive), "POST", body);
    check(alive);
    scan.end();
    for (const db of scan.found) {
      // Under the workspace, or under a page it cannot see; not in a block, whose page shows it.
      const top = !db.parent || (searchedAll && db.parentType === "page_id" && !pages.has(db.parent));
      if (!top || have.has(db.id)) continue;
      have.add(db.id);
      roots.push(withIcon({ kind: "database", id: db.id, title: db.title ?? "Untitled" }, db.icon));
    }
    if (!scan.hasMore || !scan.cursor) break;
    cursor = scan.cursor;
  }
  return byTitle(roots);
}

/** How many of the latest edited pages a quick check of the top level looks at. */
const RECENT = 10;

/**
 * A quick check of the top level between full reads: one search for the pages
 * edited last. New top-level pages show at once; databases wait for the full
 * read, their answers being too big to take whole.
 */
export async function readRecentRoots(token: string, alive: Alive): Promise<Entry[]> {
  check(alive);
  const response = await call(token, "POST", SEARCH_TITLES, {
    filter: { property: "object", value: "page" },
    sort: { timestamp: "last_edited_time", direction: "descending" },
    page_size: RECENT,
  }, reading(alive));
  return rootsInSearch(response);
}

/**
 * Reads a view. Databases are resolved once and kept in `databases`, so
 * coming back to one costs one request.
 */
export async function readView(
  token: string,
  view: View,
  scope: Scope,
  now: Date,
  databases: Map<string, Database>,
  alive: Alive,
  onFirst?: (entries: Entry[], view: View) => void,
): Promise<Loaded> {
  if (view.kind === "root") return { entries: await readRoot(token, alive), view, database: null };

  let resolved: View = view;
  if (view.kind === "start") {
    // Tried as a database first; Notion answers a page id there with 400 or 404.
    try {
      const opened = await openDatabase(token, view.id, alive);
      databases.set(view.id, opened.database);
      openedAt.set(view.id, now.getTime());
      resolved = { kind: "database", id: view.id, title: opened.title, icon: view.icon };
    } catch (err) {
      if (!(err instanceof NotionError) || (err.status !== 400 && err.status !== 404)) throw err;
      resolved = { kind: "page", id: view.id, title: view.title ?? "", icon: view.icon };
    }
  }

  if (resolved.kind === "page") {
    const page = resolved;
    const first = onFirst ? (list: Entry[]) => onFirst(list, page) : undefined;
    return { entries: await readPage(token, page.id, alive, first), view: page, database: null };
  }
  if (resolved.kind !== "database") throw new Error("unexpected view");

  let database = databases.get(resolved.id);
  if (!database || now.getTime() - (openedAt.get(resolved.id) ?? 0) >= SCHEMA_MS) {
    database = (await openDatabase(token, resolved.id, alive)).database;
    databases.set(resolved.id, database);
    openedAt.set(resolved.id, now.getTime());
  }
  let response: Json | null = null;
  while (!response) {
    check(alive);
    const body = queryBody(database.schema, scope, localDate(now), localDayStart(now), database.sorts);
    try {
      response = await call(token, "POST", queryPath(database.dataSourceId, database.schema), body, reading(alive));
    } catch (err) {
      const refused = err instanceof NotionError && err.status === 400;
      // The view's sorts are taken as the query's; if Notion will not have them, the app's own order does.
      if (refused && database.sorts) {
        database = { ...database, sorts: null };
        databases.set(resolved.id, database);
        continue;
      }
      // The database's properties changed or it moved: look it up again next time.
      if (refused || (err instanceof NotionError && err.status === 404)) databases.delete(resolved.id);
      throw err;
    }
  }
  // The person's own sort is kept as it is; the app's own puts open rows first.
  const rows = tasksFromQuery(response, database.schema);
  // An option the schema does not know: it was added or renamed in Notion. Look the database up again next time.
  if (hasUnknownOption(rows, database.schema)) databases.delete(resolved.id);
  return { entries: database.sorts ? rows : openFirst(rows), view: resolved, database };
}

// ---- Finding a to-do's block ----------------------------------------------

interface Walk {
  readonly ids: string[];
  readonly texts: string[];
}

/** Per page, the to-dos' block ids and texts in the markdown's order, as far as they were walked. */
const walks = new Map<string, Walk>();
const MAX_WALKS = 2;

/**
 * Walks a page's blocks depth first, in the order the markdown lists them, and
 * collects its to-dos up to the one at `upto`: a page of 600 to-dos walked to
 * its end took the wire for about 24 requests. Only blocks with children are
 * looked into.
 */
async function walk(token: string, page: string, upto: number): Promise<Walk> {
  const ids: string[] = [];
  const texts: string[] = [];
  const enough = () => ids.length > upto;
  const visit = async (blockId: string): Promise<void> => {
    let cursor = "";
    do {
      const query = `page_size=${WALK_PAGE_SIZE}${cursor ? `&start_cursor=${cursor}` : ""}`;
      const response = await call(token, "GET", `blocks/${blockId}/children?${query}`, undefined, writing);
      for (const block of walkedBlocks(response)) {
        if (block.todo !== null) {
          ids.push(block.id);
          texts.push(block.todo);
          if (enough()) return;
        }
        if (block.descend) await visit(block.id);
        if (enough()) return;
      }
      cursor = response.has_more === true && typeof response.next_cursor === "string" ? response.next_cursor : "";
    } while (cursor);
  };
  await visit(page);
  return { ids, texts };
}

/** The block id of a to-do read from markdown: the page is walked once, then remembered. */
async function todoBlock(token: string, task: Entry): Promise<string> {
  const page = task.page ?? "";
  const index = task.index ?? -1;
  const found = (w: Walk | undefined) => (w && index < w.ids.length && sameText(w.texts[index], task.title) ? w.ids[index] : "");
  const known = found(walks.get(page));
  if (known) return known;
  const fresh = await walk(token, page, index);
  walks.delete(page);
  walks.set(page, fresh);
  if (walks.size > MAX_WALKS) {
    const oldest = walks.keys().next().value;
    if (oldest !== undefined) walks.delete(oldest);
  }
  const id = found(fresh);
  if (!id) throw new MovedError("the page changed");
  return id;
}

/**
 * Ticks a to-do by editing its line in the page's markdown: one request, and
 * Notion keeps the block. False when Notion finds no single such line. The
 * line carries its line break (`PageReader.finish`), so it is not found inside
 * a longer one. The answer is the whole page, so it is not read.
 */
async function tickByLine(token: string, task: Entry, done: boolean): Promise<boolean> {
  // The line as it is now, whatever it was when read: the bar may have ticked it since.
  const text = (task.line ?? "").substring(6);
  const update = { old_str: (done ? "- [ ] " : "- [x] ") + text, new_str: (done ? "- [x] " : "- [ ] ") + text };
  try {
    await stream(token, `pages/${task.page}/markdown`, () => false, writing, "PATCH", {
      markdown_version: "v2",
      type: "update_content",
      update_content: { content_updates: [update] },
    });
    return true;
  } catch (err) {
    // No match, or more than one: the page changed since it was read, or it is a synced copy.
    if (err instanceof NotionError && err.status === 400) return false;
    throw err;
  }
}

/** Ticks a task off in Notion, or back on; `option` sets a status or a select by name instead. */
export async function setDone(token: string, task: Entry, database: Database | null, done: boolean, option: string | null = null): Promise<void> {
  if (task.kind === "todo" && task.page && task.line && (await tickByLine(token, task, done))) return;
  const blockId = task.kind === "todo" && task.page ? await todoBlock(token, task) : task.id;
  const update = setDoneCall(task, database, done, blockId, option);
  if (!update) throw new Error("not a task");
  await call(token, "PATCH", update.path, update.body, writing);
}
