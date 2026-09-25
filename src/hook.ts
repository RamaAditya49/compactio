// Claude Code hook entry. Usage: node hook.ts <post-tool|prompt|reset> < event.json
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apply, hasErrors, lossless, preview, type Level } from "./filters.ts";
import { decide, endpoint } from "./jev.ts";
import { ensure } from "./install.ts";
import { redact } from "./redact.ts";
import * as store from "./store.ts";

export const MIN_CHARS = 2_000; // below this, touching the output saves nothing
export const MIN_LOSSY_CHARS = 6_000; // below this, only lossless filters run
export const LOCAL_MAX_CHARS = 24_000; // without Jev, cut outputs above this to head+tail
export const MIN_CONFIDENCE = 0.6; // below this, keep the full output

// Files an agent reads but does not edit: logs, data dumps, lockfiles, minified bundles.
export const DATA_FILE =
  /(\.(log|out|jsonl|ndjson|csv|tsv|map)|\.min\.(js|css)|(^|[\\/])(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|Cargo\.lock|composer\.lock|poetry\.lock|Gemfile\.lock|go\.sum))$/i;

type Event = {
  session_id: string;
  agent_id?: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  prompt?: string;
};

type Path = (string | number)[];

// The biggest string inside the tool response: that is what the model reads.
export function largestString(v: unknown, path: Path = []): { path: Path; text: string } | undefined {
  if (typeof v === "string") return { path, text: v };
  if (!v || typeof v !== "object") return undefined;
  let best: { path: Path; text: string } | undefined;
  for (const [k, child] of Object.entries(v)) {
    const hit = largestString(child, [...path, Array.isArray(v) ? Number(k) : k]);
    if (hit && (!best || hit.text.length > best.text.length)) best = hit;
  }
  return best;
}

function setAt(v: unknown, path: Path, text: string): unknown {
  if (path.length === 0) return text;
  const copy: any = Array.isArray(v) ? [...v] : { ...(v as object) };
  copy[path[0]] = setAt(copy[path[0]], path.slice(1), text);
  return copy;
}

const cliPath = () => fileURLToPath(new URL("./cli.ts", import.meta.url));

export async function postTool(ev: Event, env = process.env): Promise<unknown | undefined> {
  const t0 = Date.now();
  const resp = ev.tool_response as any;
  if (!resp || resp.isImage) return;
  if (ev.tool_name === "Bash" && String(ev.tool_input?.command ?? "").includes("compactio")) return;
  // Images, PDFs, notebooks: the largest string is base64 or cell JSON, not text. Never cut, never counted.
  if (ev.tool_name === "Read" && resp.type && resp.type !== "text") return;
  const hit = largestString(resp);
  if (!hit || hit.text.length < MIN_CHARS) return;

  const original = hit.text;
  const base = { ts: new Date().toISOString(), sid: ev.session_id, tool: ev.tool_name, before: original.length };
  const done = (text: string, engine: store.LogEntry["engine"], level: string, extra: Partial<store.LogEntry> = {}) => {
    store.log({ ...base, engine, level, after: text.length, ms: Date.now() - t0, ...extra });
    if (text === original) return undefined;
    return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: setAt(resp, hit.path, text) } };
  };

  // Claude Code saves big outputs to tool-results/ and the agent reads them back:
  // that is tool output, not code, so it takes the normal filter path. Data files too.
  const file = String(ev.tool_input?.file_path ?? "");
  const savedOutput = /[\\/]\.claude[\\/]projects[\\/].+[\\/]tool-results[\\/]/.test(file);

  // Read: never cut code the agent may edit. Only skip exact re-reads.
  if (ev.tool_name === "Read" && !savedOutput && !DATA_FILE.test(file)) {
    const i = ev.tool_input ?? {};
    const key = [ev.agent_id ?? "main", i.file_path, i.offset ?? "", i.limit ?? "", i.pages ?? ""].join("|");
    const hash = createHash("sha256").update(original).digest("hex");
    const s = store.loadSession(ev.session_id);
    const seen = s.reads[key] === hash;
    // After one "unchanged" answer, forget the hash: if the earlier read left the
    // context (native tool-result clearing), the next identical read comes back in full.
    if (seen) delete s.reads[key];
    else s.reads[key] = hash;
    store.saveSession(ev.session_id, s);
    if (!seen) return done(original, "dedupe", "full");
    const lines = original.split("\n").length;
    return done(
      `[compactio: this file is unchanged since you last read it in this conversation (${lines} lines). Use that earlier read. If it is no longer in your context, read the file again.]`,
      "dedupe",
      "unchanged",
    );
  }

  const text = lossless(original);
  if (text.length < MIN_LOSSY_CHARS) return done(text.length < original.length * 0.9 ? text : original, "lossless", "full");

  const levels: Level[] = hasErrors(text) ? ["full", "errors", "headtail", "stub"] : ["full", "headtail", "stub"];
  let level: Level = "full";
  let engine: store.LogEntry["engine"] = "local";
  const extra: Partial<store.LogEntry> = {};
  const ep = endpoint(env);
  if (ep) {
    try {
      const state = {
        goal: redact(store.loadSession(ev.session_id).goal ?? "unknown"),
        tool: ev.tool_name,
        tool_input: redact(JSON.stringify(ev.tool_input ?? {})).slice(0, 600),
        output: Object.fromEntries(Object.entries(preview(text)).map(([k, v]) => [k, typeof v === "string" ? redact(v) : v])),
      };
      const d = await decide(state, levels, ep, Number(env.COMPACTIO_TIMEOUT_MS ?? 1500));
      engine = "jev";
      extra.jevTokens = d.inputTokens;
      level = d.confidence >= MIN_CONFIDENCE ? d.level : "full";
    } catch (e) {
      engine = "fail-open";
      extra.error = String((e as Error).message ?? e).slice(0, 200);
    }
  } else if (text.length > LOCAL_MAX_CHARS) {
    level = "headtail";
  }

  if (level === "full") return done(text, engine, level, extra);
  const id = randomUUID().slice(0, 8);
  store.saveOriginal(id, original);
  const kept = apply(level, text);
  const note = `\n[compactio: kept "${level}" view of ${text.split("\n").length} lines. Full output: node "${cliPath()}" show ${id}]`;
  return done(kept + note, engine, level, extra);
}

export function prompt(ev: Event): void {
  const s = store.loadSession(ev.session_id);
  s.goal = String(ev.prompt ?? "").slice(0, 2000);
  store.saveSession(ev.session_id, s);
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const ev = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Event;
  const mode = process.argv[2];
  if (mode === "prompt") return prompt(ev);
  if (mode === "reset") return store.clearReads(ev.session_id);
  if (mode === "start") {
    const warning = await ensure();
    if (warning) process.stdout.write(JSON.stringify({ systemMessage: warning }));
    return;
  }
  const out = await postTool(ev);
  if (out) process.stdout.write(JSON.stringify(out));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Fail open: compactio must never break the agent.
  main().catch((e) => {
    process.stderr.write(`compactio: ${e?.message ?? e}\n`);
    process.exit(0);
  });
}
