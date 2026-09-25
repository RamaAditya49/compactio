#!/usr/bin/env node
// compactio CLI: `show <id>` prints a stored original output, `gain` prints the scoreboard.
import { fileURLToPath } from "node:url";
import { JEV_PRICE_PER_TOKEN } from "./jev.ts";
import * as store from "./store.ts";

const tok = (chars: number) => Math.round(chars / 4); // estimate: ~4 characters per token
const fmt = (n: number) => n.toLocaleString("en-US");

export function gain(entries: store.LogEntry[], sid?: string): string {
  const rows = sid ? entries.filter((e) => e.sid === sid) : entries;
  const saved = rows.reduce((a, e) => a + e.before - e.after, 0);
  const jevTokens = rows.reduce((a, e) => a + (e.jevTokens ?? 0), 0);
  const count = (f: (e: store.LogEntry) => boolean) => rows.filter(f).length;
  const cut = count((e) => e.after < e.before);
  const cost = jevTokens * JEV_PRICE_PER_TOKEN;
  return [
    `compactio · ${sid ? "this session" : "all sessions"}`,
    `  tool outputs seen          ${fmt(rows.length)}`,
    `  outputs made smaller       ${fmt(cut)}`,
    `  tokens kept out of context ~${fmt(tok(saved))}`,
    `  Jev decisions              ${fmt(count((e) => e.engine === "jev"))}   cost $${cost.toFixed(4)}`,
    `  unchanged re-reads skipped ${fmt(count((e) => e.level === "unchanged"))}`,
    `  fail-open                  ${fmt(count((e) => e.engine === "fail-open"))}`,
    `  (tokens are estimated as characters / 4)`,
  ].join("\n");
}

const [cmd, arg] = process.argv.slice(2);
if (process.argv[1] !== fileURLToPath(import.meta.url)) {
  // imported (tests): do nothing
} else if (cmd === "show") {
  const text = arg && store.loadOriginal(arg);
  if (!text) {
    process.stderr.write(`compactio: no stored output with id ${arg}\n`);
    process.exit(1);
  }
  process.stdout.write(text);
} else if (cmd === "gain") {
  console.log(gain(store.readLog(), arg));
} else if (cmd) {
  process.stderr.write("usage: compactio show <id> | compactio gain [session-id]\n");
  process.exit(1);
}
