import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { Hub } from '../src/hub/hub.js';
import { formatInboundMessage, NodeDaemon } from '../src/node/node-daemon.js';
import { generateNodeIdentity, signNodeHello } from '../src/lib/security.js';
import { FILE_TRANSFER_CHUNK_BYTES } from '../src/lib/file-transfer.js';
import { WEBSPIDER_VERSION } from '../src/lib/self-update.js';

const execFileAsync = promisify(execFile);

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

test('an installer attachment re-enrolls a node identity forgotten by a rebuilt hub', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-stale-node-'));
  const workspace = path.join(directory, 'workspace');
  const nodeState = path.join(directory, 'node');
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(workspace);
  fs.mkdirSync(nodeState);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(bin, 'codex'), 0o700);
  const staleIdentity = { nodeId: 'nod_from_previous_hub', ...generateNodeIdentity() };
  fs.writeFileSync(path.join(nodeState, 'identity.json'), JSON.stringify(staleIdentity), { mode: 0o600 });
  fs.writeFileSync(path.join(nodeState, 'config.json'), JSON.stringify({
    hubURL: 'http://127.0.0.1:1', displayName: 'Recovered workstation', roots: [],
  }), { mode: 0o600 });

  const hub = new Hub({ stateDir: path.join(directory, 'hub'), listenPort: 0 });
  const project = hub.database.createProject({ name: 'Recovered project' });
  const token = 'wsj_recover_stale_identity';
  hub.database.createJoinToken('Recovered workstation', token, 60_000, { project_id: project.id });
  const listening = await hub.listen();
  t.after(async () => {
    await hub.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const result = await execFileAsync(process.execPath, [
    path.resolve('bin/webspider.js'), 'node', 'attach',
    '--hub', listening.url, '--token', token, '--workspace', workspace,
    '--state-dir', nodeState, '--name', 'Recovered workstation',
  ], { env: { ...process.env, PATH: `${bin}:${process.env.PATH || ''}` } });
  assert.match(result.stdout, /"enrolled": true/);
  const identity = JSON.parse(fs.readFileSync(path.join(nodeState, 'identity.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.join(nodeState, 'config.json'), 'utf8'));
  assert.notEqual(identity.nodeId, staleIdentity.nodeId);
  assert.equal(hub.database.getNode(identity.nodeId, true).display_name, 'Recovered workstation');
  assert.equal(config.hubURL, listening.url);
  assert.equal(config.roots[0].path, workspace);
  assert.equal(hub.database.listAgents(project.id).length, 1);
});

test('same-machine Hub and worker identities stay online across one shared process store', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-same-machine-nodes-'));
  const hubWorkspace = path.join(directory, 'hub-workspace');
  const workerWorkspace = path.join(directory, 'worker-workspace');
  fs.mkdirSync(hubWorkspace);
  fs.mkdirSync(workerWorkspace);
  const localIdentity = generateNodeIdentity();
  const workerIdentity = generateNodeIdentity();
  const hub = new Hub({ stateDir: path.join(directory, 'hub'), listenPort: 0 });
  hub.bootstrapLocal({ nodeId: 'nod_local', publicKey: localIdentity.publicKey, workspace: hubWorkspace });
  hub.database.createNode({ id: 'nod_worker', displayName: 'Same machine worker', publicKey: workerIdentity.publicKey });
  const listening = await hub.listen();
  const sharedState = path.join(directory, 'shared-process-state');
  const local = new NodeDaemon({
    stateDir: sharedState, hubURL: listening.url, nodeId: 'nod_local', displayName: 'Local workstation',
    publicKey: localIdentity.publicKey, privateKey: localIdentity.privateKey,
    roots: [{ id: 'awr_local', path: hubWorkspace }], reconnect: false,
  });
  const worker = new NodeDaemon({
    stateDir: sharedState, hubURL: listening.url, nodeId: 'nod_worker', displayName: 'Same machine worker',
    publicKey: workerIdentity.publicKey, privateKey: workerIdentity.privateKey,
    roots: [{ id: 'awr_worker', path: workerWorkspace }], reconnect: false,
  });
  local.on('error', () => {});
  worker.on('error', () => {});
  let unexpectedOffline = 0;
  local.on('offline', () => { unexpectedOffline += 1; });
  worker.on('offline', () => { unexpectedOffline += 1; });
  t.after(async () => {
    await local.stop();
    await worker.stop();
    await hub.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const localOnline = onceWithTimeout(local, 'online');
  const workerOnline = onceWithTimeout(worker, 'online');
  local.start();
  worker.start();
  await Promise.all([localOnline, workerOnline]);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(hub.broker.isOnline('nod_local'), true);
  assert.equal(hub.broker.isOnline('nod_worker'), true);
  assert.equal(unexpectedOffline, 0);
});

test('coordinated update waits for explicit readiness and resumes the Master Codex session', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-fleet-update-'));
  const workspace = path.join(directory, 'workspace');
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(workspace);
  fs.mkdirSync(bin);
  const fakeCodex = path.join(bin, 'codex');
  fs.writeFileSync(fakeCodex, `#!/bin/sh
mkdir -p "$CODEX_HOME/sessions/2026/08/25"
printf '{}\\n' > "$CODEX_HOME/sessions/2026/08/25/fleet-session.jsonl"
if [ "$1" = resume ]; then printf '%s\\n' "$@" > fleet-resume-args.txt; fi
trap 'exit 0' TERM INT
while :; do sleep 0.05; done
`);
  fs.chmodSync(fakeCodex, 0o700);
  const identity = generateNodeIdentity();
  const hub = new Hub({
    stateDir: path.join(directory, 'hub'), listenPort: 0,
    latestReleaseResolver: async () => WEBSPIDER_VERSION,
    fleetUpdateGraceMs: 0,
  });
  const bootstrap = hub.bootstrapLocal({
    nodeId: 'nod_local', publicKey: identity.publicKey, workspace,
    agentProfile: { id: 'apf_fleet_codex', name: 'Codex', adapterKind: 'pty', executable: fakeCodex, arguments: [] },
  });
  const listening = await hub.listen();
  const node = new NodeDaemon({
    stateDir: path.join(directory, 'node'), hubURL: listening.url,
    nodeId: 'nod_local', displayName: 'Local workstation',
    publicKey: identity.publicKey, privateKey: identity.privateKey,
    roots: [{ id: bootstrap.root_id, path: workspace }], reconnect: false,
  });
  node.on('error', () => {});
  t.after(async () => {
    try {
      await jsonFetch(`${listening.url}/api/v1/agent-instances/${bootstrap.agent.id}:stop`, listening.ownerToken, { method: 'POST' });
    } catch {}
    await node.stop();
    await hub.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const online = onceWithTimeout(node, 'online');
  node.start();
  await online;
  const woken = await jsonFetch(`${listening.url}/api/v1/agent-instances/${bootstrap.agent.id}:wake`, listening.ownerToken, { method: 'POST' });
  assert.equal(woken.response.status, 200);
  await waitUntil(() => hub.database.getAgent(bootstrap.agent.id).state === 'ready');

  const prepared = await jsonFetch(`${listening.url}/api/v1/fleet-updates`, listening.ownerToken, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmation: 'update-all' }),
  });
  assert.equal(prepared.response.status, 200);
  assert.equal(prepared.body.update.blockers.pending_agents.length, 1);
  const updateId = prepared.body.update.id;
  const readyToken = 'wsa_fleet_update_ready_test';
  hub.database.issueAgentControlToken(bootstrap.agent.id, readyToken, ['updates:write:self']);
  const ready = await fetch(`${listening.url}/api/v1/agent-control/updates/${updateId}:ready`, {
    method: 'POST', headers: { authorization: `Bearer ${readyToken}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(ready.status, 200);
  await waitUntil(() => hub.database.latestFleetUpdate()?.state === 'completed', 10_000);
  await waitUntil(() => fs.existsSync(path.join(workspace, 'fleet-resume-args.txt')), 5_000);
  const resumeArgs = fs.readFileSync(path.join(workspace, 'fleet-resume-args.txt'), 'utf8').trim().split('\n');
  assert.deepEqual(resumeArgs.slice(0, 3), ['resume', '-C', path.resolve(workspace)]);
  assert.equal(resumeArgs.at(-1), '--last');
  assert.equal(hub.database.getAgent(bootstrap.agent.id).state, 'ready');
});

test('quiet browser uploads and large agent file handoffs stream across nodes without SSH', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-file-relay-'));
  const sourceWorkspace = path.join(directory, 'source');
  const targetWorkspace = path.join(directory, 'target');
  fs.mkdirSync(sourceWorkspace);
  fs.mkdirSync(path.join(targetWorkspace, 'datasets'), { recursive: true });
  const sourceIdentity = generateNodeIdentity();
  const targetIdentity = generateNodeIdentity();
  const hub = new Hub({ stateDir: path.join(directory, 'hub'), listenPort: 0 });
  const bootstrap = hub.bootstrapLocal({
    nodeId: 'nod_file_source', publicKey: sourceIdentity.publicKey,
    workspace: sourceWorkspace, rootId: 'awr_file_source',
    agentProfile: { id: 'apf_file_relay', name: 'File relay test', adapterKind: 'pty', executable: '/bin/cat', arguments: [] },
  });
  hub.database.createNode({ id: 'nod_file_target', displayName: 'Target workstation', publicKey: targetIdentity.publicKey });
  const targetProject = hub.database.createProject({ name: 'Target project' });
  const sourceWorker = hub.database.createAgent({
    id: 'agt_file_source', profileId: bootstrap.profile.id, projectId: bootstrap.project.id,
    nodeId: 'nod_file_source', title: 'Source Sub-Spider', orchestrationRole: 'worker',
    root: { id: 'awr_file_source_agent', node_root_id: 'awr_file_source', logical_name: 'workspace', access_mode: 'read_write' },
  });
  const targetWorker = hub.database.createAgent({
    id: 'agt_file_target', profileId: bootstrap.profile.id, projectId: targetProject.id,
    nodeId: 'nod_file_target', title: 'Target Sub-Spider', orchestrationRole: 'worker',
    root: { id: 'awr_file_target_agent', node_root_id: 'awr_file_target', logical_name: 'workspace', access_mode: 'read_write' },
  });
  const listening = await hub.listen();
  const sourceNode = new NodeDaemon({
    stateDir: path.join(directory, 'source-node'), hubURL: listening.url,
    nodeId: 'nod_file_source', displayName: 'Source workstation',
    publicKey: sourceIdentity.publicKey, privateKey: sourceIdentity.privateKey,
    roots: [{ id: 'awr_file_source', path: sourceWorkspace, symlink_policy: 'no_symlinks' }], reconnect: false,
  });
  const targetNode = new NodeDaemon({
    stateDir: path.join(directory, 'target-node'), hubURL: listening.url,
    nodeId: 'nod_file_target', displayName: 'Target workstation',
    publicKey: targetIdentity.publicKey, privateKey: targetIdentity.privateKey,
    roots: [{ id: 'awr_file_target', path: targetWorkspace, symlink_policy: 'no_symlinks' }], reconnect: false,
  });
  sourceNode.on('error', () => {});
  targetNode.on('error', () => {});
  const sourceOnline = onceWithTimeout(sourceNode, 'online');
  const targetOnline = onceWithTimeout(targetNode, 'online');
  sourceNode.start();
  targetNode.start();
  await Promise.all([sourceOnline, targetOnline]);
  t.after(async () => {
    for (const node of [sourceNode, targetNode]) {
      for (const runtime of node.database.listProcesses()) {
        if (runtime.state === 'running') node.supervisor.stopProcess(runtime.id, 'SIGTERM');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    await sourceNode.stop();
    await targetNode.stop();
    await hub.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const quietBytes = Buffer.from('quiet browser data\n'.repeat(470_000));
  const messagesBeforeUpload = hub.database.listMessages(targetWorker.active_thread_id).length;
  const begun = await jsonFetch(`${listening.url}/api/v1/roots/awr_file_target_agent/file-transfers`, listening.ownerToken, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transfer_id: 'xfr_browserquietABC1234', destination_path: 'datasets/browser-data.bin',
      size_bytes: quietBytes.length, conflict: 'rename',
    }),
  });
  assert.equal(begun.response.status, 200, JSON.stringify(begun.body));
  let quietOffset = 0;
  while (quietOffset < quietBytes.length) {
    const chunk = quietBytes.subarray(quietOffset, Math.min(quietOffset + FILE_TRANSFER_CHUNK_BYTES, quietBytes.length));
    const written = await jsonFetch(`${listening.url}/api/v1/roots/awr_file_target_agent/file-transfers/xfr_browserquietABC1234/chunks`, listening.ownerToken, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ destination_path: begun.body.destination_path, offset: quietOffset, data_base64: chunk.toString('base64') }),
    });
    assert.equal(written.response.status, 200);
    quietOffset += chunk.length;
  }
  const quietComplete = await jsonFetch(`${listening.url}/api/v1/roots/awr_file_target_agent/file-transfers/xfr_browserquietABC1234:complete`, listening.ownerToken, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ destination_path: begun.body.destination_path }),
  });
  assert.equal(quietComplete.response.status, 200);
  assert.deepEqual(fs.readFileSync(path.join(targetWorkspace, 'datasets', 'browser-data.bin')), quietBytes);
  assert.equal(hub.database.listMessages(targetWorker.active_thread_id).length, messagesBeforeUpload);

  const relayBytes = Buffer.from('cross-machine-binary\0data'.repeat(600_000));
  fs.writeFileSync(path.join(sourceWorkspace, 'relay.bin'), relayBytes);
  hub.database.issueAgentControlToken(sourceWorker.id, 'wsa_file_relay', ['files:transfer']);
  const targets = await jsonFetch(`${listening.url}/api/v1/agent-control/files/targets`, 'wsa_file_relay');
  assert.equal(targets.response.status, 200);
  assert(targets.body.targets.some((target) => target.id === targetWorker.id && target.online));
  assert(!targets.body.targets.some((target) => target.id === sourceWorker.id));
  const relayTransferId = 'xfr_resumableRelayABC1234';
  const relaySource = await sourceNode.rootService.describeTransferSource('awr_file_source', 'relay.bin');
  targetNode.rootService.ensureTransferInbox('awr_file_target');
  const partialDestination = `.webspider/inbox/${relayTransferId}-relay.bin`;
  const partial = await targetNode.rootService.beginFileTransfer('awr_file_target', {
    transferId: relayTransferId, destinationPath: partialDestination,
    sizeBytes: relayBytes.length, conflict: 'error',
    sourceVersion: relaySource.version, sourcePath: 'relay.bin',
  });
  const firstChunk = relayBytes.subarray(0, FILE_TRANSFER_CHUNK_BYTES);
  await targetNode.rootService.writeFileTransferChunk('awr_file_target', {
    transferId: relayTransferId, destinationPath: partial.destination_path, offset: 0,
    bytes: firstChunk, sha256: createHash('sha256').update(firstChunk).digest('hex'),
  });
  const sourceReadOffsets = [];
  const originalReadTransferSourceChunk = sourceNode.rootService.readTransferSourceChunk.bind(sourceNode.rootService);
  sourceNode.rootService.readTransferSourceChunk = async (rootId, request) => {
    sourceReadOffsets.push(request.offset);
    return originalReadTransferSourceChunk(rootId, request);
  };
  const relayed = await jsonFetch(`${listening.url}/api/v1/agent-control/agents/${targetWorker.id}/files`, 'wsa_file_relay', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transfer_id: relayTransferId, source_path: 'relay.bin',
      instruction: 'Use this binary dataset later.', wake_policy: 'queue_only',
    }),
  });
  assert.equal(relayed.response.status, 200);
  assert.equal(relayed.body.transfer.transfer_id, relayTransferId);
  assert.equal(sourceReadOffsets[0], FILE_TRANSFER_CHUNK_BYTES);
  assert.equal(relayed.body.transfer.size_bytes, relayBytes.length);
  assert.equal(relayed.body.transfer.sha256, createHash('sha256').update(relayBytes).digest('hex'));
  assert.deepEqual(fs.readFileSync(path.join(targetWorkspace, relayed.body.transfer.relative_path)), relayBytes);
  assert.match(relayed.body.message.content_parts[0].text, /SSH access between workstations was not used/);
  assert.match(relayed.body.message.content_parts[0].text, /Use this binary dataset later/);
  const relayedRetry = await jsonFetch(`${listening.url}/api/v1/agent-control/agents/${targetWorker.id}/files`, 'wsa_file_relay', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      transfer_id: relayTransferId, source_path: 'relay.bin',
      instruction: 'Use this binary dataset later.', wake_policy: 'queue_only',
    }),
  });
  assert.equal(relayedRetry.response.status, 200);
  assert.equal(relayedRetry.body.transfer.duplicate, true);
  assert.equal(relayedRetry.body.duplicate, true);
  assert.equal(hub.database.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE command_type LIKE 'files.transfer-%'").get().count, 0);
  assert.equal(sourceNode.database.db.prepare("SELECT COUNT(*) AS count FROM commands WHERE type LIKE 'files.transfer-%'").get().count, 0);
  assert.equal(targetNode.database.db.prepare("SELECT COUNT(*) AS count FROM commands WHERE type LIKE 'files.transfer-%'").get().count, 0);
});

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

test('owner project lifecycle endpoints archive, restore, and guard permanent metadata deletion', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-project-lifecycle-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  const sentinel = path.join(workspace, 'user-work.txt');
  fs.writeFileSync(sentinel, 'must survive project-record deletion\n');
  const identity = generateNodeIdentity();
  const hub = new Hub({ stateDir: path.join(directory, 'hub'), listenPort: 0 });
  const bootstrap = hub.bootstrapLocal({ nodeId: 'nod_lifecycle', publicKey: identity.publicKey, workspace });
  const listening = await hub.listen();
  t.after(async () => {
    await hub.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const protectedProject = await jsonFetch(
    `${listening.url}/api/v1/projects/${bootstrap.project.id}:archive`, listening.ownerToken, { method: 'POST' },
  );
  assert.equal(protectedProject.response.status, 409);
  assert.equal(protectedProject.body.error.code, 'WS_PROJECT_PROTECTED');

  const created = await jsonFetch(`${listening.url}/api/v1/projects`, listening.ownerToken, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Disposable project record' }),
  });
  assert.equal(created.response.status, 200);

  const deleteWhileActive = await jsonFetch(`${listening.url}/api/v1/projects/${created.body.id}`, listening.ownerToken, {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmation: created.body.name }),
  });
  assert.equal(deleteWhileActive.response.status, 409);
  assert.equal(deleteWhileActive.body.error.code, 'WS_PROJECT_NOT_ARCHIVED');

  const archived = await jsonFetch(`${listening.url}/api/v1/projects/${created.body.id}:archive`, listening.ownerToken, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(archived.response.status, 200);
  assert(archived.body.archived_at);
  const activeList = await jsonFetch(`${listening.url}/api/v1/projects`, listening.ownerToken);
  const archivedList = await jsonFetch(`${listening.url}/api/v1/projects?archived=only`, listening.ownerToken);
  assert.equal(activeList.body.projects.some((project) => project.id === created.body.id), false);
  assert(archivedList.body.projects.some((project) => project.id === created.body.id));

  const taskWhileArchived = await jsonFetch(`${listening.url}/api/v1/tasks`, listening.ownerToken, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: created.body.id, title: 'Must not start', specification: {} }),
  });
  assert.equal(taskWhileArchived.response.status, 409);
  assert.equal(taskWhileArchived.body.error.code, 'WS_PROJECT_ARCHIVED');

  const wrongConfirmation = await jsonFetch(`${listening.url}/api/v1/projects/${created.body.id}`, listening.ownerToken, {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmation: 'Disposable project' }),
  });
  assert.equal(wrongConfirmation.response.status, 409);
  assert.equal(wrongConfirmation.body.error.code, 'WS_CONFIRMATION_REQUIRED');

  const restored = await jsonFetch(`${listening.url}/api/v1/projects/${created.body.id}:restore`, listening.ownerToken, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.archived_at, null);
  await jsonFetch(`${listening.url}/api/v1/projects/${created.body.id}:archive`, listening.ownerToken, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const deleted = await jsonFetch(`${listening.url}/api/v1/projects/${created.body.id}`, listening.ownerToken, {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmation: created.body.name }),
  });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.deleted, true);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must survive project-record deletion\n');
  const missing = await jsonFetch(`${listening.url}/api/v1/projects/${created.body.id}`, listening.ownerToken);
  assert.equal(missing.response.status, 404);
});

test('hub shutdown closes active browser WebSockets without waiting for the service timeout', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-shutdown-'));
  const hub = new Hub({ stateDir: path.join(directory, 'hub'), listenPort: 0 });
  const listening = await hub.listen();
  let hubClosed = false;
  t.after(async () => {
    if (!hubClosed) await hub.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const socket = net.createConnection(listening.address.port, '127.0.0.1');
  const upgraded = new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('data', (bytes) => resolve(bytes.toString('utf8')));
  });
  socket.write([
    'GET /api/v1/ws/events HTTP/1.1',
    `Host: 127.0.0.1:${listening.address.port}`,
    `Origin: http://127.0.0.1:${listening.address.port}`,
    `Authorization: Bearer ${listening.ownerToken}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: d2Vic3BpZGVyLXRlc3Q=',
    '',
    '',
  ].join('\r\n'));
  assert.match(await upgraded, /101 Switching Protocols/);

  await Promise.race([
    hub.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Hub shutdown timed out with an active browser socket')), 1_000)),
  ]);
  hubClosed = true;
  assert.equal(socket.destroyed, true);
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

test('the owner can adopt a remote Codex session and WebSpider pins it to the registered workspace', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-adopt-session-api-'));
  const workspace = path.join(directory, 'workspace');
  const userCodexHome = path.join(directory, 'user-codex-home');
  const sessionDirectory = path.join(userCodexHome, 'sessions', '2026', '08', '25');
  fs.mkdirSync(workspace);
  const canonicalWorkspace = fs.realpathSync(workspace);
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.writeFileSync(path.join(sessionDirectory, 'existing.jsonl'), '{}\n');
  const fakeCodex = path.join(directory, 'codex');
  fs.writeFileSync(fakeCodex, '#!/bin/sh\nprintf "%s\\n" "$@" > api-adopted-args.txt\n');
  fs.chmodSync(fakeCodex, 0o700);
  const priorCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = userCodexHome;
  const identity = generateNodeIdentity();
  const hub = new Hub({ stateDir: path.join(directory, 'hub'), listenPort: 0 });
  const bootstrap = hub.bootstrapLocal({
    nodeId: 'nod_adopt_session', publicKey: identity.publicKey, workspace, rootId: 'awr_adopt_session',
    agentProfile: { id: 'apf_adopt_session', name: 'Codex test', adapterKind: 'pty', executable: fakeCodex, arguments: [] },
  });
  const listening = await hub.listen();
  const node = new NodeDaemon({
    stateDir: path.join(directory, 'node'), hubURL: listening.url,
    nodeId: 'nod_adopt_session', displayName: 'Adopt session node',
    publicKey: identity.publicKey, privateKey: identity.privateKey,
    roots: [{ id: 'awr_adopt_session', path: workspace }], reconnect: false,
  });
  node.on('error', () => {});
  const online = onceWithTimeout(node, 'online');
  node.start();
  await online;
  t.after(async () => {
    const runtime = node.database.getProcessByAgent(bootstrap.agent.id);
    if (runtime?.state === 'running') node.supervisor.stopProcess(runtime.id, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 80));
    await node.stop(); await hub.close();
    if (priorCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const adopted = await jsonFetch(`${listening.url}/api/v1/agent-instances/${bootstrap.agent.id}:resume-codex`, listening.ownerToken, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ use_last: true }),
  });
  assert.equal(adopted.response.status, 200);
  assert.deepEqual(adopted.body.codex_session, { source: 'user', selector: 'last', session_id: null });
  await waitUntil(() => fs.existsSync(path.join(workspace, 'api-adopted-args.txt')));
  assert.deepEqual(fs.readFileSync(path.join(workspace, 'api-adopted-args.txt'), 'utf8').trim().split('\n'), [
    'resume', '-C', canonicalWorkspace, '--ask-for-approval', 'never', '--sandbox', 'danger-full-access', '--last',
  ]);
  const runtime = node.database.getProcessByAgent(bootstrap.agent.id);
  assert.deepEqual(runtime.argv.slice(0, 4), [fakeCodex, 'resume', '-C', canonicalWorkspace]);
});

test('a main agent can queue delayed command work while its target node is offline', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-offline-task-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  const identity = generateNodeIdentity();
  const hub = new Hub({ stateDir: path.join(directory, 'hub'), listenPort: 0 });
  const bootstrap = hub.bootstrapLocal({
    nodeId: 'nod_offline_task', publicKey: identity.publicKey,
    workspace, rootId: 'awr_offline_task',
  });
  const listening = await hub.listen();
  let node;
  t.after(async () => {
    if (node) await node.stop();
    await hub.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  hub.database.issueAgentControlToken(bootstrap.agent.id, 'wsa_offline_task', ['tasks:read', 'tasks:write']);
  const marker = path.join(workspace, 'delayed-command.txt');
  const queued = await jsonFetch(`${listening.url}/api/v1/agent-control/tasks`, 'wsa_offline_task', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent_id: bootstrap.agent.id,
      title: 'Offline delayed command proof',
      delay_seconds: 1,
      notify_master: false,
      argv: [process.execPath, '-e', "require('node:fs').writeFileSync('delayed-command.txt', 'offline task completed\\n')"],
    }),
  });
  assert.equal(queued.response.status, 200);
  await waitUntil(() => hub.database.getTask(queued.body.id).state === 'runnable');
  assert.equal(fs.existsSync(marker), false);

  const listed = await jsonFetch(`${listening.url}/api/v1/agent-control/tasks`, 'wsa_offline_task');
  assert.equal(listed.response.status, 200);
  assert(listed.body.tasks.some((task) => task.id === queued.body.id));

  node = new NodeDaemon({
    stateDir: path.join(directory, 'node'), hubURL: listening.url,
    nodeId: 'nod_offline_task', displayName: 'Offline task node',
    publicKey: identity.publicKey, privateKey: identity.privateKey,
    roots: [{ id: 'awr_offline_task', path: workspace, symlink_policy: 'no_symlinks' }],
    reconnect: false,
  });
  node.on('error', () => {});
  const online = onceWithTimeout(node, 'online');
  node.start();
  await online;

  await waitUntil(() => hub.database.getTask(queued.body.id).state === 'succeeded', 10_000);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'offline task completed\n');
  assert.equal(hub.database.getTask(queued.body.id).specification.delay_seconds, 1);
});

test('worker hooks are self-confined, restart-durable, and can notify self or master', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-worker-hooks-'));
  const workspace = path.join(directory, 'workspace');
  const hubState = path.join(directory, 'hub');
  fs.mkdirSync(workspace);
  const identity = generateNodeIdentity();
  let hub = new Hub({ stateDir: hubState, listenPort: 0 });
  const bootstrap = hub.bootstrapLocal({
    nodeId: 'nod_worker_hooks', publicKey: identity.publicKey,
    workspace, rootId: 'awr_master_hooks',
  });
  const worker = hub.database.createAgent({
    id: 'agt_worker_hooks',
    profileId: bootstrap.agent.profile_id,
    projectId: bootstrap.project.id,
    nodeId: bootstrap.agent.node_id,
    title: 'Hook worker',
    orchestrationRole: 'worker',
    root: {
      id: 'awr_worker_hooks',
      node_root_id: 'awr_worker_hooks',
      logical_name: 'workspace',
      access_mode: 'read_write',
    },
  });
  const token = 'wsa_worker_hooks';
  hub.database.issueAgentControlToken(worker.id, token, [
    'tasks:read', 'tasks:write', 'reminders:read:self', 'reminders:write:self',
  ]);
  let listening = await hub.listen();
  t.after(async () => {
    await hub.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const forbiddenTask = await jsonFetch(`${listening.url}/api/v1/agent-control/tasks`, token, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent_id: bootstrap.agent.id,
      argv: [process.execPath, '-e', 'process.exit(0)'],
    }),
  });
  assert.equal(forbiddenTask.response.status, 403);
  const selfTask = await jsonFetch(`${listening.url}/api/v1/agent-control/tasks`, token, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      argv: [process.execPath, '-e', 'process.exit(0)'],
      completion_message: 'Worker-local completion hook',
    }),
  });
  assert.equal(selfTask.response.status, 200);
  assert.equal(selfTask.body.specification.notify_target, 'self');
  await waitUntil(() => hub.database.getTask(selfTask.body.id).state === 'runnable');
  const workerTaskList = await jsonFetch(`${listening.url}/api/v1/agent-control/tasks`, token);
  assert.deepEqual(workerTaskList.body.tasks.map((task) => task.id), [selfTask.body.id]);

  hub.database.issueAgentControlToken(bootstrap.agent.id, 'wsa_master_hooks', ['tasks:write']);
  const delegatedTask = await jsonFetch(`${listening.url}/api/v1/agent-control/tasks`, 'wsa_master_hooks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent_id: worker.id,
      argv: [process.execPath, '-e', 'process.exit(0)'],
    }),
  });
  assert.equal(delegatedTask.response.status, 200);
  assert.equal(delegatedTask.body.specification.notify_target, 'master');

  const toMaster = await jsonFetch(`${listening.url}/api/v1/agent-control/reminders`, token, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Restart durable master hook',
      message: 'Worker reminder reached the Master.',
      delay_seconds: 1,
      delivery_target: 'master',
    }),
  });
  assert.equal(toMaster.response.status, 200);
  await hub.close();
  hub = new Hub({ stateDir: hubState, listenPort: 0 });
  listening = await hub.listen();
  await waitUntil(() => hub.database.getTask(toMaster.body.id).state === 'succeeded', 5_000);
  const masterMessage = hub.database.listMessages(bootstrap.agent.active_thread_id)
    .find((message) => message.content_parts[0].text.includes('Worker reminder reached the Master.'));
  assert(masterMessage);
  assert.equal(masterMessage.delivery_role, 'user');
  assert.match(masterMessage.content_parts[0].text, new RegExp(`Reminder ID: ${toMaster.body.id}`));

  const recurringSelf = await jsonFetch(`${listening.url}/api/v1/agent-control/reminders`, token, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Two worker self hooks',
      message: 'Worker future-self check.',
      every_seconds: 1,
      max_runs: 2,
      delivery_target: 'self',
    }),
  });
  assert.equal(recurringSelf.response.status, 200);
  await waitUntil(() => hub.database.getTask(recurringSelf.body.id).state === 'succeeded', 5_000);
  const workerMessages = hub.database.listMessages(worker.active_thread_id)
    .filter((message) => message.content_parts[0].text.includes('Worker future-self check.'));
  assert.equal(workerMessages.length, 2);
  assert(workerMessages.every((message) => message.delivery_role === 'user'));
  assert.equal(hub.database.getTask(recurringSelf.body.id).specification.run_count, 2);

  const cancellable = await jsonFetch(`${listening.url}/api/v1/agent-control/reminders`, token, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Do not deliver.', delay_seconds: 30 }),
  });
  const listed = await jsonFetch(`${listening.url}/api/v1/agent-control/reminders`, token);
  assert(listed.body.reminders.some((reminder) => reminder.id === cancellable.body.id));
  const cancelled = await jsonFetch(`${listening.url}/api/v1/agent-control/reminders/${cancellable.body.id}:cancel`, token, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.state, 'cancelled');
});

test('hub and outbound node provide a root-confined end-to-end API', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-e2e-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'report.txt'), 'durable result\n');
  fs.writeFileSync(path.join(workspace, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>');
  fs.writeFileSync(path.join(workspace, 'paper.pdf'), Buffer.from('%PDF-1.4\n%%EOF\n'));
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
    for (const agentId of [bootstrap.agent.id, 'agt_e2e_worker']) {
      const runtime = node.database.getProcessByAgent(agentId);
      if (runtime?.state === 'running') node.supervisor.stopProcess(runtime.id, 'SIGTERM');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    await node.stop();
    await hub.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const list = await jsonFetch(`${listening.url}/api/v1/roots/awr_e2e/entries`, listening.ownerToken);
  assert.equal(list.response.status, 200);
  assert(list.body.entries.some((entry) => entry.name === 'report.txt'));

  const svgPreview = await fetch(`${listening.url}/api/v1/roots/awr_e2e/media-preview?path=diagram.svg`, {
    headers: { authorization: `Bearer ${listening.ownerToken}` },
  });
  assert.equal(svgPreview.status, 200);
  assert.equal(svgPreview.headers.get('content-type'), 'image/svg+xml');
  assert.match(svgPreview.headers.get('content-disposition'), /^inline/);
  assert.match(svgPreview.headers.get('content-security-policy'), /sandbox/);
  assert.match(svgPreview.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.match(await svgPreview.text(), /<svg/);
  const pdfPreview = await fetch(`${listening.url}/api/v1/roots/awr_e2e/media-preview?path=paper.pdf`, {
    headers: { authorization: `Bearer ${listening.ownerToken}` },
  });
  assert.equal(pdfPreview.status, 200);
  assert.equal(pdfPreview.headers.get('content-type'), 'application/pdf');
  assert.match(Buffer.from(await pdfPreview.arrayBuffer()).toString('utf8'), /^%PDF/);

  const unauthenticated = await fetch(`${listening.url}/api/v1/projects`);
  assert.equal(unauthenticated.status, 401);
  assert.equal(bootstrap.agent.orchestration_role, 'main');

  const pastedPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const imageUpload = await jsonFetch(`${listening.url}/api/v1/agent-instances/${bootstrap.agent.id}/uploads`, listening.ownerToken, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      upload_id: 'upl_e2eclipboard123456', terminal_id: bootstrap.agent.terminal_id,
      filename: 'clipboard.png', mime_type: 'image/png', data_base64: pastedPng.toString('base64'),
    }),
  });
  assert.equal(imageUpload.response.status, 200);
  assert.equal(imageUpload.body.upload.relative_path, '.webspider/uploads/upl_e2eclipboard123456.png');
  assert.deepEqual(fs.readFileSync(path.join(workspace, imageUpload.body.upload.relative_path)), pastedPng);
  assert.match(imageUpload.body.message.content_parts[0].text, /Inspect the local image/);
  assert.match(imageUpload.body.message.content_parts[0].text, /\.webspider\/uploads\/upl_e2eclipboard123456\.png/);

  const attachedPdf = Buffer.from('%PDF-1.4\nBrowser attachment\n%%EOF\n');
  const fileUpload = await jsonFetch(`${listening.url}/api/v1/agent-instances/${bootstrap.agent.id}/file-uploads`, listening.ownerToken, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      upload_id: 'upl_e2efileattach123456', terminal_id: bootstrap.agent.terminal_id,
      filename: 'analysis draft.pdf', mime_type: 'application/pdf', data_base64: attachedPdf.toString('base64'),
    }),
  });
  assert.equal(fileUpload.response.status, 200);
  assert.equal(fileUpload.body.upload.relative_path, '.webspider/uploads/upl_e2efileattach123456-analysis draft.pdf');
  assert.deepEqual(fs.readFileSync(path.join(workspace, fileUpload.body.upload.relative_path)), attachedPdf);
  assert.equal(fs.statSync(path.join(workspace, fileUpload.body.upload.relative_path)).mode & 0o777, 0o600);
  assert.match(fileUpload.body.message.content_parts[0].text, /Inspect the local file/);
  assert.match(fileUpload.body.message.content_parts[0].text, /analysis draft\.pdf/);

  const policy = await jsonFetch(`${listening.url}/api/v1/projects/${bootstrap.project.id}/policy`, listening.ownerToken);
  assert.equal(policy.response.status, 200);
  assert.equal(policy.body.policy.principle, 'minimize_user_burden');
  assert.match(policy.body.rendered_instructions, /on-demand multi-project Master Spider/);
  assert.match(policy.body.rendered_worker_instructions, /instructions arrive directly, are authoritative, and bypass the Master/);
  const policyUpdate = await jsonFetch(`${listening.url}/api/v1/projects/${bootstrap.project.id}/policy`, listening.ownerToken, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ policy: { execution: { use_project_conventions: false } } }),
  });
  assert.equal(policyUpdate.response.status, 200);
  assert.equal(policyUpdate.body.revision, 2);
  assert.equal(policyUpdate.body.policy.execution.validate_before_claiming_completion, true);

  const instructionsUpdate = await jsonFetch(`${listening.url}/api/v1/agent-instances/${bootstrap.agent.id}/instructions`, listening.ownerToken, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instructions: 'Keep portfolio summaries compact.', expected_revision: 1 }),
  });
  assert.equal(instructionsUpdate.response.status, 200);
  assert.equal(instructionsUpdate.body.instruction_revision, 2);
  const instructionPolicy = await jsonFetch(`${listening.url}/api/v1/agent-instances/${bootstrap.agent.id}/policy`, listening.ownerToken);
  assert.equal(instructionPolicy.body.custom_instructions, 'Keep portfolio summaries compact.');
  assert.equal(instructionPolicy.body.instruction_revision, 2);
  assert.match(instructionPolicy.body.preview, /## Custom instructions[\s\S]*Keep portfolio summaries compact\./);
  assert.equal(instructionPolicy.body.stale, true);

  hub.database.issueAgentControlToken(bootstrap.agent.id, 'wsa_e2e_control', [
    'policy:read', 'policy:write:project', 'policy:write:system', 'usage:read', 'usage:write', 'agents:read', 'messages:write', 'documents:write',
  ]);
  const worker = hub.database.createAgent({
    id: 'agt_e2e_worker',
    profileId: bootstrap.agent.profile_id,
    projectId: bootstrap.project.id,
    nodeId: bootstrap.agent.node_id,
    title: 'Remote worker',
    orchestrationRole: 'worker',
    root: {
      id: 'awr_e2e_worker', node_root_id: 'awr_e2e', logical_name: 'workspace', access_mode: 'read_write',
    },
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
  const documentBytes = Buffer.from('# Remote runbook\nValidate the durable document handoff.\n');
  const document = await jsonFetch(`${listening.url}/api/v1/agent-control/agents/${worker.id}/documents`, 'wsa_e2e_control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: 'remote-runbook.md',
      data_base64: documentBytes.toString('base64'),
      instruction: 'Read the inbox copy and validate it.',
    }),
  });
  assert.equal(document.response.status, 200);
  assert.equal(document.body.message.delivery_role, 'user');
  assert.equal(document.body.message.content_parts[1].type, 'document');
  await waitUntil(() => fs.existsSync(path.join(workspace, document.body.document.relative_path)));
  await waitUntil(() => hub.database.getMessage(document.body.message.id).delivery.state === 'adapter_accepted');
  assert.equal(fs.readFileSync(path.join(workspace, document.body.document.relative_path), 'utf8'), documentBytes.toString('utf8'));
  assert.match(document.body.message.content_parts[0].text, new RegExp(`Document ID: ${document.body.document.id}`));
  hub.database.issueAgentControlToken(worker.id, 'wsa_e2e_worker_documents', ['documents:write']);
  const forbiddenPeerDocument = await jsonFetch(`${listening.url}/api/v1/agent-control/agents/${worker.id}/documents`, 'wsa_e2e_worker_documents', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'peer.txt', data_base64: Buffer.from('peer').toString('base64') }),
  });
  assert.equal(forbiddenPeerDocument.response.status, 403);
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
  assert.equal(markdownModule.headers.get('cache-control'), 'no-cache');
  assert.match(await markdownModule.text(), /renderMarkdown/);
  const randomModule = await fetch(`${listening.url}/random.js`);
  assert.equal(randomModule.status, 200);
  assert.match(randomModule.headers.get('content-type'), /javascript/);
  assert.doesNotMatch(await randomModule.text(), /randomUUID/);
  const terminalModule = await fetch(`${listening.url}/vendor/xterm.mjs`);
  assert.equal(terminalModule.status, 200);
  assert.match(terminalModule.headers.get('content-type'), /javascript/);
  assert.equal(terminalModule.headers.get('cache-control'), 'public, max-age=3600');
  assert.match(await terminalModule.text(), /export\{.*Terminal/);
  const mathJaxModule = await fetch(`${listening.url}/vendor/mathjax.js`);
  assert.equal(mathJaxModule.status, 200);
  assert.match(mathJaxModule.headers.get('content-type'), /javascript/);
  assert.equal(mathJaxModule.headers.get('cache-control'), 'public, max-age=3600');
  const mathJaxFont = await fetch(`${listening.url}/vendor/mathjax-fonts/woff-v2/MathJax_Main-Regular.woff`);
  assert.equal(mathJaxFont.status, 200);
  assert.match(mathJaxFont.headers.get('content-type'), /font\/woff/);
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
  assert.match(fs.readFileSync(path.join(remoteWorkspace, '.webspider', 'WEBSPIDER_USER_GUIDE.txt'), 'utf8'),
    /Direct project mode/);

  hub.database.issueAgentControlToken(bootstrap.agent.id, 'wsa_portfolio_master', ['portfolio:read', 'agents:read', 'messages:write']);
  const portfolio = await jsonFetch(`${listening.url}/api/v1/agent-control/portfolio`, 'wsa_portfolio_master');
  assert.equal(portfolio.response.status, 200);
  assert(portfolio.body.projects.some((project) => project.id === onboard.body.project.id));
  const delegated = await jsonFetch(`${listening.url}/api/v1/agent-control/agents/${worker.id}/messages`, 'wsa_portfolio_master', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Run the remote analysis and report progress.', wake_policy: 'ensure_running' }),
  });
  assert.equal(delegated.response.status, 200);
  await waitUntil(() => node.supervisor.snapshot(worker.terminal_id).text.includes('Run the remote analysis'), 10_000);

  hub.database.issueAgentControlToken(worker.id, 'wsa_worker_report', ['status:write:self']);
  const report = await jsonFetch(`${listening.url}/api/v1/agent-control/report`, 'wsa_worker_report', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'working', summary: 'Analysis is running on the GPU.' }),
  });
  assert.equal(report.response.status, 200);
  assert.equal(hub.database.getAgent(worker.id).work_status, 'working');
  assert.equal(report.body.notification, null);
  assert(!hub.database.listMessages(bootstrap.agent.active_thread_id)
    .some((message) => message.content_parts[0].text.includes('Analysis is running on the GPU.')));

  const escalatedReport = await jsonFetch(`${listening.url}/api/v1/agent-control/report`, 'wsa_worker_report', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      status: 'blocked', summary: 'GPU allocation needs a Master decision.', notify_master: true,
    }),
  });
  assert.equal(escalatedReport.response.status, 200);
  assert(escalatedReport.body.notification?.message);
  assert(hub.database.listMessages(bootstrap.agent.active_thread_id)
    .some((message) => message.content_parts[0].text.includes('GPU allocation needs a Master decision.')));

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
  await waitUntil(() => !['running', 'stopping'].includes(node.database.getProcess(exitedRuntime.id).state), 5_000);
  assert.equal(hub.database.getAgent(worker.id).state, 'ready');
  assert.equal(hub.database.getAgent(worker.id).terminal_state, 'attached');

  const closedShell = await jsonFetch(`${listening.url}/api/v1/terminals/${shellTab.body.id}`, listening.ownerToken, {
    method: 'DELETE',
  });
  assert.equal(closedShell.response.status, 200);
  assert.equal(closedShell.body.deleted, true);
  assert.equal(hub.database.getTerminal(shellTab.body.id), null);
  await waitUntil(() => node.database.getProcessByTerminal(shellTab.body.id)?.state !== 'running', 5_000);

  const taskTerminal = hub.database.createTaskTerminal(worker.id, 'Detached benchmark');
  hub.database.setTerminalState(taskTerminal.id, 'attached');
  const dismissedTaskTerminal = await jsonFetch(`${listening.url}/api/v1/terminals/${taskTerminal.id}`, listening.ownerToken, {
    method: 'DELETE',
  });
  assert.equal(dismissedTaskTerminal.response.status, 200);
  assert.equal(dismissedTaskTerminal.body.deleted, true);
  assert.equal(dismissedTaskTerminal.body.process_stopped, false);
  assert.equal(dismissedTaskTerminal.body.task_continues, true);
  assert.equal(hub.database.getTerminal(taskTerminal.id), null);

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
