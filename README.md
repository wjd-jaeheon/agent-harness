# agent-harness — minimal Phase 2 quick start

현재 구현 범위는 **계획 핑퐁 → Codex 구현 → runner 검증 → 수동 병합 준비**다.

```text
Claude 요구사항 확인
→ 사람의 최종 SPEC·핑퐁 시작 승인
Cursor Scout 1회
→ Claude 계획
→ Codex 적대 리뷰
→ 필요하면 Claude 수정
→ Codex 재검토
→ 사람의 계획 승인
→ Codex 구현
→ runner diff·보호 경로·CMD 검증
→ READY_FOR_MANUAL_MERGE
```

Codex만 detached writer worktree의 source를 수정한다. runner는 `.git`, `.harness` 변경을 거부하고 잠긴 SPEC의 backtick-wrapped `CMD-###`를 실행한다.

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

## 2. Orca에서 `/pingpong`으로 시작

최초 1회, 이 저장소의 [Pingpong Skill](./integrations/claude/pingpong/SKILL.md)을 `C:\Users\wjdbi\.claude\skills\pingpong\SKILL.md`에 설치한다. 대상 저장소를 Orca에서 연 뒤 Claude Code 탭에 다음처럼 입력한다.

```text
/pingpong 다운로드 파일에서 이메일·메신저 말투를 학습하는 기능
```

인수 없이 `/pingpong`만 입력하면 `무슨 작업을 계획할까요?`라고 묻는다. 새 작업은 저장소에서 확인할 수 없는 계획 변경 맥락만 한 번에 하나씩 질문하고, 요구사항이 정리되면 목표·제외 범위·완료 기준·검증 명령을 최종 SPEC 요약으로 보여준다. 사용자가 승인해야만 기존 runner의 `start`를 호출한다. 이후 Cursor Scout → Claude 계획 → Codex 적대 검토 → 필요시 Claude 수정 → Codex 재검토 후 최종 계획 승인에서 멈춘다.

기존 작업은 다음으로 연다.

```text
/pingpong resume
```

Orca `Settings > Shortcuts`에서 Claude Code의 `New agent tab`에 원하는 키(예: `Ctrl+Alt+H`)를 지정하면 `단축키 → /pingpong <작업>`으로 시작할 수 있다.

첫 파일럿은 30~90분 안에 끝낼 수 있는 작은 Git 저장소 작업을 권장한다.

## 3. 복구용 Orca Global Quick Command

Claude Code를 사용할 수 없을 때 저장된 run을 복구·관리하는 선택 경로다.

```text
Settings > Quick Commands
Label: Pingpong Recovery
Command: node "D:\codex-projects\agent-harness\launcher.mjs"
Scope: Global
```

launcher는 새 작업을 만들지 않는다. 현재 worktree가 runner가 만든 exact writer worktree이면 그 소유 run만 사용한다. 같은 저장소의 활성 run이 여러 개면 자동 선택하지 않고 사람이 하나를 고른다. Orca에서 숨겨진 external writer worktree는 프로젝트 메뉴에서 숨김을 해제한 뒤 import 또는 표시한다.

## 4. Fallback: raw runner commands

`/pingpong`을 사용할 수 없을 때만 아래 명령을 직접 사용한다. [SPEC.example.md](./SPEC.example.md)를 복사해 실제 요청, `AC-###`, `CMD-###`를 적는다.

```powershell
Set-Location D:\codex-projects\agent-harness

node .\harness.mjs init `
  --repo "D:\path\to\target-repo" `
  --spec "D:\path\to\SPEC.md"
```

`init`은 새 worktree를 base_sha로 만든 뒤 SPEC 계약 섹션의 `CMD-###`를 **거기서 한 번 실행한다**. 결과는 `specCommandBaseline`에, `AC-###`별 판정 명령은 `specAcceptanceCoverage`에 담겨 나온다. base에서 통과하는 CMD는 변경 전에도 통과한다는 뜻이므로 이번 작업을 판정하지 못할 수 있다. 자동 거부는 하지 않으니 사람이 보고 판단한다.

검증 명령은 멱등·비파괴여야 한다. runner가 base_sha에서 한 번, 구현 뒤에 또 한 번 실행하기 때문이다. 배포·마이그레이션은 검증이 아니라 작업이다.

출력의 `runId`를 복사한다. 이후 모든 명령은 이 ID를 명시한다.

```powershell
$run = '<runId>'
node .\harness.mjs run --run $run
node .\harness.mjs status --run $run
```

`run`은 현재 상태의 자동 단계를 실행하고 다음 중 하나에서 멈춘다.

- `AWAIT_PLAN_APPROVAL`: 계획 검토 가능
- `READY_FOR_MANUAL_MERGE`: 구현 diff와 필수 검증 통과
- `NEEDS_HUMAN`: 수렴 정지, 예산 소진, 경계 위반, 또는 SPEC 결함. `lastError`와 `lastErrorDetail.next_action` 확인

## 5. 계획 읽고 결정

`status` 출력의 `currentPlanPath`, `currentPlanSha`를 사용한다. 실제 파일은 다음 아래에 있다.

```text
.harness/runs/<runId>/
  SPEC.md
  plan/
  reviews/
  decisions/
  evidence/
  implementation.diff
  implementation-manifest.json
  run.json
  events.jsonl
```

계획이 좋으면 exact SHA로 승인한다.

```powershell
node .\harness.mjs approve-plan --run $run --plan-sha '<currentPlanSha>'
node .\harness.mjs run --run $run
```

승인된 구현은 source를 commit하지 않는다. `READY_FOR_MANUAL_MERGE`에서 `changedPaths`, `implementationDigest`, `verificationEvidence`와 writer worktree diff를 사람이 확인한다.

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

중단한 run의 최신 계획을 수정된 SPEC의 시작점으로 이어받으려면 명시적으로 parent를 지정한다. 동일 입력으로 예산만 초기화하는 재시작은 거부되고, 계보 전체 리뷰는 기본 6회에서 멈춘다.

```powershell
node .\harness.mjs start `
  --repo "D:\path\to\target-repo" `
  --spec "D:\path\to\revised-SPEC.md" `
  --parent-run $run
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

- checkpoint별 Claude 코드 리뷰·Codex fix 루프는 아직 없다.
- verification command는 SPEC `## 계약` 섹션에서 `CMD-001: \`실행할 명령\`` 형식이어야 한다. `## 맥락` 섹션의 언급은 파싱되지 않는다.
- GitHub 자동 병합은 없다. 최종 병합은 사람이 한다.
- Orca orchestration은 쓰지 않는다.
- Cursor 독립 감사는 아직 없다.
