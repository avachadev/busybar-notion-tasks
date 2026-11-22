import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { emojiIcon, emojiName } from "../src/emoji.ts";

test("an emoji's file is named as Twemoji names it", () => {
  assert.equal(emojiName("\u{1f604}"), "1f604");
  // U+FE0F goes, unless the sequence is joined with U+200D.
  assert.equal(emojiName("❤️"), "2764");
  assert.equal(emojiName("\u{1f3f3}️‍\u{1f308}"), "1f3f3-fe0f-200d-1f308");
  assert.equal(emojiName("\u{1f44d}\u{1f3fd}"), "1f44d-1f3fd");
  assert.equal(emojiIcon(""), null);
});

test("every emoji tried has its pack among the app's files, and its section in that pack", () => {
  for (const e of ["\u{1f604}", "\u2764\ufe0f", "\u2705", "\u{1f4da}", "\u{1f3e0}", "\u{1f3f3}\ufe0f\u200d\u{1f308}", "\u{1f44d}\u{1f3fd}", "\u{1f1f7}\u{1f1fa}", "#\ufe0f\u20e3"]) {
    const icon = emojiIcon(e)!;
    const path = `src/${icon.file}`;
    assert.ok(existsSync(path), `${e} -> ${path}`);
    // A section's name is in the pack's section table as plain text.
    assert.ok(readFileSync(path).includes(Buffer.from(`${icon.section}\0`)), `${e} -> ${icon.section} in ${icon.file}`);
  }
});
