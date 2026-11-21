/**
 * Screen geometry, palette and text measuring, after the Figma design
 * `notion_frontscreen_tasks_list`.
 *
 * The front display is 72x16. Entries are 9 px rows, 10 px apart, the whole
 * width of the screen. With the logo on (a setting, for photos and videos),
 * the app's 8x8 icon sits on the left and the rows start beside it. The focused one sits in the
 * middle, rows 3..11; the one before peeks in at the top and the one after at
 * the bottom. Turning the wheel scrolls the list a row.
 */

import { registerFontMaps, textWidth as measure } from "@busy-app/busy-lib";
import { small } from "@busy-app/busy-lib/fonts";

export const SCREEN_W = 72;
export const SCREEN_H = 16;

export const FONT = "small";
registerFontMaps(small);

/** The icon, centred vertically at the left edge. */
export const ICON_X = 0;
export const ICON_Y = 4;

export const ROW_H = 9;
export const ROW_STEP = 10;
/** Top of the focused row. */
export const FOCUS_Y = 3;

/** The checkbox is 7x7, 1 px in from the row's left and top edges. */
export const CHECKBOX_INSET_X = 1;
export const CHECKBOX_INSET_Y = 1;

/**
 * `small` text anchored at y puts its ink on rows y+2..y+6 (measured on the
 * device), so text anchored at the row's top sits in the middle of the 9 px row.
 */
export const TEXT_INSET_X = 11;
export const TEXT_INSET_Y = 0;

/**
 * Images from the design, packaged under src/images. The rows are 72 px wide,
 * or 62 px with the logo: 10 px less of their flat middle.
 */
export const IMAGES = {
  icon: "images/notion_icon.png",
  rowDone: "images/row_done.png",
  rowIdle: "images/row_idle.png",
  rowDoneWide: "images/row_done_wide.png",
  rowIdleWide: "images/row_idle_wide.png",
  checkboxDone: "images/checkbox_done.png",
  checkboxIdle: "images/checkbox_idle.png",
};

/** Text of an open task, a page and a database is white; a ticked task's fades to 40%. */
export const TEXT_DONE = "#FFFFFF66";
export const TEXT_IDLE = "#FFFFFFFF";
/** The mark that stands in for the checkbox on a page or a database: the idle checkbox's grey. */
export const MARK_COLOR = "#5F5E58";

/** The dot that marks a list Notion could not confirm on the last read. */
export const STALE_COLOR = "#FF8A3DFF";

export const MESSAGE_COLOR = "#FFFFFFFF";
export const MESSAGE_DIM_COLOR = "#FFFFFF99";

/** Where the list starts: the screen's left edge, or 2 px right of the icon. */
export function listX(logo: boolean): number {
  return logo ? 10 : 0;
}

/** Width of `text` in the app's font, in pixels. */
export function textWidth(text: string): number {
  return measure(text, FONT);
}
