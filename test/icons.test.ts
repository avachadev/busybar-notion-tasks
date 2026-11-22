import assert from "node:assert/strict";
import { test } from "node:test";

import { ICON_MS, Icons } from "../src/icons.ts";
import type { Entry } from "../src/tasks.ts";

const page = (id: string, icon?: string): Entry => (icon ? { kind: "page", id, title: id, icon } : { kind: "page", id, title: id });
const todo = (id: string): Entry => ({ kind: "todo", id, title: id, done: false });

test("icons asked for go onto the page's subpages", () => {
  const icons = new Icons();
  const list = [page("a"), todo("t"), page("b")];
  icons.got("b", "📚", 0);
  const out = icons.apply(list);
  assert.equal(out[2].icon, "📚");
  assert.equal(out[0].icon, undefined);
  assert.equal(list[2].icon, undefined, "the list read is left as it was");
});

test("nothing known leaves the same list", () => {
  const icons = new Icons();
  const list = [page("a"), todo("t")];
  assert.equal(icons.apply(list), list);
});

test("an icon the page showed before stays until Notion is asked", () => {
  const icons = new Icons();
  assert.equal(icons.apply([page("a")], [page("a", "🚀")])[0].icon, "🚀");
  icons.got("a", "", 0);
  assert.equal(icons.apply([page("a")], [page("a", "🚀")])[0].icon, undefined, "removed in Notion");
});

test("asked from the focused line down, then above it; to-dos are not asked", () => {
  const icons = new Icons();
  const list = [page("a"), todo("t"), page("b"), page("c")];
  assert.equal(icons.next(list, 1, 0)?.id, "b");
  icons.got("b", "", 0);
  icons.got("c", "💡", 0);
  assert.equal(icons.next(list, 1, 0)?.id, "a");
  icons.got("a", "", 0);
  assert.equal(icons.next(list, 1, 0), null);
  assert.equal(icons.next(list, 1, ICON_MS)?.id, "b", "asked again after a while");
});

test("an empty list has nothing to ask", () => {
  assert.equal(new Icons().next([], 0, 0), null);
});
