# Orca harness 진입점 설계

## 문제

현재 runner는 상태와 증거를 안전하게 소유하지만 사용자가 매번 `node harness.mjs ... --run <run-id>`를 복사해야 한다. Orca에서 생성된 external writer worktree도 숨겨질 수 있어 실제 작업 위치를 찾기 어렵다.

## 유지할 불변조건

- `.harness/runs/<run-id>/`와 Node runner가 유일한 상태 정본이다.
- 모델은 다음 상태를 정하거나 사람 승인을 대신하지 않는다.
- 여러 run이 있으면 암묵적으로 하나를 고르지 않는다.
- Orca가 꺼져도 같은 runner 명령으로 재개할 수 있다.
- Agent Permissions는 `Manual`이며 bypass 또는 yolo 인자는 제거한다.
- 메뉴 항목 하나는 공개 runner 서브커맨드 하나만 호출한다. 메뉴와 Skill은 `.harness`를 직접 수정하거나 별도 전이를 구현하지 않는다. 복합 전이는 runner 서브커맨드 내부가 소유한다.

## 선택지

1. **원시 Control terminal만 사용**: 안전하지만 명령과 run ID를 외워야 하므로 사용성이 나쁘다.
2. **Claude Skill을 주 진입점으로 사용**: 편하지만 Claude가 실행 선택과 상태를 소유하기 쉬워지고 Claude가 없으면 조작할 수 없다.
3. **결정론적 launcher를 Orca Quick Command로 실행하고 Claude Skill은 선택 어댑터로 사용**: 사용성 문제를 없애면서 runner 정본을 유지한다.

3번을 채택한다.

## 저장소와 run 해석

launcher는 현재 디렉터리의 Git root와 canonical `git rev-parse --git-common-dir`를 구한다.

1. 현재 Git root가 어느 `run.json.worktree_path`와 정확히 일치하면 그 소유 run으로 바로 연결한다.
2. 아니면 canonical git-common-dir가 같은 대상 저장소의 활성 run을 찾는다.
3. 활성 run이 하나면 그 run을 사용하고, 둘 이상이면 사람이 선택한다.
4. 일치하는 run이 없을 때만 새 run을 제안한다.

`--git-common-dir`는 본 저장소 경로를 추측하는 용도가 아니라 동일 저장소를 판별하는 식별자로만 사용한다.

## 사용자 흐름

### 새 프로젝트 시작

1. 대상 Git 저장소를 Orca에 등록하고 그 저장소의 worktree를 연다.
2. 모든 저장소에 한 번만 등록한 Global Quick Command `Harness`를 누른다.
3. launcher는 현재 Orca worktree의 저장소를 자동 인식한다.
4. 활성 run이 없으면 SPEC 경로를 입력받아 공개 runner `start`를 한 번 호출한다. `start` 내부가 `init → run`을 소유한다.
5. 활성 run이 하나면 상태와 허용된 사람 행동을 표시한다.
6. 활성 run이 둘 이상이면 목록을 보여주고 사용자가 하나를 고르게 한다.

### 승인과 재개

- `PLAN_LOOP`이면 `계속`은 `run`을 한 번 호출한다.
- `AWAIT_PLAN_APPROVAL`이면 `승인`, `보완`, `취소`가 각각 `approve-plan`, `request-plan-revision`, `abort`를 한 번 호출한다.
- `NEEDS_HUMAN`이면 오류와 현재 runner가 지원하는 안전한 선택지만 표시한다.
- 재부팅 뒤 같은 `Harness` Quick Command를 누르면 파일 원장에서 run 목록을 다시 읽는다.
- 원시 `node harness.mjs ...` 명령은 복구용 fallback으로 문서에 남긴다.

## Claude Skill의 역할

개인 Claude Skill `/harness`는 선택 사항이다. Skill은 launcher를 그대로 호출하고 결과를 설명할 수 있지만 다음을 금지한다.

- `.harness` 상태 직접 수정
- run 자동 선택
- 계획 승인 또는 merge 승인 대행
- runner와 다른 전이 규칙 보유

Quick Command와 Skill은 서로 다른 하네스가 아니라 같은 launcher의 두 진입점이다.

## Orca 설정

- Settings > Agents > Agent Permissions: `Manual`
- Claude, Codex, Cursor custom arguments: bypass/yolo 계열 제거
- Settings > Quick Commands: `Harness`, Global 범위, 현재 worktree에서 launcher 실행
- 대상 저장소의 external worktree: 프로젝트 메뉴에서 숨김을 해제하고 runner가 만든 writer worktree를 import 또는 표시
- 새 작업 시작의 기본 agent: Claude. 실제 Codex writer와 Claude reviewer 프로세스는 runner가 역할에 맞춰 실행
- `agent-harness` 저장소의 `Harness Control` 터미널은 개발과 복구에만 사용
- Orca orchestration은 사용하지 않는다.

## 최소 변경 범위

- runner에 저장소별 run 조회와 `start` 서브커맨드를 추가한다.
- launcher는 현재 Git 저장소와 소유 run을 찾고 허용된 runner 명령만 호출한다.
- PLAN과 README의 “Control terminal만 유일한 조작 표면”을 “runner가 유일한 상태 전이 표면”으로 교정한다.
- README의 기본 사용법은 Global Quick Command 한 번으로 바꾸고 원시 명령은 fallback으로 내린다.
- 개인 Claude Skill은 동일 launcher 호출만 담당한다.

## 오류 처리

- Git 저장소가 아니면 시작하지 않고 이유를 표시한다.
- SPEC이 없으면 상태를 만들지 않는다.
- 활성 run이 여러 개면 반드시 사용자가 고른다.
- runner 또는 provider 오류는 기존 `NEEDS_HUMAN` 규칙을 그대로 따른다.
- Quick Command 또는 Skill 실패가 `.harness` 파일을 별도로 수정하지 않는다.

## 검증

- runner 단위 테스트: 활성 run 0개, 1개, 여러 개와 repo 경로 정규화.
- writer worktree 테스트: 그 pane에서 실행하면 새 init이 아니라 소유 run으로 연결.
- 승인 동등성 테스트: launcher 승인과 원시 `approve-plan`이 timestamp와 run별 경로를 제외한 `run.json` 승인 필드와 `events.jsonl` 전이 필드를 동일하게 기록.
- launcher 스모크 테스트: 다른 대상 repo에서 run ID를 직접 입력하지 않고 시작하고 재개.
- Orca 테스트: Global Quick Command가 현재 worktree를 대상으로 실행.
- 재부팅 테스트: Orca 재시작 후 같은 버튼으로 같은 run 재개.
- 독립성 테스트: Orca와 Claude를 종료해도 원시 runner 명령으로 같은 상태 조회.

## 의도적으로 하지 않는 것

- 별도 데몬, 전역 current-run 포인터, Orca orchestration, 자동 승인, 자동 merge
- Quick Command와 Skill에 별도 상태머신 구현
- 여러 활성 run 중 최근 항목 임의 선택
