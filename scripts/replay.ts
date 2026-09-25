// Replay real Claude Code transcripts through the filter and report the saving.
// Usage: node scripts/replay.ts [--jev] [--sessions N] [--before ISO-date]
//   --jev       ask Jev (needs TYPESAFE_API_KEY or OPENROUTER_API_KEY); default is local mode
//   --sessions  the N largest transcripts (default 30)
//   --before    only transcripts last changed before this date (default: now)
// Nothing is written to ~/.compactio: the replay uses a temporary COMPACTIO_HOME.
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

process.env.COMPACTIO_HOME = mkdtempSync(join(tmpdir(), "compactio-replay-"));
const { postTool, prompt } = await import("../src/hook.ts");

const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const useJev = process.argv.includes("--jev");
const count = Number(process.argv.includes("--sessions") ? arg("--sessions") : 30);
const before = process.argv.includes("--before") ? Date.parse(arg("--before")) : Date.now();

const root = join(homedir(), ".claude", "projects");
const files = readdirSync(root)
  .flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith(".jsonl")).map((f) => join(root, d, f)))
  .map((f) => ({ f, st: statSync(f) }))
  .filter((x) => x.st.mtimeMs < before)
  .sort((a, b) => b.st.size - a.st.size)
  .slice(0, count);

const len = (v: unknown) => (typeof v === "string" ? v.length : JSON.stringify(v ?? "").length);
// What the model reads from a tool result: its text. Images are counted apart (base64 is not text).
let images = 0;
const resultLen = (c: unknown) =>
  typeof c === "string" ? c.length : Array.isArray(c) ? c.reduce((a, x: any) => (x.type === "image" ? (images++, a) : a + (x.text?.length ?? 0)), 0) : 0;
let context = 0, toolOut = 0, saved = 0, calls = 0, cut = 0;
const byTool = new Map<string, { out: number; saved: number }>();

for (const { f } of files) {
  const tools = new Map<string, { name: string; input: any }>();
  const sid = f.split("/").pop()!.replace(".jsonl", "");
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const content = e.message?.content;
    if (!e.message || (e.type !== "user" && e.type !== "assistant")) continue;
    if (typeof content === "string") {
      context += content.length;
      if (e.type === "user") prompt({ session_id: sid, tool_name: "", prompt: content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "thinking" || b.type === "redacted_thinking") continue;
      if (b.type === "text") {
        context += b.text.length;
        if (e.type === "user" && !b.text.trimStart().startsWith("<")) prompt({ session_id: sid, tool_name: "", prompt: b.text });
      } else if (b.type === "tool_use") {
        context += len(b.input);
        tools.set(b.id, { name: b.name, input: b.input });
      } else if (b.type === "tool_result") {
        const size = resultLen(b.content);
        context += size;
        toolOut += size;
        const use = tools.get(b.tool_use_id);
        const name = use?.name ?? "tool";
        const t = byTool.get(name) ?? { out: 0, saved: 0 };
        t.out += size;
        byTool.set(name, t);
        if (!use || e.toolUseResult === undefined || typeof e.toolUseResult === "string" || e.toolUseResult?.type === "image") continue;
        calls++;
        const out: any = await postTool(
          { session_id: sid, tool_name: name, tool_input: use.input, tool_response: e.toolUseResult },
          useJev ? process.env : {},
        );
        if (!out) continue;
        // Never count more than the model saw from this result.
        const cutBy = Math.min(size, Math.max(0, len(e.toolUseResult) - len(out.hookSpecificOutput.updatedToolOutput)));
        saved += cutBy;
        t.saved += cutBy;
        if (cutBy) cut++;
      }
    }
  }
}

const pct = (a: number, b: number) => `${b ? ((a / b) * 100).toFixed(1) : "0.0"}%`;
const tok = (c: number) => Math.round(c / 4).toLocaleString("en-US");
console.log(`compactio replay · ${files.length} sessions · ${useJev ? "Jev" : "local mode"}`);
console.log(`  context (final, no thinking)  ~${tok(context)} tokens`);
console.log(`  tool output                   ~${tok(toolOut)} tokens (${pct(toolOut, context)} of context)`);
console.log(`  kept out by the filter        ~${tok(saved)} tokens`);
console.log(`    share of tool output        ${pct(saved, toolOut)}`);
console.log(`    share of context            ${pct(saved, context)}`);
console.log(`  outputs cut                   ${cut} of ${calls}  (images, not counted: ${images})`);
console.log("  by tool (tool output → kept out):");
for (const [name, t] of [...byTool].sort((a, b) => b[1].out - a[1].out).slice(0, 10))
  console.log(`    ${name.slice(0, 40).padEnd(40)} ~${tok(t.out).padStart(9)} → ~${tok(t.saved).padStart(8)}  (${pct(t.saved, t.out)})`);
console.log("tokens ≈ characters ÷ 4. Context is the transcript at its end, before any compaction.");
