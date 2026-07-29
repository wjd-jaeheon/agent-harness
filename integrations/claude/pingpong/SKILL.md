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
3. `D:/codex-projects/agent-harness/SPEC.example.md` 형식으로 원요청, non-goals, `AC-###`, `CMD-###`를 작성한다.
4. 목표, 제외 범위, 완료 기준, 검증 명령을 `최종 SPEC 요약`으로 보여주고 `이 내용으로 Cursor Scout와 계획 핑퐁을 시작할까요? (승인/수정)`라고 묻고 기다린다.
5. 수정 요청이면 SPEC을 고쳐 최종 SPEC 요약을 다시 보여주고 다시 승인을 묻는다. 애매한 응답은 승인이 아니다.
6. 승인 뒤 `$env:TEMP` 아래에 `pingpong-spec-<UUID>.md` 형식의 고유한 절대 경로를 만들고 SPEC을 UTF-8로 저장한다. `.harness`에는 직접 쓰지 않는다.
7. 다음 공개 runner 명령을 실행하고 사람 gate까지 기다린다. 명령이 끝나면 임시 SPEC을 삭제한다. runner가 필요한 원본은 run 안의 `SPEC.md`로 이미 잠근다.

```powershell
node "D:/codex-projects/agent-harness/harness.mjs" start --repo "<현재 Git root>" --spec "<작성한 SPEC 파일>"
```

8. runner 결과의 `cursorScoutStatus`가 `unavailable`이면 `cursorScoutUnavailableReason`을 그대로 보여주고 Scout 근거 없이 계획됐다고 명시한다. `AWAIT_PLAN_APPROVAL`이면 반환된 `runId`, `currentPlanPath`, `currentPlanSha`를 사용한다. `currentPlanPath`는 상대 경로이므로 `D:/codex-projects/agent-harness/.harness/runs/<runId>/<currentPlanPath>`에서 최종 PLAN을 읽어 한국어로 보여주고 승인·보완·취소 중 하나를 명시적으로 묻는다.
9. 사용자의 명시적 선택에만 대응하는 기존 `approve-plan`, `request-plan-revision`, `run`, `abort` 명령을 호출한다. exact `runId`와 PLAN SHA를 사용한다. 계획 승인 결과가 `IMPLEMENT_LOOP`이면 같은 run에 `run`을 호출해 Codex 구현과 runner 검증을 진행한다.
10. `READY_FOR_MANUAL_MERGE`이면 `changedPaths`, `implementationDigest`, `verificationEvidence`, writer worktree 경로를 보여주고 사람이 diff를 검토해 직접 병합하도록 안내한다. `NEEDS_HUMAN`이면 `lastError`를 그대로 보여주고 멈춘다. 실패한 provider를 임의로 우회하거나 새 run을 만들지 않는다.
11. 사용자가 수정된 최종 SPEC으로 재시작을 명시적으로 승인한 경우에만 기존 run을 `abort`한 뒤 아래처럼 이어받는다. 이전 run이나 SPEC을 자동 선택하지 않는다.

```powershell
node "D:/codex-projects/agent-harness/harness.mjs" start --repo "<현재 Git root>" --spec "<작성한 SPEC 파일>" --parent-run "<이전 runId>"
```

## 불변조건

`harness.mjs`만 상태 전이를 소유한다. 이 Skill은 `.harness`의 `run.json`이나 `events.jsonl`을 직접 수정하지 않으며, 여러 run 중 하나를 자동 선택하거나 사람 승인·수동 병합을 대신하지 않는다.
