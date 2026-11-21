/**
 * Reads a page from Notion's markdown (`GET /pages/{id}/markdown`, version 2).
 *
 * One request returns the whole page: to-dos inside toggles, columns,
 * callouts, quotes, synced blocks and lists, nested to-dos, subpages and
 * databases wherever they sit. The page's blocks would take a request per
 * container. The markdown has no block ids, so a to-do carries its place among
 * the page's to-dos instead, and `source.ts` finds its block when it is ticked.
 *
 * Pure, so it is tested off the device.
 */

import { dashed } from "./link.ts";
import { type Entry, MAX_TITLE } from "./tasks.ts";

const TODO = /^\s*- \[([ xX])\] ?(.*)$/;
/** The `url` attribute itself, not the end of `data-source-url`. */
const OPENS = /^\s*<(page|database)\s(?:[^>]*\s)?url="([^"]+)"[^>]*>(.*)$/;
const HEX32 = /([0-9a-fA-F]{32})(?:[?#].*)?$/;

/** The object id at the end of a Notion URL. */
function idOf(url: string): string {
  const match = HEX32.exec(url.split("-").join(""));
  return match ? dashed(match[1]) : "";
}

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": "\"", "&#39;": "'" };

/** Plain text of one line of Notion's markdown: no tags, links or escapes. */
export function inlineText(md: string): string {
  let s = md;
  // A date mention has no text of its own: its start date stands in.
  s = s.replace(/<mention-date[^>]*\sstart="([^"]*)"[^>]*\/?>/g, "$1");
  s = s.replace(/<[^>]*>/g, "");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\\(.)/g, "$1");
  s = s.replace(/&(lt|gt|amp|quot|#39);/g, (m) => ENTITIES[m] ?? m);
  return s.replace(/\s+/g, " ").trim().substring(0, MAX_TITLE);
}

/** For telling a to-do in the markdown from its block: letters and digits only, any case. */
export function sameText(a: string, b: string): boolean {
  // No Unicode property escapes: the bar's JerryScript may lack them, so punctuation is listed.
  const key = (s: string) => s.toLowerCase().replace(/[\s.,:;!?'"()[\]{}<>\u00ab\u00bb\u2013\u2014\-_*`~/\\|@#$%^&+=]+/g, "");
  const x = key(a);
  const y = key(b);
  return x === y || (x.length >= 8 && y.length >= 8 && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0));
}

const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
/** A toggle, or a to-do written as a tag: Notion does that for a to-do with children inside a toggle. */
const BLOCK_OPEN = /^\s*<(toggle|todo)\b([^>]*)>(.*)$/;
const BLOCK_CLOSE = /^\s*<\/(toggle|todo)>/;

/** Leading whitespace as columns; a tab is a level, as two spaces are. */
function indentOf(s: string): number {
  return s.replace(/\t/g, "  ").length;
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
 * in them is listed in place. Plain paragraphs are left out.
 *
 * A to-do keeps `index`, its place among the page's to-dos, empty ones
 * included, so its block can be found when it is ticked. An empty to-do is not
 * shown and adds no level: the to-dos under it sit where it would. A to-do's
 * id is made of its text and which of the to-dos with that text it is, so it
 * stays the same when other to-dos come and go. A to-do whose line no other
 * line contains keeps the line, to be ticked by editing the page's markdown.
 */
export function entriesFromMarkdown(pageId: string, md: string): Entry[] {
  const entries: Entry[] = [];
  const lines = md.split("\n");
  let todos = 0;
  const titles: Record<string, number> = {};
  const occurrence = (key: string) => {
    const seen = (titles[key] ?? 0) + 1;
    titles[key] = seen;
    return seen;
  };
  const stack: Context[] = [{ base: 0, toggles: [], list: [] }];
  /** A toggle or a to-do tag whose title is the next line with text. */
  let untitled: { kind: "toggle" | "todo"; at: number; depth: number; toggles: string[]; done: boolean; index: number } | null = null;
  let inCode = false;

  const titled = (title: string) => {
    if (!untitled) return;
    const u = untitled;
    untitled = null;
    const inside = stack[stack.length - 1];
    if (u.kind === "toggle") {
      const shown = title || "Untitled";
      const id = `${pageId}/toggle/${occurrence(`toggle:${shown}`)}/${shown}`;
      entries[u.at] = { kind: "toggle", id, title: shown, depth: u.depth, toggles: u.toggles };
      inside.toggles = u.toggles.concat([id]);
    } else if (title) {
      entries[u.at] = { kind: "todo", id: `${pageId}/${occurrence(title)}/${title}`, title, done: u.done, page: pageId, index: u.index, depth: u.depth, toggles: u.toggles };
    } else {
      // An empty to-do: not shown, and what is under it sits where it would.
      entries.splice(u.at, 1);
      inside.base = u.depth;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    // A toggle's or a to-do tag's title is the line right after the tag: a blank one means none.
    if (untitled && line.trim() === "") titled("");
    if (line.trim() === "") continue;
    const c = stack[stack.length - 1];

    const block = BLOCK_OPEN.exec(line);
    if (block) {
      titled("");
      const kind = block[1] as "toggle" | "todo";
      const indent = indentOf((/^\s*/.exec(line) ?? [""])[0]);
      while (c.list.length > 0 && c.list[c.list.length - 1].indent >= indent) c.list.pop();
      const depth = c.base + c.list.filter((l) => l.shows).length;
      c.list = [];
      const index = kind === "todo" ? todos : -1;
      if (kind === "todo") todos += 1;
      untitled = { kind, at: entries.length, depth, toggles: c.toggles, done: /checked="true"/.test(block[2]), index };
      entries.push({ kind, id: "", title: "", depth, toggles: c.toggles });
      stack.push({ base: depth + 1, toggles: c.toggles, list: [] });
      const rest = inlineText(block[3]);
      if (rest) titled(rest);
      continue;
    }
    if (BLOCK_CLOSE.test(line)) {
      titled("");
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (untitled) {
      titled(inlineText(line));
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const indent = indentOf(item[1]);
      while (c.list.length > 0 && c.list[c.list.length - 1].indent >= indent) c.list.pop();
      const depth = c.base + c.list.filter((l) => l.shows).length;
      const todo = TODO.exec(line);
      if (!todo) {
        c.list.push({ indent, shows: false });
        continue;
      }
      const index = todos;
      todos += 1;
      const title = inlineText(todo[2]);
      c.list.push({ indent, shows: title !== "" });
      if (!title) continue;
      const raw = line.trim();
      const entry: Entry = {
        kind: "todo",
        id: `${pageId}/${occurrence(title)}/${title}`,
        title,
        done: todo[1] !== " ",
        page: pageId,
        index,
        depth,
        toggles: c.toggles,
      };
      // Unique whichever way the other to-dos are ticked, so a change made meanwhile cannot make it ambiguous.
      const rest = `] ${raw.substring(6)}`;
      entries.push(lines.filter((l) => l.indexOf(rest) >= 0).length === 1 ? { ...entry, line: raw } : entry);
      continue;
    }
    // Anything else at the left edge ends the lists above it.
    if (indentOf((/^\s*/.exec(line) ?? [""])[0]) === 0) c.list = [];

    const heading = HEADING.exec(line);
    if (heading) {
      const title = inlineText(heading[1]);
      if (title) entries.push({ kind: "heading", id: `${pageId}/heading/${occurrence(`heading:${title}`)}/${title}`, title, depth: c.base, toggles: c.toggles });
      continue;
    }

    const opens = OPENS.exec(line);
    if (opens) {
      const kind = opens[1] as "page" | "database";
      const close = `</${kind}>`;
      // The title follows the tag, on the same line or the next ones, up to the closing tag.
      let text = opens[3];
      while (text.indexOf(close) < 0 && i + 1 < lines.length) {
        i += 1;
        text += ` ${lines[i]}`;
      }
      const id = idOf(opens[2]);
      if (id) entries.push({ kind, id, title: inlineText(text.split(close)[0]) || "Untitled", depth: c.base, toggles: c.toggles });
    }
  }
  titled("");

  // A toggle counts the open tasks inside it.
  return entries.map((e) => (e.kind === "toggle"
    ? { ...e, count: entries.filter((t) => t.kind === "todo" && !t.done && (t.toggles ?? []).indexOf(e.id) >= 0).length }
    : e));
}

/** What shows of a page: everything not inside a closed toggle. */
export function shownEntries(entries: readonly Entry[], open: ReadonlySet<string>): Entry[] {
  return entries.filter((e) => (e.toggles ?? []).every((t) => open.has(t)));
}
