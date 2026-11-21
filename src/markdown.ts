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

/**
 * The page's subpages, databases and to-dos, in the page's order, however deep.
 * A to-do keeps `index`, its place among the page's to-dos, empty ones
 * included, so its block can be found when it is ticked. Its id is made of its
 * text and which of the to-dos with that text it is, so it stays the same when
 * other to-dos come and go. A to-do whose line no other line contains keeps
 * the line, to be ticked by editing the page's markdown. Code blocks are skipped.
 */
export function entriesFromMarkdown(pageId: string, md: string): Entry[] {
  const entries: Entry[] = [];
  const lines = md.split("\n");
  let todos = 0;
  const titles: Record<string, number> = {};
  let inCode = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;

    const todo = TODO.exec(line);
    if (todo) {
      const index = todos;
      todos += 1;
      const title = inlineText(todo[2]);
      if (!title) continue;
      const seen = (titles[title] ?? 0) + 1;
      titles[title] = seen;
      const raw = line.trim();
      const entry: Entry = { kind: "todo", id: `${pageId}/${seen}/${title}`, title, done: todo[1] !== " ", page: pageId, index };
      // Unique whichever way the other to-dos are ticked, so a change made meanwhile cannot make it ambiguous.
      const rest = `] ${raw.substring(6)}`;
      entries.push(lines.filter((l) => l.indexOf(rest) >= 0).length === 1 ? { ...entry, line: raw } : entry);
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
      if (id) entries.push({ kind, id, title: inlineText(text.split(close)[0]) || "Untitled" });
    }
  }
  return entries;
}
