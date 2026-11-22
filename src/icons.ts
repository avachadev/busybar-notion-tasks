/**
 * Emoji of a page's subpages and databases. A page's markdown names them by
 * url and title only, so each one's icon is a request of its own
 * (`GET /pages/{id}` or `/databases/{id}`, 1.3-1.7 s on the bar). They are
 * asked one at a time while the user and the wire are idle, from the focused
 * line down, and kept: a page read again shows its icons at once.
 */

import { type Entry, withIcon } from "./tasks.ts";

/** An icon found is asked again this long after, in case it was changed in Notion. */
export const ICON_MS = 30 * 60 * 1000;
/** Ids kept, least recently used dropped first. */
const MAX_KEPT = 300;

interface Known {
  readonly icon: string;
  readonly at: number;
}

export class Icons {
  private readonly known = new Map<string, Known>();

  /** Entries that can have an icon this way: subpages and databases. */
  static wants(e: Entry): boolean {
    return e.kind === "page" || e.kind === "database";
  }

  /**
   * The entries with the icons known for them; one not known yet keeps the
   * icon `before` had for it, as when the place was saved before a restart.
   */
  apply(entries: Entry[], before: readonly Entry[] = []): Entry[] {
    let out: Entry[] | null = null;
    for (let i = 0; i < entries.length; i += 1) {
      const e = entries[i];
      if (!Icons.wants(e) || e.icon) continue;
      const k = this.known.get(e.id);
      const icon = k ? k.icon : before.find((b) => b.id === e.id)?.icon ?? "";
      if (!icon) continue;
      if (!out) out = entries.slice();
      out[i] = withIcon(e, icon);
    }
    return out ?? entries;
  }

  /** The next entry to ask about: from `from` down, then above it. Null when all are known and fresh. */
  next(entries: readonly Entry[], from: number, now: number): Entry | null {
    const n = entries.length;
    for (let j = 0; j < n; j += 1) {
      const e = entries[(Math.max(0, from) + j) % n];
      if (!Icons.wants(e)) continue;
      const k = this.known.get(e.id);
      if (!k || now - k.at >= ICON_MS) return e;
    }
    return null;
  }

  /** What Notion said: the emoji, or "" for none or a picture the bar cannot draw. */
  got(id: string, icon: string, now: number): void {
    this.known.delete(id);
    this.known.set(id, { icon, at: now });
    if (this.known.size > MAX_KEPT) {
      const oldest = this.known.keys().next().value;
      if (oldest !== undefined) this.known.delete(oldest);
    }
  }

  /** Forgets everything: another token sees other pages. */
  clear(): void {
    this.known.clear();
  }
}
