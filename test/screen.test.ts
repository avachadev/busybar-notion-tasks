import assert from "node:assert/strict";
import { test } from "node:test";

import { printable, textWidth } from "../src/layout.ts";
import { fit, listFrame, messageFrame, placeLines, scrollbar } from "../src/screen.ts";
import type { Entry } from "../src/tasks.ts";

const todo = (id: string, title: string): Entry => ({ kind: "todo", id, title });
type El = Record<string, unknown> & { fill_colors: string[] };
const byId = (els: unknown[]) => Object.fromEntries((els as El[]).map((e) => [e.id, e])) as Record<string, El>;

test("text widths match the device", () => {
  // Measured on the bar: "CPU 92%" is 29 px of ink in `small`; the advance adds the trailing 1 px gap.
  assert.equal(textWidth("CPU 92%"), 30);
});

test("without the logo the list takes the whole screen", () => {
  const els = byId(listFrame([todo("a", "One"), todo("b", "Two"), todo("c", "Three")], 1, new Set()));
  assert.equal(els.icon, undefined);
  assert.equal(els.row1.x, 0);
  assert.equal(els.row1.type, "rectangle");
  // The plate stops 1 px short of the scrollbar in the last column.
  assert.equal(els.row1.width, 70);
  assert.equal(els.mark1.x, 1);
  assert.equal(els.text1.x, 10);
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
  assert.equal(els.mark1.y, 4);
  assert.equal(els.mark1.x, 11);
  assert.equal(els.text1.x, 20);
});

test("the first entry has nothing above it", () => {
  const ids = listFrame([todo("a", "One"), todo("b", "Two")], 0, new Set()).map((e) => e.id);
  assert.ok(!ids.includes("row0"));
  assert.ok(ids.includes("row1") && ids.includes("row2"));
});

test("a ticked task gets the highlighted row, the blue checkbox and faded text", () => {
  const els = byId(listFrame([todo("a", "One"), todo("b", "Two")], 0, new Set(["a"]), true));
  assert.equal(els.row1.fill_colors[0], "#1B2027FF");
  assert.equal(els.row1.width, 60);
  assert.match(String(els.mark1.data), /#2883DF/);
  assert.equal(els.text1.color, "#FFFFFF66");
  assert.equal(els.row2.fill_colors[0], "#161616FF");
  assert.equal(els.text2.color, "#FFFFFFFF");
});

test("only the focused line scrolls", () => {
  const long = "A very long task title that does not fit on the bar";
  const els = byId(listFrame([todo("a", long), todo("b", long)], 0, new Set()));
  assert.ok(els.text1.scroll_rate);
  assert.equal(els.text2.scroll_rate, undefined);
});

test("only tasks have a plate; pages and databases a mark and a chevron", () => {
  const els = byId(listFrame(
    [{ kind: "page", id: "p", title: "\u041e\u043a\u0442\u044f\u0431\u0440\u044c" }, { kind: "database", id: "d", title: "Tasks" }],
    0,
    new Set(["p"]),
  ));
  assert.equal(els.mark1.type, "xpmbitmap");
  assert.equal(els.mark2.type, "xpmbitmap");
  assert.equal(els.chevron1.x, 66);
  assert.equal(els.row1, undefined);
  assert.match(String(els.mark1.data), /####/);
  // The focused line scrolls short of the chevron.
  assert.equal(els.text1.x, 10);
});

test("a toggle shows its state and the count of open tasks in it", () => {
  const toggle: Entry = { kind: "toggle", id: "t", title: "Ideas", count: 3 };
  const closed = byId(listFrame([toggle], 0, new Set()));
  assert.match(String(closed.mark1.data), /  #    /);
  assert.equal(closed.count1.text, "3");
  assert.equal(closed.row1, undefined);
  const open = byId(listFrame([toggle], 0, new Set(), false, new Set(["t"])));
  assert.notEqual(open.mark1.data, closed.mark1.data);
  assert.equal(byId(listFrame([{ ...toggle, count: 0 }], 0, new Set())).count1, undefined);
});

test("nesting moves a line 3 px right per level, up to three; a heading is faded text alone", () => {
  const els = byId(listFrame([
    { kind: "heading", id: "h", title: "Week", depth: 0 },
    { kind: "todo", id: "a", title: "Deep", depth: 5 },
    { kind: "page", id: "p", title: "Notes", depth: 1 },
  ], 1, new Set()));
  assert.equal(els.text0.x, 1);
  assert.equal(els.text0.color, "#FFFFFF66");
  assert.equal(els.row1.x, 9);
  assert.equal(els.row1.width, 61);
  assert.equal(els.mark1.x, 10);
  assert.equal(els.mark2.x, 4);
});

test("lines that are not focused are cut to their room", () => {
  const long = "A page with a title much too long for the bar";
  const els = byId(listFrame([todo("a", "One"), { kind: "page", id: "p", title: long }], 0, new Set()));
  assert.ok(textWidth(String(els.text2.text)) <= 68 - 2 - 10);
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

test("lines without a plate go grey away from the focus, as in the APPS menu", () => {
  const page = (id: string): Entry => ({ kind: "page", id, title: id });
  const els = byId(listFrame([page("a"), page("b"), todo("c", "C")], 1, new Set()));
  assert.equal(els.text1.color, "#FFFFFFFF");
  assert.equal(els.text0.color, "#FFFFFF66");
  assert.match(String(els.mark0.data), /#5F5E58/);
  assert.match(String(els.chevron0.data), /#5F5E58/);
  assert.match(String(els.mark1.data), /#8C8B85/);
  // A task keeps its look wherever it is.
  assert.equal(els.text2.color, "#FFFFFFFF");
});

test("the same inputs give back the same element, so a frame is compared without serialising it", () => {
  const list = [todo("a", "One"), todo("b", "Two")];
  const first = listFrame(list, 0, new Set());
  const again = listFrame(list, 0, new Set());
  assert.equal(first.length, again.length);
  first.forEach((e, i) => assert.equal(e, again[i]));
  const ticked = byId(listFrame(list, 0, new Set(["a"])));
  assert.notEqual(ticked.row1, byId(first).row1);
  assert.equal(ticked.text2, byId(first).text2);
});

test("a title the font cannot draw at all shows as Untitled", () => {
  const els = byId(listFrame([todo("a", "\ud83d\ude00\ud83d\ude80")], 0, new Set()));
  assert.equal(els.text1.text, "Untitled");
});

const row = (id: string, title: string, tag: string, color: string): Entry => ({ kind: "row", id, title, done: false, tag, color });

test("a row with a status fills the screen: title above, its status as a tag below", () => {
  const rows = [row("a", "Ship", "Todo", "gray"), row("b", "Call the bank", "Doing", "blue"), row("c", "Rest", "Todo", "gray")];
  assert.deepEqual(placeLines(rows, 1), [{ offset: 0, y: 0 }]);
  const els = byId(listFrame(rows, 1, new Set()));
  assert.equal(els.row1.height, 16);
  assert.equal(els.text1.x, 4);
  assert.equal(els.text1.text, "Call the bank");
  assert.equal(els.chevron1.type, "xpmbitmap");
  assert.equal(els.tagtext1.text, "Doing");
  assert.equal(els.tag1.x, 3);
  assert.equal(els.tag1.y, 8);
  assert.equal(els.row0, undefined);
  assert.equal(els.row2, undefined);
});

test("pointing dims all but its part; choosing moves the tag between two arrows", () => {
  const rows = [row("b", "Call", "Doing", "blue")];
  const list = byId(listFrame(rows, 0, new Set()));
  const title = byId(listFrame(rows, 0, new Set(), false, new Set(), { mode: "title" }));
  assert.ok(title.go1);
  assert.equal(title.text1.color, list.text1.color);
  assert.notEqual(title.tag1.fill_colors[0], list.tag1.fill_colors[0]);
  const mark = byId(listFrame(rows, 0, new Set(), false, new Set(), { mode: "mark" }));
  assert.equal(mark.go1, undefined);
  assert.equal(mark.text1.color, "#FFFFFF66");
  assert.equal(mark.tag1.fill_colors[0], list.tag1.fill_colors[0]);
  const pick = byId(listFrame(rows, 0, new Set(), false, new Set(), { mode: "pick", tag: { name: "Done", color: "green" } }));
  assert.equal(pick.tagtext1.text, "Done");
  assert.equal(pick.tag1.x, 7);
  assert.equal(pick.arrowl1.x, 3);
  assert.ok(pick.arrowr1);
});

test("a to-do that links a page has a chevron and two parts; one that does not has neither", () => {
  const linked: Entry = { kind: "todo", id: "a", title: "Brief", link: "x" };
  const els = byId(listFrame([linked], 0, new Set()));
  assert.ok(els.chevron1);
  assert.equal(byId(listFrame([todo("b", "Plain")], 0, new Set())).chevron1, undefined);
  const onBox = byId(listFrame([linked], 0, new Set(), false, new Set(), { mode: "mark" }));
  assert.match(String(onBox.mark1.data), /#FFFFFF/);
  assert.equal(onBox.text1.color, "#FFFFFF66");
  const onTitle = byId(listFrame([linked], 0, new Set(), false, new Set(), { mode: "title" }));
  assert.ok(onTitle.go1);
  assert.equal(onTitle.text1.color, "#FFFFFFFF");
});

test("the scrollbar is the firmware's: 1 px on the right, the thumb moving from the first focusable line to the last", () => {
  const lines: Entry[] = [{ kind: "heading", id: "h", title: "Week" }, ...Array.from({ length: 10 }, (_, i) => todo(`t${i}`, `Task ${i}`))];
  const at = (i: number) => byId(scrollbar(lines, i));
  assert.equal(at(1).scrolltrack.x, 71);
  assert.equal(at(1).scrolltrack.height, 16);
  assert.equal(at(1).scrolltrack.fill_colors[0], "#313131FF");
  assert.equal(at(1).scrollthumb.height, 3);
  assert.equal(at(1).scrollthumb.y, 0);
  assert.equal(at(10).scrollthumb.y, 13);
  assert.equal(at(6).scrollthumb.y, 7);
  assert.deepEqual(scrollbar([todo("a", "Only")], 0), []);
  assert.equal(byId(scrollbar([todo("a", "A"), todo("b", "B")], 0)).scrollthumb.height, 8);
  // In the frame too, and the list ends at x 70.
  const frame = byId(listFrame(lines, 3, new Set()));
  assert.ok(frame.scrollthumb);
});
