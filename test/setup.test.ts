import assert from "node:assert/strict";
import { test } from "node:test";

import { BACK_W, setupElements } from "../src/setup.ts";

test("the back screen's guide fits 148x80, ids on the back only, and says what to paste", () => {
  for (const reason of ["none", "bad"] as const) {
    for (const addresses of [[], [{ how: "Wi-Fi" as const, address: "192.168.100.200" }], [{ how: "Wi-Fi" as const, address: "192.168.1.101" }, { how: "USB" as const, address: "10.0.4.20" }]]) {
      const els = setupElements(reason, addresses);
      for (const e of els) {
        assert.equal(e.display, "back");
        assert.ok(e.id.startsWith("b_"), e.id);
        assert.ok(e.y >= 0 && e.y + (e.type === "rectangle" ? e.height : 10) <= 80, `${e.id} at ${e.y}`);
        if (e.type === "rectangle") assert.ok(e.width <= BACK_W, `${e.id} ${e.width}`);
      }
      assert.equal(new Set(els.map((e) => e.id)).size, els.length);
      const texts = els.flatMap((e) => (e.type === "text" ? [e.text] : []));
      assert.ok(texts.includes("Tasks for Notion"));
      assert.equal(texts[0], reason === "bad" ? "Token not accepted" : "Connect Notion");
      assert.ok(texts.includes(addresses.length ? addresses[0].address : "10.0.4.20"));
    }
  }
});
