// Sweep: a local proxy between Claude Code and the Anthropic API. Jev marks old tool
// results that the current goal no longer needs; code replaces them with tombstones.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { preview } from "./filters.ts";
import { ask, endpoint } from "./jev.ts";
import { redact } from "./redact.ts";
import * as store from "./store.ts";

export const MIN_RESULT_CHARS = 4_000; // smaller results do not pay for a cache rewrite
export const PROTECT_MESSAGES = 10; // the last messages are work in progress: never swept
export const MIN_ASK_CHARS = 40_000; // ask Jev only when this much text is at stake
export const MAX_QUESTIONS = 16; // Jev limit: state + questions <= 64k tokens
export const DROP_CONFIDENCE = 0.8; // dropping is worse than keeping: ask for more confidence
export const REASK_MESSAGES = 40; // a kept result is asked again after this many new messages

type Block = { type: string; tool_use_id?: string; id?: string; name?: string; input?: unknown; content?: unknown; text?: string };
type Message = { role: string; content: string | Block[] };
type Body = { messages?: Message[]; metadata?: { user_id?: string } };
type Found = { id: string; msg: number; block: Block; text: string; tool: string; input: string };

const cliPath = () => fileURLToPath(new URL("./cli.ts", import.meta.url));

// Only text results can be swept. Results with images stay.
function resultText(b: Block): string | undefined {
  if (typeof b.content === "string") return b.content;
  if (!Array.isArray(b.content) || !b.content.every((c: Block) => c.type === "text")) return undefined;
  return b.content.map((c: Block) => c.text ?? "").join("\n");
}

function summary(tool: string, input: any): string {
  const s = input?.file_path ?? input?.command ?? input?.pattern ?? input?.url ?? JSON.stringify(input ?? {});
  return `${tool} ${String(s).slice(0, 100)}`;
}

// The goal: the last text the user typed. Skip reminders and tool results.
function goal(msgs: Message[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    const texts = typeof m.content === "string" ? [m.content] : m.content.filter((b) => b.type === "text").map((b) => b.text ?? "");
    const typed = texts.filter((t) => t.trim() && !t.trimStart().startsWith("<"));
    if (typed.length) return typed.join("\n").slice(-2000);
  }
  return "unknown";
}

function results(msgs: Message[]): Found[] {
  const tools = new Map<string, Block>();
  const out: Found[] = [];
  msgs.forEach((m, i) => {
    if (typeof m.content === "string") return;
    for (const b of m.content) {
      if (b.type === "tool_use" && b.id) tools.set(b.id, b);
      if (b.type !== "tool_result" || !b.tool_use_id) continue;
      const text = resultText(b);
      if (text === undefined) continue;
      const use = tools.get(b.tool_use_id);
      out.push({ id: b.tool_use_id, msg: i, block: b, text, tool: use?.name ?? "tool", input: summary(use?.name ?? "tool", use?.input) });
    }
  });
  return out;
}

// Rewrites body.messages in place. Returns whether the body or the state changed.
export async function sweep(
  body: Body,
  state: store.SweepState,
  env: Record<string, string | undefined> = process.env,
  opts: { askJev?: boolean } = {},
): Promise<{ body: boolean; state: boolean }> {
  const msgs = body.messages;
  const changed = { body: false, state: false };
  if (!Array.isArray(msgs)) return changed;
  const all = results(msgs);

  // 1. Replay earlier tombstones on every request, so the prompt prefix stays the same.
  for (const r of all) {
    if (state.dropped[r.id] && r.text !== state.dropped[r.id]) {
      r.block.content = state.dropped[r.id];
      changed.body = true;
    }
  }

  const old = all.filter((r) => r.msg < msgs.length - PROTECT_MESSAGES && !state.dropped[r.id] && r.text.length >= MIN_RESULT_CHARS);
  const sid = body.metadata?.user_id?.match(/session_([0-9a-f-]{36})/)?.[1] ?? "proxy";

  // 2. Ask Jev about old results it has not judged, or judged long ago.
  const open = old.filter((r) => !state.stale[r.id] && (state.kept[r.id] === undefined || msgs.length - state.kept[r.id] >= REASK_MESSAGES));
  const ep = endpoint(env);
  if (opts.askJev !== false && ep && open.reduce((a, r) => a + r.text.length, 0) >= MIN_ASK_CHARS) {
    const batch = [...open].sort((a, b) => b.text.length - a.text.length).slice(0, MAX_QUESTIONS);
    const t0 = Date.now();
    try {
      const jevState = {
        goal: redact(goal(msgs)),
        results: Object.fromEntries(
          batch.map((r, k) => [
            `r${k}`,
            { tool: redact(r.input), ...Object.fromEntries(Object.entries(preview(r.text, 2400)).map(([n, v]) => [n, typeof v === "string" ? redact(v) : v])) },
          ]),
        ),
      };
      const questions = Object.fromEntries(
        batch.map((_, k) => [
          `r${k}`,
          {
            type: "choice",
            instructions: `A coding agent works on \`goal\`. \`results.r${k}\` is a preview of the output of an earlier tool call. Must that output stay in the agent's context?`,
            criteria: {
              keep: "The agent may still need details from this output for the goal or for the work in progress.",
              drop: "The output is stale: the goal no longer depends on it, or a later step replaced it. The agent can run the tool again if needed.",
            },
          },
        ]),
      );
      const { answers, inputTokens } = await ask(jevState, questions, ep, Number(env.COMPACTIO_SWEEP_TIMEOUT_MS ?? 3000));
      batch.forEach((r, k) => {
        const a = answers[`r${k}`];
        if (a?.choice === "drop" && a.confidence >= DROP_CONFIDENCE) state.stale[r.id] = 1;
        else state.kept[r.id] = msgs.length;
      });
      store.log({ ts: new Date().toISOString(), sid, tool: "sweep", engine: "jev", level: "judge", before: 0, after: 0, ms: Date.now() - t0, jevTokens: inputTokens });
      changed.state = true;
    } catch (e) {
      store.log({ ts: new Date().toISOString(), sid, tool: "sweep", engine: "fail-open", level: "judge", before: 0, after: 0, ms: Date.now() - t0, error: String((e as Error).message ?? e).slice(0, 200) });
    }
  }

  // 3. Cache gate. Dropping text in the middle of the prefix makes the next request rewrite
  // the cache after that point (1.25x) instead of reading it (0.1x). Drop only when the
  // saving over the next turns pays for that rewrite: dropped * 0.1 * turns > tail * 1.15.
  const stale = old.filter((r) => state.stale[r.id]);
  if (!stale.length) return changed;
  const dropChars = stale.reduce((a, r) => a + r.text.length, 0);
  const first = Math.min(...stale.map((r) => r.msg));
  const tailChars = JSON.stringify(msgs.slice(first)).length;
  const turns = Number(env.COMPACTIO_SWEEP_TURNS ?? 30);
  if (dropChars * 0.1 * turns < tailChars * 1.15) return changed;

  for (const r of stale) {
    const id = randomUUID().slice(0, 8);
    store.saveOriginal(id, r.text);
    const tomb = `[compactio: the output of ${r.input} was removed because the current goal no longer needs it. Full output: node "${cliPath()}" show ${id}. Or run the tool again.]`;
    r.block.content = tomb;
    state.dropped[r.id] = tomb;
    delete state.stale[r.id];
    store.log({ ts: new Date().toISOString(), sid, tool: r.tool, engine: "sweep", level: "tombstone", before: r.text.length, after: tomb.length, ms: 0 });
  }
  return { body: true, state: true };
}

export const HEALTH = "/_compactio/health";
export const QUIT = "/_compactio/quit";
const MESSAGES = /^\/v1\/messages(\/count_tokens)?(\?|$)/;
const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "accept-encoding", "keep-alive"]);

export function serve(port: number, env: Record<string, string | undefined> = process.env): Server {
  const upstream = (env.COMPACTIO_UPSTREAM ?? "https://api.anthropic.com").replace(/\/$/, "");
  const state = store.loadSweep();
  const server = createServer(async (req, res) => {
    if (req.url === HEALTH) return void res.end("ok");
    // The custom header makes a browser send a CORS preflight first, which fails: web pages cannot stop the proxy.
    if (req.url === QUIT && req.method === "POST" && req.headers["x-compactio"] === "quit") {
      return void res.end("bye", () => process.exit(0));
    }
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: Buffer | undefined = chunks.length ? Buffer.concat(chunks) : undefined;
      const url = req.url ?? "/";
      if (req.method === "POST" && body && MESSAGES.test(url)) {
        // Fail open: any error here forwards the original body.
        try {
          const json = JSON.parse(body.toString("utf8"));
          const c = await sweep(json, state, env, { askJev: !url.includes("count_tokens") });
          if (c.state) store.saveSweep(state);
          if (c.body) body = Buffer.from(JSON.stringify(json));
        } catch (e) {
          process.stderr.write(`compactio sweep: ${(e as Error).message ?? e}\n`);
        }
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
      const up = await fetch(upstream + url, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
      const out: Record<string, string> = {};
      up.headers.forEach((v, k) => {
        if (!HOP.has(k) && k !== "content-encoding") out[k] = v;
      });
      res.writeHead(up.status, out);
      if (up.body) Readable.fromWeb(up.body as any).pipe(res);
      else res.end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `compactio proxy: ${(e as Error).message ?? e}` } }));
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}
