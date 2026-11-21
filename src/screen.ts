/**
 * Builds the frames the app sends to the display.
 *
 * Elements are built by hand rather than through the layout helpers: every
 * position here is a fixed pixel on a 72x16 screen, so there is nothing for a
 * layout pass to decide.
 */

import type { DisplayDrawParams } from "@busy-app/busy-lib";

import {
  CHECKBOX_INSET_X,
  CHECKBOX_INSET_Y,
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
  MESSAGE_COLOR,
  MESSAGE_DIM_COLOR,
  LINE_GAP,
  LINE_H,
  PLATE_H,
  SCREEN_H,
  SCREEN_W,
  STALE_COLOR,
  TEXT_DONE,
  TEXT_HEADING,
  TEXT_IDLE,
  TEXT_INSET_X,
  TEXT_INSET_Y,
  listX,
  printable,
  rowImage,
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

function image(id: string, x: number, y: number, path: string, z: number): Element {
  return { id, type: "image", display: "front", align: "top_left", x, y, path, z_index: z } as Element;
}

function mark(id: string, kind: string, x: number, y: number): Element {
  const rows = MARKS[kind];
  return {
    id,
    type: "xpmbitmap",
    display: "front",
    align: "top_left",
    x,
    y,
    data: ["! XPM2", `${rows[0].length} ${rows.length} 2 1`, "  c none", `# c ${MARK_COLOR}`, ...rows].join("\n"),
    z_index: 1,
  };
}

/** Settings that make the bar scroll a line inside `width` when it does not fit. */
function scrolling(width: number): Partial<Element> {
  return { width, scroll_rate: 1200, scroll_start_delay: 1200, scroll_repeat_delay: 2000 } as Partial<Element>;
}

function text(id: string, x: number, y: number, value: string, color: string, scrollWidth: number | null): Element {
  return {
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
  } as Element;
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
  return {
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
  } as Element;
}

/** The longest start of `value` that fits `width` px. */
export function fit(value: string, width: number): string {
  if (textWidth(value) <= width) return value;
  let n = value.length;
  while (n > 0 && textWidth(value.substring(0, n)) > width) n -= 1;
  return value.substring(0, n);
}

/** Ids of the tasks that are ticked off, in Notion or on their way there. */
export type Done = ReadonlySet<string>;

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
  /** The focused line scrolls in its room; the others are cut to it, so they stay clear of a chevron or a count. */
  const line = (id: string, x: number, y: number, title: string, color: string, room: number, focused: boolean) => {
    const value = printable(title);
    return text(id, x, y, focused ? value : fit(value, room), color, focused ? room : null);
  };
  const elements: Element[] = logo ? [icon()] : [];
  for (const { offset, y } of placeLines(entries, selected)) {
    const entry = entries[selected + offset];
    // Ids by place: 1 is the focused line, 0 and 2 its neighbours, and so on outwards.
    const slot = offset + 1;
    const x0 = listX(logo) + INDENT * Math.min(entry.depth ?? 0, MAX_DEPTH);
    const focused = offset === 0;
    const textX = x0 + TEXT_INSET_X;
    const markY = y + CHECKBOX_INSET_Y;
    // Each kind of mark has its own id: the bar rejects a draw that changes an
    // element's type under the same id. A slot that changes kind is cleared once.
    if (hasPlate(entry)) {
      const done = doneIds.has(entry.id);
      elements.push(image(`row${slot}`, x0, y, rowImage(done, SCREEN_W - x0), 0));
      elements.push(image(`box${slot}`, x0 + CHECKBOX_INSET_X, markY, done ? IMAGES.checkboxDone : IMAGES.checkboxIdle, 1));
      elements.push(line(`text${slot}`, textX, y + TEXT_INSET_Y, entry.title, done ? TEXT_DONE : TEXT_IDLE, SCREEN_W - textX, focused));
    } else if (entry.kind === "page" || entry.kind === "database") {
      elements.push(mark(`${entry.kind}${slot}`, entry.kind, x0 + CHECKBOX_INSET_X, markY));
      elements.push(mark(`chevron${slot}`, "chevron", CHEVRON_X, y + CHEVRON_INSET_Y));
      elements.push(line(`text${slot}`, textX, y + TEXT_INSET_Y, entry.title, TEXT_IDLE, CHEVRON_X - 2 - textX, focused));
    } else if (entry.kind === "toggle") {
      const open = openToggles.has(entry.id);
      elements.push(mark(`toggle${slot}`, open ? "toggleOpen" : "toggleClosed", x0 + CHECKBOX_INSET_X, markY));
      const count = String(entry.count ?? 0);
      const countX = SCREEN_W - 1 - textWidth(count);
      if (entry.count) elements.push(text(`count${slot}`, countX, y + TEXT_INSET_Y, count, COUNT_COLOR, null));
      const room = (entry.count ? countX - 1 : SCREEN_W) - textX;
      elements.push(line(`text${slot}`, textX, y + TEXT_INSET_Y, entry.title, TEXT_IDLE, room, focused));
    } else {
      elements.push(line(`text${slot}`, x0 + 1, y + TEXT_INSET_Y, entry.title, TEXT_HEADING, SCREEN_W - x0 - 1, false));
    }
  }
  return elements;
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
  const line = (id: string, y: number, raw: string, color: string): Element => {
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
  };
  const backdrop: Element = {
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
  };
  // The font's 2 px top bearing: these anchors put the ink on rows 2..6 and 9..13.
  const lines = [backdrop, line("m_title", 0, title, MESSAGE_COLOR), line("m_detail", 7, detail, MESSAGE_DIM_COLOR)];
  return logo ? [icon(), ...lines] : lines;
}
