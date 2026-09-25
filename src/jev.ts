// Jev (TypeSafe AI) as the System 1 engine: typed answers, no generation.
import type { Level } from "./filters.ts";

export const JEV_PRICE_PER_TOKEN = 0.042 / 1_000_000;

const CRITERIA: Record<Level, string> = {
  full: "The agent needs the exact, complete output: it will read, quote, or edit specific details from it, or the output is the main answer to the goal.",
  errors: "Only the errors, failures, and warnings matter. The other lines are routine noise.",
  headtail: "The start and the end of the output are enough to know what happened.",
  stub: "The output is not relevant to the goal. One line that says the tool ran is enough.",
};

export type Decision = { level: Level; confidence: number; inputTokens: number };

export async function decide(state: unknown, levels: Level[], opts: { key: string; timeoutMs: number }): Promise<Decision> {
  const criteria = Object.fromEntries(levels.map((l) => [l, CRITERIA[l]]));
  const res = await fetch(process.env.COMPACTIO_JEV_URL ?? "https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${opts.key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.COMPACTIO_JEV_MODEL ?? "jev-1.13.0",
      state,
      questions: {
        keep: {
          type: "choice",
          instructions:
            "A coding agent ran a tool while it works on `goal`. How much of the tool output must the agent keep in its context to continue the task?",
          criteria,
        },
      },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) throw new Error(`jev http ${res.status}`);
  const body = (await res.json()) as { answers: { keep: { choice: Level; confidence: number } }; usage?: { input_tokens?: number } };
  const a = body.answers.keep;
  if (!levels.includes(a.choice)) throw new Error(`jev unknown choice ${a.choice}`);
  return { level: a.choice, confidence: a.confidence, inputTokens: body.usage?.input_tokens ?? 0 };
}
