# Claude `/pingpong` 진입점 설계

## 목표

Orca의 현재 프로젝트에서 Claude Code를 열고 `/pingpong <작업>`만 입력하면 요구사항 확인부터 기존 계획 핑퐁 runner까지 이어진다. 사용자는 Node 명령이나 run ID를 외우지 않는다.

## 역할

- Claude 개인 Skill: 한국어 대화와 사용자 진입만 담당한다.
- `harness.mjs`: run 생성, provider 호출, 상태 전이와 증거 저장을 계속 독점한다.
- `launcher.mjs`: 저장된 run의 복구·관리용 fallback만 담당한다.
- Orca: Claude 탭, runner 터미널, worktree와 diff를 보여주는 관제 화면이다.

Skill과 launcher는 `.harness` 파일을 직접 수정하거나 자체 상태머신을 만들지 않는다.

## 새 작업

1. `/pingpong`에 인수가 없으면 첫 응답은 `무슨 작업을 계획할까요?` 한 문장뿐이다. 저장소·커밋·기존 run을 먼저 조사하지 않는다.
2. 작업 설명이 들어오면 필요한 경우에만 한국어 질문을 한 번에 하나씩 한다.
3. 요구가 충분히 명확해지면 현재 Git root를 확인하고 목표·제외 범위·완료 기준·검증 명령을 `최종 SPEC 요약`으로 보여준다.
4. 새 작업 진입부터 사용자가 이 요약을 명시적으로 승인할 때까지 현재 Claude의 직접 대화·읽기 전용 조사만 허용하며, 임시 파일·Cursor Scout·provider·subagent를 호출하지 않는다. 수정 요청이면 SPEC 요약을 고쳐 다시 승인받는다.
5. 승인 뒤 `$env:TEMP`에 `SPEC.example.md` 형식의 임시 SPEC을 만들고 기존 `harness.mjs start --repo <root> --spec <file>`만 호출한다. runner 반환 뒤 임시 파일을 삭제하며 `.harness`에는 직접 쓰지 않는다.
6. 이 명령이 Cursor Scout, Claude 계획, Codex 검토와 Claude 수정을 수행한다.
7. `AWAIT_PLAN_APPROVAL`이면 `D:/codex-projects/agent-harness/.harness/runs/<runId>/<currentPlanPath>`에서 최종 PLAN을 읽고 SHA와 함께 사용자에게 보여준 뒤 승인·보완·취소 중 하나를 명시적으로 받는다.
8. 승인 시 Skill은 exact SHA를 넣은 기존 `approve-plan` 명령만 호출한다.

현재 runner 코드의 자동 범위는 계획 승인까지다. `approve-plan` 이후 `IMPLEMENT_LOOP` 구현은 별도 단계이며, Skill은 구현이 실행됐다고 과장하지 않는다.

## 기존 작업

`/pingpong resume` 또는 명시적인 이어가기 요청만 복구 경로로 취급한다. Skill은 Orca에 복구용 launcher 터미널 하나를 연다. launcher는 저장된 run을 표시하고 사람이 고른 기존 runner 명령 하나만 호출한다.

## 안전 규칙

- Skill은 `disable-model-invocation: true`로 사람이 직접 호출할 때만 시작한다.
- 최종 SPEC 요약에 대한 명시적 승인 전에는 임시 SPEC 생성, Cursor Scout, provider, subagent 호출을 하지 않는다.
- 여러 run 중 하나를 자동 선택하지 않는다.
- 사람 승인 문구 없이 계획을 승인하지 않는다.
- `allowed-tools`나 permission bypass를 추가하지 않는다.
- API 키 인증, Orca orchestration, 자동 merge를 추가하지 않는다.

## 검증

- canonical Skill 테스트: 무인자 질문, `$ARGUMENTS`, `start`, `resume`, 임시 SPEC, PLAN 절대 경로, 상태 소유권 규칙이 존재하며 새 작업이 `launcher.mjs`로 가지 않는다.
- launcher 테스트: 새 작업을 시작하지 않고 복구 안내만 제공한다.
- 전체 Node 테스트와 `git diff --check`가 통과한다.
- 설치된 개인 Skill이 canonical 파일과 byte-for-byte 동일하다.
