---
name: harness
description: Use when the user explicitly enters /harness to open the local agent-harness launcher for the current Orca worktree.
disable-model-invocation: true
---

# Harness

Open exactly one Orca terminal running the shared launcher:

`orca terminal create --worktree active --title "Harness" --command 'node "D:\codex-projects\agent-harness\launcher.mjs"' --focus --json`

Report the Orca command result. Do not read or edit `.harness`, choose a run, approve a plan, or implement another state transition.
