# compactio

**System 1 for your coding agent.** Cut the tool output that the task does not need, before it enters the context. Powered by [Jev](https://docs.typesafe.ai).

Coding agents use their most expensive model for every small decision. They also carry every tool output into every later turn, and each turn bills those tokens again. compactio puts a fast decision model in front of the LLM. After each tool call it decides how much of the output the agent needs for the current goal: all of it, only the errors, the start and the end, or one line.

- **No generation.** Jev returns a typed choice with a confidence. It costs $0.042 per 1M input tokens.
- **Fail open.** If Jev is slow, down, or unsure, the agent gets the full output.
- **Nothing is lost.** Every cut output is stored locally. `compactio show <id>` returns it.
- **Unchanged re-reads are skipped.** If the agent reads the same unchanged file again, it gets one line instead of the whole file.
- **Secrets stay local.** Keys, tokens, and `KEY=value` pairs are masked before any request.

See [BLUEPRINT.md](BLUEPRINT.md) for the full design and roadmap.

## Install (Claude Code)

```bash
claude plugin marketplace add RamaAditya49/compactio
claude plugin install compactio@compactio
```

Node 22.18 or later must be on your `PATH`.

Add your TypeSafe key (from [console.typesafe.ai/keys](https://console.typesafe.ai/keys)) to `~/.claude/settings.json`:

```json
{ "env": { "TYPESAFE_API_KEY": "your-key" } }
```

Without a key, compactio runs in local mode: lossless filters, re-read skip, and a head+tail cut for outputs above 24k characters.

## Use

It works by itself after install. To see what it saved (example output):

```
/compactio:gain
```

```
compactio · all sessions
  tool outputs seen          1,204
  outputs made smaller       611
  tokens kept out of context ~912,408
  Jev decisions              540   cost $0.0181
  unchanged re-reads skipped 73
  fail-open                  3
```

## Settings

| Variable | Default | Effect |
|---|---|---|
| `TYPESAFE_API_KEY` | — | Turns on Jev decisions. |
| `COMPACTIO_TIMEOUT_MS` | `1500` | Time limit for one decision, then fail open. |
| `COMPACTIO_JEV_MODEL` | `jev-1.13.0` | Jev model version. |
| `COMPACTIO_HOME` | `~/.compactio` | Where originals and the log are stored. |

## Hosts

| Host | Status |
|---|---|
| Claude Code | ✅ v0.1 |
| Codex CLI, OpenCode, Gemini CLI | v0.2 |
| Cursor, Trae (command rewrite) | v0.2 |

## Develop

```bash
node --test test/*.test.ts
```

## License

MIT
