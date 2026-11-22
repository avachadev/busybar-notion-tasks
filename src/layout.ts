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

/**
 * The scrollbar the firmware's menus draw (APPS, measured on 1.4.1): 1 px in
 * the rightmost column, the track white at 20% (#313131 on the bar), the thumb
 * white, 16/n px tall and at least 3. The list stops 1 px short of it: plates,
 * chevrons and counts end at LIST_RIGHT.
 */
export const SCROLL_X = SCREEN_W - 1;
export const SCROLL_TRACK = "#313131FF";
export const SCROLL_THUMB = "#FFFFFFFF";
export const SCROLL_MIN = 3;
export const LIST_RIGHT = SCREEN_W - 2;

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

/** The logo, packaged under src/images: drawn once, so a file is fine. */
export const IMAGES = {
  icon: "images/notion_icon.png",
};

/** Each level of nesting moves a line this far right; deeper than MAX_DEPTH stays there. */
export const INDENT = 3;
export const MAX_DEPTH = 3;

/**
 * A task's plate, from where the line starts to the screen's right edge: a
 * rectangle, not a picture. The bar reads a picture's file on every draw
 * (measured: three plates 56 ms as PNGs, 19 ms as rectangles, spikes to 310 ms);
 * a rectangle with a 1 px border and radius 2 matches the design's PNG to a few
 * levels in the corners.
 */
export const PLATE = {
  idle: { fill: "#161616FF", border: "#202020FF" },
  done: { fill: "#1B2027FF", border: "#20262FFF" },
  radius: 2,
};

/** The checkboxes from the design, pixel for pixel, as XPM: drawn from the request, no file. */
export const CHECKBOX_XPM = {
  idle: "! XPM2\n7 7 10 1\na c #60605A\nb c #5F5F59\nc c #5F5E58\nd c #2A2927\ne c #000000\nf c #2A2A26\ng c #5F5E59\nh c #292927\n" +
    "i c #5F5F58\nj c #605F57\nabcccca\ncdeeefg\nceeeeec\nceeeeec\nceeeeec\nbdeeehi\naicccja",
  done: "! XPM2\n7 7 16 1\na c #2B85DF\nb c #2983DF\nc c #2883DF\nd c #2884DF\ne c #78B2EB\nf c #ACD0F3\ng c #FFFFFF\nh c #79B2EB\n" +
    "i c #4393E3\nj c #C9E0F7\nk c #358BE1\nl c #A1C9F1\nm c #F2F7FD\nn c #2984DF\no c #86B9ED\np c #2784DF\n" +
    "abcccda\ndccccef\nccccegh\nijieghc\nklmghcc\nncohccd\nadcccpa",
};

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
export const CHEVRON_X = LIST_RIGHT - 4;
export const CHEVRON_INSET_Y = 2;

/**
 * A row with a status takes the whole screen in two lines: the title at
 * TAG_TITLE_X on the top line, the status as a tag on the bottom one (Figma,
 * "Вариант I"). The tag is a rectangle 7 px tall with the option's name 2 px in.
 */
export const TAG_TITLE_X = 5;
export const TAG_X = 3;
/**
 * Pointing at a row's title or its status, the firmware's cursor `▶` (2x3)
 * stands against the plate's left edge, its tip 2 px before the text: before
 * the title, and before the tag's text, the tag's own inset being those 2 px.
 * Choosing the status, the firmware's `‹` takes its place and `›` follows the
 * tag 1 px after it, as the value of a setting in SETTINGS.
 */
export const POINTER_X = 1;
export const TAG_TOP = 8;
export const TAG_H = 7;
export const TAG_TEXT_Y = 7;

/** Notion's colour names, as the bar shows them. */
const NOTION_COLORS: Record<string, string> = {
  default: "8C8B85", gray: "8C8B85", brown: "A47148", orange: "E0832E", yellow: "D9A63A",
  green: "3FA66B", blue: "2B85DF", purple: "9A6DD7", pink: "D15796", red: "E5534B",
};

function channels(hex: string): number[] {
  return [0, 2, 4].map((i) => parseInt(hex.substring(i, i + 2), 16));
}

function hexOf(rgb: number[]): string {
  return rgb.map((v) => {
    const h = Math.round(Math.max(0, Math.min(255, v))).toString(16).toUpperCase();
    return h.length < 2 ? `0${h}` : h;
  }).join("");
}

/** A tag's fill and its text: the colour darkened under, lightened on top, as Notion's tags are. */
export function tagLook(color: string): { fill: string; ink: string } {
  const rgb = channels(NOTION_COLORS[color] ?? NOTION_COLORS.default);
  return { fill: `#${hexOf(rgb.map((v) => v * 0.32))}FF`, ink: `#${hexOf(rgb.map((v) => v * 0.8 + 255 * 0.2))}FF` };
}

/**
 * Hover and choosing dim everything but what is pointed at to 40%. A colour
 * with alpha keeps its RGB and loses alpha; an opaque one is darkened, as it
 * would look over black.
 */
export const DIM = 0.4;
export function dim(color: string): string {
  const hex = color.replace("#", "");
  if (hex.length === 8) {
    const a = Math.round(parseInt(hex.substring(6, 8), 16) * DIM);
    return `#${hex.substring(0, 6)}${hexOf([a, 0, 0]).substring(0, 2)}`;
  }
  return `#${hexOf(channels(hex).map((v) => v * DIM))}`;
}

/**
 * The top of a view being opened, after the mockup approved on the bar
 * (22.11): the title on the top line, its letters on rows 1..5
 * (anchored at -1), from the list's text x; at its left, where the mark goes,
 * the firmware's own spinner while the view is read (8x8, from `stock_path`,
 * at y 1), or the view's mark once it is known (y 0, centred on the letters
 * as in the list). While reading, the title is drawn white under `load_dim`,
 * which greys it and lets a shimmer through, and `load_bars` stands in for the
 * lines to come (`tools/skeleton.py`); both play by themselves. Once read, the
 * line under the title says what the view holds.
 */
export const TOP_TITLE_Y = -1;
export const SPINNER = "animations/spinner_front_8x8.anim";
export const SPINNER_Y = 1;
/**
 * Opened from a line of one row, the loading screen keeps that line where it
 * was (FOCUS_Y) and puts the spinner in its mark's place, centred on the
 * screen: rows 4..11. The two-line skeleton is for what opens from a row with
 * a status, whose title was on top already, and for the app's start.
 */
export const SPINNER_INLINE_Y = 4;
export const LOAD_DIM = "animations/load_dim.anim";
export const LOAD_DIM_Y = 0;
export const LOAD_BARS = "animations/load_bars.anim";
export const LOAD_BARS_Y = 8;
/**
 * The preview of a view read before stands where a row with a status stands,
 * which is what it is most often opened from: the title's letters on rows
 * 2..6, the line under it where the status's tag text is (rows 9..13), the mark
 * centred on the title as in the list. Nothing jumps when the row opens.
 */
export const PREVIEW_TITLE_Y = 0;
export const PREVIEW_MARK_Y = 1;
export const PREVIEW_DETAIL_Y = TAG_TEXT_Y;

/** The dot that marks a list Notion could not confirm on the last read. */
export const STALE_COLOR = "#FF8A3DFF";

export const MESSAGE_COLOR = "#FFFFFFFF";

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

/** Characters the font surely has: printable ASCII but the backtick, and Russian. */
const PLAIN = /^[\x20-\x5f\x61-\x7e\u0401\u0410-\u044f\u0451]*$/;

/** `text` as the bar can draw it: missing characters replaced or left out. */
export function printable(text: string): string {
  // Most titles are plain: one test instead of a lookup per character, which costs on the bar.
  if (PLAIN.test(text)) return text.replace(/\s+/g, " ").trim();
  let out = "";
  for (const ch of text) out += hasGlyph(ch.codePointAt(0) ?? 0) ? ch : (STANDINS[ch] ?? "");
  return out.replace(/\s+/g, " ").trim();
}

/** Width of `text` in the app's font, in pixels. */
export function textWidth(text: string): number {
  return measure(text, FONT);
}
