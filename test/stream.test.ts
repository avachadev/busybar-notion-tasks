import assert from "node:assert/strict";
import { test } from "node:test";

import { PageReader, entriesFromMarkdown } from "../src/markdown.ts";
import { MarkdownLines, decode } from "../src/stream.ts";

/** The answer Notion sends for a page, as bytes. */
const answer = (md: string) => new TextEncoder().encode(JSON.stringify({ object: "page_markdown", id: "x", markdown: md, truncated: false }));

/** Reads the answer through MarkdownLines, cut into chunks of `size` bytes. */
function viaStream(md: string, size: number) {
  const reader = new PageReader("P");
  const lines = new MarkdownLines((line) => {
    reader.push(line);
    return !reader.full;
  });
  const bytes = answer(md);
  for (let i = 0; i < bytes.length; i += size) if (!lines.feed(bytes.subarray(i, i + size))) break;
  lines.end();
  return reader.finish();
}

const PAGE = [
  "Intro with \"quotes\" and a back\\slash",
  "",
  "- [ ] Купить молоко",
  "  - [x] Вложенная \"задача\" ✅",
  "<toggle>",
  "Идеи",
  "",
  "- [ ] В тоггле",
  "</toggle>",
  "\tTabbed paragraph",
  "<page url=\"https://app.notion.com/p/8d45f9b4f53e53fe952da63631fc0ee6\">",
  "Страница",
  "</page>",
  "# Заголовок 😀",
  "- [ ] Последняя",
].join("\n");

test("a page read as a stream, in chunks of any size, comes out as read whole", () => {
  const whole = entriesFromMarkdown("P", PAGE);
  for (const size of [1, 2, 3, 7, 16, 64, 100000]) assert.deepEqual(viaStream(PAGE, size), whole, `chunks of ${size}`);
});

test("decoding undoes UTF-8 and JSON escapes", () => {
  const bytes = new TextEncoder().encode(JSON.stringify("Задача \"в кавычках\" \\ 😀 \u0001").slice(1, -1));
  assert.equal(decode(bytes, 0, bytes.length), "Задача \"в кавычках\" \\ 😀 \u0001");
});

test("a very long line is cut, and the lines after it still come", () => {
  const md = `- [ ] ${"Очень длинная ".repeat(400)}\n- [ ] После`;
  const entries = viaStream(md, 50);
  assert.equal(entries.length, 2);
  assert.ok(entries[0].title.length <= 80);
  assert.equal(entries[1].title, "После");
});

test("reading stops once the page has given MAX_ENTRIES lines", () => {
  const md = Array.from({ length: 1000 }, (_, i) => `- [ ] Task ${i}`).join("\n") + "\n" + "x".repeat(200000);
  let chunks = 0;
  const reader = new PageReader("P");
  const lines = new MarkdownLines((line) => {
    reader.push(line);
    return !reader.full;
  });
  const bytes = answer(md);
  for (let i = 0; i < bytes.length; i += 1024) {
    chunks += 1;
    if (!lines.feed(bytes.subarray(i, i + 1024))) break;
  }
  assert.ok(chunks < 10, `stopped after ${chunks} chunks`);
  assert.equal(reader.finish().at(-1)?.title, "More in Notion");
});
