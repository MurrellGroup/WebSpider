import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HubDatabase } from '../src/db/hub-database.js';
import { NodeBroker } from '../src/hub/node-broker.js';
import { generateNodeIdentity } from '../src/lib/security.js';
import { createDefaultProjectPolicy } from '../src/lib/project-policy.js';

function databaseFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-db-'));
  const database = new HubDatabase(path.join(directory, 'hub.db'));
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const identity = generateNodeIdentity();
  database.createNode({ id: 'nod_test', displayName: 'Test node', publicKey: identity.publicKey });
  database.createProject({ id: 'prj_test', name: 'Test project' });
  database.createProfile({ id: 'apf_test', name: 'Shell', adapterKind: 'pty', executable: '/bin/sh', arguments: [] });
  const agent = database.createAgent({
    id: 'agt_test', profileId: 'apf_test', projectId: 'prj_test', nodeId: 'nod_test',
    root: { id: 'awr_test', logical_name: 'workspace' },
  });
  return { database, agent };
}

test('message acceptance is durable and idempotent', (t) => {
  const { database, agent } = databaseFixture(t);
  const input = {
    threadId: agent.active_thread_id,
    actorId: 'owner:test',
    deliveryRole: 'user',
    displaySender: 'Tester',
    contentParts: [{ type: 'text', text: 'hello' }],
    wakePolicy: 'ensure_running',
    idempotencyKey: 'same-key',
  };
  const first = database.createMessage(input);
  const duplicate = database.createMessage(input);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.message.id, first.message.id);
  assert.equal(database.listMessages(agent.active_thread_id).length, 1);
  assert(database.listEvents(0).some((event) => event.type === 'message.accepted.v1'));
});

test('projects can be safely archived, restored, and permanently removed without touching a workspace', (t) => {
  const { database } = databaseFixture(t);
  database.setAgentRole('agt_test', 'main');
  assert.throws(
    () => database.archiveProject('prj_test'),
    (error) => error.code === 'WS_PROJECT_PROTECTED' && error.status === 409,
  );

  database.createProject({ id: 'prj_archive', name: 'Archive candidate' });
  const agent = database.createAgent({
    id: 'agt_archive', profileId: 'apf_test', projectId: 'prj_archive', nodeId: 'nod_test',
    root: { id: 'awr_archive', logical_name: 'workspace' },
  });
  const shell = database.createInteractiveTerminal(agent.id, 'Archive guard');
  database.setTerminalState(shell.id, 'attached');
  assert.throws(
    () => database.archiveProject('prj_archive'),
    (error) => error.code === 'WS_PROJECT_ACTIVE' && /shell/.test(error.message),
  );
  database.setTerminalState(shell.id, 'exited');
  assert.equal(database.deleteAuxiliaryTerminal(shell.id).id, shell.id);
  assert.equal(database.getTerminal(shell.id), null);
  const taskTerminal = database.createTaskTerminal(agent.id, 'Benchmark run');
  assert.equal(taskTerminal.label, 'Benchmark run');
  assert.equal(database.deleteAuxiliaryTerminal(taskTerminal.id).kind, 'task_shell');
  assert.equal(database.getTerminal(taskTerminal.id), null);
  assert.throws(
    () => database.deleteAuxiliaryTerminal(agent.terminal_id),
    (error) => error.code === 'WS_FORBIDDEN',
  );

  database.setAgentState(agent.id, 'stopping');
  assert.throws(
    () => database.archiveProject('prj_archive'),
    (error) => error.code === 'WS_PROJECT_ACTIVE',
  );
  database.setAgentState(agent.id, 'stopped');

  const task = database.createTask({ projectId: 'prj_archive', title: 'Finished work' });
  assert.throws(
    () => database.archiveProject('prj_archive'),
    (error) => error.code === 'WS_PROJECT_ACTIVE',
  );
  database.setTaskState(task.id, 'succeeded', { ok: true });
  const message = database.createMessage({
    threadId: agent.active_thread_id,
    actorId: 'owner:test',
    displaySender: 'Tester',
    contentParts: [{ type: 'text', text: 'kept until permanent deletion' }],
    idempotencyKey: 'archive-message',
  }).message;
  database.issueAgentControlToken(agent.id, 'wsa_archive_test', ['status:write:self']);

  const archived = database.archiveProject('prj_archive', 'owner:test');
  assert(archived.archived_at);
  assert.equal(database.getAgentControlToken('wsa_archive_test'), null);
  assert.equal(database.listProjects().some((project) => project.id === archived.id), false);
  assert.equal(database.listProjects({ archived: 'archived' })[0].id, archived.id);
  assert.throws(
    () => database.createTask({ projectId: archived.id, title: 'Blocked task' }),
    (error) => error.code === 'WS_PROJECT_ARCHIVED',
  );
  assert.throws(
    () => database.createMessage({
      threadId: agent.active_thread_id,
      actorId: 'owner:test',
      contentParts: [{ type: 'text', text: 'blocked message' }],
      idempotencyKey: 'blocked-after-archive',
    }),
    (error) => error.code === 'WS_PROJECT_ARCHIVED',
  );
  assert.throws(
    () => database.createAgent({
      id: 'agt_archive_blocked', profileId: 'apf_test', projectId: archived.id, nodeId: 'nod_test',
    }),
    (error) => error.code === 'WS_PROJECT_ARCHIVED',
  );

  const restored = database.restoreProject(archived.id, 'owner:test');
  assert.equal(restored.archived_at, null);
  assert(database.listProjects().some((project) => project.id === restored.id));
  database.archiveProject(restored.id, 'owner:test');
  assert.deepEqual(database.deleteArchivedProject(restored.id), {
    id: restored.id, name: restored.name, deleted: true,
  });
  assert.equal(database.getProject(restored.id), null);
  assert.equal(database.getAgent(agent.id), null);
  assert.equal(database.getTask(task.id), null);
  assert.equal(database.getMessage(message.id), null);
  assert.equal(database.listProjects({ archived: 'all' }).some((project) => project.id === restored.id), false);
});

test('offline transient commands expire while durable messages reuse one outbox command', async (t) => {
  const { database } = databaseFixture(t);
  const broker = new NodeBroker(database);

  let transientError;
  try {
    await broker.request('nod_test', 'terminal.input', { terminal_id: 'trm_test', data: 'ZA==' });
  } catch (error) {
    transientError = error;
  }
  assert.equal(transientError?.code, 'WS_NODE_OFFLINE');
  assert.equal(database.getOutbox(transientError.details.command_id).state, 'failed');
  assert.equal(database.pendingOutbox('nod_test').length, 0);

  const messagePayload = { message: { id: 'msg_durable' } };
  const durableErrors = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await broker.request('nod_test', 'message.deliver', messagePayload, { idempotencyKey: 'msg_durable' });
    } catch (error) {
      durableErrors.push(error);
    }
  }
  assert.deepEqual(durableErrors.map((error) => error.code), ['WS_NODE_OFFLINE', 'WS_NODE_OFFLINE']);
  assert.equal(durableErrors[0].details.command_id, durableErrors[1].details.command_id);
  assert.equal(database.pendingOutbox('nod_test').length, 1);
});

test('terminal leases fence stale controllers', (t) => {
  const { database, agent } = databaseFixture(t);
  const first = database.acquireTerminalLease(agent.terminal_id, 'owner:laptop');
  assert.throws(() => database.acquireTerminalLease(agent.terminal_id, 'owner:phone'), (error) => error.code === 'WS_TERMINAL_LEASE_REQUIRED');
  assert(database.validateTerminalLease(agent.terminal_id, first.id, first.lease_epoch, 'owner:laptop'));
  assert.throws(() => database.validateTerminalLease(agent.terminal_id, first.id, first.lease_epoch - 1, 'owner:laptop'), (error) => error.code === 'WS_TERMINAL_LEASE_STALE');
  database.db.prepare('UPDATE terminal_leases SET expires_at = ? WHERE id = ?').run('1970-01-01T00:00:00.000Z', first.id);
  const renewed = database.validateTerminalLease(agent.terminal_id, first.id, first.lease_epoch, 'owner:laptop');
  assert(new Date(renewed.expires_at) > new Date());
  database.db.prepare('UPDATE terminal_leases SET expires_at = ? WHERE id = ?').run('1970-01-01T00:00:00.000Z', first.id);
  const second = database.acquireTerminalLease(agent.terminal_id, 'owner:phone');
  assert(second.lease_epoch > first.lease_epoch);
  assert.throws(() => database.validateTerminalLease(agent.terminal_id, first.id, first.lease_epoch, 'owner:laptop'), (error) => error.code === 'WS_TERMINAL_LEASE_STALE');
});

test('task and event state survives database reopen', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-reopen-'));
  const file = path.join(directory, 'hub.db');
  const identity = generateNodeIdentity();
  let database = new HubDatabase(file);
  database.createNode({ id: 'nod_test', displayName: 'Node', publicKey: identity.publicKey });
  database.createProject({ id: 'prj_test', name: 'Project' });
  const task = database.createTask({ projectId: 'prj_test', title: 'Persistent task', specification: { argv: ['/bin/true'] } });
  database.setTaskState(task.id, 'running');
  const lastSequence = database.listEvents(0).at(-1).global_sequence;
  database.close();
  database = new HubDatabase(file);
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(database.getTask(task.id).state, 'running');
  assert.equal(database.listEvents(lastSequence - 1).at(-1).global_sequence, lastSequence);
});

test('note metadata is private by default and supports explicit master visibility', (t) => {
  const { database } = databaseFixture(t);
  const note = database.createNote({ title: 'Analysis ideas', filename: 'nte_test.txt' });
  assert.equal(note.visibility, 'private');
  assert.equal(database.listNotes({ visibility: 'master' }).length, 0);
  const visible = database.updateNote(note.id, { visibility: 'master', title: 'Analysis plan' });
  assert.equal(visible.visibility, 'master');
  assert.equal(database.listNotes({ visibility: 'master' })[0].title, 'Analysis plan');
  assert.equal(database.deleteNote(note.id).id, note.id);
  assert.equal(database.getNote(note.id), null);
});

test('fleet update readiness is durable, agent-specific, and auditable when the owner overrides it', (t) => {
  const { database, agent } = databaseFixture(t);
  const update = database.createFleetUpdate({
    targetVersion: '9.8.7', nodeIds: ['nod_test'], agentIds: [agent.id], requestedBy: 'owner:test',
  });
  assert.equal(database.getActiveFleetUpdate().id, update.id);
  assert.deepEqual(database.getFleetUpdate(update.id).ready_agents, {});
  const overridden = database.overrideFleetAgentReadiness(update.id, 'owner:test');
  assert.equal(overridden.ready_agents[agent.id].override, true);
  assert.equal(overridden.ready_agents[agent.id].actor_id, 'owner:test');
  const task = database.createTask({
    projectId: agent.project_id,
    type: 'command',
    title: 'Long preview server',
    specification: { argv: ['python3', '-m', 'http.server'] },
    assignedAgentInstanceId: agent.id,
    nodeId: 'nod_test',
    createdBy: `agent:${agent.id}`,
  });
  database.setTaskState(task.id, 'running');
  const allowed = database.allowFleetTask(update.id, task.id, 'owner:test');
  assert.deepEqual(allowed.allowed_task_ids, [task.id]);
  assert.deepEqual(database.getFleetUpdate(update.id).allowed_task_ids, [task.id]);
  database.setFleetUpdateNodeStatus(update.id, 'nod_test', { phase: 'complete', version: '9.8.7' });
  const completed = database.setFleetUpdateState(update.id, 'completed');
  assert.equal(completed.node_status.nod_test.version, '9.8.7');
  assert.equal(database.getActiveFleetUpdate(), null);
  assert.equal(database.latestFleetUpdate().state, 'completed');
  assert.throws(() => database.markFleetAgentReady(update.id, agent.id, 'agent:test'),
    (error) => error.code === 'WS_UPDATE_NOT_WAITING');
});

test('node join tokens are one-time and expire atomically', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-token-'));
  const database = new HubDatabase(path.join(directory, 'hub.db'));
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const identity = generateNodeIdentity();
  database.createJoinToken('GPU node', 'wsj_one_time', 10_000);
  const node = database.consumeJoinToken('wsj_one_time', identity.publicKey, 'GPU node');
  assert.equal(node.display_name, 'GPU node');
  assert.throws(() => database.consumeJoinToken('wsj_one_time', identity.publicKey, 'clone'), (error) => error.code === 'WS_AUTH_REQUIRED');
  database.createJoinToken('Expired node', 'wsj_expired', -1);
  assert.throws(() => database.consumeJoinToken('wsj_expired', identity.publicKey, 'expired'), (error) => error.code === 'WS_AUTH_REQUIRED');
});

test('trusted local bootstrap can refresh only its own isolated node credential', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-local-node-key-'));
  const database = new HubDatabase(path.join(directory, 'hub.db'));
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const first = generateNodeIdentity();
  const second = generateNodeIdentity();
  database.ensureLocalNode({
    id: 'nod_local', displayName: 'Local workstation', publicKey: first.publicKey, labels: { location: 'local' },
  });
  const refreshed = database.ensureLocalNode({
    id: 'nod_local', displayName: 'Local workstation', publicKey: second.publicKey, labels: { location: 'local' },
  });
  assert.equal(refreshed.public_key, second.publicKey);
  assert.equal(database.db.prepare('SELECT credential_version FROM nodes WHERE id = ?').get('nod_local').credential_version, 2);

  database.createNode({ id: 'nod_worker', displayName: 'Worker', publicKey: first.publicKey });
  assert.throws(() => database.ensureLocalNode({
    id: 'nod_worker', displayName: 'Worker', publicKey: second.publicKey,
  }), (error) => error.code === 'WS_CONFLICT');
});

test('project policy is defaulted, versioned, and snapshotted for agent launches', (t) => {
  const { database, agent } = databaseFixture(t);
  const initial = database.getProject('prj_test');
  assert.equal(initial.policy.principle, 'minimize_user_burden');
  const updated = database.updateProjectPolicy('prj_test', { scholarly_work_product: { citations: 'verified references only' } });
  assert.equal(updated.policy_revision, 2);
  assert.equal(updated.policy.execution.validate_before_claiming_completion, true);
  const instructed = database.updateAgentInstructions(agent.id, 'Keep reports compact.', 'owner:test', { expectedRevision: 1 });
  assert.equal(instructed.custom_instructions, 'Keep reports compact.');
  assert.equal(instructed.instruction_revision, 2);
  assert.equal(
    database.updateAgentInstructions(agent.id, 'Keep reports compact.', 'owner:test', { expectedRevision: 2 }).instruction_revision,
    2,
  );
  assert.throws(
    () => database.updateAgentInstructions(agent.id, 'stale edit', 'owner:test', { expectedRevision: 1 }),
    (error) => error.code === 'WS_INSTRUCTION_REVISION_CONFLICT' && error.status === 409,
  );
  const snapshot = database.createPolicySnapshot({
    projectId: updated.id,
    agentInstanceId: agent.id,
    policyRevision: updated.policy_revision,
    policy: updated.policy,
    agentInstructions: instructed.custom_instructions,
    agentInstructionRevision: instructed.instruction_revision,
    renderedInstructions: '# Project agreement\nProceed with safe defaults.',
  });
  assert.equal(database.latestPolicySnapshot(agent.id).id, snapshot.id);
  assert.equal(database.latestPolicySnapshot(agent.id).agent_instructions, 'Keep reports compact.');
  assert.equal(database.latestPolicySnapshot(agent.id).agent_instruction_revision, 2);
  assert.equal(snapshot.content_hash.length, 64);
});

test('an agent can persist an explicit user Codex resume selector only for Codex profiles', (t) => {
  const { database, agent } = databaseFixture(t);
  assert.equal(agent.codex_capable, false);
  assert.throws(() => database.setAgentCodexSession(agent.id, { source: 'user', selector: 'last' }),
    (error) => error.code === 'WS_ADAPTER_UNAVAILABLE');
  database.createProfile({ id: 'apf_codex', name: 'Codex', adapterKind: 'pty', executable: '/usr/local/bin/codex' });
  const codex = database.createAgent({
    id: 'agt_codex', profileId: 'apf_codex', projectId: 'prj_test', nodeId: 'nod_test',
    root: { id: 'awr_codex', logical_name: 'workspace' },
  });
  assert.equal(codex.codex_capable, true);
  const configured = database.setAgentCodexSession(codex.id, {
    source: 'user', selector: 'id', session_id: '01a00000-0000-0000-0000-000000000002',
  });
  assert.deepEqual(configured.codex_session, {
    source: 'user', selector: 'id', session_id: '01a00000-0000-0000-0000-000000000002',
  });
  assert.equal(database.setAgentCodexSession(codex.id, null).codex_session, null);
});

test('system defaults remain layered beneath project overrides with optimistic revisions', (t) => {
  const { database } = databaseFixture(t);
  const system = database.getSystemPolicy();
  assert.equal(system.revision, 1);
  const updatedSystem = database.updateSystemPolicy(
    { execution: { use_project_conventions: false } },
    { expectedRevision: 1, actor: 'agent:main', reason: 'User requested a system default change.' },
  );
  assert.equal(updatedSystem.revision, 2);
  assert.equal(database.updateSystemPolicy({}, { expectedRevision: updatedSystem.revision }).revision, updatedSystem.revision);
  assert.equal(database.getProject('prj_test').policy.execution.use_project_conventions, false);
  const project = database.updateProjectPolicy(
    'prj_test',
    { execution: { use_project_conventions: true } },
    'agent:main',
    { expectedRevision: 1, reason: 'User requested a project-specific exception.' },
  );
  assert.equal(project.policy.execution.use_project_conventions, true);
  assert.equal(project.system_policy_revision, 2);
  assert.throws(
    () => database.updateSystemPolicy({}, { expectedRevision: 1 }),
    (error) => error.code === 'WS_POLICY_REVISION_CONFLICT' && error.status === 409,
  );
});

test('worker tokens are confined to self controls and root-confined file relay', (t) => {
  const { database, agent } = databaseFixture(t);
  assert.equal(agent.orchestration_role, 'worker');
  database.issueAgentControlToken(agent.id, 'wsa_worker_status', ['status:write:self']);
  assert.deepEqual(database.getAgentControlToken('wsa_worker_status').scopes, ['status:write:self']);
  assert.throws(
    () => database.issueAgentControlToken(agent.id, 'wsa_worker', ['policy:read']),
    (error) => error.code === 'WS_FORBIDDEN',
  );
  database.issueAgentControlToken(agent.id, 'wsa_worker_hooks', [
    'status:write:self', 'tasks:read', 'tasks:write', 'reminders:read:self', 'reminders:write:self', 'files:transfer',
  ]);
  assert.deepEqual(database.getAgentControlToken('wsa_worker_hooks').scopes, [
    'status:write:self', 'tasks:read', 'tasks:write', 'reminders:read:self', 'reminders:write:self', 'files:transfer',
  ]);
  const main = database.setAgentRole(agent.id, 'main');
  assert.equal(main.can_edit_behavior, true);
  database.issueAgentControlToken(main.id, 'wsa_main', ['policy:read', 'policy:write:project', 'tasks:read', 'tasks:write']);
  const principal = database.getAgentControlToken('wsa_main');
  assert.equal(principal.agent_instance_id, main.id);
  assert.deepEqual(principal.scopes, ['policy:read', 'policy:write:project', 'tasks:read', 'tasks:write']);
  assert.equal(database.revokeAgentControlTokens(main.id), true);
  assert.equal(database.getAgentControlToken('wsa_main'), null);
  assert.throws(
    () => database.issueAgentControlToken(main.id, 'wsa_forbidden', ['billing:write']),
    (error) => error.code === 'WS_FORBIDDEN',
  );
});

test('weekly account allowance is stored as an observation and only main agents may report it', (t) => {
  const { database, agent } = databaseFixture(t);
  assert.throws(() => database.createAccountUsageSnapshot({
    agentInstanceId: agent.id,
    source: 'codex-status',
    rateLimits: [{ name: 'weekly', window_minutes: 10_080, remaining_percent: 60 }],
  }), (error) => error.code === 'WS_FORBIDDEN');

  const main = database.setAgentRole(agent.id, 'main');
  const observedAt = new Date(Date.now() - 3 * 60 * 60 * 1_000).toISOString();
  const snapshot = database.createAccountUsageSnapshot({
    agentInstanceId: main.id,
    source: 'codex-status',
    observedAt,
    rateLimits: [{
      name: 'weekly', window_minutes: 10_080, remaining_percent: 60,
      resets_at: new Date(Date.now() + 4 * 24 * 60 * 60 * 1_000).toISOString(),
    }],
    tokenActivity: { period: 'weekly', tokens: 123_456, source: 'codex-usage-weekly' },
  });
  assert.equal(snapshot.rate_limits[0].used_percent, 40);
  assert.equal(snapshot.token_activity.tokens, 123_456);
  assert.equal(database.latestAccountUsageSnapshot().id, snapshot.id);
  const status = database.accountUsageStatus();
  assert.equal(status.weekly.remaining_percent, 60);
  assert.equal(status.stale, true);
  assert.throws(() => database.createAccountUsageSnapshot({
    agentInstanceId: main.id,
    source: 'codex-status',
    rateLimits: [{
      name: 'weekly', window_minutes: 10_080, remaining_percent: 60, used_percent: 60,
    }],
  }), (error) => error.code === 'WS_VALIDATION');
});

test('a 0.2 project migrates to layered policy without pinning old built-in defaults', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-policy-migration-'));
  const file = path.join(directory, 'hub.db');
  const legacyPolicy = createDefaultProjectPolicy();
  legacyPolicy.schema_version = 1;
  delete legacyPolicy.behavior_control;
  delete legacyPolicy.harness_deference;
  delete legacyPolicy.context_budget;
  delete legacyPolicy.account_quota;
  delete legacyPolicy.requested_instructions;
  legacyPolicy.scholarly_work_product.citations = 'legacy user citation preference';
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
    labels_json TEXT NOT NULL DEFAULT '{}', policy_json TEXT NOT NULL DEFAULT '{}',
    policy_revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  raw.prepare(`INSERT INTO projects
    (id, name, description, labels_json, policy_json, policy_revision, created_at, updated_at)
    VALUES (?, ?, '', ?, ?, 4, ?, ?)`).run(
    'prj_legacy', 'Legacy project', JSON.stringify({ project_kind: 'academic' }),
    JSON.stringify(legacyPolicy), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
  );
  raw.close();
  const database = new HubDatabase(file);
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const project = database.getProject('prj_legacy');
  assert.equal(project.policy.schema_version, 3);
  assert.equal(project.policy.behavior_control.edit_trigger, 'explicit_user_request_only');
  assert.equal(project.policy.harness_deference.remote_default, 'native_harness');
  assert.equal(project.policy.scholarly_work_product.citations, 'legacy user citation preference');
  assert.equal(project.policy_overrides.schema_version, undefined);
});
