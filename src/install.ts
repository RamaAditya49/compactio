// `compactio sweep on|off|status`: run the Sweep proxy as a systemd user service
// and point Claude Code at it, in one step.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./store.ts";
import { HEALTH } from "./sweep.ts";

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

async function healthy(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}${HEALTH}`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
}

export async function on(port = PORT): Promise<string> {
  if (process.platform !== "linux") throw new Error("sweep on needs systemd (Linux). Run `compactio proxy` yourself and set ANTHROPIC_BASE_URL.");
  // Copy the code out of the plugin cache: a plugin update must not break the service.
  const bin = join(store.home(), "bin");
  mkdirSync(bin, { recursive: true });
  const src = dirname(fileURLToPath(import.meta.url));
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  for (const f of readdirSync(src).filter((f) => f.endsWith(ext))) copyFileSync(join(src, f), join(bin, f));
  mkdirSync(dirname(unitFile()), { recursive: true });
  writeFileSync(unitFile(), unit(process.execPath, join(bin, `cli${ext}`), port));
  systemctl("daemon-reload");
  systemctl("enable", "--now", UNIT);
  systemctl("restart", UNIT);
  // Point Claude Code at the proxy only when the proxy answers. Otherwise Claude Code cannot reach the API.
  for (let i = 0; i < 20 && !(await healthy(port)); i++) await new Promise((r) => setTimeout(r, 250));
  if (!(await healthy(port))) throw new Error(`the proxy did not start. See: journalctl --user -u ${UNIT}`);
  writeSettings(withEnv(readSettings(), ENV(port)));
  return `Sweep is on: proxy on 127.0.0.1:${port}, Claude Code settings updated. Restart Claude Code sessions to use it.`;
}

export function off(): string {
  // Settings first, so that no new session points at a stopped proxy.
  writeSettings(withoutEnv(readSettings(), ENV(PORT)));
  try {
    systemctl("disable", "--now", UNIT);
  } catch {}
  rmSync(unitFile(), { force: true });
  try {
    systemctl("daemon-reload");
  } catch {}
  return "Sweep is off. Restart Claude Code sessions that are still open.";
}

export async function status(port = PORT): Promise<string> {
  const env = readSettings().env ?? {};
  const up = await healthy(port);
  const set = env.ANTHROPIC_BASE_URL === ENV(port).ANTHROPIC_BASE_URL;
  const warn = set && !up ? "\nWARNING: Claude Code points at the proxy, but the proxy does not answer. Run `compactio sweep on` or `compactio sweep off`." : "";
  return `proxy ${up ? "running" : "stopped"} on 127.0.0.1:${port} · Claude Code settings ${set ? "point at it" : "do not point at it"}${warn}`;
}
