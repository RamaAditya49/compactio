#!/usr/bin/env node
// compactio CLI: `show <id>` prints a stored original output, `gain` prints the scoreboard,
// `proxy [port]` runs the Sweep proxy, `sweep on|off|status` installs it as a service.
import { fileURLToPath } from "node:url";
import { JEV_PRICE_PER_TOKEN } from "./jev.ts";
import * as store from "./store.ts";
import * as install from "./install.ts";
import { serve } from "./sweep.ts";

const tok = (chars: number) => Math.round(chars / 4); // estimate: ~4 characters per token
const fmt = (n: number) => n.toLocaleString("en-US");

const k = (chars: number) => (chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : `${chars}`);
const bar = (part: number, width = 20) => "█".repeat(Math.round(part * width)).padEnd(width, "░");

export function gain(entries: store.LogEntry[], sid?: string): string {
  // Sweep "judge" rows are Jev calls, not outputs: count their cost, not their size.
  const all = sid ? entries.filter((e) => e.sid === sid) : entries;
  const rows = all.filter((e) => e.level !== "judge");
  const cut = rows.filter((e) => e.after < e.before);
  const before = rows.reduce((a, e) => a + e.before, 0);
  const saved = rows.reduce((a, e) => a + e.before - e.after, 0);
  const cutBefore = cut.reduce((a, e) => a + e.before, 0);
  const jev = all.filter((e) => e.engine === "jev");
  const cost = jev.reduce((a, e) => a + (e.jevTokens ?? 0), 0) * JEV_PRICE_PER_TOKEN;
  const share = before ? saved / before : 0;
  const avgCut = cutBefore ? saved / cutBefore : 0;
  const line = "─".repeat(52);
  const out = [
    `compactio · ${sid ? "this session" : "all sessions"}`,
    line,
    `  Tokens kept out of context   ~${fmt(tok(saved))}`,
    `  Share of tool output cut     ${bar(share)} ${Math.round(share * 100)}%`,
    `  Outputs cut                  ${cut.length} of ${rows.length}  (avg cut ${Math.round(avgCut * 100)}%)`,
    `  Jev decisions                ${jev.length}  ·  $${cost.toFixed(4)}`,
    `  Old outputs swept            ${rows.filter((e) => e.engine === "sweep").length}`,
    `  Unchanged re-reads skipped   ${rows.filter((e) => e.level === "unchanged").length}`,
    `  Fail-open                    ${all.filter((e) => e.engine === "fail-open").length}`,
  ];
  const top = [...cut].sort((a, b) => b.before - b.after - (a.before - a.after)).slice(0, 3);
  if (top.length) {
    out.push(line, "  Biggest cuts");
    for (const e of top) out.push(`    ${e.tool.padEnd(6)} ${(e.engine === "lossless" ? "clean" : e.level).padEnd(9)} ${k(e.before).padStart(6)} → ${k(e.after).padEnd(6)} chars  (${e.engine})`);
  }
  out.push(line, "  tokens ≈ characters ÷ 4");
  return out.join("\n");
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
} else if (cmd === "proxy") {
  const port = Number(arg ?? process.env.COMPACTIO_PORT ?? 8787);
  serve(port).on("listening", () => console.log(`compactio sweep proxy on http://127.0.0.1:${port}`));
} else if (cmd === "sweep" && (arg === "on" || arg === "off" || arg === "status" || !arg)) {
  const run = arg === "on" ? install.on() : arg === "off" ? install.off() : install.status();
  Promise.resolve(run).then(console.log, (e) => {
    console.error(`compactio: ${e.message ?? e}`);
    process.exit(1);
  });
} else if (cmd) {
  process.stderr.write("usage: compactio show <id> | compactio gain [session-id] | compactio proxy [port] | compactio sweep on|off|status\n");
  process.exit(1);
}
