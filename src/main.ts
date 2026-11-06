/**
 * Tasks for Notion — browse Notion from the bar and tick tasks off.
 *
 * The bar talks to the Notion API itself with the token from the app's
 * settings. It starts on the top-level pages, or on the page set in the
 * settings. The wheel moves through a page's subpages, databases and to-dos;
 * OK or Start opens a page or a database, or ticks a task off or back on; Back goes up
 * a level, and a long Back leaves the app.
 *
 * As in Notion, a ticked task stays where it is, with a burst of confetti. The
 * change goes to Notion a moment later; a second press in that time takes it
 * back without a request.
 */

import manifest from "./appmeta/manifest.json";
import { type Level, load, save } from "./cache.ts";
import { type Config, configKey, readConfig } from "./config.ts";
import { clearElements, drawElements } from "./display.ts";
import { NotionError } from "./notion.ts";
import { type Element, listFrame, messageFrame } from "./screen.ts";
import { NoDoneFieldError, type View, readView, setDone } from "./source.ts";
import { type Database, type Entry, isTask } from "./tasks.ts";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

/** Settings saved while the app runs do not restart it, so they are read again this often. */
const TICK_MS = 3000;
/** How often the open view is read again. Each read is one request of about ten seconds. */
const REFRESH_MS = 60 * 1000;
/** The top-level pages take several requests to find, and rarely change. */
const ROOT_REFRESH_MS = 10 * 60 * 1000;
/** First retry after a failure, doubled on each further one up to MAX_RETRY_MS. */
const RETRY_MS = 15 * 1000;
const MAX_RETRY_MS = 5 * 60 * 1000;
/** A tick waits this long before it goes to Notion; OK again in that time takes it back. */
const UNDO_MS = 1500;
/** Notion can list a task the old way for a few seconds after a change; the bar's own state wins this long. */
const SETTLED_GRACE_MS = 60 * 1000;
/** On opening a page its name is shown this long before its contents. */
const BANNER_MS = 1200;
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

type Shown = Level;

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

function main(): void {
  let config: Config | null = null;
  let key = "";
  let home = "";
  let stack: View[] = [{ kind: "root" }];
  let entries: Entry[] = [];
  let database: Database | null = null;
  let selected = 0;
  /** The entries are worth showing: read from Notion, or remembered. */
  let loaded = false;
  let problem: Problem | null = null;
  let failures = 0;
  let nextReadAt = 0;
  let reading = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let banner: { title: string; until: number } | null = null;
  let bannerTimer: ReturnType<typeof setTimeout> | undefined;

  const remembered = new Map<string, Shown>();
  const databases = new Map<string, Database>();
  interface Pending {
    readonly timer: ReturnType<typeof setTimeout>;
    readonly task: Entry;
    readonly database: Database | null;
    readonly done: boolean;
  }
  /** Ticked off or back on, waiting out UNDO_MS, with the state it goes to. */
  const pending = new Map<string, Pending>();
  /** Sent to Notion, not answered yet, with the state it goes to. */
  const sending = new Map<string, boolean>();
  /** Changed from the bar and confirmed: the state, and when. Wins over reads for SETTLED_GRACE_MS. */
  const settled = new Map<string, { done: boolean; at: number }>();

  /** What a task shows: the change on its way if there is one, else what Notion said. */
  const isDone = (e: Entry): boolean => {
    const p = pending.get(e.id);
    if (p) return p.done;
    const s = sending.get(e.id);
    return s !== undefined ? s : e.done === true;
  };

  /** Notion calls go out one at a time: the bar's runtime is small, and a close should not race a read. */
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const run = queue.then(work);
    queue = run.catch(() => undefined);
    return run;
  };

  const report = (where: string, err: unknown) =>
    console.error(`${APP}: ${where}: ${err instanceof Error ? err.message : String(err)}`);

  const current = () => stack[stack.length - 1];

  // ---- Display -------------------------------------------------------------

  /** What is on screen now, by element id, as last sent. */
  let onScreen: Record<string, string> = {};
  let drawing = false;
  let dirty = false;

  /**
   * Sends only what changed. The new elements go first and the old ones are
   * cleared after: clearing first can leave the app with nothing on screen for
   * a moment, and the bar then flashes its own "Loading" placeholder.
   *
   * If either call fails, what is on screen is no longer known, so the next
   * frame is sent whole. That also covers the bar dropping the app's elements
   * by itself: clearing then fails with "not displaying anything".
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

  /** Forgets what is on screen, so the next frame is sent whole. */
  function redrawAll(): void {
    onScreen = {};
    redraw();
  }

  function frame(): Element[] {
    if (!config) return messageFrame("Loading", "settings");
    if (config.token === "") return messageFrame("Set token", "in settings");
    if (config.token === null) return messageFrame("Bad token", "check the settings");
    if (config.link.kind === "invalid") return messageFrame("Bad link", config.link.text);

    const view = current();
    const title = viewTitle(view) || "Notion";
    if (banner && Date.now() < banner.until) return messageFrame(banner.title, loaded ? count(entries) : "loading");
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
    return listFrame(entries, selected, done);
  }

  /** At most one draw in flight; changes made meanwhile are drawn once it is done. */
  function redraw(): void {
    if (stopped) return;
    if (drawing) {
      dirty = true;
      return;
    }
    drawing = true;
    void show(frame())
      .catch((err: unknown) => report("draw", err))
      .then(() => {
        drawing = false;
        if (dirty) {
          dirty = false;
          redraw();
        }
      });
  }

  function showBanner(title: string): void {
    if (bannerTimer !== undefined) clearTimeout(bannerTimer);
    banner = { title, until: Date.now() + BANNER_MS };
    bannerTimer = setTimeout(() => {
      bannerTimer = undefined;
      banner = null;
      redraw();
    }, BANNER_MS);
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

  function keep(view: View, shown: Shown): void {
    const k = viewKey(view);
    remembered.delete(k);
    remembered.set(k, shown);
    if (remembered.size > MAX_REMEMBERED) {
      const oldest = remembered.keys().next().value;
      if (oldest !== undefined) remembered.delete(oldest);
    }
  }

  /** Saves the path and what every step of it shows, so going up after a restart needs no read. */
  function persist(): void {
    if (!loaded) return;
    const levels = stack.map((v, i) => (i === stack.length - 1 ? { entries, database, selected } : remembered.get(viewKey(v)) ?? null));
    save({ home, stack, levels });
  }

  /** Puts a view on screen from memory when it is there; it is read again either way. */
  function enter(view: View): void {
    const shown = remembered.get(viewKey(view));
    entries = shown ? shown.entries : [];
    database = shown ? shown.database : null;
    selected = shown ? shown.selected : 0;
    loaded = shown !== undefined;
    problem = null;
    failures = 0;
    nextReadAt = 0;
    maybeRead();
  }

  /** New settings start from what was saved for that start page. */
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
    key = nextKey;
    config = next;
    flushPending();
    settled.clear();
    remembered.clear();
    databases.clear();
    dropBanner();
    home = next.link.kind === "id" ? next.link.id : "";
    const saved = load(home);
    if (saved && firstRead) {
      stack = saved.stack;
      saved.levels.forEach((level, i) => {
        if (level) keep(stack[i], level);
      });
    } else {
      stack = [home ? { kind: "start", id: home } : { kind: "root" }];
    }
    enter(current());
  }

  function backOff(): void {
    failures += 1;
    nextReadAt = Date.now() + Math.min(RETRY_MS * Math.pow(2, failures - 1), MAX_RETRY_MS);
  }

  /** Stops showing the view, for a problem that old entries would hide. */
  function fail(p: Problem, retryMs: number): void {
    loaded = false;
    problem = p;
    nextReadAt = Date.now() + retryMs;
  }

  async function read(): Promise<void> {
    const c = config;
    if (!c || !c.token || c.link.kind === "invalid") return;
    const token = c.token;
    const readKey = key;
    const view = current();
    const depth = stack.length;
    const still = () => readKey === key && stack.length === depth && current() === view;
    try {
      // A read of a view the user has left stops at its next request, so the new view's read is not kept waiting.
      const result = await readView(token, view, c.scope, new Date(), databases, still);
      const now = Date.now();
      settled.forEach((s, id) => {
        if (now - s.at > SETTLED_GRACE_MS) settled.delete(id);
      });
      const fresh = result.entries.map((t) => {
        const s = settled.get(t.id);
        return s && s.done !== t.done ? { ...t, done: s.done } : t;
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
      problem = null;
      failures = 0;
      nextReadAt = now + (view.kind === "root" ? ROOT_REFRESH_MS : REFRESH_MS);
      keep(result.view, { entries, database, selected });
      persist();
    } catch (err) {
      if (!still()) return;
      if (failures === 0) report("read", err);
      if (err instanceof NoDoneFieldError) {
        fail(["No checkbox", "or status in this database"], MAX_RETRY_MS);
      } else if (err instanceof NotionError && err.status === 401) {
        fail(["Bad token", "check the settings"], MAX_RETRY_MS);
      } else if (err instanceof NotionError && (err.status === 403 || err.status === 404)) {
        fail(["No access", "share it with the token"], REFRESH_MS);
      } else {
        backOff();
        // Without anything to show yet, say why; with a view, keep it up and keep trying.
        if (!loaded) problem = ["Offline", "retrying"];
      }
    }
  }

  /** Starts a read when one is due and none is running; another follows if the view changed meanwhile. */
  function maybeRead(): void {
    if (stopped || reading || Date.now() < nextReadAt) return;
    reading = true;
    void enqueue(read)
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
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    sending.set(id, p.done);
    redraw();
    const token = config?.token;
    if (!token) {
      sending.delete(id);
      return;
    }
    void enqueue(async () => {
      try {
        await setDone(token, p.task, p.database, p.done);
        settled.set(id, { done: p.done, at: Date.now() });
        const next = withDone(entries, id, p.done);
        if (next) {
          entries = next;
          keep(current(), { entries, database, selected });
          persist();
        }
        remembered.forEach((shown, k) => {
          const list = withDone(shown.entries, id, p.done);
          if (list) remembered.set(k, { ...shown, entries: list });
        });
      } catch (err) {
        // The task shows what Notion has again, so it can be tried again.
        report("tick", err);
      } finally {
        sending.delete(id);
        redraw();
      }
    });
  }

  /** Leaving a view, or the app, sends what was ticked in it: it was meant. */
  function flushPending(): void {
    const ids: string[] = [];
    pending.forEach((_, id) => ids.push(id));
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
   * Plays the confetti over the focused checkbox. The burst is a pre-rendered
   * transparent animation that the bar plays by itself, so it runs at a steady
   * 30 fps whatever the app is doing. Each tick gets a fresh element, which
   * restarts the burst; it is cleared once played. It is not part of the frame
   * diff: it lies on top of the list and goes.
   */
  function celebrate(): void {
    confettiRun += 1;
    const id = `confetti${confettiRun % 2}`;
    const old = `confetti${(confettiRun + 1) % 2}`;
    if (confettiTimer !== undefined) clearTimeout(confettiTimer);
    void drawElements(APP, [{
      id,
      type: "animation",
      display: "front",
      align: "top_left",
      x: 0,
      y: 0,
      path: nextConfetti(),
      loop: false,
      z_index: 6,
    }])
      .catch((err: unknown) => report("confetti", err))
      .then(() => clearElements(APP, [old]).catch(() => undefined));
    confettiTimer = setTimeout(() => {
      confettiTimer = undefined;
      void clearElements(APP, [id]).catch(() => undefined);
    }, CONFETTI_MS);
  }

  // ---- Input ---------------------------------------------------------------

  function activate(): void {
    if (!loaded) return;
    const entry = entries[selected];
    if (!entry) return;
    if (entry.kind === "page" || entry.kind === "database") {
      flushPending();
      keep(current(), { entries, database, selected });
      stack.push({ kind: entry.kind, id: entry.id, title: entry.title });
      showBanner(entry.title);
      enter(current());
      redraw();
      return;
    }
    if (sending.has(entry.id)) return;
    const waiting = pending.get(entry.id);
    if (waiting !== undefined) {
      clearTimeout(waiting.timer);
      pending.delete(entry.id);
    } else {
      const id = entry.id;
      const done = !isDone(entry);
      pending.set(id, { timer: setTimeout(() => send(id), UNDO_MS), task: entry, database, done });
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
    // The bar wipes the app's elements when Back is pressed, so nothing drawn before can be counted on.
    redrawAll();
  }

  function move(delta: number): void {
    if (!loaded || entries.length === 0) return;
    if (banner) dropBanner();
    const next = Math.max(0, Math.min(entries.length - 1, selected + delta));
    if (next === selected) return redraw();
    selected = next;
    redraw();
  }

  function quit(): void {
    if (stopped) return;
    flushPending();
    persist();
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    if (confettiTimer !== undefined) clearTimeout(confettiTimer);
    dropBanner();
    // Not from inside the handler's own callback: with nothing else left, the
    // unbind would stop the app while this callback is still running.
    setTimeout(unbind, 0);
  }

  const unbind = listen("input", (event) => {
    if (event.key === "encoder") move(event.delta);
    // Start, the big button on top, does what OK does: it is the easier one to reach.
    else if ((event.key === "ok" || event.key === "start") && event.action === "short") activate();
    else if (event.key === "back" && event.action === "short") up();
    else if (event.key === "back" && event.action === "long") quit();
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
