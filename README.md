# agent-harness — Phase 1 quick start

현재 구현 범위는 **계획 핑퐁**이다.

```text
Cursor Scout 1회
→ Claude 계획
→ Codex 적대 리뷰
→ 필요하면 Claude 수정
→ Codex 재검토
→ 사람의 계획 승인
→ IMPLEMENT_LOOP에서 정지
```

Phase 1 currently stops after `IMPLEMENT_LOOP`; it does not implement the target repository's source code.

Phase 1은 대상 저장소의 소스 코드를 수정하지 않는다. 실제 Codex 구현과 Claude 코드 리뷰 루프는 다음 단계에서 붙인다.

## 1. 최초 1회 확인

세 CLI가 구독 계정으로 로그인되어 있어야 한다.

```powershell
claude auth status
codex login status
agent status
```

다음 API 키 환경변수는 비워 둔다. 값이 있으면 runner가 Claude/Codex 호출을 거부하고 Cursor Scout는 `unavailable`로 처리한다.

```powershell
'ANTHROPIC_API_KEY','OPENAI_API_KEY','CODEX_API_KEY','CURSOR_API_KEY' |
  ForEach-Object { "$_=$([Environment]::GetEnvironmentVariable($_))" }
```

Orca에서는 Agent Permissions를 `Manual`로 두고 custom args에 `--dangerously-skip-permissions`, `--yolo`, `danger-full-access` 같은 우회 플래그가 없는지 확인한다. Orca는 화면과 터미널만 제공하며, 정본 상태는 이 저장소의 `.harness/` 파일이다.

## 2. 작은 작업의 SPEC 작성

[SPEC.example.md](./SPEC.example.md)를 복사해 실제 요청, `AC-###`, `CMD-###`를 적는다. 첫 파일럿은 30~90분 안에 끝낼 수 있는 작은 Git 저장소 작업을 권장한다.

## 3. Orca Global Quick Command에서 시작

```text
Settings > Quick Commands
Label: Harness
Command: node "D:\codex-projects\agent-harness\launcher.mjs"
Scope: Global
```

대상 저장소의 worktree에서 Global Quick Command `Harness`를 실행한다. 현재 worktree가 runner가 만든 exact writer worktree이면 launcher는 그 소유 run만 사용한다. 같은 저장소의 활성 run이 여러 개면 자동 선택하지 않고 사람이 하나를 고른다. Orca에서 숨겨진 external writer worktree는 프로젝트 메뉴에서 숨김을 해제한 뒤 import 또는 표시한다.

## 4. Fallback: raw runner commands

```powershell
Set-Location D:\codex-projects\agent-harness

node .\harness.mjs init `
  --repo "D:\path\to\target-repo" `
  --spec "D:\path\to\SPEC.md"
```

출력의 `runId`를 복사한다. 이후 모든 명령은 이 ID를 명시한다.

```powershell
$run = '<runId>'
node .\harness.mjs run --run $run
node .\harness.mjs status --run $run
```

`run`은 필요한 계획 라운드를 한 번에 실행하고 다음 중 하나에서 멈춘다.

- `AWAIT_PLAN_APPROVAL`: 계획 검토 가능
- `NEEDS_HUMAN`: 예산 소진 또는 경계 위반. `lastError` 확인

## 5. 계획 읽고 결정

`status` 출력의 `currentPlanPath`, `currentPlanSha`를 사용한다. 실제 파일은 다음 아래에 있다.

```text
.harness/runs/<runId>/
  SPEC.md
  plan/
  reviews/
  decisions/
  run.json
  events.jsonl
```

계획이 좋으면 exact SHA로 승인한다.

```powershell
node .\harness.mjs approve-plan --run $run --plan-sha '<currentPlanSha>'
```

보완이 필요하면 메모 파일을 만든 뒤 한 번 더 핑퐁한다.

```powershell
node .\harness.mjs request-plan-revision `
  --run $run `
  --note-file "D:\path\to\plan-feedback.md"

node .\harness.mjs run --run $run
```

작업 자체를 취소하려면:

```powershell
node .\harness.mjs abort --run $run --reason 'scope changed'
```

## 6. 재부팅 뒤 재개

같은 명령만 다시 실행한다. 이미 완료된 Scout·계획·리뷰는 다시 호출하지 않고, 중단된 read-only 단계만 허용된 범위에서 복구한다.

```powershell
Set-Location D:\codex-projects\agent-harness
$run = '<runId>'
node .\harness.mjs status --run $run
node .\harness.mjs run --run $run
```

## 현재 한계

- `IMPLEMENT_LOOP` 이후는 아직 구현되지 않았다.
- GitHub 자동 병합은 없다. 최종 병합은 사람이 한다.
- Orca orchestration은 쓰지 않는다.
- Cursor 독립 감사와 구현 루프는 Phase 2에서 추가한다.
