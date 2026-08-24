import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub } from '../src/hub/hub.js';
import { formatInboundMessage, NodeDaemon } from '../src/node/node-daemon.js';
import { generateNodeIdentity, signNodeHello } from '../src/lib/security.js';

function onceWithTimeout(emitter, event, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    emitter.once(event, (value) => { clearTimeout(timer); resolve(value); });
  });
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}

async function jsonFetch(url, ownerToken, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${ownerToken}`, ...(options.headers || {}) },
  });
  const body = await response.json();
  return { response, body };
}

test('inbound agent messages include source, UTC time, elapsed context, and observed weekly allowance', () => {
  const formatted = formatInboundMessage({
    created_at: '2026-08-24T10:30:00.000Z',
    display_sender: 'Research worker',
    content_parts: [{ type: 'text', text: 'Analysis completed.' }],
  }, {
    message_timestamp_utc: '2026-08-24T10:30:00.000Z',
    delivered_at_utc: '2026-08-24T10:30:03.000Z',
    source: 'Research worker',
    elapsed_since_previous_message_ms: 5_400_000,
    account_quota: {
      available: true,
      remaining_percent: 60,
      observed_at: '2026-08-24T10:00:00.000Z',
      source: 'codex-status',
      stale: false,
      resets_at: '2026-08-28T10:00:00.000Z',
    },
  });
  assert.match(formatted, /Message timestamp \(UTC\): 2026-08-24T10:30:00\.000Z/);
  assert.match(formatted, /Delivered \(UTC\): 2026-08-24T10:30:03\.000Z/);
  assert.match(formatted, /Source: Research worker/);
  assert.match(formatted, /Elapsed: 1h 30m since the previous inbound message/);
  assert.match(formatted, /Weekly account allowance: 60% remaining/);
  assert.match(formatted, /observed 2026-08-24T10:00:00\.000Z via codex-status; fresh/);
  assert.match(formatted, /Analysis completed\./);
});

test('hub notes are disk-backed and only explicitly visible notes reach the main agent', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-notes-'));
  const workspace = path.join(directory, 'workspace');
  const hubState = path.join(directory, 'hub');
  fs.mkdirSync(workspace);
  const identity = generateNodeIdentity();
  const hub = new Hub({ stateDir: hubState, listenPort: 0 });
  const bootstrap = hub.bootstrapLocal({ nodeId: 'nod_notes', publicKey: identity.publicKey, workspace });
  const listening = await hub.listen();
  t.after(async () => {
    await hub.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const created = await jsonFetch(`${listening.url}/api/v1/notes`, listening.ownerToken, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Private thought', content: 'not for agents' }),
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.visibility, 'private');
  const notePath = path.join(hubState, 'notes', created.body.filename);
  assert.equal(fs.readFileSync(notePath, 'utf8'), 'not for agents');
  assert.equal(fs.statSync(notePath).mode & 0o777, 0o600);

  hub.database.issueAgentControlToken(bootstrap.agent.id, 'wsa_notes_master', ['notes:read:visible']);
  const hidden = await jsonFetch(`${listening.url}/api/v1/agent-control/notes`, 'wsa_notes_master');
  assert.deepEqual(hidden.body.notes, []);

  const updated = await jsonFetch(`${listening.url}/api/v1/notes/${created.body.id}`, listening.ownerToken, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Shared plan', content: 'master may read this', visibility: 'master' }),
  });
  assert.equal(updated.body.visibility, 'master');
  assert.equal(fs.readFileSync(notePath, 'utf8'), 'master may read this');
  const visible = await jsonFetch(`${listening.url}/api/v1/agent-control/notes`, 'wsa_notes_master');
  assert.equal(visible.body.notes.length, 1);
  assert.equal(visible.body.notes[0].content, 'master may read this');

  const worker = hub.database.createAgent({
    id: 'agt_notes_worker', profileId: bootstrap.agent.profile_id, projectId: bootstrap.project.id,
    nodeId: bootstrap.agent.node_id, orchestrationRole: 'worker',
  });
  assert.throws(
    () => hub.database.issueAgentControlToken(worker.id, 'wsa_notes_worker', ['notes:read:visible']),
    (error) => error.code === 'WS_FORBIDDEN',
  );

  const deleted = await jsonFetch(`${listening.url}/api/v1/notes/${created.body.id}`, listening.ownerToken, { method: 'DELETE' });
  assert.equal(deleted.body.deleted, true);
  assert.equal(fs.existsSync(notePath), false);
});

test('a missing previously-running agent is restarted and receives a durable recovery message', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-reboot-recovery-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  const identity = generateNodeIdentity();
  const hubState = path.join(directory, 'hub');
  let hub = new Hub({ stateDir: hubState, listenPort: 0 });
  const bootstrap = hub.bootstrapLocal({
    nodeId: 'nod_recovery', publicKey: identity.publicKey, workspace, rootId: 'awr_recovery',
  });
  hub.database.setAgentState(bootstrap.agent.id, 'ready', 'test:pre-reboot');
  await hub.listen();
  await hub.close();
  hub = new Hub({ stateDir: hubState, listenPort: 0 });
  const listening = await hub.listen();
  const node = new NodeDaemon({
    stateDir: path.join(directory, 'node'), hubURL: listening.url,
    nodeId: 'nod_recovery', displayName: 'Recovery node',
    publicKey: identity.publicKey, privateKey: identity.privateKey,
    roots: [{ id: 'awr_recovery', path: workspace, symlink_policy: 'no_symlinks' }],
    reconnect: false,
  });
  node.on('error', () => {});
  const online = onceWithTimeout(node, 'online');
  node.start();
  await online;
  const connectionStatus = JSON.parse(fs.readFileSync(path.join(directory, 'node', 'connection-status.json'), 'utf8'));
  assert.equal(connectionStatus.connection_state, 'online');
  assert(connectionStatus.connection_epoch > 0);
  t.after(async () => {
    const runtime = node.database.getProcessByAgent(bootstrap.agent.id);
    if (runtime?.state === 'running') node.supervisor.stopProcess(runtime.id, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await node.stop();
    await hub.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await waitUntil(() => {
    const runtime = node.database.getProcessByAgent(bootstrap.agent.id);
    return hub.database.getAgent(bootstrap.agent.id).state === 'ready' && runtime?.state === 'running';
  });
  const messages = hub.database.listMessages(bootstrap.agent.active_thread_id);
  const recovery = messages.find((message) => message.display_sender === 'WebSpider recovery');
  assert(recovery);
  assert.match(recovery.content_parts[0].text, /continue without asking the user to restate the project/i);
  assert(hub.database.listEvents(0).some((event) => event.payload?.reason === 'runtime_missing_after_node_reconnect'));
});

test('hub and outbound node provide a root-confined end-to-end API', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-e2e-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'report.txt'), 'durable result\n');
  const identity = generateNodeIdentity();
  const hub = new Hub({ stateDir: path.join(directory, 'hub'), listenPort: 0 });
  const bootstrap = hub.bootstrapLocal({ nodeId: 'nod_e2e', publicKey: identity.publicKey, workspace, rootId: 'awr_e2e' });
  const listening = await hub.listen();
  const node = new NodeDaemon({
    stateDir: path.join(directory, 'node'),
    hubURL: listening.url,
    nodeId: 'nod_e2e',
    displayName: 'E2E node',
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    roots: [{ id: 'awr_e2e', path: workspace, symlink_policy: 'no_symlinks' }],
    reconnect: false,
  });
  node.on('error', () => {});
  const online = onceWithTimeout(node, 'online');
  node.start();
  await online;
  t.after(async () => {
    await node.stop();
    await hub.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const list = await jsonFetch(`${listening.url}/api/v1/roots/awr_e2e/entries`, listening.ownerToken);
  assert.equal(list.response.status, 200);
  assert(list.body.entries.some((entry) => entry.name === 'report.txt'));

  const unauthenticated = await fetch(`${listening.url}/api/v1/projects`);
  assert.equal(unauthenticated.status, 401);
  assert.equal(bootstrap.agent.orchestration_role, 'main');

  const policy = await jsonFetch(`${listening.url}/api/v1/projects/${bootstrap.project.id}/policy`, listening.ownerToken);
  assert.equal(policy.response.status, 200);
  assert.equal(policy.body.policy.principle, 'minimize_user_burden');
  assert.match(policy.body.rendered_instructions, /Reduce user burden/);
  const policyUpdate = await jsonFetch(`${listening.url}/api/v1/projects/${bootstrap.project.id}/policy`, listening.ownerToken, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ policy: { execution: { use_project_conventions: false } } }),
  });
  assert.equal(policyUpdate.response.status, 200);
  assert.equal(policyUpdate.body.revision, 2);
  assert.equal(policyUpdate.body.policy.execution.validate_before_claiming_completion, true);

  hub.database.issueAgentControlToken(bootstrap.agent.id, 'wsa_e2e_control', [
    'policy:read', 'policy:write:project', 'policy:write:system', 'usage:read', 'usage:write', 'agents:read', 'messages:write',
  ]);
  const worker = hub.database.createAgent({
    id: 'agt_e2e_worker',
    profileId: bootstrap.agent.profile_id,
    projectId: bootstrap.project.id,
    nodeId: bootstrap.agent.node_id,
    title: 'Remote worker',
    orchestrationRole: 'worker',
  });
  const agentList = await jsonFetch(`${listening.url}/api/v1/agent-control/agents`, 'wsa_e2e_control');
  assert.equal(agentList.response.status, 200);
  assert.equal(agentList.body.agents.find((agent) => agent.id === bootstrap.agent.id).is_self, true);
  assert.equal(agentList.body.agents.find((agent) => agent.id === worker.id).is_self, false);
  const agentMessage = await jsonFetch(`${listening.url}/api/v1/agent-control/agents/${worker.id}/messages`, 'wsa_e2e_control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Check the remote result.', wake_policy: 'queue_only' }),
  });
  assert.equal(agentMessage.response.status, 200);
  assert.equal(agentMessage.body.message.authenticated_actor_id, `agent:${bootstrap.agent.id}`);
  assert.equal(agentMessage.body.message.delivery_role, 'user');
  assert.match(agentMessage.body.message.display_sender, /via WebSpider/);
  const agentPolicy = await jsonFetch(`${listening.url}/api/v1/agent-control/policy`, 'wsa_e2e_control');
  assert.equal(agentPolicy.response.status, 200);
  assert.equal(agentPolicy.body.project.revision, 2);
  const agentOrdinaryRoute = await jsonFetch(`${listening.url}/api/v1/projects`, 'wsa_e2e_control');
  assert.equal(agentOrdinaryRoute.response.status, 403);
  const agentUpdate = await jsonFetch(`${listening.url}/api/v1/agent-control/policy`, 'wsa_e2e_control', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'project',
      expected_revision: 2,
      reason: 'User explicitly requested this project behavior change.',
      patch: { execution: { minimize_unrelated_changes: false } },
    }),
  });
  assert.equal(agentUpdate.response.status, 200);
  assert.equal(agentUpdate.body.revision, 3);
  assert.equal(agentUpdate.body.restart_required, true);
  const staleUpdate = await jsonFetch(`${listening.url}/api/v1/agent-control/policy`, 'wsa_e2e_control', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'project', expected_revision: 2,
      reason: 'User explicitly requested another behavior change.', patch: {},
    }),
  });
  assert.equal(staleUpdate.response.status, 409);

  const usageReport = await jsonFetch(`${listening.url}/api/v1/agent-control/usage`, 'wsa_e2e_control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'codex-status',
      observed_at: new Date().toISOString(),
      rate_limits: [{ name: 'weekly', window_minutes: 10_080, remaining_percent: 60 }],
      token_activity: { period: 'weekly', tokens: 987_654, source: 'codex-usage-weekly' },
    }),
  });
  assert.equal(usageReport.response.status, 200);
  assert.equal(usageReport.body.weekly.remaining_percent, 60);
  assert.equal(usageReport.body.snapshot.token_activity.tokens, 987_654);
  const ownerUsage = await jsonFetch(`${listening.url}/api/v1/account-usage`, listening.ownerToken);
  assert.equal(ownerUsage.response.status, 200);
  assert.equal(ownerUsage.body.weekly.remaining_percent, 60);
  const forbiddenAccountMutation = await jsonFetch(`${listening.url}/api/v1/agent-control/usage/reset`, 'wsa_e2e_control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(forbiddenAccountMutation.response.status, 404);

  const portal = await fetch(listening.url);
  assert.equal(portal.status, 200);
  const contentSecurityPolicy = portal.headers.get('content-security-policy');
  assert.match(contentSecurityPolicy, /object-src 'none'/);
  assert.match(contentSecurityPolicy, /style-src 'self' 'unsafe-inline'/);
  assert.match(contentSecurityPolicy, /script-src 'self';/);
  assert.doesNotMatch(contentSecurityPolicy, /script-src[^;]*'unsafe-inline'/);
  assert.match(await portal.text(), /WebSpider/);
  const markdownModule = await fetch(`${listening.url}/markdown.js`);
  assert.equal(markdownModule.status, 200);
  assert.match(markdownModule.headers.get('content-type'), /javascript/);
  assert.match(await markdownModule.text(), /renderMarkdown/);
  const randomModule = await fetch(`${listening.url}/random.js`);
  assert.equal(randomModule.status, 200);
  assert.match(randomModule.headers.get('content-type'), /javascript/);
  assert.doesNotMatch(await randomModule.text(), /randomUUID/);
  const terminalModule = await fetch(`${listening.url}/vendor/xterm.mjs`);
  assert.equal(terminalModule.status, 200);
  assert.match(terminalModule.headers.get('content-type'), /javascript/);
  assert.match(await terminalModule.text(), /export\{.*Terminal/);
  const fitModule = await fetch(`${listening.url}/vendor/addon-fit.mjs`);
  assert.equal(fitModule.status, 200);
  assert.match(fitModule.headers.get('content-type'), /javascript/);
  assert.match(await fitModule.text(), /FitAddon/);
  const terminalStyles = await fetch(`${listening.url}/vendor/xterm.css`);
  assert.equal(terminalStyles.status, 200);
  assert.match(terminalStyles.headers.get('content-type'), /css/);

  const login = await fetch(`${listening.url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: listening.ownerToken }),
  });
  assert.equal(login.status, 200);
  const setCookies = login.headers.getSetCookie();
  const sessionCookie = setCookies.find((value) => value.startsWith('ws_session=')).split(';')[0];
  const csrfCookie = setCookies.find((value) => value.startsWith('ws_csrf=')).split(';')[0];
  const csrfToken = decodeURIComponent(csrfCookie.slice('ws_csrf='.length));
  const blockedCsrf = await fetch(`${listening.url}/api/v1/projects`, {
    method: 'POST',
    headers: { cookie: `${sessionCookie}; ${csrfCookie}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Blocked project' }),
  });
  assert.equal(blockedCsrf.status, 403);
  const allowedCsrf = await fetch(`${listening.url}/api/v1/projects`, {
    method: 'POST',
    headers: { cookie: `${sessionCookie}; ${csrfCookie}`, 'content-type': 'application/json', 'x-webspider-csrf': csrfToken },
    body: JSON.stringify({ name: 'CSRF-protected project' }),
  });
  assert.equal(allowedCsrf.status, 200);

  const traversal = await jsonFetch(`${listening.url}/api/v1/roots/awr_e2e/preview?path=${encodeURIComponent('../outside')}`, listening.ownerToken);
  assert.equal(traversal.response.status, 403);
  assert.equal(traversal.body.error.code, 'WS_PATH_ESCAPE_BLOCKED');

  const messagePayload = {
    parts: [{ type: 'text', text: 'echo WebSpider-message' }],
    delivery_role: 'user',
    wake_policy: 'queue_only',
  };
  const message = await jsonFetch(`${listening.url}/api/v1/threads/${bootstrap.agent.active_thread_id}/messages`, listening.ownerToken, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'e2e-message' },
    body: JSON.stringify(messagePayload),
  });
  assert.equal(message.response.status, 200);
  assert.equal(message.body.message.content_parts[0].text, 'echo WebSpider-message');
  const duplicate = await jsonFetch(`${listening.url}/api/v1/threads/${bootstrap.agent.active_thread_id}/messages`, listening.ownerToken, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'e2e-message' },
    body: JSON.stringify(messagePayload),
  });
  assert.equal(duplicate.body.duplicate, true);

  const events = await jsonFetch(`${listening.url}/api/v1/events?after=0`, listening.ownerToken);
  assert(events.body.events.some((event) => event.type === 'node.online.v1'));
  assert(events.body.events.some((event) => event.type === 'message.accepted.v1'));
});

test('a project invite provisions a persistent remote Codex worker with reports and shell tabs', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-portfolio-'));
  const localWorkspace = path.join(directory, 'master');
  const remoteWorkspace = path.join(directory, 'remote-project');
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(localWorkspace);
  fs.mkdirSync(remoteWorkspace);
  fs.mkdirSync(bin);
  const fakeCodex = path.join(bin, 'codex');
  fs.writeFileSync(fakeCodex, '#!/bin/sh\nprintf "fake-codex-ready\\n"\nexec cat\n');
  fs.chmodSync(fakeCodex, 0o700);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;

  const localIdentity = generateNodeIdentity();
  const remoteIdentity = generateNodeIdentity();
  const hub = new Hub({ stateDir: path.join(directory, 'hub'), listenPort: 0 });
  const bootstrap = hub.bootstrapLocal({
    nodeId: 'nod_portfolio_master', publicKey: localIdentity.publicKey,
    workspace: localWorkspace, rootId: 'awr_portfolio_master',
  });
  const listening = await hub.listen();
  let node;
  t.after(async () => {
    process.env.PATH = originalPath;
    if (node) {
      for (const runtime of node.database.listProcesses()) {
        if (runtime.state === 'running') node.supervisor.stopProcess(runtime.id, 'SIGTERM');
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      await node.stop();
    }
    await hub.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const onboard = await jsonFetch(`${listening.url}/api/v1/projects/onboard`, listening.ownerToken, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_name: 'Remote study', node_name: 'GPU workstation' }),
  });
  assert.equal(onboard.response.status, 200);
  const physicalRootId = 'awr_remote_physical';
  const enrollment = await fetch(`${listening.url}/api/v1/nodes/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: onboard.body.invite.token,
      name: 'GPU workstation',
      public_key: remoteIdentity.publicKey,
      labels: { os: process.platform, arch: process.arch },
      capabilities: {
        rooted_files: true, detached_processes: true, codex: true,
        shell: process.env.SHELL || '/bin/bash',
        root_ids: [physicalRootId], roots: [{ id: physicalRootId, name: 'remote-project' }],
      },
    }),
  });
  assert.equal(enrollment.status, 200);
  const enrolled = await enrollment.json();
  assert(enrolled.agent_id);

  node = new NodeDaemon({
    stateDir: path.join(directory, 'remote-node'), hubURL: listening.url,
    nodeId: enrolled.node_id, displayName: 'GPU workstation',
    publicKey: remoteIdentity.publicKey, privateKey: remoteIdentity.privateKey,
    roots: [{ id: physicalRootId, path: remoteWorkspace, display_name: 'remote-project', symlink_policy: 'no_symlinks' }],
    reconnect: false,
  });
  node.on('error', () => {});
  const online = onceWithTimeout(node, 'online');
  node.start();
  await online;
  await waitUntil(() => hub.database.getAgent(enrolled.agent_id)?.state === 'ready', 10_000);
  const worker = hub.database.getAgent(enrolled.agent_id);
  assert.equal(worker.project_id, onboard.body.project.id);
  assert.equal(worker.node_id, enrolled.node_id);
  assert.equal(node.database.getProcessByAgent(worker.id)?.state, 'running');

  hub.database.issueAgentControlToken(bootstrap.agent.id, 'wsa_portfolio_master', ['portfolio:read', 'agents:read', 'messages:write']);
  const portfolio = await jsonFetch(`${listening.url}/api/v1/agent-control/portfolio`, 'wsa_portfolio_master');
  assert.equal(portfolio.response.status, 200);
  assert(portfolio.body.projects.some((project) => project.id === onboard.body.project.id));
  const delegated = await jsonFetch(`${listening.url}/api/v1/agent-control/agents/${worker.id}/messages`, 'wsa_portfolio_master', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Run the remote analysis and report progress.', wake_policy: 'ensure_running' }),
  });
  assert.equal(delegated.response.status, 200);
  await waitUntil(() => node.supervisor.snapshot(worker.terminal_id).text.includes('Run the remote analysis'), 5_000);

  hub.database.issueAgentControlToken(worker.id, 'wsa_worker_report', ['status:write:self']);
  const report = await jsonFetch(`${listening.url}/api/v1/agent-control/report`, 'wsa_worker_report', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'working', summary: 'Analysis is running on the GPU.' }),
  });
  assert.equal(report.response.status, 200);
  assert.equal(hub.database.getAgent(worker.id).work_status, 'working');
  assert(hub.database.listMessages(bootstrap.agent.active_thread_id)
    .some((message) => message.content_parts[0].text.includes('Analysis is running on the GPU.')));

  const shellTab = await jsonFetch(`${listening.url}/api/v1/agent-instances/${worker.id}/terminals`, listening.ownerToken, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'GPU monitor' }),
  });
  assert.equal(shellTab.response.status, 200);
  assert.equal(shellTab.body.kind, 'shell_tab');
  assert.equal(node.database.getProcessByTerminal(shellTab.body.id)?.kind, 'shell');
  assert.equal(node.database.getProcessByAgent(worker.id)?.kind, 'agent');

  const stopped = await jsonFetch(`${listening.url}/api/v1/agent-instances/${worker.id}:stop`, listening.ownerToken, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(stopped.response.status, 200);
  assert.equal(stopped.body.state, 'stopped');
  const exitedRuntime = node.database.getProcessByAgent(worker.id);
  assert.notEqual(exitedRuntime.state, 'running');
  const restarted = await jsonFetch(`${listening.url}/api/v1/agent-instances/${worker.id}:wake`, listening.ownerToken, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(restarted.response.status, 200);
  assert.equal(restarted.body.state, 'ready');
  assert.equal(node.database.getProcessByAgent(worker.id).state, 'running');
  assert.notEqual(node.database.getProcessByAgent(worker.id).id, exitedRuntime.id);

  const secondProject = await jsonFetch(`${listening.url}/api/v1/projects/onboard`, listening.ownerToken, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_name: 'Second remote study', node_name: 'GPU workstation' }),
  });
  const secondRootId = 'awr_second_physical';
  const timestamp = Date.now();
  const nonce = 'second-project-attachment';
  const attachment = await fetch(`${listening.url}/api/v1/nodes/attach-root`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: secondProject.body.invite.token,
      node_id: enrolled.node_id,
      timestamp,
      nonce,
      signature: signNodeHello(remoteIdentity.privateKey, enrolled.node_id, timestamp, nonce),
      root: { id: secondRootId, name: 'second-remote-project' },
    }),
  });
  assert.equal(attachment.status, 200);
  const attached = await attachment.json();
  assert.equal(attached.node_id, enrolled.node_id);
  assert.equal(hub.database.getAgent(attached.agent_id).project_id, secondProject.body.project.id);
  assert.deepEqual(hub.database.getNode(enrolled.node_id).capabilities.root_ids.sort(), [physicalRootId, secondRootId].sort());
  const reusedInvite = await fetch(`${listening.url}/api/v1/nodes/attach-root`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: secondProject.body.invite.token,
      node_id: enrolled.node_id,
      timestamp,
      nonce,
      signature: signNodeHello(remoteIdentity.privateKey, enrolled.node_id, timestamp, nonce),
      root: { id: 'awr_reused', name: 'reused' },
    }),
  });
  assert.equal(reusedInvite.status, 401);
});
