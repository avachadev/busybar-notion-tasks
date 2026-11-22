/**
 * Finds the top-level pages and databases in a search answer while it
 * arrives, without holding it or parsing it (`docs/roots.md`).
 *
 * An answer of 100 pages is about 95 KB; the bar's `JSON.parse` would need
 * several times that of a 384 KiB heap. One `Uint8Array.indexOf` pass over it
 * costs about 340 ms on the bar (3.6 us a byte, measured), which is the floor:
 * each chunk is searched once, for `w`, which is rare in an answer. A `w` that
 * is the one of `"type":"workspace"` after `"parent":{` marks a top-level
 * result. Only then is anything else looked at: the result's id, back from the
 * hit, and a page's title, forward from it. Chunks are kept by reference, never
 * joined: copying costs as much as searching.
 *
 * Measured key order (22.11.2026): a page is `{"object":"page","id":...,
 * "cover":...,"icon":...,"parent":{...},...,"properties":{...title...},"url":...}`;
 * a data source ends `"parent":{"type":"database_id","database_id":"<id>"},
 * "database_parent":{"type":"workspace",...}`, its title far before, after
 * which comes its schema (up to 24 KB): a database's title is not read here.
 */

import { decode } from "./stream.ts";
import { MAX_TITLE } from "./tasks.ts";

export interface TopLevel {
  readonly kind: "page" | "database";
  readonly id: string;
  /** A page's title; null for a database, whose title is read on its own. */
  readonly title: string | null;
  /** A page's icon when it is an emoji (`"icon":{"type":"emoji","emoji":"..."}`), else "". */
  readonly icon: string;
  /**
   * Only in a scan of shared data sources: the id of the page or block the
   * database is in, "" for the workspace.
   */
  readonly parent?: string;
  /** With `parent`: "page_id" or "block_id". */
  readonly parentType?: string;
}

const W = 0x77;
const J = 0x6a;
const UNDERSCORE = 0x5f;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const CLOSE_BRACE = 0x7d;
const COMMA = 0x2c;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACKET = 0x5b;

const ascii = (s: string): number[] => s.split("").map((c) => c.charCodeAt(0));
/** What comes before the hit: `parent":{"type":"`, after a `"` for a page or `"database_` for a data source. */
const PARENT_TAIL = ascii('parent":{"type":"');
const DATABASE_HEAD = ascii('"database_');
const AFTER_W = ascii('orkspace"');
const PAGE_START = ascii('"object":"page","id":"');
const DATABASE_ID = ascii('"database_id":"');
const PLAIN_TEXT = ascii('"plain_text":"');
const TITLE_KEY = ascii('"title":[');
const EMOJI_KEY = ascii('"emoji":"');
/** A data source's start and its database's parent, found by their `_` in a scan of shared data sources. */
const SOURCE_START = ascii('"object":"data_source","id":"');
const SOURCE_START_U = 14;
const DATABASE_PARENT = ascii('"database_parent":{"type":"');
const DATABASE_PARENT_U = 9;
const WORKSPACE = "workspace";
/** From the start of a data source's `"database_id":"` to the `w`: the key, the id, `"},`, the key, `{"type":"`. */
const DATABASE_ID_BACK = DATABASE_ID.length + 36 + 3 + 27;
/** How far back a page's start may be from its parent: a cover and an icon with long URLs fit. */
const MAX_BACK = 4096;
/** A title that has not ended this far after its hit is given up as untitled. */
const MAX_TITLE_BYTES = 6144;

/** A title being read: where the search stands, and what has been read so far. */
interface TitleJob {
  /**
   * A database is found whole at its hit; it waits in line only to keep the
   * answer's order. A source's title is read at its start and kept until its
   * database's parent, at its end, says where it is.
   */
  readonly kind: "page" | "database" | "source";
  readonly id: string;
  readonly icon: string;
  readonly hit: number;
  pos: number;
  /** Past the `"title":[` that opens the page's title: until then `pos` looks for it. */
  inside: boolean;
  title: string;
}

/**
 * The chunks still needed, with their absolute offsets: the last few, for
 * looking back from a hit, and any a title being read still needs.
 */
class Window {
  private readonly chunks: Uint8Array[] = [];
  private readonly starts: number[] = [];
  /** Absolute offset just past the last byte received. */
  end = 0;

  add(chunk: Uint8Array, keepFrom: number): void {
    this.chunks.push(chunk);
    this.starts.push(this.end);
    this.end += chunk.length;
    while (this.chunks.length > 1 && this.starts[1] <= keepFrom) {
      this.chunks.shift();
      this.starts.shift();
    }
  }

  get first(): number {
    return this.starts.length > 0 ? this.starts[0] : this.end;
  }

  private chunkAt(abs: number): number {
    for (let i = this.chunks.length - 1; i >= 0; i -= 1) if (abs >= this.starts[i]) return i;
    return -1;
  }

  /** The byte at `abs`, or -1 when it has not arrived or is no longer kept. */
  at(abs: number): number {
    if (abs < this.first || abs >= this.end) return -1;
    const i = this.chunkAt(abs);
    return this.chunks[i][abs - this.starts[i]];
  }

  /** Whether `bytes` stand at `abs`; null when some of them have not arrived. */
  matches(abs: number, bytes: readonly number[]): boolean | null {
    if (abs < this.first) return false;
    if (abs + bytes.length > this.end) return null;
    for (let k = 0; k < bytes.length; k += 1) if (this.at(abs + k) !== bytes[k]) return false;
    return true;
  }

  /** The first `byte` at or after `abs`, across chunks; -1 when none has arrived. */
  indexOf(byte: number, abs: number): number {
    let i = this.chunkAt(Math.max(abs, this.first));
    if (i < 0) i = 0;
    for (; i < this.chunks.length; i += 1) {
      const from = Math.max(0, abs - this.starts[i]);
      if (from >= this.chunks[i].length) continue;
      const found = this.chunks[i].indexOf(byte, from);
      if (found >= 0) return this.starts[i] + found;
    }
    return -1;
  }

  /** The last `byte` at or before `abs`, no further back than `limit`; -1 when none. */
  lastIndexOf(byte: number, abs: number, limit: number): number {
    for (let i = this.chunkAt(abs); i >= 0; i -= 1) {
      if (this.starts[i] + this.chunks[i].length <= limit) break;
      const from = Math.min(abs - this.starts[i], this.chunks[i].length - 1);
      const found = this.chunks[i].lastIndexOf(byte, from);
      if (found >= 0) return this.starts[i] + found >= limit ? this.starts[i] + found : -1;
    }
    return -1;
  }

  /** The bytes from `from` to `to`, joined: only ever a title or an id, so the copy is small. */
  slice(from: number, to: number): Uint8Array {
    const out = new Uint8Array(to - from);
    for (let i = 0; i < this.chunks.length; i += 1) {
      const s = this.starts[i];
      const e = s + this.chunks[i].length;
      if (e <= from || s >= to) continue;
      const a = Math.max(from, s);
      const b = Math.min(to, e);
      out.set(this.chunks[i].subarray(a - s, b - s), a - from);
    }
    return out;
  }
}

/**
 * Takes a search answer chunk by chunk and collects its top-level results in
 * `found`; `end()` reads the cursor for the next page of results.
 */
export class SearchScan {
  readonly found: TopLevel[] = [];
  /**
   * `shared`: the answer is a search of data sources for an internal
   * connection, whose top level includes databases under pages it cannot see.
   * Every data source is then taken, with its title and its database's
   * parent: found by their `_`, which is common in a schema, but each costs a
   * few byte compares (a 24 KB schema has a few hundred).
   */
  private readonly shared: boolean;

  constructor(shared = false) {
    this.shared = shared;
  }
  /** Hits that did not fit a result as the scan expects: reported, not guessed at. */
  odd = 0;
  cursor: string | null = null;
  hasMore = false;
  private readonly win = new Window();
  /** Positions of `w` whose following bytes had not arrived. */
  private waiting: number[] = [];
  /** The same for `_` in a scan of shared data sources. */
  private waitingU: number[] = [];
  /** The title and icon of the data source being read, until its database's parent. */
  private source: { title: string; icon: string } | null = null;
  private jobs: TitleJob[] = [];

  feed(chunk: Uint8Array): void {
    const from = this.win.end;
    // Kept: enough to look back from a hit (a hit still waiting lies in the last few bytes), and all a title being read needs.
    const keep = Math.min(this.win.end - MAX_BACK, this.jobs.length > 0 ? this.jobs[0].pos - TITLE_KEY.length : Infinity);
    this.win.add(chunk, keep);
    const again = this.waiting;
    this.waiting = [];
    for (const hit of again) this.check(hit);
    if (this.shared) {
      const againU = this.waitingU;
      this.waitingU = [];
      // In order: a source's title job is queued before its parent is looked at.
      for (const u of againU) this.checkShared(u);
      for (let i = chunk.indexOf(UNDERSCORE); i >= 0; i = chunk.indexOf(UNDERSCORE, i + 1)) this.checkShared(from + i);
    } else {
      for (let i = chunk.indexOf(W); i >= 0; i = chunk.indexOf(W, i + 1)) this.check(from + i);
    }
    this.runJobs();
  }

  /** A `_` in a scan of shared data sources: a source's start, its database's parent, or nothing. */
  private checkShared(u: number): void {
    const start = this.win.matches(u - SOURCE_START_U, SOURCE_START);
    if (start === true) {
      const at = u - SOURCE_START_U;
      this.source = null;
      this.jobs.push({ kind: "source", id: "", icon: "", hit: u, pos: at + SOURCE_START.length, inside: false, title: "" });
      return;
    }
    const parent = this.win.matches(u - DATABASE_PARENT_U, DATABASE_PARENT);
    if (parent === true) {
      // Its source's title is read by now: it comes before the schema.
      this.runJobs();
      if (this.parentAt(u - DATABASE_PARENT_U) === "wait") this.waitingU.push(u);
      return;
    }
    if (start === null || parent === null) this.waitingU.push(u);
  }

  /** Reads a database's parent at `start` and takes the database: its id stands just before. */
  private parentAt(start: number): "wait" | "done" {
    const t = start + DATABASE_PARENT.length;
    const q = this.win.indexOf(QUOTE, t);
    if (q < 0) return "wait";
    if (q - t > 16) {
      this.odd += 1;
      return "done";
    }
    const type = String.fromCharCode.apply(null, this.win.slice(t, q) as unknown as number[]);
    let parent = "";
    if (type !== WORKSPACE) {
      const key = ascii(`,"${type}":"`);
      const idAt = q + 1 + key.length;
      if (idAt + 36 > this.win.end) return "wait";
      if (this.win.matches(q + 1, key) !== true) {
        this.odd += 1;
        return "done";
      }
      parent = this.id(idAt);
    }
    const at = start - 3 - 36 - DATABASE_ID.length;
    if (this.win.matches(at, DATABASE_ID) !== true) {
      this.odd += 1;
      return "done";
    }
    const source = this.source;
    this.source = null;
    this.found.push({ kind: "database", id: this.id(at + DATABASE_ID.length), title: source && source.title ? source.title : null, icon: source ? source.icon : "", parent, parentType: parent ? type : "" });
    return "done";
  }

  /** The answer is over: a title still open is taken as read, and the cursor is read from the answer's tail. */
  end(): void {
    for (const job of this.jobs) if (job.kind !== "source") this.found.push({ kind: job.kind, id: job.id, title: job.title || null, icon: job.icon });
    this.jobs = [];
    const tailFrom = Math.max(this.win.first, this.win.end - 400);
    const tail = String.fromCharCode.apply(null, this.win.slice(tailFrom, this.win.end) as unknown as number[]);
    const cursor = /"next_cursor":(?:null|"([^"]+)")/.exec(tail);
    this.cursor = cursor && cursor[1] ? cursor[1] : null;
    this.hasMore = /"has_more":true/.test(tail);
  }

  private check(hit: number): void {
    const after = this.win.matches(hit + 1, AFTER_W);
    if (after === null) {
      this.waiting.push(hit);
      return;
    }
    if (!after || this.win.matches(hit - PARENT_TAIL.length, PARENT_TAIL) !== true) return;
    const lead = this.win.at(hit - PARENT_TAIL.length - 1);
    if (lead === QUOTE) this.page(hit);
    else if (lead === UNDERSCORE && this.win.matches(hit - PARENT_TAIL.length - DATABASE_HEAD.length, DATABASE_HEAD) === true) this.database(hit);
  }

  private id(at: number): string {
    return String.fromCharCode.apply(null, this.win.slice(at, at + 36) as unknown as number[]);
  }

  private page(hit: number): void {
    // Back to `"object":"page","id":"`: the `j` of "object", past the two users' ones in between.
    const limit = Math.max(this.win.first, hit - MAX_BACK);
    for (let j = this.win.lastIndexOf(J, hit, limit); j >= 0; j = this.win.lastIndexOf(J, j - 1, limit)) {
      if (this.win.matches(j - 3, PAGE_START) === true) {
        const start = j - 3;
        this.jobs.push({ kind: "page", id: this.id(start + PAGE_START.length), icon: this.icon(start, hit), hit, pos: hit, inside: false, title: "" });
        return;
      }
    }
    this.odd += 1;
  }

  /**
   * A page's emoji icon, between its start and its parent: `"emoji":"` is
   * looked for by its `j`, and only the first one counts (a cover or an
   * uploaded icon has none). "" when the icon is not an emoji.
   */
  private icon(start: number, hit: number): string {
    for (let j = this.win.indexOf(J, start + PAGE_START.length); j >= 0 && j < hit; j = this.win.indexOf(J, j + 1)) {
      if (this.win.matches(j - 4, EMOJI_KEY) !== true) continue;
      const from = j - 4 + EMOJI_KEY.length;
      const to = this.win.indexOf(QUOTE, from);
      if (to < 0 || to > hit || to - from > 64) return "";
      return decode(this.win.slice(from, to), 0, to - from);
    }
    return "";
  }

  private database(hit: number): void {
    const at = hit - DATABASE_ID_BACK;
    if (this.win.matches(at, DATABASE_ID) === true) {
      this.jobs.push({ kind: "database", id: this.id(at + DATABASE_ID.length), icon: "", hit, pos: hit, inside: true, title: "" });
    } else {
      this.odd += 1;
    }
  }

  /** Reads the titles the received bytes allow, in order; the first that needs more waits for the next chunk. */
  private runJobs(): void {
    while (this.jobs.length > 0) {
      const job = this.jobs[0];
      const state = job.kind === "database" ? "done" : this.title(job);
      if (state === "wait") return;
      this.jobs.shift();
      if (job.kind === "source") {
        // Its icon lies between its start and its title, which is read past by now.
        const icon = this.icon(job.hit - SOURCE_START_U, Math.min(job.pos, this.win.end));
        this.source = { title: state === "done" ? job.title : "", icon };
        continue;
      }
      this.found.push({ kind: job.kind, id: job.id, title: job.kind === "page" && state === "done" && job.title ? job.title : null, icon: job.icon });
    }
  }

  /**
   * A page's title: the `plain_text` of each part of its rich text, until the
   * array closes. "wait" when the bytes for the next step have not arrived.
   */
  private title(job: TitleJob): "done" | "wait" | "lost" {
    // The title property's array comes first after the parent (`properties` holds only it, by
    // `filter_properties=title`); a `[` in a property's name is not after `"title":`.
    while (!job.inside) {
      if (job.pos - job.hit > MAX_TITLE_BYTES) return "lost";
      const b = this.win.indexOf(OPEN_BRACKET, job.pos);
      const next = b < 0 ? -1 : this.win.at(b + 1);
      if (next < 0) {
        job.pos = b < 0 ? Math.max(job.pos, this.win.end - TITLE_KEY.length) : b - TITLE_KEY.length + 1;
        return "wait";
      }
      if (this.win.matches(b - TITLE_KEY.length + 1, TITLE_KEY) !== true) {
        job.pos = b + 1;
        continue;
      }
      // An empty title: nothing to read.
      if (next === CLOSE_BRACKET) return "done";
      job.inside = true;
      job.pos = b + 1;
    }
    for (;;) {
      if (job.pos - job.hit > MAX_TITLE_BYTES || job.title.length >= MAX_TITLE) return "done";
      const u = this.win.indexOf(UNDERSCORE, job.pos);
      if (u < 0) {
        job.pos = Math.max(job.pos, this.win.end - PLAIN_TEXT.length);
        return "wait";
      }
      const start = u - 6;
      const is = this.win.matches(start, PLAIN_TEXT);
      if (is === null) {
        job.pos = start;
        return "wait";
      }
      if (!is) {
        job.pos = u + 1;
        continue;
      }
      const from = start + PLAIN_TEXT.length;
      // The closing quote: one not escaped, so not after an odd run of backslashes.
      let q = this.win.indexOf(QUOTE, from);
      for (;;) {
        if (q < 0) {
          job.pos = start;
          return "wait";
        }
        let slashes = 0;
        while (this.win.at(q - 1 - slashes) === BACKSLASH) slashes += 1;
        if (slashes % 2 === 0) break;
        q = this.win.indexOf(QUOTE, q + 1);
      }
      // After the part: `,"href":...}` then `,` for another part or `]` for the end.
      const brace = this.win.indexOf(CLOSE_BRACE, q);
      const next = brace < 0 ? -1 : this.win.at(brace + 1);
      if (next < 0) {
        job.pos = start;
        return "wait";
      }
      job.title += decode(this.win.slice(from, q), 0, q - from);
      if (next === CLOSE_BRACKET) return "done";
      if (next !== COMMA) return "lost";
      job.pos = brace + 1;
    }
  }
}
