# Security policy

compactio reads tool output from your coding agent. That output can contain source code and secrets. We take reports about data exposure seriously.

## Report a vulnerability

Do not open a public issue. Use GitHub private vulnerability reporting on this repository (Security tab → Report a vulnerability).

Include the affected version, the steps to reproduce, and the impact. We reply within 7 days.

## What compactio sends

With `TYPESAFE_API_KEY` set, compactio sends a redacted summary to the TypeSafe API for each large tool output. The summary contains the goal, the tool input, and a preview of the output. See "What goes to Jev" in the README. Without the key, compactio sends nothing.

The redaction is based on patterns. It does not find every possible secret. If your tool output can contain secrets that the patterns do not match, run compactio without a key.
