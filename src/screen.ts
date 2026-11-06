/**
 * Builds the frames the app sends to the display.
 *
 * Elements are built by hand rather than through the layout helpers: every
 * position here is a fixed pixel on a 72x16 screen, so there is nothing for a
 * layout pass to decide.
 */

import type { DisplayDrawParams } from "@busy-app/busy-lib";

import {
  CHECKBOX_INSET_Y,
  CHECKBOX_X,
  FOCUS_Y,
  FONT,
  ICON_X,
  ICON_Y,
  IMAGES,
  LIST_X,
  MARK_COLOR,
  MESSAGE_COLOR,
  MESSAGE_DIM_COLOR,
  ROW_STEP,
  SCREEN_H,
  SCREEN_W,
  TEXT_DONE,
  TEXT_IDLE,
  TEXT_INSET_Y,
  TEXT_X,
  textWidth,
} from "./layout.ts";
import type { Entry } from "./tasks.ts";

export type Element = DisplayDrawParams["elements"][number];

/**
 * Marks for what opens rather than ticks, in the checkbox's 7x7 place: an
 * arrow for a page, a grid for a database.
 */
const MARKS: Record<string, readonly string[]> = {
  page: ["       ", "  #    ", "  ##   ", "  ###  ", "  ##   ", "  #    ", "       "],
  database: ["       ", " ##### ", " # # # ", " ##### ", " # # # ", " ##### ", "       "],
};

function image(id: string, x: number, y: number, path: string, z: number): Element {
  return { id, type: "image", display: "front", align: "top_left", x, y, path, z_index: z } as Element;
}

function mark(id: string, kind: string, x: number, y: number): Element {
  return {
    id,
    type: "xpmbitmap",
    display: "front",
    align: "top_left",
    x,
    y,
    data: ["! XPM2", "7 7 2 1", "  c none", `# c ${MARK_COLOR}`, ...MARKS[kind]].join("\n"),
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

/** The app's icon, on every screen and above everything, messages' backdrop included. */
function icon(): Element {
  return image("icon", ICON_X, ICON_Y, IMAGES.icon, 5);
}

/** Ids of the tasks that are ticked off, in Notion or on their way there. */
export type Done = ReadonlySet<string>;

/** Which entries are on screen: the focused one and its neighbours, as offsets from it. */
const SLOTS = [-1, 0, 1];

/**
 * The list: the focused entry in the middle, the ones around it cut by the
 * screen's edges. A ticked task has the highlighted row, the blue checkbox and
 * white text; an open one the dark row, an empty checkbox and dimmed text.
 * Pages and databases have the dark row and a mark instead of a checkbox. Only
 * the focused line scrolls when it is too long; the others run off the edge.
 */
export function listFrame(entries: readonly Entry[], selected: number, doneIds: Done): Element[] {
  const elements: Element[] = [icon()];
  for (const offset of SLOTS) {
    const i = selected + offset;
    if (i < 0 || i >= entries.length) continue;
    const entry = entries[i];
    const slot = offset + 1;
    const y = FOCUS_Y + offset * ROW_STEP;
    const isPlace = entry.kind === "page" || entry.kind === "database";
    const done = !isPlace && doneIds.has(entry.id);

    elements.push(image(`row${slot}`, LIST_X, y, done ? IMAGES.rowDone : IMAGES.rowIdle, 0));
    // Each kind of mark has its own id: the bar rejects a draw that changes an
    // element's type under the same id. A slot that changes kind is cleared once.
    const markY = y + CHECKBOX_INSET_Y;
    elements.push(isPlace
      ? mark(`${entry.kind}${slot}`, entry.kind, CHECKBOX_X, markY)
      : image(`box${slot}`, CHECKBOX_X, markY, done ? IMAGES.checkboxDone : IMAGES.checkboxIdle, 1));
    const scroll = offset === 0 ? SCREEN_W - TEXT_X : null;
    elements.push(text(`text${slot}`, TEXT_X, y + TEXT_INSET_Y, entry.title, done ? TEXT_DONE : TEXT_IDLE, scroll));
  }
  return elements;
}

/**
 * Shown while there is no list: two short centred lines, the second dimmed
 * and scrolling when it is long. They sit on an opaque black backdrop above
 * everything else, so whatever was on screen is hidden the moment the message
 * is drawn, before the old elements are cleared.
 */
export function messageFrame(title: string, detail: string): Element[] {
  // Centred in the room right of the icon.
  const middle = LIST_X + (SCREEN_W - LIST_X) / 2;
  const inner = SCREEN_W - LIST_X - 2;
  const line = (id: string, y: number, value: string, color: string): Element => {
    const long = textWidth(value) > inner;
    return {
      id,
      type: "text",
      display: "front",
      align: long ? "top_left" : "top_mid",
      x: long ? LIST_X + 1 : middle,
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
  return [icon(), backdrop, line("m_title", 0, title, MESSAGE_COLOR), line("m_detail", 7, detail, MESSAGE_DIM_COLOR)];
}
