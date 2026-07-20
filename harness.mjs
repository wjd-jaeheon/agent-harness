import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TERMINAL_STATES = new Set([
  'AWAIT_PLAN_APPROVAL',
  'NEEDS_HUMAN',
  'IMPLEMENT_LOOP',
  'ABORTED',
  'DONE',
]);
const DEFAULT_POLICY = {
  budgets: { plan_review_max: 2, human_plan_revision_max: 1 },
};
const REVISER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plan_markdown: { type: 'string', minLength: 1 },
    decisions_markdown: { type: 'string', minLength: 1 },
  },
  required: ['plan_markdown', 'decisions_markdown'],
};

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function renderPrompt(template, inputs) {
  return `${template.trim()}\n\n## Inputs (verbatim JSON)\n\n${JSON.stringify(inputs, null, 2)}\n`;
}

function parseClaudeStructured(stdout) {
  const envelope = JSON.parse(stdout);
  let value = envelope?.structured_output ?? envelope;
  if (typeof value === 'string') value = JSON.parse(value);
  if (
    typeof value?.plan_markdown !== 'string' ||
    typeof value?.decisions_markdown !== 'string' ||
    !value.plan_markdown.trim() ||
    !value.decisions_markdown.trim()
  ) {
    throw new Error('Claude structured output is invalid');
  }
  return value;
}

async function killChild(child) {
  if (!child.pid) return;
  const waitForClose = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('close', resolve));
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
  } else {
    child.kill('SIGKILL');
  }
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch {}
  }
  await waitForClose;
}

export function runProcess({ command, args, cwd, input = '', timeoutMs = 30 * 60 * 1000, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(async () => {
      timedOut = true;
      try {
        await killChild(child);
        finish(() => reject(new Error(`${command} timed out`)));
      } catch (error) {
        finish(() => reject(error));
      }
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (!timedOut) finish(() => reject(error));
    });
    child.on('close', (code) => {
      if (!timedOut) {
        finish(() => resolve({
          exitCode: code ?? 5,
          stdout,
          stderr,
        }));
      }
    });
    child.stdin.end(input);
  });
}

export function createDefaultProviderRunner({
  harnessRoot = HERE,
  env = process.env,
  processRunner = runProcess,
  commands = {},
} = {}) {
  const resolvedCommands = {
    claude: commands.claude ?? 'claude',
    codex: commands.codex ?? 'codex',
    powershell: commands.powershell ?? 'powershell.exe',
    agentScript: commands.agentScript ?? path.join(env.LOCALAPPDATA ?? '', 'cursor-agent', 'agent.ps1'),
  };
  const prompt = async (name, inputs) => renderPrompt(
    await readFile(path.join(harnessRoot, 'prompts', name), 'utf8'),
    inputs,
  );

  return async (request) => {
    if (request.provider === 'cursor') {
      if (env.CURSOR_API_KEY?.trim()) {
        return {
          exitCode: 5,
          stdout: '',
          stderr: 'CURSOR_API_KEY is forbidden; use Cursor subscription login',
          scout: '',
        };
      }
      const scoutPrompt = await prompt('cursor-scout.md', request.inputs);
      const result = await processRunner({
        command: resolvedCommands.powershell,
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          resolvedCommands.agentScript,
          '-p',
          '--output-format',
          'text',
          '--mode',
          'plan',
          '--sandbox',
          'enabled',
          '--workspace',
          request.cwd,
          '--trust',
          scoutPrompt,
        ],
        cwd: request.cwd,
        env,
      });
      return { ...result, scout: result.stdout };
    }

    if (request.provider === 'claude') {
      if (env.ANTHROPIC_API_KEY?.trim()) {
        throw new Error('ANTHROPIC_API_KEY is forbidden; use Claude subscription login');
      }
      const revising = request.step === 'claude_plan_revise';
      const input = await prompt(revising ? 'plan-reviser.md' : 'planner.md', request.inputs);
      const args = [
        '-p',
        '--output-format',
        revising ? 'json' : 'text',
        '--permission-mode',
        'plan',
        '--tools',
        'Read,Glob,Grep',
        '--no-session-persistence',
      ];
      if (revising) args.push('--json-schema', JSON.stringify(REVISER_SCHEMA));
      const result = await processRunner({
        command: resolvedCommands.claude,
        args,
        cwd: request.cwd,
        input,
        env,
      });
      if (!revising) return { ...result, plan: result.stdout };
      if (result.exitCode !== 0) return { ...result, plan: '', decision: '' };
      let structured;
      try {
        structured = parseClaudeStructured(result.stdout);
      } catch (error) {
        return { ...result, plan: '', decision: '', adapterError: error.message };
      }
      return {
        ...result,
        plan: structured.plan_markdown,
        decision: structured.decisions_markdown,
      };
    }

    if (request.provider === 'codex') {
      if (env.OPENAI_API_KEY?.trim() || env.CODEX_API_KEY?.trim()) {
        throw new Error('OPENAI_API_KEY/CODEX_API_KEY is forbidden; use ChatGPT subscription login');
      }
      const input = await prompt('plan-reviewer.md', { ...request.inputs, round: request.round });
      const temporary = await mkdtemp(path.join(tmpdir(), 'agent-harness-codex-'));
      const output = path.join(temporary, 'last-message.json');
      try {
        const result = await processRunner({
          command: resolvedCommands.codex,
          args: [
            'exec',
            '--sandbox',
            'read-only',
            '--json',
            '--output-schema',
            path.join(harnessRoot, 'schemas', 'review-output.schema.json'),
            '--output-last-message',
            output,
            '--ephemeral',
            '--color',
            'never',
            '-',
          ],
          cwd: request.cwd,
          input,
          env,
        });
        if (result.exitCode !== 0) return { ...result, review: null };
        try {
          return {
            ...result,
            review: JSON.parse(await readFile(output, 'utf8')),
          };
        } catch (error) {
          return { ...result, review: null, adapterError: error.message };
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }

    throw new Error(`unsupported provider: ${request.provider}`);
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) throw new Error('command is required');
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2).replaceAll('-', '_');
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`value required for ${token}`);
    values[key] = value;
    index += 1;
  }
  return { command, values };
}

function requireValue(values, key) {
  if (!values[key]) throw new Error(`--${key.replaceAll('_', '-')} is required`);
  return values[key];
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function atomicWrite(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, file);
}

async function atomicJson(file, value) {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runRoot(harnessRoot, runId) {
  return path.join(harnessRoot, '.harness', 'runs', runId);
}

function runFile(harnessRoot, runId) {
  return path.join(runRoot(harnessRoot, runId), 'run.json');
}

async function loadRun(harnessRoot, runId) {
  return JSON.parse(await readFile(runFile(harnessRoot, runId), 'utf8'));
}

async function saveRun(harnessRoot, run) {
  await atomicJson(runFile(harnessRoot, run.run_id), run);
}

async function event(harnessRoot, run, action, result, previousState = run.state) {
  const record = {
    at: new Date().toISOString(),
    previous_state: previousState,
    state: run.state,
    action,
    result,
    plan_version: run.plan_version,
    plan_review_round: run.plan_review_round,
  };
  await appendFile(
    path.join(runRoot(harnessRoot, run.run_id), 'events.jsonl'),
    `${JSON.stringify(record)}\n`,
    'utf8',
  );
}

async function setState(harnessRoot, run, state, action, result) {
  const previous = run.state;
  run.state = state;
  await saveRun(harnessRoot, run);
  await event(harnessRoot, run, action, result, previous);
}

async function gitOutput(gitExecutable, cwd, args) {
  const { stdout } = await exec(gitExecutable, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gitSnapshot(run, gitExecutable) {
  const head = await gitOutput(gitExecutable, run.worktree_path, ['rev-parse', 'HEAD']);
  const status = await gitOutput(gitExecutable, run.worktree_path, [
    'status',
    '--porcelain=v1',
    '-z',
  ]);
  return { head, status_hash: sha256Bytes(Buffer.from(status)) };
}

function extractIds(text, prefix) {
  return [...new Set(text.match(new RegExp(`\\b${prefix}-\\d{3}\\b`, 'g')) ?? [])];
}

function validateSpec(text) {
  const acceptanceIds = extractIds(text, 'AC');
  const commandIds = extractIds(text, 'CMD');
  if (acceptanceIds.length === 0) throw new Error('SPEC requires at least one AC-###');
  if (commandIds.length === 0) throw new Error('SPEC requires at least one CMD-###');
  return { acceptanceIds, commandIds };
}

function parseScout(text) {
  if (!text?.trim()) throw new Error('Scout output is empty');
  const blocks = text.trim().split(/\r?\n(?=SCOUT-\d{3}\s*\|)/);
  const pattern = /^SCOUT-(\d{3})\s*\|\s*(reuse|impact|test|risk|unknown)\s*\r?\nevidence:\s*(.+)\r?\nnote:\s*(.+)$/;
  const items = [];
  for (const [index, block] of blocks.entries()) {
    const match = block.match(pattern);
    if (!match) throw new Error('Scout output has invalid format or surrounding prose');
    const expected = String(index + 1).padStart(3, '0');
    if (match[1] !== expected) throw new Error('Scout IDs must be sequential from SCOUT-001');
    items.push({ id: `SCOUT-${match[1]}`, category: match[2] });
  }
  if (items.length === 0) throw new Error('Scout output has invalid format');
  return items;
}

function validatePlan(text, run) {
  if (!text?.trim()) return { valid: false, reason: 'plan is empty' };
  if (extractIds(text, 'CP').length === 0) return { valid: false, reason: 'plan needs CP-###' };
  for (const id of run.spec.acceptance_ids) {
    if (!text.includes(id)) return { valid: false, reason: `plan is missing ${id}` };
  }
  if (!run.spec.command_ids.some((id) => text.includes(id))) {
    return { valid: false, reason: 'plan is missing CMD-###' };
  }
  if (run.cursor.scout_status === 'completed') {
    for (const id of run.cursor.scout_ids) {
      const escaped = id.replace('-', '\\-');
      const disposition = new RegExp(
        `^${escaped}:\\s*(incorporated|rejected)\\s*(?:—|-)\\s*.+$`,
        'm',
      );
      if (!disposition.test(text)) {
        return { valid: false, reason: `plan is missing disposition for ${id}` };
      }
    }
  }
  return { valid: true, reason: null };
}

function validateDecision(text, review) {
  if (!text?.trim()) return { valid: false, reason: 'Claude decision is empty' };
  for (const finding of review.findings) {
    const escaped = finding.id.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const disposition = new RegExp(`^${escaped}:\\s*(incorporated|rejected)\\b`, 'm');
    if (!disposition.test(text)) {
      return { valid: false, reason: `Claude decision is missing ${finding.id}` };
    }
  }
  return { valid: true, reason: null };
}

function validateReviewShape(review, expectedRound) {
  if (!review || review.phase !== 'plan' || review.round !== expectedRound) {
    throw new Error('review phase or round is invalid');
  }
  for (const key of ['findings', 'prior_findings', 'ac_checks']) {
    if (!Array.isArray(review[key])) throw new Error(`review.${key} must be an array`);
  }
  if (!Number.isInteger(review.checkpoint_count) || review.checkpoint_count < 0) {
    throw new Error('review.checkpoint_count is invalid');
  }
  for (const finding of review.findings) {
    if (
      typeof finding?.id !== 'string' ||
      typeof finding.claim !== 'string' ||
      typeof finding.failure_scenario !== 'string' ||
      !['blocker', 'major', 'minor'].includes(finding.severity)
    ) {
      throw new Error('review finding is invalid');
    }
    if (
      !Array.isArray(finding.evidence) ||
      finding.evidence.some((item) => typeof item !== 'string') ||
      typeof finding.needs_evidence !== 'boolean'
    ) {
      throw new Error(`review finding ${finding.id} evidence is invalid`);
    }
  }
  for (const prior of review.prior_findings) {
    if (typeof prior?.id !== 'string' || !['resolved', 'open'].includes(prior.status)) {
      throw new Error('review prior finding is invalid');
    }
  }
  for (const check of review.ac_checks) {
    if (
      typeof check?.id !== 'string' ||
      typeof check.implementation_ref !== 'string' ||
      typeof check.verification_ref !== 'string' ||
      !['pass', 'fail', 'needs_evidence'].includes(check.status)
    ) {
      if (typeof check?.implementation_ref !== 'string') {
        throw new Error('review AC implementation_ref must be a string');
      }
      throw new Error('review AC check is invalid');
    }
  }
}

function evaluateReview(review, run, planText) {
  const reasons = [];
  const blockingIds = [];
  const plan = validatePlan(planText, run);
  if (!plan.valid) reasons.push(plan.reason);

  const priorById = new Map(review.prior_findings.map((item) => [item.id, item.status]));
  for (const id of run.previous_gate_blocking_ids) {
    if (!priorById.has(id)) reasons.push(`previous finding ${id} was not reclassified`);
    else if (priorById.get(id) === 'open') reasons.push(`previous finding ${id} remains open`);
  }

  for (const finding of review.findings) {
    const serious = finding.severity === 'blocker' || finding.severity === 'major';
    if (serious || finding.needs_evidence) {
      reasons.push(`finding ${finding.id} blocks approval`);
      blockingIds.push(finding.id);
    }
  }

  const checksById = new Map();
  for (const check of review.ac_checks) {
    if (checksById.has(check.id)) reasons.push(`AC ${check.id} is duplicated`);
    checksById.set(check.id, check);
  }
  if (checksById.size !== run.spec.acceptance_ids.length) {
    reasons.push('AC checks do not exactly match the SPEC');
  }
  for (const id of run.spec.acceptance_ids) {
    const check = checksById.get(id);
    if (!check) reasons.push(`AC ${id} is missing`);
    else if (
      check.status !== 'pass' ||
      !check.implementation_ref?.trim() ||
      !check.verification_ref?.trim()
    ) {
      reasons.push(`AC ${id} is not fully mapped and passing`);
    }
  }
  if (review.checkpoint_count < 1) reasons.push('at least one checkpoint is required');
  return { ready: reasons.length === 0, reasons, blockingIds: [...new Set(blockingIds)] };
}

async function readPolicy(harnessRoot) {
  const file = path.join(harnessRoot, 'policy.json');
  if (!(await exists(file))) return structuredClone(DEFAULT_POLICY);
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  return {
    budgets: {
      ...DEFAULT_POLICY.budgets,
      ...parsed.budgets,
    },
  };
}

async function stopForLockedInput(harnessRoot, run, label, detail) {
  run.last_error = `${label} locked digest changed${detail ? `: ${detail}` : ''}`;
  run.active_step = null;
  await setState(harnessRoot, run, 'NEEDS_HUMAN', 'locked_input', run.last_error);
  return false;
}

async function verifyLockedFile(harnessRoot, run, relative, expectedSha, label) {
  try {
    const bytes = await readFile(path.join(runRoot(harnessRoot, run.run_id), relative));
    if (sha256Bytes(bytes) !== expectedSha) {
      return stopForLockedInput(harnessRoot, run, label, 'digest mismatch');
    }
    return true;
  } catch (error) {
    return stopForLockedInput(harnessRoot, run, label, error.message);
  }
}

async function verifyLockedInputs(harnessRoot, run) {
  if (!(await verifyLockedFile(harnessRoot, run, 'SPEC.md', run.spec.sha256, 'SPEC'))) return false;
  if (
    run.cursor.scout_status === 'completed' &&
    !(await verifyLockedFile(
      harnessRoot,
      run,
      run.cursor.scout_path,
      run.cursor.scout_sha256,
      'Scout',
    ))
  ) return false;
  if (
    run.current_plan_path &&
    !(await verifyLockedFile(
      harnessRoot,
      run,
      run.current_plan_path,
      run.current_plan_sha,
      'PLAN',
    ))
  ) return false;
  return true;
}

function newRunId() {
  return `${new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

async function initCommand(values, options) {
  const repo = path.resolve(requireValue(values, 'repo'));
  const specPath = path.resolve(requireValue(values, 'spec'));
  const specBytes = await readFile(specPath);
  const specText = specBytes.toString('utf8');
  const spec = validateSpec(specText);
  const baseSha = await gitOutput(options.gitExecutable, repo, ['rev-parse', 'HEAD']);
  const inside = await gitOutput(options.gitExecutable, repo, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') throw new Error('repo must be a Git worktree');

  const runId = newRunId();
  const root = runRoot(options.harnessRoot, runId);
  const worktree = path.join(options.harnessRoot, '.harness', 'worktrees', runId);
  await mkdir(root, { recursive: true });
  await mkdir(path.dirname(worktree), { recursive: true });
  await gitOutput(options.gitExecutable, repo, ['worktree', 'add', '--detach', worktree, baseSha]);
  const status = await gitOutput(options.gitExecutable, worktree, ['status', '--porcelain=v1', '-z']);
  if (status !== '') throw new Error('new writer worktree is not clean');

  await atomicWrite(path.join(root, 'SPEC.md'), specBytes);
  await atomicWrite(path.join(root, 'events.jsonl'), '');
  const run = {
    run_id: runId,
    state: 'PLAN_LOOP',
    repo_path: repo,
    worktree_path: worktree,
    base_sha: baseSha,
    head_sha: null,
    spec: {
      acceptance_ids: spec.acceptanceIds,
      command_ids: spec.commandIds,
      sha256: sha256Bytes(specBytes),
    },
    plan_version: 0,
    plan_review_round: 0,
    human_plan_revision_count: 0,
    human_revision_target_round: null,
    pending_human_plan_revision_path: null,
    latest_human_plan_revision_path: null,
    current_plan_path: null,
    current_plan_sha: null,
    current_review_path: null,
    last_reviewed_plan_sha: null,
    previous_gate_blocking_ids: [],
    cursor: {
      scout_attempted: 0,
      scout_status: 'pending',
      scout_path: null,
      scout_sha256: null,
      scout_ids: [],
      unavailable_reason: null,
    },
    active_step: null,
    last_error: null,
    approved_plan_path: null,
    approved_plan_sha: null,
    approved_base_sha: null,
  };
  await saveRun(options.harnessRoot, run);
  await event(options.harnessRoot, run, 'init', 'created');
  return summarize(run);
}

function summarize(run) {
  return {
    runId: run.run_id,
    state: run.state,
    planVersion: run.plan_version,
    planReviewRound: run.plan_review_round,
    humanPlanRevisionCount: run.human_plan_revision_count ?? 0,
    currentPlanPath: run.current_plan_path,
    currentPlanSha: run.current_plan_sha,
    cursorScoutStatus: run.cursor.scout_status,
    lastError: run.last_error,
  };
}

function relativeOutputs(type, run, round) {
  if (type === 'cursor_scout') {
    return {
      artifact: 'reviews/cursor-scout.md',
      stdout: 'reviews/cursor-scout.raw.txt',
      stderr: 'reviews/cursor-scout.stderr.log',
    };
  }
  if (type === 'claude_plan') {
    return {
      artifact: `plan/PLAN_v${run.plan_version + 1}.md`,
      stdout: `reviews/plan-v${run.plan_version + 1}-claude.raw.txt`,
      stderr: `reviews/plan-v${run.plan_version + 1}-claude.stderr.log`,
    };
  }
  if (type === 'codex_plan_review') {
    return {
      artifact: `reviews/plan-r${round}.json`,
      stdout: `reviews/plan-r${round}.raw.jsonl`,
      stderr: `reviews/plan-r${round}.stderr.log`,
    };
  }
  return {
    artifact: `plan/PLAN_v${run.plan_version + 1}.md`,
    decision: `decisions/plan-r${run.plan_review_round}.md`,
    stdout: `reviews/plan-v${run.plan_version + 1}-claude.raw.json`,
    stderr: `reviews/plan-v${run.plan_version + 1}-claude.stderr.log`,
  };
}

async function beginStep(harnessRoot, run, type, round, inputs, gitExecutable) {
  const inputHash = sha256Bytes(Buffer.from(JSON.stringify(inputs)));
  if (run.active_step) {
    if (run.active_step.type !== type || run.active_step.input_hash !== inputHash) {
      await setState(harnessRoot, run, 'NEEDS_HUMAN', 'recovery', 'active step mismatch');
      return null;
    }
    if (run.active_step.attempt >= 2) {
      run.last_error = `${type} retry budget exhausted`;
      await setState(harnessRoot, run, 'NEEDS_HUMAN', 'recovery', run.last_error);
      return null;
    }
    run.active_step.attempt += 1;
  } else {
    const snapshot = await gitSnapshot(run, gitExecutable);
    const cleanHash = sha256Bytes(Buffer.from(''));
    if (snapshot.head !== run.base_sha || snapshot.status_hash !== cleanHash) {
      run.last_error = 'writer worktree drifted from the locked clean base';
      await setState(harnessRoot, run, 'NEEDS_HUMAN', type, run.last_error);
      return null;
    }
    run.active_step = {
      type,
      round,
      input_hash: inputHash,
      pre_head: snapshot.head,
      pre_status_hash: snapshot.status_hash,
      attempt: 1,
      outputs: relativeOutputs(type, run, round),
    };
  }
  await saveRun(harnessRoot, run);
  return run.active_step;
}

async function recordStepFailure(harnessRoot, run, error) {
  const message = error instanceof Error ? error.message : String(error);
  run.last_error = message;
  if (run.active_step?.attempt >= 2) {
    const type = run.active_step.type;
    run.active_step = null;
    await setState(harnessRoot, run, 'NEEDS_HUMAN', type, message);
    return true;
  }
  await saveRun(harnessRoot, run);
  return false;
}

async function unchangedAfterStep(run, gitExecutable) {
  const after = await gitSnapshot(run, gitExecutable);
  return after.head === run.active_step.pre_head && after.status_hash === run.active_step.pre_status_hash;
}

async function writeProviderLogs(root, outputs, result) {
  if (outputs.stdout) await atomicWrite(path.join(root, outputs.stdout), result.stdout ?? '');
  if (outputs.stderr) await atomicWrite(path.join(root, outputs.stderr), result.stderr ?? '');
}

async function finishStep(harnessRoot, run) {
  run.active_step = null;
  run.last_error = null;
  await saveRun(harnessRoot, run);
}

async function markBoundaryViolation(harnessRoot, run, type) {
  run.last_error = `${type} changed HEAD or worktree status`;
  run.active_step = null;
  await setState(harnessRoot, run, 'NEEDS_HUMAN', type, run.last_error);
}

async function resumeActiveStep(harnessRoot, run, gitExecutable) {
  if (!run.active_step) return;
  const root = runRoot(harnessRoot, run.run_id);
  const { type, outputs, round } = run.active_step;
  if (
    run.active_step.pre_head !== run.base_sha ||
    run.active_step.pre_status_hash !== sha256Bytes(Buffer.from(''))
  ) {
    await markBoundaryViolation(harnessRoot, run, type);
    return;
  }
  if (!(await unchangedAfterStep(run, gitExecutable))) {
    await markBoundaryViolation(harnessRoot, run, type);
    return;
  }
  try {
    if (type === 'cursor_scout' && await exists(path.join(root, outputs.artifact))) {
      const text = await readFile(path.join(root, outputs.artifact), 'utf8');
      const items = parseScout(text);
      run.cursor.scout_status = 'completed';
      run.cursor.scout_path = outputs.artifact;
      run.cursor.scout_sha256 = sha256Bytes(Buffer.from(text));
      run.cursor.scout_ids = items.map((item) => item.id);
      await finishStep(harnessRoot, run);
      return;
    }
    if (type === 'claude_plan' && await exists(path.join(root, outputs.artifact))) {
      const text = await readFile(path.join(root, outputs.artifact), 'utf8');
      const validation = validatePlan(text, run);
      if (!validation.valid) throw new Error(validation.reason);
      run.plan_version += 1;
      run.current_plan_path = outputs.artifact;
      run.current_plan_sha = sha256Bytes(Buffer.from(text));
      await finishStep(harnessRoot, run);
      return;
    }
    if (type === 'codex_plan_review' && await exists(path.join(root, outputs.artifact))) {
      const review = JSON.parse(await readFile(path.join(root, outputs.artifact), 'utf8'));
      validateReviewShape(review, round);
      run.plan_review_round = round;
      run.current_review_path = outputs.artifact;
      run.last_reviewed_plan_sha = run.current_plan_sha;
      await finishStep(harnessRoot, run);
      return;
    }
    if (
      type === 'claude_plan_revise' &&
      await exists(path.join(root, outputs.artifact)) &&
      await exists(path.join(root, outputs.decision))
    ) {
      const text = await readFile(path.join(root, outputs.artifact), 'utf8');
      const decision = await readFile(path.join(root, outputs.decision), 'utf8');
      const review = JSON.parse(await readFile(path.join(root, run.current_review_path), 'utf8'));
      const planValidation = validatePlan(text, run);
      const decisionValidation = validateDecision(decision, review);
      if (!planValidation.valid) throw new Error(planValidation.reason);
      if (!decisionValidation.valid) throw new Error(decisionValidation.reason);
      run.plan_version += 1;
      run.current_plan_path = outputs.artifact;
      run.current_plan_sha = sha256Bytes(Buffer.from(text));
      run.pending_human_plan_revision_path = null;
      await finishStep(harnessRoot, run);
      return;
    }
  } catch {
    // Incomplete or invalid saved output follows the normal retry path below.
  }
  if (type === 'cursor_scout') {
    run.cursor.scout_status = 'unavailable';
    run.cursor.unavailable_reason = 'Scout was interrupted';
    run.active_step = null;
    await saveRun(harnessRoot, run);
  }
}

async function callScout(harnessRoot, run, providerRunner, gitExecutable) {
  const root = runRoot(harnessRoot, run.run_id);
  const specText = await readFile(path.join(root, 'SPEC.md'), 'utf8');
  const inputs = { spec: specText, base_sha: run.base_sha };
  run.cursor.scout_attempted = 1;
  const step = await beginStep(harnessRoot, run, 'cursor_scout', 1, inputs, gitExecutable);
  if (!step) return;
  let result;
  try {
    result = await providerRunner({
      step: 'cursor_scout',
      provider: 'cursor',
      runId: run.run_id,
      round: 1,
      cwd: run.worktree_path,
      inputs,
    });
  } catch (error) {
    result = { exitCode: 5, stdout: '', stderr: error.message, scout: '' };
  }
  await writeProviderLogs(root, step.outputs, result);
  if (!(await unchangedAfterStep(run, gitExecutable))) {
    await markBoundaryViolation(harnessRoot, run, 'cursor_scout');
    return;
  }
  try {
    if (result.exitCode !== 0) throw new Error(result.stderr || `exit ${result.exitCode}`);
    const items = parseScout(result.scout);
    await atomicWrite(path.join(root, step.outputs.artifact), result.scout);
    run.cursor.scout_status = 'completed';
    run.cursor.scout_path = step.outputs.artifact;
    run.cursor.scout_sha256 = sha256Bytes(Buffer.from(result.scout));
    run.cursor.scout_ids = items.map((item) => item.id);
  } catch (error) {
    run.cursor.scout_status = 'unavailable';
    run.cursor.unavailable_reason = error.message;
  }
  await finishStep(harnessRoot, run);
}

async function callPlanner(harnessRoot, run, providerRunner, gitExecutable) {
  const root = runRoot(harnessRoot, run.run_id);
  const specText = await readFile(path.join(root, 'SPEC.md'), 'utf8');
  const scoutText = run.cursor.scout_path
    ? await readFile(path.join(root, run.cursor.scout_path), 'utf8')
    : '';
  const inputs = {
    spec: specText,
    scout: scoutText,
    scout_status: run.cursor.scout_status,
    scout_sha256: run.cursor.scout_sha256,
  };
  const step = await beginStep(harnessRoot, run, 'claude_plan', 1, inputs, gitExecutable);
  if (!step) return;
  let result;
  try {
    result = await providerRunner({
      step: 'claude_plan',
      provider: 'claude',
      runId: run.run_id,
      round: 1,
      cwd: run.worktree_path,
      inputs,
    });
  } catch (error) {
    result = { exitCode: 5, stdout: '', stderr: error.message, plan: '' };
  }
  await writeProviderLogs(root, step.outputs, result);
  if (!(await unchangedAfterStep(run, gitExecutable))) {
    await markBoundaryViolation(harnessRoot, run, 'claude_plan');
    return;
  }
  const validation = validatePlan(result.plan, run);
  if (result.exitCode !== 0 || !validation.valid) {
    const error = new Error(result.adapterError || result.stderr || validation.reason);
    if (!(await recordStepFailure(harnessRoot, run, error))) throw error;
    return;
  }
  await atomicWrite(path.join(root, step.outputs.artifact), result.plan);
  run.plan_version += 1;
  run.current_plan_path = step.outputs.artifact;
  run.current_plan_sha = sha256Bytes(Buffer.from(result.plan));
  await finishStep(harnessRoot, run);
}

async function callReviewer(harnessRoot, run, providerRunner, gitExecutable) {
  const root = runRoot(harnessRoot, run.run_id);
  const round = run.plan_review_round + 1;
  const specText = await readFile(path.join(root, 'SPEC.md'), 'utf8');
  const planText = await readFile(path.join(root, run.current_plan_path), 'utf8');
  const scoutText = run.cursor.scout_path
    ? await readFile(path.join(root, run.cursor.scout_path), 'utf8')
    : '';
  const previousReview = run.current_review_path
    ? JSON.parse(await readFile(path.join(root, run.current_review_path), 'utf8'))
    : null;
  const previousDecisionPath = run.plan_review_round > 0
    ? path.join(root, `decisions/plan-r${run.plan_review_round}.md`)
    : null;
  const previousDecision = previousDecisionPath && await exists(previousDecisionPath)
    ? await readFile(previousDecisionPath, 'utf8')
    : '';
  const inputs = {
    spec: specText,
    plan: planText,
    scout: scoutText,
    scout_sha256: run.cursor.scout_sha256,
    previous_gate_blocking_ids: run.previous_gate_blocking_ids,
    previous_review: previousReview,
    previous_decision: previousDecision,
    human_revision_note: run.latest_human_plan_revision_path
      ? await readFile(path.join(root, run.latest_human_plan_revision_path), 'utf8')
      : '',
  };
  const step = await beginStep(harnessRoot, run, 'codex_plan_review', round, inputs, gitExecutable);
  if (!step) return null;
  let result;
  try {
    result = await providerRunner({
      step: 'codex_plan_review',
      provider: 'codex',
      runId: run.run_id,
      round,
      cwd: run.worktree_path,
      inputs,
    });
  } catch (error) {
    result = { exitCode: 5, stdout: '', stderr: error.message, review: null };
  }
  await writeProviderLogs(root, step.outputs, result);
  if (!(await unchangedAfterStep(run, gitExecutable))) {
    await markBoundaryViolation(harnessRoot, run, 'codex_plan_review');
    return null;
  }
  try {
    if (result.exitCode !== 0 || result.adapterError) {
      throw new Error(result.adapterError || result.stderr || `Codex review exit ${result.exitCode}`);
    }
    validateReviewShape(result.review, round);
  } catch (error) {
    if (!(await recordStepFailure(harnessRoot, run, error))) throw error;
    return null;
  }
  await atomicJson(path.join(root, step.outputs.artifact), result.review);
  run.plan_review_round = round;
  run.current_review_path = step.outputs.artifact;
  run.last_reviewed_plan_sha = run.current_plan_sha;
  await finishStep(harnessRoot, run);
  return result.review;
}

async function callReviser(harnessRoot, run, review, providerRunner, gitExecutable) {
  const root = runRoot(harnessRoot, run.run_id);
  const specText = await readFile(path.join(root, 'SPEC.md'), 'utf8');
  const planText = await readFile(path.join(root, run.current_plan_path), 'utf8');
  const scoutText = run.cursor.scout_path
    ? await readFile(path.join(root, run.cursor.scout_path), 'utf8')
    : '';
  const inputs = {
    spec: specText,
    plan: planText,
    review,
    scout: scoutText,
    scout_sha256: run.cursor.scout_sha256,
    human_revision_note: run.pending_human_plan_revision_path
      ? await readFile(path.join(root, run.pending_human_plan_revision_path), 'utf8')
      : '',
  };
  const step = await beginStep(
    harnessRoot,
    run,
    'claude_plan_revise',
    run.plan_review_round,
    inputs,
    gitExecutable,
  );
  if (!step) return;
  let result;
  try {
    result = await providerRunner({
      step: 'claude_plan_revise',
      provider: 'claude',
      runId: run.run_id,
      round: run.plan_review_round,
      cwd: run.worktree_path,
      inputs,
    });
  } catch (error) {
    result = { exitCode: 5, stdout: '', stderr: error.message, plan: '', decision: '' };
  }
  await writeProviderLogs(root, step.outputs, result);
  if (!(await unchangedAfterStep(run, gitExecutable))) {
    await markBoundaryViolation(harnessRoot, run, 'claude_plan_revise');
    return;
  }
  const planValidation = validatePlan(result.plan, run);
  const decisionValidation = validateDecision(result.decision, review);
  if (result.exitCode !== 0 || !planValidation.valid || !decisionValidation.valid) {
    const error = new Error(
      result.adapterError || result.stderr || planValidation.reason || decisionValidation.reason,
    );
    if (!(await recordStepFailure(harnessRoot, run, error))) throw error;
    return;
  }
  await atomicWrite(path.join(root, step.outputs.artifact), result.plan);
  await atomicWrite(path.join(root, step.outputs.decision), result.decision);
  run.plan_version += 1;
  run.current_plan_path = step.outputs.artifact;
  run.current_plan_sha = sha256Bytes(Buffer.from(result.plan));
  run.pending_human_plan_revision_path = null;
  await finishStep(harnessRoot, run);
}

async function runPlanLoop(run, options) {
  const { harnessRoot, providerRunner, gitExecutable } = options;
  if (TERMINAL_STATES.has(run.state)) return summarize(run);
  if (run.state !== 'PLAN_LOOP') throw new Error(`unsupported state: ${run.state}`);
  if (!providerRunner) throw new Error('providerRunner is required for run');

  if (!(await verifyLockedInputs(harnessRoot, run))) return summarize(run);
  await resumeActiveStep(harnessRoot, run, gitExecutable);
  run = await loadRun(harnessRoot, run.run_id);
  if (TERMINAL_STATES.has(run.state)) return summarize(run);

  const policy = await readPolicy(harnessRoot);
  while (run.state === 'PLAN_LOOP') {
    if (!(await verifyLockedInputs(harnessRoot, run))) break;
    if (run.cursor.scout_status === 'pending') {
      await callScout(harnessRoot, run, providerRunner, gitExecutable);
      run = await loadRun(harnessRoot, run.run_id);
      if (run.state !== 'PLAN_LOOP') break;
      continue;
    }
    if (!run.current_plan_path) {
      await callPlanner(harnessRoot, run, providerRunner, gitExecutable);
      run = await loadRun(harnessRoot, run.run_id);
      if (run.state !== 'PLAN_LOOP') break;
      continue;
    }
    if (run.pending_human_plan_revision_path) {
      const pendingReview = JSON.parse(await readFile(
        path.join(runRoot(harnessRoot, run.run_id), run.current_review_path),
        'utf8',
      ));
      await callReviser(harnessRoot, run, pendingReview, providerRunner, gitExecutable);
      run = await loadRun(harnessRoot, run.run_id);
      if (run.state !== 'PLAN_LOOP') break;
      continue;
    }
    if (run.last_reviewed_plan_sha !== run.current_plan_sha) {
      await callReviewer(harnessRoot, run, providerRunner, gitExecutable);
      run = await loadRun(harnessRoot, run.run_id);
      if (run.state !== 'PLAN_LOOP') break;
      continue;
    }

    const review = JSON.parse(await readFile(path.join(runRoot(harnessRoot, run.run_id), run.current_review_path), 'utf8'));
    const planText = await readFile(path.join(runRoot(harnessRoot, run.run_id), run.current_plan_path), 'utf8');
    const gate = evaluateReview(review, run, planText);
    if (gate.ready) {
      run.last_error = null;
      await setState(harnessRoot, run, 'AWAIT_PLAN_APPROVAL', 'plan_gate', 'ready');
      break;
    }
    const manualRoundComplete = run.human_revision_target_round !== null
      && run.plan_review_round >= run.human_revision_target_round;
    if (manualRoundComplete || run.plan_review_round >= policy.budgets.plan_review_max) {
      run.last_error = gate.reasons.join('; ');
      await setState(harnessRoot, run, 'NEEDS_HUMAN', 'plan_gate', run.last_error);
      break;
    }
    run.previous_gate_blocking_ids = gate.blockingIds;
    await saveRun(harnessRoot, run);
    await callReviser(harnessRoot, run, review, providerRunner, gitExecutable);
    run = await loadRun(harnessRoot, run.run_id);
  }
  return summarize(await loadRun(harnessRoot, run.run_id));
}

async function requestPlanRevision(values, options) {
  const runId = requireValue(values, 'run');
  const noteFile = path.resolve(requireValue(values, 'note_file'));
  const noteBytes = await readFile(noteFile);
  if (!noteBytes.toString('utf8').trim()) throw new Error('plan revision note is empty');
  const run = await loadRun(options.harnessRoot, runId);
  if (!['AWAIT_PLAN_APPROVAL', 'NEEDS_HUMAN'].includes(run.state) || run.active_step) {
    throw new Error('run is not awaiting a human plan decision');
  }
  if (!run.current_review_path || !run.current_plan_path) {
    throw new Error('run has no reviewed plan to revise');
  }
  if (!(await verifyLockedInputs(options.harnessRoot, run))) return summarize(run);
  const policy = await readPolicy(options.harnessRoot);
  const used = run.human_plan_revision_count ?? 0;
  if (used >= policy.budgets.human_plan_revision_max) {
    throw new Error('human plan revision budget exhausted');
  }

  const root = runRoot(options.harnessRoot, runId);
  const sequence = used + 1;
  const relative = `decisions/human-plan-revision-${sequence}.md`;
  await atomicWrite(path.join(root, relative), noteBytes);
  const review = JSON.parse(await readFile(path.join(root, run.current_review_path), 'utf8'));
  const planText = await readFile(path.join(root, run.current_plan_path), 'utf8');
  const gate = evaluateReview(review, run, planText);
  run.previous_gate_blocking_ids = gate.blockingIds;
  run.human_plan_revision_count = sequence;
  run.human_revision_target_round = run.plan_review_round + 1;
  run.pending_human_plan_revision_path = relative;
  run.latest_human_plan_revision_path = relative;
  run.last_error = null;
  await setState(options.harnessRoot, run, 'PLAN_LOOP', 'request_plan_revision', relative);
  return summarize(run);
}

async function approvePlan(values, options) {
  const runId = requireValue(values, 'run');
  const expected = requireValue(values, 'plan_sha');
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('plan digest must be lowercase SHA-256');
  const run = await loadRun(options.harnessRoot, runId);
  if (run.state !== 'AWAIT_PLAN_APPROVAL' || run.active_step) {
    throw new Error('run is not awaiting plan approval');
  }
  if (!(await verifyLockedInputs(options.harnessRoot, run))) return summarize(run);
  const file = path.join(runRoot(options.harnessRoot, runId), run.current_plan_path);
  const actual = sha256Bytes(await readFile(file));
  if (actual !== expected || actual !== run.current_plan_sha) throw new Error('plan SHA digest mismatch');
  const snapshot = await gitSnapshot(run, options.gitExecutable);
  if (snapshot.head !== run.base_sha) throw new Error('worktree HEAD differs from base SHA');
  if (snapshot.status_hash !== sha256Bytes(Buffer.from(''))) throw new Error('worktree is not clean');
  run.approved_plan_path = run.current_plan_path;
  run.approved_plan_sha = actual;
  run.approved_base_sha = run.base_sha;
  await setState(options.harnessRoot, run, 'IMPLEMENT_LOOP', 'approve_plan', actual);
  return summarize(run);
}

async function abortRun(values, options) {
  const run = await loadRun(options.harnessRoot, requireValue(values, 'run'));
  const reason = requireValue(values, 'reason');
  run.last_error = reason;
  run.active_step = null;
  await setState(options.harnessRoot, run, 'ABORTED', 'abort', reason);
  return summarize(run);
}

export async function runCommand(argv, options = {}) {
  const { command, values } = parseArgs(argv);
  const resolved = {
    harnessRoot: path.resolve(options.harnessRoot ?? HERE),
    providerRunner: options.providerRunner,
    env: options.env ?? process.env,
    gitExecutable: options.gitExecutable ?? 'git',
  };
  if (!resolved.providerRunner) {
    resolved.providerRunner = createDefaultProviderRunner({
      harnessRoot: resolved.harnessRoot,
      env: resolved.env,
      processRunner: options.processRunner,
      commands: options.commands,
    });
  }
  if (command === 'init') return initCommand(values, resolved);
  if (command === 'status') return summarize(await loadRun(resolved.harnessRoot, requireValue(values, 'run')));
  if (command === 'run') {
    const run = await loadRun(resolved.harnessRoot, requireValue(values, 'run'));
    return runPlanLoop(run, resolved);
  }
  if (command === 'approve-plan') return approvePlan(values, resolved);
  if (command === 'request-plan-revision') return requestPlanRevision(values, resolved);
  if (command === 'abort') return abortRun(values, resolved);
  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCommand(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
