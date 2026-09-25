# compactio: Blueprint

> **System 1 for your coding agent.**
> The LLM thinks. compactio decides. Code executes.

Status: blueprint v1.1 · 25 Sep 2026 · default engine: Jev (TypeSafe AI) · v0.1 shipped for Claude Code

---

## 1. The idea in one paragraph

Daniel Kahneman splits the mind into two systems. **System 1** is fast, cheap, and automatic.
**System 2** is slow, expensive, and deliberate. Coding agents today use System 2 for everything.
They carry every tool output into every turn. They drop context only when the window is almost
full, and they drop it with one expensive summary prompt. compactio puts a **System 1** in front
of the LLM. A decision model answers each small question in milliseconds: "Does the agent still
need this output?", "Did the agent already read this file?", "Does this task need a generative
model at all?". The LLM receives only what it needs.

---

## 2. The problem, with evidence

| Problem | Evidence |
|---|---|
| Tool output fills the context | Tool results are **49.7%** of a Claude Code context (ctxlens profile). A Playwright snapshot is 56 KB. 20 GitHub issues are 59 KB (context-mode). |
| Each token is paid again on each turn | **97.2%** of billed tokens are cache reads (165.9M-token sample, devxlabs.ai). A stale token is billed on every later turn. |
| Compaction comes late and costs a lot | Claude Code docs: `/compact` "is itself a large request". Auto-compact starts only near the limit. |
| Quality drops after compaction | claude-code issues #6354, #9796, #32678: CLAUDE.md and rules get lost. |
| Agents read the same file again | Issues #11487 (re-read loop), #72417 (thousands of tokens lost). |
| Long context lowers quality | Chroma "Context Rot": 18 LLMs get worse as input gets longer. |
| Quotas run out fast | claude-code #16157 (1,497 comments), #38335. codex #14593 (630 comments). |

**Root cause:** agents have no System 1. A big model or a fixed rule makes every small decision.

---

## 3. Competitors and their gaps

| Tool | Mechanism | Gap |
|---|---|---|
| **rtk** (81.7k ★) | A PreToolUse hook rewrites Bash commands. Fixed rules for each command. | It does not filter `Read`, `Grep`, `Glob`. The rules do not know the current task. |
| **fast-jev-compaction** (6.8k ★) | Replaces the compaction summary with Jev decisions (2 `noul` questions per tool call). | See the defect table below. |
| caveman (107k ★), ponytail (145k ★) | Prompts or skills that make output shorter. | Prompt only. They do not touch tool output. |
| context-mode (24k ★) | An MCP sandbox keeps raw output outside the context. | The LLM must choose the sandbox tools itself. |
| claude-mem (94k ★) | Compresses sessions with an LLM for later sessions. | It uses a generative LLM to summarize. |
| ~20 other Jev plugins (Codex, OpenCode, Pi, Hermes) | Copies of the "compact when full" pattern. | One host per repo. Same pattern, same defects. |

### fast-jev-compaction defects (from its own issue tracker)

| # | Defect | Evidence | compactio answer |
|---|---|---|---|
| 1 | Jev drops almost everything. A fake that answers "0 for all" gets 88.5% reduction; real Jev gets 87.7%. AUC 0.54–0.66. | #26, #52, #56 | Send a **content preview**, not a size note. Calibrate the threshold on labeled data. |
| 2 | The model invents "work done" after a call is dropped. | #65 | A **tombstone** stays where a call was dropped. |
| 3 | The saving is lost on `--resume` (28k → 166k). | #89 | Do not depend only on compaction. Filter at the source (per tool) and in the proxy. |
| 4 | The TypeSafe Cloudflare firewall rejects state with shell, SQL, or paths (HTML 403). The fallback is silent. | #97 | Redact and normalize the state. Every fallback is **visible** on the scoreboard. |
| 5 | The full history goes to a third party with no redaction. | #64, #88, #98 | Redact secrets locally before sending. |
| 6 | Claude Code only, with early-access function hooks. | #21, #76 | Standard hooks. Adapters for many hosts from day one. |

**compactio's position:** it does not make compaction faster. It makes compaction **rarely needed**.

---

## 4. Architecture: three System 1 organs

```
 user prompt
     │
     ▼
┌──────────┐  "Generative needed? Which model? Which context?"
│ 1. GATE  │──── deterministic answer / model routing
└──────────┘
     │
     ▼
   LLM (System 2) ──► tool call
                          │
                          ▼
                   ┌────────────┐  "This output: full / errors / head+tail / stub?"
                   │ 2. FILTER  │──── + skip unchanged re-reads (pure code)
                   └────────────┘
                          │
     ┌────────────────────┘
     ▼
┌──────────┐  "Which old context is stale now?"
│ 3. SWEEP │──── drop in blocks, leave tombstones, protect the prompt cache
└──────────┘
```

Division of work (the TypeSafe pattern):

- **Code** does what is exact: file hashes, re-read checks, size limits, redaction.
- **Jev** does what needs judgment: relevant or not, how much to keep, which route.
- **The LLM** only writes: plans, code, answers.

### 4.1 Filter (per tool call): the main organ, shipped in v0.1

It runs after the tool finishes and before the model sees the output.

1. **Code first.** The output goes through lossless filters: strip ANSI codes, fold repeated
   lines, fold blank runs.
2. **Skip unchanged re-reads.** Hash the file content. Same file, same range, same hash →
   `[compactio: this file is unchanged since you last read it…]`. No Jev call.
   After one such answer, the hash is forgotten, so a third identical read returns in full.
   This prevents a loop when native tool-result clearing removed the first read.
3. **Jev chooses how much to keep**, with one `choice` question:
   - `full`: the output is relevant to the current goal.
   - `errors`: keep error, failure, and warning lines with context, plus the tail.
   - `headtail`: keep the start and the end.
   - `stub`: keep one structural line.
   The state holds: the goal (last user prompt), the tool name and input, a **content preview**
   (head + error lines + tail), and the size. All of it is redacted.
4. **Low confidence → `full`.** Keeping too much costs less than dropping too much.
5. The original output stays on disk. The model can get it back with `compactio show <id>`.

Code files from `Read` are never cut, because the agent may edit them. Small outputs (< 2 KB)
pass untouched. The saving comes from big outputs.

### 4.2 Sweep (old context): v0.3

It runs every N turns, not every turn.

- Jev rates each old tool result with a 4-level `score` against the current goal.
  All questions go in **one request** (Jev answers in parallel: 13 questions in 0.27 s).
- A stale result becomes a **tombstone**:
  `[compactio: output of Read src/db.ts (turn 8) removed; run it again if needed]`.
  Assistant text that mentions the call keeps an anchor. This fixes defect #2.
- **Protect the prompt cache.** Cache reads are 97% of the bill. Removing context in the middle
  of the prefix causes a cache miss. The Sweep runs only when
  `tokens_saved × estimated_remaining_turns > cache_rewrite_cost`. It removes one big block,
  not many small pieces.
- Path per host: a local proxy (Claude Code, Codex), the `messages.transform` hook (OpenCode),
  `BeforeModel` (Gemini CLI).

### 4.3 Gate (start of each prompt): v0.4

One Jev request with parallel questions:

| Question | Type | Action |
|---|---|---|
| Does this task need a generative model? | `noul` | No → run a deterministic path (for example "run the tests", "git status") where the host allows it. |
| Which model is enough? | `choice` (fast / powerful) | The proxy routes the request to the cheaper model. |
| Which context is needed? | `choice` per pack | Add only the relevant context packs (`additionalContext`). |

The honest limit: only Gemini CLI (`BeforeModel` → `llm_response`) and proxy mode can
**skip** the model. Other hosts can only add context or block the prompt.

---

## 5. Host matrix

| Host | Filter | Sweep | Gate | Path |
|---|---|---|---|---|
| **Claude Code** | ✅ `PostToolUse.updatedToolOutput` (all tools, verified live in v0.1) | proxy | `UserPromptSubmit` + proxy | plugin `.claude-plugin` |
| **Codex CLI** | ✅ `postToolUse` `decision:block` + `reason` | proxy | `userPromptSubmit` + proxy | plugin `.codex-plugin` |
| **OpenCode** | ✅ `tool.execute.after` | ✅ `messages.transform` | `chat.message` | npm package |
| **Gemini CLI** | ✅ `AfterTool` | ✅ `BeforeModel` | ✅ can skip the model | extension |
| **Cursor** | ⚠️ command rewrite (PreToolUse) + MCP | — | — | `.cursor-plugin` |
| **Trae** | ⚠️ command rewrite | — | — | `hooks.json` |
| **ZCode, Windsurf** | ⚠️ MCP server `compactio_exec` only | — | — | MCP |

Fallback path for all hosts: **command rewrite** (`compactio run -- <cmd>`), the rtk pattern.

---

## 6. Technical decisions

| Decision | Choice | Reason |
|---|---|---|
| Language | TypeScript, run directly by Node ≥ 22.18 (type stripping). Zero dependencies. No build step. | The hook starts fast and installs with nothing. Before the npm release, compile to JS, because Node does not strip types inside `node_modules`. |
| Engine | Jev `jev-1.13.0` (pinned) through the TypeSafe API, or `~typesafe/jev-latest` through the OpenRouter Decisions endpoint (app name: compactio). | $0.042 per 1M input tokens. Output is free. |
| Request limits | State + questions ≤ 64k tokens. State + longest question ≤ 32k. | Official Jev limits. The preview is capped at ~6k characters. |
| Failure | **Fail open**: the original output passes, the event is logged, and the scoreboard shows it. | compactio must never break the agent. |
| Timeout | 1.5 s per decision, then fail open. | Far below the Claude Code hook timeout. |
| Privacy | Redact secrets (key patterns, tokens, `KEY=value`) locally. No key = local mode, code filters only. | Fixes defects #4 and #5. |
| Storage | `~/.compactio/`: original outputs, read hashes, decision log (JSONL). | Auditable. Replayable for evals. |
| Config | Environment variables with safe defaults. | Zero config to start. |

Repo layout (v0.1):

```
compactio/
  src/filters.ts   # lossless, errors, head+tail, stub, preview
  src/redact.ts    # secret masking before anything leaves the machine
  src/jev.ts       # Jev client: one choice question, timeout
  src/store.ts     # ~/.compactio: originals, read hashes, log
  src/hook.ts      # Claude Code hook entry (post-tool, prompt, reset)
  src/cli.ts       # show <id>, gain
  hooks/hooks.json, .claude-plugin/, commands/gain.md
  test/            # node --test
```

Later: `src/hosts/` (one thin adapter per host), `src/proxy/`, `eval/`.

---

## 7. Honest numbers (mandatory rule)

"Hundreds of times cheaper" is true only for the **cost per decision** (Jev vs an LLM).
A claim about the total bill must be measured end to end.

A known limit, found in v0.1: Claude Code already caps Bash output at 30,000 characters
before hooks run. The Filter saves at most ~7.5k tokens per Bash call. The saving on that
call is paid again on every later turn, so it compounds over a long session.

`compactio gain` shows, per session and in total (example output, not a measurement):

```
compactio · all sessions
  tool outputs seen          1,204
  outputs made smaller       611
  tokens kept out of context ~912,408
  Jev decisions              540   cost $0.0181
  unchanged re-reads skipped 73
  fail-open                  3
  (tokens are estimated as characters / 4)
```

Public benchmark (mandatory before launch):

- A paired A/B test on a SWE-bench Verified subset: **tokens, cost, and task success rate**.
- Compare: no plugin, rtk, fast-jev-compaction, compactio, compactio + rtk.
- The "fake answer" test: compare with the "drop all" and "head+tail" baselines.
  If compactio does not beat the baselines, make no claim.

---

## 8. Roadmap

| Version | Scope | Done when |
|---|---|---|
| **v0.1** ✅ | Claude Code: Filter (PostToolUse), unchanged re-read skip, `gain`, fail open, redaction, local mode | Installed and verified live in Claude Code 2.1.282. 11 unit tests pass. |
| **v0.2** | Codex, OpenCode, Gemini CLI + command rewrite (Cursor, Trae) + MCP fallback. Replay eval on 20 real sessions. | One install command per host. ≥ 50% fewer tool tokens, same task success. |
| **v0.3** | Sweep: local proxy (opt-in) + OpenCode/Gemini hooks + tombstones + cache guard | Auto-compact rarely runs in a 4-hour session. |
| **v0.4** | Gate: model routing + generative skip (Gemini, proxy) | Cost per task drops, task success does not. |
| **v1.0** | Public benchmark + launch | The numbers are proven and reproducible. |

---

## 9. Launch plan

**Main hook:** *"Your coding agent thinks with System 2 for everything. Give it a System 1."*

1. **15-second demo:** a real Claude Code session, `compactio gain` going up live, 1× speed.
2. **One-line install:** *"ask your agent to install compactio"*.
3. **Launch thread:** Kahneman → the problem (numbers from §2) → 3 organs → honest benchmark → link.
4. **Tags:** @typesafeai (they repost integrations), @altryne, @tamarajtran. Credit: "powered by Jev".
5. **A friend, not a rival:** "works with rtk". compactio filters what rtk does not reach.
6. **Scoreboard screenshots** that are easy to share. Dollars, not percentages.
7. **Channels:** X, Show HN ("System 1 for coding agents"), r/ClaudeAI, r/LocalLLaMA, Product Hunt.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Dependence on TypeSafe (price, API, firewall) | Pin the model version. OpenRouter path. Local mode. A one-layer engine interface. |
| A wrong drop confuses the agent or makes it invent work | Low confidence = keep. Tombstones. The original is always recoverable. |
| Cache misses raise the bill | The cache guard in the Sweep (§4.2). Measure it in the benchmark. |
| Host hook APIs change | A thin adapter per host. A contract test per host. |
| Privacy of client code | Local redaction, local mode, and a clear list of what is sent. |
| Competitors copy the idea | Release speed, a public benchmark, many hosts. |

---

## 11. Decisions made

- Name: **compactio**. npm `compactio` is registered. Repo `RamaAditya49/compactio`.
- Frame: **System 1** (Kahneman), not "System One" (TypeSafe's product term).
- Default engine: Jev, credited as "powered by Jev".
- Proxy mode: **yes, opt-in**, in v0.3. Without a proxy, the Sweep cannot run in Claude Code or Codex.
- Language of the project: English (international open source).

## Sources

docs.typesafe.ai (api.md, models.md, concepts/system-one.md) · github.com/tamaratran/fast-jev-compaction
(issues #26 #52 #56 #65 #89 #97) · github.com/rtk-ai/rtk · code.claude.com/docs/en/hooks, /costs ·
learn.chatgpt.com/docs/hooks · opencode.ai/docs/plugins · geminicli.com/docs/hooks/reference ·
cursor.com/docs/agent/hooks · zcode.z.ai/en/docs/hooks · trychroma.com/research/context-rot ·
devxlabs.ai/blogs/how-claude-code-actually-works
