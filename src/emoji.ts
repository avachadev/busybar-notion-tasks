/**
 * A page's emoji icon as the app's 7x7 picture of it (`tools/emoji.py`, from
 * Twemoji, graphics CC-BY 4.0): a section of one frame in one of FOLDERS
 * animation packs, which the firmware plays by name.
 *
 * The section is named as Twemoji names the file: the code points in hex
 * joined by "-", U+FE0F dropped unless the sequence has a U+200D; its pack is
 * the name's 32-bit FNV-1a modulo FOLDERS, as the tool sorts them.
 */

const FOLDERS = 64;
const ZWJ = "\u200d";
const VS16 = 0xfe0f;

/** Twemoji's file name for an emoji, without ".png". */
export function emojiName(emoji: string): string {
  const keepVs16 = emoji.indexOf(ZWJ) >= 0;
  const parts: string[] = [];
  for (let i = 0; i < emoji.length; i += 1) {
    const c = emoji.charCodeAt(i);
    let cp = c;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < emoji.length) {
      const d = emoji.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i += 1;
      }
    }
    if (cp === VS16 && !keepVs16) continue;
    parts.push(cp.toString(16));
  }
  return parts.join("-");
}

function folder(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const f = (h % FOLDERS).toString(16);
  return f.length < 2 ? `0${f}` : f;
}

/** The animation pack and the section that draw an emoji; null for what is not one. */
export function emojiIcon(emoji: string): { readonly file: string; readonly section: string } | null {
  if (!emoji) return null;
  const name = emojiName(emoji);
  // Flat among the app's animations: the build drops folders.
  return name ? { file: `animations/e_${folder(name)}.anim`, section: name } : null;
}
