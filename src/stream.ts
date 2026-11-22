/**
 * Cuts Notion's page-markdown answer into lines while it arrives, without
 * holding the answer or decoding most of it.
 *
 * The answer is JSON, `{"object":"page_markdown",...,"markdown":"...",...}`,
 * and a page of notes can make it hundreds of kilobytes, while the app's whole
 * heap was 256 KiB (now 384): a 43 KB answer read whole ran it out and the bar restarted.
 * The bar's JavaScript has no TextDecoder, and a loop over bytes costs about
 * 20 us a byte, so the bytes are searched with the native `indexOf`, a line
 * ends at a JSON `\n`, and only the lines the reader keeps are decoded, UTF-8
 * and JSON escapes together.
 */

import type { Line } from "./markdown.ts";

const BACKSLASH = 0x5c;
const QUOTE = 0x22;
const SPACE = 0x20;
/** `"markdown":"`, as bytes. */
const FIELD = [0x22, 0x6d, 0x61, 0x72, 0x6b, 0x64, 0x6f, 0x77, 0x6e, 0x22, 0x3a, 0x22];
/** How much of a line's ASCII start tells what the line is. */
const HEAD_BYTES = 12;
/** A line longer than this is cut: a title is short, and the rest is never shown. */
const MAX_LINE_BYTES = 640;

/** Plain ASCII without escapes: then the bytes are the characters, and one native call makes the string. */
function plainAscii(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i += 1) if (bytes[i] >= 0x80 || bytes[i] === BACKSLASH) return false;
  return true;
}

/**
 * Decodes UTF-8 bytes holding a JSON string's inside: its escapes are undone
 * too. Measured on the bar: this loop costs about 54 us a byte, a native
 * `String.fromCharCode.apply` about 11, so ASCII goes the native way.
 */
export function decode(bytes: Uint8Array, from: number, to: number): string {
  if (plainAscii(bytes, from, to)) return String.fromCharCode.apply(null, bytes.subarray(from, to) as unknown as number[]);
  const codes: number[] = [];
  let i = from;
  while (i < to) {
    const b = bytes[i];
    if (b === BACKSLASH && i + 1 < to) {
      const e = bytes[i + 1];
      i += 2;
      if (e === 0x6e) codes.push(10);
      else if (e === 0x74) codes.push(9);
      else if (e === 0x72) codes.push(13);
      else if (e === 0x62) codes.push(8);
      else if (e === 0x66) codes.push(12);
      else if (e === 0x75 && i + 4 <= to) {
        let v = 0;
        for (let k = 0; k < 4; k += 1) v = v * 16 + parseInt(String.fromCharCode(bytes[i + k]), 16);
        codes.push(v);
        i += 4;
      } else codes.push(e);
    } else if (b < 0x80) {
      codes.push(b);
      i += 1;
    } else if (b >= 0xf0 && i + 3 < to) {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      codes.push(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff));
      i += 4;
    } else if (b >= 0xe0 && i + 2 < to) {
      codes.push(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    } else if (b >= 0xc0 && i + 1 < to) {
      codes.push(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else {
      // A sequence cut by the line's end: dropped.
      i += 1;
    }
  }
  return String.fromCharCode.apply(null, codes);
}

/** A line of the answer, as bytes: its indent and ASCII start cheaply, its text when asked. */
class RawLine implements Line {
  readonly indent: number;
  readonly blank: boolean;
  readonly head: string;
  private readonly bytes: Uint8Array;
  private readonly start: number;
  private readonly to: number;
  private decoded: string | null = null;

  constructor(bytes: Uint8Array, from: number, to: number) {
    let i = from;
    let indent = 0;
    while (i < to) {
      if (bytes[i] === SPACE) {
        indent += 1;
        i += 1;
      } else if (bytes[i] === BACKSLASH && bytes[i + 1] === 0x74) {
        indent += 2;
        i += 2;
      } else break;
    }
    this.bytes = bytes;
    this.start = i;
    this.to = to;
    this.indent = indent;
    this.blank = i >= to;
    // The head only tells what the line is, by its ASCII start: no decoding.
    let n = i;
    while (n < to && n < i + HEAD_BYTES && bytes[n] < 0x80 && bytes[n] !== BACKSLASH) n += 1;
    this.head = n > i ? String.fromCharCode.apply(null, bytes.subarray(i, n) as unknown as number[]) : "";
  }

  text(): string {
    if (this.decoded === null) this.decoded = decode(this.bytes, this.start, this.to);
    return this.decoded;
  }
}

/** An empty line, shared: every other line of Notion's markdown is one. */
const EMPTY: Line = { indent: 0, blank: true, head: "", text: () => "" };

function rawLine(bytes: Uint8Array, from: number, to: number): Line {
  return from >= to ? EMPTY : new RawLine(bytes, from, to);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Where `needle` starts in `hay` at or after `from`, or -1. */
function find(hay: Uint8Array, needle: readonly number[], from: number): number {
  for (let i = hay.indexOf(needle[0], from); i >= 0 && i + needle.length <= hay.length; i = hay.indexOf(needle[0], i + 1)) {
    let k = 1;
    while (k < needle.length && hay[i + k] === needle[k]) k += 1;
    if (k === needle.length) return i;
  }
  return -1;
}

/**
 * Takes the answer's bytes chunk by chunk and hands each line of its
 * `markdown` field to `onLine`, which says whether more is wanted.
 */
export class MarkdownLines {
  /** Bytes not yet handed on: the start of the current line, or the answer before the field. */
  private carry: Uint8Array = new Uint8Array(0);
  private inField = false;
  private done = false;
  private readonly onLine: (line: Line) => boolean;

  constructor(onLine: (line: Line) => boolean) {
    this.onLine = onLine;
  }

  /** Takes the next chunk; false once nothing more is wanted. */
  feed(chunk: Uint8Array): boolean {
    if (this.done) return false;
    let data = concat(this.carry, chunk);
    if (!this.inField) {
      const at = find(data, FIELD, 0);
      if (at < 0) {
        // The field's name may straddle chunks: keep its length's worth.
        this.carry = data.subarray(Math.max(0, data.length - FIELD.length));
        return true;
      }
      this.inField = true;
      data = data.subarray(at + FIELD.length);
    }
    let start = 0;
    let at = 0;
    // Searched for once a chunk and again only once passed: quotes are rare, and each search runs to the chunk's end.
    let quote = data.indexOf(QUOTE, 0);
    for (;;) {
      const slash = data.indexOf(BACKSLASH, at);
      if (quote >= 0 && quote < at) quote = data.indexOf(QUOTE, at);
      if (quote >= 0 && (slash < 0 || quote < slash)) {
        // The field's closing quote: escaped ones are skipped below.
        this.emit(data, start, quote);
        this.done = true;
        return false;
      }
      if (slash < 0 || slash + 1 >= data.length || (data[slash + 1] === 0x75 && slash + 6 > data.length)) {
        // The rest of the line, an escape cut by the chunk's end included, waits for the next chunk.
        this.keep(data, start, slash >= 0 ? slash : data.length);
        return true;
      }
      if (data[slash + 1] === 0x6e) {
        if (!this.emit(data, start, slash)) {
          this.done = true;
          return false;
        }
        start = slash + 2;
        at = start;
      } else {
        at = slash + (data[slash + 1] === 0x75 ? 6 : 2);
      }
    }
  }

  /**
   * Keeps the current line's bytes for the next chunk. Once the line is longer
   * than MAX_LINE_BYTES only its start is kept, with the bytes from where the
   * search stopped, and the middle is dropped.
   */
  private keep(data: Uint8Array, start: number, tail: number): void {
    if (tail - start > MAX_LINE_BYTES) {
      // The kept start must not end inside an escape, or it would pair with the next chunk's bytes.
      let size = MAX_LINE_BYTES;
      while (size > 0 && data[start + size - 1] === BACKSLASH) size -= 1;
      const head = data.subarray(start, start + size);
      this.carry = concat(head.slice(), data.subarray(tail).slice());
    } else {
      this.carry = data.subarray(start).slice();
    }
  }

  private emit(data: Uint8Array, start: number, end: number): boolean {
    const to = Math.min(end, start + MAX_LINE_BYTES);
    this.carry = new Uint8Array(0);
    return this.onLine(rawLine(data, start, to));
  }

  /** The answer ended: hands on a last line left without its closing quote. */
  end(): void {
    if (!this.done && this.inField && this.carry.length > 0) this.onLine(rawLine(this.carry, 0, this.carry.length));
    this.done = true;
  }
}
