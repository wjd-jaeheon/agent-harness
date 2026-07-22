# agent-harness 실행 설계 v2.0

> Claude가 계획하고 Codex가 구현한다.
> Claude와 Codex는 파일 산출물을 통해 서로 검토하고, 사람은 Orca에서 승인·예외·머지를 조작한다.
> 상태와 증거는 파일에 남고 Node foreground runner가 사람 게이트까지 자동 진행한다.

## 0. 결론

v2.0의 구조는 다음으로 고정한다.

| 역할 | 담당 | source 수정 |
|---|---|---|
| 계획 작성·수정 | Claude | 금지 |
| 계획 적대 검토 | Codex | 금지 |
| 구현·재구현 | Codex | 허용 — 유일한 Writer |
| checkpoint·최종 코드 리뷰 | Claude | 금지 |
| 저장소 사전 조사·제3 의견 | Cursor CLI | 금지, Scout 1회 + 조건부 감사 1회 |
| 상태 전이·호출·증거 저장 | Node runner | source 수정 금지 |
| 승인·예외·최종 머지 | 사람 | Orca에서 조작 |
| worktree·터미널·diff 관제 | Orca | 완료 판정자가 아님 |

핵심 불변 조건:

- Codex만 source를 수정한다. Claude와 Cursor는 계획·review·Scout 산출물만 작성한다.
- runner가 루프와 상태를 소유한다. 모델이 다음 단계를 선택하지 않는다.
- 사람 확인은 핑퐁 시작 전 SPEC 승인, 최종 계획 승인, GitHub 머지 세 번이다. SPEC 승인은 run 생성 전 대화 게이트이고 나머지 둘만 runner 상태 게이트다.
- Orca가 종료돼도 파일 원장으로 재개할 수 있다.
- v1.9는 docs/full-spec-v1.9.md에 방어 후보 카탈로그로 보존한다.

로드맵:

    v2.0  계획·구현·checkpoint 리뷰·최종 검증 자동화
      ↓
    v2.1  branch push·PR 생성
      ↓
    v2.2  CI 확인·실패 복구
      ↓
    v3.0  조건부 자동 머지·장시간 무인 실행

## 1. v2.0 계약

### 위협 모델

신뢰한 내 저장소에서 다음 모델 실수를 줄인다.

- 요구사항·설계 누락
- 계획과 구현의 불일치
- 승인 범위 밖 파일 수정
- 테스트 누락 또는 실패 은폐
- 리뷰 finding의 증거 부족
- 재부팅 뒤 단계·증거 유실

### non-goals

v2.0에서는 다음을 만들지 않는다.

- 자동 push, PR, CI 대기, merge
- daemon 또는 background service
- Orca orchestration 의존
- C# Job Object launcher
- 스키마 코드 생성, Ajv, 해시체인 원장
- CLI 실행파일 해시 잠금
- 강한 hostile-repo sandbox
- Cursor의 계획 결정·finding 판정·source 수정
- Claude의 source 수정
- writer의 run 중 교체

새 방어는 위협 모델 안에서 실제 파일럿 사고가 기록된 경우에만 제안할 수 있다. 가상의 공격이나 “나중에 필요할 수 있음”은 full-spec 카탈로그에만 남긴다.

## 2. 아키텍처와 파일 원장

### 실행 구조

    Orca
    ├─ Claude Code /pingpong → runner
    ├─ 복구용 Global Quick Command → launcher → runner
    ├─ Codex writer worktree
    ├─ Claude review pane
    └─ diff·commit 관찰
             │
             ▼
    agent-harness/.harness/runs/<run-id>/

Orca는 모든 사람 조작의 화면이다. runner와 원장은 Orca 프로세스에 종속되지 않는다.

### 예정 파일

    agent-harness/
      PLAN.md
      docs/full-spec-v1.9.md
      harness.mjs
      policy.json
      schemas/review-output.schema.json
      prompts/
        planner.md
        plan-reviewer.md
        plan-reviser.md
        implementer.md
        fixer.md
        code-reviewer.md
      .harness/runs/<run-id>/
        run.json
        SPEC.md
        plan/PLAN_v<N>.md
        reviews/<phase>-r<N>.raw.jsonl
        reviews/<phase>-r<N>.json
        reviews/cursor-scout.md
        reviews/cursor-audit-<phase>.md
        decisions/<phase>-r<N>.md
        evidence/<head-sha>/<command-id>.log
        events.jsonl

review-output schema는 finding과 AC 판정을 위한 작은 계약 하나만 둔다. Node가 JSON.parse 후 필수 필드를 직접 검사한다. validator 생성기나 별도 라이브러리는 쓰지 않는다.

### 상태

    PLAN_LOOP
      → AWAIT_PLAN_APPROVAL
      → IMPLEMENT_LOOP
      → FINAL_LOOP
      → READY_FOR_MANUAL_MERGE
      → DONE

    모든 미완료 상태 → NEEDS_HUMAN | ABORTED

세부 행동은 현재 상태, round, checkpoint, 등록 산출물로 결정한다.

run.json 최소 필드:

    {
      "run_id": "...",
      "state": "PLAN_LOOP",
      "base_sha": "...",
      "head_sha": null,
      "rounds": {"plan": 0, "checkpoint": 0, "final": 0},
      "checkpoint_id": null,
      "approved_plan_path": null,
      "approved_plan_sha": null,
      "approved_base_sha": null,
      "cursor": {"scout_attempted": 0, "scout_status": "pending", "audit_attempted": 0},
      "active_step": null,
      "last_error": null
    }

run.json은 temp 파일에 쓴 뒤 rename한다. events.jsonl에는 시간, 이전 상태, 새 상태, 행동, round, 결과만 append한다.

v2.0은 동시에 여러 run 디렉터리를 보존할 수 있지만 암묵적 current-run 포인터를 두지 않는다. init을 제외한 모든 runner 명령은 --run <run-id>를 필수로 받아 조작 대상을 고정한다.

### SPEC과 PLAN의 최소 문법

SPEC.md에는 다음을 ID와 함께 둔다.

- 원요청과 non-goals
- AC-### 형식의 수용조건
- CMD-### 형식의 필수 명령

PLAN_vN.md에는 다음을 둔다.

- 모든 AC의 구현 경로와 CMD 매핑
- CP-### 형식의 논리적 checkpoint
- checkpoint별 예상 변경 경로와 실행할 CMD
- Scout가 완료됐다면 `SCOUT-###: incorporated | rejected — <근거 또는 PLAN 위치>` 형식의 처리 결과

runner는 이 ID와 경로만 기계적으로 검사한다. 자유형식 설명의 의미 판정은 Claude와 Codex가 담당한다.

### 구조화 리뷰

계획·코드 리뷰는 동일한 최소 JSON 구조를 사용한다.

- phase와 round
- findings: id, severity, claim, failure_scenario, evidence
- 이전 blocker/major의 resolved 또는 open 판정
- AC별 pass, fail, needs_evidence

Claude는 --json-schema, Codex는 --output-schema와 --output-last-message를 사용한다. CLI 원본 이벤트와 구조화 최종 결과를 모두 보존한다.

### handler 성공 계약

각 step의 산출물 경로는 run ID, phase, round, checkpoint ID로 실행 전에 결정한다. 재시작 때 해당 경로의 완성된 산출물과 postcondition이 모두 맞을 때만 adopt한다.

- planner: process exit 0, 비어 있지 않은 PLAN_vN.md, 필수 AC·CMD·checkpoint ID 문법 통과
- plan reviser: planner 조건과 decisions/plan-rN.md 존재
- plan·code reviewer: process exit 0, raw JSONL 존재, review-output 구조 검증 통과
- Codex implementer: process exit 0, HEAD 불변, 변경 경로가 checkpoint 허용 범위 안
- Codex fixer: implementer 조건과 decisions/<phase>-rN.md 존재
- test: process 시작 성공, exit code와 head SHA를 포함한 완성된 evidence log 존재
- Cursor Scout: 시도 전 `scout_attempted=1`, pre/post HEAD가 exact base SHA, worktree status 불변, process exit 0, 비어 있지 않은 원문, 중복 없는 SCOUT ID·허용 category·evidence·note 문법 통과
- Cursor audit: 시도 전 `audit_attempted=1`, pre/post HEAD와 state 불변, worktree status 불변, process exit 0, 비어 있지 않은 감사 원문

Scout의 spawn 실패·nonzero·timeout·빈 출력·형식 오류는 unavailable이다. Cursor step에서 HEAD나 worktree status가 달라지면 NEEDS_HUMAN이다. Claude planner와 Codex plan reviewer의 `active_step.input_hash`에는 동일한 `cursor-scout.md` 원문 bytes의 SHA-256을 포함한다.

Codex 구현 결과의 diff가 비어 있어도 runner는 완료 선언을 믿지 않고 테스트와 Claude 리뷰로 판정한다. 모델이 직접 commit했거나 필수 산출물·postcondition이 하나라도 다르면 성공으로 adopt하지 않는다.

## 3. 실제 루프

### A. 계획 루프

1. `/pingpong` Skill이 최종 SPEC 요약을 보여주고 사람의 명시적 승인을 받은 뒤에만 `start`를 호출해 SPEC과 exact base SHA를 잠근다.
2. runner가 Cursor Repo Scout를 exact base SHA에서 read-only로 1회 실행하고 원문을 `reviews/cursor-scout.md`에 저장한다.
3. Scout를 사용할 수 없으면 사유를 기록하고 계획을 계속한다. 자동 재시도하지 않는다.
4. runner가 Claude에 SPEC과 Scout 원문을 전달해 PLAN_v1.md를 만든다. Claude는 각 항목을 `SCOUT-###: incorporated | rejected — <근거 또는 PLAN 위치>`로 처리한다.
5. runner가 Codex에 SPEC, PLAN, Scout 원문, 이전 review 원문을 전달해 적대 검토한다.
6. runner가 review JSON에서 gate를 계산한다.
7. finding이 있으면 Claude가 finding별 수용·거절 사유를 남기고 PLAN_v2.md를 만든다.
8. Codex가 수정 계획과 이전 blocker/major를 다시 검토한다.
9. gate 통과 시 AWAIT_PLAN_APPROVAL에서 멈춘다.
10. runner가 아래의 사람용 “계획 승인 준비 완료” 요약을 Orca Control terminal에 표시한다.
11. 사람이 최종 PLAN, 남은 minor 의견, Scout 처리 결과, 예상 변경 경로와 checkpoint를 확인한다.
12. 승인하면 approve-plan --run <run-id> --plan-sha <sha>를 실행한다.
13. runner가 승인된 PLAN 경로·SHA와 base SHA를 run.json에 잠근 뒤에만 Codex 구현을 시작한다.

계획 리뷰는 기본 1회, 수정이 있으면 최대 1회 추가한다. 이후에도 blocker/major 또는 needs_evidence가 남으면 NEEDS_HUMAN이다.

    계획 승인 준비 완료

    최종 계획: PLAN_v2.md
    계획 SHA: <sha>
    기준 코드 SHA: <base-sha>
    해결되지 않은 큰 문제: 0
    확인 방법이 없는 요구사항: 0
    Cursor Scout: <completed — 반영 4 / 기각 1 | unavailable — 사유>
    구현 checkpoint: 3개
    남은 참고 의견: 2개
    자동 계획 검토: 2/2회

사람이 계획 보완을 원하면 request-plan-revision --run <run-id> --note-file <path>를 실행한다. runner는 사람 의견 원문을 새 finding 입력으로 등록하고 Claude 수정 → Codex 재검토를 한 라운드 더 수행한다. 이는 사람이 명시적으로 요청한 라운드이므로 자동 검토 상한과 별도로 기록한다.

SPEC의 수용조건 자체가 바뀌는 요청은 계획 보완이 아니다. 현재 run을 ABORTED로 보존하고 새 run을 만든다.

승인 뒤 PLAN 파일·PLAN SHA·base SHA 중 하나라도 달라지면 승인은 무효이며 구현으로 넘기지 않는다.

### B. Codex 구현과 checkpoint 리뷰

1. runner가 승인된 PLAN의 checkpoint를 순서대로 Codex에 전달한다.
2. Codex는 writer worktree에서 해당 checkpoint만 구현하고 source를 직접 commit하지 않는다.
3. runner가 실제 변경 경로를 checkpoint의 승인 경로와 비교한다.
4. 범위 밖 변경이 있으면 stage하지 않고 NEEDS_HUMAN으로 간다.
5. runner가 해당 checkpoint의 CMD를 실행하고 로그를 evidence에 저장한다.
6. 성공하면 승인 경로만 명시적으로 stage하고 checkpoint commit을 만든다.
7. runner가 Claude에 checkpoint diff, PLAN, SPEC, evidence 원문을 전달한다.
8. Claude는 finding과 Codex용 재구현 지시를 반환한다.
9. blocker/major가 있으면 Codex가 accepted/rejected 사유를 남기고 재구현한다.
10. runner가 테스트, 새 checkpoint commit, Claude 재검토를 수행한다.
11. 해당 checkpoint gate가 통과하면 다음 checkpoint로 간다.

작은 변경은 PLAN에서 하나의 checkpoint로 묶는다. 모든 임의 commit마다 리뷰하지 않고, PLAN에 정의된 논리적 checkpoint commit에서만 Claude 리뷰를 실행한다.

### C. 최종 교차 검증

1. 모든 checkpoint 완료 뒤 runner가 SPEC의 필수 명령 전체를 current head SHA에서 실행한다.
2. Claude가 base..head 전체 diff, 최종 PLAN, 모든 review·decision·evidence를 검토한다.
3. Codex가 Claude finding마다 수용·거절과 근거를 남기고 accepted finding을 수정한다.
4. 새 commit이 생기면 기존 테스트·리뷰 evidence를 stale 처리한다.
5. runner가 전체 테스트를 다시 실행하고 Claude가 close-out 리뷰한다.
6. 최종 gate 통과 시 READY_FOR_MANUAL_MERGE에서 멈춘다.
7. 사람이 Orca diff와 GitHub PR을 확인해 직접 push·PR·merge한다.
8. 머지 뒤 complete --merged-sha <sha>로 DONE을 기록한다.

Claude는 어느 단계에서도 source를 수정하지 않는다. Codex의 “완료” 선언과 모델 간 동의는 증거가 아니다.

### D. Cursor Scout와 독립 감사

#### Repo Scout — 매 run 정규 1회

Cursor는 Claude 계획 전에 exact base SHA를 read-only로 조사한다. 역할은 계획 작성이 아니라 저장소의 실제 근거를 먼저 모으는 것이다.

`reviews/cursor-scout.md`는 항목마다 다음 형식을 사용한다.

    SCOUT-### | <category: reuse | impact | test | risk | unknown>
    evidence: <path 또는 확인한 명령>
    note: <관찰 내용; risk면 구체적 실패 시나리오>

Scout는 재사용 후보, 영향 파일, 테스트 지점, 구체적 위험, 확인하지 못한 사항만 기록한다. Claude는 모든 항목을 PLAN에서 `incorporated | rejected`와 근거로 처리하고, Codex도 같은 원문을 받아 계획을 검토한다.

로그인 실패, rate limit, timeout, 빈 출력은 `scout_status=unavailable`과 사유만 기록하고 계획을 계속한다. Scout가 source를 변경하면 경계 위반이므로 NEEDS_HUMAN이다. Scout는 자동 재시도하지 않는다.

#### 독립 감사 — 조건부 최대 1회

다음 중 하나일 때, `active_step=null`이고 state가 `NEEDS_HUMAN | READY_FOR_MANUAL_MERGE`인 경우에만 사람이 `cursor-audit --phase plan | checkpoint | final`을 요청할 수 있다.

- 동일 계획 finding이 두 차례 반복됨
- Claude finding과 Codex 반박이 충돌함
- 사람이 최종 제3 검증을 원함

`--reason-file` 원문은 호출 근거로 events와 감사 파일 머리말에 보존한다.

Cursor는 read-only로 현재 SPEC, PLAN, review, decision, diff, evidence 원문을 받는다. 결과는 `reviews/cursor-audit-<phase>.md`에 그대로 저장한다.

    AUDIT-### | <observation>
    evidence: <path 또는 확인한 명령>
    failure_scenario_or_unknown: <구체적 실패 또는 확인 불가 사항>

감사는 severity, verdict, accept/reject, resolved/open을 판정하지 않는다. 결과는 의견일 뿐 finding을 자동 종료하거나 source·state를 변경하지 않는다.

감사 뒤 state는 바뀌지 않는다. 반영하려면 계획 단계에서는 감사 파일을 `request-plan-revision --note-file`에 전달하고, 구현·최종 단계에서는 `resolve --retry --note-file <감사 파일>`로 해당 Claude review에 재진입해 감사 원문을 Claude·Codex 입력에 포함한다. 이 재진입은 `NEEDS_HUMAN | READY_FOR_MANUAL_MERGE`에서 허용한다. 실패해도 재시도하지 않고 호출 전 state를 유지한다.

## 4. 게이트와 예산

### 계획 승인 준비 조건 — 사람에게 보여주는 기준

runner는 다음 세 가지를 모두 만족할 때만 AWAIT_PLAN_APPROVAL로 간다.

1. 해결되지 않은 큰 문제가 없다.
   - blocker는 구현을 시작하면 안 되는 치명적 문제다.
   - major는 실제 사용자 결과나 설계를 크게 잘못되게 만드는 문제다.
2. 모든 사용자 요구에 구현 위치와 확인 방법이 있다.
   - 각 AC가 변경할 파일 또는 영역과 검증 CMD에 연결돼야 한다.
3. Codex가 순서대로 실행할 작업 단계가 있다.
   - 작은 작업도 최소 checkpoint 1개가 있어야 한다.

### runner 내부 추적 규칙

- 이전 라운드의 blocker/major는 다음 Codex 리뷰에서 resolved 또는 open으로 반드시 재판정한다. 조용히 누락할 수 없다.
- blocker/major 주장에는 구체적인 실패 상황과 근거가 필요하다. 없으면 needs_evidence로 기록하며 승인 준비가 아니다.
- 현재 PLAN이 가장 최신 버전이어야 한다.
- Scout가 완료됐다면 모든 `SCOUT-###` 항목이 정해진 `incorporated | rejected — 근거` 문법으로 처리돼야 한다. unavailable이면 이 조건을 생략한다.
- minor는 참고 의견으로 표시하지만 자동 승인 준비를 막지 않는다. 사람이 최종 승인 때 확인한다.

### 자동 검토 안전 정지

- Codex 계획 리뷰는 기본 최대 2회다.
- 2회 안에 승인 준비 조건을 만족하면 정상적으로 사람 승인으로 넘긴다.
- 세 번째 자동 리뷰가 필요하면 통과시키지 않고 NEEDS_HUMAN으로 멈춘다.
- 사람은 Cursor 의견, 추가 계획 라운드 1회, finding 기각, run 중단 중 하나를 선택한다.

### checkpoint·최종 gate

- 현재 head SHA의 필수 CMD가 모두 exit code 0
- open blocker/major가 0
- needs_evidence가 0
- 승인 경로 밖 변경이 0

blocker/major에는 입력 또는 조건에서 잘못된 결과로 이어지는 failure scenario가 필수다. 없으면 needs_evidence이며 checkpoint·최종 gate도 통과하지 않는다.

기본 예산:

| 항목 | 상한 |
|---|---:|
| 계획 검토 | 2 |
| checkpoint별 Claude 리뷰 | 2 |
| checkpoint별 Codex fix | 2 |
| 최종 Claude 리뷰 | 2 |
| Cursor Repo Scout | run당 1, 정규·재시도 없음 |
| Cursor 독립 감사 | run당 1, 조건부·재시도 없음 |
| Cursor 전체 | run당 최대 2 |

예산은 품질 통과 조건이 아니라 자동 반복 안전장치다. 예산 소진은 통과가 아니라 NEEDS_HUMAN이다. 분쟁은 가능하면 재현 테스트로 판정하고, 계약 변경이 필요하면 현재 run을 ABORTED로 보존한 뒤 새 run을 만든다.

## 5. 실행·복구 규칙

- runner는 child 실행 전에 active_step에 step ID, type, input hash, pre-head, attempt를 기록한다.
- 산출물을 먼저 저장하고 검증한 뒤 상태와 active_step을 원자 갱신한다.
- 재시작 시 완성된 예상 산출물이 있으면 재호출하지 않고 adopt한다.
- 중단된 계획·리뷰·테스트는 남은 예산 안에서 한 번만 재실행한다. Cursor Scout와 감사는 예외로 재실행하지 않는다.
- Cursor 시도 횟수는 spawn 전에 소비하며 성공·unavailable·중단을 모두 1회로 계산한다. `resolve --retry`는 Cursor step 재실행을 거부한다.
- 재시작 때 시도된 Cursor step의 산출물이 불완전하면 Scout는 unavailable로 확정하고 계획을 계속하며, 감사는 호출 전 state를 유지한다.
- 중단된 Codex 구현·fix는 partial diff를 보존하고 NEEDS_HUMAN으로 간다. blind retry하지 않는다.
- 이 상태에서는 resolve --continue-partial 또는 resolve --abort만 허용한다. continue-partial은 사람이 현재 diff를 검토·승인한 뒤 runner가 diff hash와 current HEAD를 새 입력 상태로 기록하고 같은 step을 “기존 변경에서 계속”하도록 Codex에 전달한다. 처음부터 재실행하지 않는다.
- 모델이 직접 commit했거나 HEAD가 예상과 다르면 NEEDS_HUMAN이다.
- checkpoint commit 직후 중단되면 commit message의 run ID·checkpoint ID와 expected tree가 일치할 때만 adopt한다.
- 새 source commit이 생기면 이전 head의 테스트·코드 리뷰 evidence는 stale이다.
- worker_done, 자연어 완료 선언, 원본 없는 요약은 gate evidence가 아니다.

테스트 로그 첫머리에는 command ID, command, cwd, exit code, head SHA, 시작·종료 시각을 기록한다.

## 6. Orca 운영

runner is the only state-transition surface. `/pingpong`은 대화형 진입 어댑터이고 launcher는 복구용 어댑터다.

1. Orca에 agent-harness와 대상 저장소를 등록한다.
2. Agent Permissions를 Manual로 둔다.
3. custom arguments에서 bypass, yolo 계열 플래그를 제거한다.
4. `C:\Users\wjdbi\.claude\skills\pingpong\SKILL.md`에 개인 Skill을 설치한다. 대상 저장소의 Claude Code 탭에서 `/pingpong <작업 설명>`으로 새 작업을 시작하고 `/pingpong resume`으로 저장된 작업을 연다.
5. Settings > Shortcuts에서 Claude Code의 `New agent tab`에 원하는 단축키를 배정한다.
6. Claude가 없을 때를 위한 복구용 Global Quick Command는 선택적으로 등록한다.

   ```text
   Settings > Quick Commands
   Label: Pingpong Recovery
   Command: node "D:\codex-projects\agent-harness\launcher.mjs"
   Scope: Global
   ```

7. launcher는 새 작업을 만들지 않는다. exact writer worktree이면 그 소유 run만 선택하고, 같은 저장소의 활성 run이 여러 개면 반드시 사람이 하나를 선택한다.
8. Codex writer worktree, Claude review pane, diff viewer를 같은 run 단위로 연다. Orca에서 숨겨진 external writer worktree는 프로젝트 메뉴에서 숨김을 해제한 뒤 import 또는 표시한다.
9. Skill과 launcher는 공개 runner 명령만 호출하며 `.harness` 상태를 직접 수정하지 않는다.

v2.0은 Orca orchestration을 사용하지 않는다. Orca는 조작·관찰 화면이며 runner 상태의 정본이 아니다. Orca 종료 후 다시 열어 status와 run만 실행하면 이어져야 한다.

## 7. runner 명령

| 명령 | 역할 |
|---|---|
| list --repo <path> | 저장소의 run 목록과 exact owner 조회 |
| start --repo <path> --spec <path> | init 후 다음 사람 gate까지 진행 |
| init --repo <path> --spec <path> | 새 run과 writer worktree 생성 |
| run --run <run-id> | 사람 gate·NEEDS_HUMAN·terminal까지 자동 진행 |
| approve-plan --run <run-id> --plan-sha <sha> | exact PLAN·base SHA를 잠그고 구현 시작 |
| request-plan-revision --run <run-id> --note-file <path> | 사람 의견으로 계획 수정·재검토 1회 요청 |
| status --run <run-id> | 현재 상태·round·checkpoint·다음 행동 표시 |
| resolve --run <run-id> --retry [--note-file <path>] | read-only·분쟁 step 재시도; 감사 반영 시 해당 review로 재진입 |
| resolve --run <run-id> --continue-partial | 승인한 partial diff에서 Codex 작업 계속 |
| resolve --run <run-id> --abort | 사람 예외 중단 |
| cursor-audit --run <run-id> --phase <phase> --reason-file <path> | phase는 plan/checkpoint/final, idle human gate에서 조건부 독립 감사 1회 |
| complete --run <run-id> --merged-sha <sha> | 사람 머지 뒤 DONE 기록 |
| abort --run <run-id> --reason <text> | 현재 run 보존 종료 |

`/pingpong`은 새 작업의 기본 진입점이고 Global Quick Command는 저장 작업 복구용이다. 둘 다 runner 밖의 상태 전이를 구현하지 않는다.

## 8. 구독 인증과 CLI 경계

- Claude와 Codex는 현재 구독 로그인을 재사용한다.
- runner 시작 시 ANTHROPIC_API_KEY와 OPENAI_API_KEY가 설정돼 있으면 거부한다.
- Cursor는 기존 구독 로그인을 사용한다. CURSOR_API_KEY 설정, 로그인 실패, rate limit, timeout은 Scout에서는 unavailable로 기록하고 계속하며, 감사에서는 호출 전 상태로 돌아간다.
- Cursor Scout와 감사는 로컬 검증된 `agent -p --mode plan --sandbox enabled --workspace <writer-worktree>` subset으로 실행한다. Scout 호출 직전 HEAD가 exact base SHA인지 확인하며 `-f | --force | --yolo | --approve-mcps`는 금지한다.
- Claude 계획·리뷰는 process cwd를 대상 worktree로 두고 plan permission과 read-only tool set을 사용한다.
- Codex 계획 리뷰는 read-only sandbox, 구현은 writer worktree의 workspace-write sandbox를 사용한다.
- danger-full-access와 bypass permission 플래그는 사용하지 않는다.
- exact CLI 인자는 구현 직전 로컬 help와 한 번 대조해 PLAN 또는 테스트에 고정한다.

## 9. 파일럿 합격 조건

1. toy task가 Cursor Scout, 계획 왕복, 계획 승인, Codex 구현, checkpoint Claude 리뷰, Codex fix, 전체 테스트, Claude 최종 리뷰, manual merge 준비까지 완주한다.
2. PLAN_REVIEW 중 runner를 종료해도 같은 step을 1회 재실행해 이어진다.
3. Codex 구현 중 runner가 종료되면 partial diff가 보존되고 NEEDS_HUMAN에서 멈춘다.
4. Codex가 승인 경로 밖 파일을 바꾸면 commit하지 않고 NEEDS_HUMAN으로 간다.
5. 새 commit 뒤 이전 head의 evidence가 gate에 사용되지 않는다.
6. 리뷰·fix 예산을 넘으면 추가 호출 없이 NEEDS_HUMAN으로 간다.
7. Orca를 완전히 종료했다가 다시 열어 동일 run을 재개한다.
8. Cursor Scout 결과가 PLAN에서 전부 반영 또는 기각되고 Codex에 동일 원문이 전달된다.
9. Cursor Scout의 로그인·rate limit·spawn·nonzero·timeout·빈 출력·형식 오류는 unavailable로 기록되고 계획 루프는 계속되며 두 번째 Scout 호출은 거부된다.
10. Cursor 감사가 실패하거나 중단돼도 시도는 소비되고 호출 전 state를 유지하며 두 번째 감사 호출은 거부된다.
11. 한 run의 Cursor 호출은 Scout 1회와 감사 1회, 합계 2회를 넘지 못한다.
12. Cursor가 HEAD 또는 worktree status를 바꾸면 NEEDS_HUMAN이며 기존 finding을 자동 종료하지 않는다.
13. API key 환경변수를 넣으면 해당 provider 호출 전에 거부한다. Cursor Scout는 unavailable 처리한다.
14. 리뷰 원문, 구조화 finding, decision, command·exit code·head SHA 로그가 모두 보존된다.

## 10. 승격 규칙

v2.1은 v2.0 실전 run 10회를 완주하고, 회고에서 반복된 수동 push·PR 비용이 확인된 뒤 시작한다.

full-spec-v1.9.md의 항목은 다음 형식으로만 승격한다.

    실제 incident
      → 현재 v2.0 규칙으로 막지 못한 이유
      → 가장 작은 방어
      → 재현 테스트

사고 없는 speculative hardening과 전체 full-spec 구현은 금지한다.

## 부록 — 합의 원장

- 파일 원장이 기억, runner가 루프 엔진, Orca가 조작·관제 화면이다.
- Claude는 계획 작성·수정과 코드 리뷰만 하며 source를 수정하지 않는다.
- Codex는 계획 적대 검토와 모든 구현·재구현을 담당하는 단일 Writer다.
- Cursor는 매 run Repo Scout로 저장소 근거를 제공하고, 분쟁 또는 최종 검증에서 조건부 독립 감사를 한 번 수행할 수 있다.
- 계획은 Claude → Codex review → Claude revise → Codex re-review로 수렴한다.
- 구현은 Codex checkpoint → Claude review → Codex fix로 수렴한다.
- 최종은 Claude full review → Codex decision/fix → Claude close-out review다.
- 사람은 핑퐁 시작 전 SPEC 확인, 최종 계획 승인, GitHub 머지를 담당한다.
- v1.9의 자동 merge, 강한 sandbox, schema codegen, 해시체인은 보존만 하고 v2.0에서 구현하지 않는다.
