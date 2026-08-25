import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { makeId, nowISO } from '../lib/ids.js';
import { WebSpiderError, invariant } from '../lib/errors.js';

const MASTER_USER_GUIDE = new URL('../../docs/WEBSPIDER_USER_GUIDE.txt', import.meta.url);

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function commandString(argv) {
  invariant(Array.isArray(argv) && argv.length > 0, 'WS_VALIDATION', 'A command is required.');
  return argv.map(shellQuote).join(' ');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function inheritedUserEnvironment(environment = process.env) {
  const account = os.userInfo();
  const values = {
    HOME: environment.HOME || account.homedir || os.homedir(),
    USER: environment.USER || account.username,
    LOGNAME: environment.LOGNAME || environment.USER || account.username,
    SHELL: environment.SHELL || account.shell || '/bin/sh',
  };
  for (const key of [
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK',
  ]) {
    if (environment[key]) values[key] = environment[key];
  }
  return values;
}

function stopGroup(pid, signal = 'SIGTERM') {
  if (!pid || !alive(pid)) return;
  try { process.kill(-pid, signal); } catch {
    try { process.kill(pid, signal); } catch { /* already exited */ }
  }
}

export function sanitizeInput(bytes, maxBytes = 64 * 1024) {
  invariant(Buffer.isBuffer(bytes), 'WS_VALIDATION', 'Terminal input must be bytes.');
  invariant(bytes.length <= maxBytes, 'WS_REQUEST_TOO_LARGE', 'Terminal input exceeds the limit.', 413);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  invariant(!text.includes('\0'), 'WS_VALIDATION', 'Terminal input contains a NUL byte.');
  return Buffer.from(text);
}

function terminalProcesses(rootPid) {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,tty='], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  const processes = String(result.stdout || '').split('\n').map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), tty: match[4] } : null;
  }).filter(Boolean);
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (descendants.has(process.ppid) && !descendants.has(process.pid)) {
        descendants.add(process.pid);
        changed = true;
      }
    }
  }
  return processes.filter((process) => descendants.has(process.pid) && !['?', '??', '-'].includes(process.tty));
}

function enhancedKeyboardEnabled(outputLog) {
  try {
    const stat = fs.statSync(outputLog);
    const length = Math.min(stat.size, 65_536);
    const descriptor = fs.openSync(outputLog, 'r');
    try {
      const bytes = Buffer.alloc(length);
      fs.readSync(descriptor, bytes, 0, length, stat.size - length);
      let enabled = false;
      for (const match of bytes.toString('utf8').matchAll(/\u001b\[(>|<)\d*u/g)) enabled = match[1] === '>';
      return enabled;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return false;
  }
}

function usableCodexInstruction(home) {
  for (const filename of ['AGENTS.override.md', 'AGENTS.md']) {
    const candidate = path.join(home, filename);
    try {
      const content = fs.readFileSync(candidate, 'utf8').trim();
      if (content) return content;
    } catch { /* this Codex home has no instruction file at this level */ }
  }
  return '';
}

function materializeCodexHome(contextDirectory, renderedInstructions, environment) {
  const inheritedHome = path.resolve(environment.CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const managedHome = path.join(contextDirectory, 'codex-home');
  fs.mkdirSync(managedHome, { recursive: true, mode: 0o700 });
  if (fs.existsSync(inheritedHome) && inheritedHome !== managedHome) {
    for (const entry of fs.readdirSync(inheritedHome, { withFileTypes: true })) {
      if (['AGENTS.md', 'AGENTS.override.md', 'sessions', 'logs', 'tmp'].includes(entry.name)) continue;
      const destination = path.join(managedHome, entry.name);
      if (fs.existsSync(destination)) continue;
      try {
        fs.symlinkSync(path.join(inheritedHome, entry.name), destination, entry.isDirectory() ? 'dir' : 'file');
      } catch { /* optional state remains available through the inherited process environment */ }
    }
  }
  const inheritedInstructions = usableCodexInstruction(inheritedHome);
  const combined = [
    inheritedInstructions ? '# Inherited Codex user guidance\n\n' + inheritedInstructions : '',
    renderedInstructions,
  ].filter(Boolean).join('\n\n---\n\n');
  fs.writeFileSync(path.join(managedHome, 'AGENTS.md'), combined, { mode: 0o600 });
  return managedHome;
}

const CONTROL_SCRIPT = `#!/usr/bin/env node
const endpoint = process.env.WEBSPIDER_CONTROL_URL;
const token = process.env.WEBSPIDER_AGENT_TOKEN;
if (!endpoint || !token) {
  console.error('WebSpider behavior control is not available to this agent.');
  process.exit(2);
}
const base = endpoint.replace(/\\/+$/, '');
async function request(resource, method = 'GET', body) {
  const response = await fetch(base + '/' + resource, {
    method,
    headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  if (!response.ok) {
    console.error(value.error?.message || 'WebSpider control request failed.');
    if (value.error?.details) console.error(JSON.stringify(value.error.details));
    process.exit(1);
  }
  return value;
}
function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
async function main() {
  const [resource, action = 'show'] = process.argv.slice(2);
  const valid = (resource === 'policy' && ['show', 'patch'].includes(action))
    || (resource === 'usage' && ['show', 'report'].includes(action))
    || (resource === 'agents' && ['list', 'send'].includes(action))
    || (resource === 'documents' && action === 'send')
    || (resource === 'tasks' && ['list', 'run'].includes(action))
    || (resource === 'reminders' && ['list', 'add', 'cancel'].includes(action))
    || (resource === 'portfolio' && action === 'list')
    || (resource === 'notes' && ['list', 'show'].includes(action))
    || resource === 'report';
  if (!valid) {
    console.error('Usage: webspider-control portfolio list | notes list | notes show --note ID | agents list | agents send --agent ID (--message TEXT | --file PATH) [--wake ensure_running|queue_only|interrupt] | documents send (--agent ID | --master) --file PATH [--name FILENAME] [--instruction TEXT] [--wake ensure_running|queue_only|interrupt] | tasks list | tasks run [--agent ID] --argv-json JSON [--title TEXT] [--delay-seconds N] [--notify self|master|none] [--completion-message TEXT] | reminders list | reminders add (--message TEXT | --file PATH) [--title TEXT] [--delay-seconds N] [--every-seconds N] [--max-runs N] [--target self|master] | reminders cancel --reminder ID | report --status idle|working|blocked|completed (--summary TEXT | --file PATH) | policy show | policy patch --scope project|system --json JSON --reason TEXT | usage show | usage report --weekly-remaining PERCENT [--resets-at ISO] [--weekly-tokens COUNT] [--source codex-status]');
    process.exit(2);
  }
  if (resource === 'portfolio') {
    console.log(JSON.stringify(await request('portfolio'), null, 2));
    return;
  }
  if (resource === 'notes') {
    if (action === 'list') {
      console.log(JSON.stringify(await request('notes'), null, 2));
      return;
    }
    const note = option('--note');
    if (!note) {
      console.error('notes show requires --note ID');
      process.exit(2);
    }
    console.log(JSON.stringify(await request('notes/' + encodeURIComponent(note)), null, 2));
    return;
  }
  if (resource === 'tasks') {
    if (action === 'list') {
      console.log(JSON.stringify(await request('tasks'), null, 2));
      return;
    }
    const agent = option('--agent') || process.env.WEBSPIDER_AGENT_INSTANCE_ID;
    const argvJSON = option('--argv-json');
    const title = option('--title');
    const notify = option('--notify') || 'master';
    const completionMessage = option('--completion-message');
    const delaySeconds = Number(option('--delay-seconds') || 0);
    let argv;
    try { argv = JSON.parse(argvJSON || ''); } catch { console.error('--argv-json must contain valid JSON'); process.exit(2); }
    if (!agent || !Array.isArray(argv) || !argv.length || argv.some((argument) => typeof argument !== 'string')
      || !Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 86_400
      || !['self', 'master', 'none'].includes(notify)) {
      console.error('tasks run requires --argv-json with a non-empty string array, optional --agent ID, --delay-seconds 0..86400, and --notify self|master|none');
      process.exit(2);
    }
    console.log(JSON.stringify(await request('tasks', 'POST', {
      agent_id: agent,
      argv,
      title,
      delay_seconds: delaySeconds,
      notify_target: notify,
      completion_message: completionMessage,
    }), null, 2));
    return;
  }
  if (resource === 'reminders') {
    if (action === 'list') {
      console.log(JSON.stringify(await request('reminders'), null, 2));
      return;
    }
    if (action === 'cancel') {
      const reminder = option('--reminder');
      if (!reminder) {
        console.error('reminders cancel requires --reminder ID');
        process.exit(2);
      }
      console.log(JSON.stringify(await request('reminders/' + encodeURIComponent(reminder) + ':cancel', 'POST', {}), null, 2));
      return;
    }
    const messageOption = option('--message');
    const file = option('--file');
    const title = option('--title');
    const delayOption = option('--delay-seconds');
    const everyOption = option('--every-seconds');
    const maxRunsOption = option('--max-runs');
    const target = option('--target') || 'self';
    if ((!messageOption && !file) || (messageOption && file) || (delayOption == null && everyOption == null)
      || !['self', 'master'].includes(target)) {
      console.error('reminders add requires exactly one of --message TEXT or --file PATH, a delay or interval, and optional --target self|master');
      process.exit(2);
    }
    const delaySeconds = delayOption == null ? undefined : Number(delayOption);
    const everySeconds = everyOption == null ? undefined : Number(everyOption);
    const maxRuns = maxRunsOption == null ? undefined : Number(maxRunsOption);
    if ((delaySeconds != null && (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 2_592_000))
      || (everySeconds != null && (!Number.isInteger(everySeconds) || everySeconds < 1 || everySeconds > 2_592_000))
      || (maxRuns != null && (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 10_000))) {
      console.error('reminder delay/interval must be 1..2592000 seconds and max runs must be 1..10000');
      process.exit(2);
    }
    const message = file ? (await import('node:fs')).readFileSync(file, 'utf8') : messageOption;
    console.log(JSON.stringify(await request('reminders', 'POST', {
      message,
      title,
      delay_seconds: delaySeconds,
      every_seconds: everySeconds,
      max_runs: maxRuns,
      delivery_target: target,
    }), null, 2));
    return;
  }
  if (resource === 'documents') {
    const agent = option('--agent') || (process.argv.includes('--master') ? 'master' : undefined);
    const file = option('--file');
    const name = option('--name');
    const instruction = option('--instruction');
    const wake = option('--wake') || 'ensure_running';
    if (!agent || !file || !['ensure_running', 'queue_only', 'interrupt'].includes(wake)) {
      console.error('documents send requires --agent ID or --master, --file PATH, and optional --wake ensure_running|queue_only|interrupt');
      process.exit(2);
    }
    const fs = await import('node:fs');
    const path = await import('node:path');
    const crypto = await import('node:crypto');
    const bytes = fs.readFileSync(file);
    const filename = name || path.basename(file);
    if (!bytes.length || bytes.length > 512 * 1024 || !['.txt', '.md', '.markdown'].includes(path.extname(filename).toLowerCase())) {
      console.error('documents send accepts a non-empty .txt, .md, or .markdown file of at most 512 KiB');
      process.exit(2);
    }
    console.log(JSON.stringify(await request('agents/' + encodeURIComponent(agent) + '/documents', 'POST', {
      filename,
      data_base64: bytes.toString('base64'),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      instruction,
      wake_policy: wake,
    }), null, 2));
    return;
  }
  if (resource === 'report') {
    const status = option('--status');
    const summaryOption = option('--summary');
    const file = option('--file');
    if (!['idle', 'working', 'blocked', 'completed'].includes(status) || (!summaryOption && !file) || (summaryOption && file)) {
      console.error('report requires --status idle|working|blocked|completed and exactly one of --summary TEXT or --file PATH');
      process.exit(2);
    }
    const summary = file ? (await import('node:fs')).readFileSync(file, 'utf8') : summaryOption;
    console.log(JSON.stringify(await request('report', 'POST', { status, summary }), null, 2));
    return;
  }
  if (resource === 'agents') {
    if (action === 'list') {
      console.log(JSON.stringify(await request('agents'), null, 2));
      return;
    }
    const agent = option('--agent');
    const messageOption = option('--message');
    const file = option('--file');
    const wake = option('--wake') || 'ensure_running';
    if (!agent || (!messageOption && !file) || (messageOption && file)) {
      console.error('agents send requires --agent ID and exactly one of --message TEXT or --file PATH');
      process.exit(2);
    }
    if (!['ensure_running', 'queue_only', 'interrupt'].includes(wake)) {
      console.error('--wake must be ensure_running, queue_only, or interrupt');
      process.exit(2);
    }
    const message = file ? (await import('node:fs')).readFileSync(file, 'utf8') : messageOption;
    console.log(JSON.stringify(await request('agents/' + encodeURIComponent(agent) + '/messages', 'POST', {
      message, wake_policy: wake,
    }), null, 2));
    return;
  }
  if (resource === 'policy' && action === 'show') {
    console.log(JSON.stringify(await request('policy'), null, 2));
    return;
  }
  if (resource === 'policy' && action === 'patch') {
    const scope = option('--scope');
    const json = option('--json');
    const reason = option('--reason');
    if (!['project', 'system'].includes(scope) || !json || !reason) {
      console.error('patch requires --scope project|system, --json JSON, and --reason TEXT');
      process.exit(2);
    }
    let patch;
    try { patch = JSON.parse(json); } catch { console.error('--json must contain valid JSON'); process.exit(2); }
    const current = await request('policy');
    const expected = scope === 'system' ? current.system.revision : current.project.revision;
    console.log(JSON.stringify(await request('policy', 'PATCH', {
      scope, patch, reason, expected_revision: expected,
    }), null, 2));
    return;
  }
  if (action === 'show') {
    console.log(JSON.stringify(await request('usage'), null, 2));
    return;
  }
  const remaining = Number(option('--weekly-remaining'));
  const resetsAt = option('--resets-at');
  const weeklyTokensOption = option('--weekly-tokens');
  const source = option('--source') || 'codex-status';
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100) {
    console.error('usage report requires --weekly-remaining as a percentage from 0 to 100');
    process.exit(2);
  }
  if (resetsAt && !Number.isFinite(new Date(resetsAt).getTime())) {
    console.error('--resets-at must be a valid ISO timestamp');
    process.exit(2);
  }
  let weeklyTokens;
  if (weeklyTokensOption != null) {
    weeklyTokens = Number(weeklyTokensOption);
    if (!Number.isSafeInteger(weeklyTokens) || weeklyTokens < 0) {
      console.error('--weekly-tokens must be a non-negative integer');
      process.exit(2);
    }
  }
  const body = {
    source,
    observed_at: new Date().toISOString(),
    rate_limits: [{
      name: 'weekly',
      window_minutes: 10080,
      remaining_percent: remaining,
      used_percent: Math.round((100 - remaining) * 10) / 10,
      resets_at: resetsAt || null,
    }],
    ...(weeklyTokens == null ? {} : {
      token_activity: { period: 'weekly', tokens: weeklyTokens, source: 'codex-usage-weekly' },
    }),
  };
  console.log(JSON.stringify(await request('usage', 'POST', body), null, 2));
}
main().catch((error) => { console.error(error.message || String(error)); process.exit(1); });
`;

function materializeControl(directory, control) {
  if (!control?.url || !control?.token) return {};
  const scriptPath = path.join(directory, 'webspider-control');
  fs.writeFileSync(scriptPath, CONTROL_SCRIPT, { mode: 0o700 });
  fs.chmodSync(scriptPath, 0o700);
  return {
    WEBSPIDER_CONTROL: scriptPath,
    WEBSPIDER_CONTROL_URL: control.url,
    WEBSPIDER_AGENT_TOKEN: control.token,
  };
}

function materializePolicyContext(stateDir, agentInstanceId, snapshot, {
  argv = [], environment = {}, agentControl = null, recoveryContext = null,
} = {}) {
  if (!agentInstanceId || !snapshot?.rendered_instructions) return {};
  const directory = path.join(stateDir, 'agent-context', agentInstanceId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const rulesPath = path.join(directory, 'PROJECT_RULES.md');
  const policyPath = path.join(directory, 'policy.json');
  fs.writeFileSync(rulesPath, snapshot.rendered_instructions, { mode: 0o600 });
  fs.writeFileSync(policyPath, JSON.stringify({
    id: snapshot.id,
    project_id: snapshot.project_id,
    agent_role: snapshot.agent_role || 'worker',
    system_policy_revision: snapshot.system_policy_revision || 1,
    policy_revision: snapshot.policy_revision,
    content_hash: snapshot.content_hash,
    policy: snapshot.policy,
  }, null, 2), { mode: 0o600 });
  const output = {
    WEBSPIDER_PROJECT_RULES: rulesPath,
    WEBSPIDER_PROJECT_POLICY: policyPath,
    WEBSPIDER_POLICY_SNAPSHOT_ID: snapshot.id,
    WEBSPIDER_AGENT_ROLE: snapshot.agent_role || 'worker',
    WEBSPIDER_SYSTEM_POLICY_REVISION: String(snapshot.system_policy_revision || 1),
    WEBSPIDER_POLICY_REVISION: String(snapshot.policy_revision),
    ...materializeControl(directory, agentControl),
  };
  if (recoveryContext) {
    const recoveryPath = path.join(directory, 'RECOVERY_CONTEXT.txt');
    fs.writeFileSync(recoveryPath, recoveryContext, { mode: 0o600 });
    output.WEBSPIDER_RECOVERY_CONTEXT = recoveryPath;
  }
  output.CODEX_HOME = materializeCodexHome(directory, snapshot.rendered_instructions, environment);
  return output;
}

export class ProcessSupervisor extends EventEmitter {
  constructor({ stateDir, database, rootService, pollMs = 50 }) {
    super();
    this.stateDir = stateDir;
    this.database = database;
    this.rootService = rootService;
    this.pollMs = pollMs;
    this.timer = null;
    this.polling = false;
    fs.mkdirSync(path.join(stateDir, 'processes'), { recursive: true, mode: 0o700 });
  }

  start() {
    if (this.timer) return;
    this.reconcile();
    this.timer = setInterval(() => this.#pollOnce(), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reconcile() {
    for (const runtime of this.database.listProcesses()) {
      if (fs.existsSync(runtime.exitFile)) {
        this.database.finishProcess(runtime.id, 'exited', runtime.completionReported);
        stopGroup(runtime.keeperPid);
      } else if (alive(runtime.pid)) {
        this.database.finishProcess(runtime.id, 'running', runtime.completionReported);
      } else {
        this.database.finishProcess(runtime.id, 'lost', runtime.completionReported);
        stopGroup(runtime.keeperPid);
      }
    }
  }

  launch({
    id = makeId('run'), kind = 'agent', agentInstanceId = null, taskId = null,
    terminalId = null, rootId, argv, environment = {}, policySnapshot = null,
    agentControl = null, columns = 120, rows = 36,
  }) {
    invariant(rootId, 'WS_VALIDATION', 'A workspace root is required.');
    const root = this.rootService.getRoot(rootId);
    const runtimeDir = path.join(this.stateDir, 'processes', id);
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const inputFifo = path.join(runtimeDir, 'input.fifo');
    const outputLog = path.join(runtimeDir, 'terminal.log');
    const exitFile = path.join(runtimeDir, 'exit.status');
    if (!fs.existsSync(inputFifo)) {
      const made = spawnSync('mkfifo', ['-m', '600', inputFifo]);
      if (made.status !== 0) throw new WebSpiderError('WS_RUNTIME_UNAVAILABLE', 'Could not create terminal input channel.', 500);
    }
    // Keep one independent writer open so an empty input queue blocks instead of becoming EOF.
    // The keeper is detached and survives a node-daemon restart; the managed wrapper kills it
    // when the PTY exits. A temporary read/write descriptor prevents either open from blocking.
    const bootstrapFd = fs.openSync(inputFifo, fs.constants.O_RDWR);
    const keeperWriteFd = fs.openSync(inputFifo, fs.constants.O_WRONLY);
    const keeper = spawn('sh', ['-c', 'while :; do sleep 3600; done'], {
      detached: true,
      stdio: ['ignore', keeperWriteFd, 'ignore'],
    });
    fs.closeSync(keeperWriteFd);
    keeper.unref();
    const inputFd = fs.openSync(inputFifo, fs.constants.O_RDONLY);
    const outputFd = fs.openSync(outputLog, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o600);
    const previousRuntime = kind === 'agent' ? this.database.getProcessByAgent(agentInstanceId) : null;
    let recoveryContext = null;
    if (previousRuntime && previousRuntime.id !== id && fs.existsSync(previousRuntime.outputLog)) {
      const stat = fs.statSync(previousRuntime.outputLog);
      const start = Math.max(0, stat.size - 200_000);
      const prior = fs.openSync(previousRuntime.outputLog, 'r');
      try {
        const bytes = Buffer.alloc(stat.size - start);
        fs.readSync(prior, bytes, 0, bytes.length, start);
        recoveryContext = [
          `Previous WebSpider runtime: ${previousRuntime.id}`,
          `Previous runtime state: ${previousRuntime.state}`,
          `Captured at: ${nowISO()}`,
          '',
          bytes.toString('utf8'),
        ].join('\n');
      } finally {
        fs.closeSync(prior);
      }
    }
    const guideEnvironment = kind === 'agent' && policySnapshot?.agent_role === 'main'
      ? (() => {
        const guide = this.rootService.writeUserGuide(rootId, fs.readFileSync(MASTER_USER_GUIDE));
        return { WEBSPIDER_USER_GUIDE: path.join(root.canonical, guide.relative_path) };
      })()
      : {};
    const policyEnvironment = kind === 'agent'
      ? materializePolicyContext(this.stateDir, agentInstanceId, policySnapshot, {
        argv, environment, agentControl, recoveryContext,
      })
      : {};
    const wrappedCommand = commandString(argv);
    const scriptCommand = process.platform === 'darwin'
      ? 'script -q /dev/null /bin/sh -c "$1"'
      : 'script -qefc "$1" /dev/null';
    const wrapper = `${scriptCommand}; code=$?; /bin/kill -TERM -- "-$3" 2>/dev/null || /bin/kill -TERM "$3" 2>/dev/null || true; printf "%s" "$code" > "$2"; exit "$code"`;
    const child = spawn('sh', ['-c', wrapper, 'webspider-task-wrapper', wrappedCommand, exitFile, String(keeper.pid)], {
      cwd: root.canonical,
      detached: true,
      stdio: [inputFd, outputFd, outputFd],
      env: {
        ...inheritedUserEnvironment(),
        PATH: process.env.PATH,
        TERM: 'xterm-256color',
        COLUMNS: String(columns),
        LINES: String(rows),
        WEBSPIDER_AGENT_INSTANCE_ID: agentInstanceId || '',
        WEBSPIDER_TASK_ID: taskId || '',
        WEBSPIDER_ROOT_ID: rootId,
        ...environment,
        ...guideEnvironment,
        ...policyEnvironment,
      },
    });
    fs.closeSync(inputFd);
    fs.closeSync(bootstrapFd);
    fs.closeSync(outputFd);
    child.unref();
    const runtime = {
      id,
      kind,
      agentInstanceId,
      taskId,
      terminalId,
      rootId,
      argv,
      pid: child.pid,
      pgid: child.pid,
      keeperPid: keeper.pid,
      inputFifo,
      outputLog,
      exitFile,
      policySnapshotId: policySnapshot?.id || null,
      state: 'running',
      createdAt: nowISO(),
    };
    this.database.upsertProcess(runtime);
    this.emit('state', { type: 'process.started', runtime });
    return runtime;
  }

  input(terminalId, bytes) {
    const runtime = this.database.getProcessByTerminal(terminalId);
    invariant(runtime && runtime.state === 'running', 'WS_AGENT_NOT_READY', 'Terminal process is not running.', 409);
    const safe = sanitizeInput(bytes);
    const fd = fs.openSync(runtime.inputFifo, fs.constants.O_WRONLY);
    try {
      let written = 0;
      while (written < safe.length) written += fs.writeSync(fd, safe, written, safe.length - written);
      invariant(written === safe.length, 'WS_TERMINAL_INPUT_UNCERTAIN', 'The terminal accepted only part of the input.', 502);
    } finally {
      fs.closeSync(fd);
    }
    return { accepted_bytes: safe.length };
  }

  resize(terminalId, columns, rows) {
    const runtime = this.database.getProcessByTerminal(terminalId);
    invariant(runtime && runtime.state === 'running', 'WS_AGENT_NOT_READY', 'Terminal process is not running.', 409);
    invariant(Number.isInteger(columns) && columns >= 20 && columns <= 500, 'WS_VALIDATION', 'Terminal columns must be between 20 and 500.');
    invariant(Number.isInteger(rows) && rows >= 5 && rows <= 300, 'WS_VALIDATION', 'Terminal rows must be between 5 and 300.');
    const processes = terminalProcesses(runtime.pid);
    const tty = processes.at(-1)?.tty;
    if (!tty) return { resized: false, columns, rows, reason: 'pty_not_ready' };
    const device = tty.startsWith('/') ? tty : `/dev/${tty}`;
    const args = process.platform === 'darwin'
      ? ['-f', device, 'rows', String(rows), 'cols', String(columns)]
      : ['-F', device, 'rows', String(rows), 'cols', String(columns)];
    const resized = spawnSync('stty', args, { encoding: 'utf8' });
    if (resized.status !== 0) return { resized: false, columns, rows, reason: 'stty_failed' };
    for (const pgid of new Set(processes.map((item) => item.pgid))) {
      try { process.kill(-pgid, 'SIGWINCH'); } catch { /* process may have exited during resize */ }
    }
    return { resized: true, columns, rows };
  }

  message(agentInstanceId, text) {
    invariant(typeof text === 'string' && text.length > 0, 'WS_VALIDATION', 'Message text is required.');
    const runtime = this.database.getProcessByAgent(agentInstanceId);
    invariant(runtime && runtime.terminalId, 'WS_AGENT_NOT_READY', 'Agent terminal is not running.', 409);
    const normalized = text.replace(/\r\n?/g, '\n');
    invariant(!normalized.includes('\0'), 'WS_VALIDATION', 'Message contains forbidden content.');
    const codexRuntime = path.basename(runtime.argv?.[0] || '').toLowerCase().includes('codex');
    const enhanced = codexRuntime || enhancedKeyboardEnabled(runtime.outputLog);
    const payload = enhanced
      ? `\u001b[200~${normalized}\u001b[201~\u001b[13u`
      : `${normalized}\n`;
    return this.input(runtime.terminalId, Buffer.from(payload));
  }

  stopProcess(id, signal = 'SIGTERM') {
    const runtime = this.database.getProcess(id);
    invariant(runtime, 'WS_NOT_FOUND', 'Managed process not found.', 404);
    stopGroup(runtime.pgid, signal);
    stopGroup(runtime.keeperPid, signal);
    this.database.finishProcess(id, 'stopping', runtime.completionReported);
    return { state: 'stopping' };
  }

  snapshot(terminalId, maxBytes = 200_000) {
    const runtime = this.database.getProcessByTerminal(terminalId);
    if (!runtime || !fs.existsSync(runtime.outputLog)) return { text: '', sequence: 0, state: 'detached' };
    const stat = fs.statSync(runtime.outputLog);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(runtime.outputLog, 'r');
    try {
      const bytes = Buffer.alloc(stat.size - start);
      fs.readSync(fd, bytes, 0, bytes.length, start);
      return { text: bytes.toString('utf8'), sequence: stat.size, state: runtime.state };
    } finally {
      fs.closeSync(fd);
    }
  }

  #pollOnce() {
    if (this.polling) return;
    this.polling = true;
    this.#poll()
      .catch((error) => this.emit('error', error))
      .finally(() => { this.polling = false; });
  }

  async #poll() {
    for (const runtime of this.database.listProcesses()) {
      if (fs.existsSync(runtime.outputLog)) {
        const stat = await fs.promises.stat(runtime.outputLog);
        if (stat.size > runtime.outputOffset) {
          const length = stat.size - runtime.outputOffset;
          const handle = await fs.promises.open(runtime.outputLog, 'r');
          try {
            const bytes = Buffer.alloc(Math.min(length, 256 * 1024));
            const { bytesRead } = await handle.read(bytes, 0, bytes.length, runtime.outputOffset);
            const next = runtime.outputOffset + bytesRead;
            this.database.updateProcessOffset(runtime.id, next);
            this.emit('output', {
              terminal_id: runtime.terminalId,
              process_id: runtime.id,
              sequence_start: runtime.outputOffset,
              sequence_end: next,
              bytes: bytes.subarray(0, bytesRead),
            });
          } finally {
            await handle.close();
          }
        }
      }
      if (!runtime.completionReported && fs.existsSync(runtime.exitFile)) {
        const parsed = Number.parseInt((await fs.promises.readFile(runtime.exitFile, 'utf8')).trim(), 10);
        const exitStatus = Number.isFinite(parsed) ? parsed : 255;
        this.database.finishProcess(runtime.id, exitStatus === 0 ? 'exited' : 'failed', true);
        stopGroup(runtime.keeperPid);
        this.emit('state', {
          type: 'process.completed',
          runtime,
          exit_status: exitStatus,
          completed_at: nowISO(),
        });
      } else if (!runtime.completionReported && !alive(runtime.pid) && !fs.existsSync(runtime.exitFile)) {
        this.database.finishProcess(runtime.id, 'lost', true);
        stopGroup(runtime.keeperPid);
        this.emit('state', { type: 'process.lost', runtime, completed_at: nowISO() });
      }
    }
  }
}
