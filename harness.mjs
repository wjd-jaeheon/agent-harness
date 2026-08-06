import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
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
  'READY_FOR_MANUAL_MERGE',
  'ABORTED',
  'DONE',
]);
const CLOSED_RUN_STATES = new Set(['ABORTED', 'DONE']);
const DEFAULT_POLICY = {
  models: {
    planner: { model: 'claude-fable-5', effort: 'xhigh' },
    reviewer: { model: 'gpt-5.6-sol', effort: 'ultra' },
    implementer: { model: 'gpt-5.6-sol', effort: 'xhigh' },
  },
  budgets: {
    plan_review_max: 2,
    human_plan_revision_max: 1,
    lineage_plan_review_max: 6,
  },
  protected_paths: ['.git', '.harness'],
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
  platform = process.platform,
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
    const policy = await readPolicy(harnessRoot);
    // policy.json "commands" pins provider binaries; bare names come from PATH,
    // where a stale codex.exe once shadowed the current one for a whole session.
    const command = { ...resolvedCommands, ...policy.commands };
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
        command: command.powershell,
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          command.agentScript,
          '-p',
          '--output-format',
          'text',
          '--mode',
          'plan',
          // cursor-agent sandbox requires macOS/Linux; on Windows rely on plan mode + allowlist defaults
          ...(platform === 'win32' ? [] : ['--sandbox', 'enabled']),
          '--workspace',
          request.cwd,
          '--trust',
        ],
        cwd: request.cwd,
        // The prompt goes over stdin: as a positional argument PowerShell -File
        // re-splits it, so any line starting with a dash (e.g. "rm -rf") became
        // an unknown option and Scout silently reported unavailable.
        input: scoutPrompt,
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
        '--model',
        policy.models.planner.model,
        '--effort',
        policy.models.planner.effort,
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
        command: command.claude,
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
      if (request.step === 'codex_implement') {
        const input = await prompt('implementer.md', request.inputs);
        const { model, effort } = policy.models.implementer;
        return processRunner({
          command: command.codex,
          args: [
            'exec',
            '-m',
            model,
            '-c',
            `model_reasoning_effort="${effort}"`,
            '--sandbox',
            'workspace-write',
            '--json',
            '--ephemeral',
            '--color',
            'never',
            '-',
          ],
          cwd: request.cwd,
          input,
          env,
        });
      }
      const input = await prompt('plan-reviewer.md', { ...request.inputs, round: request.round });
      const { model, effort } = policy.models.reviewer;
      const temporary = await mkdtemp(path.join(tmpdir(), 'agent-harness-codex-'));
      const output = path.join(temporary, 'last-message.json');
      try {
        const result = await processRunner({
          command: command.codex,
          args: [
            'exec',
            '-m',
            model,
            '-c',
            `model_reasoning_effort="${effort}"`,
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

function validRunId(runId) {
  return /^\d{14}-[0-9a-f]{8}$/.test(runId);
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function retireRunLock(lock) {
  const stale = `${lock}.stale.${process.pid}.${randomUUID()}`;
  try {
    await rename(lock, stale);
    await rm(stale, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function withRunLock(harnessRoot, runId, callback) {
  if (!validRunId(runId)) throw new Error('run ID is invalid');
  const lock = path.join(runRoot(harnessRoot, runId), '.runner-lock');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(lock);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try {
        owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
      } catch {
        let lockInfo;
        try {
          lockInfo = await stat(lock);
        } catch (statError) {
          if (statError.code === 'ENOENT') continue;
          throw statError;
        }
        if (Date.now() - lockInfo.mtimeMs < 5_000) {
          throw new Error('run is already executing');
        }
        await retireRunLock(lock);
        continue;
      }
      if (!Number.isInteger(owner.pid) || processIsRunning(owner.pid)) {
        throw new Error(`run is already executing${owner.pid ? ` in PID ${owner.pid}` : ''}`);
      }
      await retireRunLock(lock);
      continue;
    }
    try {
      await atomicJson(path.join(lock, 'owner.json'), {
        pid: process.pid,
        started_at: new Date().toISOString(),
      });
      return await callback();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
  throw new Error('could not acquire run execution lock');
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

async function gitRawOutput(gitExecutable, cwd, args, env) {
  const { stdout } = await exec(gitExecutable, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    ...(env ? { env } : {}),
  });
  return stdout;
}

async function gitOutput(gitExecutable, cwd, args, env) {
  return (await gitRawOutput(gitExecutable, cwd, args, env)).trim();
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function gitContext(repo, gitExecutable) {
  return {
    topLevel: path.resolve(await gitOutput(gitExecutable, repo, ['rev-parse', '--show-toplevel'])),
    commonDir: path.resolve(await gitOutput(gitExecutable, repo, [
      'rev-parse', '--path-format=absolute', '--git-common-dir',
    ])),
  };
}

async function gitSnapshot(run, gitExecutable) {
  const head = await gitOutput(gitExecutable, run.worktree_path, ['rev-parse', 'HEAD']);
  const status = await gitRawOutput(gitExecutable, run.worktree_path, [
    'status',
    '--porcelain=v1',
    '-z',
  ]);
  return { head, status_hash: sha256Bytes(Buffer.from(status)) };
}

function extractIds(text, prefix) {
  return [...new Set(text.match(new RegExp(`\\b${prefix}-\\d{3}\\b`, 'g')) ?? [])];
}

/**
 * 사람이 승인하는 계약과 planner만 읽는 맥락을 한 파일 안에서 가른다.
 * AC/CMD는 계약 섹션에서만 파싱하므로 맥락 산문은 자유롭게 쓸 수 있다.
 * 계약 헤딩이 없는 SPEC은 전문이 계약이다 (기존 run 하위호환).
 */
function contractSection(specText) {
  const heading = specText.match(/^\s{0,3}(#{1,6})\s*(?:계약|Contract)\s*$/im);
  if (!heading) return specText;
  const rest = specText.slice(heading.index + heading[0].length);
  const next = rest.match(new RegExp(`^\\s{0,3}#{1,${heading[1].length}}\\s+\\S`, 'm'));
  return next ? rest.slice(0, next.index) : rest;
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
    const match = block.trim().match(pattern);
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
        `^(?:[-*]\\s+)?${escaped}:\\s*(incorporated|rejected)\\s*(?:—|-)\\s*.+$`,
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
    const disposition = new RegExp(`^(?:[-*]\\s+)?${escaped}:\\s*(incorporated|rejected)\\b`, 'm');
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
    models: {
      planner: { ...DEFAULT_POLICY.models.planner, ...parsed.models?.planner },
      reviewer: { ...DEFAULT_POLICY.models.reviewer, ...parsed.models?.reviewer },
      implementer: { ...DEFAULT_POLICY.models.implementer, ...parsed.models?.implementer },
    },
    budgets: {
      ...DEFAULT_POLICY.budgets,
      ...parsed.budgets,
    },
    protected_paths: parsed.protected_paths ?? DEFAULT_POLICY.protected_paths,
    commands: parsed.commands ?? {},
  };
}

function parseVerificationCommands(specText, expectedIds) {
  const commands = new Map();
  const pattern = /^\s*(?:-\s*)?(CMD-\d{3}):\s*`([^`\r\n]+)`\s*$/gm;
  for (const match of specText.matchAll(pattern)) {
    if (commands.has(match[1])) throw new Error(`duplicate verification command: ${match[1]}`);
    commands.set(match[1], match[2]);
  }
  for (const id of expectedIds) {
    if (!commands.has(id)) throw new Error(`${id} needs one backtick-wrapped executable command`);
  }
  return expectedIds.map((id) => ({ id, command: commands.get(id) }));
}

/**
 * Fails at `init` instead of after a full plan+review cycle: an undefined CMD-###
 * mentioned in prose, or a command the verification shell cannot even parse.
 */
async function preflightVerificationCommands(specText, commandIds, options) {
  const commands = parseVerificationCommands(specText, commandIds);
  const temporary = await mkdtemp(path.join(tmpdir(), 'agent-harness-preflight-'));
  try {
    for (const { id, command } of commands) {
      if (options.platform === 'win32' && /^\s*(?:bash|sh)(?:\.exe)?\s/i.test(command)) {
        throw new Error(
          `${id} invokes bare "bash"; on Windows that resolves to the WSL launcher. Use an absolute path such as C:\\PROGRA~1\\Git\\bin\\bash.exe`,
        );
      }
      const file = path.join(temporary, `${id}.txt`);
      await writeFile(file, command, 'utf8');
      const request = options.platform === 'win32'
        ? {
          command: 'powershell.exe',
          args: [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$null,[ref]$e);if($e.Count){[Console]::Error.WriteLine($e[0].Message);exit 1}`,
          ],
        }
        : { command: '/bin/sh', args: ['-n', file] };
      const result = await options.processRunner({
        ...request,
        cwd: temporary,
        timeoutMs: 60 * 1000,
        env: options.env,
      });
      if (result.exitCode !== 0) {
        throw new Error(`${id} is not parseable by the verification shell: ${result.stderr.trim()}`);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return commands;
}

function normalizeProtectedPaths(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('policy.protected_paths must be a non-empty array');
  }
  return values.map((value) => {
    if (typeof value !== 'string') throw new Error('policy.protected_paths entries must be strings');
    const normalized = value.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (
      !normalized ||
      path.posix.isAbsolute(normalized) ||
      path.win32.isAbsolute(value) ||
      normalized.split('/').includes('..')
    ) {
      throw new Error(`invalid protected path: ${value}`);
    }
    return normalized;
  });
}

async function filesystemEntries(absolute, relative = '') {
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      return [{ path: relative, type: 'symlink', value: await readlink(absolute) }];
    }
    if (info.isFile()) {
      return [{ path: relative, type: 'file', value: sha256Bytes(await readFile(absolute)) }];
    }
    if (!info.isDirectory()) return [{ path: relative, type: 'other', value: null }];
    const entries = [{ path: relative, type: 'directory', value: null }];
    for (const name of (await readdir(absolute)).sort()) {
      entries.push(...await filesystemEntries(path.join(absolute, name), `${relative}/${name}`));
    }
    return entries;
  } catch (error) {
    if (error.code === 'ENOENT') return [{ path: relative, type: 'missing', value: null }];
    throw error;
  }
}

async function protectedPathDigests(worktree, protectedPaths) {
  const digests = {};
  for (const relative of protectedPaths) {
    const entries = await filesystemEntries(path.resolve(worktree, ...relative.split('/')), relative);
    digests[relative] = sha256Bytes(Buffer.from(JSON.stringify(entries)));
  }
  return digests;
}

async function implementationPaths(run, gitExecutable) {
  const tracked = await gitRawOutput(gitExecutable, run.worktree_path, [
    'diff',
    '--name-only',
    '-z',
    'HEAD',
    '--',
  ]);
  const untracked = await gitRawOutput(gitExecutable, run.worktree_path, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  const untrackedPaths = untracked.split('\0').filter(Boolean);
  const paths = [...new Set([...tracked.split('\0').filter(Boolean), ...untrackedPaths])]
    .map((value) => value.replaceAll('\\', '/'))
    .sort();
  return {
    paths,
    untracked: new Set(untrackedPaths.map((value) => value.replaceAll('\\', '/'))),
  };
}

async function stagedPaths(run, gitExecutable) {
  return (await gitRawOutput(gitExecutable, run.worktree_path, [
    'diff',
    '--cached',
    '--name-only',
    '-z',
    '--',
  ])).split('\0').filter(Boolean);
}

async function implementationDiff(run, gitExecutable, paths, untracked) {
  let diff = await gitRawOutput(gitExecutable, run.worktree_path, [
    'diff',
    '--binary',
    'HEAD',
    '--',
  ]);
  for (const relative of paths) {
    if (!untracked.has(relative)) continue;
    try {
      diff += await gitRawOutput(gitExecutable, run.worktree_path, [
        'diff',
        '--no-index',
        '--binary',
        '--',
        '/dev/null',
        relative,
      ]);
    } catch (error) {
      if (error.code !== 1 || typeof error.stdout !== 'string') throw error;
      diff += error.stdout;
    }
  }
  return diff;
}

async function implementationManifest(run, paths) {
  const root = path.resolve(run.worktree_path);
  const prefix = `${root}${path.sep}`;
  const manifest = [];
  for (const relative of paths) {
    const absolute = path.resolve(root, ...relative.split('/'));
    if (absolute !== root && !absolute.startsWith(prefix)) {
      throw new Error(`changed path escapes worktree: ${relative}`);
    }
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        manifest.push({
          path: relative,
          type: 'symlink',
          mode: info.mode & 0o777,
          sha256: sha256Bytes(Buffer.from(await readlink(absolute))),
        });
      } else if (info.isFile()) {
        manifest.push({
          path: relative,
          type: 'file',
          mode: info.mode & 0o777,
          sha256: sha256Bytes(await readFile(absolute)),
        });
      } else {
        throw new Error(`unsupported changed path type: ${relative}`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        manifest.push({ path: relative, type: 'deleted', mode: null, sha256: null });
      }
      else throw error;
    }
  }
  return manifest;
}

function verificationRequest(command, cwd, platform) {
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      cwd,
    };
  }
  return { command: '/bin/sh', args: ['-lc', command], cwd };
}

function verificationLog({
  id,
  command,
  cwd,
  result,
  startedAt,
  finishedAt,
  headSha,
  inspectionError = '',
}) {
  return [
    `command_id: ${id}`,
    `command: ${command}`,
    `cwd: ${cwd}`,
    `exit_code: ${result.exitCode}`,
    `head_sha: ${headSha}`,
    `started_at: ${startedAt}`,
    `finished_at: ${finishedAt}`,
    `inspection_error: ${inspectionError}`,
    'stdout:',
    result.stdout ?? '',
    'stderr:',
    result.stderr ?? '',
    '',
  ].join('\n');
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
  if (run.baseline) {
    for (const [label, file, sha] of [
      ['baseline PLAN', run.baseline.plan_path, run.baseline.plan_sha256],
      ['baseline review', run.baseline.review_path, run.baseline.review_sha256],
      ['baseline SPEC', run.baseline.spec_path, run.baseline.spec_sha256],
    ]) {
      if (!(await verifyLockedFile(harnessRoot, run, file, sha, label))) return false;
    }
  }
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
  const contract = contractSection(specText);
  const spec = validateSpec(contract);
  const commands = await preflightVerificationCommands(contract, spec.commandIds, options);
  const specSha = sha256Bytes(specBytes);
  const baseSha = await gitOutput(options.gitExecutable, repo, ['rev-parse', 'HEAD']);
  const inside = await gitOutput(options.gitExecutable, repo, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') throw new Error('repo must be a Git worktree');

  let carryover = null;
  if (values.parent_run) {
    const parent = await loadRun(options.harnessRoot, values.parent_run);
    if (parent.state !== 'ABORTED') throw new Error('parent run must be ABORTED');
    if (pathKey(parent.repo_path) !== pathKey(repo)) {
      throw new Error('parent run must belong to the same repository');
    }
    if (!parent.current_plan_path || !parent.current_review_path) {
      throw new Error('parent run has no reviewed plan to carry over');
    }
    if (parent.base_sha === baseSha && parent.spec?.sha256 === specSha) {
      throw new Error('parent run inputs are unchanged; resume or inspect the parent instead');
    }
    const priorPlanReviewRounds =
      (parent.prior_plan_review_rounds ?? 0) + (parent.plan_review_round ?? 0);
    const policy = await readPolicy(options.harnessRoot);
    if (priorPlanReviewRounds >= policy.budgets.lineage_plan_review_max) {
      throw new Error('lineage plan review budget exhausted');
    }
    const parentRoot = runRoot(options.harnessRoot, parent.run_id);
    carryover = {
      parent,
      priorPlanReviewRounds,
      plan: await readFile(path.join(parentRoot, parent.current_plan_path)),
      review: await readFile(path.join(parentRoot, parent.current_review_path)),
      spec: await readFile(path.join(parentRoot, 'SPEC.md')),
    };
  }

  const runsDirectory = path.join(options.harnessRoot, '.harness', 'runs');
  let existingRunIds = [];
  try {
    existingRunIds = await readdir(runsDirectory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const existingRunId of existingRunIds) {
    const existing = await loadRun(options.harnessRoot, existingRunId);
    if (
      !CLOSED_RUN_STATES.has(existing.state) &&
      pathKey(existing.repo_path) === pathKey(repo) &&
      existing.base_sha === baseSha &&
      existing.spec?.sha256 === specSha
    ) {
      throw new Error(`matching active run exists: ${existing.run_id}; resume it`);
    }
  }

  const runId = newRunId();
  const root = runRoot(options.harnessRoot, runId);
  const worktree = path.join(options.harnessRoot, '.harness', 'worktrees', runId);
  await mkdir(root, { recursive: true });
  await mkdir(path.dirname(worktree), { recursive: true });
  await gitOutput(options.gitExecutable, repo, ['worktree', 'add', '--detach', worktree, baseSha]);
  const status = await gitOutput(options.gitExecutable, worktree, ['status', '--porcelain=v1', '-z']);
  if (status !== '') throw new Error('new writer worktree is not clean');

  await atomicWrite(path.join(root, 'SPEC.md'), specBytes);
  let baseline = null;
  if (carryover) {
    const planPath = 'baseline/PLAN.md';
    const reviewPath = 'baseline/review.json';
    const baselineSpecPath = 'baseline/SPEC.md';
    await atomicWrite(path.join(root, planPath), carryover.plan);
    await atomicWrite(path.join(root, reviewPath), carryover.review);
    await atomicWrite(path.join(root, baselineSpecPath), carryover.spec);
    baseline = {
      plan_path: planPath,
      plan_sha256: sha256Bytes(carryover.plan),
      review_path: reviewPath,
      review_sha256: sha256Bytes(carryover.review),
      spec_path: baselineSpecPath,
      spec_sha256: sha256Bytes(carryover.spec),
      base_sha: carryover.parent.base_sha,
    };
  }
  await atomicWrite(path.join(root, 'events.jsonl'), '');
  const run = {
    run_id: runId,
    parent_run_id: carryover?.parent.run_id ?? null,
    prior_plan_review_rounds: carryover?.priorPlanReviewRounds ?? 0,
    baseline,
    state: 'PLAN_LOOP',
    repo_path: repo,
    worktree_path: worktree,
    base_sha: baseSha,
    head_sha: null,
    spec: {
      acceptance_ids: spec.acceptanceIds,
      command_ids: spec.commandIds,
      sha256: specSha,
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
    implementation: null,
  };
  await saveRun(options.harnessRoot, run);
  await event(options.harnessRoot, run, 'init', 'created');
  return summarize(run);
}

function summarize(run) {
  return {
    runId: run.run_id,
    state: run.state,
    worktreePath: run.worktree_path,
    planVersion: run.plan_version,
    planReviewRound: run.plan_review_round,
    humanPlanRevisionCount: run.human_plan_revision_count ?? 0,
    currentPlanPath: run.current_plan_path,
    currentPlanSha: run.current_plan_sha,
    parentRunId: run.parent_run_id ?? null,
    lineagePlanReviewRounds:
      (run.prior_plan_review_rounds ?? 0) + (run.plan_review_round ?? 0),
    cursorScoutStatus: run.cursor.scout_status,
    cursorScoutUnavailableReason: run.cursor.unavailable_reason,
    changedPaths: run.implementation?.changed_paths ?? [],
    implementationDigest: run.implementation?.digest ?? null,
    verificationEvidence: run.implementation?.evidence_paths ?? [],
    lastError: run.last_error,
  };
}

async function taskSummary(harnessRoot, runId) {
  const spec = (await readFile(path.join(runRoot(harnessRoot, runId), 'SPEC.md'), 'utf8')).replace(/^\uFEFF/, '');
  const heading = spec.match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/m);
  return heading?.[1].trim() || 'Untitled task';
}

async function listEntry(harnessRoot, run, warnings) {
  let summary = 'Untitled task';
  try {
    summary = await taskSummary(harnessRoot, run.run_id);
  } catch {
    warnings.push({ runId: run.run_id, message: 'locked SPEC unavailable' });
  }
  return {
    ...summarize(run),
    taskSummary: summary,
    repoPath: run.repo_path,
    worktreePath: run.worktree_path,
  };
}

async function listRunsCommand(values, options) {
  const repo = path.resolve(requireValue(values, 'repo'));
  const context = await gitContext(repo, options.gitExecutable);
  const runsDirectory = path.join(options.harnessRoot, '.harness', 'runs');
  let runIds = [];
  try {
    runIds = await readdir(runsDirectory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const warnings = [];
  const runs = [];
  let ownerRunId = null;
  for (const runId of runIds) {
    let run;
    try {
      run = await loadRun(options.harnessRoot, runId);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (pathKey(run.worktree_path) === pathKey(context.topLevel)) {
      ownerRunId = run.run_id;
      runs.push(await listEntry(options.harnessRoot, run, warnings));
      continue;
    }
    if (CLOSED_RUN_STATES.has(run.state)) continue;
    if (!(await exists(run.repo_path))) {
      warnings.push({ runId: run.run_id, message: `stale repo path: ${run.repo_path}` });
      continue;
    }
    if (pathKey((await gitContext(run.repo_path, options.gitExecutable)).commonDir) !== pathKey(context.commonDir)) continue;
    runs.push(await listEntry(options.harnessRoot, run, warnings));
  }

  const ownedRun = ownerRunId ? runs.find((run) => run.runId === ownerRunId) : null;
  return {
    repoPath: context.topLevel,
    ownerRunId,
    selectedRunId: ownedRun ? ownerRunId : runs.length === 1 ? runs[0].runId : null,
    runs: ownedRun ? [ownedRun] : runs,
    warnings,
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
  await event(harnessRoot, run, 'cursor_scout_start', `attempt ${step.attempt}`);
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
    await finishStep(harnessRoot, run);
    await event(harnessRoot, run, 'cursor_scout_completed', `${items.length} items`);
  } catch (error) {
    run.cursor.scout_status = 'unavailable';
    run.cursor.unavailable_reason = error.message;
    await finishStep(harnessRoot, run);
    await event(harnessRoot, run, 'cursor_scout_unavailable', error.message);
  }
}

async function callPlanner(harnessRoot, run, providerRunner, gitExecutable) {
  const root = runRoot(harnessRoot, run.run_id);
  const specText = await readFile(path.join(root, 'SPEC.md'), 'utf8');
  const scoutText = run.cursor.scout_path
    ? await readFile(path.join(root, run.cursor.scout_path), 'utf8')
    : '';
  const baselinePlan = run.baseline
    ? await readFile(path.join(root, run.baseline.plan_path), 'utf8')
    : '';
  const baselineReview = run.baseline
    ? JSON.parse(await readFile(path.join(root, run.baseline.review_path), 'utf8'))
    : null;
  const baselineSpec = run.baseline
    ? await readFile(path.join(root, run.baseline.spec_path), 'utf8')
    : '';
  const inputs = {
    spec: specText,
    scout: scoutText,
    scout_status: run.cursor.scout_status,
    scout_sha256: run.cursor.scout_sha256,
    baseline_plan: baselinePlan,
    baseline_review: baselineReview,
    baseline_spec: baselineSpec,
    baseline_base_sha: run.baseline?.base_sha ?? null,
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
  const previousPlan = run.plan_version > 1
    ? await readFile(path.join(root, `plan/PLAN_v${run.plan_version - 1}.md`), 'utf8')
    : run.baseline
      ? await readFile(path.join(root, run.baseline.plan_path), 'utf8')
      : '';
  const scoutText = run.cursor.scout_path
    ? await readFile(path.join(root, run.cursor.scout_path), 'utf8')
    : '';
  const previousReview = run.current_review_path
    ? JSON.parse(await readFile(path.join(root, run.current_review_path), 'utf8'))
    : run.baseline
      ? JSON.parse(await readFile(path.join(root, run.baseline.review_path), 'utf8'))
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
    previous_plan: previousPlan,
    review_scope: previousPlan ? 'delta' : 'full',
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
      if (
        (run.prior_plan_review_rounds ?? 0) + run.plan_review_round
        >= policy.budgets.lineage_plan_review_max
      ) {
        run.last_error = 'lineage plan review budget exhausted';
        await setState(harnessRoot, run, 'NEEDS_HUMAN', 'plan_gate', run.last_error);
        break;
      }
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
    const lineageBudgetExhausted =
      (run.prior_plan_review_rounds ?? 0) + run.plan_review_round
      >= policy.budgets.lineage_plan_review_max;
    if (
      manualRoundComplete
      || run.plan_review_round >= policy.budgets.plan_review_max
      || lineageBudgetExhausted
    ) {
      run.last_error = [
        ...gate.reasons,
        ...(lineageBudgetExhausted ? ['lineage plan review budget exhausted'] : []),
      ].join('; ');
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

async function stopImplementation(harnessRoot, run, message, action = 'implementation_gate') {
  run.last_error = message;
  run.active_step = null;
  await setState(harnessRoot, run, 'NEEDS_HUMAN', action, message);
  return summarize(run);
}

async function runImplementationLoop(run, options) {
  const { harnessRoot, providerRunner, gitExecutable, processRunner, platform } = options;
  if (run.active_step) {
    return stopImplementation(
      harnessRoot,
      run,
      'Codex implementation was interrupted; inspect the preserved partial diff',
      'codex_implement',
    );
  }
  if (!(await verifyLockedInputs(harnessRoot, run))) return summarize(run);
  if (
    run.approved_plan_path !== run.current_plan_path ||
    run.approved_plan_sha !== run.current_plan_sha ||
    run.approved_base_sha !== run.base_sha
  ) {
    return stopImplementation(harnessRoot, run, 'approved PLAN or base SHA no longer matches');
  }

  const before = await gitSnapshot(run, gitExecutable);
  if (before.head !== run.base_sha || before.status_hash !== sha256Bytes(Buffer.from(''))) {
    return stopImplementation(harnessRoot, run, 'writer worktree drifted before implementation');
  }

  const root = runRoot(harnessRoot, run.run_id);
  const specText = await readFile(path.join(root, 'SPEC.md'), 'utf8');
  const planText = await readFile(path.join(root, run.approved_plan_path), 'utf8');
  let verificationCommands;
  let protectedPaths;
  let protectedDigests;
  try {
    verificationCommands = parseVerificationCommands(contractSection(specText), run.spec.command_ids);
    protectedPaths = normalizeProtectedPaths((await readPolicy(harnessRoot)).protected_paths);
    protectedDigests = await protectedPathDigests(run.worktree_path, protectedPaths);
  } catch (error) {
    return stopImplementation(harnessRoot, run, error.message);
  }

  const inputs = {
    spec: specText,
    plan: planText,
    base_sha: run.base_sha,
    verification_commands: verificationCommands,
    protected_paths: protectedPaths,
  };
  run.active_step = {
    type: 'codex_implement',
    round: 1,
    input_hash: sha256Bytes(Buffer.from(JSON.stringify(inputs))),
    pre_head: before.head,
    pre_status_hash: before.status_hash,
    protected_digests: protectedDigests,
    attempt: 1,
    outputs: {
      stdout: 'reviews/implementation-codex.raw.jsonl',
      stderr: 'reviews/implementation-codex.stderr.log',
    },
  };
  await saveRun(harnessRoot, run);
  await event(harnessRoot, run, 'codex_implement_start', 'attempt 1');

  let result;
  try {
    result = await providerRunner({
      step: 'codex_implement',
      provider: 'codex',
      runId: run.run_id,
      round: 1,
      cwd: run.worktree_path,
      inputs,
    });
  } catch (error) {
    await atomicWrite(path.join(root, run.active_step.outputs.stdout), '');
    await atomicWrite(path.join(root, run.active_step.outputs.stderr), error.message);
    return stopImplementation(harnessRoot, run, error.message, 'codex_implement');
  }
  await writeProviderLogs(root, run.active_step.outputs, result);
  if (result.exitCode !== 0) {
    return stopImplementation(
      harnessRoot,
      run,
      `Codex implementation exited with code ${result.exitCode}`,
      'codex_implement',
    );
  }

  let paths;
  let manifest;
  let diff;
  try {
    const afterProtected = await protectedPathDigests(run.worktree_path, protectedPaths);
    const changedProtected = protectedPaths.find(
      (relative) => afterProtected[relative] !== protectedDigests[relative],
    );
    if (changedProtected) {
      return stopImplementation(
        harnessRoot,
        run,
        `Codex implementation touched protected path: ${changedProtected}`,
      );
    }
    const head = await gitOutput(gitExecutable, run.worktree_path, ['rev-parse', 'HEAD']);
    if (head !== run.base_sha) {
      return stopImplementation(harnessRoot, run, 'Codex implementation changed HEAD', 'codex_implement');
    }
    const staged = await stagedPaths(run, gitExecutable);
    if (staged.length > 0) {
      return stopImplementation(
        harnessRoot,
        run,
        `Codex implementation staged source changes: ${staged.join(', ')}`,
      );
    }
    const changes = await implementationPaths(run, gitExecutable);
    paths = changes.paths;
    if (paths.length === 0) {
      return stopImplementation(harnessRoot, run, 'Codex implementation produced no diff');
    }
    const protectedPath = paths.find((changed) => protectedPaths.some((protectedValue) => {
      const changedKey = platform === 'win32' ? changed.toLowerCase() : changed;
      const protectedKey = platform === 'win32' ? protectedValue.toLowerCase() : protectedValue;
      return changedKey === protectedKey || changedKey.startsWith(`${protectedKey}/`);
    }));
    if (protectedPath) {
      return stopImplementation(
        harnessRoot,
        run,
        `Codex implementation touched protected path: ${protectedPath}`,
      );
    }
    manifest = await implementationManifest(run, paths);
    diff = await implementationDiff(run, gitExecutable, paths, changes.untracked);
  } catch (error) {
    return stopImplementation(harnessRoot, run, error.message);
  }

  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const implementationDigest = sha256Bytes(Buffer.from(manifestText));
  await atomicWrite(path.join(root, 'implementation.diff'), diff);
  await atomicWrite(path.join(root, 'implementation-manifest.json'), manifestText);
  run.implementation = {
    changed_paths: paths,
    digest: implementationDigest,
    manifest_path: 'implementation-manifest.json',
    diff_path: 'implementation.diff',
    evidence_paths: [],
  };
  await saveRun(harnessRoot, run);

  let expectedSnapshot = await gitSnapshot(run, gitExecutable);
  // locked CMD는 워킹트리에서 돌지만 구현 산출물은 전부 untracked다 (implementer는
  // stage 금지). 그래서 git grep / ls-files / diff HEAD가 조용히 빈 집합을 본다.
  // 버릴 인덱스에 산출물을 넣어 CMD에만 건네고, 실제 인덱스는 그대로 둔다.
  const indexDirectory = await mkdtemp(path.join(tmpdir(), 'agent-harness-index-'));
  const verificationEnv = {
    ...options.env,
    GIT_INDEX_FILE: path.join(indexDirectory, 'index'),
  };
  try {
    // read-tree를 먼저 하지 않으면 .gitignore에 매칭되는 tracked 파일이
    // add -A 뒤 "삭제"로 보인다.
    await gitOutput(gitExecutable, run.worktree_path, ['read-tree', 'HEAD'], verificationEnv);
    await gitOutput(gitExecutable, run.worktree_path, ['add', '-A'], verificationEnv);
  } catch (error) {
    await rm(indexDirectory, { recursive: true, force: true });
    return stopImplementation(
      harnessRoot,
      run,
      `verification index could not be built: ${error.message}`,
      'verification',
    );
  }
  try {
    for (const verification of verificationCommands) {
      const startedAt = new Date().toISOString();
      let commandResult;
      try {
        commandResult = await processRunner({
          ...verificationRequest(verification.command, run.worktree_path, platform),
          env: verificationEnv,
        });
      } catch (error) {
        commandResult = { exitCode: 5, stdout: '', stderr: error.message };
      }
      const finishedAt = new Date().toISOString();
      let after;
      let inspectionError = '';
      try {
        after = await gitSnapshot(run, gitExecutable);
      } catch (error) {
        inspectionError = error.message;
        after = { head: 'unavailable', status_hash: null };
      }
      const evidencePath = `evidence/${verification.id}.log`;
      await atomicWrite(path.join(root, evidencePath), verificationLog({
        id: verification.id,
        command: verification.command,
        cwd: run.worktree_path,
        result: commandResult,
        startedAt,
        finishedAt,
        headSha: after.head,
        inspectionError,
      }));
      run.implementation.evidence_paths.push(evidencePath);
      await saveRun(harnessRoot, run);
      if (inspectionError) {
        return stopImplementation(
          harnessRoot,
          run,
          `${verification.id} inspection failed: ${inspectionError}`,
          'verification',
        );
      }
      if (commandResult.exitCode !== 0) {
        return stopImplementation(
          harnessRoot,
          run,
          `${verification.id} exited with code ${commandResult.exitCode}`,
          'verification',
        );
      }
      let verificationChangedWorktree =
        after.head !== expectedSnapshot.head || after.status_hash !== expectedSnapshot.status_hash;
      try {
        const afterProtected = await protectedPathDigests(run.worktree_path, protectedPaths);
        const afterChanges = await implementationPaths(run, gitExecutable);
        const afterManifest = await implementationManifest(run, afterChanges.paths);
        const afterDigest = sha256Bytes(Buffer.from(`${JSON.stringify(afterManifest, null, 2)}\n`));
        verificationChangedWorktree ||= protectedPaths.some(
          (relative) => afterProtected[relative] !== protectedDigests[relative],
        );
        verificationChangedWorktree ||= (await stagedPaths(run, gitExecutable)).length > 0;
        verificationChangedWorktree ||= afterDigest !== implementationDigest;
      } catch {
        verificationChangedWorktree = true;
      }
      if (verificationChangedWorktree) {
        return stopImplementation(
          harnessRoot,
          run,
          `${verification.id} changed HEAD or worktree status`,
          'verification',
        );
      }
      expectedSnapshot = after;
    }
  } finally {
    await rm(indexDirectory, { recursive: true, force: true });
  }

  run.head_sha = expectedSnapshot.head;
  run.active_step = null;
  run.last_error = null;
  await setState(harnessRoot, run, 'READY_FOR_MANUAL_MERGE', 'implementation_gate', 'ready');
  return summarize(run);
}

async function runWorkflow(run, options) {
  if (run.state === 'PLAN_LOOP') return runPlanLoop(run, options);
  if (run.state === 'IMPLEMENT_LOOP') return runImplementationLoop(run, options);
  if (TERMINAL_STATES.has(run.state)) return summarize(run);
  throw new Error(`unsupported state: ${run.state}`);
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
  if (
    (run.prior_plan_review_rounds ?? 0) + run.plan_review_round
    >= policy.budgets.lineage_plan_review_max
  ) {
    throw new Error('lineage plan review budget exhausted');
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
  if (CLOSED_RUN_STATES.has(run.state)) throw new Error('run is already closed');
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
    processRunner: options.processRunner ?? runProcess,
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    gitExecutable: options.gitExecutable ?? 'git',
  };
  if (!resolved.providerRunner) {
    resolved.providerRunner = createDefaultProviderRunner({
      harnessRoot: resolved.harnessRoot,
      env: resolved.env,
      processRunner: resolved.processRunner,
      commands: options.commands,
      platform: resolved.platform,
    });
  }
  if (command === 'init') return initCommand(values, resolved);
  if (command === 'start') {
    const created = await initCommand(values, resolved);
    return withRunLock(resolved.harnessRoot, created.runId, async () => (
      runWorkflow(await loadRun(resolved.harnessRoot, created.runId), resolved)
    ));
  }
  if (command === 'list') return listRunsCommand(values, resolved);
  if (command === 'status') return summarize(await loadRun(resolved.harnessRoot, requireValue(values, 'run')));
  if (command === 'run') {
    const runId = requireValue(values, 'run');
    return withRunLock(resolved.harnessRoot, runId, async () => {
      const run = await loadRun(resolved.harnessRoot, runId);
      return runWorkflow(run, resolved);
    });
  }
  if (command === 'approve-plan') {
    const runId = requireValue(values, 'run');
    return withRunLock(resolved.harnessRoot, runId, () => approvePlan(values, resolved));
  }
  if (command === 'request-plan-revision') {
    const runId = requireValue(values, 'run');
    return withRunLock(resolved.harnessRoot, runId, () => requestPlanRevision(values, resolved));
  }
  if (command === 'abort') {
    const runId = requireValue(values, 'run');
    return withRunLock(resolved.harnessRoot, runId, () => abortRun(values, resolved));
  }
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
