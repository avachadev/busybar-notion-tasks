/**
 * The workspace's top level: found once by sweeping the whole search, then kept
 * up to date by small checks while it is on screen (`docs/roots.md`).
 *
 * The API has no call for the sidebar. A page or a database is top level when
 * its parent is the workspace, and the only way to meet them all is to go
 * through every search result, subpages and database rows included: 929 of
 * them on a modest workspace. So the list is built over time and kept: a sweep
 * reads one search answer at a time while the bar is idle, scanning it as it
 * arrives (`scan.ts`), and saves where it stopped. Four readers correct it:
 *
 * - the sweep adds top-level pages and databases and renames them;
 * - the recent check reads the 10 last edited: new, renamed and restored ones;
 * - the trash check reads the 10 last trashed pages and drops them;
 * - the root check gets one kept page or database at a time: one moved under
 *   another page (a move does not change its last edit, measured), trashed,
 *   deleted or no longer shared goes.
 *
 * Only the list is kept: no tree, no parents, no rows.
 */

import { type Json, NotionError, SWEEP, type Turn, UPKEEP, call, stream } from "./notion.ts";
import { SearchScan, type TopLevel } from "./scan.ts";
import { type Entry, byTitle, pageTitle, plainText } from "./tasks.ts";

export interface Root {
  readonly kind: "page" | "database";
  readonly id: string;
  readonly title: string;
}

/** What is saved: the list, and where the sweep stands. */
interface Saved {
  readonly owner: string;
  roots: Root[];
  /** What the sweep is reading, pages and then data sources; null between passes. */
  phase: "page" | "data_source" | null;
  /** Where in it: the next search answer's cursor, null for the first. */
  cursor: string | null;
  /** When the last pass ended, ms; 0 before the first has. */
  doneAt: number;
  /** Which kept root the root check gets next. */
  next: number;
  /**
   * The token is an internal connection (`users/me`: owned by the workspace),
   * null until asked. Such a token may see a page whose parent it cannot: that
   * page is top level for it, which a sweep for workspace parents misses, so
   * its top level is read the old way (`source.ts`).
   */
  internal: boolean | null;
}

const KEY = "roots1";
/** A pass that ended this long ago is run again: paging may have missed a page, and Notion's search has no guarantee. */
const PASS_EVERY_MS = 24 * 60 * 60 * 1000;
/** Results per sweep answer: the most Notion gives; scanned as it arrives, it costs the bar about 2 s. */
const SWEEP_SIZE = 100;
/** The recent and trash checks: one small answer each. */
const CHECK_SIZE = 10;
const SEARCH = "search?filter_properties=title";

const NEWEST = { timestamp: "last_edited_time", direction: "descending" };

function storage(): Storage | undefined {
  return (globalThis as { localStorage?: Storage }).localStorage;
}

function fresh(owner: string): Saved {
  return { owner, roots: [], phase: "page", cursor: null, doneAt: 0, next: 0, internal: null };
}

function load(owner: string): Saved {
  try {
    const raw = storage()?.getItem(KEY);
    const saved = raw ? (JSON.parse(raw) as Saved) : null;
    if (saved && saved.owner === owner && Array.isArray(saved.roots)) return saved;
  } catch {
    // A broken record only costs a new sweep.
  }
  return fresh(owner);
}

export class Roots {
  private readonly saved: Saved;
  private dirty = false;
  /** The entries for the screen, made again only when the list changed: `main.ts` compares them by identity. */
  private shown: Entry[] | null = null;

  constructor(owner: string) {
    this.saved = load(owner);
  }

  /** The top level as the screen shows it, sorted by title: the sidebar's own order is not in the API. */
  entries(): Entry[] {
    if (!this.shown) this.shown = byTitle(this.saved.roots.map((r) => ({ kind: r.kind, id: r.id, title: r.title })));
    return this.shown;
  }

  /** Nothing found yet and the first pass not over: the screen says the app is looking. */
  get searching(): boolean {
    return this.saved.roots.length === 0 && this.saved.doneAt === 0;
  }

  /** A sweep answer is due: a pass is under way, or the last one is old. Not for an internal connection. */
  sweepDue(now: number): boolean {
    if (this.saved.internal !== false) return false;
    return this.saved.phase !== null || now - this.saved.doneAt >= PASS_EVERY_MS;
  }

  /** A sweep pass is under way: it finds new top-level pages itself, so the checks can wait. */
  get sweeping(): boolean {
    return this.saved.internal === false && this.saved.phase !== null;
  }

  /** Null until `whoami` has asked. */
  get internal(): boolean | null {
    return this.saved.internal;
  }

  /** Asks Notion what kind of token this is, once per token. */
  async whoami(token: string, alive: () => boolean): Promise<boolean> {
    if (this.saved.internal !== null) return this.saved.internal;
    const me = await call(token, "GET", "users/me", undefined, { priority: UPKEEP, alive });
    const owner = ((me.bot ?? {}) as Json).owner as Json | undefined;
    this.saved.internal = owner?.type === "workspace";
    this.dirty = true;
    return this.saved.internal;
  }

  /** Writes the record if it changed: every write rewrites flash, so `main.ts` calls this when the user is idle. */
  save(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      storage()?.setItem(KEY, JSON.stringify(this.saved));
    } catch {
      // A full store only costs the next start a sweep.
    }
  }

  private changed(): void {
    this.dirty = true;
    this.shown = null;
  }

  /** Adds what a scan found, or renames it; a database's title is read on its own. True when the list changed. */
  private async take(token: string, found: readonly TopLevel[], turn: Turn): Promise<boolean> {
    let any = false;
    for (const f of found) {
      const known = this.saved.roots.find((r) => r.id === f.id);
      let title = f.title;
      if (title === null && f.kind === "database") {
        if (known) continue;
        title = plainText((await call(token, "GET", `databases/${f.id}`, undefined, turn)).title);
      }
      const name = title || "Untitled";
      if (known && known.title === name) continue;
      this.saved.roots = this.saved.roots.filter((r) => r.id !== f.id).concat([{ kind: f.kind, id: f.id, title: name }]);
      any = true;
    }
    if (any) this.changed();
    return any;
  }

  private drop(id: string): boolean {
    const before = this.saved.roots.length;
    this.saved.roots = this.saved.roots.filter((r) => r.id !== id);
    if (this.saved.roots.length === before) return false;
    this.changed();
    return true;
  }

  /** One search answer, scanned as it arrives. */
  private async scan(token: string, body: Json, turn: Turn): Promise<SearchScan> {
    const scan = new SearchScan();
    await stream(token, SEARCH, (bytes) => {
      scan.feed(bytes);
      return true;
    }, turn, "POST", body);
    scan.end();
    if (scan.odd > 0) console.error(`notiontasks: ${scan.odd} search results in an unexpected shape`);
    return scan;
  }

  /**
   * One sweep answer, from where the last one stopped. Starts a new pass when
   * the last one is old. True when the list changed.
   */
  async sweep(token: string, now: number): Promise<boolean> {
    const s = this.saved;
    if (s.phase === null) {
      s.phase = "page";
      s.cursor = null;
    }
    const body: Json = { filter: { property: "object", value: s.phase }, page_size: SWEEP_SIZE };
    if (s.cursor) body.start_cursor = s.cursor;
    let scan: SearchScan;
    try {
      scan = await this.scan(token, body, { priority: SWEEP });
    } catch (err) {
      // A cursor Notion no longer takes: the pass starts over.
      if (err instanceof NotionError && err.status === 400 && s.cursor) {
        s.cursor = null;
        this.dirty = true;
      }
      throw err;
    }
    const any = await this.take(token, scan.found, { priority: SWEEP });
    if (scan.hasMore && scan.cursor) {
      s.cursor = scan.cursor;
    } else if (s.phase === "page") {
      s.phase = "data_source";
      s.cursor = null;
    } else {
      s.phase = null;
      s.cursor = null;
      s.doneAt = now;
    }
    this.dirty = true;
    return any;
  }

  /** The last edited pages and databases: new top-level ones, renamed and restored ones. */
  async recent(token: string, alive: () => boolean): Promise<boolean> {
    const scan = await this.scan(token, { sort: NEWEST, page_size: CHECK_SIZE }, { priority: UPKEEP, alive });
    return this.take(token, scan.found, { priority: UPKEEP, alive });
  }

  /** The last trashed pages: any kept one goes. */
  async trash(token: string, alive: () => boolean): Promise<boolean> {
    const answer = await call(token, "POST", SEARCH, {
      filter: { property: "object", value: "page", in_trash: true },
      sort: NEWEST,
      page_size: CHECK_SIZE,
    }, { priority: UPKEEP, alive });
    let any = false;
    for (const item of Array.isArray(answer.results) ? answer.results : []) {
      const id = (item as Json).id;
      if (typeof id === "string" && this.drop(id)) any = true;
    }
    return any;
  }

  /**
   * The next kept root, as Notion has it now: gone when it was moved under
   * another page, trashed, deleted or unshared; renamed when its title changed.
   */
  async check(token: string, alive: () => boolean): Promise<boolean> {
    const s = this.saved;
    if (s.roots.length === 0) return false;
    if (s.next >= s.roots.length) s.next = 0;
    const root = s.roots[s.next];
    s.next += 1;
    let answer: Json;
    try {
      answer = await call(token, "GET", `${root.kind === "database" ? "databases" : "pages"}/${root.id}`, undefined, { priority: UPKEEP, alive });
    } catch (err) {
      if (err instanceof NotionError && (err.status === 404 || err.status === 403)) return this.drop(root.id);
      throw err;
    }
    const parent = (answer.parent ?? {}) as Json;
    if (answer.in_trash === true || answer.archived === true || parent.type !== "workspace") return this.drop(root.id);
    const title = (root.kind === "database" ? plainText(answer.title) : pageTitle(answer)) || "Untitled";
    if (title === root.title) return false;
    s.roots = s.roots.map((r) => (r.id === root.id ? { ...r, title } : r));
    this.changed();
    return true;
  }
}
