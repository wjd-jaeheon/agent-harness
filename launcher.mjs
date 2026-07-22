import { pathToFileURL } from 'node:url';

import { runCommand } from './harness.mjs';

export function actionArgv(action, run, input = {}) {
  if (action === 'continue') return ['run', '--run', run.runId];
  if (action === 'approve') return ['approve-plan', '--run', run.runId, '--plan-sha', run.currentPlanSha];
  if (action === 'revise') return ['request-plan-revision', '--run', run.runId, '--note-file', input.noteFile];
  if (action === 'abort') return ['abort', '--run', run.runId, '--reason', input.reason];
  throw new Error(`unsupported launcher action: ${action}`);
}

function menuFor(state) {
  if (state === 'ABORTED' || state === 'DONE') return [['exit', '종료']];
  if (state === 'PLAN_LOOP') return [['continue', '계속'], ['abort', '중단']];
  if (state === 'AWAIT_PLAN_APPROVAL') return [['approve', '계획 승인'], ['revise', '계획 보완 요청'], ['abort', '중단']];
  return [['abort', '중단'], ['exit', '종료']];
}

export async function launch({ cwd = process.cwd(), runner = runCommand, ask, write = console.log } = {}) {
  if (!ask) throw new Error('launcher requires ask');
  const listed = await runner(['list', '--repo', cwd]);
  for (const warning of listed.warnings ?? []) {
    write(`경고 [${warning.runId}]: ${warning.message}`);
  }
  if (listed.runs.length === 0) {
    write('저장된 작업이 없습니다. 새 작업은 Claude Code에서 /pingpong <작업 설명>으로 시작하세요.');
    return { type: 'exit' };
  }
  const entryMenu = [
    ...listed.runs.map((run) => ['resume', `저장 작업 이어가기: ${run.taskSummary} [${run.state}]`, run]),
    ['exit', '종료'],
  ];
  entryMenu.forEach(([, label], index) => write(`${index + 1}. ${label}`));
  const entry = entryMenu[Number(await ask('작업을 선택하세요: ')) - 1];
  if (!entry) throw new Error('invalid task selection');
  if (entry[0] === 'exit') return { type: 'exit' };

  const selected = entry[2];
  write(`선택: ${selected.runId} | ${selected.worktreePath}`);
  const run = await runner(['status', '--run', selected.runId]);
  write(`상태: ${run.state}${run.lastError ? `\n오류: ${run.lastError}` : ''}`);
  if (run.state === 'AWAIT_PLAN_APPROVAL') {
    write(`계획: ${run.currentPlanPath}`);
    write(`계획 SHA: ${run.currentPlanSha}`);
  }
  const menu = menuFor(run.state);
  menu.forEach(([, label], index) => write(`${index + 1}. ${label}`));
  const action = menu[Number(await ask('행동을 선택하세요: ')) - 1]?.[0];
  if (!action) throw new Error('invalid action selection');
  if (action === 'exit') return run;
  const input = {};
  if (action === 'revise') input.noteFile = await ask('보완 요청 파일: ');
  if (action === 'abort') input.reason = await ask('중단 사유: ');
  return runner(actionArgv(action, run, input));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { createInterface } = await import('node:readline/promises');
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const result = await launch({ ask: (prompt) => readline.question(prompt) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } finally {
    readline.close();
  }
}
