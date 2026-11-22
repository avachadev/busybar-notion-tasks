/**
 * Reads a page from Notion's markdown (`GET /pages/{id}/markdown`, version 2).
 *
 * One request returns the whole page: to-dos inside toggles, columns,
 * callouts, quotes, synced blocks and lists, nested to-dos, subpages and
 * databases wherever they sit. The page's blocks would take a request per
 * container. The markdown has no block ids, so a to-do carries its place among
 * the page's to-dos instead, and `source.ts` finds its block when it is ticked.
 *
 * Lines are taken one at a time (`PageReader`), as `stream.ts` cuts them from
 * the answer while it arrives: the bar's heap is 256 KiB, and a page of notes
 * can be hundreds of kilobytes. A line is only decoded when it is kept.
 *
 * Pure, so it is tested off the device.
 */

import { dashed } from "./link.ts";
import { type Entry, MAX_TITLE } from "./tasks.ts";

const TODO = /^\s*- \[([ xX])\] ?(.*)$/;
const HEX32 = /^[0-9a-fA-F]{32}$/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
/** A toggle, or a to-do written as a tag: Notion does that for a to-do with children inside a toggle. */
const BLOCK_OPEN = /^\s*<(toggle|todo)\b([^>]*)>(.*)$/;

/**
 * Lines kept from one page, at most: the rest of a longer page is not read.
 * A line costs a few hundred bytes of the bar's 256 KiB heap; 600 of them ran it out.
 */
export const MAX_ENTRIES = 150;

/**
 * The object id at the end of a Notion URL: its last 32 hex digits, before any
 * query or fragment. Plain string work: a regular expression searching the URL
 * cost milliseconds a line on the bar.
 */
function idOf(url: string): string {
  let end = url.length;
  const query = url.indexOf("?");
  if (query >= 0) end = query;
  const fragment = url.indexOf("#");
  if (fragment >= 0 && fragment < end) end = fragment;
  const tail = url.substring(Math.max(0, end - 40), end).split("-").join("");
  const hex = tail.substring(tail.length - 32);
  return HEX32.test(hex) ? dashed(hex) : "";
}

/**
 * A `<page ...>` or `<database ...>` tag's kind, its `url` attribute (not the
 * end of `data-source-url`) and what follows the tag on its line.
 */
function openTag(text: string): { kind: "page" | "database"; url: string; rest: string } | null {
  const kind = text.substring(0, 5) === "<page" ? "page" : text.substring(0, 9) === "<database" ? "database" : null;
  if (!kind) return null;
  const close = text.indexOf(">");
  if (close < 0) return null;
  const attrs = text.substring(0, close);
  let at = attrs.indexOf(" url=\"");
  if (at < 0) return null;
  at += 6;
  const end = attrs.indexOf("\"", at);
  if (end < 0) return null;
  return { kind, url: attrs.substring(at, end), rest: text.substring(close + 1) };
}

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": "\"", "&#39;": "'" };

/** Plain text of one line of Notion's markdown: no tags, links or escapes. */
export function inlineText(md: string): string {
  // Most titles are plain text: one test instead of eight replacements, which cost about 3 ms a title on the bar.
  if (!/[<>\\&[\]\s]\s|[<>\\&[\]\t\n]/.test(md)) return md.trim().substring(0, MAX_TITLE);
  let s = md;
  // Escaped characters are text: set them aside, so `\<b>` is not taken for a tag nor `\&amp;` for an entity.
  s = s.replace(/\\</g, "\u0001").replace(/\\>/g, "\u0002").replace(/\\&/g, "\u0003");
  // A date mention has no text of its own: its start date stands in.
  s = s.replace(/<mention-date[^>]*\sstart="([^"]*)"[^>]*\/?>/g, "$1");
  s = s.replace(/<[^>]*>/g, "");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\\(.)/g, "$1");
  s = s.replace(/&(lt|gt|amp|quot|#39);/g, (m) => ENTITIES[m] ?? m);
  s = s.replace(/\u0001/g, "<").replace(/\u0002/g, ">").replace(/\u0003/g, "&");
  return s.replace(/\s+/g, " ").trim().substring(0, MAX_TITLE);
}

/** For telling a to-do in the markdown from its block: letters and digits only, any case. */
export function sameText(a: string, b: string): boolean {
  // No Unicode property escapes: the bar's JerryScript may lack them, so punctuation is listed.
  const key = (s: string) => s.toLowerCase().replace(/[\s.,:;!?'"()[\]{}<>«»–—\-_*`~/\\|@#$%^&+=]+/g, "");
  const x = key(a);
  const y = key(b);
  return x === y || (x.length >= 8 && y.length >= 8 && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0));
}

/** A short tag for a text, for ids: 32 bits of FNV-1a. */
function tag(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** One line of a page's markdown: what it starts with, cheaply, and its text when asked. */
export interface Line {
  /** Columns of leading whitespace; a tab counts two. */
  readonly indent: number;
  /** Nothing but whitespace. */
  readonly blank: boolean;
  /** The ASCII start after the indent: enough to tell what the line is. */
  readonly head: string;
  /** The whole line, without the indent. */
  text(): string;
}

/** A line of a markdown string, for pages read whole and for tests. */
function stringLine(s: string): Line {
  const lead = (/^\s*/.exec(s) ?? [""])[0];
  const body = s.substring(lead.length);
  return { indent: lead.replace(/\t/g, "  ").length, blank: body === "", head: (/^[\x00-\x7f]*/.exec(body.substring(0, 12)) ?? [""])[0], text: () => body };
}

/** Where the lines being read sit: how deep, inside which toggles, under which list items. */
interface Context {
  base: number;
  toggles: string[];
  /** Open list items above the current line: their indent, and whether they show (and so add a level). */
  list: { indent: number; shows: boolean }[];
}

/**
 * The page's subpages, databases, toggles, headings and to-dos, in the page's
 * order, however deep, each with its depth and the toggles it is inside.
 * Columns, callouts, quotes and synced blocks add nothing of their own: what is
 * in them is listed in place. Plain paragraphs, tables and code are left out.
 *
 * A to-do keeps `index`, its place among the page's to-dos, empty ones
 * included, so its block can be found when it is ticked. An empty to-do is not
 * shown and adds no level: the to-dos under it sit where it would. A to-do's
 * id is made of its text and which of the to-dos with that text it is, so it
 * stays the same when other to-dos come and go. A to-do whose text is the only
 * one of its kind keeps its line, to be ticked by editing the page's markdown.
 */
export class PageReader {
  readonly entries: Entry[] = [];
  /** MAX_ENTRIES are read: the rest of the page is not wanted. */
  full = false;
  private readonly short: string;
  private todos = 0;
  private readonly seen: Record<string, number> = {};
  private readonly stack: Context[] = [{ base: 0, toggles: [], list: [] }];
  /** A toggle or a to-do tag whose title is the next line. */
  private untitled: { kind: "toggle" | "todo"; at: number; depth: number; toggles: string[]; done: boolean; index: number } | null = null;
  /** A page or database tag whose title runs on to the closing tag. */
  private open: { kind: "page" | "database"; id: string; text: string; depth: number; toggles: string[] } | null = null;
  private inCode = false;
  /** Each kept to-do's line, by entry, until `finish` tells which can be ticked by it. */
  private readonly raw: (string | undefined)[] = [];
  /** The last line with text was this entry's to-do: its line has no line break after it. */
  private lastTodo = -1;

  private readonly pageId: string;

  constructor(pageId: string) {
    this.pageId = pageId;
    this.short = pageId.replace(/-/g, "").substring(0, 8);
  }

  private occurrence(key: string): number {
    const n = (this.seen[key] ?? 0) + 1;
    this.seen[key] = n;
    return n;
  }

  private add(entry: Entry, raw?: string): void {
    this.entries.push(entry);
    this.raw.push(raw);
    if (this.entries.length >= MAX_ENTRIES) this.full = true;
  }

  private titled(title: string): void {
    const u = this.untitled;
    if (!u) return;
    this.untitled = null;
    const inside = this.stack[this.stack.length - 1];
    if (u.kind === "toggle") {
      const shown = title || "Untitled";
      const id = `${this.short}/t${tag(shown)}/${this.occurrence(`t${shown}`)}`;
      this.entries[u.at] = { kind: "toggle", id, title: shown, depth: u.depth, toggles: u.toggles };
      inside.toggles = u.toggles.concat([id]);
    } else if (title) {
      const id = `${this.short}/${tag(title)}/${this.occurrence(title)}`;
      this.entries[u.at] = { kind: "todo", id, title, done: u.done, page: this.pageId, index: u.index, depth: u.depth, toggles: u.toggles };
    } else {
      // An empty to-do: not shown, and what is under it sits where it would.
      this.entries.splice(u.at, 1);
      this.raw.splice(u.at, 1);
      inside.base = u.depth;
    }
  }

  /** Takes the page's next line. */
  push(line: Line): void {
    if (this.full) return;
    const head = line.head;
    if (head.substring(0, 3) === "```") {
      this.inCode = !this.inCode;
      return;
    }
    if (this.inCode) return;
    // A toggle's or a to-do tag's title is the line right after the tag: a blank one means none.
    if (line.blank) {
      if (this.untitled) this.titled("");
      return;
    }
    this.lastTodo = -1;
    if (this.open) {
      // The closing tag alone on its line needs no decoding.
      const close = `</${this.open.kind}>`;
      this.closeTag(head.substring(0, close.length) === close ? close : ` ${line.text()}`);
      return;
    }
    const c = this.stack[this.stack.length - 1];

    if (head.substring(0, 7) === "<toggle" || head.substring(0, 5) === "<todo") {
      const block = BLOCK_OPEN.exec(line.text());
      if (block) {
        this.titled("");
        const kind = block[1] as "toggle" | "todo";
        while (c.list.length > 0 && c.list[c.list.length - 1].indent >= line.indent) c.list.pop();
        const depth = c.base + c.list.filter((l) => l.shows).length;
        c.list = [];
        const index = kind === "todo" ? this.todos : -1;
        if (kind === "todo") this.todos += 1;
        this.untitled = { kind, at: this.entries.length, depth, toggles: c.toggles, done: /checked="true"/.test(block[2]), index };
        this.add({ kind, id: "", title: "", depth, toggles: c.toggles });
        this.stack.push({ base: depth + 1, toggles: c.toggles, list: [] });
        const rest = inlineText(block[3]);
        if (rest) this.titled(rest);
        return;
      }
    }
    if (head.substring(0, 9) === "</toggle>" || head.substring(0, 7) === "</todo>") {
      this.titled("");
      if (this.stack.length > 1) this.stack.pop();
      return;
    }
    if (this.untitled) {
      this.titled(inlineText(line.text()));
      return;
    }

    if (LIST_ITEM.test(head)) {
      while (c.list.length > 0 && c.list[c.list.length - 1].indent >= line.indent) c.list.pop();
      const depth = c.base + c.list.filter((l) => l.shows).length;
      if (head.substring(0, 3) !== "- [") {
        c.list.push({ indent: line.indent, shows: false });
        return;
      }
      const raw = line.text();
      const todo = TODO.exec(raw);
      if (!todo) {
        c.list.push({ indent: line.indent, shows: false });
        return;
      }
      const index = this.todos;
      this.todos += 1;
      const title = inlineText(todo[2]);
      c.list.push({ indent: line.indent, shows: title !== "" });
      if (!title) return;
      const id = `${this.short}/${tag(title)}/${this.occurrence(title)}`;
      this.lastTodo = this.entries.length;
      this.add({ kind: "todo", id, title, done: todo[1] !== " ", page: this.pageId, index, depth, toggles: c.toggles }, raw);
      return;
    }
    // Anything else at the left edge ends the lists above it.
    if (line.indent === 0) c.list = [];

    if (head.charAt(0) === "#") {
      const heading = HEADING.exec(line.text());
      const title = heading ? inlineText(heading[1]) : "";
      if (title) this.add({ kind: "heading", id: `${this.short}/h${tag(title)}/${this.occurrence(`h${title}`)}`, title, depth: c.base, toggles: c.toggles });
      return;
    }

    if (head.substring(0, 5) === "<page" || head.substring(0, 9) === "<database") {
      const opens = openTag(line.text());
      if (!opens) return;
      const id = idOf(opens.url);
      if (!id) return;
      this.open = { kind: opens.kind, id, text: "", depth: c.base, toggles: c.toggles };
      this.closeTag(opens.rest);
    }
  }

  /** Adds to the open page or database tag's title, and takes the entry once the tag closes. */
  private closeTag(more: string): void {
    const o = this.open;
    if (!o) return;
    const close = `</${o.kind}>`;
    // A title is short: a tag that runs on is cut, rather than kept growing.
    o.text = (o.text + more).substring(0, 4 * MAX_TITLE);
    if (more.indexOf(close) < 0) return;
    this.open = null;
    this.add({ kind: o.kind, id: o.id, title: inlineText(o.text.split(close)[0]) || "Untitled", depth: o.depth, toggles: o.toggles });
  }

  /**
   * The entries, once the page is read. A to-do whose text no other to-do has
   * keeps its line for ticking, with the line break after it, so it cannot be
   * found inside a longer line; the page's last line has none, and keeps its
   * line only if no other to-do's text begins with its own.
   */
  finish(): Entry[] {
    this.titled("");
    const entries = this.entries;
    const count: Record<string, number> = {};
    const textOf = (raw: string) => raw.substring(6);
    this.raw.forEach((raw) => {
      if (raw !== undefined) count[textOf(raw)] = (count[textOf(raw)] ?? 0) + 1;
    });
    const last = this.full ? -1 : this.lastTodo;
    const lastText = last >= 0 ? textOf(this.raw[last] ?? "") : "";
    const extends_ = last >= 0 && this.raw.some((raw, i) => raw !== undefined && i !== last && textOf(raw).indexOf(lastText) === 0);
    const open: Record<string, number> = {};
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      const raw = this.raw[i];
      if (raw !== undefined && count[textOf(raw)] === 1 && !(i === last && extends_)) {
        entries[i] = { ...e, line: i === last ? raw : `${raw}\n` };
      }
      if (e.kind === "todo" && !e.done) for (const t of e.toggles ?? []) open[t] = (open[t] ?? 0) + 1;
    }
    for (let i = 0; i < entries.length; i += 1) {
      if (entries[i].kind === "toggle") entries[i] = { ...entries[i], count: open[entries[i].id] ?? 0 };
    }
    if (this.full) entries.push({ kind: "heading", id: `${this.short}/more`, title: "More in Notion", depth: 0, toggles: [] });
    return entries;
  }
}

/** Every entry of a page's markdown, read whole: for tests, and for a page that came in one piece. */
export function entriesFromMarkdown(pageId: string, md: string): Entry[] {
  const reader = new PageReader(pageId);
  const lines = md.split("\n");
  for (let i = 0; i < lines.length && !reader.full; i += 1) reader.push(stringLine(lines[i]));
  return reader.finish();
}

/** What shows of a page: everything not inside a closed toggle. */
export function shownEntries(entries: readonly Entry[], open: ReadonlySet<string>): Entry[] {
  return entries.filter((e) => (e.toggles ?? []).every((t) => open.has(t)));
}
