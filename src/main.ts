/**
 * Tasks for Notion: browse Notion from the bar and tick tasks off.
 *
 * The bar talks to the Notion API itself with the token from the app's
 * settings. It starts on the top-level pages, or on the page set in the
 * settings. The wheel moves through a page's subpages, databases and to-dos;
 * OK or Start opens a page or a database, or ticks a task off or back on; Back
 * goes up a level, and on the top level leaves the app.
 *
 * A task whose title opens something, a database row (a page) or a to-do that
 * links a page, has two parts: OK points at them, the wheel moves between the
 * title and the mark, OK on the title opens it and on the mark acts on it. A
 * row with a status chooses it in place: the wheel goes through the options,
 * OK writes the one on show, Back keeps the old one.
 *
 * As in Notion, a ticked task stays where it is, with a burst of confetti. The
 * change goes to Notion a moment later; a second press in that time takes it
 * back without a request. The open view is read again every few seconds, so a
 * task closed in Notion closes on the bar too.
 */

import manifest from "./appmeta/manifest.json";
import { forgetOthers, type Level, load, save } from "./cache.ts";
import { type Config, configKey, readConfig, tokenTag, usable } from "./config.ts";
import { clearAll, deleteElements, drawElements, prepare } from "./display.ts";
import { focusable, settle, step } from "./focus.ts";
import { shownEntries } from "./markdown.ts";
import { NotionError, wireIdle } from "./notion.ts";
import { forgetRoots, Roots } from "./roots.ts";
import { type Element, type Focus, isTagRow, lineLeft, listFrame, loadingFrame, messageFrame as message, opens, previewFrame } from "./screen.ts";
import { MovedError, NoDoneFieldError, type View, readRecentRoots, readView, setDone } from "./source.ts";
import { type Database, type Entry, type Option, isTask, mergeRoots, optionOf } from "./tasks.ts";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

/** Settings saved while the app runs do not restart it, so they are read again this often. */
const TICK_MS = 3000;
/**
 * Reading the settings and saving the place cost the bar file work (measured in
 * `log trace`: about 200 ms for the settings), and a draw that meets them waits.
 * Neither is done until the wheel and the buttons have been still this long.
 */
const IDLE_MS = 5000;
/** How often the open page or database is read again: a change made in Notion shows this soon. */
const REFRESH_MS = 5000;
/** A read that took T is not repeated sooner than this many T later. */
const SLOW_READ_FACTOR = 3;
/**
 * For an internal connection the whole top level is read the old way, which
 * takes several requests, this seldom; in between, one search for what was
 * edited last brings new pages in this often. A personal token's top level is
 * kept by `roots.ts`, checked every REFRESH_MS while it is on screen.
 */
const ROOT_REFRESH_MS = 10 * 60 * 1000;
const ROOT_CHECK_MS = 15 * 1000;
/** While the top level is on screen, the trash and one kept root are checked every this many reads of it. */
const ROOT_DEEP_EVERY = 3;
/** A read waits until the wheel and buttons have been still this long: parsing an answer stalls the list. */
const QUIET_MS = 2000;
/** First retry after a failure, doubled on each further one up to MAX_RETRY_MS. */
const RETRY_MS = 15 * 1000;
const MAX_RETRY_MS = 5 * 60 * 1000;
/** For a page or database that is not shared with the token: it may be shared any moment. */
const NO_ACCESS_RETRY_MS = 60 * 1000;
/** A tick waits this long before it goes to Notion; OK again in that time takes it back. */
const UNDO_MS = 1500;
/** A tick that does not get through is sent again, up to this many tries in all, this much later each time. */
const TICK_TRIES = 3;
const TICK_RETRY_MS = 5000;
/**
 * Notion can list a task the old way for a few seconds after a change: a read
 * that starts this soon after a tick is confirmed keeps the bar's state. A later
 * read wins, so a change made in Notion right after shows on the bar.
 */
const SETTLED_GRACE_MS = 5000;
/**
 * A list Notion has not confirmed for this long gets a note saying so, once:
 * a single failed read (a DNS timeout, a busy Notion) is retried and passes
 * unseen. A mark for it was a coloured dot nobody could read (22.11).
 */
const STALE_NOTE_MS = 60 * 1000;
/** On opening a page its name is shown this long before its contents; a note stays longer. */
const BANNER_MS = 1200;
const NOTE_MS = 2500;
/**
 * The confetti bursts, made by tools/confetti.py: about 1.3 s at 30 fps each,
 * the last frame empty. A tick plays one of them, never the same twice in a row.
 */
const CONFETTI_PATHS = [
  "animations/confetti_burst.anim",
  "animations/confetti_fountain.anim",
  "animations/confetti_streamers.anim",
];
const CONFETTI_MS = 1500;
/** Views kept in memory for going back without waiting: each holds up to MAX_ENTRIES lines of the 384 KiB heap. */
const MAX_REMEMBERED = 4;

type Problem = readonly [string, string];

/**
 * A task changed from the bar. `waiting` sits out UNDO_MS, `sending` is on its
 * way, retries included, `settled` is confirmed and wins over reads that
 * start within SETTLED_GRACE_MS.
 */
interface Tick {
  stage: "waiting" | "sending" | "settled";
  readonly done: boolean;
  /** For a status or a select chosen by name: the option; null for a tick. */
  readonly option: string | null;
  readonly task: Entry;
  readonly database: Database | null;
  readonly token: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  tries: number;
  at: number;
  /** Pressed again while `sending`: the state to send once this one is through. */
  then: { done: boolean; option: string | null } | null;
}

function viewKey(view: View): string {
  return view.kind === "root" ? "root" : view.id;
}

function viewTitle(view: View): string {
  return view.kind === "page" || view.kind === "database" ? view.title : view.kind === "start" ? (view.title ?? "") : "";
}

/** A view's emoji icon, when the line it was opened from had one. */
function viewIcon(view: View): string {
  return view.kind === "root" ? "" : view.icon ?? "";
}

/** The mark a view's title has on the loading screen: the one its line had in the list. */
function viewMark(view: View): "page" | "database" | null {
  return view.kind === "database" ? "database" : view.kind === "page" || view.kind === "start" ? "page" : null;
}

function count(entries: readonly Entry[]): string {
  const tasks = entries.filter((e) => isTask(e) && !e.done).length;
  const places = entries.filter((e) => !isTask(e)).length;
  const parts: string[] = [];
  if (places > 0) parts.push(`${places} ${places === 1 ? "page" : "pages"}`);
  if (tasks > 0) parts.push(`${tasks} ${tasks === 1 ? "task" : "tasks"}`);
  return parts.join(", ") || "empty";
}

/**
 * What went wrong, in two short lines, and how soon to try again. `drop`: old
 * entries would hide the problem, so the screen says it instead.
 */
function explain(err: unknown, failures: number): { problem: Problem; retryMs: number; drop: boolean } {
  const backOff = Math.min(RETRY_MS * Math.pow(2, failures), MAX_RETRY_MS);
  if (err instanceof NoDoneFieldError) return { problem: ["Can't read", "this database"], retryMs: MAX_RETRY_MS, drop: true };
  if (err instanceof MovedError) return { problem: ["Page changed", "try again"], retryMs: 0, drop: false };
  if (err instanceof NotionError) {
    if (err.status === 401) return { problem: ["Bad token", "check the settings"], retryMs: MAX_RETRY_MS, drop: true };
    if (err.status === 403 || err.status === 404) {
      return { problem: ["No access", "share it with the token"], retryMs: NO_ACCESS_RETRY_MS, drop: true };
    }
    if (err.status === 429) return { problem: ["Notion busy", "waiting"], retryMs: Math.max(err.retryAfterMs, backOff), drop: false };
    if (err.status >= 500) return { problem: ["Notion down", "retrying"], retryMs: backOff, drop: false };
    return { problem: ["Notion error", err.code || err.message], retryMs: backOff, drop: false };
  }
  return { problem: ["Offline", "retrying"], retryMs: backOff, drop: false };
}

/** A tick worth sending again: the request did not get through, or Notion asked to wait. */
function worthRetry(err: unknown): boolean {
  return !(err instanceof NotionError) || err.status === 409 || err.status === 429 || err.status >= 500;
}

function main(): void {
  let config: Config | null = null;
  let key = "";
  let owner = "";
  let home = "";
  let stack: View[] = [{ kind: "root" }];
  let entries: Entry[] = [];
  let database: Database | null = null;
  let selected = 0;
  /** The entries are worth showing: read from Notion, or remembered. */
  let loaded = false;
  /** Only a page's first screen is in: what is on screen is not kept, the rest of the page being missing. */
  let partial = false;
  /**
   * Bumped by every `enter`: a read goes on while it matches. Not the view
   * object itself, which a read replaces when it learns a start view's kind.
   */
  let viewGen = 0;
  /** What a link's id turned out to be: opened again, it needs no probe. */
  const kinds = new Map<string, "page" | "database">();
  /**
   * Since when reads of the list on screen fail, 0 while they pass; whether its
   * note was shown in this run of failures; the timer that shows it.
   */
  let failingSince = 0;
  let staleNoted = false;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  /** The list is confirmed again, or another one is up: no note is due. */
  function confirmed(): void {
    failingSince = 0;
    staleNoted = false;
    if (staleTimer !== undefined) clearTimeout(staleTimer);
    staleTimer = undefined;
  }
  let problem: Problem | null = null;
  /** What the latest failed read was, for the note about a list left unconfirmed. */
  let lastProblem: Problem = ["Offline", "retrying"];
  let failures = 0;
  let nextReadAt = 0;
  let reading = false;
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  let lastInputAt = 0;
  /** When the top level was last read in full (an internal connection). */
  let rootReadAt = 0;
  /** A personal token's top level, kept across runs; null with a start page or no token. */
  let roots: Roots | null = null;
  /** Reads of the top level so far: every ROOT_DEEP_EVERY-th checks the trash and one kept root. */
  let rootReads = 0;
  let sweeping = false;
  /** When the sweep pass under way started, for the log line at its end. */
  let passStartedAt = 0;
  /** After a failed sweep answer: no new one before this. */
  let sweepAfter = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * A title shown on opening a page read before, with its mark, or a note:
   * over the list, for a moment. `detail` null: what the list holds.
   */
  let banner: { title: string; detail: string | null; mark: "page" | "database" | null; icon: string } | null = null;
  let bannerTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Where the view being read was opened from: the left of a line of one row,
   * which the loading screen keeps in place; null for a row with a status or
   * no line at all, which get the two-line skeleton.
   */
  let loadingAt: number | null = null;

  const remembered = new Map<string, Level>();
  /** Per view, the toggles opened on the bar; every toggle starts closed. */
  const openToggles = new Map<string, Set<string>>();
  const openHere = (): Set<string> => {
    const k = viewKey(current());
    let set = openToggles.get(k);
    if (!set) {
      set = new Set();
      openToggles.set(k, set);
    }
    return set;
  };
  /** The lines of the view that show: none inside a closed toggle. `selected` counts in these. Worked out again only when they change. */
  let shownFor: { entries: Entry[]; open: Set<string>; size: number; lines: Entry[]; any: boolean } | null = null;
  const shownState = () => {
    const open = openHere();
    if (!shownFor || shownFor.entries !== entries || shownFor.open !== open || shownFor.size !== open.size) {
      const lines = shownEntries(entries, open);
      shownFor = { entries, open, size: open.size, lines, any: lines.some(focusable) };
    }
    return shownFor;
  };
  const shown = (): Entry[] => shownState().lines;
  /** The id of the focused line, kept for coming back to it. */
  const focused = (): string => shown()[selected]?.id ?? "";
  const databases = new Map<string, Database>();
  const ticks = new Map<string, Tick>();

  /** What a task shows: the change on its way if there is one, else what Notion said. */
  const isDone = (e: Entry): boolean => {
    const t = ticks.get(e.id);
    if (!t || t.stage === "settled") return e.done === true;
    return t.then ? t.then.done : t.done;
  };

  /** The options of the open database's status or select, in the schema's order. */
  const options = (): readonly Option[] => {
    const field = database?.schema.done ?? null;
    return field && field.kind !== "checkbox" ? field.options : [];
  };

  /** The option a row shows: the one on its way, else what Notion said. */
  const tagOf = (e: Entry): { name: string; color: string } => {
    const t = ticks.get(e.id);
    const name = t && t.stage !== "settled" ? (t.then ? t.then.option : t.option) : null;
    if (name === null) return { name: e.tag ?? "", color: e.color ?? "default" };
    return { name, color: optionOf(database?.schema.done ?? null, name)?.color ?? "default" };
  };

  /**
   * The focused task pointed at, its title or its mark; or its status being
   * chosen, `index` the option on show. Both are for the line with `id`, and
   * end when the focus leaves it.
   */
  let pointing: { id: string; target: "title" | "mark" } | null = null;
  let picking: { id: string; index: number } | null = null;

  /** How the focused line is drawn. */
  const focusOf = (e: Entry | undefined): Focus => {
    if (!e || e.kind !== "row" || !isTagRow(e)) {
      return pointing && e && pointing.id === e.id ? { mode: pointing.target } : { mode: "list" };
    }
    if (picking && picking.id === e.id) {
      const o = options()[picking.index];
      return { mode: "pick", tag: o ? { name: o.name, color: o.color } : tagOf(e) };
    }
    const tag = tagOf(e);
    const shownTag = tag.name === (e.tag ?? "") ? null : tag;
    return pointing && pointing.id === e.id ? { mode: pointing.target, tag: shownTag } : { mode: "list", tag: shownTag };
  };

  /** Pointing and choosing end once the focused line is another. */
  function dropPointing(): void {
    pointing = null;
    picking = null;
  }

  const report = (where: string, err: unknown) =>
    console.error(`${APP}: ${where}: ${err instanceof Error ? err.message : String(err)}`);

  const current = () => stack[stack.length - 1];

  // ---- Display -------------------------------------------------------------

  /** What is on screen now, by element id: the very objects last sent, as `screen.ts` remembers them. */
  let onScreen: Record<string, Element> = {};
  /** The ids the last frame had, in view: only these can leave it. */
  let inView: string[] = [];
  /** What is on screen is not known (a draw failed): the next frame starts from a cleared screen. */
  let lost = false;
  let drawing = false;
  let dirty = false;
  /** The confetti playing now, if any: part of the frame until it has played. */
  let confetti: Element | null = null;
  /** Below the screen: where an element no longer shown waits, until its id is used again. */
  const OFF_SCREEN_Y = 64;

  /**
   * Sends what changed, in one request. An element is unchanged when it is the
   * same object as last time: `screen.ts` gives back the same object for the
   * same inputs, so nothing is serialised to compare. An element the last
   * frame had and this one does not is moved off screen in the same request,
   * rather than deleted in a second one. Its id keeps its type, so it can come back.
   *
   * If the draw fails, what is on screen is no longer known: the next frame
   * clears the app's elements and is sent whole.
   */
  async function show(elements: Element[]): Promise<void> {
    if (lost) {
      await clearAll(APP);
      onScreen = {};
      inView = [];
      lost = false;
    }
    const ids: Record<string, true> = {};
    const changed: Element[] = [];
    /**
     * An animation that leaves the frame is deleted, not moved: off screen a
     * looping one would go on costing the bar its frames, and an animation
     * sent again under an id the bar still has does not start over (the
     * spinner stood still on the second loading screen, 22.11).
     */
    const deleted: string[] = [];
    for (const element of elements) {
      ids[element.id] = true;
      if (onScreen[element.id] !== element) changed.push(element);
    }
    for (const id of inView) {
      if (ids[id]) continue;
      const gone = onScreen[id] as Element & { type: string };
      if (gone.type === "animation") deleted.push(id);
      else changed.push({ ...gone, y: OFF_SCREEN_Y } as Element);
    }
    try {
      if (changed.length > 0) await drawElements(APP, changed);
      for (const element of changed) onScreen[element.id] = element;
      if (deleted.length > 0) {
        for (const id of deleted) delete onScreen[id];
        await deleteElements(APP, deleted);
      }
      inView = elements.map((e) => e.id);
    } catch (err) {
      lost = true;
      throw err;
    }
  }

  function content(): Element[] {
    const logo = config?.logo === true;
    const messageFrame = (title: string, detail: string, kind: "page" | "database" | null = null, icon = "") => message(title, detail, logo, kind, icon);
    if (!config) return messageFrame("Loading", "settings");
    if (config.token === "") return messageFrame("Set token", "in settings");
    if (config.token === null) return messageFrame("Bad token", "check the settings");
    if (config.link.kind === "invalid") return messageFrame("Bad link", config.link.text);

    const view = current();
    const title = viewTitle(view) || "Notion";
    if (banner) {
      const detail = banner.detail ?? (loaded ? count(entries) : "loading");
      return banner.mark ? previewFrame(banner.title, detail, banner.mark, logo, banner.icon) : messageFrame(banner.title, detail);
    }
    if (!loaded) return problem ? messageFrame(problem[0], problem[1]) : loadingFrame(title, logo, loadingAt);
    if (entries.length === 0) {
      if (view.kind === "database") {
        return config.scope === "today" ? messageFrame("All done", "for today", "database") : messageFrame("All done", "no open tasks", "database");
      }
      // The first sweep is still under way: the top level fills in as it goes.
      if (view.kind === "root" && roots && roots.searching) return loadingFrame("Notion", logo);
      // An internal connection sees only pages shared with it: ••• > Connections in Notion.
      if (view.kind === "root") return messageFrame("No pages", "share pages with the connection");
      return messageFrame(title, "no tasks or pages", viewMark(view), viewIcon(view));
    }
    const state = shownState();
    if (!state.any) return messageFrame(title, "no tasks or pages", viewMark(view), viewIcon(view));
    // Ticks are looked up for the lines on screen only, not the whole list.
    const list = listFrame(state.lines, selected, (e: Entry) => isTask(e) && isDone(e), logo, openHere(), focusOf(state.lines[selected]));
    return list;
  }

  function frame(): Element[] {
    const elements = content();
    if (confetti) elements.push(confetti);
    return elements;
  }

  /** At most one draw in flight; changes made meanwhile are drawn once it is done. */
  function redraw(): void {
    if (stopped) return;
    if (drawing) {
      dirty = true;
      return;
    }
    let elements: Element[];
    try {
      elements = frame();
    } catch (err) {
      // A bad frame is reported, and the next change draws again rather than never.
      report("frame", err);
      return;
    }
    drawing = true;
    void show(elements)
      .catch((err: unknown) => report("draw", err))
      .then(() => {
        drawing = false;
        if (dirty) {
          dirty = false;
          redraw();
        } else if (readyTimer === undefined) {
          readyTimer = setTimeout(guarded("prepare", getReady), 0);
        }
      });
  }

  /**
   * Builds the frames one wheel step up and one down, and serialises their
   * elements, while nothing else is going on: the next step then finds its
   * lines made and costs only the request. Measured on the bar, a line seen
   * for the first time took 60-120 ms to build.
   */
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  function getReady(): void {
    readyTimer = undefined;
    // Not while a read is out: a long page is parsed meanwhile, and both at once ran the heap out.
    if (stopped || drawing || dirty || banner || reading || !loaded || !config) return;
    const state = shownState();
    if (!state.any) return;
    for (const delta of [1, -1]) {
      const next = step(state.lines, selected, delta);
      if (next === selected) continue;
      prepare(listFrame(state.lines, next, (e: Entry) => isTask(e) && isDone(e), config.logo === true, openHere()));
    }
  }

  function showBanner(title: string, detail: string | null, ms: number, mark: "page" | "database" | null = null, icon = ""): void {
    if (bannerTimer !== undefined) clearTimeout(bannerTimer);
    banner = { title, detail, mark, icon };
    bannerTimer = setTimeout(() => {
      bannerTimer = undefined;
      banner = null;
      redraw();
    }, ms);
    redraw();
  }

  function dropBanner(): void {
    if (bannerTimer !== undefined) clearTimeout(bannerTimer);
    bannerTimer = undefined;
    banner = null;
  }

  // ---- State ---------------------------------------------------------------

  function selectById(id: string | undefined): void {
    const lines = shown();
    // A line inside a closed toggle hands the focus to that toggle.
    const hidden = entries.find((e) => e.id === id);
    const target = hidden && lines.indexOf(hidden) < 0 ? ((hidden.toggles ?? []).find((t) => !openHere().has(t)) ?? id) : id;
    const at = target === undefined ? -1 : lines.findIndex((t) => t.id === target);
    selected = settle(lines, at >= 0 ? at : selected);
  }

  function keep(view: View, level: Level): void {
    const k = viewKey(view);
    remembered.delete(k);
    remembered.set(k, level);
    if (remembered.size > MAX_REMEMBERED) {
      const oldest = remembered.keys().next().value;
      if (oldest !== undefined) remembered.delete(oldest);
    }
  }

  /** The place changed since it was saved: saved once the user is idle, or on leaving. */
  let unsaved = false;
  const persist = (): void => {
    unsaved = true;
  };

  /** Saves the path and what every step of it shows, so going up after a restart needs no read. */
  function persistNow(): void {
    unsaved = false;
    if (!loaded) return;
    const levels = stack.map((v, i) => (i === stack.length - 1 ? { entries, database, focus: focused() } : remembered.get(viewKey(v)) ?? null));
    save({ owner, home, stack, levels });
  }

  /**
   * Keeps the view on screen for coming back, when its list is complete: an
   * empty one of a view still loading would come back as "All done".
   */
  function keepShown(): void {
    if (loaded && !partial) keep(current(), { entries, database, focus: focused() });
  }

  /** Puts a view on screen from memory when it is there; it is read again either way. */
  function enter(view: View): void {
    dropPointing();
    const level = remembered.get(viewKey(view));
    entries = level ? level.entries : [];
    database = level ? level.database : null;
    loaded = level !== undefined;
    partial = false;
    viewGen += 1;
    selected = 0;
    selectById(level?.focus);
    confirmed();
    problem = null;
    failures = 0;
    nextReadAt = 0;
    maybeRead();
  }

  /** New settings start from what was saved for that token and start page. */
  async function refreshConfig(): Promise<void> {
    let next: Config;
    try {
      next = await readConfig(APP);
    } catch (err) {
      report("settings", err);
      return;
    }
    const nextKey = configKey(next);
    if (nextKey === key) {
      // Only the look changed: the place and the list stay.
      if (config && config.logo !== next.logo) config = next;
      return;
    }
    const firstRead = config === null;
    // Ticks made under the old settings go out with the old token.
    flushPending();
    ticks.forEach((t, id) => {
      if (t.stage === "settled") ticks.delete(id);
    });
    key = nextKey;
    config = next;
    rootReadAt = 0;
    owner = next.token ? tokenTag(next.token) : "";
    remembered.clear();
    openToggles.clear();
    databases.clear();
    dropBanner();
    home = next.link.kind === "id" ? next.link.id : "";
    loadingAt = null;
    roots?.save();
    // What was saved under another token, or under none, leaves the bar.
    forgetOthers(owner);
    forgetRoots(owner);
    roots = next.token && !home ? new Roots(owner) : null;
    rootReads = 0;
    sweepAfter = 0;
    const saved = firstRead ? load(owner, home) : null;
    if (saved) {
      stack = saved.stack;
      saved.levels.forEach((level, i) => {
        if (level) keep(stack[i], level);
      });
    } else {
      stack = [home ? { kind: "start", id: home } : { kind: "root" }];
    }
    enter(current());
  }

  async function read(token: string, scope: Config["scope"]): Promise<void> {
    const readKey = key;
    const view = current();
    const gen = viewGen;
    const still = () => !stopped && readKey === key && gen === viewGen;
    const startedAt = Date.now();
    const quick = view.kind === "root" && loaded && startedAt - rootReadAt < ROOT_REFRESH_MS;
    const base = entries;
    try {
      // A read of a view the user has left stops at its next request, so the new view's read is not kept waiting.
      // A page read for the first time shows its first screen while the rest of it is read.
      const first = (list: Entry[], resolved: View) => {
        if (!still() || loaded) return;
        stack[stack.length - 1] = resolved;
        entries = list;
        loaded = true;
        partial = true;
        selected = settle(shown(), 0);
        redraw();
      };
      const kept = view.kind === "root" && roots !== null && (await roots.whoami(token, still)) === false ? roots : null;
      if (kept) {
        // The top level as kept: the last edited every read, the trash and one kept root every few.
        // While a sweep pass runs, which finds new ones itself, only the last edited, every few reads:
        // the wire is the sweep's (measured 22.11: the checks every 5 s stretched a 929-page pass to two minutes).
        rootReads += 1;
        const deep = rootReads % ROOT_DEEP_EVERY === 0;
        if (!kept.sweeping || deep) await kept.recent(token, still);
        if (deep && !kept.sweeping) {
          await kept.trash(token, still);
          await kept.check(token, still);
        }
      }
      const result = kept
        ? { view, database: null, entries: kept.entries() }
        : quick
          ? { view, database: null, entries: mergeRoots(base, await readRecentRoots(token, still)) }
          : await readView(token, view, scope, new Date(), databases, still, first);
      if (view.kind === "root" && !kept && !quick && readKey === key) rootReadAt = startedAt;
      const now = Date.now();
      const fresh = result.entries.map((e) => {
        const t = ticks.get(e.id);
        if (!t || t.stage !== "settled" || startedAt >= t.at + SETTLED_GRACE_MS) return e;
        if (t.option !== null && t.option !== e.tag) return withState(e, t);
        return t.done !== e.done ? { ...e, done: t.done } : e;
      });
      ticks.forEach((t, id) => {
        if (t.stage === "settled" && startedAt >= t.at + SETTLED_GRACE_MS) ticks.delete(id);
      });
      if (readKey !== key) return;
      if (!still()) {
        // The user moved on while this was read: keep it for when they come back.
        const before = remembered.get(viewKey(view));
        keep(result.view, { entries: fresh, database: result.database, focus: before ? before.focus : "" });
        return;
      }
      const keepId = shown()[selected]?.id;
      stack[stack.length - 1] = result.view;
      if (result.view.kind === "page" || result.view.kind === "database") kinds.set(result.view.id, result.view.kind);
      entries = fresh;
      database = result.database;
      selectById(keepId);
      if ((pointing || picking) && focused() !== (pointing ?? picking)?.id) dropPointing();
      loaded = true;
      partial = false;
      confirmed();
      problem = null;
      failures = 0;
      // A view that takes long to read is read again less often, so reading does not take the bar over.
      // The kept top level is checked as often as any view; for it a slow read is the checks' own pace, not a reason to wait longer.
      nextReadAt = kept ? now + REFRESH_MS : now + Math.max(view.kind === "root" ? ROOT_CHECK_MS : REFRESH_MS, (now - startedAt) * SLOW_READ_FACTOR);
      keep(result.view, { entries, database, focus: focused() });
      persist();
    } catch (err) {
      if (!still()) return;
      if (failures === 0) report("read", err);
      const { problem: p, retryMs, drop } = explain(err, failures);
      failures += 1;
      nextReadAt = Date.now() + retryMs;
      if (drop) loaded = false;
      // Without a list the screen says why at once. With one, the list stays, and if reads go on failing
      // for STALE_NOTE_MS a note says so once, in the words of the latest failure.
      if (!loaded) {
        problem = p;
      } else if (failingSince === 0) {
        failingSince = Date.now();
        staleTimer = setTimeout(guarded("stale", () => {
          staleTimer = undefined;
          if (failingSince === 0 || staleNoted || stopped) return;
          staleNoted = true;
          showBanner(lastProblem[0], "list may be old", NOTE_MS);
        }), STALE_NOTE_MS);
      }
      lastProblem = p;
    }
  }

  /**
   * Starts a read when one is due and none is running. While the user turns
   * the wheel it waits; a timer comes back for it.
   */
  function maybeRead(): void {
    const c = config;
    if (stopped || reading || !usable(c)) return;
    const now = Date.now();
    const at = loaded ? Math.max(nextReadAt, lastInputAt + QUIET_MS) : nextReadAt;
    if (now < at) {
      if (readTimer !== undefined) clearTimeout(readTimer);
      readTimer = setTimeout(guarded("read", () => {
        readTimer = undefined;
        maybeRead();
      }), at - now);
      return;
    }
    reading = true;
    void read(c.token, c.scope)
      .catch((err: unknown) => report("read", err))
      .then(() => {
        reading = false;
        redraw();
        maybeRead();
        maybeSweep();
      });
  }

  /**
   * One sweep answer, when nothing else wants the wire: the user has been still
   * QUIET_MS, no read is out or waiting. A sweep answer holds the wire about 2 s
   * and cannot be stopped, so it never starts while the user is busy. Then the
   * next one, the same way, until the pass is over.
   */
  function maybeSweep(): void {
    const c = config;
    const r = roots;
    const now = Date.now();
    if (stopped || sweeping || !r || !usable(c) || reading || now < sweepAfter || !r.sweepDue(now)) return;
    if (now - lastInputAt < QUIET_MS || !wireIdle()) return;
    sweeping = true;
    const sweepKey = key;
    // A pass from its first answer in this run: one resumed after a restart counts from here.
    if (passStartedAt === 0) passStartedAt = now;
    void r.sweep(c.token, now)
      .then((changed) => {
        sweepAfter = 0;
        // One line a pass, about a day apart: how long the workspace took, for comparing bars and workspaces.
        if (!r.sweeping && passStartedAt > 0) {
          console.error(`${APP}: sweep pass done in ${Math.round((Date.now() - passStartedAt) / 1000)} s, ${r.entries().length} top-level`);
          passStartedAt = 0;
        }
        if (!changed || sweepKey !== key || roots !== r || current().kind !== "root") return;
        const keepId = shown()[selected]?.id;
        entries = r.entries();
        loaded = true;
        selectById(keepId);
        keep(current(), { entries, database: null, focus: focused() });
        redraw();
      }, (err: unknown) => {
        report("sweep", err);
        sweepAfter = Date.now() + RETRY_MS;
      })
      .then(() => {
        sweeping = false;
        if (!stopped) setTimeout(guarded("sweep", maybeSweep), 0);
      });
  }

  // ---- Ticking tasks ------------------------------------------------------

  function newTick(task: Entry, db: Database | null, token: string, done: boolean, option: string | null = null): Tick {
    return { stage: "waiting", done, option, task, database: db, token, timer: undefined, tries: 0, at: Date.now(), then: null };
  }

  /** A task with the state a tick gave it: done, and for a status its option and colour. */
  function withState(e: Entry, t: Tick): Entry {
    if (t.option === null) return { ...e, done: t.done };
    const color = optionOf(t.database?.schema.done ?? null, t.option)?.color ?? "default";
    return { ...e, done: t.done, tag: t.option, color };
  }

  /** Sets a task's state in a list, if the list has it. */
  function withDone(list: Entry[], id: string, t: Tick): Entry[] | null {
    if (!list.some((e) => e.id === id)) return null;
    return list.map((e) => (e.id === id ? withState(e, t) : e));
  }

  /** The tick is final now: send it. The task stays where it is either way. */
  function send(id: string): void {
    const t = ticks.get(id);
    if (!t || t.stage !== "waiting") return;
    if (t.timer !== undefined) clearTimeout(t.timer);
    t.stage = "sending";
    attempt(id, t);
  }

  function attempt(id: string, t: Tick): void {
    t.timer = undefined;
    setDone(t.token, t.task, t.database, t.done, t.option)
      .then(() => {
        if (ticks.get(id) !== t) return;
        t.stage = "settled";
        t.at = Date.now();
        const next = withDone(entries, id, t);
        if (next) {
          entries = next;
          keep(current(), { entries, database, focus: focused() });
          persist();
        }
        remembered.forEach((level, k) => {
          const list = withDone(level.entries, id, t);
          if (list) remembered.set(k, { ...level, entries: list });
        });
        // Pressed again meanwhile: that goes out now, without the wait.
        if (t.then !== null && (t.then.done !== t.done || t.then.option !== t.option) && !stopped) {
          const again = newTick(t.task, t.database, t.token, t.then.done, t.then.option);
          ticks.set(id, again);
          send(id);
        }
      })
      .catch((err: unknown) => {
        if (ticks.get(id) !== t) return;
        t.tries += 1;
        if (!stopped && worthRetry(err) && t.tries < TICK_TRIES) {
          t.timer = setTimeout(guarded("tick", () => attempt(id, t)), TICK_RETRY_MS * t.tries);
          return;
        }
        report("tick", err);
        // The task shows what Notion has again, and the screen says why.
        ticks.delete(id);
        // The page changed under the tick: read it now, so the next try finds the task.
        if (err instanceof MovedError) nextReadAt = 0;
        if (!stopped) showBanner("Not saved", explain(err, 0).problem[0], NOTE_MS);
      })
      .then(() => redraw());
  }

  /** Leaving a view, or the app, sends what was ticked in it: it was meant. */
  function flushPending(): void {
    const ids: string[] = [];
    ticks.forEach((t, id) => {
      if (t.stage === "waiting") ids.push(id);
    });
    for (const id of ids) send(id);
  }

  // ---- Confetti ------------------------------------------------------------

  let confettiTimer: ReturnType<typeof setTimeout> | undefined;
  let confettiRun = 0;
  let lastConfetti = -1;

  /** Any style but the one played last. */
  function nextConfetti(): string {
    let i = Math.floor(Math.random() * (CONFETTI_PATHS.length - 1));
    if (i >= lastConfetti && lastConfetti >= 0) i += 1;
    lastConfetti = i;
    return CONFETTI_PATHS[i];
  }

  /**
   * Plays the confetti over the list. The burst is a pre-rendered transparent
   * animation that the bar plays by itself at a steady 30 fps. It goes out with
   * the frame; each tick takes the other of two ids, which restarts the burst,
   * and once it has played it leaves the frame.
   */
  function celebrate(): void {
    confettiRun += 1;
    if (confettiTimer !== undefined) clearTimeout(confettiTimer);
    confetti = {
      id: `confetti${confettiRun % 2}`,
      type: "animation",
      display: "front",
      align: "top_left",
      x: 0,
      y: 0,
      path: nextConfetti(),
      loop: false,
      z_index: 6,
    } as Element;
    confettiTimer = setTimeout(() => {
      confettiTimer = undefined;
      confetti = null;
      redraw();
    }, CONFETTI_MS);
  }

  // ---- Input ---------------------------------------------------------------

  /** A to-do's link as a view: of the kind it turned out to be, or to be found out. */
  function linked(id: string, title: string): View {
    const kind = kinds.get(id);
    return kind ? { kind, id, title } : { kind: "start", id, title };
  }

  /** Opens a view from the list: a subpage, a database, a row's page or a to-do's link. */
  function go(view: View, title: string, from: Entry): void {
    loadingAt = isTagRow(from) ? null : lineLeft(from, config?.logo === true);
    flushPending();
    keepShown();
    stack.push(view);
    enter(current());
    // Remembered: its name for a moment, then the list. Not yet: the loading screen, which has its name.
    if (loaded) showBanner(title, null, BANNER_MS, viewMark(view), viewIcon(view));
    else redraw();
  }

  /** Ticks a task off or back on: after UNDO_MS, and a second press in that time takes it back. */
  function toggleDone(entry: Entry, token: string): void {
    const t = ticks.get(entry.id);
    const done = !isDone(entry);
    if (t && t.stage === "sending") {
      // Sent already: the press is kept and goes out once the request is through.
      t.then = { done, option: null };
    } else if (t && t.stage === "waiting") {
      if (t.timer !== undefined) clearTimeout(t.timer);
      ticks.delete(entry.id);
    } else {
      const id = entry.id;
      const next = newTick(entry, database, token, done);
      next.timer = setTimeout(guarded("tick", () => send(id)), UNDO_MS);
      ticks.set(id, next);
    }
    if (done && !(t && t.stage === "waiting")) celebrate();
  }

  /** Writes the status on show: chosen on purpose, so it goes at once, without the wait for a second press. */
  function choose(entry: Entry, token: string, option: Option): void {
    if (option.name === tagOf(entry).name) return;
    const done = option.group === "done";
    const t = ticks.get(entry.id);
    if (done && !isDone(entry)) celebrate();
    if (t && t.stage === "sending") {
      t.then = { done, option: option.name };
      return;
    }
    if (t && t.timer !== undefined) clearTimeout(t.timer);
    ticks.set(entry.id, newTick(entry, database, token, done, option.name));
    send(entry.id);
  }

  function activate(): void {
    // A press while a title or a note is up only takes it away.
    if (banner) {
      dropBanner();
      redraw();
      return;
    }
    const token = config?.token;
    if (!loaded || !token) return;
    const entry = shown()[selected];
    if (!entry || !focusable(entry)) return;
    if (picking && picking.id === entry.id) {
      const option = options()[picking.index];
      dropPointing();
      if (option) choose(entry, token, option);
      redraw();
      return;
    }
    if (pointing && pointing.id === entry.id) {
      const target = pointing.target;
      if (target === "title") {
        dropPointing();
        if (entry.kind === "row") go({ kind: "page", id: entry.id, title: entry.title, icon: entry.icon }, entry.title, entry);
        else if (entry.link) go(linked(entry.link, entry.title), entry.title, entry);
        return;
      }
      if (isTagRow(entry)) {
        // The status is chosen in place, starting from the one it has.
        const at = options().findIndex((o) => o.name === tagOf(entry).name);
        picking = { id: entry.id, index: Math.max(0, at) };
      } else {
        dropPointing();
        toggleDone(entry, token);
      }
      redraw();
      return;
    }
    if (entry.kind === "toggle") {
      // Opens or closes in place: what is inside shows under it, one level deeper.
      const open = openHere();
      if (open.has(entry.id)) open.delete(entry.id);
      else open.add(entry.id);
      redraw();
      return;
    }
    if (entry.kind === "page" || entry.kind === "database") {
      go({ kind: entry.kind, id: entry.id, title: entry.title, icon: entry.icon }, entry.title, entry);
      return;
    }
    if (opens(entry)) {
      // Two parts: point at them first. A row with a status starts on its title, a to-do on its checkbox.
      pointing = { id: entry.id, target: isTagRow(entry) ? "title" : "mark" };
      redraw();
      return;
    }
    toggleDone(entry, token);
    redraw();
  }

  function up(): void {
    // Back steps out of choosing, then out of pointing, then up a level.
    if (picking) {
      picking = null;
      redraw();
      return;
    }
    if (pointing) {
      pointing = null;
      redraw();
      return;
    }
    if (stack.length <= 1) {
      quit();
      return;
    }
    flushPending();
    dropBanner();
    loadingAt = null;
    keepShown();
    stack.pop();
    enter(current());
    redraw();
  }

  function move(delta: number): void {
    if (!loaded || entries.length === 0) return;
    if (banner) dropBanner();
    if (picking) {
      // The wheel goes round the options.
      const n = options().length;
      if (n > 0) picking = { id: picking.id, index: (((picking.index + delta) % n) + n) % n };
      redraw();
      return;
    }
    if (pointing) {
      // The wheel moves between the two parts: title above the tag, checkbox left of the title.
      const entry = shown()[selected];
      const order: ("title" | "mark")[] = entry && isTagRow(entry) ? ["title", "mark"] : ["mark", "title"];
      const at = order.indexOf(pointing.target) + (delta > 0 ? 1 : -1);
      pointing = { id: pointing.id, target: order[Math.max(0, Math.min(1, at))] };
      redraw();
      return;
    }
    // Headings are passed over.
    selected = step(shown(), selected, delta);
    redraw();
  }

  function quit(): void {
    if (stopped) return;
    flushPending();
    persistNow();
    roots?.save();
    stopped = true;
    for (const t of [timer, readTimer, confettiTimer, readyTimer, staleTimer]) if (t !== undefined) clearTimeout(t);
    // Retries still waiting are given up; a request already out settles by itself.
    ticks.forEach((t) => {
      if (t.stage === "sending" && t.timer !== undefined) clearTimeout(t.timer);
    });
    dropBanner();
    // Not from inside the handler's own callback: with nothing else left, the
    // unbind would stop the app while this callback is still running.
    setTimeout(unbind, 0);
  }

  /** Runs a handler so that an error in it is reported and the app goes on: an uncaught one ends the app. */
  const guarded = (where: string, work: () => void) => () => {
    try {
      work();
    } catch (err) {
      report(where, err);
    }
  };

  const unbind = listen("input", (event) => guarded("input", () => {
    lastInputAt = Date.now();
    if (event.key === "encoder") move(event.delta);
    // Start, the big button on top, does what OK does: it is the easier one to reach.
    else if ((event.key === "ok" || event.key === "start") && event.action === "short") activate();
    else if (event.key === "back" && event.action === "short") up();
  })());

  // ---- Loop ----------------------------------------------------------------

  async function tick(): Promise<void> {
    const idle = Date.now() - lastInputAt >= IDLE_MS;
    if (idle || config === null) await refreshConfig();
    if (idle && unsaved) persistNow();
    if (idle) roots?.save();
    maybeRead();
    maybeSweep();
    redraw();
  }

  /** Self-rescheduling timeout rather than an interval, so ticks never stack up. */
  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick()
        .catch((err: unknown) => report("tick", err))
        .then(schedule);
    }, TICK_MS);
  }

  void tick()
    .catch((err: unknown) => report("tick", err))
    .then(schedule);
}

main();
