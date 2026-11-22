/**
 * Builds the frames the app sends to the display.
 *
 * Elements are built by hand rather than through the layout helpers: every
 * position here is a fixed pixel on a 72x16 screen, so there is nothing for a
 * layout pass to decide.
 *
 * Every element is remembered by what it is made of, and the same inputs give
 * back the same object. The bar's JavaScript is slow (about 3 us an
 * instruction): measured, building a frame from scratch took 140-240 ms. With
 * the elements remembered a frame costs a few lookups, and `main.ts` tells what
 * changed by comparing objects, without serialising them.
 */

import type { DisplayDrawParams } from "@busy-app/busy-lib";

import {
  CHECKBOX_INSET_X,
  CHECKBOX_INSET_Y,
  CHECKBOX_XPM,
  CHEVRON_INSET_Y,
  CHEVRON_X,
  COUNT_COLOR,
  INDENT,
  MAX_DEPTH,
  FOCUS_Y,
  FONT,
  ICON_X,
  ICON_Y,
  IMAGES,
  MARK_COLOR,
  MARK_EDGE,
  MESSAGE_COLOR,
  MESSAGE_DIM_COLOR,
  PLATE,
  LINE_GAP,
  LINE_H,
  LIST_RIGHT,
  PLATE_H,
  SCROLL_MIN,
  SCROLL_THUMB,
  SCROLL_TRACK,
  SCROLL_X,
  SKELETON,
  SKELETON_Y,
  SPINNER,
  SPINNER_X,
  SCREEN_H,
  SCREEN_W,
  STALE_COLOR,
  TEXT_DONE,
  TEXT_EDGE,
  TEXT_IDLE,
  TEXT_INSET_X,
  TEXT_INSET_Y,
  PICK_SHIFT,
  TAG_H,
  TAG_TEXT_Y,
  TAG_TITLE_X,
  TAG_TOP,
  TAG_X,
  dim,
  listX,
  printable,
  tagLook,
  textWidth,
} from "./layout.ts";
import type { Entry } from "./tasks.ts";

export type Element = DisplayDrawParams["elements"][number];

/**
 * Marks for what has no plate, in the checkbox's 7x7 place: a sheet for a
 * page, a grid for a database, a triangle for a toggle, closed or open; and
 * the 3x5 chevron at the right of what opens.
 */
const MARKS: Record<string, readonly string[]> = {
  page: [" ####  ", " #  ## ", " #   # ", " #   # ", " #   # ", " #   # ", " ##### "],
  database: ["       ", " ##### ", " # # # ", " ##### ", " # # # ", " ##### ", "       "],
  toggleClosed: ["       ", "  #    ", "  ##   ", "  ###  ", "  ##   ", "  #    ", "       "],
  toggleOpen: ["       ", "       ", " ##### ", "  ###  ", "   #   ", "       ", "       "],
  chevron: ["#  ", " # ", "  #", " # ", "#  "],
  // The title opens: at its left while it is pointed at.
  go: ["# ", "##", "# "],
  // Turn the wheel: either side of the tag while a status is chosen.
  arrowLeft: ["  #", " ##", "###", " ##", "  #"],
  arrowRight: ["#  ", "## ", "###", "## ", "#  "],
};

/**
 * What the focused line is doing: shown in the list, pointed at on its title
 * or on its mark (checkbox or status), or having its status chosen with
 * `tag` the option on show.
 */
export interface Focus {
  readonly mode: "list" | "title" | "mark" | "pick";
  readonly tag?: { readonly name: string; readonly color: string } | null;
}
const LIST: Focus = { mode: "list" };

/** A line for a row with a status, in two lines on the whole screen. */
export const isTagRow = (e: Entry): boolean => e.kind === "row" && e.tag !== undefined;
/** A task whose title opens something: a database row (a page), or a to-do that links one. */
export const opens = (e: Entry): boolean => e.kind === "row" || (e.kind === "todo" && !!e.link);

/**
 * Elements by what they are made of; cleared when it grows, which only costs
 * rebuilding them. Kept small: the app's whole heap is 384 KiB, and a frame and
 * its two neighbours need about 30 elements.
 */
const made = new Map<string, Element>();
const MAX_MADE = 60;

function remember(key: string, make: () => Element): Element {
  const known = made.get(key);
  if (known) return known;
  if (made.size >= MAX_MADE) made.clear();
  const element = make();
  made.set(key, element);
  return element;
}

function image(id: string, x: number, y: number, path: string, z: number): Element {
  return remember(`i|${id}|${x}|${y}|${path}`, () => ({ id, type: "image", display: "front", align: "top_left", x, y, path, z_index: z }) as Element);
}

function xpm(id: string, x: number, y: number, data: string, key: string): Element {
  return remember(`x|${id}|${x}|${y}|${key}`, () => ({ id, type: "xpmbitmap", display: "front", align: "top_left", x, y, data, z_index: 1 }));
}

function mark(id: string, kind: string, x: number, y: number, color = MARK_COLOR): Element {
  const rows = MARKS[kind];
  const data = () => ["! XPM2", `${rows[0].length} ${rows.length} 2 1`, "  c none", `# c ${color}`, ...rows].join("\n");
  return remember(`m|${id}|${x}|${y}|${kind}|${color}`, () => ({ id, type: "xpmbitmap", display: "front", align: "top_left", x, y, data: data(), z_index: 1 }));
}

/** An XPM with every colour of its palette passed through `f`: the checkbox pointed at, or dimmed. */
function recolor(data: string, f: (hex: string) => string): string {
  return data.replace(/ c #([0-9A-Fa-f]{6})/g, (_m, hex: string) => ` c ${f(`#${hex}`)}`);
}

/** The checkbox pointed at: its grey border white. */
const BOX_POINTED = recolor(CHECKBOX_XPM.idle, (hex) => (parseInt(hex.substring(1, 3), 16) > 0x50 ? "#FFFFFF" : hex));

function plate(id: string, x: number, y: number, done: boolean, height = PLATE_H, dimmed = false): Element {
  const look = done ? PLATE.done : PLATE.idle;
  return remember(`p|${id}|${x}|${y}|${done}|${height}|${dimmed}`, () => ({
    id,
    type: "rectangle",
    display: "front",
    align: "top_left",
    x,
    y,
    width: LIST_RIGHT - x,
    height,
    fill: "solid",
    fill_colors: [dimmed ? dim(look.fill) : look.fill],
    border_width: 1,
    border_color: dimmed ? dim(look.border) : look.border,
    radius: PLATE.radius,
    z_index: 0,
  }) as Element);
}

/** A status tag: a rectangle in the option's dark colour with its name in the light one. */
function tag(slot: number, x: number, name: string, color: string, dimmed: boolean): Element[] {
  const look = tagLook(color);
  const value = printable(name) || "No status";
  const width = textWidth(value) + 4;
  const fill = dimmed ? dim(look.fill) : look.fill;
  const box = remember(`g|${slot}|${x}|${width}|${fill}`, () => ({
    id: `tag${slot}`,
    type: "rectangle",
    display: "front",
    align: "top_left",
    x,
    y: TAG_TOP,
    width,
    height: TAG_H,
    fill: "solid",
    fill_colors: [fill],
    border_width: 0,
    radius: 1,
    z_index: 1,
  }) as Element);
  return [box, text(`tagtext${slot}`, x + 2, TAG_TEXT_Y, value, dimmed ? dim(look.ink) : look.ink, null)];
}

/** Settings that make the bar scroll a line inside `width` when it does not fit. */
function scrolling(width: number): Partial<Element> {
  return { width, scroll_rate: 1200, scroll_start_delay: 1200, scroll_repeat_delay: 2000 } as Partial<Element>;
}

function text(id: string, x: number, y: number, value: string, color: string, scrollWidth: number | null): Element {
  return remember(`t|${id}|${x}|${y}|${color}|${scrollWidth}|${value}`, () => ({
    id,
    type: "text",
    display: "front",
    align: "top_left",
    x,
    y,
    text: value,
    font: FONT,
    color,
    z_index: 2,
    ...(scrollWidth !== null && textWidth(value) > scrollWidth ? scrolling(scrollWidth) : {}),
  }) as Element);
}

/** The app's icon, with the logo on: on every screen, above everything, messages' backdrop included. */
function icon(): Element {
  return image("icon", ICON_X, ICON_Y, IMAGES.icon, 5);
}

/**
 * A 2x2 dot, above the icon or in the top right corner: the list on screen is
 * what Notion said last, and the latest read of it failed.
 */
export function staleMark(logo = false): Element {
  return remember(`stale|${logo}`, () => ({
    id: "stale",
    type: "rectangle",
    display: "front",
    align: "top_left",
    x: logo ? ICON_X + 3 : SCREEN_W - 2,
    y: logo ? ICON_Y - 3 : 0,
    width: 2,
    height: 2,
    fill: "solid",
    fill_colors: [STALE_COLOR],
    border_width: 0,
    z_index: 5,
  }) as Element);
}

/** The longest start of `value` that fits `width` px: halving, not a character at a time. */
export function fit(value: string, width: number): string {
  if (textWidth(value) <= width) return value;
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(value.substring(0, mid)) <= width) lo = mid;
    else hi = mid - 1;
  }
  return value.substring(0, lo);
}

/** Which tasks are ticked off, in Notion or on their way there: ids, or a test asked of the lines on screen only. */
export type Done = ReadonlySet<string> | ((e: Entry) => boolean);

const hasPlate = (e: Entry) => e.kind === "todo" || e.kind === "row";
/** A line's height, and where its box starts below the text's anchor. */
const boxOf = (e: Entry) => (hasPlate(e) ? { h: PLATE_H, inset: 0 } : { h: LINE_H, inset: 1 });

/**
 * Which entries are on screen and where: the focused one with its text at
 * FOCUS_Y, then outwards, each line LINE_GAP from the next, while any of it is
 * on screen. Returns each line's offset from the focused one and its anchor.
 */
export function placeLines(entries: readonly Entry[], selected: number): { offset: number; y: number }[] {
  const out: { offset: number; y: number }[] = [];
  const focus = entries[selected];
  if (!focus) return out;
  // A row with a status fills the screen: nothing else shows around it.
  if (isTagRow(focus)) return [{ offset: 0, y: 0 }];
  out.push({ offset: 0, y: FOCUS_Y });
  let top = FOCUS_Y + boxOf(focus).inset;
  for (let i = selected - 1; i >= 0 && top - 1 - LINE_GAP >= 0; i -= 1) {
    const b = boxOf(entries[i]);
    top = top - LINE_GAP - b.h;
    out.push({ offset: i - selected, y: top - b.inset });
  }
  let bottom = FOCUS_Y + boxOf(focus).inset + boxOf(focus).h - 1;
  for (let i = selected + 1; i < entries.length && bottom + 1 + LINE_GAP <= SCREEN_H - 1; i += 1) {
    const b = boxOf(entries[i]);
    const boxTop = bottom + 1 + LINE_GAP;
    out.push({ offset: i - selected, y: boxTop - b.inset });
    bottom = boxTop + b.h - 1;
  }
  return out;
}

/**
 * The list: the focused entry in the middle, the ones around it cut by the
 * screen's edges. Only a task has a plate: the highlighted one with the blue
 * checkbox and faded text when ticked, the dark one with an empty checkbox and
 * white text when open. A page, a database and a toggle have a mark in the
 * checkbox's place and no plate; a page and a database a chevron at the right,
 * a toggle the count of open tasks in it. A heading is faded text alone. Each
 * level of nesting moves a line INDENT px right. Only the focused line scrolls
 * when it is too long; the others run off their room.
 */
export function listFrame(
  entries: readonly Entry[],
  selected: number,
  doneIds: Done,
  logo = false,
  openToggles: ReadonlySet<string> = new Set(),
  focus: Focus = LIST,
): Element[] {
  const isDone = typeof doneIds === "function" ? doneIds : (e: Entry) => doneIds.has(e.id);
  const elements: Element[] = logo ? [icon()] : [];
  for (const { offset, y } of placeLines(entries, selected)) {
    const entry = entries[selected + offset];
    const done = hasPlate(entry) && isDone(entry);
    const open = entry.kind === "toggle" && openToggles.has(entry.id);
    for (const element of lineOf(entry, offset + 1, y, offset === 0, done, open, logo, offset === 0 ? focus : LIST)) elements.push(element);
  }
  for (const element of scrollbar(entries, selected)) elements.push(element);
  return elements;
}

/**
 * Each line's place among the lines the focus can stand on, worked out once a
 * list: a loop over a long page costs the bar milliseconds, a frame should not.
 */
let placesFor: { lines: readonly Entry[]; at: number[]; count: number } | null = null;

function places(lines: readonly Entry[]): { at: number[]; count: number } {
  if (!placesFor || placesFor.lines !== lines) {
    const at: number[] = [];
    let count = 0;
    for (let i = 0; i < lines.length; i += 1) {
      at.push(count);
      if (lines[i].kind !== "heading") count += 1;
    }
    placesFor = { lines, at, count };
  }
  return placesFor;
}

function bar(id: string, y: number, height: number, color: string, z: number): Element {
  return remember(`sb|${id}|${y}|${height}`, () => ({
    id,
    type: "rectangle",
    display: "front",
    align: "top_left",
    x: SCROLL_X,
    y,
    width: 1,
    height,
    fill: "solid",
    fill_colors: [color],
    border_width: 0,
    z_index: z,
  }) as Element);
}

/**
 * Where the focus is in the list, as the firmware's menus show it: the thumb
 * moves down the track from the first line the focus can stand on to the
 * last. Nothing when there is only one.
 */
export function scrollbar(lines: readonly Entry[], selected: number): Element[] {
  const { at, count } = places(lines);
  if (count < 2 || selected < 0 || selected >= lines.length) return [];
  const height = Math.max(Math.floor(SCREEN_H / count), SCROLL_MIN);
  const room = SCREEN_H - height;
  const y = Math.floor((room * at[selected] + Math.floor((count - 1) / 2)) / (count - 1));
  return [bar("scrolltrack", 0, SCREEN_H, SCROLL_TRACK, 1), bar("scrollthumb", y, height, SCROLL_THUMB, 2)];
}

/**
 * One line's elements, remembered for the entry object and where and how it
 * is drawn: turning the wheel brings back lines already built, at a lookup each.
 */
const linesMade = new Map<Entry, Map<string, Element[]>>();
const MAX_LINES = 24;

function lineOf(entry: Entry, slot: number, y: number, focused: boolean, done: boolean, open: boolean, logo: boolean, focus: Focus): Element[] {
  let made = linesMade.get(entry);
  if (!made) {
    if (linesMade.size >= MAX_LINES) linesMade.clear();
    made = new Map();
    linesMade.set(entry, made);
  }
  const shown = focus.tag ? `${focus.tag.name}|${focus.tag.color}` : "";
  const key = `${slot}|${y}|${focused ? 1 : 0}${done ? 1 : 0}${open ? 1 : 0}${logo ? 1 : 0}|${focus.mode}|${shown}`;
  let line = made.get(key);
  if (!line) {
    line = buildLine(entry, slot, y, focused, done, open, logo, focus);
    made.set(key, line);
  }
  return line;
}

function buildLine(entry: Entry, slot: number, y: number, focused: boolean, done: boolean, open: boolean, logo: boolean, focus: Focus): Element[] {
  /** The focused line scrolls in its room; the others are cut to it, so they stay clear of a chevron or a count. */
  const line = (id: string, x: number, ly: number, title: string, color: string, room: number) =>
    remember(`l|${id}|${x}|${ly}|${color}|${room}|${focused}|${title}`, () => {
      // A title of emoji alone has nothing the font can draw.
      const value = printable(title) || "Untitled";
      return text(id, x, ly, focused ? value : fit(value, room), color, focused ? room : null);
    });
  const out: Element[] = [];
  const x0 = listX(logo) + INDENT * Math.min(entry.depth ?? 0, MAX_DEPTH);
  const textX = x0 + TEXT_INSET_X;
  const markX = x0 + CHECKBOX_INSET_X;
  const markY = y + CHECKBOX_INSET_Y;
  // Lines without a plate go grey away from the focus.
  const ink = focused ? TEXT_IDLE : TEXT_EDGE;
  const markColor = focused ? MARK_COLOR : MARK_EDGE;
  // The checkbox and every mark are XPM under one id per slot, so a slot that
  // changes kind keeps its element. A plate, a chevron or a count a slot no
  // longer has is moved off screen by main.ts.
  const mode = focus.mode;
  if (isTagRow(entry)) {
    // Two lines on the whole screen: the title, which opens, and the status under it.
    const onTitle = mode === "title";
    const onTag = mode === "mark" || mode === "pick";
    const titleX = x0 + TAG_TITLE_X;
    const ink = done ? TEXT_DONE : TEXT_IDLE;
    out.push(plate(`row${slot}`, x0, y, done, SCREEN_H, mode !== "list"));
    out.push(line(`text${slot}`, titleX, y, entry.title, onTag ? dim(ink) : ink, CHEVRON_X - 2 - titleX));
    out.push(mark(`chevron${slot}`, "chevron", CHEVRON_X, y + CHEVRON_INSET_Y, onTag ? dim(MARK_COLOR) : MARK_COLOR));
    if (onTitle) out.push(mark(`go${slot}`, "go", x0 + 1, y + 3, TEXT_IDLE.substring(0, 7)));
    const shown = focus.tag ?? { name: entry.tag ?? "", color: entry.color ?? "default" };
    const tagX = x0 + TAG_X + (mode === "pick" ? PICK_SHIFT : 0);
    for (const element of tag(slot, tagX, shown.name, shown.color, onTitle)) out.push(element);
    if (mode === "pick") {
      const width = textWidth(printable(shown.name) || "No status") + 4;
      out.push(mark(`arrowl${slot}`, "arrowLeft", tagX - 4, TAG_TOP + 1, "#FFFFFF"));
      out.push(mark(`arrowr${slot}`, "arrowRight", tagX + width + 1, TAG_TOP + 1, "#FFFFFF"));
    }
  } else if (hasPlate(entry)) {
    const link = opens(entry);
    const onTitle = mode === "title";
    const onMark = mode === "mark";
    const ink = done ? TEXT_DONE : TEXT_IDLE;
    out.push(plate(`row${slot}`, x0, y, done, PLATE_H, mode !== "list"));
    const box = done ? CHECKBOX_XPM.done : onMark ? BOX_POINTED : CHECKBOX_XPM.idle;
    const boxKey = `${done ? "done" : onMark ? "pointed" : "idle"}${onTitle ? "-dim" : ""}`;
    out.push(xpm(`mark${slot}`, markX, markY, onTitle ? recolor(box, dim) : box, boxKey));
    out.push(line(`text${slot}`, textX, y + TEXT_INSET_Y, entry.title, onMark ? dim(ink) : ink, (link ? CHEVRON_X - 2 : LIST_RIGHT) - textX));
    if (link) out.push(mark(`chevron${slot}`, "chevron", CHEVRON_X, y + CHEVRON_INSET_Y, onMark ? dim(MARK_COLOR) : MARK_COLOR));
    if (onTitle) out.push(mark(`go${slot}`, "go", textX - 2, y + 3, TEXT_IDLE.substring(0, 7)));
  } else if (entry.kind === "page" || entry.kind === "database") {
    out.push(mark(`mark${slot}`, entry.kind, markX, markY, markColor));
    out.push(mark(`chevron${slot}`, "chevron", CHEVRON_X, y + CHEVRON_INSET_Y, markColor));
    out.push(line(`text${slot}`, textX, y + TEXT_INSET_Y, entry.title, ink, CHEVRON_X - 2 - textX));
  } else if (entry.kind === "toggle") {
    out.push(mark(`mark${slot}`, open ? "toggleOpen" : "toggleClosed", markX, markY, markColor));
    const count = String(entry.count ?? 0);
    const countX = LIST_RIGHT - 1 - textWidth(count);
    if (entry.count) out.push(text(`count${slot}`, countX, y + TEXT_INSET_Y, count, focused ? COUNT_COLOR : TEXT_EDGE, null));
    const room = (entry.count ? countX - 1 : LIST_RIGHT) - textX;
    out.push(line(`text${slot}`, textX, y + TEXT_INSET_Y, entry.title, ink, room));
  } else {
    // A heading is never focused: grey, as any line without a plate away from the focus.
    out.push(line(`text${slot}`, x0 + 1, y + TEXT_INSET_Y, entry.title, TEXT_EDGE, LIST_RIGHT - x0 - 1));
  }
  return out;
}

/**
 * Shown while a view is read for the first time, so it is plain the bar has not
 * hung: the title moved to the top line, with its mark, the firmware's spinner
 * at the right, and a skeleton of a line under them with a shimmer. Both are
 * animations the bar plays itself: no request per frame.
 */
export function loadingFrame(title: string, kind: "page" | "database" | null, logo = false): Element[] {
  const x0 = listX(logo);
  const textX = kind ? x0 + TEXT_INSET_X : x0 + 1;
  const value = printable(title) || "Untitled";
  const out: Element[] = logo ? [icon()] : [];
  if (kind) out.push(mark("loadmark", kind, x0 + CHECKBOX_INSET_X, CHECKBOX_INSET_Y));
  out.push(text("loadtitle", textX, 0, value, TEXT_IDLE, SPINNER_X - 2 - textX));
  out.push(remember("loadspin", () => ({
    id: "loadspin", type: "animation", display: "front", align: "top_left", x: SPINNER_X, y: 0, stock_path: SPINNER, loop: true, z_index: 2,
  }) as unknown as Element));
  out.push(remember(`loadskel|${x0}`, () => ({
    id: "loadskel", type: "animation", display: "front", align: "top_left", x: x0, y: SKELETON_Y, path: SKELETON, loop: true, z_index: 1,
  }) as unknown as Element));
  return out;
}

/**
 * Shown while there is no list: two short centred lines, the second dimmed
 * and scrolling when it is long. They sit on an opaque black backdrop above
 * everything else, so whatever was on screen is hidden the moment the message
 * is drawn, before the old elements are cleared.
 */
export function messageFrame(title: string, detail: string, logo = false): Element[] {
  // Centred in the room right of the icon, or on the whole screen.
  const x0 = listX(logo);
  const middle = x0 + (SCREEN_W - x0) / 2;
  const inner = SCREEN_W - x0 - 2;
  const line = (id: string, y: number, raw: string, color: string): Element => remember(`ml|${id}|${y}|${logo}|${color}|${raw}`, () => {
    const value = printable(raw);
    const long = textWidth(value) > inner;
    return {
      id,
      type: "text",
      display: "front",
      align: long ? "top_left" : "top_mid",
      x: long ? x0 + 1 : middle,
      y,
      text: value,
      font: FONT,
      color,
      z_index: 4,
      ...(long ? scrolling(inner) : {}),
    } as Element;
  });
  const backdrop: Element = remember("m_backdrop", () => ({
    id: "m_backdrop",
    type: "rectangle",
    display: "front",
    align: "top_left",
    x: 0,
    y: 0,
    width: SCREEN_W,
    height: SCREEN_H,
    fill: "solid",
    fill_colors: ["#000000FF"],
    border_width: 0,
    z_index: 3,
  }) as Element);
  // The font's 2 px top bearing: these anchors put the ink on rows 2..6 and 9..13.
  const lines = [backdrop, line("m_title", 0, title, MESSAGE_COLOR), line("m_detail", 7, detail, MESSAGE_DIM_COLOR)];
  return logo ? [icon(), ...lines] : lines;
}
