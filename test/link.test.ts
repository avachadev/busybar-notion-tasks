import assert from "node:assert/strict";
import { test } from "node:test";

import { parseListLink, parseToken } from "../src/link.ts";

const ID = "1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6";
const DASHED = "1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6";

test("finds the list id in what people paste", () => {
  for (const raw of [
    `https://www.notion.so/team/Tasks-${ID}?v=ffffffffffffffffffffffffffffffff&pvs=4`,
    `https://www.notion.so/Tasks-${ID}`,
    `https://www.notion.so/${ID}?source=copy_link`,
    `notion.so/team/${ID}/`,
    ` ${ID} `,
    DASHED,
    `https://www.notion.so/team/Cafe-${ID.toUpperCase()}#section`,
  ]) {
    assert.deepEqual(parseListLink(raw), { kind: "id", id: DASHED }, raw);
  }
});

test("empty and invalid links", () => {
  assert.deepEqual(parseListLink("  "), { kind: "empty" });
  assert.equal(parseListLink("https://www.notion.so/team/Tasks").kind, "invalid");
  // The view id alone is not the list.
  assert.equal(parseListLink(`https://www.notion.so/team/Tasks?v=${ID}`).kind, "invalid");
});

test("tokens", () => {
  assert.equal(parseToken(""), "");
  assert.equal(parseToken("  ntn_abcdefghijklmnopqrstuvwxyz0123  "), "ntn_abcdefghijklmnopqrstuvwxyz0123");
  assert.equal(parseToken("ntn_abc def"), null);
  assert.equal(parseToken("short"), null);
});
