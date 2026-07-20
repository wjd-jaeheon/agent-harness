import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

import { runCommand } from './harness.mjs';

export function actionArgv(action, run, input = {}) {
  if (action === 'continue') return ['run', '--run', run.runId];
  if (action === 'approve') return ['approve-plan', '--run', run.runId, '--plan-sha', run.currentPlanSha];
  if (action === 'revise') return ['request-plan-revision', '--run', run.runId, '--note-file', input.noteFile];
  if (action === 'abort') return ['abort', '--run', run.runId, '--reason', input.reason];
  throw new Error(`unsupported launcher action: ${action}`);
}

function menuFor(state) {
  if (state === 'ABORTED' || state === 'DONE') return [['exit', 'Exit']];
  if (state === 'PLAN_LOOP') return [['continue', 'Continue'], ['abort', 'Abort']];
  if (state === 'AWAIT_PLAN_APPROVAL') return [['approve', 'Approve plan'], ['revise', 'Request revision'], ['abort', 'Abort']];
  return [['abort', 'Abort'], ['exit', 'Exit']];
}

const CLAUDE_PLAN_PROMPT = 'What work would you like to plan? Do not implement anything. Discuss the task, then wait for my plan approval before making changes.';

export async function launch({ cwd = process.cwd(), runner = runCommand, ask, write = console.log } = {}) {
  if (!ask) throw new Error('launcher requires ask');
  const listed = await runner(['list', '--repo', cwd]);
  for (const warning of listed.warnings ?? []) {
    write(`Warning [${warning.runId}]: ${warning.message}`);
  }
  const entryMenu = [
    ['new', 'New task with Claude'],
    ...listed.runs.map((run) => ['resume', `Resume saved task: ${run.taskSummary} [${run.state}]`, run]),
    ['exit', 'Exit'],
  ];
  entryMenu.forEach(([, label], index) => write(`${index + 1}. ${label}`));
  const entry = entryMenu[Number(await ask('Select a task: ')) - 1];
  if (!entry) throw new Error('invalid task selection');
  if (entry[0] === 'new') {
    return { type: 'start-claude-plan', cwd: listed.repoPath, prompt: CLAUDE_PLAN_PROMPT };
  }
  if (entry[0] === 'exit') return { type: 'exit' };

  const selected = entry[2];
  write(`Selected: ${selected.runId} | ${selected.worktreePath}`);
  const run = await runner(['status', '--run', selected.runId]);
  write(`State: ${run.state}${run.lastError ? `\nError: ${run.lastError}` : ''}`);
  if (run.state === 'AWAIT_PLAN_APPROVAL') {
    write(`Plan: ${run.currentPlanPath}`);
    write(`Plan SHA: ${run.currentPlanSha}`);
  }
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

function startClaudePlan(request) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['--permission-mode', 'plan', request.prompt], {
      cwd: request.cwd,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { createInterface } = await import('node:readline/promises');
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const result = await launch({ ask: (prompt) => readline.question(prompt) });
    if (result.type === 'start-claude-plan') {
      readline.close();
      const { code, signal } = await startClaudePlan(result);
      if (code !== 0 && code !== null) process.exitCode = code;
      if (signal) process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } finally {
    readline.close();
  }
}
