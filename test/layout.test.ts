import assert from "node:assert/strict";
import { test } from "node:test";

import { textWidth as measure } from "@busy-app/busy-lib";

import { FONT, fitLength, textWidth } from "../src/layout.ts";

const SAMPLES = ["", "a", "Ship the release", "Сверстать лендинг", "«Ёлка» — 2026…", "Mixed Ёж and Q4 (draft) #12", "😀 Party"];

test("a text's width is busy-lib's, a character at a time", () => {
  for (const s of SAMPLES) assert.equal(textWidth(s), measure(s, FONT), s);
});

test("what fits is the longest start no wider than the room", () => {
  for (const s of SAMPLES) {
    for (const room of [0, 1, 5, 17, 40, 200]) {
      const n = fitLength(s, room);
      assert.ok(measure(s.substring(0, n), FONT) <= room, `${s} in ${room}`);
      if (n < s.length) assert.ok(measure(s.substring(0, n + (s.charCodeAt(n) >= 0xd800 && s.charCodeAt(n) <= 0xdbff ? 2 : 1)), FONT) > room, `${s} in ${room}: one more fits`);
    }
  }
});
