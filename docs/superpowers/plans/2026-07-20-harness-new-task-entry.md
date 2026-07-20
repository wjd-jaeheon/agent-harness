# Harness New Task Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Orca `Harness` command start a fresh interactive Claude planning session by explicit choice, while never silently resuming a saved task.

**Architecture:** `launcher.mjs` owns only the deterministic human menu. `harness.mjs list` supplies a display title read from each run's locked `SPEC.md`; the existing runner remains the only state-machine owner. The CLI wrapper closes its readline handle before starting native interactive Claude in the current repository.

**Tech Stack:** Node.js standard library, `node:test`, Claude Code CLI 2.1.201.

## Global Constraints

- A saved run must never execute without an explicit resume choice.
- The new-task action must not mutate any saved run.
- Claude starts in the selected repository with `--permission-mode plan`.
- Do not use `--print`, `--continue`, `--resume`, `--bare`, or permission-bypass flags.
- Do not parse interactive Claude TUI output or claim that Codex handoff is automated by this change.
- Add no dependency and no new state-machine state.

---

### Task 1: Explicit new-task and resume entry menu

**Files:**
- Modify: `launcher.mjs`
- Modify: `harness.mjs`
- Modify: `tests/harness.test.mjs`
- Modify: `README.md`

**Interfaces:**
- `harness.mjs list` produces `runs[].taskSummary` from the locked `SPEC.md` first heading.
- `launch()` returns a `start-claude-plan` request for a new task or calls one exact existing runner command after an explicit resume choice.
- The CLI wrapper consumes `start-claude-plan` by closing readline and spawning native interactive Claude with inherited stdio.

- [ ] **Step 1: Write failing launcher tests**

Cover these behaviors:

```text
one saved run + New task -> no status/run call for that saved run
one saved run + Resume -> saved SPEC title is displayed before any action
Exit -> list is the only runner call
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test tests\harness.test.mjs --test-name-pattern "launcher|list finds"
```

Expected: failures because the launcher still auto-selects a sole run and list entries lack `taskSummary`.

- [ ] **Step 3: Implement the smallest menu and Claude launch request**

The top-level menu is exactly:

```text
1. New task with Claude
2..N. Resume saved task: <taskSummary> [<state>]
N+1. Exit
```

The interactive Claude prompt begins by asking the user what work to plan, forbids implementation, and waits for plan approval.

- [ ] **Step 4: Verify GREEN and full regression suite**

Run the focused command, then:

```powershell
node --test tests\*.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Update usage documentation and commit**

Document that `Harness` first asks whether to start a new Claude plan or resume a named saved task, and that automated import of the interactive plan into the Codex review loop is not part of this change.
