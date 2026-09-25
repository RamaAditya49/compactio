// `compactio sweep on|off|status`: run the Sweep proxy as a systemd user service
// and point Claude Code at it, in one step.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./store.ts";
import { HEALTH, QUIT } from "./sweep.ts";

export const PORT = 8787;
const UNIT = "compactio-proxy.service";

// Behind a custom base URL, Claude Code does not know the model's window and compacts in a
// loop. The "[1m]" suffix tells it the window. Mapping the opus alias keeps the model picker.
// ponytail: pinned to Opus 5.5; update when a new Opus ships.
export const ENV = (port: number) => ({
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5[1m]",
});

const settingsFile = () => join(homedir(), ".claude", "settings.json");
const unitFile = () => join(homedir(), ".config", "systemd", "user", UNIT);

// The base URL is ours. A model mapping the user set stays.
export function withEnv(settings: any, env: Record<string, string>): any {
  return { ...settings, env: { ...env, ...(settings.env ?? {}), ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL } };
}

// Remove only the values that are still ours.
export function withoutEnv(settings: any, env: Record<string, string>): any {
  const out = { ...(settings.env ?? {}) };
  for (const [k, v] of Object.entries(env)) if (out[k] === v) delete out[k];
  return { ...settings, env: out };
}

export function unit(node: string, cli: string, port: number): string {
  return `[Unit]
Description=compactio Sweep proxy for Claude Code

[Service]
ExecStart=${node} ${cli} proxy ${port}
Restart=always
RestartSec=1

[Install]
WantedBy=default.target
`;
}

function readSettings(): any {
  const f = settingsFile();
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
}

function writeSettings(s: any): void {
  const f = settingsFile();
  if (existsSync(f)) copyFileSync(f, `${f}.compactio-bak`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
}

const systemctl = (...args: string[]) => execFileSync("systemctl", ["--user", ...args], { stdio: "pipe" }).toString();

const binDir = () => join(store.home(), "bin");
const binCli = () => ["cli.ts", "cli.js"].map((f) => join(binDir(), f)).find(existsSync);

export async function healthy(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}${HEALTH}`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
}

// Without systemd, run the proxy as a background process. The SessionStart hook starts it again when it stops.
function startDetached(port: number): void {
  const cli = binCli();
  if (cli) spawn(process.execPath, [cli, "proxy", String(port)], { detached: true, stdio: "ignore" }).unref();
}

async function waitHealthy(port: number, ms: number): Promise<boolean> {
  for (let t = 0; t < ms && !(await healthy(port)); t += 250) await new Promise((r) => setTimeout(r, 250));
  return healthy(port);
}

// SessionStart guard: when Claude Code points at our proxy and the proxy is down, start it.
// Returns a message for the user only when the proxy still does not answer.
export async function ensure(env: Record<string, string | undefined> = process.env): Promise<string | undefined> {
  const port = Number(env.ANTHROPIC_BASE_URL?.match(/^http:\/\/127\.0\.0\.1:(\d+)\/?$/)?.[1]);
  if (!port || !binCli() || (await healthy(port))) return;
  try {
    if (process.platform === "linux") systemctl("start", UNIT);
  } catch {}
  if (!(await waitHealthy(port, 1500))) startDetached(port);
  if (await waitHealthy(port, 2500)) return;
  return `compactio: the Sweep proxy does not start, so Claude Code cannot reach the API. To fix it, run this in a terminal: node "${binCli()}" sweep off`;
}

export async function on(port = PORT): Promise<string> {
  // Copy the code out of the plugin cache: a plugin update must not break the service.
  const bin = binDir();
  mkdirSync(bin, { recursive: true });
  const src = dirname(fileURLToPath(import.meta.url));
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  for (const f of readdirSync(src).filter((f) => f.endsWith(ext))) copyFileSync(join(src, f), join(bin, f));
  writeFileSync(join(bin, "package.json"), '{ "type": "module" }\n');
  if (process.platform === "linux") {
    mkdirSync(dirname(unitFile()), { recursive: true });
    writeFileSync(unitFile(), unit(process.execPath, join(bin, `cli${ext}`), port));
    systemctl("daemon-reload");
    systemctl("enable", "--now", UNIT);
    systemctl("restart", UNIT);
  } else if (!(await healthy(port))) {
    startDetached(port);
  }
  // Point Claude Code at the proxy only when the proxy answers. Otherwise Claude Code cannot reach the API.
  if (!(await waitHealthy(port, 5000))) throw new Error("the proxy did not start. Nothing was changed in the Claude Code settings.");
  writeSettings(withEnv(readSettings(), ENV(port)));
  return `Sweep is on: proxy on 127.0.0.1:${port}, Claude Code settings updated. Restart Claude Code sessions to use it.`;
}

export function off(): string {
  // Settings first, so that no new session points at a stopped proxy.
  writeSettings(withoutEnv(readSettings(), ENV(PORT)));
  try {
    systemctl("disable", "--now", UNIT);
    rmSync(unitFile(), { force: true });
    systemctl("daemon-reload");
  } catch {}
  // A proxy started without systemd: ask it to exit.
  fetch(`http://127.0.0.1:${PORT}${QUIT}`, { method: "POST", headers: { "x-compactio": "quit" }, signal: AbortSignal.timeout(500) }).catch(() => {});
  return "Sweep is off. Restart Claude Code sessions that are still open.";
}

// The Claude desktop app sets its own API address for its sessions, over the settings file.
export function desktopNote(env: Record<string, string | undefined> = process.env, port = PORT): string {
  const ours = ENV(port).ANTHROPIC_BASE_URL;
  if (env.CLAUDE_CODE_ENTRYPOINT !== "claude-desktop" || !env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL === ours) return "";
  return "\nNote: the Claude desktop app sets its own API address, so the Sweep does not run in desktop sessions. It runs in `claude` sessions in a terminal. The filter runs in both.";
}

export async function status(port = PORT): Promise<string> {
  const env = readSettings().env ?? {};
  const up = await healthy(port);
  const set = env.ANTHROPIC_BASE_URL === ENV(port).ANTHROPIC_BASE_URL;
  const warn = set && !up ? "\nWARNING: Claude Code points at the proxy, but the proxy does not answer. Run `compactio sweep on` or `compactio sweep off`." : "";
  return `proxy ${up ? "running" : "stopped"} on 127.0.0.1:${port} · Claude Code settings ${set ? "point at it" : "do not point at it"}${warn}${desktopNote()}`;
}

// The Jev key: from the environment (Claude Code passes its settings env to commands) or the settings file.
function jevKey(): string | undefined {
  const env = readSettings().env ?? {};
  return process.env.TYPESAFE_API_KEY || process.env.OPENROUTER_API_KEY || env.TYPESAFE_API_KEY || env.OPENROUTER_API_KEY;
}

export function keyEnv(key: string): Record<string, string> {
  return key.startsWith("sk-or-") ? { OPENROUTER_API_KEY: key } : { TYPESAFE_API_KEY: key };
}

// `compactio key`: ask for the key without showing it, then save it in the Claude Code settings.
export async function key(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = (rl as any)._writeToOutput.bind(rl);
  let muted = false;
  (rl as any)._writeToOutput = (s: string) => (muted ? undefined : write(s));
  const answer = await new Promise<string>((r) => {
    rl.question("Paste your TypeSafe or OpenRouter API key (hidden): ", r);
    muted = true;
  });
  rl.close();
  process.stdout.write("\n");
  const k = answer.trim();
  if (k.length < 16) throw new Error("that does not look like an API key. Nothing was saved.");
  writeSettings({ ...readSettings(), env: { ...(readSettings().env ?? {}), ...keyEnv(k) } });
  return "Key saved. Next, run /compactio:setup in Claude Code.";
}

// `compactio setup`: the one step for users. The filter works now; the Sweep needs a Jev key.
export async function setup(): Promise<string> {
  if (!jevKey()) {
    return [
      "compactio filter: on (local mode, no key).",
      "To let Jev decide and to turn on the Sweep, you need one API key:",
      "  1. Get a key: https://console.typesafe.ai/keys or https://openrouter.ai/keys",
      "  2. In a terminal, run: npx compactio key   (the key stays hidden and is saved in your Claude Code settings)",
      "  3. Run /compactio:setup again.",
    ].join("\n");
  }
  return `compactio filter: on, decisions by Jev.\n${await on()}${desktopNote()}`;
}
