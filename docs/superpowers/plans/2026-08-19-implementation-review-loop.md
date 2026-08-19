# Implementation Review Loop Plan

> Execute inline in this session. `PLAN.md` is the approved design contract.

**Goal:** After each approved checkpoint, run its locked checks and a read-only Claude code review; let Codex fix blocking findings once, then repeat the same process for the final full diff.

**Architecture:** Keep the existing foreground runner and file ledger. Extend the PLAN grammar with explicit checkpoint paths, ACs, and CMDs; reuse the current Codex writer, verification, diff, and manifest paths; add Claude as a structured read-only reviewer. Cursor remains planning-only in this release, and push/PR/merge remain outside the runtime workflow.

**Tech stack:** Node.js standard library, Git CLI, Claude Code CLI, Codex CLI, existing `node:test` suite.

---

### Task 1: Lock the checkpoint contract

**Files:**
- Modify: `tests/harness.test.mjs`
- Modify: `prompts/planner.md`
- Modify: `harness.mjs`

1. Add a failing integration test whose approved PLAN declares `Paths`, `ACs`, and `Commands` for `CP-001`.
2. Require sequential checkpoints and validate every referenced path, AC, and CMD before plan approval.
3. Run the focused test and confirm the new contract passes.

### Task 2: Add checkpoint verification and Claude review

**Files:**
- Modify: `tests/harness.test.mjs`
- Modify: `harness.mjs`
- Add: `prompts/code-reviewer.md`
- Modify: `schemas/review-output.schema.json`

1. Add a failing test for `Codex implement -> checkpoint CMD -> Claude review`.
2. Route `claude_code_review` through the Claude CLI with read-only tools and structured output.
3. Save checkpoint diff, evidence, raw output, and parsed review under the run ledger.
4. Block on major/blocker, missing evidence, or failed mapped ACs; allow minor findings.

### Task 3: Add the Codex fix loop and final review

**Files:**
- Modify: `tests/harness.test.mjs`
- Modify: `harness.mjs`
- Add: `prompts/fixer.md`

1. Add a failing test where the first Claude review finds a major issue.
2. Let Codex fix only approved checkpoint paths, rerun the checkpoint CMDs, and request one close-out review.
3. After all checkpoints pass, run every locked CMD and repeat the same Claude review/fix gate for the full diff.
4. Reach `READY_FOR_MANUAL_MERGE` only after the final review passes; otherwise stop at `NEEDS_HUMAN` with the preserved diff and evidence.

### Task 4: Update operator guidance and verify

**Files:**
- Modify: `README.md`
- Modify: `integrations/claude/pingpong/SKILL.md`

1. Replace the obsolete “no post-implementation review” limitation with the actual loop and artifact locations.
2. Run the focused implementation-review tests, then the full test suite.
3. Inspect `git diff` and stage only this plan and the implementation files; exclude the pre-existing `policy.json` and workflow image files.

### Task 5: Publish for review

1. Create a `codex/checkpoint-review-loop` branch.
2. Commit the scoped files, push the branch, and open a draft GitHub PR.
3. Leave merge as the explicit human gate.
