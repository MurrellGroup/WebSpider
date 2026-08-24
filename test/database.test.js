import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HubDatabase } from '../src/db/hub-database.js';
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

test('terminal leases fence stale controllers', (t) => {
  const { database, agent } = databaseFixture(t);
  const first = database.acquireTerminalLease(agent.terminal_id, 'owner:laptop');
  assert.throws(() => database.acquireTerminalLease(agent.terminal_id, 'owner:phone'), (error) => error.code === 'WS_TERMINAL_LEASE_REQUIRED');
  assert(database.validateTerminalLease(agent.terminal_id, first.id, first.lease_epoch, 'owner:laptop'));
  assert.throws(() => database.validateTerminalLease(agent.terminal_id, first.id, first.lease_epoch - 1, 'owner:laptop'), (error) => error.code === 'WS_TERMINAL_LEASE_STALE');
  assert.equal(database.releaseTerminalLease(agent.terminal_id, first.id, 'owner:laptop'), true);
  const second = database.acquireTerminalLease(agent.terminal_id, 'owner:phone');
  assert(second.lease_epoch >= 1);
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

test('project policy is defaulted, versioned, and snapshotted for agent launches', (t) => {
  const { database, agent } = databaseFixture(t);
  const initial = database.getProject('prj_test');
  assert.equal(initial.policy.principle, 'minimize_user_burden');
  const updated = database.updateProjectPolicy('prj_test', { scholarly_work_product: { citations: 'verified references only' } });
  assert.equal(updated.policy_revision, 2);
  assert.equal(updated.policy.execution.validate_before_claiming_completion, true);
  const snapshot = database.createPolicySnapshot({
    projectId: updated.id,
    agentInstanceId: agent.id,
    policyRevision: updated.policy_revision,
    policy: updated.policy,
    renderedInstructions: '# Project agreement\nProceed with safe defaults.',
  });
  assert.equal(database.latestPolicySnapshot(agent.id).id, snapshot.id);
  assert.equal(snapshot.content_hash.length, 64);
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

test('worker tokens are self-report-only while main control tokens remain revocable', (t) => {
  const { database, agent } = databaseFixture(t);
  assert.equal(agent.orchestration_role, 'worker');
  database.issueAgentControlToken(agent.id, 'wsa_worker_status', ['status:write:self']);
  assert.deepEqual(database.getAgentControlToken('wsa_worker_status').scopes, ['status:write:self']);
  assert.throws(
    () => database.issueAgentControlToken(agent.id, 'wsa_worker', ['policy:read']),
    (error) => error.code === 'WS_FORBIDDEN',
  );
  const main = database.setAgentRole(agent.id, 'main');
  assert.equal(main.can_edit_behavior, true);
  database.issueAgentControlToken(main.id, 'wsa_main', ['policy:read', 'policy:write:project']);
  const principal = database.getAgentControlToken('wsa_main');
  assert.equal(principal.agent_instance_id, main.id);
  assert.deepEqual(principal.scopes, ['policy:read', 'policy:write:project']);
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
