import assert from "node:assert/strict";
import { test } from "node:test";

import { printable, textWidth } from "../src/layout.ts";
import { fit, listFrame, messageFrame, placeLines } from "../src/screen.ts";
import type { Entry } from "../src/tasks.ts";

const todo = (id: string, title: string): Entry => ({ kind: "todo", id, title });
type El = Record<string, unknown>;
const byId = (els: unknown[]) => Object.fromEntries((els as El[]).map((e) => [e.id, e])) as Record<string, El>;

test("text widths match the device", () => {
  // Measured on the bar: "CPU 92%" is 29 px of ink in `small`; the advance adds the trailing 1 px gap.
  assert.equal(textWidth("CPU 92%"), 30);
});

test("without the logo the list takes the whole screen", () => {
  const els = byId(listFrame([todo("a", "One"), todo("b", "Two"), todo("c", "Three")], 1, new Set()));
  assert.equal(els.icon, undefined);
  assert.equal(els.row1.x, 0);
  assert.equal(els.row1.path, "images/row_idle_72.png");
  assert.equal(els.box1.x, 1);
  assert.equal(els.text1.x, 11);
  const msg = byId(messageFrame("All done", "for today"));
  assert.equal(msg.icon, undefined);
  assert.equal(msg.m_title.x, 36);
});

test("with the logo the focused row sits in the middle beside the icon, its neighbours at the edges", () => {
  const els = byId(listFrame([todo("a", "One"), todo("b", "Two"), todo("c", "Three")], 1, new Set(), true));
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

test("a ticked task gets the highlighted row, the blue checkbox and faded text", () => {
  const els = byId(listFrame([todo("a", "One"), todo("b", "Two")], 0, new Set(["a"]), true));
  assert.equal(els.row1.path, "images/row_done_62.png");
  assert.equal(els.box1.path, "images/checkbox_done.png");
  assert.equal(els.text1.color, "#FFFFFF66");
  assert.equal(els.row2.path, "images/row_idle_62.png");
  assert.equal(els.text2.color, "#FFFFFFFF");
});

test("only the focused line scrolls", () => {
  const long = "A very long task title that does not fit on the bar";
  const els = byId(listFrame([todo("a", long), todo("b", long)], 0, new Set()));
  assert.ok(els.text1.scroll_rate);
  assert.equal(els.text2.scroll_rate, undefined);
});

test("only tasks have a plate; pages and databases a mark and a chevron, under ids of their own", () => {
  // The bar rejects a draw that changes an element's type under the same id.
  const els = byId(listFrame(
    [{ kind: "page", id: "p", title: "\u041e\u043a\u0442\u044f\u0431\u0440\u044c" }, { kind: "database", id: "d", title: "Tasks" }],
    0,
    new Set(["p"]),
  ));
  assert.equal(els.page1.type, "xpmbitmap");
  assert.equal(els.database2.type, "xpmbitmap");
  assert.equal(els.chevron1.x, 68);
  assert.equal(els.row1, undefined);
  assert.equal(els.box1, undefined);
  // The focused line scrolls short of the chevron.
  assert.equal(els.text1.x, 11);
});

test("a toggle shows its state and the count of open tasks in it", () => {
  const toggle: Entry = { kind: "toggle", id: "t", title: "Ideas", count: 3 };
  const closed = byId(listFrame([toggle], 0, new Set()));
  assert.match(String(closed.toggle1.data), /  #    /);
  assert.equal(closed.count1.text, "3");
  assert.equal(closed.row1, undefined);
  const open = byId(listFrame([toggle], 0, new Set(), false, new Set(["t"])));
  assert.notEqual(open.toggle1.data, closed.toggle1.data);
  assert.equal(byId(listFrame([{ ...toggle, count: 0 }], 0, new Set())).count1, undefined);
});

test("nesting moves a line 2 px right per level, up to three; a heading is faded text alone", () => {
  const els = byId(listFrame([
    { kind: "heading", id: "h", title: "Week", depth: 0 },
    { kind: "todo", id: "a", title: "Deep", depth: 5 },
    { kind: "page", id: "p", title: "Notes", depth: 1 },
  ], 1, new Set()));
  assert.equal(els.text0.x, 1);
  assert.equal(els.text0.color, "#FFFFFF80");
  assert.equal(els.row1.x, 6);
  assert.equal(els.row1.path, "images/row_idle_66.png");
  assert.equal(els.box1.x, 7);
  assert.equal(els.page2.x, 3);
});

test("lines that are not focused are cut to their room", () => {
  const long = "A page with a title much too long for the bar";
  const els = byId(listFrame([todo("a", "One"), { kind: "page", id: "p", title: long }], 0, new Set()));
  assert.ok(textWidth(String(els.text2.text)) <= 68 - 2 - 11);
  assert.equal(fit("Short", 60), "Short");
});

test("messages are two centred lines", () => {
  const els = byId(messageFrame("All done", "for today", true));
  // The icon stays above the backdrop, so it is on every screen.
  assert.ok((els.icon.z_index as number) > (els.m_backdrop.z_index as number));
  assert.equal(els.m_title.x, 41);
  assert.equal(els.m_title.align, "top_mid");
  // An opaque backdrop above the list hides it the moment the message is drawn.
  assert.equal(els.m_backdrop.width, 72);
  assert.ok((els.m_backdrop.z_index as number) > 2 && (els.m_title.z_index as number) > (els.m_backdrop.z_index as number));
  assert.equal(els.m_detail.y, 7);
});

test("characters the bar's font lacks are replaced or left out", () => {
  assert.equal(printable("\u0414\u0435\u043b\u0430 \u2116 1"), "\u0414\u0435\u043b\u0430 No 1");
  assert.equal(printable("\ud83d\ude80 Launch \u2705"), "Launch");
  assert.equal(printable("Caf\u00e9 \u2014 \u00ab\u0451\u00bb"), "Cafe \u2014 \u00ab\u0451\u00bb");
});

test("lines stack by their height: a plate is 9 px, a line without one 7, 1 px apart", () => {
  const page = (id: string): Entry => ({ kind: "page", id, title: id });
  // Tasks: as before, 10 px apart.
  assert.deepEqual(placeLines([todo("a", "A"), todo("b", "B"), todo("c", "C")], 1), [
    { offset: 0, y: 3 }, { offset: -1, y: -7 }, { offset: 1, y: 13 },
  ]);
  // Pages only: 8 px apart, so more of the neighbours shows.
  assert.deepEqual(placeLines([page("a"), page("b"), page("c")], 1), [
    { offset: 0, y: 3 }, { offset: -1, y: -5 }, { offset: 1, y: 11 },
  ]);
  // Mixed: a page under a task, 9 px.
  assert.deepEqual(placeLines([todo("a", "A"), page("b")], 0), [{ offset: 0, y: 3 }, { offset: 1, y: 12 }]);
});
