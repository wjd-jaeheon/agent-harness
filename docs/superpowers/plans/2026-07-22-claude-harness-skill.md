# Claude Pingpong Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the launcher-only `/harness` alias with a Korean, task-first `/pingpong` entry that invokes the existing deterministic plan runner.

**Architecture:** The tracked Claude Skill owns conversation only and calls public `harness.mjs` commands. `harness.mjs` remains the sole state-transition owner. `launcher.mjs` is reduced to saved-run recovery so there is no second, disconnected new-task path.

**Tech Stack:** Claude Code personal Skill, Node.js ESM standard library, `node:test`.

## Global Constraints

- Add no dependency, daemon, state, automatic approval, or permission bypass.
- Reuse existing `start`, `list`, `run`, `approve-plan`, `request-plan-revision`, and `abort` commands.
- With no arguments, `/pingpong` asks only `무슨 작업을 계획할까요?` and waits.
- The tracked and installed Skill files must be identical.
- This patch connects through `AWAIT_PLAN_APPROVAL`; it does not implement the later `IMPLEMENT_LOOP` engine.

---

### Task 1: Task-first personal Skill and recovery-only launcher

**Files:**
- Modify: `tests/harness.test.mjs`
- Replace: `integrations/claude/harness/SKILL.md` with `integrations/claude/pingpong/SKILL.md`
- Modify: `launcher.mjs`
- Modify: `README.md`
- Modify: `PLAN.md`
- Install: `C:/Users/wjdbi/.claude/skills/pingpong/SKILL.md`

**Interfaces:**
- `/pingpong [작업 설명]` collects requirements, creates a temporary SPEC, and invokes `harness.mjs start`.
- `/pingpong resume` opens the existing launcher for explicit saved-run recovery.
- `launch()` never starts an untracked interactive Claude plan.

- [x] **Step 1: Write the failing tests**

Add one test that reads the tracked Skill and requires `$ARGUMENTS`, the exact no-argument Korean question, the public `start` command, explicit resume behavior, and no launcher-based new-task path. Replace the launcher new-task test with a recovery-only test.

- [x] **Step 2: Verify RED**

Run:

```powershell
node --test --test-name-pattern "tracked pingpong skill|launcher has no disconnected" tests\harness.test.mjs
```

Expected: failures because the current Skill only opens `launcher.mjs` and the launcher still exposes `New task with Claude`.

- [x] **Step 3: Implement the minimum behavior**

Rewrite the tracked Skill as a concise user-only workflow. Remove `startClaudePlan`, its `spawn` import, and the new-task branch from `launcher.mjs`. Keep all saved-run state changes mapped through `actionArgv()`.

- [x] **Step 4: Verify GREEN**

Run the focused test command. Expected: all focused tests pass.

- [x] **Step 5: Update docs and install the Skill**

Make `/pingpong` the normal path, document the Orca Claude-tab shortcut, and demote Quick Command to recovery. Copy the canonical Skill to the personal Claude directory without changing its bytes.

- [x] **Step 6: Full verification**

Run:

```powershell
node --test tests\*.test.mjs
git diff --check
```

Expected: all tests pass, no whitespace errors, and the installed Skill hash equals the tracked Skill hash.
