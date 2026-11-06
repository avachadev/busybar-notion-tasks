/** Reads what one screen of the app shows, and closes tasks. */

import { type Json, NotionError, call } from "./notion.ts";
import {
  type Database,
  type Entry,
  type Scope,
  entriesFromBlocks,
  localDate,
  localDayStart,
  plainText,
  queryBody,
  queryPath,
  readSchema,
  openFirst,
  rootsFromSearch,
  setDoneCall,
  tasksFromQuery,
} from "./tasks.ts";

/** The database has nothing that marks a task done: no checkbox, no status. */
export class NoDoneFieldError extends Error {}

/** The read was given up because the user left the view. */
export class CancelledError extends Error {}

/** Tells a read whether it is still wanted; checked before every request. */
export type Alive = () => boolean;

function check(alive: Alive): void {
  if (!alive()) throw new CancelledError("left the view");
}

/**
 * Where the user is. `root` is the top-level pages; `start` is the page or
 * database from the settings, until the first read tells which it is.
 */
export type View =
  | { readonly kind: "root" }
  | { readonly kind: "start"; readonly id: string }
  | { readonly kind: "page"; readonly id: string; readonly title: string }
  | { readonly kind: "database"; readonly id: string; readonly title: string };

export interface Loaded {
  readonly entries: Entry[];
  /** The view as it turned out: a `start` becomes a page or a database. */
  readonly view: View;
  readonly database: Database | null;
}

/** Blocks per request when reading a page. */
const BLOCKS_PER_PAGE = 50;
/** Four requests of 50: a page longer than 200 blocks shows its first part. */
const MAX_BLOCK_PAGES = 4;
/** Search results per request, and how many requests a root read may make. */
const SEARCH_PER_PAGE = 20;
const MAX_SEARCH_PAGES = 5;

function list(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

async function openDatabase(token: string, id: string, alive: Alive): Promise<{ database: Database; title: string }> {
  check(alive);
  const db = await call(token, "GET", `databases/${id}`);
  const first = list(db.data_sources)[0];
  if (!first || typeof first.id !== "string") throw new NoDoneFieldError("database has no data source");
  check(alive);
  const schema = readSchema(await call(token, "GET", `data_sources/${first.id}`));
  if (!schema) throw new NoDoneFieldError("no checkbox or status property");
  return { database: { dataSourceId: first.id, schema }, title: plainText(db.title) };
}

async function readPage(token: string, id: string, alive: Alive): Promise<Entry[]> {
  let entries: Entry[] = [];
  let cursor = "";
  for (let i = 0; i < MAX_BLOCK_PAGES; i += 1) {
    const query = `page_size=${BLOCKS_PER_PAGE}${cursor ? `&start_cursor=${cursor}` : ""}`;
    check(alive);
    const response = await call(token, "GET", `blocks/${id}/children?${query}`);
    entries = entries.concat(entriesFromBlocks(response));
    if (response.has_more !== true || typeof response.next_cursor !== "string") break;
    cursor = response.next_cursor;
  }
  return entries;
}

/**
 * The API has no call for the sidebar, so the top-level pages are picked out
 * of a search, a few requests deep. Sorted by title: the sidebar's own order
 * is not in the API either.
 */
async function readRoot(token: string, alive: Alive): Promise<Entry[]> {
  let entries: Entry[] = [];
  let cursor = "";
  for (let i = 0; i < MAX_SEARCH_PAGES; i += 1) {
    const body: Json = { filter: { property: "object", value: "page" }, page_size: SEARCH_PER_PAGE };
    if (cursor) body.start_cursor = cursor;
    check(alive);
    const response = await call(token, "POST", "search", body);
    entries = entries.concat(rootsFromSearch(response));
    if (response.has_more !== true || typeof response.next_cursor !== "string") break;
    cursor = response.next_cursor;
  }
  return entries.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
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
): Promise<Loaded> {
  if (view.kind === "root") return { entries: await readRoot(token, alive), view, database: null };

  let resolved: View = view;
  if (view.kind === "start") {
    // Tried as a database first; Notion answers a page id there with 400 or 404.
    try {
      const opened = await openDatabase(token, view.id, alive);
      databases.set(view.id, opened.database);
      resolved = { kind: "database", id: view.id, title: opened.title };
    } catch (err) {
      if (!(err instanceof NotionError) || (err.status !== 400 && err.status !== 404)) throw err;
      resolved = { kind: "page", id: view.id, title: "" };
    }
  }

  if (resolved.kind === "page") {
    return { entries: await readPage(token, resolved.id, alive), view: resolved, database: null };
  }
  if (resolved.kind !== "database") throw new Error("unexpected view");

  let database = databases.get(resolved.id);
  if (!database) {
    database = (await openDatabase(token, resolved.id, alive)).database;
    databases.set(resolved.id, database);
  }
  check(alive);
  const body = queryBody(database.schema, scope, localDate(now), localDayStart(now));
  const response = await call(token, "POST", queryPath(database.dataSourceId, database.schema), body);
  return { entries: openFirst(tasksFromQuery(response, database.schema)), view: resolved, database };
}

/** Ticks a task off in Notion, or back on. */
export async function setDone(token: string, task: Entry, database: Database | null, done: boolean): Promise<void> {
  const update = setDoneCall(task, database, done);
  if (!update) throw new Error("not a task");
  await call(token, "PATCH", update.path, update.body);
}
