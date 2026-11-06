/**
 * Keeps where the user was in `localStorage`: the path from the start view,
 * and what each step of it showed. The app opens there at once, and going up
 * after a restart shows the level above without waiting for Notion.
 *
 * Every `setItem` rewrites the app's store to flash, so state is saved only
 * when it changed. The token is never stored here; it stays in the settings.
 */

import type { View } from "./source.ts";
import type { Database, Entry } from "./tasks.ts";

const KEY = "place";

/** What one view showed. */
export interface Level {
  readonly entries: Entry[];
  readonly database: Database | null;
  readonly selected: number;
}

export interface Saved {
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

export function load(home: string): Saved | null {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Saved;
    const ok = saved.home === home && Array.isArray(saved.stack) && saved.stack.length > 0 &&
      Array.isArray(saved.levels) && saved.levels.length === saved.stack.length;
    return ok ? saved : null;
  } catch {
    return null;
  }
}

export function save(saved: Saved): void {
  try {
    const levels = saved.levels.map((l) => (l && l.entries.length > MAX_SAVED_ENTRIES
      ? { ...l, entries: l.entries.slice(0, MAX_SAVED_ENTRIES), selected: Math.min(l.selected, MAX_SAVED_ENTRIES - 1) }
      : l));
    const raw = JSON.stringify({ ...saved, levels });
    const store = storage();
    if (store && store.getItem(KEY) !== raw) store.setItem(KEY, raw);
  } catch {
    // A full or missing store only costs the instant start.
  }
}
