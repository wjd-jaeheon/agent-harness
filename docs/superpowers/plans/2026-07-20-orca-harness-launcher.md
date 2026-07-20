# Orca Harness Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user start, resume, and approve an agent-harness run from one Orca Global Quick Command without copying a run ID.

**Architecture:** `harness.mjs` remains the only state-transition owner. A new `launcher.mjs` discovers the current repository through the public read-only `list` command and maps one menu choice to exactly one public runner command; it never reads or writes `.harness` itself. A user-only Claude Skill opens that same launcher in an Orca terminal.

**Tech Stack:** Node.js ESM and standard library only, `node:test`, Git CLI, Orca CLI, Claude Code personal Skill.

## Global Constraints

- Add no dependency, daemon, background service, global current-run pointer, Orca orchestration, automatic approval, or automatic merge.
- `.harness/runs/<run-id>/` and `harness.mjs` remain the only state source and transition surface.
- A state-changing menu selection invokes exactly one public runner command.
- `start` owns its `init → run` composition inside the runner.
- An exact `run.worktree_path` match selects that owner run even when it is terminal; otherwise only non-`ABORTED`/non-`DONE` runs with the same canonical git-common-dir are candidates.
- Multiple candidate runs always require human selection.
- Orca Quick Command scope is `Global`; Agent Permissions remains `Manual`.

---

### Task 1: Repository discovery and runner-owned start

**Files:**
- Modify: `harness.mjs`
- Modify: `tests/harness.test.mjs`

**Interfaces:**
- Produces: `runCommand(['list', '--repo', repo])` returning `{ repoPath, ownerRunId, selectedRunId, runs, warnings }`.
- Produces: `runCommand(['start', '--repo', repo, '--spec', spec])` returning the same summary as `run` at its next human gate.
- Reuses: `initCommand`, `runPlanLoop`, `loadRun`, `summarize`, and `gitOutput`.

- [ ] **Step 1: Write failing discovery tests**

Add tests using the existing `fixture`, `initRun`, and `readRun` helpers:

```js
test('list finds no run, one run, and multiple active runs for a repo', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await runCommand(['list', '--repo', f.repo], { harnessRoot: f.harnessRoot })).runs, []);

  const first = await initRun(f);
  assert.equal((await runCommand(['list', '--repo', f.repo], { harnessRoot: f.harnessRoot })).selectedRunId, first.runId);

  const second = await initRun(f);
  const listed = await runCommand(['list', '--repo', f.repo], { harnessRoot: f.harnessRoot });
  assert.equal(listed.selectedRunId, null);
  assert.deepEqual(new Set(listed.runs.map((run) => run.runId)), new Set([first.runId, second.runId]));
});

test('list from a managed writer worktree selects only its owner run', async (t) => {
  const f = await fixture(t);
  const owner = await initRun(f);
  await initRun(f);
  const run = await readRun(f.harnessRoot, owner.runId);
  const listed = await runCommand(['list', '--repo', run.worktree_path], { harnessRoot: f.harnessRoot });
  assert.equal(listed.ownerRunId, owner.runId);
  assert.equal(listed.selectedRunId, owner.runId);
  assert.deepEqual(listed.runs.map((item) => item.runId), [owner.runId]);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern "list finds|managed writer" tests\harness.test.mjs
```

Expected: both tests fail with `unknown command: list`.

- [ ] **Step 3: Implement minimal discovery**

Import `readdir` from `node:fs/promises` and add:

```js
const CLOSED_RUN_STATES = new Set(['ABORTED', 'DONE']);

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function gitContext(repo, gitExecutable) {
  return {
    topLevel: path.resolve(await gitOutput(gitExecutable, repo, ['rev-parse', '--show-toplevel'])),
    commonDir: path.resolve(await gitOutput(gitExecutable, repo, [
      'rev-parse', '--path-format=absolute', '--git-common-dir',
    ])),
  };
}
```

Implement `listRunsCommand(values, options)` by reading every `.harness/runs/*/run.json`, checking an exact normalized `worktree_path` first, then comparing canonical `commonDir` values for open runs. A missing stale `repo_path` adds `{ runId, message }` to `warnings` and is skipped. Return run entries as `{ ...summarize(run), repoPath: run.repo_path, worktreePath: run.worktree_path }`.

Add dispatch:

```js
if (command === 'list') return listRunsCommand(values, resolved);
```

- [ ] **Step 4: Verify discovery GREEN**

Run the focused command from Step 2. Expected: 2 passed, 0 failed.

- [ ] **Step 5: Write a failing start test**

Use the existing scripted Scout/planner/reviewer outputs:

```js
test('start owns init then plan execution through the next human gate', async (t) => {
  const f = await fixture(t);
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: review(1) } },
  ]);
  const result = await runCommand(['start', '--repo', f.repo, '--spec', f.specPath], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  assert.equal(result.state, 'AWAIT_PLAN_APPROVAL');
  assert.equal(scripted.queue.length, 0);
});
```

- [ ] **Step 6: Verify start RED, implement, and verify GREEN**

RED command:

```powershell
node --test --test-name-pattern "start owns" tests\harness.test.mjs
```

Expected RED: `unknown command: start`.

Minimal dispatch:

```js
if (command === 'start') {
  const created = await initCommand(values, resolved);
  return runPlanLoop(await loadRun(resolved.harnessRoot, created.runId), resolved);
}
```

Re-run the focused test. Expected GREEN: 1 passed, 0 failed.

- [ ] **Step 7: Run the full suite and commit**

Run `node --test tests\*.test.mjs`. Expected: all tests pass.

Commit: `feat: add repository-aware harness commands`.

---

### Task 2: One-action interactive launcher

**Files:**
- Create: `launcher.mjs`
- Modify: `tests/harness.test.mjs`

**Interfaces:**
- Consumes: public `runCommand` commands only.
- Produces: `actionArgv(action, run, input)` and `launch(options)`.
- `launch` may call read-only `list`/`status` for presentation; after selection it calls exactly one state-changing command.

- [ ] **Step 1: Write failing action mapping and delegation tests**

```js
test('launcher approval maps to one exact approve-plan command', async () => {
  assert.deepEqual(actionArgv('approve', { runId: 'r1', currentPlanSha: 'a'.repeat(64) }), [
    'approve-plan', '--run', 'r1', '--plan-sha', 'a'.repeat(64),
  ]);
});

test('launcher invokes exactly one selected state-changing command', async () => {
  const calls = [];
  const runner = async (argv) => {
    calls.push(argv);
    if (argv[0] === 'list') return { ownerRunId: null, selectedRunId: 'r1', runs: [{ runId: 'r1' }], warnings: [] };
    if (argv[0] === 'status') return { runId: 'r1', state: 'AWAIT_PLAN_APPROVAL', currentPlanSha: 'a'.repeat(64) };
    return { runId: 'r1', state: 'IMPLEMENT_LOOP' };
  };
  await launch({ cwd: 'D:\\repo', runner, ask: async () => '1', write: () => {} });
  assert.deepEqual(calls.at(-1), ['approve-plan', '--run', 'r1', '--plan-sha', 'a'.repeat(64)]);
  assert.equal(calls.filter((argv) => !['list', 'status'].includes(argv[0])).length, 1);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern "launcher approval|launcher invokes" tests\harness.test.mjs
```

Expected: module/function-not-found failure for `launcher.mjs`.

- [ ] **Step 3: Implement the launcher with Node standard library**

`actionArgv` maps only:

```js
export function actionArgv(action, run, input = {}) {
  if (action === 'continue') return ['run', '--run', run.runId];
  if (action === 'approve') return ['approve-plan', '--run', run.runId, '--plan-sha', run.currentPlanSha];
  if (action === 'revise') return ['request-plan-revision', '--run', run.runId, '--note-file', input.noteFile];
  if (action === 'abort') return ['abort', '--run', run.runId, '--reason', input.reason];
  throw new Error(`unsupported launcher action: ${action}`);
}
```

`launch` performs one pass: call `list`, select exact owner/sole run or prompt for a candidate, prompt for SPEC and call `start` when none exists, otherwise call `status`, show a state-specific numbered menu, then execute one `actionArgv` result. `PLAN_LOOP` offers continue/abort; `AWAIT_PLAN_APPROVAL` offers approve/revise/abort; all other states display state/error and offer abort/exit only. Use `node:readline/promises` in the executable main block and always close the interface in `finally`.

- [ ] **Step 4: Verify launcher GREEN**

Run the focused tests from Step 2. Expected: 2 passed, 0 failed.

- [ ] **Step 5: Add the semantic approval parity test**

Create two isolated fixtures and advance both to approval. Approve one with raw argv and one with `actionArgv('approve', summary)`. Compare:

```js
const approvalFields = ({ state, approved_plan_path, approved_plan_sha, approved_base_sha }) => ({
  state, approved_plan_path, approved_plan_sha, approved_base_sha,
});
const transitionFields = ({ previous_state, state, action, result }) => ({
  previous_state, state, action, result,
});
assert.deepEqual(approvalFields(viaLauncherRun), approvalFields(rawRun));
assert.deepEqual(transitionFields(viaLauncherEvent), transitionFields(rawEvent));
```

- [ ] **Step 6: Run the full suite and commit**

Run `node --test tests\*.test.mjs`. Expected: all tests pass.

Commit: `feat: add Orca harness launcher`.

---

### Task 3: Orca instructions and user-only Claude alias

**Files:**
- Modify: `PLAN.md`
- Modify: `README.md`
- Create: `integrations/claude/harness/SKILL.md`
- Install: `C:\Users\wjdbi\.claude\skills\harness\SKILL.md`

**Interfaces:**
- Orca Global Quick Command executes `node "D:\codex-projects\agent-harness\launcher.mjs"` in the current worktree.
- `/harness` opens that same command in a new active Orca terminal; it owns no state logic.

- [ ] **Step 1: Record the Skill RED baseline**

Before creating the Skill, verify `C:\Users\wjdbi\.claude\skills\harness\SKILL.md` does not exist and run a fresh Claude plan-only retrieval scenario asking what `/harness` must invoke. Record that no installed `/harness` definition exists; do not permit file or state changes.

- [ ] **Step 2: Update PLAN and README**

Replace “Control terminal is the only operation surface” with “runner is the only state-transition surface.” Document:

```text
Settings > Quick Commands
Label: Harness
Command: node "D:\codex-projects\agent-harness\launcher.mjs"
Scope: Global
```

Keep raw `harness.mjs --run` commands in a fallback section. Add the exact writer-worktree rule, multiple-run selection rule, Manual permissions, hidden external worktree import, and current Phase 1 limitation after `IMPLEMENT_LOOP`.

- [ ] **Step 3: Create and install the minimal Skill**

Use identical content in the tracked template and personal path:

```markdown
---
name: harness
description: Use when the user explicitly enters /harness to open the local agent-harness launcher for the current Orca worktree.
disable-model-invocation: true
---

# Harness

Open exactly one Orca terminal running the shared launcher:

`orca terminal create --worktree active --title "Harness" --command 'node "D:\codex-projects\agent-harness\launcher.mjs"' --focus --json`

Report the Orca command result. Do not read or edit `.harness`, choose a run, approve a plan, or implement another state transition.
```

Do not add `allowed-tools` or `user-invocable: false`.

- [ ] **Step 4: Verify the Skill and documentation**

Restart Claude Code. Confirm `/skills` lists `harness` as user-invoked, `/harness` opens the shared launcher, and a normal sentence mentioning harness does not invoke it automatically. Confirm PLAN and README contain `Global Quick Command` and do not contain the old “Claude slash command를 만들지 않는다” rule.

- [ ] **Step 5: Full verification and commit**

Run:

```powershell
node --test tests\*.test.mjs
git diff --check
```

Expected: all tests pass and `git diff --check` prints nothing.

Commit: `docs: wire Orca and Claude launcher entrypoints`.
