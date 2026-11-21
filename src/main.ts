/**
 * Tasks for Notion: browse Notion from the bar and tick tasks off.
 *
 * The bar talks to the Notion API itself with the token from the app's
 * settings. It starts on the top-level pages, or on the page set in the
 * settings. The wheel moves through a page's subpages, databases and to-dos;
 * OK or Start opens a page or a database, or ticks a task off or back on; Back
 * goes up a level, and on the top level leaves the app.
 *
 * As in Notion, a ticked task stays where it is, with a burst of confetti. The
 * change goes to Notion a moment later; a second press in that time takes it
 * back without a request. The open view is read again every few seconds, so a
 * task closed in Notion closes on the bar too.
 */

import manifest from "./appmeta/manifest.json";
import { type Level, load, save } from "./cache.ts";
import { type Config, configKey, readConfig, tokenTag, usable } from "./config.ts";
import { clearElements, drawElements } from "./display.ts";
import { NotionError } from "./notion.ts";
import { type Element, listFrame, messageFrame, staleMark } from "./screen.ts";
import { NoDoneFieldError, type View, readView, setDone } from "./source.ts";
import { type Database, type Entry, isTask } from "./tasks.ts";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

/** Settings saved while the app runs do not restart it, so they are read again this often. */
const TICK_MS = 3000;
/** How often the open page or database is read again: a change made in Notion shows this soon. */
const REFRESH_MS = 5000;
/** The top-level pages take several requests to find, and rarely change. */
const ROOT_REFRESH_MS = 10 * 60 * 1000;
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
/** Views kept in memory for going back without waiting. */
const MAX_REMEMBERED = 12;

type Problem = readonly [string, string];

/**
 * A task changed from the bar. `waiting` sits out UNDO_MS, `sending` is on its
 * way, retries included, `settled` is confirmed and wins over reads that
 * start within SETTLED_GRACE_MS.
 */
interface Tick {
  stage: "waiting" | "sending" | "settled";
  readonly done: boolean;
  readonly task: Entry;
  readonly database: Database | null;
  readonly token: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  tries: number;
  at: number;
}

function viewKey(view: View): string {
  return view.kind === "root" ? "root" : view.id;
}

function viewTitle(view: View): string {
  return view.kind === "page" || view.kind === "database" ? view.title : "";
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
  if (err instanceof NoDoneFieldError) return { problem: ["No checkbox", "or status in this database"], retryMs: MAX_RETRY_MS, drop: true };
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
  /** The entries on screen were not confirmed by the latest read. */
  let stale = false;
  let problem: Problem | null = null;
  let failures = 0;
  let nextReadAt = 0;
  let reading = false;
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  let lastInputAt = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** A title shown on opening a page, or a note: over the list, for a moment. */
  let banner: { title: string; detail: string | null } | null = null;
  let bannerTimer: ReturnType<typeof setTimeout> | undefined;

  const remembered = new Map<string, Level>();
  const databases = new Map<string, Database>();
  const ticks = new Map<string, Tick>();

  /** What a task shows: the change on its way if there is one, else what Notion said. */
  const isDone = (e: Entry): boolean => {
    const t = ticks.get(e.id);
    return t && t.stage !== "settled" ? t.done : e.done === true;
  };

  const report = (where: string, err: unknown) =>
    console.error(`${APP}: ${where}: ${err instanceof Error ? err.message : String(err)}`);

  const current = () => stack[stack.length - 1];

  // ---- Display -------------------------------------------------------------

  /** What is on screen now, by element id, as last sent. */
  let onScreen: Record<string, string> = {};
  let drawing = false;
  let dirty = false;
  /** The confetti playing now, if any: part of the frame until it has played. */
  let confetti: Element | null = null;

  /**
   * Sends only what changed. The new elements go first and the old ones are
   * cleared after: clearing first can leave the app with nothing on screen for
   * a moment, and the bar then flashes its own "Loading" placeholder.
   *
   * If either call fails, what is on screen is no longer known, so the next
   * frame is sent whole.
   */
  async function show(elements: Element[]): Promise<void> {
    const next: Record<string, string> = {};
    const changed = [];
    for (const element of elements) {
      const sent = JSON.stringify(element);
      next[element.id] = sent;
      if (onScreen[element.id] !== sent) changed.push(element);
    }
    const gone = Object.keys(onScreen).filter((id) => !(id in next));
    try {
      if (changed.length > 0) await drawElements(APP, changed);
      if (gone.length > 0) await clearElements(APP, gone);
      onScreen = next;
    } catch (err) {
      onScreen = {};
      throw err;
    }
  }

  function content(): Element[] {
    if (!config) return messageFrame("Loading", "settings");
    if (config.token === "") return messageFrame("Set token", "in settings");
    if (config.token === null) return messageFrame("Bad token", "check the settings");
    if (config.link.kind === "invalid") return messageFrame("Bad link", config.link.text);

    const view = current();
    const title = viewTitle(view) || "Notion";
    if (banner) return messageFrame(banner.title, banner.detail ?? (loaded ? count(entries) : "loading"));
    if (!loaded) return problem ? messageFrame(problem[0], problem[1]) : messageFrame(title, "loading");
    if (entries.length === 0) {
      if (view.kind === "database") {
        return config.scope === "today" ? messageFrame("All done", "for today") : messageFrame("All done", "no open tasks");
      }
      // An internal connection sees only pages shared with it: ••• > Connections in Notion.
      if (view.kind === "root") return messageFrame("No pages", "share pages with the connection");
      return messageFrame(title, "no tasks or pages");
    }
    const done = new Set<string>();
    for (const e of entries) if (isTask(e) && isDone(e)) done.add(e.id);
    const list = listFrame(entries, selected, done);
    if (stale) list.push(staleMark());
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
        }
      });
  }

  function showBanner(title: string, detail: string | null, ms: number): void {
    if (bannerTimer !== undefined) clearTimeout(bannerTimer);
    banner = { title, detail };
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
    const at = id === undefined ? -1 : entries.findIndex((t) => t.id === id);
    selected = at >= 0 ? at : Math.max(0, Math.min(selected, entries.length - 1));
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

  /** Saves the path and what every step of it shows, so going up after a restart needs no read. */
  function persist(): void {
    if (!loaded) return;
    const levels = stack.map((v, i) => (i === stack.length - 1 ? { entries, database, selected } : remembered.get(viewKey(v)) ?? null));
    save({ owner, home, stack, levels });
  }

  /** Puts a view on screen from memory when it is there; it is read again either way. */
  function enter(view: View): void {
    const level = remembered.get(viewKey(view));
    entries = level ? level.entries : [];
    database = level ? level.database : null;
    selected = level ? level.selected : 0;
    loaded = level !== undefined;
    stale = false;
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
    if (nextKey === key) return;
    const firstRead = config === null;
    // Ticks made under the old settings go out with the old token.
    flushPending();
    ticks.forEach((t, id) => {
      if (t.stage === "settled") ticks.delete(id);
    });
    key = nextKey;
    config = next;
    owner = next.token ? tokenTag(next.token) : "";
    remembered.clear();
    databases.clear();
    dropBanner();
    home = next.link.kind === "id" ? next.link.id : "";
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
    const depth = stack.length;
    const still = () => !stopped && readKey === key && stack.length === depth && current() === view;
    const startedAt = Date.now();
    try {
      // A read of a view the user has left stops at its next request, so the new view's read is not kept waiting.
      const result = await readView(token, view, scope, new Date(), databases, still);
      const now = Date.now();
      const fresh = result.entries.map((e) => {
        const t = ticks.get(e.id);
        return t && t.stage === "settled" && startedAt < t.at + SETTLED_GRACE_MS && t.done !== e.done ? { ...e, done: t.done } : e;
      });
      ticks.forEach((t, id) => {
        if (t.stage === "settled" && startedAt >= t.at + SETTLED_GRACE_MS) ticks.delete(id);
      });
      if (readKey !== key) return;
      if (!still()) {
        // The user moved on while this was read: keep it for when they come back.
        const before = remembered.get(viewKey(view));
        keep(result.view, { entries: fresh, database: result.database, selected: before ? before.selected : 0 });
        return;
      }
      const keepId = entries[selected]?.id;
      stack[stack.length - 1] = result.view;
      entries = fresh;
      database = result.database;
      selectById(keepId);
      loaded = true;
      stale = false;
      problem = null;
      failures = 0;
      nextReadAt = now + (view.kind === "root" ? ROOT_REFRESH_MS : REFRESH_MS);
      keep(result.view, { entries, database, selected });
      persist();
    } catch (err) {
      if (!still()) return;
      if (failures === 0) report("read", err);
      const { problem: p, retryMs, drop } = explain(err, failures);
      failures += 1;
      nextReadAt = Date.now() + retryMs;
      if (drop) loaded = false;
      // With a list up, it stays and gets the stale mark; without one, the screen says why.
      if (loaded) stale = true;
      else problem = p;
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
      readTimer = setTimeout(() => {
        readTimer = undefined;
        maybeRead();
      }, at - now);
      return;
    }
    reading = true;
    void read(c.token, c.scope)
      .catch((err: unknown) => report("read", err))
      .then(() => {
        reading = false;
        redraw();
        maybeRead();
      });
  }

  // ---- Ticking tasks ------------------------------------------------------

  /** Sets a task's state in a list, if the list has it. */
  function withDone(list: Entry[], id: string, done: boolean): Entry[] | null {
    if (!list.some((t) => t.id === id)) return null;
    return list.map((t) => (t.id === id ? { ...t, done } : t));
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
    setDone(t.token, t.task, t.database, t.done)
      .then(() => {
        if (ticks.get(id) !== t) return;
        t.stage = "settled";
        t.at = Date.now();
        const next = withDone(entries, id, t.done);
        if (next) {
          entries = next;
          keep(current(), { entries, database, selected });
          persist();
        }
        remembered.forEach((level, k) => {
          const list = withDone(level.entries, id, t.done);
          if (list) remembered.set(k, { ...level, entries: list });
        });
      })
      .catch((err: unknown) => {
        if (ticks.get(id) !== t) return;
        t.tries += 1;
        if (!stopped && worthRetry(err) && t.tries < TICK_TRIES) {
          t.timer = setTimeout(() => attempt(id, t), TICK_RETRY_MS * t.tries);
          return;
        }
        report("tick", err);
        // The task shows what Notion has again, and the screen says why.
        ticks.delete(id);
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

  function activate(): void {
    // A press while a title or a note is up only takes it away.
    if (banner) {
      dropBanner();
      redraw();
      return;
    }
    const token = config?.token;
    if (!loaded || !token) return;
    const entry = entries[selected];
    if (!entry) return;
    if (entry.kind === "page" || entry.kind === "database") {
      flushPending();
      keep(current(), { entries, database, selected });
      stack.push({ kind: entry.kind, id: entry.id, title: entry.title });
      enter(current());
      showBanner(entry.title, null, BANNER_MS);
      return;
    }
    const t = ticks.get(entry.id);
    if (t && t.stage === "sending") return;
    if (t && t.stage === "waiting") {
      if (t.timer !== undefined) clearTimeout(t.timer);
      ticks.delete(entry.id);
    } else {
      const id = entry.id;
      const done = !isDone(entry);
      ticks.set(id, {
        stage: "waiting",
        done,
        task: entry,
        database,
        token,
        timer: setTimeout(() => send(id), UNDO_MS),
        tries: 0,
        at: Date.now(),
      });
      if (done) celebrate();
    }
    redraw();
  }

  function up(): void {
    if (stack.length <= 1) {
      quit();
      return;
    }
    flushPending();
    dropBanner();
    keep(current(), { entries, database, selected });
    stack.pop();
    enter(current());
    redraw();
  }

  function move(delta: number): void {
    if (!loaded || entries.length === 0) return;
    if (banner) dropBanner();
    selected = Math.max(0, Math.min(entries.length - 1, selected + delta));
    redraw();
  }

  function quit(): void {
    if (stopped) return;
    flushPending();
    persist();
    stopped = true;
    for (const t of [timer, readTimer, confettiTimer]) if (t !== undefined) clearTimeout(t);
    // Retries still waiting are given up; a request already out settles by itself.
    ticks.forEach((t) => {
      if (t.stage === "sending" && t.timer !== undefined) clearTimeout(t.timer);
    });
    dropBanner();
    // Not from inside the handler's own callback: with nothing else left, the
    // unbind would stop the app while this callback is still running.
    setTimeout(unbind, 0);
  }

  const unbind = listen("input", (event) => {
    lastInputAt = Date.now();
    if (event.key === "encoder") move(event.delta);
    // Start, the big button on top, does what OK does: it is the easier one to reach.
    else if ((event.key === "ok" || event.key === "start") && event.action === "short") activate();
    else if (event.key === "back" && event.action === "short") up();
  });

  // ---- Loop ----------------------------------------------------------------

  async function tick(): Promise<void> {
    await refreshConfig();
    maybeRead();
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
