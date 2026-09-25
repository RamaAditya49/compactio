# Contributing to compactio

Thank you for your help. Bug reports, host adapters, and evaluation data are the most useful contributions.

## Before you start

- For a large change, open an issue first. Describe the problem and your plan.
- Keep the project free of runtime dependencies. Use the Node standard library.
- Keep the fail-open rule: an error in compactio must never block the agent.

## Setup

```bash
git clone https://github.com/RamaAditya49/compactio.git
cd compactio
node --test test/*.test.ts
```

Node 22.18 or later runs the TypeScript sources directly. No build step is necessary.

## Pull requests

1. Make one change in each pull request.
2. Add a test for each new rule or branch in `test/`.
3. Make sure that `node --test test/*.test.ts` passes.
4. Write commit messages in the imperative mood, for example `fix: keep stderr when stdout is empty`.
5. Never put real API keys or real session data in tests or fixtures.

## Numbers

If a change claims a saving, include how you measured it. Label example numbers as examples.

## Releases (maintainers)

1. Set the new version in `package.json` and `.claude-plugin/plugin.json`.
2. Commit, then tag: `git tag -a vX.Y.Z -m "compactio X.Y.Z"`.
3. Push the tag: `git push origin vX.Y.Z`.

CI runs the tests, builds `dist/`, and publishes to npm with provenance through npm Trusted Publishing. No npm token is stored in GitHub.
