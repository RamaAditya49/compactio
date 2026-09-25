import assert from "node:assert/strict";
import { test } from "node:test";
import { errorsOnly, headTail, lossless } from "../src/filters.ts";
import { redact } from "../src/redact.ts";

test("lossless strips ANSI and folds repeated lines", () => {
  const out = lossless("\x1b[31mred\x1b[0m\n" + "same\n".repeat(5) + "end");
  assert.equal(out, "red\nsame\n[… same line repeated 4 more times]\nend");
});

test("headTail keeps both ends", () => {
  const text = Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n");
  const out = headTail(text, 2, 2).split("\n");
  assert.deepEqual(out, ["l0", "l1", "[… 96 lines cut …]", "l98", "l99"]);
});

test("errorsOnly keeps the error with context and the tail", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `ok ${i}`);
  lines[50] = "Error: boom";
  const out = errorsOnly(lines.join("\n"), 1, 1);
  assert.match(out, /ok 49\nError: boom\nok 51/);
  assert.match(out, /ok 99$/);
  assert.ok(!out.includes("ok 10\n"));
});

test("redact masks keys and assignments", () => {
  const out = redact("API_KEY=abcd1234xyz and ghp_abcdefghijklmnopqrstuvwx and Bearer abcdefghijklmnop");
  assert.equal(out, "API_KEY=[REDACTED] and [REDACTED] and [REDACTED]");
});
