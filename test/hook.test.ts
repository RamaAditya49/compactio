import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.COMPACTIO_HOME = mkdtempSync(join(tmpdir(), "compactio-"));
const { postTool, prompt } = await import("../src/hook.ts");
const store = await import("../src/store.ts");

const bash = (stdout: string, command = "npm test") => ({
  session_id: "s1",
  tool_name: "Bash",
  tool_input: { command },
  tool_response: { stdout, stderr: "", interrupted: false, isImage: false },
});
const big = (n: number, line = "PASS test/some.spec.ts") => Array.from({ length: n }, (_, i) => `${line} ${i}`).join("\n");

// A fake Jev that answers with a fixed choice and records the request.
async function fakeJev(choice: string, confidence = 0.9) {
  const seen: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ ...JSON.parse(body), headers: req.headers });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ answers: { keep: { type: "choice", choice, confidence } }, usage: { input_tokens: 800 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/v1/systemone`;
  return { url, seen, close: () => server.close() };
}

test("small output passes untouched", async () => {
  assert.equal(await postTool(bash("hello"), {}), undefined);
});

test("without a key, huge output becomes head+tail and the original is stored", async () => {
  const out: any = await postTool(bash(big(3000)), {});
  const stdout = out.hookSpecificOutput.updatedToolOutput.stdout as string;
  assert.ok(stdout.length < 5000);
  assert.equal(out.hookSpecificOutput.updatedToolOutput.isImage, false);
  const id = stdout.match(/show (\w+)\]$/)![1];
  assert.equal(store.loadOriginal(id), big(3000));
});

test("Jev choice is applied, and secrets are redacted before sending", async () => {
  const jev = await fakeJev("errors");
  prompt({ session_id: "s1", tool_name: "", prompt: "fix the failing test, TOKEN=supersecret1" });
  const lines = big(500).split("\n");
  lines[200] = "FAIL test/db.spec.ts: Error: connection refused";
  const out: any = await postTool(bash(lines.join("\n")), { TYPESAFE_API_KEY: "k", COMPACTIO_JEV_URL: jev.url });
  jev.close();
  const stdout = out.hookSpecificOutput.updatedToolOutput.stdout as string;
  assert.match(stdout, /connection refused/);
  assert.ok(!stdout.includes("PASS test/some.spec.ts 100\n"));
  const sent = JSON.stringify(jev.seen[0]);
  assert.ok(!sent.includes("supersecret1"));
  assert.deepEqual(Object.keys(jev.seen[0].questions.keep.criteria), ["full", "errors", "headtail", "stub"]);
});

test("OpenRouter key: Decisions endpoint, OpenRouter model name, compactio attribution", async () => {
  const jev = await fakeJev("headtail");
  const out: any = await postTool(bash(big(500)), { OPENROUTER_API_KEY: "sk-or-x", COMPACTIO_JEV_URL: jev.url });
  jev.close();
  assert.match(out.hookSpecificOutput.updatedToolOutput.stdout, /kept "headtail"/);
  const req = jev.seen[0];
  assert.equal(req.model, "~typesafe/jev-latest");
  assert.equal(req.headers["authorization"], "Bearer sk-or-x");
  assert.equal(req.headers["x-openrouter-title"], "compactio");
  assert.equal(req.headers["http-referer"], "https://github.com/RamaAditya49/compactio");
});

test("low confidence keeps the full output", async () => {
  const jev = await fakeJev("stub", 0.3);
  const text = big(500);
  const out: any = await postTool(bash(text), { TYPESAFE_API_KEY: "k", COMPACTIO_JEV_URL: jev.url });
  jev.close();
  assert.equal(out, undefined);
});

test("a Jev failure fails open", async () => {
  const text = big(500);
  const out = await postTool(bash(text), { TYPESAFE_API_KEY: "k", COMPACTIO_JEV_URL: "http://127.0.0.1:1/x" });
  assert.equal(out, undefined);
  assert.equal(store.readLog().at(-1)!.engine, "fail-open");
});

test("Read: second identical read is skipped, third comes back in full", async () => {
  const content = big(200, "const x = 1;");
  const read = {
    session_id: "s2",
    tool_name: "Read",
    tool_input: { file_path: "/a.ts" },
    tool_response: { type: "text", file: { filePath: "/a.ts", content, numLines: 200, startLine: 1, totalLines: 200 } },
  };
  assert.equal(await postTool(read, {}), undefined);
  const second: any = await postTool(read, {});
  assert.match(second.hookSpecificOutput.updatedToolOutput.file.content, /unchanged/);
  assert.equal(second.hookSpecificOutput.updatedToolOutput.file.filePath, "/a.ts");
  assert.equal(await postTool(read, {}), undefined);
});

test("Read of a saved Claude Code tool output is filtered like Bash", async () => {
  const content = big(3000);
  const read = {
    session_id: "s3",
    tool_name: "Read",
    tool_input: { file_path: "/home/u/.claude/projects/p/abc/tool-results/x.txt" },
    tool_response: { type: "text", file: { filePath: "/x", content, numLines: 3000, startLine: 1, totalLines: 3000 } },
  };
  const out: any = await postTool(read, {});
  assert.match(out.hookSpecificOutput.updatedToolOutput.file.content, /kept "headtail"/);
});

test("compactio's own show command is never filtered", async () => {
  assert.equal(await postTool(bash(big(3000), "node cli.ts show abc # compactio"), {}), undefined);
});

test("Read of a data file (log, lockfile) is filtered like Bash", async () => {
  const content = big(3000);
  const read = {
    session_id: "s4",
    tool_name: "Read",
    tool_input: { file_path: "/repo/build/output.log" },
    tool_response: { type: "text", file: { filePath: "/repo/build/output.log", content, numLines: 3000, startLine: 1, totalLines: 3000 } },
  };
  const out: any = await postTool(read, {});
  assert.match(out.hookSpecificOutput.updatedToolOutput.file.content, /kept "headtail"/);
});

test("Read of an image passes untouched and is not counted", async () => {
  const n = store.readLog().length;
  const read = {
    session_id: "s5",
    tool_name: "Read",
    tool_input: { file_path: "/a.png" },
    tool_response: { type: "image", file: { base64: "A".repeat(500_000), type: "image/png", originalSize: 375_000 } },
  };
  assert.equal(await postTool(read, {}), undefined);
  assert.equal(store.readLog().length, n);
});
