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
  if (state === 'PLAN_LOOP') return [['continue', 'Continue'], ['abort', 'Abort']];
  if (state === 'AWAIT_PLAN_APPROVAL') return [['approve', 'Approve plan'], ['revise', 'Request revision'], ['abort', 'Abort']];
  return [['abort', 'Abort'], ['exit', 'Exit']];
}

async function chooseRun(listed, ask, write) {
  const runId = listed.ownerRunId ?? listed.selectedRunId;
  if (runId) return runId;
  listed.runs.forEach((run, index) => write(`${index + 1}. ${run.runId}`));
  const selection = Number(await ask('Select a run: '));
  const run = listed.runs[selection - 1];
  if (!run) throw new Error('invalid run selection');
  return run.runId;
}

export async function launch({ cwd = process.cwd(), runner = runCommand, ask, write = console.log } = {}) {
  if (!ask) throw new Error('launcher requires ask');
  const listed = await runner(['list', '--repo', cwd]);
  if (listed.runs.length === 0) {
    const spec = await ask('SPEC path: ');
    if (!spec?.trim()) throw new Error('SPEC path is required');
    return runner(['start', '--repo', cwd, '--spec', spec.trim()]);
  }

  const runId = await chooseRun(listed, ask, write);
  const run = await runner(['status', '--run', runId]);
  write(`State: ${run.state}${run.lastError ? `\nError: ${run.lastError}` : ''}`);
  const menu = menuFor(run.state);
  menu.forEach(([, label], index) => write(`${index + 1}. ${label}`));
  const action = menu[Number(await ask('Select an action: ')) - 1]?.[0];
  if (!action) throw new Error('invalid action selection');
  if (action === 'exit') return run;
  const input = {};
  if (action === 'revise') input.noteFile = await ask('Revision note file: ');
  if (action === 'abort') input.reason = await ask('Abort reason: ');
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
