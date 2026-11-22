/**
 * Keeps where the user was in `localStorage`: the path from the start view,
 * and what each step of it showed. The app opens there at once, and going up
 * after a restart shows the level above without waiting for Notion.
 *
 * Every `setItem` rewrites the app's store to flash, so state is saved only
 * when it changed. The token is never stored here, only a short tag of it, so
 * titles saved under one token are not shown under another.
 */

import type { View } from "./source.ts";
import type { Database, Entry } from "./tasks.ts";

/** Bumped when what is saved changes shape: a place saved by an older version is not read. */
const KEY = "place2";

/** What one view showed. */
export interface Level {
  readonly entries: Entry[];
  readonly database: Database | null;
  /** The id of the focused entry: an index would point elsewhere once a toggle opens or closes. */
  readonly focus: string;
}

export interface Saved {
  /** `tokenTag` of the token it was read with. */
  readonly owner: string;
  /** The start page's id, or "" for the top-level pages: what `stack[0]` was read for. */
  readonly home: string;
  /** From the start view to the one on screen. */
  readonly stack: View[];
  /** One per step of `stack`, null where nothing was read yet. */
  readonly levels: (Level | null)[];
}

/** Entries kept per level: the store stays small, and a long list is read again anyway. */
const MAX_SAVED_ENTRIES = 40;

function storage(): Storage | undefined {
  return (globalThis as { localStorage?: Storage }).localStorage;
}

export function load(owner: string, home: string): Saved | null {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Saved;
    const ok = saved.owner === owner && saved.home === home && Array.isArray(saved.stack) && saved.stack.length > 0 &&
      Array.isArray(saved.levels) && saved.levels.length === saved.stack.length;
    return ok ? saved : null;
  } catch {
    return null;
  }
}

/**
 * Removes a place saved under another token, or under none when `owner` is "":
 * the titles of a workspace the bar no longer reads do not stay on it.
 */
export function forgetOthers(owner: string): void {
  try {
    const store = storage();
    const raw = store?.getItem(KEY);
    if (!store || !raw) return;
    const saved = JSON.parse(raw) as Partial<Saved>;
    if (!owner || saved.owner !== owner) {
      store.removeItem(KEY);
      lastSaved = "";
    }
  } catch {
    storage()?.removeItem(KEY);
  }
}

let lastSaved = "";

export function save(saved: Saved): void {
  try {
    const levels = saved.levels.map((l) => (l && l.entries.length > MAX_SAVED_ENTRIES
      ? { ...l, entries: l.entries.slice(0, MAX_SAVED_ENTRIES) }
      : l));
    const raw = JSON.stringify({ ...saved, levels });
    const store = storage();
    // Compared with what this run saved last, not read back: reading is file work too.
    if (store && raw !== lastSaved) {
      store.setItem(KEY, raw);
      lastSaved = raw;
    }
  } catch {
    // A full or missing store only costs the instant start.
  }
}
