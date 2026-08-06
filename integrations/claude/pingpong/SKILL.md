---
name: pingpong
description: Use when the user explicitly invokes /pingpong to start or resume the local Claude-Codex development loop for the current Git repository.
argument-hint: "[작업 설명 | resume]"
disable-model-invocation: true
---

# Pingpong

사용자 입력: `$ARGUMENTS`

## 진입

- 입력이 비어 있으면 저장소·커밋·과거 작업을 조사하지 말고 `무슨 작업을 계획할까요?`라고만 묻고 기다린다.
- `/pingpong resume` 또는 명시적인 이어가기 요청이면 새 작업을 만들지 않는다. 아래 명령으로 복구용 launcher 하나만 열고 결과를 보고한다.

```powershell
orca terminal create --worktree active --title "Pingpong 복구" --command 'node "D:/codex-projects/agent-harness/launcher.mjs"' --focus --json
```

- 그 외 입력은 새 작업이다. 한국어로 대화하며, 구현에 필요한 정보가 실제로 빠진 경우에만 질문을 한 번에 하나씩 한다. 작업을 추측하지 않는다.

## 새 작업 시작

새 작업 진입 시점부터 최종 SPEC 요약에 대한 사용자의 명시적 승인 전에는 현재 Claude가 직접 대화하고 읽기 전용 조사만 한다. 임시 파일 생성, `harness.mjs start`, Cursor Scout, 다른 provider, subagent는 호출하지 않는다.

1. 현재 Git root를 확인한다. 사용자가 명시한 저장소의 canonical Git root가 현재 Git root와 다르면 시작하지 말고, 해당 저장소의 Orca worktree에서 다시 실행하도록 안내하거나 사용자의 명시적 선택을 받는다.
2. 현재 Git root와 관련 파일을 조사한다. 아직 source를 수정하지 않는다.
3. 계획 전에 요청이 닿는 사용자·대상·데이터·상태·외부 시스템을 짧게 훑고, 목표·성공 모습, 포함·제외 범위, 입력·출력, 권한, 상태 변화, 실패·충돌 처리, 검증 방법 중 답에 따라 동작·범위·데이터·권한·검증이 달라지는 미확정 맥락만 찾는다.
   - 사용자 말이나 현재 코드에서 답을 확인할 수 있으면 채택하고 묻지 않는다.
   - 계획을 바꾸지 않는 구현 세부나 나중에 조절할 값이면 planner 판단으로 남기고 묻지 않는다.
   - 계획을 바꾸는 미확정 맥락은 한 번에 하나씩 묻는다. 가능한 경우 짧은 추천안이나 구체적 선택지를 먼저 제시한다.
   - 답을 받으면 그 답이 닿는 부분만 다시 확인한다. 질문 수를 채우기 위한 일반론, 이미 답한 내용, 코드로 확인 가능한 내용은 묻지 않는다.
   - 사용자 말과 현재 코드가 어긋나면 임의로 한쪽을 채택하지 않고 그 차이를 그대로 보여주며 묻는다.
   - 도메인·동작은 사용자만 아는 것이므로 끌어내고, 기술 선택은 짧은 선택지와 추천을 먼저 제시해 사용자가 고르게 한다.
4. 계획을 바꾸는 미확정 맥락이 하나라도 남아 있으면 SPEC으로 넘어가지 않는다. 사용자가 결정을 명시적으로 위임하면 추천안을 SPEC의 구현 재량으로 기록하고 미확정으로 두지 않는다.
5. 미확정 맥락이 없으면 `D:/codex-projects/agent-harness/SPEC.example.md` 형식으로 SPEC을 작성한다. SPEC은 `## 계약`과 `## 맥락` 두 섹션으로 나눈다.
   - `## 계약` — 사람이 승인하는 부분. 요청, 범위 밖, `AC-###`, `CMD-###`, 제약. runner는 **이 섹션 안에서만** `AC-###`와 `CMD-###`를 파싱한다.
   - `## 맥락` — planner·reviewer·implementer만 읽는다. 대화에서 나온 결정과 근거, 조사한 파일, 버린 대안. 길어도 되고, 이 섹션의 `CMD-###` 언급은 파싱되지 않는다.
   - 각 `AC-###` 줄 끝에 그것을 판정하는 `CMD-###`를 적는다. 자동 판정이 불가능하면 `검증: 수동`이라고 적는다.
   - **`CMD-###`는 멱등·비파괴여야 한다.** runner가 base_sha에서 한 번, 구현 뒤에 또 한 번 실행한다. 배포·마이그레이션·과금·외부 쓰기는 검증이 아니라 작업이다. 배포 자동화 작업이면 `deploy --dry-run` 같은 형태를 쓴다.
   - 검증 명령은 저장소에서 실제로 쓰는 것을 먼저 찾아 쓴다. 없으면 그 부재 자체를 사용자에게 알리고 무엇으로 판정할지 정한다.
   - `CMD-###`는 정의 줄에서 백틱 하나로 감싼 실행 가능한 명령이어야 하고, 백틱 뒤에 설명을 붙이지 않는다.
   - 검증 명령은 Windows에서 PowerShell로 실행된다. `&&` 같은 POSIX 연산자가 필요하면 Git Bash 전체 경로(`C:\PROGRA~1\Git\bin\bash.exe -c '...'`)로 감싼다. 무수식 `bash`는 WSL 런처로 해석되어 거부된다.
6. `## 계약` 섹션만으로 `최종 SPEC 요약`을 만들어 보여준다. `## 맥락`은 요약에 넣지 않는다. 그리고 `이 내용으로 Cursor Scout와 계획 핑퐁을 시작할까요? (승인/수정)`이라고 묻고 기다린다.
7. 수정 요청이면 SPEC을 고쳐 최종 SPEC 요약을 다시 보여주고 다시 승인을 묻는다. 애매한 응답은 승인이 아니다.
8. 승인 뒤 `$env:TEMP` 아래에 `pingpong-spec-<UUID>.md` 형식의 고유한 절대 경로를 만들고 SPEC을 UTF-8로 저장한다. `.harness`에는 직접 쓰지 않는다.
9. 다음 공개 runner 명령을 실행하고 사람 gate까지 기다린다. 명령이 끝나면 임시 SPEC을 삭제한다. runner가 필요한 원본은 run 안의 `SPEC.md`로 이미 잠근다.

```powershell
node "D:/codex-projects/agent-harness/harness.mjs" start --repo "<현재 Git root>" --spec "<작성한 SPEC 파일>"
```

10. runner 결과의 `specCommandBaseline`과 `specAcceptanceCoverage`를 표로 보여준다. 이건 SPEC이 실제로 무엇을 검증하는지에 대한 기계적 사실이므로 반드시 사람이 보게 한다.
    - `exit_code`가 `0`인 CMD는 **변경 전에도 통과한다**. 기존 동작을 지키는 명령이면 정상이고, 이번 작업을 판정할 명령이면 공허하다. 어느 쪽인지 묻는다.
    - `exit_code`가 `0`이 아닌 CMD는 새 동작을 검증한다는 뜻이므로 정상이다.
    - `mutated_worktree`가 `true`인 CMD는 멱등·비파괴 계약을 어긴 것이다. 그 사실을 알리고 명령을 바꿀지 묻는다.
    - `command_ids`가 빈 `AC-###`는 자동 판정되지 않는다. 그대로 진행할지 CMD를 추가할지 묻는다.
    - 사용자가 SPEC을 고치기로 하면 계획 핑퐁을 진행하지 않고 5번으로 돌아간다.
11. runner 결과의 `cursorScoutStatus`가 `unavailable`이면 `cursorScoutUnavailableReason`을 그대로 보여주고 Scout 근거 없이 계획됐다고 명시한다. `AWAIT_PLAN_APPROVAL`이면 반환된 `runId`, `currentPlanPath`, `currentPlanSha`를 사용한다. `currentPlanPath`는 상대 경로이므로 `D:/codex-projects/agent-harness/.harness/runs/<runId>/<currentPlanPath>`에서 최종 PLAN **전문을 끝까지 읽은 뒤**, 한국어 구조화 요약을 반드시 제시하고 전문 파일 경로를 함께 안내한 다음 승인·보완·취소 중 하나를 명시적으로 묻는다. 요약에는 최소한 다음을 포함한다: ① 핵심 설계 결정(번호별), ② 신규·변경 파일 목록, ③ 검증 계획(자동/수동 구분), ④ 미확인 사항과 리스크, ⑤ 리뷰 지적 반영 이력(있는 경우). 요약 없이 승인을 묻지 않는다.
12. 사용자의 명시적 선택에만 대응하는 기존 `approve-plan`, `request-plan-revision`, `run`, `abort` 명령을 호출한다. exact `runId`와 PLAN SHA를 사용한다. 계획 승인 결과가 `IMPLEMENT_LOOP`이면 같은 run에 `run`을 호출해 Codex 구현과 runner 검증을 진행한다.
13. `READY_FOR_MANUAL_MERGE`이면 `changedPaths`, `implementationDigest`, `verificationEvidence`, writer worktree 경로를 보여주고 사람이 diff를 검토해 직접 병합하도록 안내한다. `NEEDS_HUMAN`이면 `lastError`와 `lastErrorDetail`을 보여주고 멈춘다. `lastErrorDetail.next_action`이 권장 행동이다. events의 액션이 `spec_gate`이면 계획 수정으로는 못 고치는 SPEC 결함이므로, `lastErrorDetail.blocking_findings[].evidence`가 가리키는 SPEC 줄을 사용자에게 보여주고 SPEC 수정 후 재시작을 묻는다. 실패한 provider를 임의로 우회하거나 새 run을 만들지 않는다.
14. 사용자가 수정된 최종 SPEC으로 재시작을 명시적으로 승인한 경우에만 기존 run을 `abort`한 뒤 아래처럼 이어받는다. 이전 run이나 SPEC을 자동 선택하지 않는다.

```powershell
node "D:/codex-projects/agent-harness/harness.mjs" start --repo "<현재 Git root>" --spec "<작성한 SPEC 파일>" --parent-run "<이전 runId>"
```

## 세션 비용

누적 대화 전체가 매 호출의 입력이 되므로, 한 세션에서 gate를 여러 번 연속 처리하면 같은 문맥을 반복해서 지불한다.

- gate(`AWAIT_PLAN_APPROVAL`, `READY_FOR_MANUAL_MERGE`, `NEEDS_HUMAN`)에 도달하면 결과를 보고하고 그 세션에서의 작업을 끝낸다. 다음 행동은 새 세션에서 `/pingpong resume`으로 이어간다.
- 이어갈 때 넘길 것은 `runId`, `state`, `lastError`, PLAN 경로뿐이다. 이전 대화 전문을 옮기지 않는다.
- run 산출물(SPEC, PLAN, 리뷰, 검증 로그)은 전부 `.harness/runs/<runId>/` 아래에 남아 있으므로 대화 문맥으로 들고 다닐 이유가 없다.

## 불변조건

`harness.mjs`만 상태 전이를 소유한다. 이 Skill은 `.harness`의 `run.json`이나 `events.jsonl`을 직접 수정하지 않으며, 여러 run 중 하나를 자동 선택하거나 사람 승인·수동 병합을 대신하지 않는다.
