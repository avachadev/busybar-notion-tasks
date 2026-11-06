/**
 * Screen geometry, palette and text measuring, after the Figma design
 * `notion_frontscreen_tasks_list`.
 *
 * The front display is 72x16. The app's 8x8 icon sits on the left on every
 * screen, so a photo or a screen recording shows what the bar is showing.
 * Beside it, entries are 9 px rows, 10 px apart. The focused one sits in the
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
/** Where the list starts, 2 px right of the icon. Rows are 62 px wide, to the screen's edge. */
export const LIST_X = 10;

export const ROW_H = 9;
export const ROW_STEP = 10;
/** Top of the focused row. */
export const FOCUS_Y = 3;

/** The checkbox is 7x7, 1 px in from the row's left and top edges. */
export const CHECKBOX_X = LIST_X + 1;
export const CHECKBOX_INSET_Y = 1;

/**
 * `small` text anchored at y puts its ink on rows y+2..y+6 (measured on the
 * device), so text anchored at the row's top sits in the middle of the 9 px row.
 */
export const TEXT_X = LIST_X + 11;
export const TEXT_INSET_Y = 0;

/**
 * Images from the design, packaged under src/images. The rows are Figma's
 * 72x9 rows with 10 px cut from their flat middle, to make room for the icon.
 */
export const IMAGES = {
  icon: "images/notion_icon.png",
  rowDone: "images/row_done.png",
  rowIdle: "images/row_idle.png",
  checkboxDone: "images/checkbox_done.png",
  checkboxIdle: "images/checkbox_idle.png",
};

/** Text of a ticked task; an open one is white at 40%. */
export const TEXT_DONE = "#FFFFFFFF";
export const TEXT_IDLE = "#FFFFFF66";
/** The mark that stands in for the checkbox on a page or a database: the idle checkbox's grey. */
export const MARK_COLOR = "#5F5E58";

export const MESSAGE_COLOR = "#FFFFFFFF";
export const MESSAGE_DIM_COLOR = "#FFFFFF99";

/** Width of `text` in the app's font, in pixels. */
export function textWidth(text: string): number {
  return measure(text, FONT);
}
