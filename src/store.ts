// Local state under ~/.compactio: original outputs, read hashes, decision log.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const home = () => process.env.COMPACTIO_HOME ?? join(homedir(), ".compactio");

function dir(...parts: string[]): string {
  const d = join(home(), ...parts);
  mkdirSync(d, { recursive: true });
  return d;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

// ponytail: originals are never pruned; add an age-based sweep when the folder gets big.
export function saveOriginal(id: string, text: string): void {
  writeFileSync(join(dir("store"), `${safe(id)}.txt`), text);
}

export function loadOriginal(id: string): string | undefined {
  const f = join(home(), "store", `${safe(id)}.txt`);
  return existsSync(f) ? readFileSync(f, "utf8") : undefined;
}

type Session = { goal?: string; reads: Record<string, string> };

export function loadSession(sid: string): Session {
  const f = join(dir("sessions"), `${safe(sid)}.json`);
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return { reads: {} };
  }
}

export function saveSession(sid: string, s: Session): void {
  writeFileSync(join(dir("sessions"), `${safe(sid)}.json`), JSON.stringify(s));
}

export function clearReads(sid: string): void {
  const s = loadSession(sid);
  s.reads = {};
  saveSession(sid, s);
}

// Sweep decisions, keyed by tool_use id (unique across conversations).
// dropped: id -> tombstone text. stale: Jev said drop, waiting for the cache gate. kept: id -> message count at decision.
// ponytail: never pruned; drop ids older than N days when the file gets big.
export type SweepState = { dropped: Record<string, string>; stale: Record<string, 1>; kept: Record<string, number> };

export function loadSweep(): SweepState {
  try {
    return { dropped: {}, stale: {}, kept: {}, ...JSON.parse(readFileSync(join(home(), "sweep.json"), "utf8")) };
  } catch {
    return { dropped: {}, stale: {}, kept: {} };
  }
}

export function saveSweep(s: SweepState): void {
  writeFileSync(join(dir(), "sweep.json"), JSON.stringify(s));
}

export type LogEntry = {
  ts: string;
  sid: string;
  tool: string;
  engine: "jev" | "local" | "dedupe" | "lossless" | "fail-open" | "sweep";
  level: string;
  before: number;
  after: number;
  ms: number;
  jevTokens?: number;
  error?: string;
};

export function log(e: LogEntry): void {
  appendFileSync(join(dir(), "log.jsonl"), JSON.stringify(e) + "\n");
}

export function readLog(): LogEntry[] {
  const f = join(home(), "log.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

