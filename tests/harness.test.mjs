import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  createDefaultProviderRunner,
  runCommand,
  runProcess,
  sha256Bytes,
} from '../harness.mjs';
import { actionArgv, launch } from '../launcher.mjs';

const exec = promisify(execFile);

async function git(cwd, ...args) {
  const { stdout } = await exec('git', args, { cwd, encoding: 'utf8' });
  return stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-harness-'));
  const harnessRoot = path.join(root, 'harness');
  const repo = path.join(root, 'repo');
  await mkdir(harnessRoot);
  await mkdir(repo);
  await git(repo, 'init');
  await git(repo, 'config', 'user.email', 'harness@example.test');
  await git(repo, 'config', 'user.name', 'Harness Test');
  await writeFile(path.join(repo, 'app.txt'), 'base\n', 'utf8');
  await git(repo, 'add', 'app.txt');
  await git(repo, 'commit', '-m', 'base');

  const specPath = path.join(root, 'SPEC.md');
  const spec = '# Toy SPEC\n\nAC-001: update app\n\nCMD-001: `node --version`\n';
  await writeFile(specPath, spec, 'utf8');
  await writeFile(
    path.join(harnessRoot, 'policy.json'),
    JSON.stringify({ budgets: { plan_review_max: 2 } }),
    'utf8',
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, harnessRoot, repo, specPath, spec };
}

function scriptedProvider(script) {
  const queue = [...script];
  const calls = [];
  const providerRunner = async (request) => {
    calls.push(request);
    const item = queue.shift();
    assert.ok(item, `unexpected provider call: ${request.step}`);
    assert.equal(request.step, item.step);
    if (item.throw) throw item.throw;
    return {
      exitCode: 0,
      stdout: `${request.step} raw\n`,
      stderr: '',
      ...item.result,
    };
  };
  return { providerRunner, calls, queue };
}

const scout = `SCOUT-001 | reuse
evidence: app.txt
note: reuse the existing file
`;

const multiScout = `SCOUT-001 | reuse
evidence: app.txt
note: reuse the existing file

SCOUT-002 | test
evidence: app.test.txt
note: verify the existing file
`;

const planV1 = `# Plan v1

AC-001 is implemented in app.txt and verified by CMD-001.

SCOUT-001: incorporated — app.txt is reused.

CP-001: update app.txt, then run CMD-001.
`;

const planV2 = `# Plan v2

AC-001 is implemented in app.txt and verified by CMD-001.

SCOUT-001: incorporated — app.txt is reused.

CP-001: handle the edge case in app.txt, then run CMD-001.
`;

const acPass = {
  id: 'AC-001',
  status: 'pass',
  implementation_ref: 'app.txt',
  verification_ref: 'CMD-001',
};

function finding(id = 'F-001') {
  return {
    id,
    severity: 'major',
    claim: 'edge case is missing',
    failure_scenario: 'empty input -> wrong output',
    evidence: ['app.txt'],
    needs_evidence: false,
  };
}

function review(round, { findings = [], prior = [], ac = [acPass], checkpoints = 1 } = {}) {
  return {
    phase: 'plan',
    round,
    findings,
    prior_findings: prior,
    ac_checks: ac,
    checkpoint_count: checkpoints,
  };
}

async function initRun(f, providerRunner) {
  return runCommand(
    ['init', '--repo', f.repo, '--spec', f.specPath],
    { harnessRoot: f.harnessRoot, providerRunner },
  );
}

async function readRun(harnessRoot, runId) {
  const file = path.join(harnessRoot, '.harness', 'runs', runId, 'run.json');
  return JSON.parse(await readFile(file, 'utf8'));
}

test('init rejects a CMD id that the SPEC mentions but never defines', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.specPath,
    '# Toy SPEC\n\nAC-001: update app\n\nCMD-001: `node --version`\n\nSee CMD-004 for details.\n',
    'utf8',
  );
  const { providerRunner, calls } = scriptedProvider([]);
  await assert.rejects(
    () => initRun(f, providerRunner),
    /CMD-004 needs one backtick-wrapped executable command/,
  );
  assert.equal(calls.length, 0, 'no provider may run before the SPEC is proven executable');
});

test('init rejects a verification command the verification shell cannot parse', async (t) => {
  const f = await fixture(t);
  const broken = process.platform === 'win32' ? 'node --version && node --version' : 'node --version )';
  await writeFile(f.specPath, `# Toy SPEC\n\nAC-001: update app\n\nCMD-001: \`${broken}\`\n`, 'utf8');
  const { providerRunner, calls } = scriptedProvider([]);
  await assert.rejects(
    () => initRun(f, providerRunner),
    /CMD-001 is not parseable by the verification shell/,
  );
  assert.equal(calls.length, 0);
});

test('맥락 섹션의 CMD 언급은 필수 검증 명령으로 파싱되지 않는다', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.specPath,
    [
      '# Toy SPEC',
      '',
      '## 계약',
      '',
      '- AC-001: update app — 검증: CMD-001',
      '- CMD-001: `node --version`',
      '',
      '## 맥락',
      '',
      '이전 시도에서 CMD-004를 썼다가 실패했다. AC-009 형태도 검토했다.',
      '',
    ].join('\n'),
    'utf8',
  );
  const { providerRunner } = scriptedProvider([]);
  const created = await initRun(f, providerRunner);
  const run = await readRun(f.harnessRoot, created.runId);

  assert.deepEqual(run.spec.acceptance_ids, ['AC-001']);
  assert.deepEqual(run.spec.command_ids, ['CMD-001']);
});

test('계약 섹션이 없는 SPEC은 전문에서 그대로 파싱된다', async (t) => {
  const f = await fixture(t);
  const { providerRunner } = scriptedProvider([]);
  const created = await initRun(f, providerRunner);
  const run = await readRun(f.harnessRoot, created.runId);

  assert.deepEqual(run.spec.acceptance_ids, ['AC-001']);
  assert.deepEqual(run.spec.command_ids, ['CMD-001']);
});

test('계약 섹션 안의 하위 소제목은 경계가 아니고, 형제 헤딩만 경계다', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.specPath,
    [
      '# Toy SPEC',
      '',
      '## 계약',
      '',
      '### 수용 조건',
      '',
      '- AC-001: update app — 검증: CMD-001',
      '',
      '### 필수 검증 명령',
      '',
      '- CMD-001: `node --version`',
      '',
      '## 맥락',
      '',
      'CMD-004는 여기서만 언급된다. AC-009도 마찬가지다.',
      '',
    ].join('\n'),
    'utf8',
  );
  const { providerRunner } = scriptedProvider([]);
  const created = await initRun(f, providerRunner);
  const run = await readRun(f.harnessRoot, created.runId);

  assert.deepEqual(run.spec.acceptance_ids, ['AC-001']);
  assert.deepEqual(run.spec.command_ids, ['CMD-001']);
});

test('계약 섹션이 파일의 마지막 섹션이어도(뒤따르는 헤딩이 없어도) 파싱된다', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.specPath,
    [
      '# Toy SPEC',
      '',
      '## 계약',
      '',
      '- AC-001: update app — 검증: CMD-001',
      '- CMD-001: `node --version`',
      '',
    ].join('\n'),
    'utf8',
  );
  const { providerRunner } = scriptedProvider([]);
  const created = await initRun(f, providerRunner);
  const run = await readRun(f.harnessRoot, created.runId);

  assert.deepEqual(run.spec.acceptance_ids, ['AC-001']);
  assert.deepEqual(run.spec.command_ids, ['CMD-001']);
});

test('launcher approval maps to one exact approve-plan command', async () => {
  assert.deepEqual(actionArgv('approve', { runId: 'r1', currentPlanSha: 'a'.repeat(64) }), [
    'approve-plan', '--run', 'r1', '--plan-sha', 'a'.repeat(64),
  ]);
});

test('tracked pingpong skill connects a task to the public plan runner', async () => {
  const skill = await readFile(
    new URL('../integrations/claude/pingpong/SKILL.md', import.meta.url),
    'utf8',
  );
  const newWork = skill.split('## 새 작업 시작')[1];
  assert.match(skill, /^name: pingpong$/m);
  assert.match(skill, /^disable-model-invocation: true$/m);
  assert.match(skill, /\$ARGUMENTS/);
  assert.match(skill, /무슨 작업을 계획할까요\?/);
  assert.match(skill, /harness\.mjs"?\s+init --repo/);
  assert.match(skill, /harness\.mjs"?\s+run --run/);
  assert.match(skill, /pingpong resume/);
  assert.match(skill, /사용자가 명시한 저장소.*현재 Git root.*다르면/s);
  assert.match(skill, /\$env:TEMP/);
  assert.doesNotMatch(skill, /\.harness\/inputs/);
  assert.match(skill, /\.harness\/runs\/<runId>\/<currentPlanPath>/);
  assert.match(skill, /최종 SPEC 요약/);
  assert.match(skill, /명시적 승인.*전에는.*harness\.mjs.*init/s);
  assert.match(skill, /명시적 승인.*전에는.*Cursor Scout.*provider.*subagent.*호출하지 않는다/s);
  assert.match(skill, /최종 SPEC 요약.*명시적 승인.*승인 뒤.*harness\.mjs.*init/s);
  assert.match(skill, /수정.*SPEC.*다시.*승인/s);
  assert.match(skill, /계획을 바꾸는 미확정 맥락.*한 번에 하나씩/s);
  assert.match(skill, /현재 코드에서 답을 확인할 수 있으면.*묻지 않는다/s);
  assert.match(skill, /미확정 맥락이 하나라도 남아 있으면 SPEC으로 넘어가지 않는다/);
  assert.match(skill, /runner.*상태 전이/s);
  assert.match(skill, /cursorScoutUnavailableReason.*보여/s);
  assert.match(skill, /--parent-run "<이전 runId>"/);
  assert.match(skill, /## 계약[\s\S]*## 맥락/);
  assert.match(skill, /멱등.*비파괴/);
  assert.match(skill, /specCommandBaseline/);
  assert.match(skill, /specAcceptanceCoverage/);
  assert.match(skill, /`exit_code`가 `null`/);
  assert.match(skill, /다른 git 저장소/);
  // baseline 보고는 provider에 돈을 쓰기 전에 온다: init --repo → baseline → run --run.
  assert.ok(newWork.indexOf('init --repo') < newWork.indexOf('specCommandBaseline'));
  assert.ok(newWork.indexOf('specCommandBaseline') < newWork.indexOf('run --run'));
  assert.match(skill, /사용자 말과 현재 코드가 어긋나면.*묻는다/s);
  assert.match(skill, /lastErrorDetail/);
  assert.match(newWork, /새 작업 진입 시점부터.*명시적 승인.*Cursor Scout.*provider.*subagent.*호출하지 않는다/s);
  assert.ok(newWork.indexOf('새 작업 진입 시점부터') < newWork.indexOf('1. 현재 Git root'));
  assert.doesNotMatch(newWork, /launcher\.mjs/);
});

test('launcher has no disconnected new-task path', async () => {
  const output = [];
  const result = await launch({
    cwd: 'D:\\repo',
    runner: async () => ({ repoPath: 'D:\\repo', runs: [], warnings: [] }),
    ask: async () => { throw new Error('launcher must not ask for a new task'); },
    write: (line) => output.push(line),
  });
  assert.deepEqual(result, { type: 'exit' });
  assert.deepEqual(output, ['저장된 작업이 없습니다. 새 작업은 Claude Code에서 /pingpong <작업 설명>으로 시작하세요.']);
});

test('launcher displays a saved SPEC title before resuming it', async () => {
  const calls = [];
  const output = [];
  const answers = ['1', '1'];
  const runner = async (argv) => {
    calls.push(argv);
    if (argv[0] === 'list') {
      return {
        repoPath: 'D:\\repo',
        runs: [{
          runId: 'r1',
          taskSummary: 'Saved SPEC title',
          state: 'AWAIT_PLAN_APPROVAL',
          worktreePath: 'D:\\worktrees\\r1',
        }],
        warnings: [{ runId: 'stale-run', message: 'stale repo path: D:\\gone' }],
      };
    }
    if (argv[0] === 'status') {
      return {
        runId: 'r1',
        state: 'AWAIT_PLAN_APPROVAL',
        currentPlanSha: 'a'.repeat(64),
        cursorScoutStatus: 'unavailable',
        cursorScoutUnavailableReason: 'rate limited',
      };
    }
    return { runId: 'r1', state: 'IMPLEMENT_LOOP' };
  };
  await launch({
    cwd: 'D:\\repo',
    runner,
    ask: async () => answers.shift(),
    write: (line) => output.push(line),
  });
  assert.equal(output[0], '경고 [stale-run]: stale repo path: D:\\gone');
  assert.ok(output.includes('Cursor Scout: unavailable — rate limited'));
  assert.ok(output.includes('1. 저장 작업 이어가기: Saved SPEC title [AWAIT_PLAN_APPROVAL]'));
  assert.deepEqual(calls.at(-1), ['approve-plan', '--run', 'r1', '--plan-sha', 'a'.repeat(64)]);
});

test('launcher exit calls only list', async () => {
  const calls = [];
  const runner = async (argv) => {
    calls.push(argv);
    return {
      repoPath: 'D:\\repo',
      runs: [{ runId: 'r1', taskSummary: 'Saved task', state: 'PLAN_LOOP' }],
      warnings: [],
    };
  };
  await launch({ cwd: 'D:\\repo', runner, ask: async () => '2', write: () => {} });
  assert.deepEqual(calls, [['list', '--repo', 'D:\\repo']]);
});

test('launcher invokes exactly one selected state-changing command after explicit resume', async () => {
  const output = [];
  const calls = [];
  const answers = ['2', '1'];
  const runner = async (argv) => {
    calls.push(argv);
    if (argv[0] === 'list') {
      return {
        repoPath: 'D:\\repo',
        runs: [
          { runId: 'r1', taskSummary: 'First task', state: 'PLAN_LOOP', worktreePath: 'D:\\worktrees\\r1' },
          { runId: 'r2', taskSummary: 'Second task', state: 'AWAIT_PLAN_APPROVAL', worktreePath: 'D:\\worktrees\\r2' },
        ],
        warnings: [],
      };
    }
    if (argv[0] === 'status') {
      return {
        runId: 'r2',
        state: 'AWAIT_PLAN_APPROVAL',
        currentPlanPath: 'plans/PLAN-v1.md',
        currentPlanSha: 'a'.repeat(64),
        lastError: null,
      };
    }
    return { runId: 'r2', state: 'IMPLEMENT_LOOP' };
  };
  await launch({
    cwd: 'D:\\repo',
    runner,
    ask: async () => answers.shift(),
    write: (line) => output.push(line),
  });
  assert.ok(output.includes('1. 저장 작업 이어가기: First task [PLAN_LOOP]'));
  assert.ok(output.includes('2. 저장 작업 이어가기: Second task [AWAIT_PLAN_APPROVAL]'));
  assert.ok(output.includes('3. 종료'));
  assert.ok(output.includes('선택: r2 | D:\\worktrees\\r2'));
  assert.ok(output.includes('계획: plans/PLAN-v1.md'));
  assert.ok(output.includes(`계획 SHA: ${'a'.repeat(64)}`));
  assert.deepEqual(calls.at(-1), ['approve-plan', '--run', 'r2', '--plan-sha', 'a'.repeat(64)]);
  assert.equal(calls.filter((argv) => !['list', 'status'].includes(argv[0])).length, 1);
});

test('launcher resumes IMPLEMENT_LOOP with the public run command', async () => {
  const calls = [];
  const answers = ['1', '1'];
  const runner = async (argv) => {
    calls.push(argv);
    if (argv[0] === 'list') {
      return {
        repoPath: 'D:\\repo',
        runs: [{
          runId: 'r1',
          taskSummary: 'Ready to implement',
          state: 'IMPLEMENT_LOOP',
          worktreePath: 'D:\\worktrees\\r1',
        }],
        warnings: [],
      };
    }
    if (argv[0] === 'status') return { runId: 'r1', state: 'IMPLEMENT_LOOP' };
    return { runId: 'r1', state: 'READY_FOR_MANUAL_MERGE' };
  };

  const result = await launch({
    cwd: 'D:\\repo',
    runner,
    ask: async () => answers.shift(),
    write: () => {},
  });

  assert.equal(result.state, 'READY_FOR_MANUAL_MERGE');
  assert.deepEqual(calls.at(-1), ['run', '--run', 'r1']);
});

test('launcher keeps Abort and Exit for non-closed fallback states', async () => {
  for (const state of ['ABORTED', 'DONE', 'NEEDS_HUMAN', 'READY_FOR_MANUAL_MERGE']) {
    const calls = [];
    const output = [];
    const answers = ['1', '1', 'stop'];
    const runner = async (argv) => {
      calls.push(argv);
      if (argv[0] === 'list') {
        return {
          repoPath: 'D:\\repo',
          runs: [{ runId: 'r1', taskSummary: 'Saved task', state, worktreePath: 'D:\\worktrees\\r1' }],
          warnings: [],
        };
      }
      return { runId: 'r1', state, lastError: null };
    };
    await launch({
      cwd: 'D:\\repo',
      runner,
      ask: async () => answers.shift(),
      write: (line) => output.push(line),
    });
    const closed = state === 'ABORTED' || state === 'DONE';
    assert.deepEqual(
      output.filter((line) => /^\d+\. /.test(line)).slice(closed ? -1 : -2),
      closed ? ['1. 종료'] : ['1. 중단', '2. 종료'],
    );
    assert.deepEqual(
      calls.map((argv) => argv[0]),
      closed ? ['list', 'status'] : ['list', 'status', 'abort'],
    );
  }
});

test('launcher approval records the same approval transition as raw argv', async (t) => {
  const launcherFixture = await fixture(t);
  const rawFixture = await fixture(t);
  assert.notEqual(launcherFixture.harnessRoot, rawFixture.harnessRoot);
  assert.notEqual(launcherFixture.repo, rawFixture.repo);
  const sharedBase = await git(launcherFixture.repo, 'rev-parse', 'HEAD');
  await git(rawFixture.repo, 'fetch', launcherFixture.repo, sharedBase);
  await git(rawFixture.repo, 'checkout', '--detach', sharedBase);

  const approvalRun = async (f) => {
    const scripted = scriptedProvider([
      { step: 'cursor_scout', result: { scout } },
      { step: 'claude_plan', result: { plan: planV1 } },
      { step: 'codex_plan_review', result: { review: review(1) } },
    ]);
    return runCommand(['start', '--repo', f.repo, '--spec', f.specPath], {
      harnessRoot: f.harnessRoot,
      providerRunner: scripted.providerRunner,
    });
  };
  const viaLauncher = await approvalRun(launcherFixture);
  const raw = await approvalRun(rawFixture);
  await runCommand(actionArgv('approve', viaLauncher), { harnessRoot: launcherFixture.harnessRoot });
  await runCommand(['approve-plan', '--run', raw.runId, '--plan-sha', raw.currentPlanSha], { harnessRoot: rawFixture.harnessRoot });

  const approvalFields = ({ state, approved_plan_path, approved_plan_sha, approved_base_sha }) => ({
    state, approved_plan_path, approved_plan_sha, approved_base_sha,
  });
  const transitionFields = ({ previous_state, state, action, result }) => ({
    previous_state, state, action, result,
  });
  const events = async (f, runId) => JSON.parse((await readFile(
    path.join(f.harnessRoot, '.harness', 'runs', runId, 'events.jsonl'), 'utf8',
  )).trim().split('\n').at(-1));
  const viaLauncherRun = await readRun(launcherFixture.harnessRoot, viaLauncher.runId);
  const rawRun = await readRun(rawFixture.harnessRoot, raw.runId);
  assert.deepEqual(approvalFields(viaLauncherRun), approvalFields(rawRun));
  assert.deepEqual(
    transitionFields(await events(launcherFixture, viaLauncher.runId)),
    transitionFields(await events(rawFixture, raw.runId)),
  );
});

test('list finds no run, one run, and multiple active runs for a repo', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await runCommand(['list', '--repo', f.repo], { harnessRoot: f.harnessRoot })).runs, []);

  const first = await initRun(f);
  const single = await runCommand(['list', '--repo', f.repo], { harnessRoot: f.harnessRoot });
  assert.equal(single.selectedRunId, first.runId);
  assert.equal(single.runs[0].taskSummary, 'Toy SPEC');

  await writeFile(f.specPath, '# Other SPEC\n\nAC-001: other task\n\nCMD-001: `node --version`\n', 'utf8');
  const second = await initRun(f);
  const listed = await runCommand(['list', '--repo', f.repo], { harnessRoot: f.harnessRoot });
  assert.equal(listed.selectedRunId, null);
  assert.deepEqual(new Set(listed.runs.map((run) => run.runId)), new Set([first.runId, second.runId]));
});

test('init rejects an identical active task instead of resetting its budget', async (t) => {
  const f = await fixture(t);
  const first = await initRun(f);

  await assert.rejects(
    initRun(f),
    new RegExp(`matching active run exists: ${first.runId}`),
  );
});

test('list finds taskSummary from the first locked SPEC heading', async (t) => {
  const f = await fixture(t);
  const created = await initRun(f);
  const lockedSpec = path.join(f.harnessRoot, '.harness', 'runs', created.runId, 'SPEC.md');
  await writeFile(f.specPath, '# Changed source SPEC\n\nAC-001: changed\n\nCMD-001: `node --version`\n', 'utf8');
  await writeFile(lockedSpec, '\uFEFF  ## Locked task title\n\nAC-001: update app\n\nCMD-001: `node --version`\n', 'utf8');

  const listed = await runCommand(['list', '--repo', f.repo], { harnessRoot: f.harnessRoot });
  assert.equal(listed.runs[0].taskSummary, 'Locked task title');
});

test('list keeps a damaged locked SPEC selectable for recovery', async (t) => {
  const f = await fixture(t);
  const created = await initRun(f);
  await unlink(path.join(f.harnessRoot, '.harness', 'runs', created.runId, 'SPEC.md'));

  const listed = await runCommand(['list', '--repo', f.repo], { harnessRoot: f.harnessRoot });
  assert.equal(listed.runs[0].taskSummary, 'Untitled task');
  assert.deepEqual(listed.warnings, [{
    runId: created.runId,
    message: 'locked SPEC unavailable',
  }]);

  const calls = [];
  const request = await launch({
    cwd: f.repo,
    runner: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'list') return listed;
      throw new Error(`unexpected runner call: ${argv[0]}`);
    },
    ask: async () => '2',
    write: () => {},
  });
  assert.equal(request.type, 'exit');
  assert.deepEqual(calls, [['list', '--repo', f.repo]]);
});

test('list from a managed writer worktree selects only its owner run', async (t) => {
  const f = await fixture(t);
  const owner = await initRun(f);
  await writeFile(
    f.specPath,
    '# Second task\n\nAC-001: update app differently\n\nCMD-001: `node --version`\n',
    'utf8',
  );
  await initRun(f);
  const run = await readRun(f.harnessRoot, owner.runId);
  const listed = await runCommand(['list', '--repo', run.worktree_path], { harnessRoot: f.harnessRoot });
  assert.equal(listed.ownerRunId, owner.runId);
  assert.equal(listed.selectedRunId, owner.runId);
  assert.deepEqual(listed.runs.map((item) => item.runId), [owner.runId]);
});

test('list from a nested directory in an aborted writer worktree selects its owner run', async (t) => {
  const f = await fixture(t);
  const owner = await initRun(f);
  await runCommand(['abort', '--run', owner.runId, '--reason', 'stopped'], { harnessRoot: f.harnessRoot });
  const run = await readRun(f.harnessRoot, owner.runId);
  const nested = path.join(run.worktree_path, 'nested');
  await mkdir(nested);
  const listed = await runCommand(['list', '--repo', nested], { harnessRoot: f.harnessRoot });
  assert.equal(listed.ownerRunId, owner.runId);
  assert.equal(listed.selectedRunId, owner.runId);
  assert.deepEqual(listed.runs.map((item) => item.runId), [owner.runId]);
});

test('abort rejects closed runs without changing run state or events', async (t) => {
  const f = await fixture(t);
  const assertImmutable = async (runId) => {
    const root = path.join(f.harnessRoot, '.harness', 'runs', runId);
    const runPath = path.join(root, 'run.json');
    const eventsPath = path.join(root, 'events.jsonl');
    const beforeRun = await readFile(runPath, 'utf8');
    const beforeEvents = await readFile(eventsPath, 'utf8');
    await assert.rejects(
      runCommand(['abort', '--run', runId, '--reason', 'again'], { harnessRoot: f.harnessRoot }),
      /run is already closed/,
    );
    assert.equal(await readFile(runPath, 'utf8'), beforeRun);
    assert.equal(await readFile(eventsPath, 'utf8'), beforeEvents);
  };

  const aborted = await initRun(f);
  await runCommand(['abort', '--run', aborted.runId, '--reason', 'stopped'], {
    harnessRoot: f.harnessRoot,
  });
  await assertImmutable(aborted.runId);

  const done = await initRun(f);
  const donePath = path.join(f.harnessRoot, '.harness', 'runs', done.runId, 'run.json');
  const doneRun = await readRun(f.harnessRoot, done.runId);
  doneRun.state = 'DONE';
  await writeFile(donePath, `${JSON.stringify(doneRun, null, 2)}\n`, 'utf8');
  await assertImmutable(done.runId);
});

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

async function runToApproval(f) {
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: review(1, { findings: [finding()] }) } },
    {
      step: 'claude_plan_revise',
      result: { plan: planV2, decision: '# Decisions\n\nF-001: incorporated.\n' },
    },
    {
      step: 'codex_plan_review',
      result: { review: review(2, { prior: [{ id: 'F-001', status: 'resolved' }] }) },
    },
  ]);
  const created = await initRun(f, scripted.providerRunner);
  const result = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  return { ...scripted, created, result };
}

test('init creates a durable PLAN_LOOP run without provider calls', async (t) => {
  const f = await fixture(t);
  const scripted = scriptedProvider([]);
  const result = await initRun(f, scripted.providerRunner);
  const run = await readRun(f.harnessRoot, result.runId);

  assert.equal(result.state, 'PLAN_LOOP');
  assert.equal(run.state, 'PLAN_LOOP');
  assert.equal(run.base_sha, await git(f.repo, 'rev-parse', 'HEAD'));
  assert.equal(await readFile(path.join(f.harnessRoot, '.harness', 'runs', result.runId, 'SPEC.md'), 'utf8'), f.spec);
  assert.equal(await git(run.worktree_path, 'status', '--porcelain'), '');
  assert.deepEqual(scripted.calls, []);
});

test('init runs every CMD at base_sha and reports the result', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.specPath,
    [
      '# Toy SPEC',
      '',
      '## 계약',
      '',
      '- AC-001: app.txt가 그대로다 — 검증: CMD-001',
      '- AC-002: 새 파일이 생긴다 — 검증: 수동',
      '- CMD-001: `node --version`',
      '- CMD-002: `git ls-files --error-unmatch new.txt`',
      '',
    ].join('\n'),
    'utf8',
  );
  const { providerRunner } = scriptedProvider([]);
  const created = await initRun(f, providerRunner);
  const run = await readRun(f.harnessRoot, created.runId);

  assert.deepEqual(
    run.spec_command_baseline.map(({ id, exit_code }) => [id, exit_code]),
    [['CMD-001', 0], ['CMD-002', 1]],
  );
  assert.deepEqual(created.specCommandBaseline, run.spec_command_baseline);
  assert.deepEqual(run.spec_acceptance_coverage, [
    { id: 'AC-001', command_ids: ['CMD-001'] },
    { id: 'AC-002', command_ids: [] },
  ]);
  assert.equal(await git(run.worktree_path, 'status', '--porcelain'), '');
});

test('a CMD that dirties the baseline worktree is restored and flagged', async (t) => {
  const f = await fixture(t);
  const dirty = process.platform === 'win32'
    ? 'Set-Content -Path probe.txt -Value x'
    : 'printf x > probe.txt';
  await writeFile(
    f.specPath,
    `# Toy SPEC\n\nAC-001: update app\n\nCMD-001: \`${dirty}\`\n`,
    'utf8',
  );
  const { providerRunner } = scriptedProvider([]);
  const created = await initRun(f, providerRunner);
  const run = await readRun(f.harnessRoot, created.runId);

  assert.equal(run.spec_command_baseline[0].mutated_worktree, true);
  assert.equal(await git(run.worktree_path, 'status', '--porcelain'), '');
});

test('full two-review plan loop reaches AWAIT_PLAN_APPROVAL with durable artifacts', async (t) => {
  const f = await fixture(t);
  const { created, result, calls, queue } = await runToApproval(f);
  const runRoot = path.join(f.harnessRoot, '.harness', 'runs', created.runId);
  const run = await readRun(f.harnessRoot, created.runId);

  assert.equal(result.state, 'AWAIT_PLAN_APPROVAL');
  assert.equal(run.plan_review_round, 2);
  assert.equal(run.plan_version, 2);
  assert.deepEqual(calls.map((call) => call.step), [
    'cursor_scout',
    'claude_plan',
    'codex_plan_review',
    'claude_plan_revise',
    'codex_plan_review',
  ]);
  assert.equal(queue.length, 0);
  for (const relative of [
    'reviews/cursor-scout.md',
    'plan/PLAN_v1.md',
    'plan/PLAN_v2.md',
    'reviews/plan-r1.raw.jsonl',
    'reviews/plan-r1.json',
    'reviews/plan-r2.raw.jsonl',
    'reviews/plan-r2.json',
    'decisions/plan-r1.md',
  ]) {
    assert.ok((await readFile(path.join(runRoot, relative))).length > 0, relative);
  }
  assert.equal(run.cursor.scout_attempted, 1);
  assert.equal(run.cursor.scout_status, 'completed');
  assert.equal(run.current_plan_sha, sha256Bytes(Buffer.from(planV2)));
  assert.equal(calls[1].inputs.scout_sha256, calls[2].inputs.scout_sha256);
});

test('blank lines between multiple Scout items are accepted', async (t) => {
  const f = await fixture(t);
  const plan = `${planV1}
SCOUT-001: incorporated — reuse app.txt
SCOUT-002: incorporated — verify app.test.txt
`;
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout: multiScout } },
    { step: 'claude_plan', result: { plan } },
    { step: 'codex_plan_review', result: { review: review(1) } },
  ]);

  const result = await runCommand(['start', '--repo', f.repo, '--spec', f.specPath], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  const run = await readRun(f.harnessRoot, result.runId);

  assert.equal(result.cursorScoutStatus, 'completed');
  assert.deepEqual(run.cursor.scout_ids, ['SCOUT-001', 'SCOUT-002']);
  assert.equal(scripted.calls[1].inputs.scout, multiScout);
});

test('unavailable Scout continues once and is never retried', async (t) => {
  const f = await fixture(t);
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { exitCode: 5, stdout: '', stderr: 'rate limited', scout: '' } },
    { step: 'claude_plan', result: { plan: '# Plan\n\nAC-001 -> app.txt -> CMD-001\n\nCP-001\n' } },
    { step: 'codex_plan_review', result: { review: review(1) } },
  ]);
  const created = await initRun(f, scripted.providerRunner);
  const first = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  const second = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  const run = await readRun(f.harnessRoot, created.runId);

  assert.equal(first.state, 'AWAIT_PLAN_APPROVAL');
  assert.equal(second.state, 'AWAIT_PLAN_APPROVAL');
  assert.match(first.cursorScoutUnavailableReason, /rate limited/);
  assert.equal(run.cursor.scout_status, 'unavailable');
  assert.match(run.cursor.unavailable_reason, /rate limited|exit/i);
  assert.equal(scripted.calls.filter((call) => call.step === 'cursor_scout').length, 1);
  assert.equal(scripted.queue.length, 0);
});

test('unavailable Scout records its lifecycle and discard reason', async (t) => {
  const f = await fixture(t);
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { exitCode: 5, stdout: '', stderr: 'rate limited', scout: '' } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: review(1) } },
  ]);

  const result = await runCommand(['start', '--repo', f.repo, '--spec', f.specPath], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  const events = (await readFile(
    path.join(f.harnessRoot, '.harness', 'runs', result.runId, 'events.jsonl'),
    'utf8',
  )).trim().split('\n').map((line) => JSON.parse(line));

  assert.deepEqual(
    events
      .filter(({ action }) => action.startsWith('cursor_scout_'))
      .map(({ action, result: eventResult }) => [action, eventResult]),
    [
      ['cursor_scout_start', 'attempt 1'],
      ['cursor_scout_unavailable', 'rate limited'],
    ],
  );
});

test('completed Scout records the adopted item count', async (t) => {
  const f = await fixture(t);
  const plan = `${planV1}
SCOUT-001: incorporated — reuse app.txt
SCOUT-002: incorporated — verify app.test.txt
`;
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout: multiScout } },
    { step: 'claude_plan', result: { plan } },
    { step: 'codex_plan_review', result: { review: review(1) } },
  ]);

  const result = await runCommand(['start', '--repo', f.repo, '--spec', f.specPath], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  const events = (await readFile(
    path.join(f.harnessRoot, '.harness', 'runs', result.runId, 'events.jsonl'),
    'utf8',
  )).trim().split('\n').map((line) => JSON.parse(line));

  assert.deepEqual(
    events
      .filter(({ action }) => action === 'cursor_scout_completed')
      .map(({ result: eventResult }) => eventResult),
    ['2 items'],
  );
});

test('a second blocked review stops at NEEDS_HUMAN without a third call', async (t) => {
  const f = await fixture(t);
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: review(1, { findings: [finding()] }) } },
    { step: 'claude_plan_revise', result: { plan: planV2, decision: 'F-001: incorporated' } },
    {
      step: 'codex_plan_review',
      result: {
        review: review(2, {
          findings: [finding('F-002')],
          prior: [{ id: 'F-001', status: 'open' }],
        }),
      },
    },
  ]);
  const created = await initRun(f, scripted.providerRunner);
  const first = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  const count = scripted.calls.length;
  const second = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });

  assert.equal(first.state, 'NEEDS_HUMAN');
  assert.equal(second.state, 'NEEDS_HUMAN');
  assert.equal(scripted.calls.length, count);
  assert.equal(scripted.queue.length, 0);
});

test('a review round that resolves nothing stops the loop even under budget', async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.harnessRoot, 'policy.json'),
    JSON.stringify({ budgets: { plan_review_max: 6 } }),
    'utf8',
  );
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: review(1, { findings: [finding()] }) } },
    { step: 'claude_plan_revise', result: { plan: planV2, decision: 'F-001: incorporated' } },
    {
      step: 'codex_plan_review',
      result: {
        review: review(2, {
          findings: [finding('F-001')],
          prior: [{ id: 'F-001', status: 'open' }],
        }),
      },
    },
  ]);
  const created = await initRun(f, scripted.providerRunner);
  const result = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });

  assert.equal(result.state, 'NEEDS_HUMAN');
  assert.equal(scripted.queue.length, 0, '예산이 남아도 헛돌면 더 안 돈다');
  assert.match(result.lastError, /stall/i);
  assert.equal(result.lastErrorDetail.blocking_findings.length, 1, 'F-001이 한 번만 나온다');
  assert.deepEqual(result.lastErrorDetail.unresolved_prior_findings, [
    { id: 'F-001', status: 'open' },
  ]);
  assert.ok(result.lastErrorDetail.next_action);
});

test('a review round that omits reclassification of a prior finding stalls the loop', async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.harnessRoot, 'policy.json'),
    JSON.stringify({ budgets: { plan_review_max: 6 } }),
    'utf8',
  );
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: review(1, { findings: [finding()] }) } },
    { step: 'claude_plan_revise', result: { plan: planV2, decision: 'F-001: incorporated' } },
    // Round 2 says nothing at all about F-001 — not resolved, not still open, not
    // reported. previous_gate_blocking_ids is genuinely non-empty (F-001, from
    // round 1); an empty prior_findings here must still stall, not slide through
    // on "there was nothing to check".
    { step: 'codex_plan_review', result: { review: review(2, {}) } },
  ]);
  const created = await initRun(f, scripted.providerRunner);
  const result = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });

  assert.equal(result.state, 'NEEDS_HUMAN');
  assert.equal(scripted.queue.length, 0, '리바이저를 다시 부르지 않는다');
  assert.match(result.lastError, /stall/i);
});

test('a reviser that returns the same plan bytes stops instead of spinning', async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.harnessRoot, 'policy.json'),
    JSON.stringify({ budgets: { plan_review_max: 6 } }),
    'utf8',
  );
  // 같은 계획을 그대로 돌려주면 current_plan_sha가 안 바뀌어 리뷰어가 건너뛰어지고
  // plan_review_round가 영영 안 오른다 — stall 룰도 라운드 예산도 발동하지 못한다.
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: review(1, { findings: [finding()] }) } },
    { step: 'claude_plan_revise', result: { plan: planV1, decision: 'F-001: incorporated' } },
  ]);
  const created = await initRun(f, scripted.providerRunner);
  const result = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  const revisions = scripted.calls.filter((call) => call.step === 'claude_plan_revise');

  assert.equal(result.state, 'NEEDS_HUMAN');
  assert.equal(revisions.length, 1, '수렴하지 않는 리바이저를 두 번 부르지 않는다');
  assert.equal(scripted.queue.length, 0);
  assert.match(result.lastError, /unchanged plan/i);
  assert.equal(result.planReviewRound, 1);
  assert.ok(result.lastErrorDetail.next_action);
  assert.equal(result.lastErrorDetail.blocking_findings.length, 1);
});

test('a converging review round keeps going past the old three-round ceiling', async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.harnessRoot, 'policy.json'),
    JSON.stringify({ budgets: { plan_review_max: 6 } }),
    'utf8',
  );
  const planV3 = planV2.replace('CP-001', 'CP-001\n\nCP-002');
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: review(1, { findings: [finding('F-001')] }) } },
    { step: 'claude_plan_revise', result: { plan: planV2, decision: 'F-001: incorporated' } },
    {
      step: 'codex_plan_review',
      result: {
        review: review(2, {
          findings: [finding('F-002')],
          prior: [{ id: 'F-001', status: 'resolved' }],
        }),
      },
    },
    { step: 'claude_plan_revise', result: { plan: planV3, decision: 'F-002: incorporated' } },
    {
      step: 'codex_plan_review',
      result: { review: review(3, { prior: [{ id: 'F-002', status: 'resolved' }] }) },
    },
  ]);
  const created = await initRun(f, scripted.providerRunner);
  const result = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });

  assert.equal(result.state, 'AWAIT_PLAN_APPROVAL');
  assert.equal(scripted.queue.length, 0);
});

test('a blocking spec_defect stops the loop immediately at spec_gate', async (t) => {
  const f = await fixture(t);
  const specDefect = {
    ...finding('F-001'),
    severity: 'blocker',
    category: 'spec_defect',
    evidence: ['SPEC 계약: CMD-001: `git grep -q deploy`'],
  };
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: review(1, { findings: [specDefect] }) } },
  ]);
  const created = await initRun(f, scripted.providerRunner);
  const result = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  const events = (await readFile(
    path.join(f.harnessRoot, '.harness', 'runs', created.runId, 'events.jsonl'),
    'utf8',
  )).trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(result.state, 'NEEDS_HUMAN');
  assert.equal(scripted.queue.length, 0, '리바이저를 호출하지 않는다');
  assert.match(result.lastError, /SPEC/i);
  assert.ok(events.some(({ action }) => action === 'spec_gate'));
  assert.equal(result.lastErrorDetail.blocking_findings[0].category, 'spec_defect');
  assert.match(result.lastErrorDetail.blocking_findings[0].evidence[0], /CMD-001/);
});

test('spec_gate는 같은 라운드에 함께 있던 계획 결함도 버리지 않는다', async (t) => {
  const f = await fixture(t);
  const specDefect = {
    ...finding('F-001'),
    severity: 'blocker',
    category: 'spec_defect',
    evidence: ['SPEC 계약: CMD-001: `git grep -q deploy`'],
  };
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    {
      step: 'codex_plan_review',
      // SPEC 결함과 계획 결함이 한 라운드에 같이 온다. SPEC만 고쳐 새 run을 시작한
      // 사람이 못 본 계획 blocker를 그때 처음 만나면 안 된다.
      result: { review: review(1, { findings: [specDefect], ac: [], checkpoints: 0 }) },
    },
  ]);
  const created = await initRun(f, scripted.providerRunner);
  const result = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });

  assert.equal(result.state, 'NEEDS_HUMAN');
  assert.deepEqual(result.lastErrorDetail.blocking_findings.map(({ id }) => id), ['F-001']);
  assert.ok(result.lastErrorDetail.plan_defects.length > 0, '계획 결함이 그대로 남는다');
  assert.deepEqual(result.lastErrorDetail.failed_acceptance.map(({ id }) => id), ['AC-001']);
});

test('a finding without a category is treated as a plan defect', async (t) => {
  const f = await fixture(t);
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: review(1, { findings: [finding()] }) } },
    { step: 'claude_plan_revise', result: { plan: planV2, decision: 'F-001: incorporated' } },
    {
      step: 'codex_plan_review',
      result: { review: review(2, { prior: [{ id: 'F-001', status: 'resolved' }] }) },
    },
  ]);
  const created = await initRun(f, scripted.providerRunner);
  const result = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });

  assert.equal(result.state, 'AWAIT_PLAN_APPROVAL');
  assert.equal(scripted.queue.length, 0);
});

test('lastErrorDetail from a spec_gate stop clears once the run recovers', async (t) => {
  const f = await fixture(t);
  const specDefect = {
    ...finding('F-001'),
    severity: 'blocker',
    category: 'spec_defect',
    evidence: ['SPEC 계약: CMD-001: `git grep -q deploy`'],
  };
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: review(1, { findings: [specDefect] }) } },
  ]);
  const created = await initRun(f, scripted.providerRunner);
  const first = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  assert.equal(first.state, 'NEEDS_HUMAN');
  assert.ok(first.lastErrorDetail, 'spec_gate stop must record blocking finding detail');

  const notePath = path.join(f.root, 'human-plan-note.md');
  await writeFile(notePath, '# Human request\n\nSPEC fixed upstream; retry.\n', 'utf8');
  scripted.queue.push(
    { step: 'claude_plan_revise', result: { plan: planV2, decision: 'F-001: incorporated' } },
    {
      step: 'codex_plan_review',
      result: { review: review(2, { prior: [{ id: 'F-001', status: 'resolved' }] }) },
    },
  );

  const requested = await runCommand(
    ['request-plan-revision', '--run', created.runId, '--note-file', notePath],
    { harnessRoot: f.harnessRoot, providerRunner: scripted.providerRunner },
  );
  assert.equal(requested.state, 'PLAN_LOOP');
  assert.equal(requested.lastErrorDetail, null, 'recovering from spec_gate must clear stale detail');

  const resumed = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  assert.equal(resumed.state, 'AWAIT_PLAN_APPROVAL');
  assert.equal(resumed.lastErrorDetail, null, 'a clean gate must not report a stale SPEC defect');
});

test('aborting a spec_gate stop clears the SPEC defect detail', async (t) => {
  const f = await fixture(t);
  const specDefect = {
    ...finding('F-001'),
    severity: 'blocker',
    category: 'spec_defect',
    evidence: ['SPEC 계약: CMD-001: `git grep -q deploy`'],
  };
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: review(1, { findings: [specDefect] }) } },
  ]);
  const created = await initRun(f, scripted.providerRunner);
  const first = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  assert.equal(first.state, 'NEEDS_HUMAN');
  assert.ok(first.lastErrorDetail, 'spec_gate stop must record blocking finding detail');

  const aborted = await runCommand(
    ['abort', '--run', created.runId, '--reason', 'SPEC contract is wrong'],
    { harnessRoot: f.harnessRoot },
  );
  assert.equal(aborted.state, 'ABORTED');
  assert.equal(aborted.lastError, 'SPEC contract is wrong');
  assert.equal(aborted.lastErrorDetail, null, 'abort must clear stale SPEC defect detail');
});

test('approve-plan accepts only the exact current plan digest', async (t) => {
  const f = await fixture(t);
  const { created, providerRunner } = await runToApproval(f);

  await assert.rejects(
    runCommand(['approve-plan', '--run', created.runId, '--plan-sha', '0'.repeat(64)], {
      harnessRoot: f.harnessRoot,
      providerRunner,
    }),
    /digest|sha/i,
  );
  assert.equal((await readRun(f.harnessRoot, created.runId)).state, 'AWAIT_PLAN_APPROVAL');

  const before = await readRun(f.harnessRoot, created.runId);
  const approved = await runCommand(
    ['approve-plan', '--run', created.runId, '--plan-sha', before.current_plan_sha],
    { harnessRoot: f.harnessRoot, providerRunner },
  );
  const after = await readRun(f.harnessRoot, created.runId);

  assert.equal(approved.state, 'IMPLEMENT_LOOP');
  assert.equal(after.approved_plan_sha, before.current_plan_sha);
  assert.equal(after.approved_plan_path, before.current_plan_path);
  assert.equal(after.approved_base_sha, before.base_sha);
});

test('approved plan runs one Codex implementation and verified diff reaches manual merge', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.specPath,
    '# Toy SPEC\n\nAC-001: update app\n\nCMD-001: `node --check app.txt`\n',
    'utf8',
  );
  const planning = await runToApproval(f);
  const before = await readRun(f.harnessRoot, planning.created.runId);
  await runCommand(
    ['approve-plan', '--run', planning.created.runId, '--plan-sha', before.current_plan_sha],
    { harnessRoot: f.harnessRoot, providerRunner: planning.providerRunner },
  );
  const verificationCalls = [];
  const providerRunner = async (request) => {
    if (request.step !== 'codex_implement') return planning.providerRunner(request);
    await writeFile(path.join(request.cwd, 'app.txt'), 'implemented\n', 'utf8');
    await writeFile(path.join(request.cwd, 'new.txt'), 'new file\n', 'utf8');
    return { exitCode: 0, stdout: 'implemented', stderr: '' };
  };

  const result = await runCommand(['run', '--run', planning.created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner,
    processRunner: async (request) => {
      verificationCalls.push(request);
      return { exitCode: 0, stdout: 'ok\n', stderr: '' };
    },
  });
  const run = await readRun(f.harnessRoot, planning.created.runId);
  const root = path.join(f.harnessRoot, '.harness', 'runs', planning.created.runId);

  assert.equal(result.state, 'READY_FOR_MANUAL_MERGE');
  assert.deepEqual(run.implementation.changed_paths, ['app.txt', 'new.txt']);
  assert.match(run.implementation.digest, /^[0-9a-f]{64}$/);
  assert.equal(verificationCalls.length, 1);
  assert.match(verificationCalls[0].args.join(' '), /node --check app\.txt/);
  assert.match(
    await readFile(path.join(root, 'evidence', 'CMD-001.log'), 'utf8'),
    /command_id: CMD-001[\s\S]*exit_code: 0[\s\S]*stdout:\nok/,
  );
  assert.match(
    await readFile(path.join(root, 'implementation.diff'), 'utf8'),
    /implemented[\s\S]*new file mode[\s\S]*new file/,
  );
  assert.ok(
    JSON.parse(await readFile(path.join(root, 'implementation-manifest.json'), 'utf8'))
      .filter(({ type }) => type === 'file')
      .every(({ mode }) => Number.isInteger(mode)),
  );
});

test('locked CMD sees untracked implementation files through a throwaway index', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.specPath,
    '# Toy SPEC\n\nAC-001: add a new file\n\nCMD-001: `git ls-files --error-unmatch new.txt`\n',
    'utf8',
  );
  const planning = await runToApproval(f);
  const before = await readRun(f.harnessRoot, planning.created.runId);
  await runCommand(
    ['approve-plan', '--run', planning.created.runId, '--plan-sha', before.current_plan_sha],
    { harnessRoot: f.harnessRoot, providerRunner: planning.providerRunner },
  );

  const result = await runCommand(['run', '--run', planning.created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: async (request) => {
      if (request.step !== 'codex_implement') return planning.providerRunner(request);
      await writeFile(path.join(request.cwd, 'new.txt'), 'new file\n', 'utf8');
      return { exitCode: 0, stdout: 'implemented', stderr: '' };
    },
  });
  const run = await readRun(f.harnessRoot, planning.created.runId);

  assert.equal(result.state, 'READY_FOR_MANUAL_MERGE');
  assert.deepEqual(await stagedPathsForTest(run.worktree_path), []);
});

async function stagedPathsForTest(worktree) {
  const out = await git(worktree, 'diff', '--cached', '--name-only');
  return out ? out.split('\n') : [];
}

test('implementation touching a protected path stops before verification', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.repo, '.gitignore'), '.harness/\n', 'utf8');
  await git(f.repo, 'add', '.gitignore');
  await git(f.repo, 'commit', '-m', 'ignore protected harness path');
  await writeFile(
    f.specPath,
    '# Toy SPEC\n\nAC-001: update app\n\nCMD-001: `node --check app.txt`\n',
    'utf8',
  );
  const planning = await runToApproval(f);
  const before = await readRun(f.harnessRoot, planning.created.runId);
  await runCommand(
    ['approve-plan', '--run', planning.created.runId, '--plan-sha', before.current_plan_sha],
    { harnessRoot: f.harnessRoot, providerRunner: planning.providerRunner },
  );
  let verificationCalls = 0;

  const result = await runCommand(['run', '--run', planning.created.runId], {
    harnessRoot: f.harnessRoot,
    platform: 'win32',
    providerRunner: async (request) => {
      if (request.step !== 'codex_implement') return planning.providerRunner(request);
      await mkdir(path.join(request.cwd, '.HARNESS'));
      await writeFile(path.join(request.cwd, '.HARNESS', 'owned.txt'), 'no\n', 'utf8');
      return { exitCode: 0, stdout: 'implemented', stderr: '' };
    },
    processRunner: async () => {
      verificationCalls += 1;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.state, 'NEEDS_HUMAN');
  assert.match(result.lastError, /protected path.*\.HARNESS/i);
  assert.equal(verificationCalls, 0);
});

test('verification mutating an existing implementation file stops with the changed diff preserved', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.specPath,
    '# Toy SPEC\n\nAC-001: update app\n\nCMD-001: `node --check app.txt`\n',
    'utf8',
  );
  const planning = await runToApproval(f);
  const before = await readRun(f.harnessRoot, planning.created.runId);
  await runCommand(
    ['approve-plan', '--run', planning.created.runId, '--plan-sha', before.current_plan_sha],
    { harnessRoot: f.harnessRoot, providerRunner: planning.providerRunner },
  );

  const result = await runCommand(['run', '--run', planning.created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: async (request) => {
      if (request.step !== 'codex_implement') return planning.providerRunner(request);
      await writeFile(path.join(request.cwd, 'app.txt'), 'implemented\n', 'utf8');
      return { exitCode: 0, stdout: 'implemented', stderr: '' };
    },
    processRunner: async (request) => {
      await writeFile(path.join(request.cwd, 'app.txt'), 'verification changed it\n', 'utf8');
      return { exitCode: 0, stdout: 'ok\n', stderr: '' };
    },
  });
  const run = await readRun(f.harnessRoot, planning.created.runId);

  assert.equal(result.state, 'NEEDS_HUMAN');
  assert.match(result.lastError, /CMD-001 changed.*worktree/i);
  assert.equal(await readFile(path.join(run.worktree_path, 'app.txt'), 'utf8'), 'verification changed it\n');
});

test('Codex staging source changes is rejected before verification', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.specPath,
    '# Toy SPEC\n\nAC-001: update app\n\nCMD-001: `node --check app.txt`\n',
    'utf8',
  );
  const planning = await runToApproval(f);
  const before = await readRun(f.harnessRoot, planning.created.runId);
  await runCommand(
    ['approve-plan', '--run', planning.created.runId, '--plan-sha', before.current_plan_sha],
    { harnessRoot: f.harnessRoot, providerRunner: planning.providerRunner },
  );
  let verificationCalls = 0;

  const result = await runCommand(['run', '--run', planning.created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: async (request) => {
      if (request.step !== 'codex_implement') return planning.providerRunner(request);
      await writeFile(path.join(request.cwd, 'app.txt'), 'implemented\n', 'utf8');
      await git(request.cwd, 'add', 'app.txt');
      return { exitCode: 0, stdout: 'implemented', stderr: '' };
    },
    processRunner: async () => {
      verificationCalls += 1;
      return { exitCode: 0, stdout: 'ok\n', stderr: '' };
    },
  });

  assert.equal(result.state, 'NEEDS_HUMAN');
  assert.match(result.lastError, /staged/i);
  assert.equal(verificationCalls, 0);
});

test('verification inspection failure records evidence and stops in NEEDS_HUMAN', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.specPath,
    '# Toy SPEC\n\nAC-001: update app\n\nCMD-001: `node --check app.txt`\n',
    'utf8',
  );
  const planning = await runToApproval(f);
  const before = await readRun(f.harnessRoot, planning.created.runId);
  await runCommand(
    ['approve-plan', '--run', planning.created.runId, '--plan-sha', before.current_plan_sha],
    { harnessRoot: f.harnessRoot, providerRunner: planning.providerRunner },
  );

  const result = await runCommand(['run', '--run', planning.created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: async (request) => {
      if (request.step !== 'codex_implement') return planning.providerRunner(request);
      await writeFile(path.join(request.cwd, 'app.txt'), 'implemented\n', 'utf8');
      return { exitCode: 0, stdout: 'implemented', stderr: '' };
    },
    processRunner: async (request) => {
      await unlink(path.join(request.cwd, '.git'));
      return { exitCode: 0, stdout: 'ok\n', stderr: '' };
    },
  });
  const root = path.join(f.harnessRoot, '.harness', 'runs', planning.created.runId);
  const run = await readRun(f.harnessRoot, planning.created.runId);

  assert.equal(result.state, 'NEEDS_HUMAN');
  assert.equal(run.active_step, null);
  assert.match(result.lastError, /CMD-001.*inspection/i);
  assert.match(
    await readFile(path.join(root, 'evidence', 'CMD-001.log'), 'utf8'),
    /exit_code: 0[\s\S]*inspection_error:/,
  );
});

test('a concurrent run cannot start a second Codex writer for the same run', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.specPath,
    '# Toy SPEC\n\nAC-001: update app\n\nCMD-001: `node --check app.txt`\n',
    'utf8',
  );
  const planning = await runToApproval(f);
  const before = await readRun(f.harnessRoot, planning.created.runId);
  await runCommand(
    ['approve-plan', '--run', planning.created.runId, '--plan-sha', before.current_plan_sha],
    { harnessRoot: f.harnessRoot, providerRunner: planning.providerRunner },
  );
  let release;
  let markStarted;
  let writerCalls = 0;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const providerRunner = async (request) => {
    if (request.step !== 'codex_implement') return planning.providerRunner(request);
    writerCalls += 1;
    await writeFile(path.join(request.cwd, 'app.txt'), 'implemented\n', 'utf8');
    await new Promise((resolve) => {
      release = resolve;
      markStarted();
    });
    return { exitCode: 0, stdout: 'implemented', stderr: '' };
  };
  const options = {
    harnessRoot: f.harnessRoot,
    providerRunner,
    processRunner: async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '' }),
  };

  const first = runCommand(['run', '--run', planning.created.runId], options);
  await started;
  const second = runCommand(['run', '--run', planning.created.runId], options);
  release();

  await assert.rejects(second, /already executing/i);
  assert.equal((await first).state, 'READY_FOR_MANUAL_MERGE');
  assert.equal(writerCalls, 1);
});

test('an old ownerless run lock is recovered after a crashed acquisition', async (t) => {
  const f = await fixture(t);
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: review(1) } },
  ]);
  const created = await initRun(f, scripted.providerRunner);
  const lock = path.join(f.harnessRoot, '.harness', 'runs', created.runId, '.runner-lock');
  await mkdir(lock);
  const stale = new Date(Date.now() - 10_000);
  await utimes(lock, stale, stale);

  const result = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });

  assert.equal(result.state, 'AWAIT_PLAN_APPROVAL');
  await assert.rejects(readFile(path.join(lock, 'owner.json')), { code: 'ENOENT' });
});

test('failed required command keeps the diff and evidence in NEEDS_HUMAN', async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.specPath,
    '# Toy SPEC\n\nAC-001: update app\n\nCMD-001: `node --check app.txt`\n',
    'utf8',
  );
  const planning = await runToApproval(f);
  const before = await readRun(f.harnessRoot, planning.created.runId);
  await runCommand(
    ['approve-plan', '--run', planning.created.runId, '--plan-sha', before.current_plan_sha],
    { harnessRoot: f.harnessRoot, providerRunner: planning.providerRunner },
  );

  const result = await runCommand(['run', '--run', planning.created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: async (request) => {
      if (request.step !== 'codex_implement') return planning.providerRunner(request);
      await writeFile(path.join(request.cwd, 'app.txt'), 'broken\n', 'utf8');
      return { exitCode: 0, stdout: 'implemented', stderr: '' };
    },
    processRunner: async () => ({ exitCode: 1, stdout: '', stderr: 'syntax error\n' }),
  });
  const root = path.join(f.harnessRoot, '.harness', 'runs', planning.created.runId);

  assert.equal(result.state, 'NEEDS_HUMAN');
  assert.match(result.lastError, /CMD-001.*exited with code 1/i);
  assert.equal(await readFile(path.join((await readRun(f.harnessRoot, planning.created.runId)).worktree_path, 'app.txt'), 'utf8'), 'broken\n');
  assert.match(
    await readFile(path.join(root, 'evidence', 'CMD-001.log'), 'utf8'),
    /exit_code: 1[\s\S]*stderr:\nsyntax error/,
  );
});

test('human can request one explicit plan revision without rerunning Scout', async (t) => {
  const f = await fixture(t);
  const { created, providerRunner, calls, queue } = await runToApproval(f);
  const notePath = path.join(f.root, 'human-plan-note.md');
  const note = '# Human request\n\nAdd a rollback checkpoint before approval.\n';
  const planV3 = `${planV2}\nCP-002: document the rollback checkpoint.\n`;
  await writeFile(notePath, note, 'utf8');
  queue.push(
    {
      step: 'claude_plan_revise',
      result: { plan: planV3, decision: '# Decisions\n\nHuman request: incorporated.\n' },
    },
    { step: 'codex_plan_review', result: { review: review(3, { checkpoints: 2 }) } },
  );

  const requested = await runCommand(
    ['request-plan-revision', '--run', created.runId, '--note-file', notePath],
    { harnessRoot: f.harnessRoot, providerRunner },
  );
  assert.equal(requested.state, 'PLAN_LOOP');

  const resumed = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner,
  });
  assert.equal(resumed.state, 'AWAIT_PLAN_APPROVAL');
  assert.equal(resumed.planReviewRound, 3);
  assert.equal(resumed.planVersion, 3);
  assert.equal(calls.filter((call) => call.step === 'cursor_scout').length, 1);
  const revisionCall = calls.at(-2);
  const reviewCall = calls.at(-1);
  assert.equal(revisionCall.inputs.human_revision_note, note);
  assert.equal(reviewCall.inputs.human_revision_note, note);
  const root = path.join(f.harnessRoot, '.harness', 'runs', created.runId);
  assert.equal(await readFile(path.join(root, 'decisions', 'human-plan-revision-1.md'), 'utf8'), note);
  await assert.rejects(
    runCommand(
      ['request-plan-revision', '--run', created.runId, '--note-file', notePath],
      { harnessRoot: f.harnessRoot, providerRunner },
    ),
    /revision budget exhausted/,
  );
});

test('an explicit parent run carries its latest plan and review into the new planner', async (t) => {
  const f = await fixture(t);
  const parent = await runToApproval(f);
  const parentRun = await readRun(f.harnessRoot, parent.created.runId);
  await runCommand(
    ['abort', '--run', parent.created.runId, '--reason', 'contract changed'],
    { harnessRoot: f.harnessRoot },
  );
  await writeFile(
    f.specPath,
    '# Toy SPEC v2\n\nAC-001: update app with the revised contract\n\nCMD-001: `node --version`\n',
    'utf8',
  );
  const childProvider = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: review(1) } },
  ]);

  const child = await runCommand(
    [
      'start',
      '--repo', f.repo,
      '--spec', f.specPath,
      '--parent-run', parent.created.runId,
    ],
    {
      harnessRoot: f.harnessRoot,
      providerRunner: childProvider.providerRunner,
    },
  );
  const childRun = await readRun(f.harnessRoot, child.runId);
  const planner = childProvider.calls[1];
  const reviewer = childProvider.calls[2];

  assert.equal(childRun.parent_run_id, parent.created.runId);
  assert.equal(planner.inputs.baseline_plan, planV2);
  assert.equal(planner.inputs.baseline_review.round, 2);
  assert.equal(planner.inputs.baseline_spec, f.spec);
  assert.equal(planner.inputs.baseline_base_sha, parentRun.base_sha);
  assert.equal(reviewer.inputs.review_scope, 'delta');
  assert.equal(reviewer.inputs.previous_plan, planV2);
  assert.equal(reviewer.inputs.previous_review.round, 2);
});

test('an active run cannot be used as a carryover parent', async (t) => {
  const f = await fixture(t);
  const parent = await runToApproval(f);
  await writeFile(
    f.specPath,
    '# Toy SPEC v2\n\nAC-001: update app with the revised contract\n\nCMD-001: `node --version`\n',
    'utf8',
  );

  await assert.rejects(
    runCommand(
      [
        'init',
        '--repo', f.repo,
        '--spec', f.specPath,
        '--parent-run', parent.created.runId,
      ],
      { harnessRoot: f.harnessRoot },
    ),
    /parent run must be ABORTED/,
  );
});

test('the lineage review budget stops a child before another revision cycle', async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.harnessRoot, 'policy.json'),
    JSON.stringify({ budgets: { plan_review_max: 2, lineage_plan_review_max: 3 } }),
    'utf8',
  );
  const parent = await runToApproval(f);
  await runCommand(
    ['abort', '--run', parent.created.runId, '--reason', 'contract changed'],
    { harnessRoot: f.harnessRoot },
  );
  await writeFile(
    f.specPath,
    '# Toy SPEC v2\n\nAC-001: update app with the revised contract\n\nCMD-001: `node --version`\n',
    'utf8',
  );
  const childProvider = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: review(1, { findings: [finding()] }) } },
  ]);

  const child = await runCommand(
    [
      'start',
      '--repo', f.repo,
      '--spec', f.specPath,
      '--parent-run', parent.created.runId,
    ],
    {
      harnessRoot: f.harnessRoot,
      providerRunner: childProvider.providerRunner,
    },
  );

  assert.equal(child.state, 'NEEDS_HUMAN');
  assert.equal(child.lineagePlanReviewRounds, 3);
  assert.match(child.lastError, /lineage plan review budget exhausted/);
  assert.deepEqual(
    childProvider.calls.map(({ step }) => step),
    ['cursor_scout', 'claude_plan', 'codex_plan_review'],
  );
});

test('restart retries only the interrupted reviewer and preserves Scout and plan', async (t) => {
  const f = await fixture(t);
  const crash = Object.assign(new Error('simulated power loss'), { code: 'SIMULATED_CRASH' });
  const firstProvider = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', throw: crash },
  ]);
  const created = await initRun(f, firstProvider.providerRunner);
  await assert.rejects(
    runCommand(['run', '--run', created.runId], {
      harnessRoot: f.harnessRoot,
      providerRunner: firstProvider.providerRunner,
    }),
    /simulated power loss/,
  );
  const interrupted = await readRun(f.harnessRoot, created.runId);
  assert.equal(interrupted.active_step.type, 'codex_plan_review');
  assert.equal(interrupted.active_step.attempt, 1);

  const resumedProvider = scriptedProvider([
    { step: 'codex_plan_review', result: { review: review(1) } },
  ]);
  const resumed = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: resumedProvider.providerRunner,
  });

  assert.equal(resumed.state, 'AWAIT_PLAN_APPROVAL');
  assert.deepEqual(resumedProvider.calls.map((call) => call.step), ['codex_plan_review']);
  assert.equal((await readRun(f.harnessRoot, created.runId)).cursor.scout_attempted, 1);
});

test('run stops before providers when the writer worktree drifted from the locked base', async (t) => {
  const f = await fixture(t);
  const scripted = scriptedProvider([]);
  const created = await initRun(f, scripted.providerRunner);
  const run = await readRun(f.harnessRoot, created.runId);
  await writeFile(path.join(run.worktree_path, 'app.txt'), 'dirty\n', 'utf8');

  const result = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });

  assert.equal(result.state, 'NEEDS_HUMAN');
  assert.match(result.lastError, /base|clean|status|drift/i);
  assert.equal(scripted.calls.length, 0);
});

test('tampered locked SPEC stops before any provider call', async (t) => {
  const f = await fixture(t);
  const scripted = scriptedProvider([]);
  const created = await initRun(f, scripted.providerRunner);
  const root = path.join(f.harnessRoot, '.harness', 'runs', created.runId);
  await writeFile(path.join(root, 'SPEC.md'), `${f.spec}\nAC-999: tampered\n`, 'utf8');

  const result = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  assert.equal(result.state, 'NEEDS_HUMAN');
  assert.match(result.lastError, /SPEC.*digest|SPEC.*changed/i);
  assert.deepEqual(scripted.calls, []);
});

test('tampered Scout artifact blocks a human revision request', async (t) => {
  const f = await fixture(t);
  const { created, providerRunner } = await runToApproval(f);
  const root = path.join(f.harnessRoot, '.harness', 'runs', created.runId);
  await writeFile(path.join(root, 'reviews', 'cursor-scout.md'), `${scout}\nSCOUT-002 | unknown\nevidence: none\nnote: tampered\n`, 'utf8');
  const notePath = path.join(f.root, 'note.md');
  await writeFile(notePath, 'Revise the plan.\n', 'utf8');

  const result = await runCommand(
    ['request-plan-revision', '--run', created.runId, '--note-file', notePath],
    { harnessRoot: f.harnessRoot, providerRunner },
  );
  assert.equal(result.state, 'NEEDS_HUMAN');
  assert.match(result.lastError, /Scout.*digest|Scout.*changed/i);
});

test('invalid Claude plan is not adopted and remains retryable', async (t) => {
  const f = await fixture(t);
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: '# Invalid\n\nAC-001 CMD-001\n' } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: review(1) } },
  ]);
  const created = await initRun(f, scripted.providerRunner);

  await assert.rejects(
    runCommand(['run', '--run', created.runId], {
      harnessRoot: f.harnessRoot,
      providerRunner: scripted.providerRunner,
    }),
    /CP-001|checkpoint|plan needs/i,
  );
  let run = await readRun(f.harnessRoot, created.runId);
  assert.equal(run.plan_version, 0);
  assert.equal(run.active_step.attempt, 1);

  const result = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  assert.equal(result.state, 'AWAIT_PLAN_APPROVAL');
});

test('second consecutive provider failure immediately becomes NEEDS_HUMAN', async (t) => {
  const f = await fixture(t);
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', throw: new Error('planner unavailable one') },
    { step: 'claude_plan', throw: new Error('planner unavailable two') },
  ]);
  const created = await initRun(f, scripted.providerRunner);
  await assert.rejects(
    runCommand(['run', '--run', created.runId], {
      harnessRoot: f.harnessRoot,
      providerRunner: scripted.providerRunner,
    }),
    /planner unavailable one/,
  );

  const result = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  assert.equal(result.state, 'NEEDS_HUMAN');
  assert.match(result.lastError, /planner unavailable two/);
  assert.equal((await readRun(f.harnessRoot, created.runId)).active_step, null);
});

test('second reviewer receives the previous review and Claude decision verbatim', async (t) => {
  const f = await fixture(t);
  const { calls } = await runToApproval(f);
  const firstReview = calls[2];
  const secondReview = calls[4];

  assert.equal(firstReview.inputs.review_scope, 'full');
  assert.equal(firstReview.inputs.previous_plan, '');
  assert.equal(secondReview.step, 'codex_plan_review');
  assert.equal(secondReview.inputs.review_scope, 'delta');
  assert.equal(secondReview.inputs.previous_plan, planV1);
  assert.equal(secondReview.inputs.previous_review.findings[0].id, 'F-001');
  assert.match(secondReview.inputs.previous_decision, /F-001: incorporated/);
});

test('a thrown Scout provider error becomes unavailable and the plan loop continues', async (t) => {
  const f = await fixture(t);
  const scripted = scriptedProvider([
    { step: 'cursor_scout', throw: new Error('Cursor offline') },
    { step: 'claude_plan', result: { plan: '# Plan\n\nAC-001 -> app.txt -> CMD-001\n\nCP-001\n' } },
    { step: 'codex_plan_review', result: { review: review(1) } },
  ]);
  const created = await initRun(f, scripted.providerRunner);

  const result = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  const run = await readRun(f.harnessRoot, created.runId);

  assert.equal(result.state, 'AWAIT_PLAN_APPROVAL');
  assert.equal(run.cursor.scout_status, 'unavailable');
  assert.match(run.cursor.unavailable_reason, /Cursor offline/);
  assert.equal(scripted.calls.filter((call) => call.step === 'cursor_scout').length, 1);
});

test('malformed structured review stays active and can be retried once', async (t) => {
  const f = await fixture(t);
  const malformed = review(1, {
    ac: [{ ...acPass, implementation_ref: 42 }],
  });
  const firstProvider = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: malformed } },
  ]);
  const created = await initRun(f, firstProvider.providerRunner);

  await assert.rejects(
    runCommand(['run', '--run', created.runId], {
      harnessRoot: f.harnessRoot,
      providerRunner: firstProvider.providerRunner,
    }),
    /implementation_ref/i,
  );
  const interrupted = await readRun(f.harnessRoot, created.runId);
  assert.equal(interrupted.active_step.type, 'codex_plan_review');
  assert.equal(interrupted.active_step.attempt, 1);

  const resumedProvider = scriptedProvider([
    { step: 'codex_plan_review', result: { review: review(1) } },
  ]);
  const resumed = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: resumedProvider.providerRunner,
  });
  assert.equal(resumed.state, 'AWAIT_PLAN_APPROVAL');
});

test('incomplete Claude decision is not adopted and remains retryable', async (t) => {
  const f = await fixture(t);
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout } },
    { step: 'claude_plan', result: { plan: planV1 } },
    { step: 'codex_plan_review', result: { review: review(1, { findings: [finding()] }) } },
    { step: 'claude_plan_revise', result: { plan: planV2, decision: 'No disposition here.' } },
    {
      step: 'claude_plan_revise',
      result: { plan: planV2, decision: 'F-001: incorporated' },
    },
    {
      step: 'codex_plan_review',
      result: { review: review(2, { prior: [{ id: 'F-001', status: 'resolved' }] }) },
    },
  ]);
  const created = await initRun(f, scripted.providerRunner);
  await assert.rejects(
    runCommand(['run', '--run', created.runId], {
      harnessRoot: f.harnessRoot,
      providerRunner: scripted.providerRunner,
    }),
    /decision is missing F-001/,
  );
  assert.equal((await readRun(f.harnessRoot, created.runId)).plan_version, 1);

  const result = await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  assert.equal(result.state, 'AWAIT_PLAN_APPROVAL');
});

test('default provider builds a read-only Cursor Scout invocation', async () => {
  const calls = [];
  const runner = createDefaultProviderRunner({
    harnessRoot: path.resolve('.'),
    env: { ...process.env, CURSOR_API_KEY: '' },
    platform: 'linux',
    commands: {
      powershell: 'powershell.exe',
      agentScript: 'C:\\cursor-agent\\agent.ps1',
    },
    processRunner: async (request) => {
      calls.push(request);
      return { exitCode: 0, stdout: scout, stderr: '' };
    },
  });

  const result = await runner({
    step: 'cursor_scout',
    provider: 'cursor',
    runId: 'run-1',
    round: 1,
    cwd: 'C:\\repo',
    inputs: { spec: 'AC-001 CMD-001', base_sha: 'abc' },
  });

  assert.equal(result.scout, scout);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.deepEqual(calls[0].args.slice(0, 5), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    'C:\\cursor-agent\\agent.ps1',
  ]);
  for (const required of ['-p', '--mode', 'plan', '--sandbox', 'enabled', '--workspace', 'C:\\repo']) {
    assert.ok(calls[0].args.includes(required), required);
  }
  for (const forbidden of ['-ExecutionPolicy', 'Bypass', '-f', '--force', '--yolo', '--approve-mcps']) {
    assert.ok(!calls[0].args.includes(forbidden), forbidden);
  }
});

test('default provider omits the Cursor sandbox flag on Windows', async () => {
  const calls = [];
  const runner = createDefaultProviderRunner({
    harnessRoot: path.resolve('.'),
    env: { ...process.env, CURSOR_API_KEY: '' },
    platform: 'win32',
    commands: {
      powershell: 'powershell.exe',
      agentScript: 'C:\\cursor-agent\\agent.ps1',
    },
    processRunner: async (request) => {
      calls.push(request);
      return { exitCode: 0, stdout: scout, stderr: '' };
    },
  });

  const result = await runner({
    step: 'cursor_scout',
    provider: 'cursor',
    runId: 'run-1',
    round: 1,
    cwd: 'C:\\repo',
    inputs: { spec: 'AC-001 CMD-001', base_sha: 'abc' },
  });

  assert.equal(result.scout, scout);
  assert.ok(!calls[0].args.includes('--sandbox'), 'sandbox flag must be omitted on win32');
  for (const required of ['-p', '--mode', 'plan', '--workspace', 'C:\\repo']) {
    assert.ok(calls[0].args.includes(required), required);
  }
});

test('default provider parses Claude planner and reviser outputs', async () => {
  const calls = [];
  const runner = createDefaultProviderRunner({
    harnessRoot: path.resolve('.'),
    env: { ...process.env, ANTHROPIC_API_KEY: '' },
    commands: { claude: 'claude.exe' },
    processRunner: async (request) => {
      calls.push(request);
      if (calls.length === 1) return { exitCode: 0, stdout: planV1, stderr: '' };
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          type: 'result',
          structured_output: {
            plan_markdown: planV2,
            decisions_markdown: 'F-001: incorporated',
          },
        }),
        stderr: '',
      };
    },
  });

  const planned = await runner({
    step: 'claude_plan',
    provider: 'claude',
    runId: 'run-1',
    round: 1,
    cwd: 'C:\\repo',
    inputs: { spec: 'AC-001 CMD-001', scout: scout, scout_status: 'completed' },
  });
  const revised = await runner({
    step: 'claude_plan_revise',
    provider: 'claude',
    runId: 'run-1',
    round: 1,
    cwd: 'C:\\repo',
    inputs: { spec: 'AC-001 CMD-001', plan: planV1, review: review(1), scout },
  });

  assert.equal(planned.plan, planV1);
  assert.equal(revised.plan, planV2);
  assert.equal(revised.decision, 'F-001: incorporated');
  const { planner } = JSON.parse(
    await readFile(new URL('../policy.json', import.meta.url), 'utf8'),
  ).models;
  assert.deepEqual(
    calls[0].args.slice(calls[0].args.indexOf('--model'), calls[0].args.indexOf('--model') + 4),
    ['--model', planner.model, '--effort', planner.effort],
  );
  assert.ok(calls[0].args.includes('--permission-mode'));
  assert.ok(calls[0].args.includes('plan'));
  assert.ok(calls[1].args.includes('--json-schema'));
  assert.match(calls[0].input, /AC-001 CMD-001/);
});

test('default provider reads Codex structured review from output-last-message', async () => {
  const expected = review(1);
  const calls = [];
  const runner = createDefaultProviderRunner({
    harnessRoot: path.resolve('.'),
    env: { ...process.env, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
    commands: { codex: 'codex.exe' },
    processRunner: async (request) => {
      calls.push(request);
      const output = request.args[request.args.indexOf('--output-last-message') + 1];
      await writeFile(output, JSON.stringify(expected), 'utf8');
      return { exitCode: 0, stdout: '{"type":"turn.completed"}\n', stderr: '' };
    },
  });

  const result = await runner({
    step: 'codex_plan_review',
    provider: 'codex',
    runId: 'run-1',
    round: 1,
    cwd: 'C:\\repo',
    inputs: {
      spec: 'AC-001 CMD-001',
      plan: planV1,
      scout,
      previous_gate_blocking_ids: [],
      previous_review: null,
      previous_decision: '',
    },
  });

  assert.deepEqual(result.review, expected);
  assert.deepEqual(
    calls[0].args.slice(calls[0].args.indexOf('-m'), calls[0].args.indexOf('-m') + 4),
    ['-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="ultra"'],
  );
  for (const required of ['exec', '--sandbox', 'read-only', '--json', '--output-schema', '--output-last-message', '--ephemeral', '--color', 'never', '-']) {
    assert.ok(calls[0].args.includes(required), required);
  }
  assert.equal(calls[0].cwd, 'C:\\repo');
  assert.match(calls[0].input, /"round": 1/);
});

test('default provider gives Codex implementation workspace-write without review output flags', async () => {
  const calls = [];
  const runner = createDefaultProviderRunner({
    harnessRoot: path.resolve('.'),
    env: { ...process.env, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
    commands: { codex: 'codex.exe' },
    processRunner: async (request) => {
      calls.push(request);
      return { exitCode: 0, stdout: '{"type":"turn.completed"}\n', stderr: '' };
    },
  });

  const result = await runner({
    step: 'codex_implement',
    provider: 'codex',
    runId: 'run-1',
    round: 1,
    cwd: 'C:\\repo',
    inputs: {
      spec: 'AC-001 CMD-001',
      plan: planV1,
      verification_commands: [{ id: 'CMD-001', command: 'node --check app.txt' }],
      protected_paths: ['.git', '.harness'],
    },
  });

  assert.equal(result.exitCode, 0);
  assert.ok(calls[0].args.includes('workspace-write'));
  assert.deepEqual(
    calls[0].args.slice(calls[0].args.indexOf('-m'), calls[0].args.indexOf('-m') + 4),
    ['-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="xhigh"'],
  );
  for (const forbidden of ['read-only', '--output-schema', '--output-last-message']) {
    assert.ok(!calls[0].args.includes(forbidden), forbidden);
  }
});

test('default provider refuses API-key auth and makes Cursor key use a soft failure', async () => {
  const never = async () => {
    throw new Error('process runner must not be called');
  };
  const claude = createDefaultProviderRunner({
    harnessRoot: path.resolve('.'),
    env: { ...process.env, ANTHROPIC_API_KEY: 'forbidden' },
    processRunner: never,
  });
  await assert.rejects(
    claude({ step: 'claude_plan', provider: 'claude', cwd: '.', inputs: {} }),
    /ANTHROPIC_API_KEY/,
  );

  const cursor = createDefaultProviderRunner({
    harnessRoot: path.resolve('.'),
    env: { ...process.env, CURSOR_API_KEY: 'forbidden' },
    processRunner: never,
  });
  const result = await cursor({ step: 'cursor_scout', provider: 'cursor', cwd: '.', inputs: {} });
  assert.equal(result.exitCode, 5);
  assert.match(result.stderr, /CURSOR_API_KEY/);

  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY']) {
    const codex = createDefaultProviderRunner({
      harnessRoot: path.resolve('.'),
      env: { ...process.env, OPENAI_API_KEY: '', CODEX_API_KEY: '', [key]: 'forbidden' },
      processRunner: never,
    });
    await assert.rejects(
      codex({ step: 'codex_plan_review', provider: 'codex', cwd: '.', inputs: {}, round: 1 }),
      /OPENAI_API_KEY\/CODEX_API_KEY/,
    );
  }
});

test('default provider returns malformed structured output with raw bytes intact', async () => {
  const claudeRaw = 'not-json-from-claude';
  const claude = createDefaultProviderRunner({
    harnessRoot: path.resolve('.'),
    env: { ...process.env, ANTHROPIC_API_KEY: '' },
    processRunner: async () => ({ exitCode: 0, stdout: claudeRaw, stderr: '' }),
  });
  const claudeResult = await claude({
    step: 'claude_plan_revise',
    provider: 'claude',
    cwd: '.',
    inputs: {},
  });
  assert.equal(claudeResult.stdout, claudeRaw);
  assert.match(claudeResult.adapterError, /JSON|Unexpected|invalid/i);

  const codexRaw = '{"type":"turn.completed"}\n';
  const codex = createDefaultProviderRunner({
    harnessRoot: path.resolve('.'),
    env: { ...process.env, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
    processRunner: async (request) => {
      const output = request.args[request.args.indexOf('--output-last-message') + 1];
      await writeFile(output, 'not-json-from-codex', 'utf8');
      return { exitCode: 0, stdout: codexRaw, stderr: '' };
    },
  });
  const codexResult = await codex({
    step: 'codex_plan_review',
    provider: 'codex',
    cwd: '.',
    inputs: {},
    round: 1,
  });
  assert.equal(codexResult.stdout, codexRaw);
  assert.match(codexResult.adapterError, /JSON|Unexpected/i);
});

test('Scout output with prose or non-sequential IDs is unavailable', async (t) => {
  const f = await fixture(t);
  const invalidScout = `extra prose\nSCOUT-002 | reuse\nevidence: app.txt\nnote: reuse it\n`;
  const scripted = scriptedProvider([
    { step: 'cursor_scout', result: { scout: invalidScout } },
    { step: 'claude_plan', result: { plan: '# Plan\n\nAC-001 -> app.txt -> CMD-001\n\nCP-001\n' } },
    { step: 'codex_plan_review', result: { review: review(1) } },
  ]);
  const created = await initRun(f, scripted.providerRunner);

  await runCommand(['run', '--run', created.runId], {
    harnessRoot: f.harnessRoot,
    providerRunner: scripted.providerRunner,
  });
  const run = await readRun(f.harnessRoot, created.runId);
  assert.equal(run.cursor.scout_status, 'unavailable');
  assert.match(run.cursor.unavailable_reason, /format|sequential|prose/i);
});

test('runProcess timeout returns only after the Windows child is gone', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-harness-timeout-'));
  const pidFile = path.join(root, 'pid.txt');
  let pid;
  t.after(async () => {
    if (pid) {
      try { await exec('taskkill.exe', ['/PID', String(pid), '/T', '/F']); } catch {}
    }
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    runProcess({
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`],
      cwd: root,
      timeoutMs: 400,
    }),
    /timed out/,
  );
  pid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH|no such process|kill/i);
  pid = undefined;
});
