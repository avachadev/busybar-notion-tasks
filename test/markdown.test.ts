import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_ENTRIES, entriesFromMarkdown, inlineText, linkOf, sameText, shownEntries } from "../src/markdown.ts";

/** What Notion's markdown (version 2) returns for a page with to-dos in every kind of container. */
const PAGE = [
  "Top task list:",
  "",
  "- [ ] Plain task",
  "- [x] Done plain task",
  "- [ ] Parent task",
  "  - [ ] Child task",
  "- [ ] Task with <b>bold</b> and [link](https://example.com) and <code>code</code>",
  "- [ ] Same title",
  "- [ ] Same title",
  "- [ ] ",
  "",
  "<toggle>",
  "Real toggle",
  "",
  "- [ ] Task in toggle",
  "</toggle>",
  "",
  "<columns>",
  "<column>",
  "- [ ] Task in left column",
  "</column>",
  "</columns>",
  "",
  "<page url=\"https://app.notion.com/p/8d45f9b4f53e53fe952da63631fc0ee6\">",
  "2025",
  "</page>",
  "",
  "<database url=\"https://app.notion.com/p/17b05673fbc85f05c602727220eca013\" data-source-url=\"collection://5451a510-ece3-ae13-a39d-5095b58c11eb\" inline=\"true\">",
  "Select tasks",
  "</database>",
  "",
  "<synced-block url=\"https://app.notion.com/p/4ff93c87f7a82827972940696cf62856#9ddc4dfdb8eb6c2aaca98c8284c5b5a8\">",
  "- [x] Task in synced block",
  "</synced-block>",
  "",
  "```",
  "- [ ] not a task, code",
  "```",
  "- [ ] Due <mention-date start=\"2026-11-21\"/> \\*sharp\\* &amp; fast",
].join("\n");

test("a page's to-dos come out from every container, with pages, databases and toggles in place", () => {
  const entries = entriesFromMarkdown("P", PAGE);
  assert.deepEqual(entries.map((e) => [e.kind, e.title, e.done ?? null, e.index ?? null, e.depth]), [
    ["todo", "Plain task", false, 0, 0],
    ["todo", "Done plain task", true, 1, 0],
    ["todo", "Parent task", false, 2, 0],
    ["todo", "Child task", false, 3, 1],
    ["todo", "Task with bold and link and code", false, 4, 0],
    ["todo", "Same title", false, 5, 0],
    ["todo", "Same title", false, 6, 0],
    // The empty to-do at 7 is not shown, but counts.
    ["toggle", "Real toggle", null, null, 0],
    ["todo", "Task in toggle", false, 8, 1],
    ["todo", "Task in left column", false, 9, 0],
    ["page", "2025", null, null, 0],
    ["database", "Select tasks", null, null, 0],
    ["todo", "Task in synced block", true, 10, 0],
    ["todo", "Due 2026-11-21 *sharp* & fast", false, 11, 0],
  ]);
  const page = entries.find((e) => e.kind === "page")!;
  assert.equal(page.id, "8d45f9b4-f53e-53fe-952d-a63631fc0ee6");
  const db = entries.find((e) => e.kind === "database")!;
  assert.equal(db.id, "17b05673-fbc8-5f05-c602-727220eca013");
});

test("toggles hide what is inside them until opened, and count its open tasks", () => {
  const md = [
    "## Week",
    "<toggle>",
    "Ideas",
    "",
    "- [ ] One",
    "- [x] Two",
    "<toggle heading=\"h3\">",
    "Deeper",
    "",
    "- [ ] Three",
    "</toggle>",
    "</toggle>",
    "- [ ] After",
  ].join("\n");
  const entries = entriesFromMarkdown("P", md);
  assert.deepEqual(entries.map((e) => [e.kind, e.title, e.depth, e.count ?? null]), [
    ["heading", "Week", 0, null],
    ["toggle", "Ideas", 0, 2],
    ["todo", "One", 1, null],
    ["todo", "Two", 1, null],
    ["toggle", "Deeper", 1, 1],
    ["todo", "Three", 2, null],
    ["todo", "After", 0, null],
  ]);
  const ideas = entries[1].id;
  const deeper = entries[4].id;
  assert.deepEqual(shownEntries(entries, new Set()).map((e) => e.title), ["Week", "Ideas", "After"]);
  assert.deepEqual(shownEntries(entries, new Set([ideas])).map((e) => e.title), ["Week", "Ideas", "One", "Two", "Deeper", "After"]);
  assert.deepEqual(shownEntries(entries, new Set([ideas, deeper])).length, 7);
});

test("a to-do written as a tag, as Notion does for one with children inside a toggle, counts and nests", () => {
  const md = [
    "<toggle>",
    "Things",
    "",
    "<todo checked=\"false\">",
    "Big task ",
    "",
    "- [ ] Small task",
    "</todo>",
    "<todo checked=\"true\">",
    "",
    "- [ ] Under an empty one",
    "</todo>",
    "</toggle>",
    "- [ ] After",
  ].join("\n");
  assert.deepEqual(entriesFromMarkdown("P", md).map((e) => [e.kind, e.title, e.depth, e.index ?? null, e.line ?? null]), [
    ["toggle", "Things", 0, null, null],
    ["todo", "Big task", 1, 0, null],
    ["todo", "Small task", 2, 1, "- [ ] Small task\n"],
    ["todo", "Under an empty one", 1, 3, "- [ ] Under an empty one\n"],
    ["todo", "After", 0, 4, "- [ ] After"],
  ]);
});

test("nested to-dos get a level each; an empty one is hidden and adds none", () => {
  const md = [
    "- [ ] Task",
    "  - [ ] Task2",
    "  - [ ] Task3",
    "  - [ ] More",
    "    - [ ] Deep",
    "- [ ] Another",
    "  - [ ] ",
    "    - [ ] Last",
    "- [ ] ",
    "- Bullet",
    "  - [ ] Under a bullet",
  ].join("\n");
  assert.deepEqual(entriesFromMarkdown("P", md).map((e) => [e.title, e.depth, e.index]), [
    ["Task", 0, 0],
    ["Task2", 1, 1],
    ["Task3", 1, 2],
    ["More", 1, 3],
    ["Deep", 2, 4],
    ["Another", 0, 5],
    ["Last", 1, 7],
    ["Under a bullet", 0, 9],
  ]);
});

test("a to-do whose text is the only one of its kind is ticked by its line, ending with its line break", () => {
  const byTitle = (md: string) => Object.fromEntries(entriesFromMarkdown("P", md).map((e) => [e.title, e.line ?? null]));
  // The line break keeps "Buy milk" from being found inside "Buy milk and eggs"; the same text twice is never ticked by line.
  assert.deepEqual(byTitle("- [ ] Buy milk\n- [ ] Buy milk and eggs\n- [x] Call\n  - [ ] Call"), {
    "Buy milk": "- [ ] Buy milk\n",
    "Buy milk and eggs": "- [ ] Buy milk and eggs\n",
    Call: null,
  });
  // The page's last line has no line break: it keeps its line only if no other to-do's text begins with it.
  assert.deepEqual(byTitle("- [ ] Buy milk and eggs\n- [ ] Buy milk"), { "Buy milk and eggs": "- [ ] Buy milk and eggs\n", "Buy milk": null });
  assert.deepEqual(byTitle("- [ ] A\n- [ ] B"), { A: "- [ ] A\n", B: "- [ ] B" });
});

test("a page is read up to MAX_ENTRIES lines, and says there is more", () => {
  const md = Array.from({ length: 400 }, (_, i) => `- [ ] Task ${i}`).join("\n");
  const entries = entriesFromMarkdown("P", md);
  assert.equal(entries.length, MAX_ENTRIES + 1);
  assert.equal(entries[entries.length - 1].title, "More in Notion");
  assert.equal(entries[entries.length - 1].kind, "heading");
});

test("escaped characters in a title are text, not tags or entities", () => {
  assert.equal(inlineText("\\<b>not a tag\\</b> \\&amp; [x](u)"), "<b>not a tag</b> &amp; x");
});

test("to-dos with the same text get ids of their own that do not move with the others", () => {
  const ids = entriesFromMarkdown("P", PAGE).filter((e) => e.title === "Same title").map((e) => e.id);
  assert.equal(new Set(ids).size, 2);
  const shifted = entriesFromMarkdown("P", `- [ ] New on top\n${PAGE}`).filter((e) => e.title === "Same title").map((e) => e.id);
  assert.deepEqual(shifted, ids);
});

test("a database's id comes from its url, whatever the order of its attributes", () => {
  const [e] = entriesFromMarkdown("P", "<database data-source-url=\"collection://11111111-2222-3333-4444-555555555555\" url=\"https://app.notion.com/p/17b05673fbc85f05c602727220eca013\">DB</database>");
  assert.equal(e.id, "17b05673-fbc8-5f05-c602-727220eca013");
});

test("a one-line page tag", () => {
  const [e] = entriesFromMarkdown("P", "<page url=\"https://app.notion.com/p/Notes-b8722494af121b07e81f3401f2e9fed3\">Notes</page>");
  assert.deepEqual([e.kind, e.id, e.title], ["page", "b8722494-af12-1b07-e81f-3401f2e9fed3", "Notes"]);
});

test("inline text and matching it with a block's text", () => {
  assert.equal(inlineText("<span color=\"red\">Red</span> \\[x\\]"), "Red [x]");
  assert.ok(sameText("Task with bold and link", "Task with bold, and link!"));
  assert.ok(sameText("Due 2026-11-21 report", "Due November 21, 2026 report") === false);
  assert.ok(!sameText("Buy milk", "Buy bread"));
});

const HEX = "ac540d75c21cf6f6f9595cd70675efdf";
const ID = "ac540d75-c21c-f6f6-f959-5cd70675efdf";

test("a to-do that mentions or links a Notion page can open it; a link off Notion cannot", () => {
  assert.equal(linkOf(`Call <mention url="https://app.notion.com/p/${HEX}">Bob</mention>`), ID);
  assert.equal(linkOf(`See [the brief](https://www.notion.so/Brief-${HEX}?pvs=4)`), ID);
  assert.equal(linkOf(`Read [this](https://example.com/${HEX})`), "");
  assert.equal(linkOf(`Meet <mention url="user://${HEX}">Ann</mention>`), "");
  assert.equal(linkOf("<mention-date start=\"2026-11-22\"/> plain"), "");
  const [linked, plain] = entriesFromMarkdown("p", `- [ ] Prepare <mention url="https://app.notion.com/p/${HEX}">Brief</mention>\n- [ ] Plain`);
  assert.equal(linked.title, "Prepare Brief");
  assert.equal(linked.link, ID);
  assert.equal(plain.link, undefined);
});
