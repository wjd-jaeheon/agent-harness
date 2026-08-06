# SPEC 신뢰성 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SPEC이 잠긴 뒤에도 검증이 진실을 보게 하고, 사람이 SPEC 전문을 읽지 않아도 승인 판단이 서게 만든다.

**Architecture:** SPEC 단계에 모델을 추가하지 않는다 (사람+AI 대화가 SPEC의 검증 수단이라는 설계 유지). 대신 대화에 **기계적 사실**을 공급한다 — base_sha에서 CMD를 실제 실행한 exit code, AC↔CMD 매핑. 그리고 사람이 승인하는 **계약**과 planner가 읽는 **맥락**을 한 파일 안에서 분리해 승인 부담과 planner 입력을 떼어놓는다. 계획 루프는 라운드 수가 아니라 수렴으로 예산을 쓰고, SPEC 자체가 결함이면 라운드를 태우지 않고 즉시 사람에게 돌린다.

**Tech Stack:** Node.js ESM 단일 파일 (`harness.mjs`), `node:test`, git CLI. 새 의존성 없음.

## Global Constraints

- 새 npm 의존성 추가 금지. Node 내장 모듈만.
- `harness.mjs`가 상태 전이를 단독 소유한다. pingpong SKILL이나 launcher는 `run.json` / `events.jsonl`을 직접 쓰지 않는다.
- `.harness/runs/` 아래 기존 run 산출물을 수정·삭제하지 않는다 (crm_frontend 작업이 재개 대기 중).
- implementer가 stage하면 중단시키는 불변조건을 유지한다 (`harness.mjs:1820`). 실제 인덱스는 계속 깨끗해야 한다.
- 검증 명령은 Windows에서 `powershell.exe -Command`, 그 외에서 `/bin/sh -lc`로 실행된다 (`verificationRequest`, `harness.mjs:891`).
- 테스트: `node --test tests/harness.test.mjs` (현재 58 pass, ~60초). 모든 태스크 끝에서 전체 통과해야 한다.
- 기존 SPEC 형식(계약 섹션 없음)으로 만든 run은 계속 동작해야 한다 — 새 규칙은 전부 하위호환 가능한 형태로 넣는다.

## File Structure

| 파일 | 책임 | 이 계획에서 |
|---|---|---|
| `harness.mjs` | 상태 전이, git 경계, 검증 실행 | 전 태스크에서 수정 |
| `schemas/review-output.schema.json` | Codex 리뷰 출력 계약 | T4 |
| `prompts/plan-reviewer.md` | 리뷰어 지시 | T4 |
| `policy.json` | 예산·모델 정책 | T5 |
| `SPEC.example.md` | SPEC 작성 양식 | T2, T6 |
| `integrations/claude/pingpong/SKILL.md` | SPEC 작성 대화 규칙 | T6 |
| `README.md` | 사용 문서 | T6 |
| `tests/harness.test.mjs` | 전체 테스트 | 전 태스크 |

`harness.mjs`는 2085줄 단일 파일이다. 이 저장소의 확립된 패턴이므로 분할하지 않는다.

---

### Task 1: 검증 명령이 구현 산출물을 보게 한다

locked CMD는 워킹트리에서 실행되는데, implementer는 stage가 금지돼 있어 모든 산출물이 untracked다. 그래서 `git grep`, `git ls-files`, `git diff HEAD`, lint-staged 등 git-aware 명령이 조용히 빈 집합을 본다. 에러도 경고도 없다.

버려도 되는 임시 인덱스에 산출물을 넣고 그 인덱스로 CMD를 실행한다. 실제 인덱스는 손대지 않으므로 "stage 금지" 불변조건이 유지된다.

**Files:**
- Modify: `harness.mjs:477-489` (`gitRawOutput`, `gitOutput`에 env 파라미터)
- Modify: `harness.mjs:1864-1938` (검증 루프)
- Test: `tests/harness.test.mjs`

**Interfaces:**
- Produces: `gitRawOutput(gitExecutable, cwd, args, env?)` / `gitOutput(gitExecutable, cwd, args, env?)` — 네 번째 인자 `env`를 주면 그 환경으로 git을 실행한다. 생략하면 기존과 동일하게 `process.env`를 상속한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/harness.test.mjs`의 검증 관련 테스트들(`'approved plan runs one Codex implementation...'` 근처) 옆에 추가한다. `processRunner`를 주입하지 않아 실제 `runProcess`가 돈다.

```js
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
```

`git ls-files --error-unmatch new.txt`는 인덱스에 `new.txt`가 없으면 exit 1이다. 임시 인덱스가 없으면 이 CMD는 항상 실패한다 — 이번 crm_frontend run이 죽은 것과 정확히 같은 형태다.

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test tests/harness.test.mjs --test-name-pattern "throwaway index"`
Expected: FAIL — `result.state`가 `NEEDS_HUMAN`, `lastError`가 `CMD-001 exited with code 1`

- [ ] **Step 3: git 헬퍼에 env를 뚫는다**

`harness.mjs:477`:

```js
async function gitRawOutput(gitExecutable, cwd, args, env) {
  const { stdout } = await exec(gitExecutable, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    ...(env ? { env } : {}),
  });
  return stdout;
}

async function gitOutput(gitExecutable, cwd, args, env) {
  return (await gitRawOutput(gitExecutable, cwd, args, env)).trim();
}
```

- [ ] **Step 4: 검증 루프를 임시 인덱스로 감싼다**

`harness.mjs:1864`의 `let expectedSnapshot = await gitSnapshot(...)` 부터 루프 끝(`:1938`)까지를 아래로 바꾼다.

```js
  let expectedSnapshot = await gitSnapshot(run, gitExecutable);
  // locked CMD는 워킹트리에서 돌지만 구현 산출물은 전부 untracked다 (implementer는
  // stage 금지). 그래서 git grep / ls-files / diff HEAD가 조용히 빈 집합을 본다.
  // 버릴 인덱스에 산출물을 넣어 CMD에만 건네고, 실제 인덱스는 그대로 둔다.
  const indexDirectory = await mkdtemp(path.join(tmpdir(), 'agent-harness-index-'));
  const verificationEnv = {
    ...options.env,
    GIT_INDEX_FILE: path.join(indexDirectory, 'index'),
  };
  try {
    // read-tree를 먼저 하지 않으면 .gitignore에 매칭되는 tracked 파일이
    // add -A 뒤 "삭제"로 보인다.
    await gitOutput(gitExecutable, run.worktree_path, ['read-tree', 'HEAD'], verificationEnv);
    await gitOutput(gitExecutable, run.worktree_path, ['add', '-A'], verificationEnv);
  } catch (error) {
    await rm(indexDirectory, { recursive: true, force: true });
    return stopImplementation(
      harnessRoot,
      run,
      `verification index could not be built: ${error.message}`,
      'verification',
    );
  }
  try {
    for (const verification of verificationCommands) {
      // ... 기존 루프 본문 그대로, processRunner 호출만 env 교체 ...
    }
  } finally {
    await rm(indexDirectory, { recursive: true, force: true });
  }
```

루프 본문 안의 `processRunner` 호출(`harness.mjs:1869`)만 바꾼다:

```js
      commandResult = await processRunner({
        ...verificationRequest(verification.command, run.worktree_path, platform),
        env: verificationEnv,
      });
```

루프 안의 `stopImplementation` early return들은 `finally`가 임시 디렉터리를 지우므로 그대로 둔다.

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `node --test tests/harness.test.mjs`
Expected: PASS — 59개 전부

`stagedPaths()`(`harness.mjs:817`)는 `process.env`를 쓰므로 실제 인덱스를 본다. 임시 인덱스는 `verificationChangedWorktree` 판정(`harness.mjs:1924`)에 잡히지 않는다. 새 테스트의 `stagedPathsForTest` 단언이 이걸 확인한다.

- [ ] **Step 6: 커밋**

```bash
git add harness.mjs tests/harness.test.mjs
git commit -m "fix: run locked verification commands against a throwaway git index"
```

---

### Task 2: SPEC을 계약과 맥락으로 나눈다

지금 SPEC 하나가 두 역할을 겸한다 — 사람이 승인하는 계약이면서 planner의 입력이다. planner를 잘 시키려면 두꺼워야 하고 사람이 판정하려면 얇아야 하니 충돌한다.

한 파일 안에서 `## 계약` 섹션을 분리하고, AC/CMD 파싱을 그 섹션으로 제한한다. 파일은 하나로 유지되므로 잠금(`verifyLockedInputs`)과 무결성 모델은 그대로다. 맥락 산문에 `CMD-004` 같은 미정의 번호를 써도 더 이상 터지지 않는다.

**Files:**
- Modify: `harness.mjs:519-525` (`validateSpec`), `harness.mjs:688-699` (`parseVerificationCommands`), `harness.mjs:986-992` (`initCommand`), `harness.mjs:1740-1746` (`runImplementationLoop`)
- Modify: `SPEC.example.md`
- Test: `tests/harness.test.mjs`

**Interfaces:**
- Produces: `contractSection(specText) -> string` — SPEC에서 `## 계약`(또는 `## Contract`) 헤딩 아래 같은 레벨 이상의 다음 헤딩 전까지를 반환한다. 헤딩이 없으면 SPEC 전문을 그대로 반환한다 (하위호환).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```js
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test tests/harness.test.mjs --test-name-pattern "맥락 섹션"`
Expected: FAIL — `CMD-004 needs one backtick-wrapped executable command` 로 `init`이 거부

- [ ] **Step 3: `contractSection`을 추가한다**

`harness.mjs`의 `extractIds`(`:515`) 바로 아래:

```js
/**
 * 사람이 승인하는 계약과 planner만 읽는 맥락을 한 파일 안에서 가른다.
 * AC/CMD는 계약 섹션에서만 파싱하므로 맥락 산문은 자유롭게 쓸 수 있다.
 * 계약 헤딩이 없는 SPEC은 전문이 계약이다 (기존 run 하위호환).
 */
function contractSection(specText) {
  const heading = specText.match(/^\s{0,3}(#{1,6})\s*(?:계약|Contract)\s*$/im);
  if (!heading) return specText;
  const rest = specText.slice(heading.index + heading[0].length);
  const next = rest.match(new RegExp(`^\\s{0,3}#{1,${heading[1].length}}\\s+\\S`, 'm'));
  return next ? rest.slice(0, next.index) : rest;
}
```

`#{1,level}` 이라서 계약 섹션 안의 더 깊은 소제목(`### 수용 조건`)은 경계로 치지 않는다.

- [ ] **Step 4: 호출부 네 곳을 계약 섹션으로 돌린다**

`initCommand` (`harness.mjs:989-992`):

```js
  const specBytes = await readFile(specPath);
  const specText = specBytes.toString('utf8');
  const contract = contractSection(specText);
  const spec = validateSpec(contract);
  const commands = await preflightVerificationCommands(contract, spec.commandIds, options);
```

`runImplementationLoop` (`harness.mjs:1746`):

```js
    verificationCommands = parseVerificationCommands(contractSection(specText), run.spec.command_ids);
```

`validateSpec`과 `parseVerificationCommands` 본문은 바꾸지 않는다 — 받는 문자열만 달라진다.

planner/reviewer/implementer에게 넘기는 `spec` 입력은 **전문 그대로** 유지한다 (`callPlanner:1444`, `callReviewer:1511`, `callReviser:1569`, `runImplementationLoop:1754`). 맥락은 그들이 읽어야 한다.

- [ ] **Step 5: `preflightVerificationCommands`가 파싱 결과를 반환하게 한다**

Task 3에서 재사용한다. `harness.mjs:705`:

```js
async function preflightVerificationCommands(specText, commandIds, options) {
  const commands = parseVerificationCommands(specText, commandIds);
  // ... 기존 본문 그대로 ...
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return commands;
}
```

- [ ] **Step 6: `SPEC.example.md`를 새 형식으로 바꾼다**

```markdown
# 작업 계약

## 계약

사람이 승인하는 부분. 이 섹션 안에서만 `AC-###`와 `CMD-###`가 파싱된다.

### 요청

사용자가 체감할 수 있는 변경을 한 문단으로 적는다.

### 범위 밖

- 이번 작업에서 하지 않을 일을 적는다.

### 수용 조건

각 줄 끝에 그 조건을 판정하는 `CMD-###`를 적는다. 자동 판정이 불가능하면 `검증: 수동`이라고 적는다.

- AC-001: 사용자가 어떤 입력을 주면 어떤 결과를 확인할 수 있어야 한다 — 검증: CMD-001
- AC-002: 기존 동작 중 무엇이 그대로 유지되어야 한다 — 검증: CMD-002

### 필수 검증 명령

**검증 명령은 멱등·비파괴여야 한다.** runner가 base_sha에서 한 번, 구현 뒤에 또 한 번 실행한다. 배포·마이그레이션·과금·외부 쓰기는 검증이 아니라 작업이다. 배포 자동화 작업이면 `deploy --dry-run` 형태를 쓴다.

- CMD-001: `프로젝트의 실제 테스트 명령`
- CMD-002: `프로젝트의 실제 빌드 또는 정적 검사 명령`

각 줄은 백틱 하나로 감싼 실행 가능한 명령으로 끝난다. 백틱 뒤에 설명을 붙이지 않는다. Windows에서는 PowerShell로 실행되므로 `&&` 같은 POSIX 연산자는 Git Bash 전체 경로로 감싼다: `C:\PROGRA~1\Git\bin\bash.exe -c '...'`. 무수식 `bash`는 WSL 런처로 해석되어 거부된다.

### 제약

- 수정하면 안 되는 파일, 호환성, 보안 또는 사용량 제약을 적는다.

## 맥락

planner·reviewer·implementer가 읽는다. 사람 승인 요약에는 안 들어간다. 길어도 된다.

대화에서 나온 결정과 그 근거, 조사한 파일, 검토했다가 버린 대안을 적는다. 이 섹션에서는 `CMD-###` / `AC-###` 번호를 자유롭게 언급해도 파싱되지 않는다.
```

- [ ] **Step 7: 전체 테스트**

Run: `node --test tests/harness.test.mjs`
Expected: PASS — 61개

기존 테스트의 SPEC들은 `## 계약` 헤딩이 없으므로 전문이 계약으로 처리된다. 하나도 안 깨져야 한다.

- [ ] **Step 8: 커밋**

```bash
git add harness.mjs SPEC.example.md tests/harness.test.mjs
git commit -m "feat: parse AC/CMD from the SPEC contract section only"
```

---

### Task 3: base_sha에서 CMD를 실제 실행하고 커버리지를 보고한다

`preflightVerificationCommands`는 셸 파싱 가능 여부만 본다. 의미 검증이 전혀 없다. `git grep -q "..." -- deploy`는 파싱은 되지만 항상 실패했고, `! git grep -q Seller2024`는 항상 통과해서 아무것도 검증하지 않았다.

`init`에서 새 worktree(= base_sha 순수 상태)에 각 CMD를 한 번 돌려 결과를 기록한다. 자동 거부는 하지 않는다 — 사람이 승인 시점에 본다.

- base에서 **실패** → 새 동작을 검증한다는 뜻. 정상.
- base에서 **통과** → 변경 전에도 통과. 기존 속성 검증이면 정상, 아니면 공허한 명령.

동시에 AC↔CMD 매핑을 계약 섹션에서 뽑아 보고한다. 판정 CMD가 없는 AC가 드러난다.

**Files:**
- Modify: `harness.mjs` — `probeVerificationCommands` / `acceptanceCoverage` 추가, `initCommand`(`:1046-1118`), `summarize`(`:1121-1141`)
- Test: `tests/harness.test.mjs`

**Interfaces:**
- Consumes: Task 2의 `contractSection`, `preflightVerificationCommands`의 반환값
- Produces:
  - `run.spec_command_baseline: Array<{ id, command, exit_code: number|null, error: string|null, mutated_worktree: boolean }>`
  - `run.spec_acceptance_coverage: Array<{ id, command_ids: string[] }>`
  - `summarize()`의 `specCommandBaseline`, `specAcceptanceCoverage`
  - 이름 주의: 기존 `run.baseline`은 부모 run 캐리오버용이다. 겹치지 않는 이름을 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```js
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test tests/harness.test.mjs --test-name-pattern "base_sha|dirties the baseline"`
Expected: FAIL — `run.spec_command_baseline`이 `undefined`

- [ ] **Step 3: 두 헬퍼를 추가한다**

`harness.mjs`의 `preflightVerificationCommands` 바로 아래:

```js
/**
 * base_sha 상태에서 각 CMD를 한 번 실행한다. 자동 거부는 하지 않고 결과만 남긴다.
 * base에서 통과하는 CMD는 변경 전에도 통과한다는 뜻이므로, 사람이 승인 시점에
 * "이 명령이 정말 이번 작업을 검증하나"를 판단할 근거가 된다.
 *
 * SPEC 계약상 CMD는 멱등·비파괴다. 그래도 워크트리를 더럽히는 명령이 있으면
 * 갓 만든 worktree를 baseline으로 되돌리고 그 사실을 기록한다 — 안 되돌리면
 * 이후 beginStep이 "writer worktree drifted"로 죽는다.
 */
async function probeVerificationCommands(commands, worktree, options) {
  const results = [];
  for (const { id, command } of commands) {
    let exitCode = null;
    let failure = null;
    try {
      const result = await options.processRunner({
        ...verificationRequest(command, worktree, options.platform),
        env: options.env,
        timeoutMs: 5 * 60 * 1000,
      });
      exitCode = result.exitCode;
    } catch (error) {
      failure = error.message;
    }
    let mutated = false;
    const status = await gitOutput(options.gitExecutable, worktree, [
      'status', '--porcelain=v1', '-z',
    ]);
    if (status !== '') {
      mutated = true;
      await gitOutput(options.gitExecutable, worktree, ['reset', '--hard', 'HEAD']);
      await gitOutput(options.gitExecutable, worktree, ['clean', '-fdq']);
    }
    results.push({ id, command, exit_code: exitCode, error: failure, mutated_worktree: mutated });
  }
  return results;
}

/**
 * 계약 섹션에서 AC 줄과 같은 줄에 적힌 CMD 참조를 모은다.
 * 판정 CMD가 없는 AC를 사람이 승인 전에 보게 하는 것이 목적이고, 강제하지 않는다.
 */
function acceptanceCoverage(contractText, acceptanceIds) {
  const coverage = new Map(acceptanceIds.map((id) => [id, []]));
  for (const line of contractText.split(/\r?\n/)) {
    const matched = extractIds(line, 'AC').filter((id) => coverage.has(id));
    if (matched.length === 0) continue;
    const commandIds = extractIds(line, 'CMD');
    for (const id of matched) coverage.get(id).push(...commandIds);
  }
  return acceptanceIds.map((id) => ({ id, command_ids: [...new Set(coverage.get(id))] }));
}
```

`git reset --hard HEAD`는 detached HEAD를 움직이지 않고 tracked 파일만 되돌린다. 이 worktree는 몇 줄 위에서 `git worktree add`로 갓 만들어졌고 baseline 체크아웃 외에는 아무것도 없으므로 안전하다.

- [ ] **Step 4: `initCommand`에서 호출한다**

worktree 청결 검사(`harness.mjs:1052-1053`) 직후, `atomicWrite(SPEC.md)` 직전:

```js
  const status = await gitOutput(options.gitExecutable, worktree, ['status', '--porcelain=v1', '-z']);
  if (status !== '') throw new Error('new writer worktree is not clean');

  const commandBaseline = await probeVerificationCommands(commands, worktree, options);
  const coverage = acceptanceCoverage(contract, spec.acceptanceIds);
```

`run` 객체(`harness.mjs:1075`)에 두 필드를 넣는다. `baseline` 바로 아래가 읽기 좋다:

```js
    baseline,
    spec_command_baseline: commandBaseline,
    spec_acceptance_coverage: coverage,
```

`event` 한 줄을 추가한다 (`harness.mjs:1117` `await event(..., 'init', 'created')` 다음):

```js
  await event(
    options.harnessRoot,
    run,
    'spec_command_baseline',
    commandBaseline.map(({ id, exit_code }) => `${id}=${exit_code}`).join(' '),
  );
```

- [ ] **Step 5: `summarize`에 노출한다**

`harness.mjs:1121`의 `summarize`에 두 줄 추가:

```js
    specCommandBaseline: run.spec_command_baseline ?? [],
    specAcceptanceCoverage: run.spec_acceptance_coverage ?? [],
```

`?? []`는 이 필드가 없는 기존 run(crm_frontend 포함)에서 `status`가 죽지 않게 한다.

- [ ] **Step 6: 테스트가 통과하는지 확인한다**

Run: `node --test tests/harness.test.mjs`
Expected: PASS — 63개

기존 테스트들은 CMD가 `node --version` / `node --check app.txt`라서 baseline 실행이 빠르고 워크트리를 안 건드린다. `'init creates a durable PLAN_LOOP run without provider calls'`(`:585`)의 `assert.equal(await git(run.worktree_path, 'status', '--porcelain'), '')`가 이걸 지킨다.

- [ ] **Step 7: 커밋**

```bash
git add harness.mjs tests/harness.test.mjs
git commit -m "feat: probe verification commands at base_sha and report AC coverage"
```

---

### Task 4: 리뷰어가 SPEC 결함을 계획 결함과 구분한다

지금은 계획 수정으로 고칠 수 있는 지적과 SPEC이 잠겨서 못 고치는 지적이 구분되지 않는다. 루프가 라운드를 태우고 예산 소진 뒤 `NEEDS_HUMAN`으로 끝나는데, 사람은 finding JSON을 직접 열어봐야 "재시작이 필요하다"는 걸 안다.

**Files:**
- Modify: `schemas/review-output.schema.json`
- Modify: `prompts/plan-reviewer.md`
- Modify: `harness.mjs:589-605` (`validateReviewShape`), `harness.mjs:626-667` (`evaluateReview`), `harness.mjs:1675-1704` (게이트 블록)
- Test: `tests/harness.test.mjs`

**Interfaces:**
- Produces: finding에 `category: 'plan_defect' | 'spec_defect'`. 스키마에서는 `required`(Codex의 strict structured output이 모든 property를 요구할 수 있으므로), `validateReviewShape`에서는 없어도 통과 (기존 산출물·테스트 픽스처 호환).
- Produces: `evaluateReview(...)` 반환값에 `blockingFindings: Array<{ id, severity, category, claim, evidence }>` 추가.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```js
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
```

두 번째 테스트가 하위호환 잠금이다 — `category` 없는 finding이 지금처럼 리바이저로 가야 한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test tests/harness.test.mjs --test-name-pattern "spec_defect|without a category"`
Expected: 첫 번째 FAIL (`lastErrorDetail`이 `undefined`), 두 번째 PASS

- [ ] **Step 3: 스키마에 `category`를 넣는다**

`schemas/review-output.schema.json`의 finding `properties`에 추가하고 `required`에도 넣는다:

```json
          "category": { "type": "string", "enum": ["plan_defect", "spec_defect"] },
```

```json
        "required": ["id", "severity", "category", "claim", "failure_scenario", "evidence", "needs_evidence"]
```

- [ ] **Step 4: 리뷰어 프롬프트에 규칙을 넣는다**

`prompts/plan-reviewer.md`의 `- minor findings do not block...` 아래에 두 줄 추가:

```markdown
- set category to `spec_defect` only when the locked SPEC itself is wrong or unachievable and no plan revision can fix it; quote the exact offending SPEC line in evidence
- set category to `plan_defect` for everything a plan revision can fix; when in doubt use `plan_defect`
```

- [ ] **Step 5: `validateReviewShape`를 관대하게 만든다**

`harness.mjs:597` 근처, finding 루프 안에 추가:

```js
    if (
      finding.category !== undefined &&
      !['plan_defect', 'spec_defect'].includes(finding.category)
    ) {
      throw new Error(`review finding ${finding.id} category is invalid`);
    }
```

- [ ] **Step 6: `evaluateReview`가 blocking finding 객체를 반환하게 한다**

`harness.mjs:638-644`를 바꾼다:

```js
  const blocking = new Map();
  for (const finding of review.findings) {
    const serious = finding.severity === 'blocker' || finding.severity === 'major';
    if (!serious && !finding.needs_evidence) continue;
    reasons.push(`finding ${finding.id} blocks approval`);
    blocking.set(finding.id, {
      id: finding.id,
      severity: finding.severity,
      category: finding.category ?? 'plan_defect',
      claim: finding.claim,
      evidence: finding.evidence,
    });
  }
```

반환문(`harness.mjs:666`):

```js
  return {
    ready: reasons.length === 0,
    reasons,
    blockingIds: [...blocking.keys()],
    blockingFindings: [...blocking.values()],
  };
```

`blockingIds`가 `Map`의 키라서 중복 제거가 자동이다. 기존 `[...new Set(blockingIds)]`와 동작이 같다.

- [ ] **Step 7: 게이트 블록에서 즉시 중단한다**

`harness.mjs:1678`의 `if (gate.ready) { ... break; }` 바로 다음:

```js
    const specDefects = gate.blockingFindings.filter(
      (item) => item.category === 'spec_defect',
    );
    if (specDefects.length > 0) {
      run.last_error = `SPEC defect blocks planning: ${
        specDefects.map((item) => `${item.id} ${item.claim}`).join('; ')
      }`;
      run.last_error_detail = {
        blocking_findings: specDefects,
        unresolved_prior_findings: [],
        failed_acceptance: [],
        plan_defects: [],
        next_action: 'blocking_findings[].evidence가 가리키는 SPEC 줄을 고치고 --parent-run으로 새 run을 시작한다',
      };
      await setState(harnessRoot, run, 'NEEDS_HUMAN', 'spec_gate', run.last_error);
      break;
    }
```

`gate.ready`가 참이면 blocking finding 자체가 없으므로 이 검사는 순서상 뒤여야 한다.

`run.last_error_detail`의 나머지 필드는 Task 5에서 채운다. 지금은 모양만 맞춘다.

- [ ] **Step 8: `summarize`에 노출한다**

`harness.mjs:1139` `lastError` 옆:

```js
    lastErrorDetail: run.last_error_detail ?? null,
```

- [ ] **Step 9: 테스트가 통과하는지 확인한다**

Run: `node --test tests/harness.test.mjs`
Expected: PASS — 65개

- [ ] **Step 10: 커밋**

```bash
git add harness.mjs schemas/review-output.schema.json prompts/plan-reviewer.md tests/harness.test.mjs
git commit -m "feat: route blocking spec_defect findings straight to the human spec gate"
```

---

### Task 5: 예산을 수렴으로 계산하고 `lastError`를 구조화한다

`plan_review_max`(현재 3)는 리바이저가 자기 수정에 대한 피드백을 받는 라운드를 보장하지 않는다. crm_frontend run에서 F-003/F-004는 실제로 해결되며 수렴 중이었는데 카운터가 먼저 끝났다.

라운드 수 대신 진전으로 판정한다 — 그 라운드에 resolved가 하나도 없으면 헛도는 것이므로 즉시 중단하고, 진전이 있으면 계속 돈다. 카운터는 무한루프 백스톱으로만 남기고 3→6으로 올린다.

동시에 `lastError`를 구조화한다. 지금은 세미콜론으로 이은 문자열이고 같은 finding이 두 번 등장한다 — `previous finding F-001 remains open`(`harness.mjs:635`)과 `finding F-001 blocks approval`(`:641`).

**Files:**
- Modify: `harness.mjs:626-667` (`evaluateReview`), `harness.mjs:1683-1704` (게이트 블록), `harness.mjs:1298-1302` (`finishStep`)
- Modify: `policy.json`
- Test: `tests/harness.test.mjs`

**Interfaces:**
- Consumes: Task 4의 `gate.blockingFindings`, `run.last_error_detail`
- Produces: `evaluateReview(...)`에 `detail: { blocking_findings, unresolved_prior_findings, failed_acceptance, plan_defects, next_action }` 추가. `next_action`은 `evaluateReview`가 `null`로 두고 중단 지점에서 채운다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```js
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test tests/harness.test.mjs --test-name-pattern "resolves nothing|converging review"`
Expected: 첫 번째 FAIL (`lastError`에 `stall` 없음, 리바이저가 한 번 더 불림), 두 번째는 3라운드까지 가므로 PASS

- [ ] **Step 3: `evaluateReview`가 detail을 반환하게 한다**

`harness.mjs:626` 전체를 아래로 바꾼다. `reasons`는 그대로 유지한다 (기존 테스트가 `lastError` 문자열을 매칭한다).

```js
function evaluateReview(review, run, planText) {
  const reasons = [];
  const planDefects = [];
  const unresolvedPrior = [];
  const failedAcceptance = [];
  const blocking = new Map();

  const plan = validatePlan(planText, run);
  if (!plan.valid) {
    reasons.push(plan.reason);
    planDefects.push(plan.reason);
  }

  const priorById = new Map(review.prior_findings.map((item) => [item.id, item.status]));
  for (const id of run.previous_gate_blocking_ids) {
    if (!priorById.has(id)) {
      reasons.push(`previous finding ${id} was not reclassified`);
      unresolvedPrior.push({ id, status: 'unreclassified' });
    } else if (priorById.get(id) === 'open') {
      reasons.push(`previous finding ${id} remains open`);
      unresolvedPrior.push({ id, status: 'open' });
    }
  }

  for (const finding of review.findings) {
    const serious = finding.severity === 'blocker' || finding.severity === 'major';
    if (!serious && !finding.needs_evidence) continue;
    reasons.push(`finding ${finding.id} blocks approval`);
    blocking.set(finding.id, {
      id: finding.id,
      severity: finding.severity,
      category: finding.category ?? 'plan_defect',
      claim: finding.claim,
      evidence: finding.evidence,
    });
  }

  const checksById = new Map();
  for (const check of review.ac_checks) {
    if (checksById.has(check.id)) {
      reasons.push(`AC ${check.id} is duplicated`);
      planDefects.push(`AC ${check.id} is duplicated`);
    }
    checksById.set(check.id, check);
  }
  if (checksById.size !== run.spec.acceptance_ids.length) {
    reasons.push('AC checks do not exactly match the SPEC');
    planDefects.push('AC checks do not exactly match the SPEC');
  }
  for (const id of run.spec.acceptance_ids) {
    const check = checksById.get(id);
    if (!check) {
      reasons.push(`AC ${id} is missing`);
      failedAcceptance.push({ id, status: 'missing', reason: 'review omitted this AC' });
    } else if (
      check.status !== 'pass' ||
      !check.implementation_ref?.trim() ||
      !check.verification_ref?.trim()
    ) {
      reasons.push(`AC ${id} is not fully mapped and passing`);
      failedAcceptance.push({
        id,
        status: check.status,
        reason: `implementation_ref=${check.implementation_ref || '(empty)'} verification_ref=${check.verification_ref || '(empty)'}`,
      });
    }
  }
  if (review.checkpoint_count < 1) {
    reasons.push('at least one checkpoint is required');
    planDefects.push('at least one checkpoint is required');
  }

  return {
    ready: reasons.length === 0,
    reasons,
    blockingIds: [...blocking.keys()],
    blockingFindings: [...blocking.values()],
    detail: {
      blocking_findings: [...blocking.values()],
      unresolved_prior_findings: unresolvedPrior,
      failed_acceptance: failedAcceptance,
      plan_defects: planDefects,
      next_action: null,
    },
  };
}
```

같은 finding id가 blocking과 unresolved_prior 양쪽에 나타날 수는 있지만 **각 목록 안에서는 한 번씩만** 나온다. 두 목록은 서로 다른 사실을 말한다 (이번 라운드에 막는 것 / 지난 라운드 지적이 안 닫힌 것).

- [ ] **Step 4: 게이트 블록을 수렴 판정으로 바꾼다**

`harness.mjs:1683-1699`(`manualRoundComplete`부터 `break;`까지)를 바꾼다:

```js
    const manualRoundComplete = run.human_revision_target_round !== null
      && run.plan_review_round >= run.human_revision_target_round;
    const lineageBudgetExhausted =
      (run.prior_plan_review_rounds ?? 0) + run.plan_review_round
      >= policy.budgets.lineage_plan_review_max;
    // 라운드 수가 아니라 진전으로 판정한다. 지난 라운드의 blocking 지적이
    // 하나도 닫히지 않았으면 리바이저가 헛도는 것이므로 예산이 남아도 멈춘다.
    const stalled = run.previous_gate_blocking_ids.length > 0
      && !review.prior_findings.some((prior) => prior.status === 'resolved');
    const stopReasons = [];
    if (stalled) {
      stopReasons.push(`plan review stalled at round ${run.plan_review_round}: no previous finding was resolved`);
    }
    if (run.plan_review_round >= policy.budgets.plan_review_max) {
      stopReasons.push('plan review budget exhausted');
    }
    if (lineageBudgetExhausted) stopReasons.push('lineage plan review budget exhausted');
    if (manualRoundComplete) stopReasons.push('requested human revision round is complete');
    if (stopReasons.length > 0) {
      run.last_error = [...stopReasons, ...gate.reasons].join('; ');
      run.last_error_detail = {
        ...gate.detail,
        next_action: stalled
          ? '리바이저가 수렴하지 않는다. SPEC을 고치거나 request-plan-revision으로 구체적인 지시를 준다'
          : 'blocking_findings를 확인하고 request-plan-revision을 보내거나 --parent-run으로 새 run을 시작한다',
      };
      await setState(harnessRoot, run, 'NEEDS_HUMAN', 'plan_gate', run.last_error);
      break;
    }
```

`gate.ready` 분기(`harness.mjs:1678`)에도 한 줄 추가:

```js
    if (gate.ready) {
      run.last_error = null;
      run.last_error_detail = null;
      await setState(harnessRoot, run, 'AWAIT_PLAN_APPROVAL', 'plan_gate', 'ready');
      break;
    }
```

- [ ] **Step 5: 오래된 detail이 남지 않게 한다**

`last_error`를 지우거나 덮는 지점 네 곳에 `last_error_detail`도 같이 처리한다. 안 하면 이전 게이트의 detail이 무관한 에러 옆에 붙어 사람을 오도한다.

`finishStep` (`harness.mjs:1298`):

```js
async function finishStep(harnessRoot, run) {
  run.active_step = null;
  run.last_error = null;
  run.last_error_detail = null;
  await saveRun(harnessRoot, run);
}
```

`stopForLockedInput`(`:929`), `markBoundaryViolation`(`:1304`), `recordStepFailure`(`:1275`), `stopImplementation`(`:1708`), `abortRun`(`:2018`) 각각의 `run.last_error = ...` 다음 줄에 추가:

```js
  run.last_error_detail = null;
```

`requestPlanRevision`(`harness.mjs:1991`)의 `run.last_error = null;` 다음에도 같은 줄을 넣는다.

`initCommand`의 run 객체(`harness.mjs:1110`) `last_error: null,` 다음에:

```js
    last_error_detail: null,
```

- [ ] **Step 6: `policy.json`의 카운터를 올린다**

```json
  "budgets": {
    "plan_review_max": 6,
    "human_plan_revision_max": 2,
    "lineage_plan_review_max": 10
  },
```

`DEFAULT_POLICY`(`harness.mjs:37`)는 건드리지 않는다 — 그건 `policy.json`이 없을 때의 보수적 기본값이다.

- [ ] **Step 7: 테스트가 통과하는지 확인한다**

Run: `node --test tests/harness.test.mjs`
Expected: PASS — 67개

`'a second blocked review stops at NEEDS_HUMAN without a third call'`(`tests/harness.test.mjs:741`)은 라운드 2에서 prior가 `open`이므로 stall 룰로도 같은 지점에서 멈춘다. `runToApproval`(`:563`)은 라운드 2에서 F-001이 `resolved`라 stall이 아니다.

- [ ] **Step 8: 커밋**

```bash
git add harness.mjs policy.json tests/harness.test.mjs
git commit -m "feat: stop the plan loop on stalled convergence and structure lastError"
```

---

### Task 6: pingpong 대화와 문서를 새 계약에 맞춘다

SPEC 단계의 검증 수단은 사람+AI 대화다. 그 대화가 이제 두 가지를 더 해야 한다 — 계약/맥락을 나눠 쓰고, baseline 리포트를 사람에게 보여준다.

**Files:**
- Modify: `integrations/claude/pingpong/SKILL.md`
- Modify: `README.md`
- Test: `tests/harness.test.mjs:174` (`'tracked pingpong skill connects a task to the public plan runner'`)

**Interfaces:**
- Consumes: Task 3의 `specCommandBaseline`, `specAcceptanceCoverage`; Task 4의 `spec_gate` 액션; Task 5의 `lastErrorDetail`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`tests/harness.test.mjs:174`의 기존 skill 테스트에 단언을 추가한다:

```js
  assert.match(skill, /## 계약[\s\S]*## 맥락/);
  assert.match(skill, /멱등.*비파괴/);
  assert.match(skill, /specCommandBaseline/);
  assert.match(skill, /specAcceptanceCoverage/);
  assert.match(skill, /사용자 말과 현재 코드가 어긋나면.*묻는다/s);
  assert.match(skill, /lastErrorDetail/);
```

- [ ] **Step 2: 실패를 확인한다**

Run: `node --test tests/harness.test.mjs --test-name-pattern "tracked pingpong skill"`
Expected: FAIL

- [ ] **Step 3: SKILL의 SPEC 작성 규칙을 바꾼다**

`integrations/claude/pingpong/SKILL.md`의 3번 항목 마지막 불릿 다음에 한 줄 추가한다:

```markdown
   - 사용자 말과 현재 코드가 어긋나면 임의로 한쪽을 채택하지 않고 그 차이를 그대로 보여주며 묻는다.
   - 도메인·동작은 사용자만 아는 것이므로 끌어내고, 기술 선택은 짧은 선택지와 추천을 먼저 제시해 사용자가 고르게 한다.
```

5번 항목 전체를 바꾼다:

```markdown
5. 미확정 맥락이 없으면 `D:/codex-projects/agent-harness/SPEC.example.md` 형식으로 SPEC을 작성한다. SPEC은 `## 계약`과 `## 맥락` 두 섹션으로 나눈다.
   - `## 계약` — 사람이 승인하는 부분. 요청, 범위 밖, `AC-###`, `CMD-###`, 제약. runner는 **이 섹션 안에서만** `AC-###`와 `CMD-###`를 파싱한다.
   - `## 맥락` — planner·reviewer·implementer만 읽는다. 대화에서 나온 결정과 근거, 조사한 파일, 버린 대안. 길어도 되고, 이 섹션의 `CMD-###` 언급은 파싱되지 않는다.
   - 각 `AC-###` 줄 끝에 그것을 판정하는 `CMD-###`를 적는다. 자동 판정이 불가능하면 `검증: 수동`이라고 적는다.
   - **`CMD-###`는 멱등·비파괴여야 한다.** runner가 base_sha에서 한 번, 구현 뒤에 또 한 번 실행한다. 배포·마이그레이션·과금·외부 쓰기는 검증이 아니라 작업이다. 배포 자동화 작업이면 `deploy --dry-run` 같은 형태를 쓴다.
   - 검증 명령은 저장소에서 실제로 쓰는 것을 먼저 찾아 쓴다. 없으면 그 부재 자체를 사용자에게 알리고 무엇으로 판정할지 정한다.
   - `CMD-###`는 정의 줄에서 백틱 하나로 감싼 실행 가능한 명령이어야 하고, 백틱 뒤에 설명을 붙이지 않는다.
   - 검증 명령은 Windows에서 PowerShell로 실행된다. `&&` 같은 POSIX 연산자가 필요하면 Git Bash 전체 경로(`C:\PROGRA~1\Git\bin\bash.exe -c '...'`)로 감싼다. 무수식 `bash`는 WSL 런처로 해석되어 거부된다.
```

6번 항목을 바꾼다:

```markdown
6. `## 계약` 섹션만으로 `최종 SPEC 요약`을 만들어 보여준다. `## 맥락`은 요약에 넣지 않는다. 그리고 `이 내용으로 Cursor Scout와 계획 핑퐁을 시작할까요? (승인/수정)`이라고 묻고 기다린다.
```

10번 항목 앞에 새 항목을 넣는다 (이후 번호는 하나씩 밀린다):

```markdown
10. runner 결과의 `specCommandBaseline`과 `specAcceptanceCoverage`를 표로 보여준다. 이건 SPEC이 실제로 무엇을 검증하는지에 대한 기계적 사실이므로 반드시 사람이 보게 한다.
    - `exit_code`가 `0`인 CMD는 **변경 전에도 통과한다**. 기존 동작을 지키는 명령이면 정상이고, 이번 작업을 판정할 명령이면 공허하다. 어느 쪽인지 묻는다.
    - `exit_code`가 `0`이 아닌 CMD는 새 동작을 검증한다는 뜻이므로 정상이다.
    - `mutated_worktree`가 `true`인 CMD는 멱등·비파괴 계약을 어긴 것이다. 그 사실을 알리고 명령을 바꿀지 묻는다.
    - `command_ids`가 빈 `AC-###`는 자동 판정되지 않는다. 그대로 진행할지 CMD를 추가할지 묻는다.
    - 사용자가 SPEC을 고치기로 하면 계획 핑퐁을 진행하지 않고 5번으로 돌아간다.
```

마지막 항목(기존 12번)에서 `NEEDS_HUMAN` 처리를 바꾼다:

```markdown
    `NEEDS_HUMAN`이면 `lastError`와 `lastErrorDetail`을 보여주고 멈춘다. `lastErrorDetail.next_action`이 권장 행동이다. events의 액션이 `spec_gate`이면 계획 수정으로는 못 고치는 SPEC 결함이므로, `lastErrorDetail.blocking_findings[].evidence`가 가리키는 SPEC 줄을 사용자에게 보여주고 SPEC 수정 후 재시작을 묻는다. 실패한 provider를 임의로 우회하거나 새 run을 만들지 않는다.
```

- [ ] **Step 4: `README.md`를 갱신한다**

`## 4. Fallback: raw runner commands` 아래 `init` 설명 다음에 문단을 추가한다:

```markdown
`init`은 새 worktree를 base_sha로 만든 뒤 SPEC 계약 섹션의 `CMD-###`를 **거기서 한 번 실행한다**. 결과는 `specCommandBaseline`에, `AC-###`별 판정 명령은 `specAcceptanceCoverage`에 담겨 나온다. base에서 통과하는 CMD는 변경 전에도 통과한다는 뜻이므로 이번 작업을 판정하지 못할 수 있다. 자동 거부는 하지 않으니 사람이 보고 판단한다.

검증 명령은 멱등·비파괴여야 한다. runner가 base_sha에서 한 번, 구현 뒤에 또 한 번 실행하기 때문이다. 배포·마이그레이션은 검증이 아니라 작업이다.
```

`## 현재 한계`의 두 번째 항목을 바꾼다:

```markdown
- verification command는 SPEC `## 계약` 섹션에서 `CMD-001: \`실행할 명령\`` 형식이어야 한다. `## 맥락` 섹션의 언급은 파싱되지 않는다.
```

`### 5. 계획 읽고 결정`의 `NEEDS_HUMAN` 설명(`- \`NEEDS_HUMAN\`: 예산 소진 또는 경계 위반. \`lastError\` 확인`)을 바꾼다:

```markdown
- `NEEDS_HUMAN`: 수렴 정지, 예산 소진, 경계 위반, 또는 SPEC 결함. `lastError`와 `lastErrorDetail.next_action` 확인
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `node --test tests/harness.test.mjs`
Expected: PASS — 67개

- [ ] **Step 6: 커밋**

```bash
git add integrations/claude/pingpong/SKILL.md README.md tests/harness.test.mjs
git commit -m "docs: teach pingpong the contract/context split and the baseline report"
```

---

## 이 계획에 없는 것

- **SPEC에 대한 독립 모델 감사** — SPEC은 사람+AI 대화로 확정한다는 설계를 유지한다. 모델을 더 붙이지 않고, 대신 대화에 기계적 사실(baseline exit code, AC 커버리지)을 공급한다. Task 3의 리포트를 몇 번 돌려보고도 SPEC 결함이 계획 단계까지 새면 그때 다시 본다.
- **AC 개수 하드 상한** — 계약/맥락 분리로 승인 대상이 이미 짧아진다. 상한은 나중에 필요해지면 `validateSpec`에 한 줄이다.
- **부작용 있는 CMD의 baseline 제외 표시** — 멱등·비파괴를 계약으로 세웠으므로 필요 없다. 계약을 어긴 CMD는 `mutated_worktree`로 드러나고 사람이 승인 전에 본다.
- **파일 2개(SPEC.md + CONTEXT.md) 분리** — 한 파일 + 섹션으로 같은 이득을 얻으면서 잠금 대상이 안 늘어난다.

## Self-Review

**Spec coverage**

| 요구 | 태스크 |
|---|---|
| 검증이 git 장님 상태로 도는 것 (핸드오프 #1) | T1 |
| preflight가 CMD를 baseline에서 실제 실행 (핸드오프 #2) | T3 |
| reviewer `spec_defect` 판정 (핸드오프 #3) | T4 |
| 예산을 라운드가 아니라 수렴으로 (핸드오프 #4) | T5 |
| `lastError` 구조화 (핸드오프 #5) | T5 |
| 사람 승인 대상과 planner 입력 분리 | T2, T6 |
| AC↔CMD 커버리지를 승인 시점에 | T3, T6 |
| 대화 품질 보강 (충돌은 자체 해결 금지, 도메인/기술 구분) | T6 |
| 기존 run 산출물 불변 | Global Constraints, T3 Step 5의 `?? []` |

**Type consistency**

- `probeVerificationCommands` 반환 항목의 키: `id`, `command`, `exit_code`, `error`, `mutated_worktree` — T3 Step 3에서 정의, Step 4·5·테스트·T6 SKILL에서 같은 이름으로 사용.
- `acceptanceCoverage` 반환 항목의 키: `id`, `command_ids` — 동일.
- `evaluateReview` 반환의 `blockingFindings`는 T4에서 도입하고 T5에서 `detail.blocking_findings`와 같은 배열을 공유한다. T4 Step 7의 `gate.blockingFindings` 참조는 T5 이후에도 유효하다.
- `run.last_error_detail`의 키: `blocking_findings`, `unresolved_prior_findings`, `failed_acceptance`, `plan_defects`, `next_action` — T4 Step 7과 T5 Step 3·4에서 동일.
- `summarize()`의 새 키: `specCommandBaseline`, `specAcceptanceCoverage`(T3), `lastErrorDetail`(T4).
