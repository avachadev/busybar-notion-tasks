import assert from "node:assert/strict";
import { test } from "node:test";

import { textWidth } from "../src/layout.ts";
import { listFrame, messageFrame } from "../src/screen.ts";
import type { Entry } from "../src/tasks.ts";

const todo = (id: string, title: string): Entry => ({ kind: "todo", id, title });
type El = Record<string, unknown>;
const byId = (els: unknown[]) => Object.fromEntries((els as El[]).map((e) => [e.id, e])) as Record<string, El>;

test("text widths match the device", () => {
  // Measured on the bar: "CPU 92%" is 29 px of ink in `small`; the advance adds the trailing 1 px gap.
  assert.equal(textWidth("CPU 92%"), 30);
});

test("the focused row sits in the middle, its neighbours at the edges", () => {
  const els = byId(listFrame([todo("a", "One"), todo("b", "Two"), todo("c", "Three")], 1, new Set()));
  assert.equal(els.icon.x, 0);
  assert.equal(els.icon.y, 4);
  assert.equal(els.row1.x, 10);
  assert.equal(els.row0.y, -7);
  assert.equal(els.row1.y, 3);
  assert.equal(els.row2.y, 13);
  assert.equal(els.box1.y, 4);
  assert.equal(els.box1.x, 11);
  assert.equal(els.text1.x, 21);
});

test("the first entry has nothing above it", () => {
  const ids = listFrame([todo("a", "One"), todo("b", "Two")], 0, new Set()).map((e) => e.id);
  assert.ok(!ids.includes("row0"));
  assert.ok(ids.includes("row1") && ids.includes("row2"));
});

test("a ticked task gets the highlighted row, the blue checkbox and white text", () => {
  const els = byId(listFrame([todo("a", "One"), todo("b", "Two")], 0, new Set(["a"])));
  assert.equal(els.row1.path, "images/row_done.png");
  assert.equal(els.box1.path, "images/checkbox_done.png");
  assert.equal(els.text1.color, "#FFFFFFFF");
  assert.equal(els.row2.path, "images/row_idle.png");
  assert.equal(els.text2.color, "#FFFFFF66");
});

test("only the focused line scrolls", () => {
  const long = "A very long task title that does not fit on the bar";
  const els = byId(listFrame([todo("a", long), todo("b", long)], 0, new Set()));
  assert.ok(els.text1.scroll_rate);
  assert.equal(els.text2.scroll_rate, undefined);
});

test("pages and databases get a mark instead of a checkbox, under ids of their own", () => {
  // The bar rejects a draw that changes an element's type under the same id.
  const els = byId(listFrame(
    [{ kind: "page", id: "p", title: "\u041e\u043a\u0442\u044f\u0431\u0440\u044c" }, { kind: "database", id: "d", title: "Tasks" }],
    0,
    new Set(["p"]),
  ));
  assert.equal(els.page1.type, "xpmbitmap");
  assert.equal(els.database2.type, "xpmbitmap");
  assert.equal(els.box1, undefined);
});

test("messages are two centred lines", () => {
  const els = byId(messageFrame("All done", "for today"));
  // The icon stays above the backdrop, so it is on every screen.
  assert.ok((els.icon.z_index as number) > (els.m_backdrop.z_index as number));
  assert.equal(els.m_title.x, 41);
  assert.equal(els.m_title.align, "top_mid");
  // An opaque backdrop above the list hides it the moment the message is drawn.
  assert.equal(els.m_backdrop.width, 72);
  assert.ok((els.m_backdrop.z_index as number) > 2 && (els.m_title.z_index as number) > (els.m_backdrop.z_index as number));
  assert.equal(els.m_detail.y, 7);
});
