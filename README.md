<div align="center">

# compactio

**System 1 for your coding agent.**

Cut the tool output your agent does not need, before it enters the context.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.18-brightgreen.svg)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-d97757.svg)](https://code.claude.com/docs/en/plugins)
[![Powered by Jev](https://img.shields.io/badge/powered%20by-Jev-111.svg)](https://docs.typesafe.ai)
[![Dependencies](https://img.shields.io/badge/dependencies-0-lightgrey.svg)](package.json)

</div>

---

Daniel Kahneman describes two modes of thought. **System 1** is fast and automatic. **System 2** is slow and deliberate.

Coding agents use System 2 for everything. They pass every test log, build log, and search result to a frontier model. Then they carry that output into every later turn and pay for it again each time. When the window is full, they spend one more large request to summarize it.

compactio adds the missing System 1. After each tool call, a fast decision model ([Jev](https://docs.typesafe.ai)) answers one question: *how much of this output does the agent need for the current goal?* The model does not generate text. It returns a typed choice with a confidence in about half a second. Then code applies that choice.

```text
 npm test  ──►  503 lines, 20,501 chars
                    │
                    ▼  Jev: "errors" (0.75 s, $0.00005)
                    │
 agent sees ◄──  FAIL test/db/pool.spec.ts
                   Error: connect ECONNREFUSED 127.0.0.1:5432
                 Tests: 1 failed, 500 passed, 501 total
                 [compactio: kept "errors" view of 503 lines. Full output: … show f0c58b38]
                 747 chars
```

This is a real run in Claude Code: the output is 96% smaller, and the agent still gave the correct diagnosis.

## Features

- **Decides, does not generate.** Jev picks one of four views: `full`, `errors`, `headtail`, `stub`. A decision costs about $0.00005.
- **Safe by default.** Low confidence, a timeout, or an API error returns the full output. compactio never blocks your agent.
- **Nothing is lost.** Every cut output stays on your disk. The note in the output tells the agent how to get it back.
- **Code is never cut.** A `Read` of a source file always passes through in full. compactio only skips an exact re-read of an unchanged file.
- **Secrets stay local.** API keys, tokens, private keys, and `KEY=value` pairs are masked before any request leaves your machine.
- **Works without a key.** Local mode uses only lossless filters, the re-read skip, and a head-and-tail cut for very large output.
- **Zero dependencies.** TypeScript that Node runs directly. No build step, and no `node_modules`.

## Quick start

**1. Install the plugin**

```bash
claude plugin marketplace add RamaAditya49/compactio
claude plugin install compactio@compactio
```

**2. Add a TypeSafe API key** (optional, but recommended). Get a key at [console.typesafe.ai/keys](https://console.typesafe.ai/keys) and add it to `~/.claude/settings.json`:

```json
{
  "env": { "TYPESAFE_API_KEY": "your-key" }
}
```

**3. Restart Claude Code.** compactio now works on every session.

**4. Check the savings**

```text
/compactio:gain
```

```text
compactio · all sessions
────────────────────────────────────────────────────
  Tokens kept out of context   ~12,478
  Share of tool output cut     ████░░░░░░░░░░░░░░░░ 20%
  Outputs cut                  3 of 17  (avg cut 93%)
  Jev decisions                4  ·  $0.0002
  Unchanged re-reads skipped   0
  Fail-open                    0
────────────────────────────────────────────────────
  Biggest cuts
    Bash   headtail   30.0k → 408    chars  (local)
    Bash   errors     20.5k → 747    chars  (jev)
    Bash   clean       3.0k → 2.4k   chars  (lossless)
────────────────────────────────────────────────────
  tokens ≈ characters ÷ 4
```

## How it works

compactio uses Claude Code's `PostToolUse` hook. The hook runs after a tool finishes and before the model sees the result.

| Step | Who | What |
|---|---|---|
| 1 | Code | Skip small output (below 2,000 characters). |
| 2 | Code | Skip an exact re-read of an unchanged file. |
| 3 | Code | Remove ANSI codes, repeated lines, and blank runs. This step loses no information. |
| 4 | Jev | For output above 6,000 characters, choose `full`, `errors`, `headtail`, or `stub` for the current goal. |
| 5 | Code | Apply the view, store the original, and add a one-line note. |

Covered tools: `Bash`, `Grep`, `WebFetch`, `WebSearch`, all MCP tools, and `Read` (re-read skip only, plus the large outputs that Claude Code saves to disk).

### What goes to Jev

Only a bounded, redacted summary:

- the goal: your last prompt, up to 2,000 characters
- the tool name and its input, up to 600 characters
- a preview of the output: the first lines, the error lines, and the last lines, about 6,000 characters in total

The full output never leaves your machine. Without `TYPESAFE_API_KEY`, nothing leaves your machine.

## Configuration

Set these variables in the `env` block of `~/.claude/settings.json`.

| Variable | Default | Description |
|---|---|---|
| `TYPESAFE_API_KEY` | — | Turns on Jev decisions. Without it, compactio runs in local mode. |
| `COMPACTIO_TIMEOUT_MS` | `1500` | Time limit for one decision. After it, the full output passes. |
| `COMPACTIO_JEV_MODEL` | `jev-1.13.0` | Jev model version. |
| `COMPACTIO_HOME` | `~/.compactio` | Folder for stored outputs, read hashes, and the decision log. |

## Commands

| Command | Description |
|---|---|
| `/compactio:gain` | Show the savings scoreboard. |
| `node <plugin>/src/cli.ts show <id>` | Print a stored original output. The agent runs this itself when it needs the full output. |
| `claude plugin disable compactio@compactio` | Turn compactio off. |

## Honest numbers

- Token counts are estimates: characters ÷ 4.
- "Hundreds of times cheaper" applies to the cost of one decision (Jev compared with an LLM). It does not apply to your total bill.
- Claude Code already limits Bash output to 30,000 characters. On one Bash call, compactio saves at most about 7,500 tokens. The agent then carries that saving through every later turn of the session.
- A public benchmark (task success rate, tokens, and cost, compared with no plugin and with other tools) is on the roadmap. We make no claim about the total bill until that benchmark exists.

## How compactio compares

| | compactio | [rtk](https://github.com/rtk-ai/rtk) | [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) |
|---|---|---|---|
| When it acts | After each tool call | Before each shell command | At compaction |
| How it decides | Jev, from the current goal | Fixed rules per command | Jev, from a size note |
| Tools covered | Bash, Grep, Web, MCP, re-reads | Shell commands | All, at compaction |

compactio and rtk work well together: rtk shrinks known shell commands, and compactio covers the rest.

## Roadmap

- [x] **v0.1** Claude Code: tool output filter, re-read skip, scoreboard, redaction, local mode
- [ ] **v0.2** Codex CLI, OpenCode, Gemini CLI, Cursor, Trae. Replay evaluation on real sessions.
- [ ] **v0.3** Sweep: remove stale context in long sessions (opt-in local proxy), with prompt-cache protection
- [ ] **v0.4** Gate: route each prompt to the cheapest model that can do the task
- [ ] **v1.0** Public benchmark

See [BLUEPRINT.md](BLUEPRINT.md) for the full design.

## Development

```bash
git clone https://github.com/RamaAditya49/compactio.git
cd compactio
node --test test/*.test.ts
```

To use your local copy in Claude Code:

```bash
claude plugin marketplace add ./
claude plugin install compactio@compactio
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. Report security issues as described in [SECURITY.md](SECURITY.md).

## Credits

- [Jev](https://docs.typesafe.ai) by [TypeSafe AI](https://typesafe.ai), the System One decision model that powers compactio.
- *Thinking, Fast and Slow* by Daniel Kahneman, for the System 1 and System 2 model.
- [rtk](https://github.com/rtk-ai/rtk) and [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction), which showed that this problem matters.

compactio is not affiliated with TypeSafe AI or Anthropic.

## License

[MIT](LICENSE) © 2026 Rama Aditya
