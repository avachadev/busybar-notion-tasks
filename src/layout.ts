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

/**
 * Lines stack by their height, not on a fixed step: a task's plate is 9 px; a
 * line without one (a page, a database, a toggle, a heading) is its 5 px of
 * letters and 1 px above and below, 7 px. Lines are 1 px apart, and the
 * focused one sits in the middle of the screen, rows 3..11 or 4..10.
 */
export const PLATE_H = 9;
export const LINE_H = 7;
export const LINE_GAP = 1;
/** Where the focused line's text is anchored, whatever its kind. */
export const FOCUS_Y = 3;

/** The checkbox is 7x7, 1 px in from the row's left and top edges. */
export const CHECKBOX_INSET_X = 1;
export const CHECKBOX_INSET_Y = 1;

/**
 * Text starts 2 px right of the 7 px checkbox or mark. `small` text anchored
 * at y puts its ink on rows y+2..y+6 (measured on the device), so text anchored
 * at the row's top sits in the middle of the 9 px row.
 */
export const TEXT_INSET_X = 10;
export const TEXT_INSET_Y = 0;

/** Images from the design, packaged under src/images. */
export const IMAGES = {
  icon: "images/notion_icon.png",
  checkboxDone: "images/checkbox_done.png",
  checkboxIdle: "images/checkbox_idle.png",
};

/** Each level of nesting moves a line this far right; deeper than MAX_DEPTH stays there. */
export const INDENT = 3;
export const MAX_DEPTH = 3;

/**
 * A task's plate, from the screen's right edge back to where the line starts:
 * 72 px less the logo's 10 and the indent. Every width is its own PNG, cut
 * from the flat middle of the 72 px one.
 */
export function rowImage(done: boolean, width: number): string {
  return `images/row_${done ? "done" : "idle"}_${width}.png`;
}

/** Text of an open task and of a focused page or database is white; a ticked task's fades to 40%. */
export const TEXT_DONE = "#FFFFFF66";
export const TEXT_IDLE = "#FFFFFFFF";
/** A toggle's count of open tasks. */
export const COUNT_COLOR = "#FFFFFF80";
/** The marks of what has no plate: pages, databases, toggles, and the chevron of what opens. */
export const MARK_COLOR = "#8C8B85";
/**
 * A line without a plate that is not focused sticks out at the screen's edge
 * in grey, as the APPS menu's neighbours do (#666666 there): it says there is
 * more without drawing the eye.
 */
export const TEXT_EDGE = "#FFFFFF66";
export const MARK_EDGE = "#5F5E58";
/** The chevron at the right of a page or a database: 3x5, 1 px in from the screen's edge. */
export const CHEVRON_X = SCREEN_W - 4;
export const CHEVRON_INSET_Y = 2;

/** The dot that marks a list Notion could not confirm on the last read. */
export const STALE_COLOR = "#FF8A3DFF";

export const MESSAGE_COLOR = "#FFFFFFFF";
export const MESSAGE_DIM_COLOR = "#FFFFFF99";

/** Where the list starts: the screen's left edge, or 2 px right of the icon. */
export function listX(logo: boolean): number {
  return logo ? 10 : 0;
}

/**
 * The characters the bar's `small` font has, as from-to code pairs, read from
 * the firmware's `assets/shared/fonts/ttf/busy_regular_5px.ttf`. The metrics in
 * busy-lib list more (for instance No. sign), but the bar draws those as a box.
 */
const GLYPHS = [32, 95, 97, 126, 160, 161, 163, 163, 165, 167, 169, 169, 171, 171, 174, 174, 176, 179, 182, 183, 185, 185, 187, 187,
  191, 191, 215, 215, 247, 247, 1025, 1025, 1040, 1103, 1105, 1105, 8202, 8202, 8211, 8212, 8216, 8218, 8220, 8222, 8224, 8226,
  8230, 8230, 8249, 8250, 8287, 8287, 8304, 8304, 8308, 8313, 8320, 8329, 8364, 8364, 8381, 8381, 8482, 8482, 8592, 8601, 8721,
  8722, 8730, 8730, 8734, 8734, 8776, 8776, 8800, 8800, 8804, 8805, 9654, 9654, 9664, 9664, 65295, 65295];

export function hasGlyph(code: number): boolean {
  for (let i = 0; i < GLYPHS.length; i += 2) if (code >= GLYPHS[i] && code <= GLYPHS[i + 1]) return true;
  return false;
}

/** Stand-ins for characters the font lacks that people put in titles. Anything else missing, emoji included, is left out. */
const STANDINS: Record<string, string> = {
  "\u2116": "No", "`": "'", "\u00e9": "e", "\u00e8": "e", "\u00ea": "e", "\u00eb": "e", "\u00e0": "a", "\u00e1": "a", "\u00e2": "a",
  "\u00e4": "a", "\u00f6": "o", "\u00f3": "o", "\u00f4": "o", "\u00fc": "u", "\u00fa": "u", "\u00f1": "n", "\u00e7": "c", "\u00df": "ss",
  "\u00ed": "i", "\u00c9": "E", "\u00d6": "O", "\u00dc": "U", "\u00c4": "A",
};

/** `text` as the bar can draw it: missing characters replaced or left out. */
export function printable(text: string): string {
  let out = "";
  for (const ch of text) out += hasGlyph(ch.codePointAt(0) ?? 0) ? ch : (STANDINS[ch] ?? "");
  return out.replace(/\s+/g, " ").trim();
}

/** Width of `text` in the app's font, in pixels. */
export function textWidth(text: string): number {
  return measure(text, FONT);
}
