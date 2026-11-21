import assert from "node:assert/strict";
import { test } from "node:test";

import { entriesFromMarkdown, inlineText, sameText } from "../src/markdown.ts";

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

test("a page's to-dos come out from every container, with pages and databases in place", () => {
  const entries = entriesFromMarkdown("P", PAGE);
  assert.deepEqual(entries.map((e) => [e.kind, e.title, e.done ?? null, e.index ?? null]), [
    ["todo", "Plain task", false, 0],
    ["todo", "Done plain task", true, 1],
    ["todo", "Parent task", false, 2],
    ["todo", "Child task", false, 3],
    ["todo", "Task with bold and link and code", false, 4],
    ["todo", "Same title", false, 5],
    ["todo", "Same title", false, 6],
    // The empty to-do at 7 is not shown, but counts.
    ["todo", "Task in toggle", false, 8],
    ["todo", "Task in left column", false, 9],
    ["page", "2025", null, null],
    ["database", "Select tasks", null, null],
    ["todo", "Task in synced block", true, 10],
    ["todo", "Due 2026-11-21 *sharp* & fast", false, 11],
  ]);
  const page = entries.find((e) => e.kind === "page")!;
  assert.equal(page.id, "8d45f9b4-f53e-53fe-952d-a63631fc0ee6");
  const db = entries.find((e) => e.kind === "database")!;
  assert.equal(db.id, "17b05673-fbc8-5f05-c602-727220eca013");
});

test("only a to-do whose line no other line contains can be ticked by its line", () => {
  const byTitle = (md: string) => Object.fromEntries(entriesFromMarkdown("P", md).map((e) => [e.title, e.line ?? null]));
  assert.deepEqual(byTitle("- [ ] Buy milk\n- [ ] Buy milk and eggs\n- [x] Call\n  - [ ] Call"), {
    "Buy milk": null,
    "Buy milk and eggs": "- [ ] Buy milk and eggs",
    Call: null,
  });
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
  assert.deepEqual(e, { kind: "page", id: "b8722494-af12-1b07-e81f-3401f2e9fed3", title: "Notes" });
});

test("inline text and matching it with a block's text", () => {
  assert.equal(inlineText("<span color=\"red\">Red</span> \\[x\\]"), "Red [x]");
  assert.ok(sameText("Task with bold and link", "Task with bold, and link!"));
  assert.ok(sameText("Due 2026-11-21 report", "Due November 21, 2026 report") === false);
  assert.ok(!sameText("Buy milk", "Buy bread"));
});
