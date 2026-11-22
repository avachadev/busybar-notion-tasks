import assert from "node:assert/strict";
import { test } from "node:test";

import { focusable, settle, step } from "../src/focus.ts";
import type { Entry } from "../src/tasks.ts";

const h = (id: string): Entry => ({ kind: "heading", id, title: id });
const t = (id: string): Entry => ({ kind: "todo", id, title: id });

test("the wheel passes over headings and stops at the ends", () => {
  const list = [h("week"), t("a"), h("later"), h("more"), t("b")];
  assert.equal(step(list, 1, 1), 4);
  assert.equal(step(list, 4, -1), 1);
  assert.equal(step(list, 1, -1), 1);
  assert.equal(step(list, 4, 1), 4);
});

test("the focus settles on the nearest line it may stand on", () => {
  const list = [h("week"), t("a"), h("later"), t("b")];
  assert.equal(settle(list, 0), 1);
  assert.equal(settle(list, 2), 3);
  assert.equal(settle([t("a"), h("end")], 1), 0);
  assert.equal(settle(list, 99), 3);
  assert.equal(settle([], 0), 0);
});

test("the wheel stops on the line that says a page was cut, not on other headings", () => {
  const list: Entry[] = [
    { kind: "todo", id: "a", title: "A" },
    { kind: "heading", id: "p/h", title: "Section" },
    { kind: "todo", id: "b", title: "B" },
    { kind: "heading", id: "p/more", title: "More in Notion" },
  ];
  assert.equal(step(list, 0, 1), 2);
  assert.equal(step(list, 2, 1), 3);
  assert.equal(focusable(list[1]), false);
});
