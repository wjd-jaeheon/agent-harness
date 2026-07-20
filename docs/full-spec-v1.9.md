> 상태: 장기 하드닝 참고 카탈로그. v2.x/v3.0에서 실제 사고로 필요가 증명된 방어만 개별 승격한다. 이 문서의 일괄 구현은 금지한다.
>
> 보존일: 2026-07-20 · 원본 본문 SHA-256: `02ebd794793b2005cee26bb56068a1242d805e8ed08dc50e46bbb21be8a6b88a`

# 듀얼 에이전트 하네스 — 실행 계획 v1.9

> Claude(계획·기본 구현) × Codex(적대 검증) 교차 루프.
> Windows 11, Claude/Codex/Cursor 구독 인증, API 키 없음.
> 2026-07-16 실환경·공식 문서 검증과 독립 적대 검토를 반영한 구현 기준판.

---

## 0. 결론

**worktree 밖 단일 파일 원장이 두뇌, host-side `harnessctl`이 집행자, agent의 `/harness`는 무권한 어댑터, Orca는 관제판이다.**

PC가 재부팅되고 Claude Code, Codex, Cursor, Orca가 모두 종료돼도 control root의 run 디렉터리만으로 정확한 상태·입력 해시·진행 중 행동·다음 행동을 복구한다.

### 역할 기본값

| 역할 | 기본값 | 불변 규칙 |
|---|---|---|
| 계약 제출·예외·승인 | 사람 | run 시작 입력을 제출하고 계획·병합 승인, writer 교체만 결정 |
| 계획 작성·구현 writer | Claude | 한 시점에 source writer는 한 명 |
| 계획 적대 검토·구현 검증 | Codex | 구현 검증은 매번 새 반대 모델 세션 |
| 저장소 정찰·제3 의견 | Cursor | 매 run 계획 전 Repo Scout 1회, 교착 시 read-only 타이브레이커 최대 1회 |
| 상태 전이·검증 관제 | host `harnessctl.mjs` | supervisor는 원장·child lifecycle만 관리하고 model-modified code는 직접 실행하지 않음 |
| worktree·터미널·diff 관제 | Orca | 상태 저장소나 완료 판정자는 아님 |

writer를 사람이 Codex로 바꾸면 이후 verifier는 새 Claude 세션으로 반전한다. 모든 절차는 이름이 아니라 `run.writer`와 `opposite(writer)`로 역할을 계산한다.
`config/policy.json`의 `default_writer`는 `claude`다. 계획 승인 게이트에서 사람은 `claude|codex`를 한 번 선택할 수 있고 생략하면 default를 쓴다. 이는 기존 계획 승인과 같은 입력이므로 세 번째 승인 게이트가 아니다.

---

## 1. 저장 구조와 신뢰 경계

기본 경로:

```text
HARNESS_HOME = D:\codex-projects\agent-harness
WORKTREE_HOME = D:\codex-worktrees
STAGING_HOME = %LOCALAPPDATA%\AgentHarness\staging
```

```text
D:\codex-projects\agent-harness\
  PLAN.md
  bin\harnessctl.mjs              # trusted host supervisor; Node 내장 모듈만 사용
  bin\harness-job.exe             # hash-locked Windows Job Object child launcher
  native\HarnessJob.cs            # reviewed source; Windows PowerShell Add-Type로 1회 빌드
  validators\*.validator.mjs      # checked-in self-contained schema validators
  validators\invariants.mjs       # cross-record uniqueness/state invariants
  validators\canonical-json.mjs   # 정본 JSON 결정적 UTF-8 직렬화
  tools\generate-validators.mjs   # pinned Ajv standalone build-only generator
  package.json
  package-lock.json                # build-only Ajv exact version/integrity
  adapters\harness-agent\         # agent용 status/help/request-human만 제공
  config\policy.json              # 상태 전이, 역할, 라운드·사용량 상한
  schemas\contract.schema.json
  schemas\planner-output.schema.json
  schemas\plan-map.schema.json
  schemas\review.schema.json
  schemas\decision.schema.json
  schemas\human-ac.schema.json
  schemas\worker-result.schema.json
  schemas\test-result.schema.json
  schemas\cursor-scout.schema.json
  schemas\execution-attempt.schema.json
  schemas\execution-manifest.schema.json
  prompts\planner.md
  prompts\reviser.md
  prompts\decision-maker.md
  prompts\writer.md
  prompts\fixer.md
  prompts\reviewer.md
  config\empty-mcp.json
  config\claude-restricted-settings.json
  .harness\runs\<repo-id>\<run-id>\
    run.json                       # authoritative snapshot
    request.md                     # 사용자 원요청 원문
    contract.json                  # AC·검증 명령·비목표·예산
    protocol\                      # 이 run이 쓰는 policy/schema/prompt/config immutable snapshot
    plan\PLAN_v1.md ...            # immutable version
    plan\PLAN_v1.map.json ...      # AC→구현 위치→검증 ID의 기계 판정용 매핑
    reviews\*-events.jsonl         # CLI 원본 이벤트
    reviews\*-findings.json        # schema 검증된 게이트 입력
    reviews\*-report.md            # JSON에서 렌더링한 사람용 문서
    decisions\<phase>-r<N>-<action-id>.json  # review별 immutable disposition
    decisions-report.md            # decision artifacts에서 렌더링한 비정본 요약
    cursor\scout-<action-id>.json  # 계획 전 Cursor Repo Scout 결과 또는 unavailable record
    evidence\epoch-<writer-epoch>\<head-sha>\
      diff.patch                    # comparison_base..head exact diff artifact
      writer-tests\                # command별 attempts + canonical manifest + logs
      verifier-tests\              # 독립 command별 attempts + canonical manifest + logs
    recovery\                      # 중단된 임시 출력, 게이트 사용 금지
    artifacts.jsonl                # 모든 게이트 입력의 path·kind·hash·size·lineage
    events.jsonl                   # append-only 감사 원장
    final.md
```

- control root는 writer/verifier worktree 밖에 둔다. Codex sandbox writable root나 Claude tool allowlist에 추가하지 않는다.
- 에이전트 입력은 supervisor가 해시가 고정된 request·contract·plan을 stdin envelope에 넣는다. child 출력은 C: staging에 캡처해 schema·hash 검증한 뒤 D: run의 `recovery/txn/<action-id>`로 copy→fsync→rehash한다. 그 다음 D: 내부 final path로만 atomic rename한다. cross-volume move를 atomic이라고 가정하지 않는다.
- `harnessctl run|resume`은 사람이 연 전용 host terminal에서 장시간 살아 있는 supervisor로 실행된다. agent가 `harnessctl`을 자식 프로세스로 실행하는 구조와 일회성 `harnessctl approve-*` 실행 파일 표면은 금지한다.
- agent의 `/harness`는 sanitized status 조회, help, `request-human`만 제공한다. 승인·전이·writer 교체·finding dismiss API는 존재하지 않는다.
- supervisor는 각 agent prompt에 sequence가 붙은 sanitized run snapshot을 넣는다. `/harness status`는 그 snapshot만 보여주고, `request-human`은 stdout에 구조화 요청을 남긴다. agent에서 control root로 가는 파일·socket·named-pipe 쓰기 경로는 두지 않는다.
- human-only 행동은 이미 실행 중인 supervisor의 실제 console stdin에서만 받는다. supervisor가 매 승인마다 메모리 안에서 256-bit nonce를 만들고 대상 hash/SHA 끝 8자리와 함께 표시한다. 사람은 둘을 재입력하며 nonce는 파일·환경변수·child stdin에 저장하거나 전달하지 않는다.
- child agent/test 프로세스는 stdin/stdout/stderr pipe만 받고 supervisor console을 상속하지 않는다. Codex/test 실행은 worktree만 writable인 sandbox, native Claude writer는 shell/network가 제거된 path-scoped file-tool allowlist를 쓴다. native writer를 띄우기 전 승인된 writable file과 모든 기존 부모를 Win32 no-follow 방식으로 검사하며 reparse point가 하나라도 있으면 시작하지 않는다.
- control root와 staging은 Codex sandbox worker identity에 deny ACL을 적용한다. native Claude에는 해당 경로의 tool을 주지 않는다. 공식 CLI host가 staging에 쓴 결과도 정본이 아니며 supervisor 등록 전에는 게이트에서 읽지 않는다.
- writer worktree에는 source만 있고 run 로그가 생기지 않는다. reviewer/verifier가 control root를 직접 고칠 수 없다.
- `repo-id`는 hash-locked delivery repository identity 또는 canonical 절대경로 SHA-256 앞 12자리와 strict sanitized slug로 만든다. 표시 slug는 lowercase ASCII `^[a-z0-9][a-z0-9-]{0,31}$`만 허용하고 사용자가 준 원문을 경로에 직접 쓰지 않는다. 원본 URL·경로도 `run.json`에 저장한다.
- `run-id`는 supervisor timestamp와 CSPRNG 64-bit suffix를 붙인 `YYYYMMDD-HHmmss-<slug>-<16-lowercase-hex>` 형식이며 한 번 정하면 바꾸지 않는다. 전체 control/worktree root canonical path 길이 상한 180, `<safe-git> check-ref-format --branch harness/<run-id>`를 side effect 전에 통과해야 한다. existing run directory, branch, worktree path 중 하나라도 충돌하면 새 run을 만들지 않는다. repo/run directory, remote branch, host-action idempotency key, PR hidden marker는 모두 exact repo-id+run-id에 묶인다.
- worktree는 정확한 SHA에서 만든다. 이동 가능한 `<delivery.remote>/<target_ref>`는 fetch·drift 확인용일 뿐 생성 기준으로 쓰지 않는다.
- `ARCHIVED` 또는 `ABORTED` 후 archive 성공 전에는 worktree를 삭제하지 않는다.
- v1 immutable forbidden writer paths는 `.git`, `.git/**`, 모든 `**/.gitattributes`, `.gitmodules`, `.github/workflows/**`, `.github/actions/**`, `.husky/**`, `.claude/**`, `.codex/**`, `.cursor/**`, `.mcp.json`이다. contract/plan map으로 예외를 만들 수 없고 필요한 작업은 `UNSUPPORTED_IN_V1`이다.
- cwd, plan map, changed path, script path, declarative file-op은 하나의 concrete Windows path validator를 거친다. 입력을 Unicode NFC와 `/` separator로 맞춘 뒤 absolute/drive/UNC/device prefix, empty·`.`·`..` component, NUL/control, Win32 reserved `<>:"|?*` 문자(따라서 ADS의 `:` 포함), segment trailing dot/space, case-insensitive DOS reserved name을 거부한다. forbidden match는 canonical relative path에 `OrdinalIgnoreCase`로 수행하므로 `.GIT`, `.git.`, `x/../.git`, `name:stream`은 모두 실행 전에 실패한다.
- 위 규칙은 wildcard 없는 concrete path용이다. `allowed_generated_paths`와 `dependency_setup.ephemeral_output_paths`만 별도 path-spec을 쓰며, valid concrete directory prefix 뒤의 terminal `/**` 하나만 허용한다. 중간 glob, `*` 단독, `?`, `[]`, absolute/`..`는 금지한다. match는 `OrdinalIgnoreCase` component boundary로 prefix 자체와 descendants에만 적용하고 literal prefix/기존 부모를 no-follow containment 검사한다. cwd/map/changed/script/file-op은 항상 concrete path다.
- supervisor는 model turn 전후 worktree의 canonical gitdir/repo ID/HEAD를 확인한다. writer 실행 전과 checkpoint 전 모두 승인 경로와 모든 기존 부모를 no-follow로 열어 reparse point를 거부하고 final canonical path가 worktree 안인지 확인한다. writer용 immutable settings에는 forbidden path와 map 밖 경로의 `Edit`/`Write` explicit deny를 넣는다. diff는 `--no-ext-diff --no-textconv`, 모든 host Git 명령은 아래 safe Git baseline을 쓰며 gitdir가 예상 경로와 다르면 즉시 `NEEDS_HUMAN`이다.
- `init`은 현재 `harnessctl.mjs`, `harness-job.exe`+source/build identity, policy, 모든 schema+validator+invariant module, prompt, restricted settings template, empty MCP config와 `node/git/claude/codex/cursor/gh/orca`의 canonical executable path·SHA-256·version을 run의 `protocol/`에 복사하고 `protocol-manifest.json`으로 hash한다. Git은 `git.exe`, canonical `git --exec-path`, 그 안의 `git-remote-http.exe`/`git-remote-https.exe`, 허용 credential helper를 각각 path+hash로 잠근다. snapshot은 immutable artifact며 모든 host Git action은 실행 직전 이 파일들을 재검증한다.
- clean install의 별도 `bootstrap-job-helper`만 `harness-job.exe`가 없을 때 reviewed `native/HarnessJob.cs`를 locked system Windows PowerShell+Framework CSC identity로 빌드하고 smoke 후 source/compiler/runtime/output hash manifest를 만든다. exe가 있는데 hash가 다르거나 active run이 있으면 자동 재빌드하지 않는다. `init`과 `resume`은 기존 manifest 검증만 하며 임의 컴파일을 절대 수행하지 않는다.
- schema마다 pinned Ajv standalone으로 미리 생성한 self-contained ESM validator를 커밋한다. generator는 build-time에만 Ajv를 쓰고, generated file에 external import/require가 있으면 빌드 실패한다. clean temp에서 `node_modules` 없이 모든 validator smoke가 성공해야 release할 수 있다. protocol manifest는 `schema hash → validator hash`를 1:1로 잠그며 supervisor가 provider 검증과 별개로 모든 input/output을 로컬 validator+`invariants.mjs`로 다시 판정한다.
- planner, reviser, decision-maker, writer, fixer, reviewer는 각각 이름이 같은 독립 prompt 파일을 쓰며 다른 role prompt를 암묵적으로 재사용하지 않는다. envelope의 `role`과 prompt artifact hash가 일치하지 않으면 child를 시작하지 않는다.
- resume bootstrap은 run snapshot의 supervisor를 실행한다. 현재 설치본·CLI version·protocol hash가 다르면 자동 migration이나 새 규칙 혼용 없이 `NEEDS_HUMAN`이다. 이 때문에 대화 context나 설치 디렉터리의 최신 prompt가 없어도 run 디렉터리의 규칙으로 재개할 수 있다.

이 구조가 단일 Writer도 권한으로 강제한다. writer는 source worktree만 쓸 수 있고 상태·승인·리뷰 판정 원장은 러너만 쓸 수 있다.

v1 위협 모델은 신뢰한 저장소에서 model 실수와 model-modified test의 호스트 쓰기·network 이탈을 줄이는 것이다. 임의 호스트 파일 읽기 기밀성, prompt injection, 악성 저장소·dependency까지 막는 strong isolation은 v1 범위 밖이며 그런 run은 시작하지 않는다. 사람 사용자·Windows 관리자·서명된 공식 CLI·잠긴 base repo의 Git 설정·OS 자체가 악성인 경우도 v1 방어 범위 밖이다.

---

## 2. 계약과 리뷰 데이터

### `contract.json` 최소 계약

```json
{
  "non_goals": ["명시적 비목표"],
  "security": {
    "isolation_profile": "trusted-repo",
    "host_read_confidentiality_required": false,
    "resource_profile": "standard-v1"
  },
  "delivery": {
    "provider": "github",
    "remote": "origin",
    "repository": "owner/repo",
    "target_ref": "main",
    "merge_mode": "merge-commit",
    "merge_transport": "git-expected-sha-lease-cas",
    "required_pr_checks": [
      {"name": "test", "workflow": "CI"}
    ]
  },
  "acceptance_criteria": [
    {
      "id": "AC-001",
      "statement": "관찰 가능한 수용조건",
      "critical": true,
      "verification": {
        "type": "command",
        "command_ids": ["T-001"]
      }
    }
  ],
  "required_commands": [
    {
      "id": "T-001",
      "cwd": ".",
      "runner": {
        "type": "exec",
        "executable": "C:\\absolute\\path\\to\\node.exe",
        "args": ["--test", "tests/smoke.test.js"],
        "inherit_env": false,
        "env": {"CI": "1"}
      },
      "setup_ids": ["S-001"],
      "timeout_seconds": 900,
      "expected_exit_code": 0
    }
  ],
  "dependency_setup": {
    "mode": "offline",
    "read_only_cache_roots": ["C:\\absolute\\path\\to\\pnpm-store"],
    "ephemeral_output_paths": ["node_modules/**"],
    "commands": [
      {
        "id": "S-001",
        "cwd": ".",
        "runner": {
          "type": "exec",
          "executable": "C:\\absolute\\path\\to\\node.exe",
          "args": ["C:\\absolute\\path\\to\\pnpm.cjs", "install", "--offline", "--frozen-lockfile"],
          "inherit_env": false,
          "env": {"CI": "1", "PNPM_STORE_DIR": "C:\\absolute\\path\\to\\pnpm-store"}
        },
        "timeout_seconds": 900
      }
    ]
  },
  "allowed_generated_paths": [],
  "budgets": {
    "plan_review_max": 2,
    "implementation_review_max": 2,
    "base_sync_max": 1,
    "base_sync_review_max": 2,
    "cursor_scout_max": 1,
    "cursor_tiebreak_max": 1,
    "cursor_invocations_run_max": 2,
    "test_fix_max_per_writer_epoch": 2,
    "test_worker_invocation_max_per_evidence_key": 2,
    "test_worker_recovery_retry_max_per_action": 1,
    "codex_invocations_run_max": 12,
    "claude_invocations_run_max": 12
  }
}
```

- `cwd`는 worktree 내부 상대경로만 허용한다. 절대경로와 `..` 탈출은 거부한다.
- `delivery.required_pr_checks`는 unique한 exact `(name, workflow)` 배열이다. 빈 배열이면 PR check 대기를 생략한다. 값이 있으면 나열된 check만 게이트 대상이며 extra check는 증거에 기록하되 결과를 바꾸지 않는다.
- contract의 `delivery.remote`는 기존 Git remote 이름이며 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`만 허용한다. `target_ref`는 `refs/heads/<target_ref>`로 정규화 가능한 short branch name이어야 하며 option·refspec 문자는 거부한다. contract 잠금 때 `<safe-git> remote get-url --all <remote>`와 `<safe-git> remote get-url --push --all <remote>`의 rewrite 적용 결과가 각각 정확히 하나인지 확인한다. v1은 credential 없는 `https://github.com/<delivery.repository>[.git]` 한 개씩만 허용하며 SSH/git/file/remote-helper URL, 다른 host/repository는 거부한다. raw fetch/push URL과 canonical repository를 `resolved-delivery.json`에 hash-lock한다. 이후 모든 network Git action 직전에 두 명령을 다시 실행해 raw 결과가 lock과 byte-for-byte 같은지 확인하고, remote 인자는 `--` 뒤에 전달한 뒤에만 fixed refspec을 쓴다.
- v1 명령은 `runner.type = exec | shell_script`뿐이다. `exec`는 lock 시 존재하는 절대 executable과 토큰화된 `args[]`를 사용하고 shell을 거치지 않는다. `shell_script`는 `shell = powershell | cmd`, 절대 shell executable, base SHA에 존재하는 worktree 상대 `script_path`, 토큰화된 `args[]`를 명시한다. inline `-Command`·`/c`, pipe, redirect, command substitution 문자열은 금지한다.
- required command끼리는 filesystem 산출물을 공유하지 않는 독립 단위여야 한다. 순서·산출물 의존이 필요한 setup+test는 base SHA에 잠긴 하나의 `shell_script` command로 묶는다. supervisor는 각 `(writer_epoch, scope, head_sha, command_id)`를 fresh disposable detached worktree에서 실행하므로 이전 command worktree가 존재한다고 가정할 수 없다.
- dependency marker가 있는 repo는 `dependency_setup.mode=offline`과 각 test의 `setup_ids`, 또는 사람이 증명한 `mode=self-contained` 중 하나를 contract에 넣어야 한다. offline setup은 같은 disposable command worktree 안에서 test 직전에 순서대로 실행하며 network는 계속 false다. executable, package-manager entry script/wrapper, lockfile blob, setup argv/env, cache path를 hash-lock한다. cache root는 canonical path+ACL을 잠가 host에서 read-only여야 하고 setup은 worktree의 `ephemeral_output_paths`만 만들 수 있다. cache miss, setup nonzero/timeout/output/resource, lockfile drift는 fixer로 보내지 않고 `NEEDS_HUMAN`이다.
- `inherit_env`는 항상 `false`다. 계약의 `env` allowlist만 test process에 전달하며 이름에 `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL`이 들어간 변수와 `HARNESS_HOME`, `STAGING_HOME`, `CODEX_HOME`, 사용자 profile 경로는 거부한다.
- contract 잠금 때 supervisor가 executable의 canonical path·SHA-256과 shell script의 base blob SHA를 별도 resolved-command record로 고정한다. wrapper는 실행 직전에 이 hash와 자신의 hash를 다시 확인하고 하나라도 다르면 실행하지 않는다.
- 모든 AC는 `verification.type = command | human` 중 하나다. command는 `command_ids`, human은 승인 시 확인할 `checklist`를 가진다.
- 모든 AC는 `critical` 값과 무관하게 필수다. `critical=true`는 실패 finding의 최소 severity를 major로 강제할 뿐 게이트 적용 여부를 바꾸지 않는다.
- command AC는 verifier worktree에서 supervisor가 독립 실행하고 반대 모델이 증거를 판정한다.
- human AC는 merge 승인 시 사람이 checklist 결과와 메모를 기록한다. `critical=true`도 허용하지만 이 기록 없이는 merge 승인할 수 없다.
- 명령 timeout 기본값은 900초다. Ctrl+C·timeout·비정상 종료는 성공 증거가 아니다.
- `standard-v1` resource profile은 고정 상한이다. planner/reviewer/writer 등 AI child는 stdout 8 MiB, stderr 8 MiB, combined 12 MiB, active process 32, Job memory 6 GiB다. 각 test-worker command는 stdout 16 MiB, stderr 16 MiB, combined 24 MiB, active process 64, Job memory 8 GiB다. 더 필요한 contract는 v1에서 시작하지 않고 사람이 별도 profile을 설계한다.
- 모든 AI/test child는 reviewed `HarnessJob.cs`를 Windows PowerShell `Add-Type -OutputType ConsoleApplication`으로 최초 1회 빌드해 hash-lock한 `harness-job.exe`를 통해 suspended create → Job Object assign → resume한다. Job은 `KILL_ON_JOB_CLOSE`, active-process, job-memory limit을 강제한다. wrapper source/exe hash나 Job assignment smoke가 다르면 child를 시작하지 않는다.
- stdout/stderr는 pipe에서 streaming count+SHA-256하며 상한 이하는 전체 저장한다. 어느 상한이든 넘으면 PID+start-time을 확인해 Job handle을 닫고 tree 종료를 확인한다. 결과는 `output_limit`, memory/process 제한은 `resource_limit`이며 성공 evidence가 아니다. 초과 로그는 stream별 처음 4 MiB, 전체 byte count와 digest만 보존한다.
- 정상 경로에서는 각 `(writer_epoch, scope, head_sha, command_id)`를 최대 한 번 완료한다. pass/fail/timeout은 같은 evidence key에서 자동 재시도하지 않는다. normal nonzero exit는 fail manifest를 등록하고 `test_fix_max_per_writer_epoch` 안에서 fixer가 새 SHA를 만들며, 새 SHA에서만 다시 시작한다. PC·process interruption만 action별 1회 자동 복구 재시도를 허용하고 `test_worker_invocation_max_per_evidence_key`는 `1 + test_worker_recovery_retry_max_per_action` 이상이어야 한다. 모든 시작된 Codex/Claude/Cursor child 호출은 중단 여부와 무관하게 provider·Cursor run 상한에 포함되고, 다음 호출이 상한을 넘으면 `NEEDS_HUMAN`이다. Cursor Scout와 타이브레이커는 자동 재시도하지 않는다.
- `implementation_review_max`와 `base_sync_review_max`는 `writer_epoch`별 상한이다. 사람의 writer 교체는 epoch를 1 올리고 새 epoch의 두 review counter를 0으로 시작하지만 provider별 run 총상한과 run 단위 `base_sync_max`는 절대 초기화하지 않는다. 두 번째 base drift는 `NEEDS_HUMAN`이다.
- v1은 사용자가 소유·검토한 저장소의 `trusted-repo`만 지원하고 `host_read_confidentiality_required`는 반드시 false다. true, untrusted source, strong isolation 요청은 `UNSUPPORTED_IN_V1`로 contract를 거부한다. strong backend 선택·구축은 v2 별도 계획이다.
- v1 delivery provider는 GitHub뿐이다. 위에서 잠근 fetch/push endpoint와 `gh repo view -R <delivery.repository> --json nameWithOwner`가 같은 repository인지, `gh auth status -h github.com`, Git credential, `<safe-git> config user.name/user.email`이 유효한지 확인해야 contract를 잠근다. repo-targeted `gh` 명령은 `-R <delivery.repository>`를 명시하고, `gh api`는 `-R`에 의존하지 않고 literal `repos/<owner>/<repo>/...` endpoint를 쓴다. API version `2026-03-10`을 protocol snapshot에 잠근다. target branch 조회의 `protected=false`와 branch에 적용되는 rules 전체 pagination 결과 `[]`를 모두 확인할 수 있는 저장소만 자동 병합한다. 오류·권한 부족·불완전 pagination·non-empty rules, merge queue, merge commit 비허용, signed-commit 강제, fork head, target ref 직접 갱신 불가 저장소는 `UNSUPPORTED_IN_V1`이다.
- contract 잠금 때 모든 scope/include가 확장된 Git config, `.git/info/attributes`, base tree의 모든 tracked `.gitattributes`를 검사한다. `filter.*.(clean|smudge|process)`, `merge.*.driver`, `diff.*.(command|textconv)`, `diff.external`, `core.fsmonitor`, `core.sshCommand`, `remote.*.(mirror|receivepack|uploadpack)`, push option, proxy/custom CA/TLS backend, external `filter|merge|diff` attributes가 하나라도 있으면 v1은 `UNSUPPORTED_IN_V1`로 거부한다. Git LFS/custom filter/merge driver와 custom proxy/CA 저장소는 v2 대상이다. credential helper는 canonical executable과 argv를 해석해 hash-lock한 Git Credential Manager 또는 잠긴 `gh.exe auth git-credential`만 허용하고 repo-relative path, 임의 `!` shell command, 알 수 없는 helper는 거부한다. expanded config+include origin, info attributes, tracked attribute paths/blobs, helper fingerprints를 `resolved-git-safety.json`에 잠근다.
- worktree/checkout/index/diff/merge/ref/network를 포함한 모든 host Git action 직전에 `resolved-git-safety.json`을 재계산한다. base-sync target tree의 모든 `.gitattributes`도 locked set/blob과 같아야 한다. drift·새 attribute file·helper 변경은 Git을 실행하기 전에 `NEEDS_HUMAN`이며 자동으로 새 값을 신뢰하지 않는다.
- 모든 supervisor Git 호출은 protocol에 잠긴 `git.exe`와 clean Git environment를 사용한다. `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_EXTERNAL_DIFF`, `GIT_CONFIG_*`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_SSH_VARIANT`, `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_PROXY_COMMAND`, `GIT_SSL_NO_VERIFY`, ambient `GIT_EXEC_PATH`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`는 상속하지 않는다. `GIT_EXEC_PATH=<locked-exec-path>`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=Never`, current directory 없는 locked Git/System32/credential-helper 최소 `PATH`를 둔다. 공통 argv는 `--no-pager -c core.hooksPath=<absolute-trusted-empty-dir> -c core.fsmonitor=false -c core.askPass= -c diff.external= -c http.sslVerify=true -c push.gpgSign=false -c push.followTags=false -c push.recurseSubmodules=no -c push.pushOption= -c fetch.recurseSubmodules=false`다. diff에는 `--no-ext-diff --no-textconv`; push에는 `--no-verify --no-signed --no-follow-tags --recurse-submodules=no --no-push-option --porcelain`; fetch에는 `--no-tags --no-recurse-submodules --no-write-fetch-head --no-auto-maintenance --no-write-commit-graph --no-server-option`; `commit-tree`에는 `--no-gpg-sign`을 추가한다. proxy/custom CA/TLS backend config는 v1에서 거부한다. worktree add/checkout, add, status, commit, merge, fetch/push에도 같은 baseline을 적용하며 baseline argv hash를 action journal에 기록한다. 이하 `<safe-git>` 표기는 이 exact executable+environment+공통 argv의 완전한 전개를 뜻한다.
- 모든 fetch는 source ref 하나를 unique `refs/harness/fetch/<action-id>/<purpose>`에만 쓰고, 그 temp ref가 사전에 없음을 확인한다. fixed refspec 외 ref/tag/FETCH_HEAD/submodule/maintenance를 갱신하지 않으며 OID를 journal에 등록한 뒤 temp ref를 CAS-delete한다. 기존 remote-tracking ref와 `--prune`은 쓰지 않는다.

### Cursor Repo Scout 정본

계획 전에 Cursor가 exact `base_sha`의 disposable detached worktree를 한 번 조사한다. Scout는 verdict나 상태 전이 권한 없이 재사용 후보·영향 위치·테스트 지점·실패 시나리오가 있는 위험·확인하지 못한 사항만 출력한다.

```json
{
  "status": "available",
  "reuse_candidates": [
    {"id": "RS-001", "location": "src/existing.ts", "reason": "재사용 가능한 기존 helper"}
  ],
  "affected_locations": [
    {"id": "RS-002", "location": "src/feature.ts", "reason": "변경 가능성이 있는 경로"}
  ],
  "test_points": [
    {"id": "RS-003", "location": "tests/feature.test.ts", "reason": "검증 지점"}
  ],
  "risks": [
    {
      "id": "RS-004",
      "claim": "구체적 위험",
      "failure_scenario": "입력 또는 조건 → 잘못된 결과",
      "evidence": ["파일:줄 또는 정적 근거"]
    }
  ],
  "unknowns": [
    {"id": "RS-005", "question": "저장소에서 확인하지 못한 사항"}
  ]
}
```

- `cursor-scout.schema.json`은 각 항목의 run 내 unique `id`, non-empty location/reason, 위험의 failure scenario와 evidence를 검증한다. Scout 출력에는 `verdict`, severity, finding disposition, 수정 지시를 두지 않는다.
- supervisor는 exact `base_sha`의 disposable worktree에 read-only `.harness-input/<action-id>.json`을 만들고 다음 고정 호출을 사용한다.

  ```powershell
  cursor-agent -p --mode plan --sandbox enabled --trust `
    --output-format json --workspace <scout-worktree> `
    "Read .harness-input/<action-id>.json and inspect the repository without editing."
  ```

- input 파일을 삭제한 뒤 HEAD·index·tracked tree·untracked set이 실행 전과 같아야 한다. worktree 내부에 다른 변경이 생기면 worktree를 폐기하고 schema-valid `unavailable` record를 등록한 뒤 계획을 계속한다. Scout worktree는 성공 여부와 관계없이 identity 확인 후 폐기하며 writer branch에는 연결하지 않는다.
- 로그인·rate limit·timeout·schema-invalid·Scout worktree 내부 변경은 `unavailable`의 구체적 reason으로 기록하는 soft failure다. 경계 밖 변경, clean-env 위반, protocol hash 불일치, ledger 무결성 실패는 `NEEDS_HUMAN`인 hard failure다. 두 경우 모두 Scout를 자동 재시도하지 않는다.
- 사용 가능한 Scout artifact와 unavailable artifact 모두 hash-lock한다. Claude planner와 Codex plan reviewer는 같은 원문 hash를 입력으로 받는다. planner 출력은 사용 가능한 모든 Scout item을 정확히 한 번 `incorporated | rejected`로 disposition하고 구체적 reason을 남긴다. unavailable이면 disposition 배열은 비어야 한다.

### 계획 매핑 정본

자유형식 계획과 별도로 같은 버전의 schema-valid `PLAN_vN.map.json`을 반드시 만든다.

```json
{
  "plan_path": "plan/PLAN_v1.md",
  "plan_sha256": "sha256",
  "mappings": [
    {
      "ac_id": "AC-001",
      "implementation_locations": ["src/feature.ts"],
      "verification_ids": ["T-001"]
    }
  ]
}
```

- contract의 모든 AC가 정확히 한 번 나타나고 알 수 없는 AC는 없어야 한다. 구현 위치는 non-empty repo 상대경로이며 코드 변경이 없는 AC만 `N/A:<구체적 이유>`를 허용한다.
- `implementation_locations`가 v1 forbidden writer path와 겹치면 plan bundle을 등록하지 않는다.
- delete는 source path, move는 source와 destination path가 모두 `implementation_locations`에 있어야 한다. directory 단위·recursive delete/move는 v1에서 금지하고 file 단위만 허용한다.
- 모든 mapping이 `N/A:`면 no-code run이다. 계획 리뷰가 이를 명시적으로 pass한 경우 writer를 생략하고 checkpoint가 tree=`base_sha^{tree}`, parent=`base_sha`인 deterministic empty commit을 만들어 `head_sha`를 한 칸 전진시킨다. 이 head로 테스트·교차 리뷰·PR을 그대로 수행한다. 하나라도 실제 구현 위치가 있는데 writer 결과 diff와 승인된 declarative file operation이 모두 비면 `NEEDS_HUMAN`이다.
- command AC의 `verification_ids`는 contract의 `command_ids`와 집합이 정확히 같아야 한다. human AC는 `HUMAN:<AC-ID>` 하나만 둔다.
- `plan_bundle_hash = SHA-256(canonical JSON {plan_sha256, map_sha256})`다. 리뷰, 결정, 승인, 구현 입력은 개별 plan hash가 아니라 이 bundle hash에 묶인다. 계획 본문이나 map 중 하나가 바뀌면 둘을 새 버전으로 등록하고 다시 리뷰한다.

### 리뷰 finding 정본

reviewer는 상태를 닫을 권한이 없다. 아래 사실만 출력한다.

```json
{
  "phase": "plan | implementation",
  "reviewer": "codex | claude | cursor",
  "invocation_id": "CLI가 반환하거나 supervisor가 부여한 이번 호출 ID",
  "input_artifacts": [
    {"kind": "contract", "sha256": "sha256"},
    {"kind": "plan_bundle", "sha256": "sha256"}
  ],
  "verdict": "APPROVED | REVISE",
  "findings": [
    {
      "severity": "blocker | major | minor",
      "claim": "검증 가능한 한 문장",
      "failure_scenario": "입력/조건 → 실제 잘못된 결과",
      "evidence": ["파일:줄, 로그, 재현 명령"],
      "acceptance_criteria": ["AC-001"],
      "affected_locations": ["path 또는 symbol"]
    }
  ],
  "finding_assessments": [
    {
      "fingerprint": "기존 finding fingerprint",
      "result": "resolved | still_open | insufficient_evidence",
      "evidence_ids": ["EV-001"],
      "notes": "재판정 근거"
    }
  ],
  "ac_assessments": [
    {
      "ac_id": "AC-001",
      "result": "pass | fail | insufficient_evidence | not_applicable",
      "evidence_ids": ["EV-001"],
      "notes": "판정 근거"
    }
  ],
  "requested_checks": []
}
```

- 러너가 `sha256(normalized AC + claim + affected_locations)`로 finding fingerprint를 만든다. 같은 fingerprint가 같은 쟁점이다.
- `phase`, `reviewer`, `invocation_id`, `input_artifacts`는 모델 진술을 믿지 않고 supervisor가 실제 invocation과 등록 artifact에서 덮어쓴다. plan review는 contract+plan bundle, implementation review는 여기에 `head_sha`와 writer/verifier manifest hash를 추가하며 하나라도 current run과 다르면 stale이다.
- blocker/major에서 claim, failure scenario, evidence, AC 연결이 하나라도 비면 `needs_evidence`로 분류한다. minor로 자동 강등하지 않는다.
- writer는 finding마다 `accepted | rejected | needs_human`과 근거를 제출한다.
- 다음 verifier가 `resolved | still_open`을 판정한다. `dismissed`는 사람만 사유와 함께 기록한다.
- 첫 리뷰의 `finding_assessments`는 빈 배열이다. 2차 리뷰는 이전 blocker/major fingerprint마다 정확히 하나의 assessment를 요구한다. 누락은 resolved가 아니라 `insufficient_evidence`로 취급한다.
- `requested_checks`는 실행 지시가 아니다. implementation review에서 current SHA의 기존 command ID를 요청하면 이미 등록된 writer/verifier evidence ID를 재사용하고 같은 evidence key에서 재실행하지 않는다. 새 조건·새 command 또는 기존 evidence로 답할 수 없는 요청은 `NEEDS_HUMAN`으로 보낸다. 계약 변경이 필요하면 현재 run을 `ABORTED/ARCHIVED`한 뒤 그 run을 `predecessor_run_id`로 가리키는 새 run을 시작한다. plan review에서는 제안으로만 기록한다.
- 구조화 JSON이 게이트 정본이다. `*-events.jsonl`은 원본 추적용, `*-report.md`는 러너가 JSON에서 결정적으로 렌더링한다.
- 각 plan review는 모든 AC를 정확히 한 번 assessment하고 `not_applicable`을 허용하지 않는다. implementation review는 모든 command AC를 정확히 한 번 assessment하며 human AC만 merge 전까지 `not_applicable`을 허용한다. 누락·중복·알 수 없는 AC는 schema 실패다.
- plan AC의 `fail|insufficient_evidence`와 implementation command AC의 같은 결과에는 해당 AC를 연결한 blocker/major finding이 반드시 있어야 한다. `critical=true` AC 실패는 major 이상이다. supervisor가 이 규칙과 open finding에서 `verdict`를 다시 파생해 model verdict를 덮어쓴다.

### 결정과 human AC 정본

각 review는 `decisions/<phase>-r<N>-<action-id>.json`에 다음 schema-valid record를 한 번만 등록한다. 기존 파일은 덮어쓰지 않으며 `run.json`이 current plan/implementation decision hash를 가리킨다. `decisions-report.md`는 이 immutable artifacts에서 결정적으로 다시 만드는 비정본 요약이다.

```json
{
  "phase": "plan | implementation",
  "input_review_sha256": "sha256",
  "plan_bundle_hash": "sha256",
  "head_sha": null,
  "items": [
    {
      "fingerprint": "finding fingerprint",
      "disposition": "accepted | rejected | needs_human",
      "reason": "구체적 이유",
      "artifact_refs": [{"kind": "contract", "sha256": "sha256"}]
    }
  ]
}
```

- current review의 finding fingerprint가 정확히 한 번씩 있어야 한다. `rejected`는 최소 한 개의 등록 artifact ref, `needs_human`은 non-empty reason을 요구한다. plan reject는 request/contract/plan/map/review artifact, implementation reject는 diff/manifest/log/review artifact만 참조할 수 있다. implementation record의 `head_sha`는 current SHA이고 plan record만 null이다.
- supervisor가 input review hash, plan bundle, head SHA를 current artifact에서 덮어쓰며 stale decision은 적용하지 않는다.
- `RUN_PLAN_DECISIONS` actor는 Claude planner, `RUN_IMPL_DECISIONS` actor는 current writer다. 둘 다 source를 못 쓰는 fresh read-only invocation으로 current contract, plan bundle, review, evidence index, prior decisions를 받고 `decision.schema.json`만 출력한다. Claude는 safe-mode baseline의 `--permission-mode plan --tools "Read,Glob,Grep" --json-schema <decision-schema>`, Codex는 hardened `--ephemeral --sandbox read-only --output-schema <decision-schema>`를 쓴다.
- decision에 `needs_human`이 하나라도 있으면 즉시 `NEEDS_HUMAN`이다. accepted plan finding은 남은 review budget이 있을 때만 `RUN_REVISE_PLAN`, accepted implementation finding은 수정 뒤 fresh review budget이 있을 때만 decision artifact를 입력으로 `RUN_FIX`한다. blocker/major를 모두 rejected한 경우에도 남은 budget 안에서 plan fresh adjudication 또는 implementation fresh verifier 재판정을 수행한다. 필요한 후속 리뷰 budget이 없으면 수정만 하고 승인하지 않으며 `NEEDS_HUMAN`이다. open blocker/major가 없고 AC gate가 통과하면 각각 사람 계획 승인 또는 PR 게시로 간다.

merge 승인 입력인 human AC record는 다음 형식이다.

```json
{
  "plan_bundle_hash": "sha256",
  "head_sha": "full git sha",
  "checks": [
    {
      "ac_id": "AC-002",
      "items": [
        {"statement": "contract checklist 원문", "result": "pass | fail", "notes": "확인 메모"}
      ]
    }
  ]
}
```

- contract의 모든 human AC와 checklist item이 순서·문구까지 정확히 한 번 있어야 하며 전부 pass여야 한다. supervisor가 사람 identity·시간·nonce 대상 suffix, `approved_target_tip_sha`, PR number/open/head/base, remote feature OID, canonical required-check result hash, supported repository-rule hash를 approval artifact에 추가한다.
- record의 bundle/head가 current 값과 다르거나 command AC가 섞이면 거부한다.

### 검증 evidence manifest

supervisor는 model-modified code를 host 권한으로 직접 실행하지 않는다. 각 `(writer_epoch, scope, head_sha, command_id)`의 fresh disposable worktree마다 Codex native sandbox의 전용 test worker를 띄운다. `test-result.schema.json`은 child가 반환하는 비신뢰 structured result, `execution-attempt.schema.json`은 supervisor가 관찰한 각 process 실행, `execution-manifest.schema.json`은 게이트가 읽는 최종 정본을 각각 검증한다.

```json
{
  "evidence_id": "EV-001",
  "writer_epoch": 1,
  "scope": "writer | verifier",
  "head_sha": "full git sha",
  "ac_ids": ["AC-001"],
  "command_id": "T-001",
  "cwd": ".",
  "runner_sha256": "sha256",
  "isolation_profile": "trusted-repo",
  "sandbox_config_sha256": "sha256",
  "job_config_sha256": "sha256",
  "setup_evidence": [
    {"setup_id": "S-001", "runner_sha256": "sha256", "exit_code": 0, "result": "pass", "log_sha256": "sha256"}
  ],
  "attempt_ids": ["ATT-001"],
  "final_attempt_id": "ATT-001",
  "exit_code": 0,
  "result": "pass",
  "termination_reason": "exit",
  "structured_result_sha256": "sha256",
  "stdout_bytes": 0,
  "stderr_bytes": 0,
  "log_sha256": "sha256"
}
```

실행 정본은 `(writer_epoch, scope, head_sha, command_id)`마다 최대 하나다. manifest는 model output이 아니라 supervisor가 모든 referenced attempt의 Job/exit/mutation/bounded-log 사실에서 생성한다. `result` enum은 `pass | fail | timeout | output_limit | resource_limit | test_mutation | setup_failed | protocol_error`이고, `exit_code`는 process exit를 관찰했을 때 integer, 그 외 null이다. structured result가 없거나 invalid한 채 process가 정상 관측 종료되면 `protocol_error` manifest를 만든다. supervisor가 해당 command를 참조하는 AC를 contract에서 역산해 정렬·중복 제거한 `ac_ids[]`로 기록한다.

각 시작된 process는 결과와 무관하게 immutable execution-attempt artifact를 남긴다. attempt에는 evidence key, action/attempt ID, PID+start time, 시작·종료시각, 관찰 exit code, termination reason, sandbox/runner/job config hash, stdout/stderr byte count·digest, structured-result hash와 schema 판정을 기록한다. process/PC interruption은 attempt에만 남기고 final manifest를 만들지 않는다. disposable worktree를 폐기·재생성한 허용 복구가 성공하면 모든 `attempt_ids`와 `final_attempt_id`를 참조하는 manifest 하나를 만든다. 복구 상한이 소진되면 manifest 없이 `NEEDS_HUMAN`으로 간다.

contract의 `expected_exit_code`는 v1에서 `0`만 허용한다. 관측된 normal nonzero exit는 handler infrastructure failure가 아니라 `result=fail`인 domain outcome이다. 성공 gate는 `result=pass`만 인정한다. 모든 command형 AC는 current writer epoch의 verifier manifest에서 연결 command가 전부 pass이고 반대 모델의 `ac_assessments.result=pass`여야 한다. 모든 human형 AC는 merge 승인에 묶인 사람 checklist 기록이 정본이다.

정본 JSON은 protocol에 포함된 checked-in canonicalizer가 객체 key를 결정적으로 정렬해 UTF-8로 직렬화한다. 배열 순서는 보존하고 JSON 숫자는 safe integer만 허용한다. Markdown·diff·stdout/stderr log는 재직렬화하지 않고 원본 bytes를 SHA-256한다. canonicalizer hash도 protocol manifest에 잠근다.

test worker 규칙:

- supervisor가 잠긴 contract의 command마다 fresh detached worktree, action ID와 Node 임시 wrapper를 만든다. wrapper는 setup IDs를 먼저 실행하고 모두 pass일 때만 test를 실행한다. string shell이 아니라 resolved executable과 `args[]`를 `shell:false`로 spawn하고, shell script형만 잠긴 shell executable에 `script_path`와 `args[]`를 토큰으로 넘긴다.
- wrapper는 worktree의 `.harness-tmp/<action-id>/runner.mjs`에 만들고 wrapper·resolved executable·해당 script의 hash를 실행 직전에 재검증한다. 같은 디렉터리의 `temp/`만 TEMP/TMP로 쓰고 실행 후 전체를 삭제한다. 이 내부 경로는 source diff에서 제외하되 cleanup 실패 시 게이트를 막는다.
- supervisor는 문자열 조립이 아니라 아래의 고정 argv template으로 Codex를 실행한다. `shell_environment_policy.set` 값은 supervisor가 TOML escape하고, PATH에는 lock된 executable의 디렉터리와 Windows core 경로만 넣는다.

  ```powershell
  codex exec --ephemeral --ignore-user-config --ignore-rules --strict-config `
    --sandbox workspace-write -C <worktree> --json `
    --output-schema <absolute-test-result-schema> `
    -c 'approval_policy="never"' `
    -c 'windows.sandbox="elevated"' `
    -c 'sandbox_workspace_write.network_access=false' `
    -c 'sandbox_workspace_write.writable_roots=[]' `
    -c 'sandbox_workspace_write.exclude_tmpdir_env_var=true' `
    -c 'sandbox_workspace_write.exclude_slash_tmp=true' `
    -c 'web_search="disabled"' `
    -c 'project_doc_max_bytes=0' `
    -c 'shell_environment_policy.inherit="none"' `
    -c 'shell_environment_policy.set={PATH="<approved-tool-dirs>",SYSTEMROOT="C:\\Windows",COMSPEC="C:\\Windows\\System32\\cmd.exe",PATHEXT=".COM;.EXE;.BAT;.CMD",TEMP="<worktree-temp>",TMP="<worktree-temp>"}' `
    -
  ```

- `--ignore-user-config`는 인증은 유지하되 사용자 config의 writable roots·approval 설정을 버린다. 명시 override, `--strict-config`, 빈 추가 writable roots, worktree 내부 temp, `approval_policy=never`, shell network off, built-in web search disabled, project instruction bytes 0을 모두 확인한 invocation record의 hash를 manifest에 넣는다. 하나라도 적용되지 않으면 실행하지 않는다.
- child가 staging 경로를 직접 받거나 `-o`로 쓰지 않는다. supervisor가 stdout/stderr pipe를 staging에 캡처하고 JSONL의 최종 structured message를 schema 검증한다.
- worker에는 wrapper 1개 실행만 지시한다. supervisor는 raw events에서 허용 wrapper 외 shell/edit/tool 호출이 없고, cwd·command ID·runner hash·exit code가 schema와 일치하는지 확인한다.
- timeout·추가 tool call·sandbox 밖 접근 시도·event 누락은 실패다. stdout/stderr는 staging에서 hash한 뒤 manifest와 함께 등록한다.
- `trusted-repo` profile은 위 hardened 호출로 worktree 밖 쓰기와 tool network를 차단하지만 임의 host 파일 읽기 기밀성은 주장하지 않는다. 이 보장이 필요한 작업은 v1에서 거부한다.

### 분쟁 증거

- 동작: 재현 테스트
- 성능: 고정 입력·환경의 벤치마크
- 보안: 위협 모델, 재현, 정적 근거
- UX·제품 의도·모호한 계약: 사람의 contract 결정

토론 횟수만 늘리지 않는다.

---

## 3. 상태·복구 모델

### 상태

```text
SPEC_DRAFT → SPEC_LOCKED/RUN_CURSOR_SCOUT → SPEC_LOCKED/RUN_PLANNER
→ PLANNING → PLAN_REVIEW → PLAN_APPROVED
→ IMPLEMENTING → IMPL_REVIEW → READY_TO_MERGE → MERGE_APPROVED
→ MERGED → ARCHIVED

READY_TO_MERGE ── base drift ──→ BASE_SYNC ── exact base merge ──→ IMPLEMENTING

모든 보호 상태 ── 반복 실패·계약 모호성·writer 교체 ──→ NEEDS_HUMAN
모든 미완료 상태 ── 사람 중단 ──→ ABORTED
```

`run.json`에는 최소한 다음을 둔다.

- `protocol_version`, `sequence`, `state`, `pending_action`, `actor`
- `repo_id`, `repo_path`, `predecessor_run_id`, `base_ref`, `base_sha`, `comparison_base_sha`, `head_sha`
- `resolved_delivery_artifact_hash`, `pr_number`, `pr_url`, `pr_head_sha`, `last_published_head_sha`, `approved_target_tip_sha`, `approved_pr_snapshot_hash`, `approved_checks_hash`, `approved_rules_hash`, `merged_sha`, `target_tip_sha`
- `writer`, `verifier`, `writer_epoch`, `writer_branch`, `remote_branch`, `writer_worktree`, `verifier_worktree`
- `review_track = normal | base_sync`
- `protocol_manifest_hash`, `supervisor_hash`, `cli_versions`, `policy_hash`, `schema_hash`, `request_hash`, `contract_hash`, `approved_plan_path`, `approved_plan_hash`, `approved_plan_map_hash`, `approved_plan_bundle_hash`, `artifact_head_hash`
- `current_cursor_scout_hash`, `cursor_scout_status = available | unavailable`, `current_plan_review_hash`, `current_plan_decision_hash`, `current_impl_review_hash`, `current_impl_decision_hash`
- `attempts.plan_review`, `attempts.implementation_review_by_epoch`, `attempts.base_sync`, `attempts.base_sync_review_by_epoch`, `attempts.test_fix_by_epoch`, `attempts.cursor_scout`, `attempts.cursor_tiebreak`, `attempts.cursor_total`, `attempts.test_worker_by_evidence_key`, `attempts.codex_total`, `attempts.claude_total`
- plan/implementation review별 fresh ephemeral invocation ID; 외부 session 저장소나 resume ID는 복구 의존성이 아님
- `in_flight`: action ID, PID, process 시작시각, host, 입력 hash, 시작시각
- `host_action_journal_hash`, `checks_started_at_utc`, `checks_deadline_utc`, `checks_next_poll_utc`, `checks_transient_failures`
- `resume_state`, `resume_action`, `needs_human_reason`
- 계획·병합 승인자의 시간과 승인 대상 hash/SHA

`pending_action`은 최소 다음 enum을 쓴다.

```text
SUBMIT_CONTRACT, RUN_CURSOR_SCOUT, RUN_PLANNER, RUN_PLAN_REVIEW, RUN_PLAN_DECISIONS,
RUN_REVISE_PLAN, APPROVE_PLAN, RUN_WRITER, RUN_FIX, HOST_CHECKPOINT,
RUN_WRITER_TESTS, RUN_VERIFIER_TESTS, RUN_IMPL_REVIEW, RUN_IMPL_DECISIONS,
HOST_PUSH_BRANCH, HOST_UPSERT_PR, WAIT_PR_CHECKS, PREPARE_MERGE,
HOST_BASE_SYNC, APPROVE_MERGE, HOST_MERGE_PUSH, CONFIRM_MERGED,
RUN_CURSOR_TIEBREAK, RESOLVE_HUMAN, ARCHIVE, NONE
```

### 완결 전이표

`state/pending_action` 조합은 아래 표에 있는 것만 유효하다. 각 성공 handler는 표의 한 결과만 단일 transaction으로 기록한다.

| 현재 | actor/handler | 성공 결과 또는 결정 분기 |
|---|---|---|
| `SPEC_DRAFT/SUBMIT_CONTRACT` | 사람 kickoff | contract·delivery lock 후 `SPEC_LOCKED/RUN_CURSOR_SCOUT` |
| `SPEC_LOCKED/RUN_CURSOR_SCOUT` | fresh disposable Cursor Repo Scout | success 또는 soft failure artifact 등록 후 `SPEC_LOCKED/RUN_PLANNER`; hard failure면 `NEEDS_HUMAN/RESOLVE_HUMAN` |
| `SPEC_LOCKED/RUN_PLANNER` | supervisor launch normalization | 입력 hash와 in-flight를 fsync한 뒤 `PLANNING/RUN_PLANNER` |
| `PLANNING/RUN_PLANNER` | Claude planner | Cursor Scout 원문과 item별 disposition을 포함한 최초 plan+map bundle 등록, `PLAN_REVIEW/RUN_PLAN_REVIEW` |
| `PLAN_REVIEW/RUN_PLAN_REVIEW` | fresh opposite reviewer | 같은 Cursor Scout 원문을 포함해 review 등록, `PLAN_REVIEW/RUN_PLAN_DECISIONS` |
| `PLAN_REVIEW/RUN_PLAN_DECISIONS` | Claude read-only decision maker | 후속 review 예산이 있는 accepted면 `PLANNING/RUN_REVISE_PLAN`; blocker/major reject면 예산 내 `PLAN_REVIEW/RUN_PLAN_REVIEW`; gate pass면 `PLAN_REVIEW/APPROVE_PLAN`; needs-human/필요 예산 소진이면 `NEEDS_HUMAN/RESOLVE_HUMAN` |
| `PLANNING/RUN_REVISE_PLAN` | Claude planner/reviser | superseding plan+map bundle 등록, `PLAN_REVIEW/RUN_PLAN_REVIEW` |
| `PLAN_REVIEW/APPROVE_PLAN` | 사람 nonce 승인+writer 선택(기본 Claude) | writer/verifier와 `writer_epoch=1` 잠금, `PLAN_APPROVED/RUN_WRITER` |
| `PLAN_APPROVED/RUN_WRITER` | supervisor launch normalization | writer 입력 hash와 in-flight를 fsync한 뒤 `IMPLEMENTING/RUN_WRITER` |
| `IMPLEMENTING/RUN_WRITER` | current writer; all-N/A면 model 생략 | 완료 후 `IMPLEMENTING/HOST_CHECKPOINT`; interrupted는 허용 복구 재시도, 그 밖의 실패·복구 예산 소진은 `NEEDS_HUMAN/RESOLVE_HUMAN` |
| `IMPLEMENTING/RUN_FIX` | current writer; accepted-review decision 또는 failed-test evidence | `IMPLEMENTING/HOST_CHECKPOINT` |
| `IMPLEMENTING/HOST_CHECKPOINT` | supervisor | source commit 또는 유효 no-code empty commit 기록, `IMPLEMENTING/RUN_WRITER_TESTS` |
| `IMPLEMENTING/RUN_WRITER_TESTS` | disposable sandbox test worker | all pass면 `IMPLEMENTING/RUN_VERIFIER_TESTS`; normal nonzero+fix 예산이면 `IMPLEMENTING/RUN_FIX`; interrupted는 허용 복구 재시도, 그 밖의 non-pass·복구/수정 예산 소진은 `NEEDS_HUMAN/RESOLVE_HUMAN` |
| `IMPLEMENTING/RUN_VERIFIER_TESTS` | 별도 detached disposable sandbox worker | all pass면 `IMPL_REVIEW/RUN_IMPL_REVIEW`; normal nonzero+fix 예산이면 `IMPLEMENTING/RUN_FIX`; interrupted는 허용 복구 재시도, 그 밖의 non-pass·복구/수정 예산 소진은 `NEEDS_HUMAN/RESOLVE_HUMAN` |
| `IMPL_REVIEW/RUN_IMPL_REVIEW` | fresh opposite reviewer | `IMPL_REVIEW/RUN_IMPL_DECISIONS` |
| `IMPL_REVIEW/RUN_IMPL_DECISIONS` | current writer read-only decision maker | 수정 뒤 review 예산이 있는 accepted면 `IMPLEMENTING/RUN_FIX`; blocker/major reject면 예산 내 `IMPL_REVIEW/RUN_IMPL_REVIEW`; gate pass면 `READY_TO_MERGE/HOST_PUSH_BRANCH`; needs-human/필요 예산 소진이면 `NEEDS_HUMAN/RESOLVE_HUMAN` |
| `READY_TO_MERGE/HOST_PUSH_BRANCH` | supervisor | exact feature ref 게시/adopt, `READY_TO_MERGE/HOST_UPSERT_PR` |
| `READY_TO_MERGE/HOST_UPSERT_PR` | supervisor+`gh -R` | exact one PR create/update/adopt; contract check가 비면 `READY_TO_MERGE/PREPARE_MERGE`, 아니면 `READY_TO_MERGE/WAIT_PR_CHECKS` |
| `READY_TO_MERGE/WAIT_PR_CHECKS` | supervisor poller | contract의 exact `(name, workflow)`가 모두 pass/skipping이면 `READY_TO_MERGE/PREPARE_MERGE`; pending이면 같은 action+deadline; 누락·실패·취소·timeout이면 `NEEDS_HUMAN/RESOLVE_HUMAN` |
| `READY_TO_MERGE/PREPARE_MERGE` | supervisor | drift면 `BASE_SYNC/HOST_BASE_SYNC`; 아니면 `READY_TO_MERGE/APPROVE_MERGE` |
| `BASE_SYNC/HOST_BASE_SYNC` | supervisor | exact non-conflict merge 후 evidence stale, `IMPLEMENTING/RUN_WRITER_TESTS` |
| `READY_TO_MERGE/APPROVE_MERGE` | 사람 nonce+human AC 승인 | `MERGE_APPROVED/HOST_MERGE_PUSH` |
| `MERGE_APPROVED/HOST_MERGE_PUSH` | supervisor | approval snapshot과 protected=false/rules=[]가 exact면 lease CAS/post-state adopt 후 `MERGE_APPROVED/CONFIRM_MERGED`; target/check drift·pending이면 승인 폐기 후 prepare/wait; protected=true·non-empty rules·API 오류·권한 부족·불완전 pagination이면 target 미변경 상태로 `NEEDS_HUMAN/RESOLVE_HUMAN`(`reason=UNSUPPORTED_IN_V1`), fail/cancel·PR/feature mismatch면 일반 `NEEDS_HUMAN/RESOLVE_HUMAN` |
| `MERGE_APPROVED/CONFIRM_MERGED` | supervisor fetch+GitHub 조회 | fetched target·tree·direct parents와 PR merged/merge commit이 일치하면 `MERGED/ARCHIVE`; 120초 안 전파 대기 중이면 같은 action, 끝까지 불일치면 `NEEDS_HUMAN/RESOLVE_HUMAN` |
| `MERGED/ARCHIVE` 또는 `ABORTED/ARCHIVE` | supervisor | `ARCHIVED/NONE` |
| `NEEDS_HUMAN/RUN_CURSOR_TIEBREAK` | fresh read-only Cursor | opinion artifact 등록 후 항상 `NEEDS_HUMAN/RESOLVE_HUMAN`; 자동 finding close/수정/전이 없음 |
| `NEEDS_HUMAN/RESOLVE_HUMAN` | 사람 예외 결정 | 저장된 허용 resume state/action 또는 `ABORTED/ARCHIVE` 중 명시된 한 곳 |

모든 non-human handler는 정상 전이, journal로 증명된 exact post-state adopt, 허용된 동일 action 복구 재시도, `NEEDS_HUMAN/RESOLVE_HUMAN` 중 하나로 반드시 수렴한다. `NEEDS_HUMAN/RUN_CURSOR_TIEBREAK`는 정지점이 아니라 dispatcher가 실행하는 비사람 action이며 성공·실패 모두 `NEEDS_HUMAN/RESOLVE_HUMAN`으로 돌아간다. schema/hash/precondition 실패는 다음 정상 action으로 넘어가지 않는다. abort는 모든 미완료 조합에서 `ABORTED/ARCHIVE`, terminal은 `ARCHIVED/NONE`뿐이다.

### 결정적 게이트

- 계획: 모든 AC assessment=pass, open blocker/major=0, needs_evidence=0, schema-valid plan map에서 모든 AC의 구현 위치·검증 ID가 정확히 매핑되고 승인 대상 `plan_bundle_hash`가 일치.
- 첫 계획 리뷰 뒤 plan bundle hash가 바뀌거나 blocker/major를 writer가 reject하면 2차 리뷰를 한다. 수정이 없고 blocker/major reject도 없으며 게이트가 통과하면 1회로 끝난다.
- 구현 기술 게이트: clean `head_sha`, writer/verifier manifest에서 모든 필수 명령 성공, 모든 command형 AC의 반대 모델 assessment=pass, open blocker/major=0, needs_evidence=0.
- merge 승인 게이트: locked fetch/push URL 재검증 뒤 `<safe-git> fetch <fetch-hardening-flags> -- <remote> refs/heads/<target>:refs/harness/fetch/<action-id>/target` 성공, exact feature remote=head, PR open/head/base, contract-defined required check 통과/empty, target branch `protected=false`, 적용 rules 전체 pagination 결과 `[]`의 canonical snapshot 고정, base drift 처리 완료, 모든 human형 AC checklist 기록과 정확한 `head_sha` 사람 승인. GitHub API 오류·권한 부족·pagination 불완전은 안전한 empty로 취급하지 않는다.
- 구현 리뷰는 writer epoch마다 최대 2회다. blocker/major reject는 코드 변경이 없어도 새 verifier 재판정을 요구한다. 해당 epoch의 2차 후 blocker/major 또는 needs_evidence가 남으면 `NEEDS_HUMAN`이다.
- writer disposition이 `needs_human`이면 라운드를 소비해 토론하지 않고 즉시 `NEEDS_HUMAN`이다.
- writer commit이 바뀌면 이전 evidence와 구현 리뷰는 모두 stale이다.
- `base_sha`는 최초 계약 기준이라 바꾸지 않는다. `prepare-merge`에서 target tip이 `comparison_base_sha`와 다르면 `BASE_SYNC`로 간다. supervisor가 정확한 fetched tip을 old head에 merge하고 두 parent를 확인한 뒤 `comparison_base_sha`와 `head_sha`를 갱신한다. evidence/review를 stale 처리하고 `review_track=base_sync`, state=`IMPLEMENTING`, pending=`RUN_WRITER_TESTS`로 둔다. writer/verifier tests와 base-sync review를 다시 하며 충돌·상한 초과·두 번째 drift는 `NEEDS_HUMAN`이다.
- v1 delivery는 승인된 target tip을 expected value로 고정한 explicit lease CAS만 허용한다. supervisor가 `<safe-git> commit-tree --no-gpg-sign`으로 tree=`head_sha^{tree}`, direct parents=`[approved_target_tip_sha, head_sha]`인 merge commit을 만들고 `<safe-git> merge-base --is-ancestor <approved_target_tip_sha> <head_sha>`와 `<approved_target_tip_sha> <merged_sha>` 성공을 확인한다. 그 뒤 `<safe-git> push --no-verify --force-with-lease=refs/heads/<target>:<approved_target_tip_sha> -- <remote> <merged_sha>:refs/heads/<target>`를 실행한다. remote ref가 한 비트라도 달라졌거나 보호 규칙이 막으면 원자적으로 거부하고 `NEEDS_HUMAN`으로 간다. plain `--force`, expected SHA 없는 `--force-with-lease`, `+refspec`, squash/rebase/fast-forward, `gh pr merge`는 금지한다. 명령 이름에 `force`가 들어가지만, 사전 검증한 fast-forward commit을 exact expected SHA와 비교·교환하는 용도로만 허용한다.
- v1은 default/non-default target을 같은 방식으로 지원한다. merge commit이 feature `head_sha`를 direct parent로 포함하므로 indirect merge가 아니다. push 뒤 `CONFIRM_MERGED`는 5초 간격으로 최대 120초 동안 fixed fetch와 PR 조회를 반복해 fetched target tip=`merged_sha`, merge tree=`head_sha^{tree}`, direct parents=`[approved_target_tip_sha, head_sha]`, PR `merged=true`, PR `merge_commit_sha=merged_sha`를 모두 확인한다. 끝까지 불일치하면 target을 되돌리지 않고 `NEEDS_HUMAN`으로 보내며 archive하지 않는다.
- `worker_done`, 모델의 “완료” 선언, 모델 간 합의는 증거가 아니다.

### 무결성과 재부팅 복구

- `run.json`이 정본이다. 임시 파일에 쓰고 fsync 후 atomic rename한다.
- `run.json.sequence`를 먼저 확정한 뒤 같은 sequence 이벤트를 append한다. 재부팅으로 이벤트가 빠지면 `status/recover`가 snapshot에서 `RECOVERED_EVENT_GAP`을 보충한다.
- 깨진 마지막 JSONL 줄은 `recovery/`로 격리하고 유효한 마지막 줄까지만 복원한다.
- 짧은 상태 갱신 동안만 lock을 잡는다. lock에는 host, PID, process start time이 들어간다. 같은 프로세스가 살아 있으면 busy, 죽었으면 자동 회수한다. 다른 host lock은 사람의 `recover --force` 없이는 지우지 않는다.
- 외부 agent/test 실행 전 `in_flight`를 저장한다. 재부팅 뒤 PID가 없으면 immutable execution-attempt에 `interrupted`를 기록하고 partial output을 recovery로 옮긴다. Cursor Scout와 타이브레이커는 자동 재시도하지 않고 각각 soft unavailable 또는 사람 resolve로 수렴한다. 그 밖의 같은 `pending_action` 자동 재시도는 해당 action의 recovery retry와 provider/evidence-key budget이 남은 경우 한 번만 허용하고, 아니면 manifest를 만들지 않은 채 `NEEDS_HUMAN`이다.
- child PID와 process start time을 함께 기록하고 둘이 모두 일치할 때만 같은 child로 인정한다. supervisor가 죽고 그 child가 살아 있으면 matching tree를 종료해 `interrupted` 처리한다. PID는 같지만 start time이 다르면 재사용된 무관 process이므로 절대 kill하지 않고 원 child가 사라진 것으로 처리한다.
- timeout·취소 때도 PID+start time을 직전 재확인한 뒤 Job handle을 닫아 kill-on-close를 먼저 수행한다. 잔존 matching PID가 있을 때만 `taskkill /T /F /PID <pid>`를 fallback으로 쓰고 다시 확인한다. 종료 확인 실패는 `NEEDS_HUMAN`이다.
- writer/fixer turn 전 `turn-workspaces/<action-id>.json`에 branch ref/HEAD/index tree, clean index, exact tracked tree, approved-path existence+blob hash, untracked set을 fsync하고 branch ref를 checkpoint까지 고정한다. interrupted/timeout/schema-invalid/`needs_human`/invalid-diff면 partial diff와 로그를 recovery에 보존한다. canonical repo/gitdir/branch/ref가 pre-turn과 같을 때만 dedicated writer worktree를 safe Git로 remove/recreate해 exact HEAD·empty untracked·clean index/worktree를 확인한다. 그 뒤에만 recovery retry 또는 사람 대기를 허용하며 ref/identity mismatch는 `NEEDS_HUMAN`이다.
- writer/verifier tests는 canonical writer worktree에서 직접 실행하지 않는다. 각 `(writer_epoch, scope, head_sha, command_id)`마다 별도 fresh detached disposable worktree를 만들고 turn journal에 path/gitdir/HEAD를 잠근다. pass/fail 뒤 canonical manifest와 mutation diff를 등록하고 worktree를 identity 확인 후 폐기한다. interruption이면 attempt만 등록하고 그 command worktree를 폐기·재생성한 뒤에만 recovery retry하며 이미 등록된 다른 command evidence는 산출물 의존이 없으므로 그대로 둔다. tracked source mutation, allowed-generated 밖 변경, cleanup 불가 상태는 `test_mutation`으로 `NEEDS_HUMAN`이며 canonical writer branch에는 들어가지 않는다.
- `status`는 항상 무결성 검사와 안전한 자동 복구를 먼저 수행한다.
- request, contract, 모든 plan/review/decision/manifest/log/human approval은 등록 시 `artifacts.jsonl`에 sequence, kind, relative path, SHA-256, byte size, input artifact hashes, supersedes, previous-entry hash를 남겨 hash chain을 만든다. `run.json.artifact_head_hash`가 chain head다. 게이트는 현재 sequence가 참조한 등록 artifact만 읽고 파일과 chain을 다시 hash해 일치 여부를 확인한다.
- artifact 등록 순서는 `(1) D: recovery/txn/<action-id>에 candidate+hash fsync, (2) D: final immutable path로 same-volume atomic rename, (3) ledger entry append+fsync, (4) run.json의 artifact head를 atomic 갱신, (5) txn marker 삭제`로 고정한다. run snapshot의 head가 마지막 committed entry다.
- 재부팅 때 ledger의 유효 entry가 run head 뒤에 있으면 그 tail과 연결 artifact를 `recovery/uncommitted-<action-id>/`로 옮기고 canonical ledger를 committed prefix로 atomic replace한다. ledger에 없는 final file·남은 txn도 orphan으로 같은 방식으로 격리한다. run head가 가리키는 entry/file이 없거나 hash가 틀리면 자동 복구하지 않고 `NEEDS_HUMAN`이다. recovery 정리 자체도 `RECOVERED_ARTIFACT_TAIL` event로 남긴다.
- Git/GitHub side effect는 generic child retry를 절대 쓰지 않는다. `HOST_CHECKPOINT`, `HOST_BASE_SYNC`, `HOST_PUSH_BRANCH`, `HOST_UPSERT_PR`, `HOST_MERGE_PUSH`, 모든 `HOST_FETCH_REF` subaction, worktree create/remove 전에 `host-actions/<action-id>.json`을 fsync한다. journal에는 idempotency key, safe Git argv hash, old HEAD/index cleanliness, expected tree/parents/ref OID, locked remote URLs, remote pre/post OID, repository/PR head/base를 action별로 기록한다.
- 복구는 side effect를 조회해 세 값으로만 분기한다. exact expected post-state면 결과를 adopt하고 state transaction을 보충한다. exact pre-state면 action별 recovery retry 한도 안에서 한 번만 재실행한다. 어느 쪽도 아니거나 조회가 모호하면 `NEEDS_HUMAN`이다.
- checkpoint journal은 `PREPARED(pre-turn HEAD, clean-index, exact unstaged/untracked diff hash, ordered file-op intents+pre hashes) → OPS_APPLIED → STAGED(index tree, commit metadata, expected commit SHA) → REF_UPDATED` phase를 fsync한다. 각 op 뒤 completed index를 fsync한다. delete는 source exact-hash 존재면 apply, absent면 expected post로 adopt한다. move는 source exact+destination absent면 apply, source absent+destination same hash면 adopt한다. 그 밖은 중단한다. 모든 op post-state 뒤에만 OPS_APPLIED로 가고 stage한다. crash 뒤 HEAD=old/index=expected tree면 commit-tree/update-ref만 재개하며 HEAD=new/index=new tree면 adopt한다. 다른 diff/index/ref 조합은 `NEEDS_HUMAN`이다. all-N/A는 same-tree one-parent empty commit을 같은 journal/CAS로 만든다.
- base sync journal은 old head/index tree/clean, fetched target, expected parent/tree/new commit을 기록한다. ref CAS 뒤 `<safe-git> read-tree --reset -u <new-head>`로 index와 worktree를 materialize하고 HEAD tree=index tree, clean 상태를 검증한다. 재부팅 뒤 ref=new이지만 index=old인 알려진 intermediate면 materialize만 재개하고, ref/index/worktree가 exact post-state면 adopt, exact pre-state면 한 번 재시도한다. 그 밖의 dirty/ref/index 조합은 `NEEDS_HUMAN`이다.
- feature push는 remote pre OID와 expected `head_sha`, PR upsert는 `<repository, base, head branch, repo-id, run-id>`를 idempotency key로 쓴다. remote=expected head는 같은 action의 fsynced prior push intent가 있을 때만 crash 결과로 adopt하며 최초 publish의 기존 ref는 SHA가 같아도 collision이다. PR body에는 `<!-- harness-run:<repo-id>:<run-id> -->` marker와 contract hash를 넣고 exact head/base/marker의 open PR이 하나면 adopt/update, 없으면 create, 둘 이상이거나 marker가 다르면 중단한다.
- target merge는 push 전에 `merged_sha`를 journal에 저장한다. 복구 fetch 결과가 `merged_sha`면 성공을 adopt하고, `approved_target_tip_sha`면 같은 explicit lease를 한 번 재시도하며, 다른 SHA면 approval을 stale 처리한다. archive/worktree 제거도 path/repo identity가 exact할 때만 adopt/retry한다.
- submit-contract, prepare-merge, merge preflight, confirm-merged 등 모든 fetch는 같은 `HOST_FETCH_REF` subaction을 호출한다. journal phase는 `PREPARED(temp ref absent, locked remote+source+dest) → FETCHED(observed OID) → CONSUMED(caller snapshot에 OID fsync) → DELETED(CAS-delete)`다. PREPARED 복구에서 ref absent면 fetch를 한 번 재시도하고, action 전용 ref가 valid single OID면 그 OID를 adopt해 FETCHED를 보충한다. FETCHED/CONSUMED에서는 ref가 recorded OID일 때만 reuse/delete하며, CONSUMED 뒤 ref absent는 deletion adopt다. 다른 OID·여러 ref·invalid object는 `NEEDS_HUMAN`이다. PREPARE_MERGE/HOST_MERGE_PUSH/CONFIRM_MERGED는 소비 OID가 각자 승인/확인 snapshot에 fsync되기 전 temp ref를 지우지 않는다.

### 자동 dispatcher와 model I/O

`harnessctl run|resume`은 무결성·복구 검사를 한 뒤 `[H]` action, `NEEDS_HUMAN/RESOLVE_HUMAN`, terminal state를 만날 때까지 모든 비사람 `pending_action`을 순서대로 자동 dispatch한다. 따라서 `NEEDS_HUMAN/RUN_CURSOR_TIEBREAK`도 자동 실행한다. 모델은 다음 action을 선택하지 못한다. 각 handler는 입력 snapshot 저장 → budget 증가 → child 실행 → schema/hash 검증 → 단일 상태 전이 transaction을 수행하고, 오류도 정해진 복구 또는 사람 전이로 닫는다.

비사람 action은 최소 다음과 같다.

```text
RUN_CURSOR_SCOUT, RUN_PLANNER, RUN_PLAN_REVIEW, RUN_PLAN_DECISIONS, RUN_REVISE_PLAN,
RUN_WRITER, RUN_FIX, HOST_CHECKPOINT,
RUN_WRITER_TESTS, RUN_VERIFIER_TESTS, RUN_IMPL_REVIEW, RUN_IMPL_DECISIONS,
HOST_PUSH_BRANCH, HOST_UPSERT_PR, WAIT_PR_CHECKS, PREPARE_MERGE,
HOST_BASE_SYNC, HOST_MERGE_PUSH,
RUN_CURSOR_TIEBREAK, CONFIRM_MERGED, ARCHIVE
```

- `RUN_CURSOR_SCOUT`: exact `base_sha`의 disposable worktree+request+contract → cursor-scout schema 또는 soft-failure unavailable artifact. 자동 재시도 없음.
- `RUN_PLANNER`: request+contract+Cursor Scout 원문 → planner schema. 사용 가능한 Scout item마다 disposition이 정확히 하나 있어야 한다.
- `RUN_PLAN_DECISIONS` / `RUN_IMPL_DECISIONS`: current review+registered evidence → decision schema; source write 없음.
- `RUN_REVISE_PLAN`: previous bundle+review+decision → planner schema; 새 plan/map은 old bundle을 `supersedes`한다.
- `RUN_WRITER`: approved plan bundle+contract+base SHA → source 수정만.
- `RUN_FIX`: input은 tagged union이다. `review_fix`는 current head+accepted findings+decision artifact, `test_fix`는 current head+scope/command ID+normal nonzero-exit manifest+bounded log artifact를 준다. `fail` 외 execution result는 fixer로 보내지 않는다. test fix는 epoch별 상한을 소비하고 source 수정만 허용한다.
- `HOST_CHECKPOINT`: changed path 검증, safe Git baseline의 `write-tree → commit-tree --no-gpg-sign → update-ref <new> <old>` CAS로 hook/signing 없는 commit 생성. no-code plan도 old tree와 one parent를 가진 deterministic empty commit을 생성한다.
- `HOST_BASE_SYNC`: clean writer worktree에서 safe Git baseline의 `merge-tree --write-tree <old-head> <target-sha>`가 conflict 없이 반환한 tree로 two-parent `commit-tree --no-gpg-sign`를 만든 뒤 `update-ref` CAS한다. 이어 `<safe-git> read-tree --reset -u <new-head>`로 index/worktree를 exact merge tree로 맞추고 clean/tree를 검증한다. conflict면 ref/worktree를 바꾸지 않고 `NEEDS_HUMAN`; 모델이 자동 해결하지 않는다. journaled author/committer identity·timestamp·message로 expected SHA를 ref 변경 전에 확정한다.
- `HOST_PUSH_BRANCH`: first publish는 explicit empty-expect lease `--force-with-lease=refs/heads/harness/<run-id>:`로 ref 부재를 CAS하고, republish는 local ancestor 확인 뒤 `--force-with-lease=...:<last_published_head_sha>`로 recorded tip만 CAS한다. 둘 다 실제 create/fast-forward update만 허용한다.
- `HOST_UPSERT_PR`: `gh -R <delivery.repository>`로 exact head/base PR을 하나만 create/update/adopt한다. `required_pr_checks=[]`면 `WAIT_PR_CHECKS`를 생략한다.
- `WAIT_PR_CHECKS`: `gh pr checks <pr-number> -R <repository> --json name,bucket,state,workflow`를 30초 간격, 최초 poll부터 30분 deadline으로 조회한다. contract의 unique exact `(name, workflow)`가 모두 나타나고 각 bucket이 `pass|skipping`일 때만 통과한다. extra check는 기록만 한다. contract check 누락, `fail|cancel`, timeout은 `NEEDS_HUMAN`, `pending`은 계속한다. malformed/API transient는 30/60/120초 backoff로 최대 3회이며 원래 deadline을 늘리지 않는다. poll/deadline은 매번 fsync해 재부팅 뒤 같은 시각에서 재개한다.
- `RUN_WRITER_TESTS` / `RUN_VERIFIER_TESTS`는 command 순서대로 fresh worktree에서 실행하고 첫 normal nonzero exit에서 fail manifest를 닫아 `test_fix`로 보낸다. 같은 evidence key는 재실행하지 않고 fixer checkpoint의 새 SHA에서 전체 scope를 처음부터 수행한다. interruption 복구는 attempt를 추가하고 성공 시에만 단일 manifest를 닫는다. 비코드 실행 실패는 즉시 `NEEDS_HUMAN`이다.
- `RUN_CURSOR_TIEBREAK`: 사람 요청에 담긴 phase/disputed fingerprints와 current contract/plan/reviews/decisions/diff/evidence hash를 read-only input file로 주고 fresh Cursor opinion을 local review schema로 검증·등록한다. `attempts.cursor_tiebreak`와 `attempts.cursor_total`을 각각 1 소비하며 자동 재시도 없이 성공/실패 모두 사람 resolve로 돌아간다.
- `HOST_MERGE_PUSH`: commit 생성 전 locked env로 target/feature ref, `gh -R` PR open/head/base, contract checks와 literal GitHub API의 protected/rules snapshot을 다시 조회해 approval snapshot과 exact 일치시킨다. 일치할 때만 local merge commit의 tree/parent/ancestor를 검증하고 expected-SHA lease CAS로 target을 갱신한다. target/check snapshot drift·pending은 승인을 폐기하고 prepare/wait한다. protected=true·non-empty rules·API 오류·권한 부족·불완전 pagination은 push 없이 `NEEDS_HUMAN(reason=UNSUPPORTED_IN_V1)`, fail/cancel·PR/feature mismatch는 일반 `NEEDS_HUMAN`이다.
- `CONFIRM_MERGED`: 5초 간격·120초 deadline 안에 fixed target fetch와 literal PR API를 반복해 fetched target, merge tree/direct parents, PR `merged`와 `merge_commit_sha`를 모두 확인한다. deadline 뒤 불일치는 rollback 없이 `NEEDS_HUMAN`이다.

모든 Claude/Codex 입력은 positional prompt가 아니라 canonicalizer가 만든 UTF-8 JSON envelope를 stdin으로 전달하고 EOF로 닫는다. supervisor는 실제 byte length와 SHA-256을 `in_flight`에 기록한다. Cursor CLI는 stdin wire contract가 없으므로 Scout 또는 tiebreak 입력을 해당 disposable worktree의 read-only `.harness-input/<action-id>.json`에 쓰고 hash한 뒤 짧은 positional prompt로 그 파일만 읽게 한다.

```json
{
  "protocol_version": 1,
  "action_id": "uuid",
  "role": "planner | reviser | decision_maker | writer | fixer | reviewer",
  "input_artifacts": [{"kind": "contract", "sha256": "sha256"}],
  "run_snapshot": {"state": "PLANNING", "writer": "claude", "head_sha": null},
  "instructions": "protocol snapshot의 해당 prompt 원문",
  "payload": {}
}
```

planner/reviser 출력 schema는 `{status, plan_markdown, plan_map, scout_dispositions, reason}`이고 writer/fixer 출력 schema는 `{status, summary, changed_paths, file_operations, reason}`다. 사용 가능한 Scout artifact가 있으면 `scout_dispositions`는 모든 item ID를 정확히 한 번 `incorporated | rejected`와 non-empty reason으로 처리하고, unavailable이면 빈 배열이어야 한다. `file_operations`는 `{op:"delete", source, source_sha256}` 또는 `{op:"move", source, destination, source_sha256}`의 배열이다. supervisor는 pre-turn의 tracked regular file hash, map 포함 여부, forbidden/reparse 여부를 no-follow로 확인한 뒤 model 종료 후 checkpoint 전에만 file 단위 operation을 적용한다. source/destination은 operation 전체에서 unique·non-overlapping이고 cycle을 허용하지 않는다. move destination은 pre-turn과 적용 시점 모두 없어야 하고, delete/move source가 turn 중 수정됐거나 hash가 다르면 거부한다. directory operation과 overwrite는 금지한다. `status`는 `done | needs_human`; `done`은 필요한 산출물과 null reason, `needs_human`은 non-empty reason을 요구한다. reviewer는 review schema, decision maker는 decision schema를 쓴다. supervisor는 `changed_paths`를 믿지 않고 Git diff로 다시 계산한다.

기본 timeout은 planner/reviser/decision-maker/reviewer/Cursor 1,800초, writer/fixer 3,600초, 종료 grace 10초다. contract command만 자체 timeout을 쓴다. timeout은 성공이 아니며 정해진 process-tree 종료와 budget 규칙을 따른다.

---

## 4. `harnessctl` 명령 계약

아래 명령은 전용 host terminal의 trusted supervisor만 실행한다. agent의 `/harness`에는 `status`, `help`, `request-human`만 노출한다. 표의 `[H]` 행동은 실행 중인 supervisor console에서만 받고, 메모리 nonce + 대상 hash/SHA 끝 8자리 확인을 요구한다.

정상 run에서 nonce를 요구하는 사람 승인 게이트는 `approve-plan`, `approve-merge` 정확히 2회다. `submit-contract`는 사람이 run을 시작하며 제공하는 입력 제출이고 별도 승인 질문을 만들지 않는다. `resolve`, `abort`, 강제 복구는 예외 경로라 정상 게이트 수에 포함하지 않는다.

| 명령 | 사전조건 | 성공 결과 |
|---|---|---|
| `init --repo --slug [--predecessor-run-id]` | active run 없음; predecessor는 `ABORTED/ARCHIVED` | repo identity와 run dir만 생성, optional predecessor link와 `SPEC_DRAFT` |
| `run` / `resume` | run 존재 | 복구 후 비사람 pending action 자동 dispatch, 사람/terminal 상태에서만 정지 |
| `submit-contract --request --contract` | `SPEC_DRAFT`, 사람이 시작 입력 제출 | 검증·delivery fetch·base/worktree 생성, `SPEC_LOCKED/RUN_CURSOR_SCOUT` |
| internal `run-cursor-scout` | `SPEC_LOCKED/RUN_CURSOR_SCOUT`, Scout/total budget 미사용 | immutable available/unavailable artifact 등록, `SPEC_LOCKED/RUN_PLANNER`; hard failure는 `NEEDS_HUMAN` |
| internal `run-planner` | `PLANNING/RUN_PLANNER`, Scout artifact 등록 | immutable plan+map+Scout disposition bundle 등록, `PLAN_REVIEW/RUN_PLAN_REVIEW` |
| internal `review --phase plan` | `PLAN_REVIEW/RUN_PLAN_REVIEW` | fresh Codex output 저장, `RUN_PLAN_DECISIONS` |
| internal `decide --phase plan` | current plan review | accepted면 `PLANNING/RUN_REVISE_PLAN`; reject 재판정이면 `PLAN_REVIEW/RUN_PLAN_REVIEW`; 통과면 `APPROVE_PLAN` 정지 |
| internal `revise-plan` | accepted plan decisions | 새 bundle을 `supersedes` 등록, `PLAN_REVIEW/RUN_PLAN_REVIEW` |
| `[H] approve-plan --bundle-hash [--writer claude|codex]` | 계획 게이트 통과 | 미지정 시 policy default Claude, verifier=`opposite(writer)`, `writer_epoch=1` 잠금, `PLAN_APPROVED/RUN_WRITER`; dispatcher가 launch 직전 `IMPLEMENTING` |
| internal `run-writer` | `PLAN_APPROVED/RUN_WRITER` 또는 복구 중인 `IMPLEMENTING/RUN_WRITER` | 입력 hash·in-flight 저장 후 writer 실행; 완료 시 `IMPLEMENTING/HOST_CHECKPOINT`, 허용 복구 외 실패는 `NEEDS_HUMAN` |
| internal `checkpoint` | writer/fixer 완료, changed paths가 승인 map 안 | declarative file op 적용 후 source commit 또는 valid no-code empty commit 기록, `RUN_WRITER_TESTS` |
| internal `verify --scope writer` | 새 `head_sha` | pass면 writer manifest·logs와 `RUN_VERIFIER_TESTS`; normal fail면 예산 내 `RUN_FIX`; 비코드 실패면 `NEEDS_HUMAN` |
| internal `verify --scope verifier` | writer tests 성공 | pass면 exact-SHA independent manifest·logs와 `RUN_IMPL_REVIEW`; normal fail면 예산 내 `RUN_FIX`; 비코드 실패면 `NEEDS_HUMAN` |
| `review --phase implementation` | 두 manifest 유효 | 새 반대 모델 finding·AC assessment, `RUN_IMPL_DECISIONS` |
| internal `decide --phase implementation` | current impl review | accepted면 `IMPLEMENTING/RUN_FIX`; reject 재판정이면 `IMPL_REVIEW/RUN_IMPL_REVIEW`; 통과면 `READY_TO_MERGE/HOST_PUSH_BRANCH` |
| internal `host-push-branch` | `READY_TO_MERGE` | feature ref create/recorded FF update/adopt, `HOST_UPSERT_PR` |
| internal `host-upsert-pr` | feature ref exact | PR create/update/adopt, PR number/URL/head 저장; contract check가 있으면 `WAIT_PR_CHECKS`, 없으면 `PREPARE_MERGE` |
| internal `wait-pr-checks` | exact PR | persisted deadline 안 required checks poll; 성공 시 `PREPARE_MERGE` |
| internal `prepare-merge` | `READY_TO_MERGE`, checks 통과 PR | fixed refspec fetch·PR head/base 재확인; drift 없음이면 `APPROVE_MERGE`, drift면 `BASE_SYNC/HOST_BASE_SYNC` |
| internal `host-base-sync` | `BASE_SYNC`, sync budget 남음 | supervisor가 exact target SHA 비충돌 merge, 새 head/comparison base 기록, evidence stale, `IMPLEMENTING/RUN_WRITER_TESTS`, base-sync review track |
| `[H] approve-merge --head-sha --human-ac <record>` | fresh `prepare-merge`·GitHub checks/rules·기술 게이트·human AC 통과 | exact head+target/feature tip+PR/check/rule snapshot 승인, `MERGE_APPROVED/HOST_MERGE_PUSH` |
| internal `host-merge-push` | `MERGE_APPROVED` | exact local merge commit 검증 후 target에 explicit expected-SHA lease CAS, `CONFIRM_MERGED` |
| internal `confirm-merged` | target push/adopt 후 120초 이내 | fetched target+tree+direct parents와 PR merged/merge_commit_sha 확인, `MERGED/ARCHIVE`; deadline 불일치는 `NEEDS_HUMAN` |
| `[H] request-cursor-tiebreak --phase --fingerprints --reason` | `NEEDS_HUMAN`, current artifacts valid, tiebreak/total budget unused | `NEEDS_HUMAN/RUN_CURSOR_TIEBREAK`; 자동 재시도 없이 opinion 뒤 다시 `RESOLVE_HUMAN` |
| `[H] resolve --decision ... --reason ...` | `NEEDS_HUMAN/RESOLVE_HUMAN` | 저장된 resume state로 복귀, writer 교체, finding dismiss, abort 중 하나 |
| `[H] abort --reason` | 미완료 run | `ABORTED`; 기록 보존 |
| `status` / `recover` | 언제나 | 안전한 자동 복구, 현재 actor·pending action·정확한 재개 명령 출력 |
| `[H] recover --force` | 다른 host lock 등 자동 복구 불가 | 이유 기록 후 사람이 선택한 복구만 수행 |
| `archive` | `MERGED` 또는 `ABORTED` | 비밀 제거·최종 요약 후 `ARCHIVED` 또는 archive 완료 표시 |

`resolve` 세부 결정:

- `resume`: 러너가 저장한 `resume_state/resume_action`으로만 복귀한다.
- `switch-writer --writer claude|codex`: 기존 writer 세션을 종료하고 새 writer만 활성화한다. `writer_epoch`을 1 올리고 새 epoch의 implementation/base-sync review counter를 0으로 시작하며 verifier를 반대 모델로 갱신한다. provider 총상한과 run 단위 base-sync 횟수는 유지한다. 계획 승인 전 또는 CI·GitHub·host 실패에서는 writer 교체를 거부한다. checkpoint 전 `head_sha`가 없으면 `PLAN_APPROVED/RUN_WRITER`, test/review fix 입력이 있으면 `IMPLEMENTING/RUN_FIX`, 유효한 `head_sha`만 있으면 `IMPLEMENTING/RUN_WRITER_TESTS`로 복귀한다. current head는 보존하되 이전 epoch evidence/review는 stale이다.
- `dismiss-finding --fingerprint`: 사람 사유 필수.
- `request-cursor-tiebreak`: 교착 fingerprint를 고르는 사람 예외 행동이다. run당 한 번이고 Cursor 의견 자체는 finding disposition이나 resume 결정을 바꾸지 않는다.
- `abort`: `abort` 명령과 동일하다.

같은 run에서 contract를 수정하거나 `SPEC_DRAFT`로 되감는 명령은 없다. 계약 변경이 필요하면 현재 run을 `ABORTED/ARCHIVED`하고 새 contract로 `init --predecessor-run-id <old-run-id>`를 실행한다. 새 run만 `predecessor_run_id`를 기록하며 이전 산출물을 입력으로 자동 승계하지 않는다.

plan 또는 구현의 blocker/major reject는 “닫힘”이 아니다. 같은 plan reviewer의 2차 adjudication 또는 새 implementation verifier가 해당 fingerprint를 더 이상 재현하지 않을 때만 resolved가 된다. 최대 라운드 뒤에도 남으면 `NEEDS_HUMAN`이다.

exit code:

| 코드 | 의미 |
|---|---|
| 0 | 성공 |
| 2 | 잘못된 인자 |
| 3 | 불법 전이 또는 게이트 미충족 |
| 4 | 살아 있는 lock/in-flight 작업 |
| 5 | provider·runner 자체를 시작하거나 관측하지 못한 infrastructure failure |
| 6 | schema·hash·artifact 무결성 실패 |
| 10 | `NEEDS_HUMAN` |

contract test의 normal nonzero exit는 코드 5가 아니라 `fail` domain outcome이며 같은 supervisor 실행 안에서 예산이 있으면 `RUN_FIX`, 없으면 `NEEDS_HUMAN`으로 전이한다. 모든 exit code는 이미 원장에 기록된 상태 전이와 함께 반환한다.

---

## 5. 실제 루프

### A. 계약과 계획

1. 사람이 `init` 후 request와 contract를 `submit-contract`로 제출한다. supervisor가 safe Git baseline과 locked delivery endpoint로 정확한 `base_sha`를 고정하고 writer worktree를 만든 뒤 `SPEC_LOCKED/RUN_CURSOR_SCOUT`로 둔다.
2. supervisor가 exact `base_sha`의 disposable detached worktree에서 Cursor Repo Scout를 딱 한 번 실행한다. 결과가 available이면 schema-valid 원문을, auth/rate-limit/timeout/schema/worktree-mutation soft failure면 unavailable record를 등록한다. hard failure가 아니면 자동으로 `SPEC_LOCKED/RUN_PLANNER`를 거쳐 `PLANNING/RUN_PLANNER`로 간다.
3. supervisor가 Scout artifact를 포함한 stdin envelope로 Claude planner를 `claude -p --safe-mode --no-chrome --disable-slash-commands --no-session-persistence --strict-mcp-config --mcp-config <protocol/empty-mcp.json> --setting-sources user --settings <protocol/claude-restricted-settings.json> --permission-mode plan --tools "Read,Glob,Grep" --output-format json --json-schema <planner-output-schema-json>`으로 실행한다. `{plan_markdown, plan_map, scout_dispositions}`을 schema 검증한 뒤 plan/map을 각각 `PLAN_v1.md`, `PLAN_v1.map.json`으로 무손실 추출한다.
4. 같은 Scout 원문을 받은 새 ephemeral Codex 세션이 read-only로 적대 검토한다.

   ```powershell
   codex exec --ephemeral --ignore-user-config --ignore-rules --strict-config `
     --sandbox read-only -C <writer-worktree> --json `
     -c 'approval_policy="never"' `
     -c 'web_search="disabled"' -c 'project_doc_max_bytes=0' `
     --output-schema <absolute-review-schema> `
     -
   ```

5. 러너가 stdout JSONL과 invocation ID를 저장하되 resume에는 의존하지 않는다. `RUN_PLAN_DECISIONS`가 current bundle+review+Scout+evidence를 넣어 Claude를 read-only decision-maker baseline과 `decision.schema.json`으로 새로 호출한다.
6. accepted finding이 있으면 `RUN_REVISE_PLAN`이 prior bundle+review+decision+Scout를 넣어 Claude planner/reviser를 호출하고 새 plan+map bundle을 old hash의 `supersedes`로 등록한다. blocker/major reject면 revised 여부와 관계없이 2차 fresh ephemeral Codex adjudication에 최초 review, decision, current bundle을 모두 stdin으로 준다. 외부 세션 저장소·`resume`·`--last`는 쓰지 않는다. 계획 리뷰 총 2회 뒤에도 open/insufficient가 남으면 `NEEDS_HUMAN`이다.
7. 계획 게이트가 통과하면 사람이 정확한 `plan_bundle_hash`와 구현 writer를 같은 승인에서 확정한다. `--writer`를 생략하면 Claude, Codex를 고르면 verifier는 Claude가 된다. run 중 자동 writer 변경은 없고 이후 변경은 `NEEDS_HUMAN/switch-writer`뿐이다.

### B. 구현

8. writer worktree는 `submit-contract` 때 잠긴 `base_sha`에서 만들어져 있다. 모든 mapping이 N/A면 model 호출을 생략한다. 그 외에는 supervisor가 approved map에서 map 밖/forbidden `Edit|Write` deny와 map 안 allow만 가진 immutable `writer-settings-<bundle-hash>.json`을 생성·등록하고, writable path/parent reparse preflight를 통과시킨다. native Windows 기본 writer Claude는 stdin envelope를 받아 `claude -p --safe-mode --no-chrome --disable-slash-commands --no-session-persistence --strict-mcp-config --mcp-config <protocol/empty-mcp.json> --setting-sources user --settings <writer-settings-artifact> --permission-mode dontAsk --tools "Read,Edit,Write,Glob,Grep" --allowedTools <derived-map-tool-rules> --output-format json --json-schema <worker-result-schema-json>`으로 실행한다. Bash·PowerShell·Web·MCP·Agent·computer-use 도구는 context 자체에 없고, current worktree file tool만 허용한다.
9. writer가 끝나면 supervisor가 선언된 delete/move를 pre-turn hash와 map으로 검증·적용하고 전체 diff 경로를 승인 plan map과 대조한다. safe Git baseline으로 허용 경로만 stage해 tree를 만들고 journaled `commit-tree --no-gpg-sign → update-ref` CAS로 `head_sha`를 기록한다. hook 실행·writer 자체 commit·directory operation은 금지한다. all-N/A면 diff/file operation이 없음을 확인하고 deterministic same-tree empty commit을 기록하며, 실제 구현 위치가 있는데 no-change면 `NEEDS_HUMAN`이다.
10. `verify --scope writer`가 command마다 current writer epoch와 exact SHA의 fresh disposable worktree를 띄워 attempt를 기록하고 canonical manifest를 만든다. normal nonzero exit면 `fail` evidence를 `test_fix`로 writer에게 보내 새 checkpoint SHA를 만들고, 비코드 failure면 `NEEDS_HUMAN`이다. pass 뒤에만 verifier scope로 간다. canonical writer worktree에서는 test를 실행하지 않는다.

### C. 반대 모델 검증

11. verifier도 command마다 별도 fresh detached worktree와 sandbox worker로 같은 setup+test를 독립 실행한다. normal nonzero exit는 같은 test-fix 경로, source/allowed-generated 밖 mutation과 protocol/resource failure는 `NEEDS_HUMAN`이다. 두 scope가 전부 pass해야 구현 review를 시작한다.

12. `opposite(run.writer)`의 새 세션이 read-only로 전체 diff와 두 evidence manifest를 검토하고 AC별 assessment를 출력한다. 기본 writer가 Claude일 때의 Codex 호출 예시는 다음과 같다.

   ```powershell
   codex exec --ephemeral --ignore-user-config --ignore-rules --strict-config `
     --sandbox read-only -C <verifier-worktree> --json `
     -c 'approval_policy="never"' `
     -c 'web_search="disabled"' -c 'project_doc_max_bytes=0' `
     --output-schema <absolute-review-schema> `
     -
   ```

   writer가 Codex라면 supervisor는 exact diff와 등록 evidence를 stdin envelope에 넣어 새 Claude를 같은 safe-mode/empty-MCP/project-local-source-excluded baseline과 `--permission-mode plan --tools "Read,Glob,Grep" --output-format json --json-schema <review-schema-json>`으로 실행하고 `structured_output`을 findings 정본으로 추출한다. 두 경로 모두 모델은 테스트를 자가신고하지 않고 supervisor가 만든 evidence ID를 참조한다.

13. `RUN_IMPL_DECISIONS`이 current writer를 read-only decision-maker로 호출한다. accepted finding만 decision artifact와 함께 `RUN_FIX`에 전달하며, blocker/major reject도 fresh verifier 재판정이 필요하다. 새 commit은 항상 writer tests, verifier tests, 새 반대 모델 리뷰를 모두 다시 요구한다.
14. 2차 리뷰 후에도 막히면 `NEEDS_HUMAN`이다. 필요할 때만 Cursor를 read-only 타이브레이커로 1회 사용한다.

   ```powershell
   cursor-agent -p --mode plan --sandbox enabled --trust --output-format json `
     --workspace <verifier-worktree> `
     "Read .harness-input/<action-id>.json and return the requested independent verdict. Do not edit files."
   ```

   input file은 supervisor가 hash하고 실행 뒤 삭제한다. `--force`와 `--yolo`는 붙이지 않는다.

### D. 납품

15. `HOST_PUSH_BRANCH`는 최초 게시에 `<safe-git> push --no-verify --force-with-lease=refs/heads/harness/<run-id>: -- <remote> <head_sha>:refs/heads/harness/<run-id>`, 재게시에는 `last_published_head_sha`가 current head의 ancestor인지 확인한 뒤 expected 값을 그 SHA로 바꾼 explicit lease CAS를 쓴다. 이로써 ref 부재/create와 recorded tip/fast-forward update를 원자적으로 강제한다. remote가 exact current head인 경우에도 같은 run/action의 fsynced prior push intent가 있을 때만 crash 결과로 adopt하고, 그 밖의 collision/divergence는 `NEEDS_HUMAN`이다.
16. `HOST_UPSERT_PR`이 `gh -R <delivery.repository>`로 exact base/head의 open PR을 하나만 create/update/adopt한다. body file에 contract, plan bundle, decisions, `head_sha`, evidence hash를 넣고 PR number/URL/head OID와 `last_published_head_sha`를 기록한다. `required_pr_checks`가 비어 있으면 wait를 생략하고, 값이 있으면 exact `(name, workflow)`만 persisted 30분 deadline 안에서 기다린다. 선택적으로 Cursor Bugbot을 병합 직전 1회 사용하고, 실행 전 현재 과금 정책·spend limit을 확인한다.
17. checks 통과 뒤 `prepare-merge`가 locked fetch/push URL을 재검증하고 fixed refspec으로 target을 fetch한다. PR은 `-R <delivery.repository>`로 조회하고, `gh api`는 API version `2026-03-10`과 literal `repos/<owner>/<repo>/branches/<url-encoded-target>` 및 paginated `repos/<owner>/<repo>/rules/branches/<url-encoded-target>` endpoint를 사용한다. `protected=false`, complete rules=`[]`, exact checks, target ancestry를 재확인한다. drift가 있으면 `BASE_SYNC → IMPLEMENTING`을 거쳐 전체 증거·리뷰, feature fast-forward update, checks wait를 다시 수행한다.
18. drift가 없으면 사람이 human AC, `head_sha`, target/feature tip, PR open/head/base, required-check hash, protected/rules hash를 한 번에 승인한다. `HOST_MERGE_PUSH`는 commit 생성 전에 같은 locked Git/gh env로 이 snapshot 전체를 다시 조회한다. exact 일치할 때만 `<safe-git> commit-tree --no-gpg-sign <head-tree> -p <approved-target> -p <head>`로 journaled merge commit을 만들고 tree/direct-parent/ancestor를 검증한 뒤 `<safe-git> push --no-verify --force-with-lease=refs/heads/<target>:<approved_target_tip_sha> -- <remote> <merged_sha>:refs/heads/<target>`를 실행한다. target/check drift나 pending이면 approval을 폐기하고 prepare/wait로 되돌아가며, fail/cancel·PR head/base/open·feature ref·rule mismatch면 `NEEDS_HUMAN`이다. 성공 후 `CONFIRM_MERGED`가 5초 간격·최대 120초 동안 fixed fetch와 PR API를 조회해 target/tree/direct parents, `merged=true`, `merge_commit_sha=merged_sha`를 모두 확인한다.
19. archive 성공 후에만 worktree를 제거한다. confirm deadline 뒤 불일치는 target을 되돌리지 않고 `NEEDS_HUMAN`으로 보낸다.

---

## 6. Worktree와 Orca

### Git이 worktree 정본, Orca는 관찰자

- worktree 생성·branch 규칙은 Git CLI가 소유한다. Orca runtime 유무에 따라 branch 결과가 달라지지 않는다.
- writer branch는 `harness/<run-id>`, 경로는 `WORKTREE_HOME\<repo-id>\<run-id>\writer`다.

  ```powershell
  & <locked-git.exe> --no-pager -c core.hooksPath=<trusted-empty> -c core.fsmonitor=false `
    -c core.askPass= -c diff.external= `
    worktree add -b "harness/<run-id>" "<writer-path>" "<base-sha>"
  ```

- verifier는 `WORKTREE_HOME\<repo-id>\<run-id>\verifier-r<N>`의 detached checkout이며 push하지 않는다.

  ```powershell
  & <locked-git.exe> --no-pager -c core.hooksPath=<trusted-empty> -c core.fsmonitor=false `
    -c core.askPass= -c diff.external= `
    worktree add --detach "<verifier-path>" "<head-sha>"
  ```

- local writer branch가 이미 있으면 `run.json`의 repo ID·branch·worktree path·recorded SHA가 모두 일치할 때만 resume한다. 하나라도 다르면 branch collision으로 `NEEDS_HUMAN`이다.
- 모든 Git network action은 `resolved-delivery.json`의 fetch/push URL과 dangerous-config/credential-helper fingerprint를 직전에 재검증한다. feature branch는 empty expected SHA로 최초 부재를, recorded `last_published_head_sha`로 재게시 tip을 explicit lease CAS하며 local fast-forward도 확인한다. target은 승인된 tip을 explicit lease CAS한다. 이 세 exact expected-value lease 외의 plain `--force`, implicit/unknown expected lease, `+refspec`은 모든 ref에서 금지한다.
- Orca는 등록한 repo의 Git worktree를 관찰·열고 터미널/diff를 제공한다. Orca가 worktree를 표시하지 못해도 Git path에서 run은 계속된다.

### Orca 최초 설정

1. 서명된 안정 버전으로 `orca open` 후 `orca status --json` 성공을 확인한다.
2. **Settings → Agents → Agent Permissions → Manual**로 변경한다.
3. agent별 custom arguments에 남은 `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo`를 제거한다. custom override는 global Manual 전환에서 보존될 수 있다.
4. 기존 Claude·Codex·Cursor 구독 로그인을 재사용한다.
5. Orca 저장소 기본 ref는 contract의 `<delivery.remote>/<target_ref>`로 등록하되, 실제 run worktree는 `base_sha`에서 만든다.

   ```powershell
   orca repo add --path <repo> --json
   orca repo set-base-ref --repo path:<repo> --ref <delivery.remote>/<target_ref> --json
   ```

6. 공식 문서상 Experimental인 Orca orchestration은 v1에서 끈다. 버전 업그레이드 후 Manual 설정, custom args, exact-SHA worktree 생성만 스모크 테스트한다.

Smart App Control이 차단해도 하네스가 자동으로 Windows 보안 기능을 끄지 않는다. 최신 서명 안정 빌드와 게시자를 먼저 확인하고, 해제는 별도 사람 결정이다.

Orca에서 쓰는 기능은 worktree 관제, 터미널 pane, usage 표시, diff viewer/Annotate AI Diff, session restore, 모바일 관찰뿐이다. **Orca 완전 종료 상태에서 복구·완료 가능한지**를 파일럿에서 검증한다.

---

## 7. 자동화와 권한 경계

자동화의 뜻은 모든 권한 해제가 아니다. **경계 안에서는 묻지 않고 진행하고, 경계 밖 행동은 거부하거나 `NEEDS_HUMAN`으로 보낸다.**

### 구독 인증 강제

- supervisor는 parent env를 그대로 넘기지 않고 child 종류별 allowlist env를 만든다. 공통으로 API key/token/base-URL/provider override를 제거하고 사용자 profile·공식 credential store 접근에 필요한 최소 변수, 잠긴 CLI/System32 경로, action 전용 temp만 전달한다. auth preflight와 실제 child는 byte-for-byte 같은 env profile을 쓴다.
- Claude profile은 `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`와 cloud-provider credential/endpoint override를 unset한다. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`, `CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1`, `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`, `MAX_STRUCTURED_OUTPUT_RETRIES=1`을 hash-locked env profile에 둬 background update/telemetry/title model call, non-stream fallback, unbounded structured retry를 막는다. 매 invocation 직전 `claude auth status --json`이 `loggedIn=true`, `authMethod=claude.ai`, `apiProvider=firstParty`, `subscriptionType=max`인지 확인하고 redacted 결과 hash만 기록한다.
- Codex profile은 `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, `CODEX_API_KEY`, Azure/OpenAI provider override를 unset한다. 같은 env의 `codex login status`가 정확히 ChatGPT 로그인을 보고해야 한다.
- Cursor profile은 `CURSOR_API_KEY`와 provider/API override를 unset하고 같은 env의 `cursor-agent status` exit 0과 subscription login success를 확인한다. Scout의 로그인/auth·rate-limit·timeout·schema-invalid·Scout worktree 내부 변경은 soft unavailable이며, 경계 밖 변경·clean-env·protocol·ledger 위반은 `NEEDS_HUMAN`이다. 타이브레이커 실패는 자동 재시도 없이 사람 resolve로 돌아간다.
- GitHub/Git credential profile은 `GH_TOKEN`, `GITHUB_TOKEN`, enterprise token, `GH_HOST`, `GH_REPO` override를 unset하고 `GH_PROMPT_DISABLED=1`을 둔다. `gh auth status --active -h github.com` exit 0과 `gh repo view -R <delivery.repository>` identity를 실제 `gh`/credential-helper 호출 직전에 재확인한다.
- preflight 실패 시 API-key/다른 provider/다른 GitHub repo로 fallback하지 않는다. Cursor Scout의 명시된 soft failure만 unavailable로 계속하고 나머지는 `NEEDS_HUMAN`이다. token 원문, email, org ID는 artifact/log에 저장하지 않는다.

### Codex on Windows

```toml
[windows]
sandbox = "elevated"
```

`elevated`는 agent 명령에 관리자 자유 권한을 주는 모드가 아니다. 초기 설정에 관리자 승인이 필요할 수 있지만 실제 명령은 전용 저권한 사용자, ACL, 방화벽 경계를 쓰는 더 강한 Windows sandbox다.

- 현재 PC의 사용자 기본값은 `workspace-write + unelevated`지만 test worker는 사용자 config를 무시하고 invocation마다 `elevated`, `approval_policy=never`, network off, 빈 추가 writable roots, worktree 내부 temp를 강제한다. 첫 실행의 관리자 setup과 hardened smoke test가 실패하면 자동 실행하지 않고 `NEEDS_HUMAN`이다.
- 계획 reviewer는 `read-only`.
- 구현 테스트는 Codex `elevated + workspace-write` sandbox의 전용 test worker가 실행한다. supervisor와 반대 모델 reviewer는 model-modified code를 직접 실행하지 않는다.
- 사람이 Codex를 writer로 선택한 run도 test worker와 같은 `--ephemeral --ignore-user-config --ignore-rules --strict-config --sandbox workspace-write -C <writer-worktree>` baseline을 쓴다. `approval_policy=never`, `windows.sandbox=elevated`, network false, 빈 writable roots, worktree temp, clean shell env, `web_search=disabled`, `project_doc_max_bytes=0`을 모두 강제하고 worker-result schema와 stdin envelope를 사용한다. writer의 임의 dependency 설치는 `NEEDS_HUMAN`이며 contract에 잠긴 supervisor-run offline setup만 test disposable worktree에서 허용한다.
- `danger-full-access`와 bypass flag는 v1의 모든 실행 환경에서 금지한다.
- `trusted-repo`는 쓰기·network 경계를 위한 v1 기본값이며 host 읽기 기밀성이 필요한 run은 `UNSUPPORTED_IN_V1`이다.

### Claude Code

- Orca Manual로 bypass flag 주입을 막는다.
- Claude Code의 OS sandbox는 macOS·Linux·WSL2만 지원하고 native Windows는 지원하지 않는다. native writer에 sandbox가 있다고 가정하지 않는다.
- 모든 supervisor-launched Claude는 safe mode, `--setting-sources user`로 project/local source 제외, strict empty MCP config, no Chrome/slash commands/session persistence와 supervisor-owned immutable settings를 강제한다. safe mode로 user customization도 비활성화해 project/local `.claude`, `CLAUDE.md`, hook, plugin, MCP가 실행되지 않게 한다.
- planner, reviser, decision maker, verifier는 `plan` + `Read,Glob,Grep`만 쓴다. native writer는 approved map에서 결정적으로 생성한 allow와 map 밖/forbidden explicit deny settings, `dontAsk` + `Read,Edit,Write,Glob,Grep`만 쓴다. writer 실행 전/후 no-follow reparse 검사를 반복하고, shell·Web·MCP·Agent·computer-use는 `--tools`에서 제거한다.
- `orca`, `harnessctl`, credential/approval 경로, network 명령, 테스트, Git commit은 writer가 호출할 수 없다. 테스트는 Codex sandbox worker, stage/commit은 supervisor가 담당한다. 비허용 동작은 질문 없이 거부되고 supervisor가 `NEEDS_HUMAN`으로 올린다.
- v1은 native permission boundary를 `trusted-repo`에만 사용한다. Claude process 전체를 격리하는 strong backend는 v2에서 별도 결정하며 WSL2 Bash sandbox만으로 strong을 선언하지 않는다.
- `bypassPermissions`와 `--dangerously-skip-permissions`는 호스트에서 금지한다.

### Cursor

- Repo Scout와 타이브레이커는 `--mode plan --sandbox enabled --trust --output-format json`; `--force`/`--yolo` 없음.
- Repo Scout는 모든 run에서 계획 전에 exact `base_sha` disposable worktree를 한 번 조사한다. verdict 없이 기존 helper·영향 위치·테스트 지점·실패 시나리오 위험·unknown만 제시하며 Claude와 Codex가 같은 원문을 독립 판단한다.
- Scout와 타이브레이커는 각각 최대 1회, 합계 최대 2회다. 어느 쪽도 자동 재시도하지 않고 source·finding disposition·state를 직접 바꿀 수 없다.
- 구현 writer로 승격하는 기능은 v1 범위 밖이다.

---

## 8. 이 PC의 준비 상태 — 2026-07-16 재확인

- [x] Node 24.18.0
- [x] Git 2.54.0.windows.1 — host action은 `C:\Program Files\Git\mingw64\bin\git.exe` canonical path·SHA-256을 protocol에 잠금
- [x] Claude Code 2.1.201 — 구독 로그인
- [x] Codex CLI 0.143.0 — `Logged in using ChatGPT`
- [x] Cursor Agent 2026.07.09-a3815c0 — `Login successful`
- [x] Orca CLI 설치 — 재부팅 후 runtime은 현재 정지 상태
- [x] GitHub CLI 2.95.0 설치
- [x] `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CURSOR_API_KEY` 미설정
- [ ] GitHub CLI 재인증 — 현재 keyring token invalid; `gh auth refresh -h github.com` 후 `gh auth setup-git`
- [ ] `HARNESS_HOME`, `WORKTREE_HOME` 생성과 저장공간 정책 확정
- [ ] reviewed `HarnessJob.cs`를 system Windows PowerShell `Add-Type`로 1회 빌드하고 exe/source hash 잠금; nested process, memory, kill-on-close 스모크 테스트
- [ ] supervisor console nonce, child console 비상속, human-only 행동 스모크 테스트
- [ ] API/token/provider/GH override sentinel을 parent env에 넣어도 child env에서 제거되고 Claude=Max, Codex=ChatGPT, Cursor=subscription, gh=stored github.com login만 선택되는지 확인
- [ ] Codex `[windows] sandbox = "elevated"` 전환·스모크 테스트 — 현재 `unelevated`
- [ ] hardened test-worker argv와 `trusted-repo` profile 스모크 테스트
- [ ] infinite stdout/stderr, process fan-out, memory pressure sentinel이 각각 `output_limit`/`resource_limit`으로 종료되고 bounded log만 남는지 확인
- [ ] supervisor-launched Claude의 project hook/plugin/MCP 미실행·file-only tool set 스모크 테스트
- [ ] base config/attributes의 hook, filter, merge/diff driver, fsmonitor sentinel이 safe Git preflight에서 거부되고 `post-checkout`·`post-merge`·`pre-push` side effect가 0인지 확인
- [ ] plan map writable path/부모의 symlink·junction sentinel이 writer 실행 전에 거부되는지 확인
- [ ] 파일럿 저장소가 merge queue/signing 없이 explicit expected-SHA lease target 갱신을 허용하는지 확인
- [ ] Orca 실행 후 Agent Permissions=Manual·custom bypass args 제거 확인
- [ ] (선택, 수동 대화용) Claude Code용 Codex 플러그인 설치 — harness child는 safe mode라 이 plugin을 로드하지 않음

  ```text
  /plugin marketplace add openai/codex-plugin-cc
  /plugin install codex@openai-codex
  /reload-plugins
  /codex:setup
  /codex:setup --disable-review-gate
  ```

- `claude --bare`는 사용하지 않는다. 현재 bare 모드는 OAuth·키체인을 읽지 않아 구독 인증과 맞지 않는다.
- 로그인 오류가 실제로 날 때만 `codex login status`, `cursor-agent status`, Claude 로그인을 확인한다. 고정 토큰 만료 일수는 가정하지 않는다.
- 사용량 창은 플랜·계정·제품에 따라 달라질 수 있으므로 갱신 주기는 가정하지 않는다. 현재 usage 표시와 contract의 provider별 호출 상한을 함께 쓰며 모든 시작된 child 호출을 원장에 센다.

---

## 9. 도입 순서와 합격 테스트

| 단계 | 구현 | 승격 조건 |
|---|---|---|
| 1. 최소 end-to-end | control root, schemas, host `harnessctl`, agent/test-worker 실행·staging 캡처, read-only `/harness`, supervisor-console 사람 승인 | 아래 합격 테스트 전부 통과 |
| 2. 반복 최적화 | prompt template, batch review, usage·알림, archive 정리 자동화 | 사람 게이트와 신뢰 경계가 그대로 유지됨 |
| 3. 관제 고도화 | Orca pane·diff·usage 연동 | Orca 없이도 동일 run 완료 가능 |
| 보류 | Orca orchestration 재평가 | Experimental 해제와 별도 disposable pilot 통과 |

첫 파일럿은 테스트가 있는 작은 실제 과제 1개다.

합격 조건:

1. `SPEC_LOCKED/RUN_CURSOR_SCOUT`, Scout 완료 뒤 planner 전환, 계획 리뷰 대기, test worker 실행 전, 구현 리뷰 대기에서 process/PC 종료 후 동일 state, actor, pending action, input hash를 복구한다. Scout interruption은 unavailable로 한 번만 닫고 재호출하지 않으며, 다른 비사람 action은 정의된 복구 규칙으로 자동 재개한다.
2. control root가 writer/verifier worktree 밖 하나뿐이며 두 모델이 원장이나 `harnessctl`을 실행·수정할 수 없다.
3. child가 supervisor console·nonce를 받지 않는다. 정상 run의 nonce 승인은 plan bundle과 head SHA에 묶인 2회뿐이며 실제 console 재입력만 성공한다.
4. writer는 `harness/<run-id>` branch의 exact `base_sha`, verifier는 exact `head_sha` detached checkout에서 만들어진다. feature ref는 empty/recorded expected-SHA lease로 최초 create 또는 current head까지의 local-verified fast-forward만 허용하고 다른 collision/divergence는 `NEEDS_HUMAN`이다.
5. test worker argv에 `--ignore-user-config`, `--strict-config`, `approval_policy=never`, elevated sandbox, shell/network off, web search disabled, project docs 0, 빈 writable roots, worktree temp가 모두 적용된다. worktree 밖 쓰기와 모든 network smoke test는 실패해야 한다.
6. `host_read_confidentiality_required=true`, untrusted source, strong-isolation 요청은 `UNSUPPORTED_IN_V1`로 contract 잠금 전에 거부된다.
7. C: staging 출력은 schema/hash 검증 뒤 D: txn으로 copy·fsync·rehash되고 D: 내부 atomic rename 전까지 게이트 입력이 되지 않는다.
8. 모든 protocol/contract/plan/map/review/decision/diff/manifest/log/approval의 ledger hash를 다시 계산한다. artifact 등록 각 단계에서 강제 종료해도 uncommitted tail/orphan만 격리되고 committed head는 유지된다.
9. 전이표에 없는 state/action, 동시 명령, stale lock, 깨진 event, 중단된 in-flight를 거부·복구한다. PID 재사용 시 start time 불일치 process를 kill하지 않는다.
10. inline shell·환경변수 상속·secret env·상대 executable을 contract가 거부하고, 실행 직전 wrapper/executable/script와 host `git.exe` hash가 바뀌면 command를 시작하지 않는다.
11. plan map과 plan review에 모든 AC가 정확히 한 번 있고 mapping이 contract와 일치하며 모든 assessment=pass여야 bundle을 승인할 수 있다.
12. decision maker와 reviser의 schema-valid artifact로 revised plan+map bundle이 `supersedes` 관계로 보존되고 `PLANNING → PLAN_REVIEW`로 정상 복귀한다. 2차 리뷰는 첫 세션 resume 없이 전체 prior artifact를 받은 fresh invocation이다.
13. 근거 없는 blocker/major는 `needs_evidence`가 되며, blocker/major reject는 fingerprint별 2차 assessment 없이 닫히지 않는다.
14. provider별 run 상한, Cursor Scout/tiebreak/total 상한, evidence-key별 test-worker 상한을 넘는 호출은 시작되지 않는다. pass/fail/timeout은 자동 재시도되지 않고, 허용된 model/test interruption만 action별 1회와 남은 budget 안에서 재시도된다. Cursor 두 역할과 host mutation은 각각 자동 재시도 0, journal reconciliation 외 blind retry 0이다.
15. `(writer_epoch, scope, head_sha, command_id)`당 canonical manifest가 최대 하나뿐이다. 중단 attempt는 독립 artifact로만 남고 recovery 성공 manifest가 모든 attempt ID와 final attempt를 참조한다. contract에서 역산한 `ac_ids[]`, runner/config/log hash, exit code, 반대 모델 assessment가 일치해야 command AC가 통과하며 requested check는 같은 evidence key를 재사용한다.
16. human AC는 merge 승인 record가 없으면 통과하지 않는다.
17. writer 수정 후 이전 evidence/review가 stale이 되고 새 `head_sha`에서 writer tests, verifier tests, fresh review가 실행된다.
18. verifier가 허용 경로 밖 source를 바꾸면 검증이 무효가 되고 delivery branch에는 어떤 변경도 들어가지 않는다.
19. `NEEDS_HUMAN → resume/switch-writer/dismiss/abort`가 각각 원장에 남고 허용 state/action으로만 복귀한다. 같은 run의 계약 수정이나 `SPEC_DRAFT` rewind는 존재하지 않으며, 계약 변경은 old run `ABORTED/ARCHIVED` 후 `predecessor_run_id`를 가진 새 run으로 시작한다.
20. target branch `protected=false`, complete applied rules=`[]`인 경우에만 승인 target tip과 head로 tree=head tree, direct parents=`[target, head]`인 local `merged_sha`를 만들고 exact expected-SHA lease CAS한다. protected=true, non-empty rules, API 오류, 권한 부족, 불완전 pagination은 각각 target을 바꾸지 않고 `NEEDS_HUMAN(reason=UNSUPPORTED_IN_V1)`인지 검증한다. push 뒤 fetched target/tree/parents와 PR `merged=true`, `merge_commit_sha=merged_sha`를 5초 간격·120초 안에 모두 확인해야 archive하며 불일치 시 rollback 없이 `NEEDS_HUMAN`이다. default/non-default target 모두 같은 direct-parent 규칙을 쓴다.
21. 호스트에서 danger-full-access가 한 번도 쓰이지 않는다.
22. Orca 종료 상태에서도 run을 복구·검증·archive할 수 있다.
23. run의 protocol snapshot만으로 재개하고 외부 model session 저장소는 없어도 된다. 현재 CLI/Git executable/protocol drift가 있으면 자동 migration 없이 `NEEDS_HUMAN`이다.
24. model-modified `.claude/settings.json`, hook, plugin, MCP sentinel을 넣어도 supervisor-launched Claude의 tool set·process 목록·network에 나타나지 않는다. approved writable path나 부모가 symlink/junction이거나 path가 `.GIT`, `.git.`, `x/../.git`, ADS 형식이면 writer 실행 전에 거부한다.
25. remote 이름 option injection, fetch/push URL 다중값, SSH/git/file URL, rewrite·`pushurl`·remote-helper·embedded credential sentinel을 거부하고 HTTPS URL 둘을 같은 contract repository로 canonicalize한다. 모든 network Git action은 hash-locked raw URL을 직전 재검증한다. repo-targeted GitHub 명령·PR 변경은 `gh -R <delivery.repository>`, `gh api`는 version-locked literal `repos/<owner>/<repo>/...`만 사용하며 push·PR·target merge는 recorded SHA만 사용한다.
26. `run|resume`은 `[H]`, `NEEDS_HUMAN/RESOLVE_HUMAN`, terminal state 외에는 멈추지 않으며 `NEEDS_HUMAN/RUN_CURSOR_TIEBREAK`도 자동 dispatch한다. 각 model input/output은 stdin envelope 또는 Cursor input artifact와 schema로 왕복한다.
27. review 뒤 `RUN_*_DECISIONS` actor/argv/input/schema가 결정적이며 accepted/rejected/needs-human 각 분기가 전이표와 정확히 일치한다.
28. file delete/move는 map 양쪽 path와 pre-turn hash가 맞는 regular file만 적용된다. overwrite·directory op·reparse 이탈은 실패한다. all-N/A는 writer 없이 same-tree one-parent empty checkpoint commit을 만들어 end-to-end PR 경로까지 통과한다.
29. base sync 뒤 remote feature tip=`last_published_head_sha`에서 current head로의 explicit lease+fast-forward 재게시가 성공하고, 다른 remote tip은 원자적으로 거부된다.
30. contract `required_pr_checks=[]`는 wait를 생략한다. non-empty이면 exact `(name, workflow)`의 pass/skipping, 누락, pending→pass, fail/cancel, extra check, transient 3회, 30분 timeout, polling 중 재부팅을 각각 기대 상태로 처리한다.
31. checkpoint commit, base sync, feature push, PR create/update, target lease push의 side effect 직후 강제 종료해도 exact post-state는 adopt, exact pre-state는 한 번 재시도, 다른 상태는 `NEEDS_HUMAN`이다. base sync의 ref=new/index=old intermediate는 materialize만 재개하고 최종 HEAD tree=index tree·clean을 확인한다.
32. base repo에 `post-checkout`·`post-merge`·`pre-push`, external filter/merge/diff driver, fsmonitor, hostile `commit.gpgSign=true`+`gpg.program`, ambient SSH/askpass/`GIT_EXEC_PATH` helper sentinel을 둬도 host에서 실행되지 않는다. TLS-disable env/config와 proxy/custom CA는 제거·거부되고 잠긴 `git-remote-https.exe`만 실행된다. 모든 push에 `--no-verify`, 모든 commit-tree에 `--no-gpg-sign`가 있다.
33. writer 교체는 계획 승인 전·CI·GitHub·host 실패에서 거부된다. 허용 교체는 새 epoch의 implementation/base-sync review counter만 초기화하고 run 단위 base-sync/provider budget을 유지하며, checkpoint 전이면 `RUN_WRITER`, fix 입력이 있으면 `RUN_FIX`, 유효 head만 있으면 `RUN_WRITER_TESTS`로 정확히 복귀한다.
34. parent에 API key/auth token/base URL/cloud provider/GH token/repo override sentinel을 넣어도 child auth preflight와 실제 호출은 같은 clean env에서 Claude Max·Codex ChatGPT·Cursor subscription·stored GitHub login만 사용하며 다른 과금 경로로 fallback하지 않는다. Cursor Scout auth/rate-limit failure만 unavailable로 계속하고 다른 clean-env 위반은 `NEEDS_HUMAN`이다.
35. slug의 `..`, slash/backslash, colon, trailing dot/space, reserved name, uppercase/Unicode, 33자 이상을 거부한다. valid slug의 동시 두 run도 서로 다른 CSPRNG suffix를 받아 path/ref-format·collision 검사를 통과하고, remote branch/PR marker가 교차 adopt되지 않는다.
36. infinite stdout/stderr, active-process 초과, memory 초과 child를 Job Object가 전체 종료하고 각각 `output_limit`/`resource_limit` 실패로 기록한다. PC/parent 종료 때 kill-on-close가 남은 tree를 제거하며 초과 로그는 bounded prefix+byte count+stream digest만 남는다.
37. `cursor-scout`, `test-result`, `execution-attempt`, `execution-manifest`를 포함한 provider/host record가 schema-invalid, extra property, unknown enum, duplicate/unknown ID를 반환하면 node_modules 없는 local generated validator+invariant 검사가 거부한다. checked-in canonicalizer는 객체 key 정렬·배열 순서 보존·safe integer·UTF-8를 결정적으로 재현하고 schema/validator/canonicalizer hash mismatch는 child 실행 전에 실패한다. Markdown·diff·log는 원본 bytes hash가 유지된다.
38. plan 승인에서 writer 미지정은 Claude/Codex verifier, `--writer codex`는 Codex/Claude verifier로 각각 epoch 1에 잠기며 추가 승인 없이 두 end-to-end 경로가 동작한다.
39. hostile push signing/followTags/recurseSubmodules/pushOption/mirror config와 reachable tag/submodule을 넣어도 push는 expected lease의 branch ref 하나만 바꾸고 외부 gpg/hook을 실행하지 않는다. fetch는 exact unique temp ref 하나만 만들었다가 지우며 tag, FETCH_HEAD, submodule endpoint, maintenance를 건드리지 않는다. PREPARED/FETCHED/CONSUMED/DELETED 각 phase kill 뒤 exact ref/OID를 adopt·CAS-delete해 재개한다.
40. 작은 Node fixture가 hash-locked package manager+lockfile+read-only offline cache setup을 각 disposable command worktree에서 수행한 뒤 network 없이 test를 통과한다. cache miss/setup failure는 fixer가 아니라 `NEEDS_HUMAN`이다.
41. writer edit, 각 declarative delete/move syscall, test source/generated mutation 직후 kill에서 partial diff를 recovery에 보존하고 journal phase로 exact pre/post를 adopt·재개하거나 canonical writer를 pre-turn으로 recreate한다. normal writer/verifier test fail은 fail artifact→fixer→새 SHA→양 scope pass로 전이하며 같은 evidence key를 재실행하지 않는다.
42. 매 run 계획 전에 Cursor Scout가 exact `base_sha`에서 한 번 실행되고 available이면 모든 item이 Claude planner에서 incorporated/rejected되며 같은 원문을 Codex가 받는다. soft failure와 worktree 내부 변경은 unavailable 후 계속하고 경계 밖·protocol·ledger 위반은 `NEEDS_HUMAN`이다. 교착 타이브레이커는 별도 1회이며 성공/실패 모두 `NEEDS_HUMAN/RESOLVE_HUMAN`으로 돌아간다. Cursor는 code·finding disposition·state를 직접 바꾸지 못한다.

---

## 10. 확정 결론

- 새 IDE를 만들지 않는다.
- Orca를 사용하되 관제판으로 제한한다.
- 최초 버전부터 host-side deterministic supervisor를 둔다. 상태 전이와 사람 승인을 agent 프롬프트에 맡기지 않는다.
- 기본 writer는 Claude, 기본 adversarial reviewer와 구현 verifier는 Codex다.
- Cursor는 모든 run의 계획 전 Repo Scout와 교착 시 read-only 타이브레이커다. 두 역할은 각각 최대 1회이며 writer나 판정자가 아니다.
- 자동화는 `control-root/staging 격리 + sandbox test worker + writer allowlist + supervisor-console 사람 게이트 2회`로 달성한다.

---

## 참고 근거

- Orca agent 권한 기본값·Manual 전환: https://www.onorca.dev/docs/agents/supported
- Orca orchestration Experimental: https://www.onorca.dev/docs/cli/orchestration
- Codex Windows sandbox: https://learn.chatgpt.com/docs/windows/windows-sandbox
- Codex approvals·sandbox: https://learn.chatgpt.com/docs/agent-approvals-security
- Claude Code permissions: https://code.claude.com/docs/en/permissions
- Claude Code permission modes: https://code.claude.com/docs/en/permission-modes
- Claude Code sandbox OS support: https://code.claude.com/docs/en/sandboxing
- Codex Claude Code plugin: https://github.com/openai/codex-plugin-cc
- Cursor CLI parameters: https://docs.cursor.com/en/cli/reference/parameters
- Git push/explicit lease/`--no-verify`: https://git-scm.com/docs/git-push
- Git remote URL resolution: https://git-scm.com/docs/git-remote
- Git hooks: https://git-scm.com/docs/githooks
- Git attributes/filter/merge/diff drivers: https://git-scm.com/docs/gitattributes
- Git commit-tree signing control: https://git-scm.com/docs/git-commit-tree
- GitHub CLI required checks: https://cli.github.com/manual/gh_pr_checks
- GitHub branch API: https://docs.github.com/en/rest/branches/branches?apiVersion=2026-03-10
- GitHub repository rules API: https://docs.github.com/en/rest/repos/rules?apiVersion=2026-03-10
- GitHub pull request merge behavior: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges
- Microsoft Smart App Control FAQ: https://support.microsoft.com/en-US/Windows/Security/threat-malware-protection/smart-app-control-frequently-asked-questions
