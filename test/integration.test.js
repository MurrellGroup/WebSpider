import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub } from '../src/hub/hub.js';
import { formatInboundMessage, NodeDaemon } from '../src/node/node-daemon.js';
import { generateNodeIdentity } from '../src/lib/security.js';

function onceWithTimeout(emitter, event, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    emitter.once(event, (value) => { clearTimeout(timer); resolve(value); });
  });
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
    'policy:read', 'policy:write:project', 'policy:write:system', 'usage:read', 'usage:write',
  ]);
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
  assert.match(portal.headers.get('content-security-policy'), /object-src 'none'/);
  assert.match(await portal.text(), /WebSpider/);
  const markdownModule = await fetch(`${listening.url}/markdown.js`);
  assert.equal(markdownModule.status, 200);
  assert.match(markdownModule.headers.get('content-type'), /javascript/);
  assert.match(await markdownModule.text(), /renderMarkdown/);

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
