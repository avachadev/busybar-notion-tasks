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
  PLATE_H,
  SCREEN_H,
  SCREEN_W,
  STALE_COLOR,
  TEXT_DONE,
  TEXT_EDGE,
  TEXT_IDLE,
  TEXT_INSET_X,
  TEXT_INSET_Y,
  listX,
  printable,
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
};

/** Elements by what they are made of; cleared when it grows, which only costs rebuilding them. */
const made = new Map<string, Element>();
const MAX_MADE = 400;

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

function plate(id: string, x: number, y: number, done: boolean): Element {
  const look = done ? PLATE.done : PLATE.idle;
  return remember(`p|${id}|${x}|${y}|${done}`, () => ({
    id,
    type: "rectangle",
    display: "front",
    align: "top_left",
    x,
    y,
    width: SCREEN_W - x,
    height: PLATE_H,
    fill: "solid",
    fill_colors: [look.fill],
    border_width: 1,
    border_color: look.border,
    radius: PLATE.radius,
    z_index: 0,
  }) as Element);
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
): Element[] {
  const isDone = typeof doneIds === "function" ? doneIds : (e: Entry) => doneIds.has(e.id);
  const elements: Element[] = logo ? [icon()] : [];
  for (const { offset, y } of placeLines(entries, selected)) {
    const entry = entries[selected + offset];
    const done = hasPlate(entry) && isDone(entry);
    const open = entry.kind === "toggle" && openToggles.has(entry.id);
    for (const element of lineOf(entry, offset + 1, y, offset === 0, done, open, logo)) elements.push(element);
  }
  return elements;
}

/**
 * One line's elements, remembered for the entry object and where and how it
 * is drawn: turning the wheel brings back lines already built, at a lookup each.
 */
const linesMade = new Map<Entry, Map<string, Element[]>>();
const MAX_LINES = 120;

function lineOf(entry: Entry, slot: number, y: number, focused: boolean, done: boolean, open: boolean, logo: boolean): Element[] {
  let made = linesMade.get(entry);
  if (!made) {
    if (linesMade.size >= MAX_LINES) linesMade.clear();
    made = new Map();
    linesMade.set(entry, made);
  }
  const key = `${slot}|${y}|${focused ? 1 : 0}${done ? 1 : 0}${open ? 1 : 0}${logo ? 1 : 0}`;
  let line = made.get(key);
  if (!line) {
    line = buildLine(entry, slot, y, focused, done, open, logo);
    made.set(key, line);
  }
  return line;
}

function buildLine(entry: Entry, slot: number, y: number, focused: boolean, done: boolean, open: boolean, logo: boolean): Element[] {
  /** The focused line scrolls in its room; the others are cut to it, so they stay clear of a chevron or a count. */
  const line = (id: string, x: number, ly: number, title: string, color: string, room: number) =>
    remember(`l|${id}|${x}|${ly}|${color}|${room}|${focused}|${title}`, () => {
      const value = printable(title);
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
  if (hasPlate(entry)) {
    out.push(plate(`row${slot}`, x0, y, done));
    out.push(xpm(`mark${slot}`, markX, markY, done ? CHECKBOX_XPM.done : CHECKBOX_XPM.idle, done ? "done" : "idle"));
    out.push(line(`text${slot}`, textX, y + TEXT_INSET_Y, entry.title, done ? TEXT_DONE : TEXT_IDLE, SCREEN_W - textX));
  } else if (entry.kind === "page" || entry.kind === "database") {
    out.push(mark(`mark${slot}`, entry.kind, markX, markY, markColor));
    out.push(mark(`chevron${slot}`, "chevron", CHEVRON_X, y + CHEVRON_INSET_Y, markColor));
    out.push(line(`text${slot}`, textX, y + TEXT_INSET_Y, entry.title, ink, CHEVRON_X - 2 - textX));
  } else if (entry.kind === "toggle") {
    out.push(mark(`mark${slot}`, open ? "toggleOpen" : "toggleClosed", markX, markY, markColor));
    const count = String(entry.count ?? 0);
    const countX = SCREEN_W - 1 - textWidth(count);
    if (entry.count) out.push(text(`count${slot}`, countX, y + TEXT_INSET_Y, count, focused ? COUNT_COLOR : TEXT_EDGE, null));
    const room = (entry.count ? countX - 1 : SCREEN_W) - textX;
    out.push(line(`text${slot}`, textX, y + TEXT_INSET_Y, entry.title, ink, room));
  } else {
    // A heading is never focused: grey, as any line without a plate away from the focus.
    out.push(line(`text${slot}`, x0 + 1, y + TEXT_INSET_Y, entry.title, TEXT_EDGE, SCREEN_W - x0 - 1));
  }
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
