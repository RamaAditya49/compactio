import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.COMPACTIO_HOME = mkdtempSync(join(tmpdir(), "compactio-sweep-"));
const { serve, sweep, PROTECT_MESSAGES } = await import("../src/sweep.ts");
const store = await import("../src/store.ts");

const big = (n: number, line = "PASS test/some.spec.ts") => Array.from({ length: n }, (_, i) => `${line} ${i}`).join("\n");
const fresh = (): store.SweepState => ({ dropped: {}, stale: {}, kept: {} });

// A conversation: one old tool call per entry of `outputs`, then filler turns, then the last prompt.
function convo(outputs: string[], tailText = "ok") {
  const messages: any[] = [{ role: "user", content: [{ type: "text", text: "fix the failing test" }] }];
  outputs.forEach((out, i) => {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `toolu_${i}`, name: "Bash", input: { command: `npm test ${i}` } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: out, cache_control: { type: "ephemeral" } }] });
  });
  for (let i = 0; i < PROTECT_MESSAGES; i++) messages.push({ role: i % 2 ? "user" : "assistant", content: [{ type: "text", text: tailText }] });
  messages.push({ role: "user", content: [{ type: "text", text: "now write the README" }] });
  return { model: "claude-x", messages, metadata: { user_id: "user_abc_account_x_session_11111111-2222-3333-4444-555555555555" } };
}

// A fake Jev that answers every question with the same choice.
async function fakeJev(choice: string, confidence = 0.95) {
  const seen: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const q = JSON.parse(body);
      seen.push(q);
      const answers = Object.fromEntries(Object.keys(q.questions).map((k) => [k, { type: "choice", choice, confidence }]));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ answers, usage: { input_tokens: 900 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/v1/systemone`;
  return { url, seen, close: () => server.close() };
}

test("a stale old result becomes a tombstone, and the tombstone replays without Jev", async () => {
  const jev = await fakeJev("drop");
  const state = fresh();
  const body: any = convo([big(3000)]);
  const c = await sweep(body, state, { TYPESAFE_API_KEY: "k", COMPACTIO_JEV_URL: jev.url });
  jev.close();
  assert.deepEqual(c, { body: true, state: true });
  const block = body.messages[2].content[0];
  assert.match(block.content, /removed because the current goal no longer needs it/);
  assert.deepEqual(block.cache_control, { type: "ephemeral" });
  assert.equal(block.tool_use_id, "toolu_0");
  assert.equal(jev.seen[0].state.goal, "now write the README");
  const id = block.content.match(/show (\w+)\./)![1];
  assert.equal(store.loadOriginal(id), big(3000));

  // Next request: same history. The tombstone must come back byte for byte, with no Jev call.
  const again: any = convo([big(3000)]);
  const c2 = await sweep(again, state, {});
  assert.equal(c2.body, true);
  assert.equal(again.messages[2].content[0].content, block.content);
});

test("results in the protected tail are never swept", async () => {
  const jev = await fakeJev("drop");
  const body: any = convo([]);
  body.messages.splice(-2, 0,
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_new", name: "Bash", input: { command: "ls" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_new", content: big(3000) }] });
  const c = await sweep(body, fresh(), { TYPESAFE_API_KEY: "k", COMPACTIO_JEV_URL: jev.url });
  jev.close();
  assert.equal(jev.seen.length, 0);
  assert.equal(c.body, false);
});

test("keep answers and low confidence leave the history alone", async () => {
  for (const [choice, conf] of [["keep", 0.95], ["drop", 0.5]] as const) {
    const jev = await fakeJev(choice, conf);
    const state = fresh();
    const body: any = convo([big(3000)]);
    const c = await sweep(body, state, { TYPESAFE_API_KEY: "k", COMPACTIO_JEV_URL: jev.url });
    jev.close();
    assert.equal(c.body, false);
    assert.equal(state.kept.toolu_0, body.messages.length);
    // Kept results are not asked again on the next request.
    const jev2 = await fakeJev("drop");
    await sweep(convo([big(3000)]), state, { TYPESAFE_API_KEY: "k", COMPACTIO_JEV_URL: jev2.url });
    jev2.close();
    assert.equal(jev2.seen.length, 0);
  }
});

test("cache gate: a small drop before a big tail waits, and Jev is not asked twice", async () => {
  const jev = await fakeJev("drop");
  const state = fresh();
  const env = { TYPESAFE_API_KEY: "k", COMPACTIO_JEV_URL: jev.url };
  const body: any = convo([big(1000), big(1000)], big(2000, "long assistant text"));
  const c = await sweep(body, state, env);
  assert.equal(c.body, false);
  assert.deepEqual(Object.keys(state.stale).sort(), ["toolu_0", "toolu_1"]);
  await sweep(convo([big(1000), big(1000)], big(2000, "long assistant text")), state, env);
  jev.close();
  assert.equal(jev.seen.length, 1);
  // With a longer horizon, the same drop pays for the cache rewrite.
  const later: any = convo([big(1000), big(1000)], big(2000, "long assistant text"));
  const c2 = await sweep(later, state, { COMPACTIO_SWEEP_TURNS: "400" });
  assert.equal(c2.body, true);
  assert.match(later.messages[2].content[0].content, /removed/);
});

test("a Jev failure changes nothing", async () => {
  const body: any = convo([big(3000)]);
  const c = await sweep(body, fresh(), { TYPESAFE_API_KEY: "k", COMPACTIO_JEV_URL: "http://127.0.0.1:1/x" });
  assert.deepEqual(c, { body: false, state: false });
  assert.equal(body.messages[2].content[0].content, big(3000));
});

test("proxy forwards headers and streams the answer, with tombstones applied", async () => {
  const got: any[] = [];
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: {}\n\n");
      res.end("event: message_stop\ndata: {}\n\n");
    });
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  const jev = await fakeJev("drop");
  const proxy = serve(0, { TYPESAFE_API_KEY: "k", COMPACTIO_JEV_URL: jev.url, COMPACTIO_UPSTREAM: `http://127.0.0.1:${(upstream.address() as any).port}` });
  await new Promise((r) => proxy.once("listening", r));
  const res = await fetch(`http://127.0.0.1:${(proxy.address() as any).port}/v1/messages?beta=true`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-ant-test", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(convo([big(3000, "proxy line")])),
  });
  const text = await res.text();
  proxy.close();
  upstream.close();
  jev.close();
  assert.equal(res.status, 200);
  assert.match(text, /message_stop/);
  assert.equal(got[0].url, "/v1/messages?beta=true");
  assert.equal(got[0].headers["x-api-key"], "sk-ant-test");
  assert.match(got[0].body.messages[2].content[0].content, /removed/);
  assert.match(JSON.stringify(store.loadSweep().dropped), /removed/);
});

test("sweep on/off edits only its own settings keys, and the unit runs the copied CLI", async () => {
  const { withEnv, withoutEnv, unit, ENV } = await import("../src/install.ts");
  const before = { model: "opus", env: { TYPESAFE_API_KEY: "k" }, hooks: {} };
  const on = withEnv(before, ENV(8787));
  assert.equal(on.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787");
  assert.equal(on.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "claude-opus-5-5[1m]");
  assert.equal(on.env.TYPESAFE_API_KEY, "k");
  assert.equal(on.model, "opus");
  assert.deepEqual(withoutEnv(on, ENV(8787)), before);
  // A model mapping the user set is kept on "on" and on "off".
  const own = withEnv({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "my-opus" } }, ENV(8787));
  assert.equal(own.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "my-opus");
  assert.deepEqual(withoutEnv(own, ENV(8787)).env, { ANTHROPIC_DEFAULT_OPUS_MODEL: "my-opus" });
  assert.match(unit("/usr/bin/node", "/h/.compactio/bin/cli.js", 8787), /ExecStart=\/usr\/bin\/node \/h\/.compactio\/bin\/cli.js proxy 8787\nRestart=always/);
});

test("proxy answers its health check without the upstream", async () => {
  const { HEALTH } = await import("../src/sweep.ts");
  const proxy = serve(0, { COMPACTIO_UPSTREAM: "http://127.0.0.1:1" });
  await new Promise((r) => proxy.once("listening", r));
  const res = await fetch(`http://127.0.0.1:${(proxy.address() as any).port}${HEALTH}`);
  proxy.close();
  assert.equal(await res.text(), "ok");
});

test("quit without the compactio header is forwarded, not obeyed", async () => {
  const { QUIT } = await import("../src/sweep.ts");
  const proxy = serve(0, { COMPACTIO_UPSTREAM: "http://127.0.0.1:1" });
  await new Promise((r) => proxy.once("listening", r));
  const res = await fetch(`http://127.0.0.1:${(proxy.address() as any).port}${QUIT}`, { method: "POST" });
  proxy.close();
  assert.equal(res.status, 502);
});

test("the session guard stays quiet when Claude Code does not use the proxy", async () => {
  const { ensure, keyEnv } = await import("../src/install.ts");
  assert.equal(await ensure({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }), undefined);
  assert.equal(await ensure({}), undefined);
  assert.deepEqual(keyEnv("sk-or-v1-abc"), { OPENROUTER_API_KEY: "sk-or-v1-abc" });
  assert.deepEqual(keyEnv("ts-abc"), { TYPESAFE_API_KEY: "ts-abc" });
});
