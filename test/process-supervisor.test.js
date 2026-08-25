import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NodeDatabase } from '../src/db/node-database.js';
import { RootedFileService } from '../src/node/root-fs.js';
import { ProcessSupervisor, sanitizeInput } from '../src/node/process-supervisor.js';

function waitForCompletion(supervisor, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for detached process')), timeoutMs);
    const listener = (event) => {
      if (event.type !== 'process.completed') return;
      clearTimeout(timer);
      supervisor.off('state', listener);
      resolve(event);
    };
    supervisor.on('state', listener);
  });
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}

test('terminal input preserves interactive control-key sequences', () => {
  const input = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 127]);
  assert.deepEqual(sanitizeInput(input), input);
  assert.throws(() => sanitizeInput(Buffer.from([0])), (error) => error.code === 'WS_VALIDATION');
});

test('detached command writes a durable exit marker and terminal log', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-runtime-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  const database = new NodeDatabase(path.join(directory, 'node.db'));
  const roots = new RootedFileService([{ id: 'awr_runtime', path: workspace }]);
  const supervisor = new ProcessSupervisor({ stateDir: directory, database, rootService: roots, pollMs: 25 });
  supervisor.on('error', () => {});
  supervisor.start();
  t.after(() => {
    supervisor.stop();
    roots.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const completion = waitForCompletion(supervisor);
  const runtime = supervisor.launch({
    id: 'run_test',
    kind: 'task',
    taskId: 'tsk_test',
    terminalId: 'trm_test',
    rootId: 'awr_runtime',
    argv: ['/bin/sh', '-c', 'printf "detached-output\\n"; test -n "$HOME"; test -n "$USER"; test -n "$LOGNAME"; test -n "$SHELL"; printf "%s\\n" "$HOME" > inherited-home.txt; printf "artifact" > result.txt'],
  });
  const event = await completion;
  assert.equal(event.exit_status, 0);
  assert.equal(fs.readFileSync(path.join(workspace, 'result.txt'), 'utf8'), 'artifact');
  assert.equal(fs.readFileSync(path.join(workspace, 'inherited-home.txt'), 'utf8').trim(), os.homedir());
  assert.match(supervisor.snapshot('trm_test').text, /detached-output/);
  assert.equal(database.getProcess(runtime.id).completionReported, true);
});

test('a surviving PTY process is reconciled and controlled after node-daemon restart', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-reconcile-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  let database = new NodeDatabase(path.join(directory, 'node.db'));
  let roots = new RootedFileService([{ id: 'awr_runtime', path: workspace }]);
  let supervisor = new ProcessSupervisor({ stateDir: directory, database, rootService: roots, pollMs: 25 });
  supervisor.on('error', () => {});
  supervisor.start();
  const runtime = supervisor.launch({
    id: 'run_survivor', kind: 'agent', agentInstanceId: 'agt_survivor', terminalId: 'trm_survivor',
    rootId: 'awr_runtime', argv: ['/bin/sh'],
  });
  supervisor.input('trm_survivor', Buffer.from('echo before-restart\n'));
  await waitUntil(() => supervisor.snapshot('trm_survivor').text.includes('before-restart'));

  supervisor.stop();
  roots.close();
  database.close();

  database = new NodeDatabase(path.join(directory, 'node.db'));
  roots = new RootedFileService([{ id: 'awr_runtime', path: workspace }]);
  supervisor = new ProcessSupervisor({ stateDir: directory, database, rootService: roots, pollMs: 25 });
  supervisor.on('error', () => {});
  supervisor.start();
  assert.equal(database.getProcess(runtime.id).state, 'running');
  const completion = waitForCompletion(supervisor);
  supervisor.input('trm_survivor', Buffer.from('echo after-restart\nexit\n'));
  const event = await completion;
  assert.equal(event.exit_status, 0);
  const snapshot = supervisor.snapshot('trm_survivor').text;
  assert.match(snapshot, /before-restart/);
  assert.match(snapshot, /after-restart/);

  t.after(() => {
    supervisor.stop();
    roots.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

test('a browser terminal resize reaches the detached PTY', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-resize-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  const database = new NodeDatabase(path.join(directory, 'node.db'));
  const roots = new RootedFileService([{ id: 'awr_resize', path: workspace }]);
  const supervisor = new ProcessSupervisor({ stateDir: directory, database, rootService: roots, pollMs: 25 });
  supervisor.on('error', () => {});
  supervisor.start();
  t.after(() => {
    supervisor.stop();
    roots.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const completion = waitForCompletion(supervisor);
  supervisor.launch({
    id: 'run_resize', kind: 'agent', agentInstanceId: 'agt_resize', terminalId: 'trm_resize',
    rootId: 'awr_resize', argv: ['/bin/sh'],
  });
  let resized;
  await waitUntil(() => {
    resized = supervisor.resize('trm_resize', 101, 31);
    return resized.resized;
  });
  assert.deepEqual(resized, { resized: true, columns: 101, rows: 31 });
  supervisor.input('trm_resize', Buffer.from('stty size\nexit\n'));
  assert.equal((await completion).exit_status, 0);
  assert.match(supervisor.snapshot('trm_resize').text, /31 101/);
});

test('a replacement agent receives bounded recovery context from its prior runtime', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-recovery-context-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  const database = new NodeDatabase(path.join(directory, 'node.db'));
  const roots = new RootedFileService([{ id: 'awr_recovery', path: workspace }]);
  const supervisor = new ProcessSupervisor({ stateDir: directory, database, rootService: roots, pollMs: 25 });
  supervisor.on('error', () => {});
  supervisor.start();
  t.after(() => {
    supervisor.stop();
    roots.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  let completion = waitForCompletion(supervisor);
  supervisor.launch({
    id: 'run_prior', kind: 'agent', agentInstanceId: 'agt_recovery', terminalId: 'trm_recovery',
    rootId: 'awr_recovery', argv: ['/bin/sh', '-c', 'echo prior-session-marker'],
    policySnapshot: {
      id: 'pol_prior', project_id: 'prj_recovery', agent_role: 'main', policy_revision: 1,
      content_hash: 'prior', policy: {}, rendered_instructions: '# Recovery test',
    },
  });
  assert.equal((await completion).exit_status, 0);

  completion = waitForCompletion(supervisor);
  supervisor.launch({
    id: 'run_replacement', kind: 'agent', agentInstanceId: 'agt_recovery', terminalId: 'trm_recovery',
    rootId: 'awr_recovery',
    argv: ['/bin/sh', '-c', 'test -f "$WEBSPIDER_RECOVERY_CONTEXT" && grep -q prior-session-marker "$WEBSPIDER_RECOVERY_CONTEXT"'],
    policySnapshot: {
      id: 'pol_replacement', project_id: 'prj_recovery', agent_role: 'main', policy_revision: 1,
      content_hash: 'replacement', policy: {}, rendered_instructions: '# Recovery test',
    },
  });
  assert.equal((await completion).exit_status, 0);
  const recovery = fs.readFileSync(path.join(directory, 'agent-context', 'agt_recovery', 'RECOVERY_CONTEXT.txt'), 'utf8');
  assert.match(recovery, /prior-session-marker/);
  assert.match(recovery, /Previous WebSpider runtime: run_prior/);
});

test('agent launch materializes the inherited project agreement without workspace setup', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-agent-context-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  const inheritedCodexHome = path.join(directory, 'original-codex-home');
  fs.mkdirSync(inheritedCodexHome);
  fs.writeFileSync(path.join(inheritedCodexHome, 'AGENTS.md'), '# User defaults\nPreserve the user rule.');
  const fakeCodex = path.join(directory, 'codex');
  fs.writeFileSync(fakeCodex, '#!/bin/sh\ntest -n "$HOME" && test -n "$USER" && test -n "$LOGNAME" && test -n "$SHELL" && test -f "$WEBSPIDER_PROJECT_RULES" && grep -q "Reduce user burden" "$WEBSPIDER_PROJECT_RULES" && grep -q "Preserve the user rule" "$CODEX_HOME/AGENTS.md" && grep -q "Reduce user burden" "$CODEX_HOME/AGENTS.md" && test "$WEBSPIDER_AGENT_ROLE" = "main" && test -x "$WEBSPIDER_CONTROL" && test "$WEBSPIDER_CONTROL_URL" = "http://127.0.0.1:7340/api/v1/agent-control" && test "$WEBSPIDER_AGENT_TOKEN" = "wsa_test"\n');
  fs.chmodSync(fakeCodex, 0o700);
  const database = new NodeDatabase(path.join(directory, 'node.db'));
  const roots = new RootedFileService([{ id: 'awr_context', path: workspace }]);
  const supervisor = new ProcessSupervisor({ stateDir: directory, database, rootService: roots, pollMs: 25 });
  supervisor.on('error', () => {});
  supervisor.start();
  t.after(() => {
    supervisor.stop();
    roots.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const completion = waitForCompletion(supervisor);
  const runtime = supervisor.launch({
    id: 'run_context', kind: 'agent', agentInstanceId: 'agt_context', terminalId: 'trm_context',
    rootId: 'awr_context', argv: [fakeCodex], environment: { CODEX_HOME: inheritedCodexHome },
    policySnapshot: {
      id: 'pol_context', project_id: 'prj_context', agent_role: 'main', system_policy_revision: 2,
      policy_revision: 3, content_hash: 'abc', policy: {},
      rendered_instructions: '# Agreement\n## Reduce user burden\nProceed with safe defaults.',
    },
    agentControl: {
      url: 'http://127.0.0.1:7340/api/v1/agent-control',
      token: 'wsa_test', scopes: ['policy:read', 'usage:read', 'usage:write'],
    },
  });
  const event = await completion;
  assert.equal(event.exit_status, 0);
  assert.equal(runtime.policySnapshotId, 'pol_context');
  assert.match(fs.readFileSync(path.join(directory, 'agent-context', 'agt_context', 'PROJECT_RULES.md'), 'utf8'), /Reduce user burden/);
  const managedAgents = fs.readFileSync(path.join(directory, 'agent-context', 'agt_context', 'codex-home', 'AGENTS.md'), 'utf8');
  assert.match(managedAgents, /Preserve the user rule/);
  assert.match(managedAgents, /Reduce user burden/);
  const controlScriptPath = path.join(directory, 'agent-context', 'agt_context', 'webspider-control');
  const controlScript = fs.readFileSync(controlScriptPath, 'utf8');
  assert.equal(spawnSync(process.execPath, ['--check', controlScriptPath]).status, 0);
  assert.match(controlScript, /expected_revision/);
  assert.match(controlScript, /usage report --weekly-remaining PERCENT/);
  assert.match(controlScript, /request\('usage', 'POST', body\)/);
  assert.match(controlScript, /agents list/);
  assert.match(controlScript, /portfolio list/);
  assert.match(controlScript, /report --status idle\|working\|blocked\|completed/);
  assert.match(controlScript, /request\('report', 'POST'/);
  assert.match(controlScript, /agents\/' \+ encodeURIComponent\(agent\) \+ '\/messages'/);
  assert.doesNotMatch(controlScript, /billing|subscription|api.?key|reset.?credit|add.?credit/i);
  assert.doesNotMatch(controlScript, /wsa_test/);
});
