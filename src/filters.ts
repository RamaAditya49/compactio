// Filters that code can run without a model. `lossless` keeps every fact;
// the level filters drop lines on purpose and are chosen by the engine.

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07/g;
const ERROR_LINE = /\b(error|errors|fail|failed|failure|panic|exception|traceback|fatal|warn|warning|denied|not found|cannot|undefined)\b|✗|✘|×/i;

export type Level = "full" | "errors" | "headtail" | "stub";

export function lossless(text: string): string {
  const lines = text.replace(ANSI, "").replace(/\r(?!\n)/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const n = j - i;
    if (n > 2) out.push(lines[i], `[… same line repeated ${n - 1} more times]`);
    else for (let k = i; k < j; k++) out.push(lines[k]);
    i = j;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function headTail(text: string, head = 40, tail = 30): string {
  const lines = text.split("\n");
  if (lines.length <= head + tail) return text;
  const cut = lines.length - head - tail;
  return [...lines.slice(0, head), `[… ${cut} lines cut …]`, ...lines.slice(-tail)].join("\n");
}

// Error lines with 2 lines of context, plus the tail (summaries live there).
export function errorsOnly(text: string, context = 2, tail = 15, max = 200): string {
  const lines = text.split("\n");
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (!ERROR_LINE.test(l)) return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep.add(k);
  });
  for (let k = Math.max(0, lines.length - tail); k < lines.length; k++) keep.add(k);
  const out: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b).slice(0, max)) {
    if (i > last + 1) out.push(`[… ${i - last - 1} lines cut …]`);
    out.push(lines[i]);
    last = i;
  }
  if (last < lines.length - 1) out.push(`[… ${lines.length - 1 - last} lines cut …]`);
  return out.join("\n");
}

export function hasErrors(text: string): boolean {
  return ERROR_LINE.test(text);
}

export function stub(text: string): string {
  const lines = text.split("\n");
  return `[${lines.length} lines, first: ${JSON.stringify(lines[0]?.slice(0, 120) ?? "")}]`;
}

export function apply(level: Level, text: string): string {
  if (level === "errors") return errorsOnly(text);
  if (level === "headtail") return headTail(text);
  if (level === "stub") return stub(text);
  return text;
}

// A short, bounded view of the output for the decision engine.
export function preview(text: string, budget = 6000): { lines: number; head: string; errors: string; tail: string } {
  const lines = text.split("\n");
  const third = Math.floor(budget / 3);
  const errs = lines.filter((l) => ERROR_LINE.test(l)).join("\n");
  return {
    lines: lines.length,
    head: lines.slice(0, 30).join("\n").slice(0, third),
    errors: errs.slice(0, third),
    tail: lines.slice(-20).join("\n").slice(-third),
  };
}
