import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { HubDatabase } from '../db/hub-database.js';
import { NodeBroker } from './node-broker.js';
import { Router } from '../lib/router.js';
import { acceptWebSocket, rejectWebSocket } from '../transport/websocket.js';
import { WebSpiderError, invariant } from '../lib/errors.js';
import { contentDisposition, parsePositiveInt, readJSON, sendError, sendJSON } from '../lib/http.js';
import { ensurePrivateFile, isSafeOrigin, parseCookies, secureEqual, sessionSecret, sha256 } from '../lib/security.js';
import { makeId, nowISO, randomToken } from '../lib/ids.js';
import { renderProjectInstructions, summarizeProjectPolicy } from '../lib/project-policy.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_DIR = path.resolve(MODULE_DIR, '../../web');
const MAIN_AGENT_CONTROL_SCOPES = [
  'policy:read',
  'policy:write:project',
  'policy:write:system',
  'usage:read',
  'usage:write',
];

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.pdf', 'application/pdf'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
]);

function fileMime(filename) {
  return MIME.get(path.extname(filename).toLowerCase()) || 'application/octet-stream';
}

function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path || '/'}`, `SameSite=${options.sameSite || 'Strict'}`];
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.maxAge != null) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  return parts.join('; ');
}

function accountQuotaContext(status) {
  if (!status?.snapshot || !status.weekly) return { available: false };
  return {
    available: true,
    remaining_percent: status.weekly.remaining_percent,
    used_percent: status.weekly.used_percent,
    resets_at: status.weekly.resets_at,
    observed_at: status.snapshot.observed_at,
    source: status.snapshot.source,
    age_ms: status.age_ms,
    stale: status.stale,
  };
}

export class Hub {
  constructor({
    stateDir,
    listenHost = '127.0.0.1',
    listenPort = 7340,
    publicBaseURL = null,
    allowedOrigins = [],
    webDir = DEFAULT_WEB_DIR,
    ownerToken = null,
  }) {
    this.stateDir = stateDir;
    this.listenHost = listenHost;
    this.listenPort = listenPort;
    this.publicBaseURL = publicBaseURL;
    this.allowedOrigins = allowedOrigins;
    this.webDir = webDir;
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(stateDir, 'artifacts'), { recursive: true, mode: 0o700 });
    this.ownerTokenPath = path.join(stateDir, 'owner.token');
    ensurePrivateFile(this.ownerTokenPath, ownerToken || randomToken('wso'));
    this.ownerToken = fs.readFileSync(this.ownerTokenPath, 'utf8').trim();
    this.database = new HubDatabase(path.join(stateDir, 'webspider.db'));
    this.broker = new NodeBroker(this.database);
    this.router = new Router();
    this.server = http.createServer((request, response) => this.#handleRequest(request, response));
    this.server.on('upgrade', (request, socket, head) => this.#handleUpgrade(request, socket, head));
    this.#registerRoutes();
    this.broker.on('node.event', (envelope) => this.#handleNodeEvent(envelope).catch((error) => this.#logError(error)));
    this.broker.on('error', (error) => this.#logError(error));
    this.database.on('event', (event) => {
      if (event.type === 'node.online.v1') {
        this.#reconcileNode(event.scope_id, event.payload?.runtime_inventory || [], event.payload?.connection_epoch)
          .then(() => this.#drainDeliveries(event.scope_id))
          .catch((error) => this.#logError(error));
      }
    });
  }

  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.listenPort, this.listenHost, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    const host = this.listenHost.includes(':') ? `[${this.listenHost}]` : this.listenHost;
    this.url = this.publicBaseURL || `http://${host}:${address.port}`;
    return { url: this.url, ownerToken: this.ownerToken, address };
  }

  async close() {
    for (const state of this.broker.connections.values()) state.connection.close(1001, 'Hub stopping');
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.database.close();
  }

  bootstrapLocal({ nodeId, publicKey, workspace, rootId = 'awr_workspace', projectContext = null, agentProfile = null }) {
    this.database.ensureNode({
      id: nodeId,
      displayName: 'Local workstation',
      publicKey,
      labels: { location: 'local' },
      capabilities: {},
    });
    let project = this.database.getProject('prj_local');
    const context = projectContext || {
      name: path.basename(workspace) || 'Research project',
      kind: 'academic',
      inference: 'academic-first-default',
      signals: [],
    };
    if (!project) project = this.database.createProject({
      id: 'prj_local',
      name: context.name,
      description: '',
      labels: {
        project_kind: context.kind || 'academic',
        context_inference: context.inference || 'academic-first-default',
        inference_confidence: context.confidence || 'default',
        inference_signals: context.signals || [],
      },
    }, 'system:bootstrap');
    const selectedProfile = agentProfile || {
      id: 'apf_shell',
      name: 'Master Shell',
      adapterKind: 'pty',
      executable: '/bin/bash',
      arguments: ['--noprofile', '--norc', '-i'],
    };
    let profile = this.database.getProfile(selectedProfile.id);
    if (!profile) profile = this.database.createProfile({
      ...selectedProfile,
      restartPolicy: { mode: 'on_failure', max_attempts: 3 },
    }, 'system:bootstrap');
    let agent = this.database.getAgent('agt_master');
    if (!agent) agent = this.database.createAgent({
      id: 'agt_master',
      profileId: profile.id,
      projectId: project.id,
      nodeId,
      title: 'Master Spider',
      orchestrationRole: 'main',
      resumability: 'detached_process',
      root: {
        id: rootId,
        logical_name: 'workspace',
        access_mode: 'read_write',
        symlink_policy: 'no_symlinks',
        mount_policy: 'allow_nested',
      },
    }, 'system:bootstrap');
    if (agent.orchestration_role !== 'main') agent = this.database.setAgentRole(agent.id, 'main');
    return { project, profile, agent, root_id: rootId };
  }

  #registerRoutes() {
    const route = (method, pattern, handler, options) => this.router.add(method, pattern, handler, options);

    route('GET', '/healthz', async () => ({ status: 'ok', version: '0.4.7', time: nowISO() }), { auth: false, csrf: false });
    route('POST', '/api/v1/auth/login', async (ctx) => {
      const body = await readJSON(ctx.request, 16_384);
      invariant(typeof body.token === 'string' && secureEqual(body.token, this.ownerToken), 'WS_AUTH_REQUIRED', 'Owner token is invalid.', 401);
      const secret = sessionSecret();
      const csrf = sessionSecret();
      const session = this.database.createSession(secret, csrf);
      const secure = this.publicBaseURL?.startsWith('https://') || ctx.request.socket.encrypted;
      ctx.response.setHeader('set-cookie', [
        cookie('ws_session', secret, { httpOnly: true, secure, maxAge: 43_200 }),
        cookie('ws_csrf', csrf, { secure, maxAge: 43_200 }),
      ]);
      this.database.audit({ actorId: session.principal_id, action: 'auth.login', targetType: 'session', targetId: session.id });
      return { principal_id: session.principal_id, role: session.role, expires_at: session.expires_at };
    }, { auth: false, csrf: false });

    route('POST', '/api/v1/auth/logout', async (ctx) => {
      this.database.revokeSession(ctx.principal.id);
      ctx.response.setHeader('set-cookie', [cookie('ws_session', '', { httpOnly: true, maxAge: 0 }), cookie('ws_csrf', '', { maxAge: 0 })]);
      return { logged_out: true };
    });

    route('GET', '/api/v1/session', async (ctx) => ({
      principal_id: ctx.principal.principal_id,
      role: ctx.principal.role,
      expires_at: ctx.principal.expires_at,
    }));

    route('GET', '/api/v1/summary', async () => this.database.countSummary());
    route('GET', '/api/v1/account-usage', async () => this.database.accountUsageStatus());
    route('GET', '/api/v1/system/policy', async () => this.database.getSystemPolicy());
    route('PATCH', '/api/v1/system/policy', async (ctx) => {
      const body = await readJSON(ctx.request);
      const previous = this.database.getSystemPolicy();
      const policy = this.database.updateSystemPolicy(body.patch || body.policy || body, {
        actor: ctx.principal.principal_id,
        expectedRevision: body.expected_revision,
        reason: body.reason || 'Owner updated system defaults.',
      });
      this.database.audit({
        actorId: ctx.principal.principal_id,
        action: 'system.policy.update',
        targetType: 'system_policy',
        targetId: policy.id,
        previousState: { revision: previous.revision },
        newState: { revision: policy.revision, reason: body.reason || null },
      });
      return policy;
    });
    route('GET', '/api/v1/projects', async () => ({ projects: this.database.listProjects() }));
    route('POST', '/api/v1/projects', async (ctx) => {
      const body = await readJSON(ctx.request);
      const project = this.database.createProject(body, ctx.principal.principal_id);
      this.database.audit({ actorId: ctx.principal.principal_id, action: 'project.create', targetType: 'project', targetId: project.id, projectId: project.id, newState: project });
      return project;
    });
    route('GET', '/api/v1/projects/:id', async (ctx) => {
      const project = this.database.getProject(ctx.params.id);
      invariant(project, 'WS_NOT_FOUND', 'Project not found.', 404);
      return project;
    });
    route('GET', '/api/v1/projects/:id/policy', async (ctx) => {
      const project = this.database.getProject(ctx.params.id);
      invariant(project, 'WS_NOT_FOUND', 'Project not found.', 404);
      return {
        project_id: project.id,
        revision: project.policy_revision,
        system_revision: project.system_policy_revision,
        policy: project.policy,
        overrides: project.policy_overrides,
        summary: summarizeProjectPolicy(project.policy),
        rendered_instructions: renderProjectInstructions(project, { role: 'main' }),
      };
    });
    route('PATCH', '/api/v1/projects/:id/policy', async (ctx) => {
      const body = await readJSON(ctx.request);
      const project = this.database.updateProjectPolicy(
        ctx.params.id,
        body.patch || body.policy || body,
        ctx.principal.principal_id,
        { expectedRevision: body.expected_revision, reason: body.reason || 'Owner updated project defaults.' },
      );
      this.database.audit({
        actorId: ctx.principal.principal_id,
        action: 'project.policy.update',
        targetType: 'project',
        targetId: project.id,
        projectId: project.id,
        newState: { policy_revision: project.policy_revision },
      });
      return {
        project_id: project.id,
        revision: project.policy_revision,
        system_revision: project.system_policy_revision,
        policy: project.policy,
        overrides: project.policy_overrides,
        summary: summarizeProjectPolicy(project.policy),
      };
    });

    route('GET', '/api/v1/agent-control/policy', async (ctx) => {
      const project = this.database.getProject(ctx.principal.project_id);
      const system = this.database.getSystemPolicy();
      return {
        agent_instance_id: ctx.principal.agent_instance_id,
        allowed_scopes: ctx.principal.scopes,
        system: { revision: system.revision, overrides: system.overrides },
        project: {
          id: project.id,
          revision: project.policy_revision,
          system_revision: project.system_policy_revision,
          overrides: project.policy_overrides,
          effective_policy: project.policy,
        },
      };
    }, { agentOnly: true, agentScopes: ['policy:read'] });

    route('PATCH', '/api/v1/agent-control/policy', async (ctx) => {
      const body = await readJSON(ctx.request);
      invariant(['project', 'system'].includes(body.scope), 'WS_VALIDATION', 'scope must be project or system.');
      invariant(body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch), 'WS_VALIDATION', 'patch must be an object.');
      invariant(Number.isInteger(body.expected_revision), 'WS_VALIDATION', 'expected_revision is required.');
      invariant(typeof body.reason === 'string' && body.reason.trim().length >= 8,
        'WS_VALIDATION', 'A concise reason tied to the explicit user request is required.');
      const requiredScope = `policy:write:${body.scope}`;
      invariant(ctx.principal.scopes.includes(requiredScope), 'WS_FORBIDDEN', 'The agent token does not grant this control scope.', 403);
      if (body.scope === 'system') {
        const previous = this.database.getSystemPolicy();
        const policy = this.database.updateSystemPolicy(body.patch, {
          actor: ctx.principal.principal_id,
          expectedRevision: body.expected_revision,
          reason: body.reason.trim(),
        });
        this.database.audit({
          actorId: ctx.principal.principal_id,
          action: 'agent.system_policy.update',
          targetType: 'system_policy',
          targetId: policy.id,
          decision: 'allowed_explicit_user_request',
          previousState: { revision: previous.revision },
          newState: { revision: policy.revision, reason: body.reason.trim() },
        });
        return { scope: 'system', revision: policy.revision, restart_required: true, policy };
      }
      const previous = this.database.getProject(ctx.principal.project_id);
      const project = this.database.updateProjectPolicy(
        ctx.principal.project_id,
        body.patch,
        ctx.principal.principal_id,
        { expectedRevision: body.expected_revision, reason: body.reason.trim() },
      );
      this.database.audit({
        actorId: ctx.principal.principal_id,
        action: 'agent.project_policy.update',
        targetType: 'project',
        targetId: project.id,
        projectId: project.id,
        decision: 'allowed_explicit_user_request',
        previousState: { revision: previous.policy_revision },
        newState: { revision: project.policy_revision, reason: body.reason.trim() },
      });
      return { scope: 'project', revision: project.policy_revision, restart_required: true, project };
    }, { agentOnly: true, agentScopes: ['policy:write:project', 'policy:write:system'] });

    route('GET', '/api/v1/agent-control/usage', async () => this.database.accountUsageStatus(), {
      agentOnly: true,
      agentScopes: ['usage:read'],
    });

    route('POST', '/api/v1/agent-control/usage', async (ctx) => {
      const body = await readJSON(ctx.request, 65_536);
      const snapshot = this.database.createAccountUsageSnapshot({
        agentInstanceId: ctx.principal.agent_instance_id,
        source: body.source,
        observedAt: body.observed_at,
        rateLimits: body.rate_limits,
        tokenActivity: body.token_activity,
      }, ctx.principal.principal_id);
      this.database.audit({
        actorId: ctx.principal.principal_id,
        action: 'agent.account_usage.report',
        targetType: 'account_usage_snapshot',
        targetId: snapshot.id,
        projectId: ctx.principal.project_id,
        decision: 'allowed_observation_only',
        newState: {
          source: snapshot.source,
          observed_at: snapshot.observed_at,
          rate_limits: snapshot.rate_limits,
        },
      });
      return this.database.accountUsageStatus();
    }, { agentOnly: true, agentScopes: ['usage:write'] });

    route('GET', '/api/v1/nodes', async () => ({ nodes: this.database.listNodes() }));
    route('POST', '/api/v1/nodes/join-tokens', async (ctx) => {
      const body = await readJSON(ctx.request);
      const token = randomToken('wsj');
      const record = this.database.createJoinToken(body.name || 'New node', token, Math.min(body.ttl_ms || 600_000, 3_600_000));
      this.database.audit({ actorId: ctx.principal.principal_id, action: 'node.join_token.create', targetType: 'join_token', targetId: record.id });
      return { ...record, token };
    });
    route('POST', '/api/v1/nodes/enroll', async (ctx) => {
      const body = await readJSON(ctx.request);
      invariant(typeof body.public_key === 'string' && body.public_key.includes('PUBLIC KEY'), 'WS_VALIDATION', 'Valid node public key is required.');
      const node = this.database.consumeJoinToken(body.token, body.public_key, body.name, body);
      this.database.appendEvent('node', node.id, 'node.enrolled.v1', `node:${node.id}`, node.id, { display_name: node.display_name });
      return { node_id: node.id, display_name: node.display_name, protocol_version: 1 };
    }, { auth: false, csrf: false });

    route('GET', '/api/v1/agent-profiles', async () => ({ profiles: this.database.listProfiles() }));
    route('POST', '/api/v1/agent-profiles', async (ctx) => {
      const body = await readJSON(ctx.request);
      const profile = this.database.createProfile({
        name: body.name,
        adapterKind: body.adapter_kind,
        executable: body.executable,
        arguments: body.arguments,
        environment: body.environment,
        restartPolicy: body.restart_policy,
      }, ctx.principal.principal_id);
      this.database.audit({ actorId: ctx.principal.principal_id, action: 'agent_profile.create', targetType: 'agent_profile', targetId: profile.id, newState: profile });
      return profile;
    });

    route('GET', '/api/v1/agent-instances', async (ctx) => ({ agents: this.database.listAgents(ctx.url.searchParams.get('project')) }));
    route('POST', '/api/v1/agent-instances', async (ctx) => {
      const body = await readJSON(ctx.request);
      invariant(!body.root?.path && !body.root?.absolute_path, 'WS_PATH_INVALID', 'Agent root requests identify a pre-registered root ID, never a host path.');
      const agent = this.database.createAgent({
        profileId: body.profile_id,
        projectId: body.project_id,
        nodeId: body.node_id,
        title: body.title,
        taskId: body.task_id,
        resumability: body.resumability,
        root: body.root,
        orchestrationRole: body.orchestration_role || 'worker',
      }, ctx.principal.principal_id);
      this.database.audit({ actorId: ctx.principal.principal_id, action: 'agent.create', targetType: 'agent_instance', targetId: agent.id, projectId: agent.project_id, newState: agent });
      return agent;
    });
    route('GET', '/api/v1/agent-instances/:id', async (ctx) => {
      const agent = this.database.getAgent(ctx.params.id);
      invariant(agent, 'WS_NOT_FOUND', 'Agent instance not found.', 404);
      return agent;
    });
    route('GET', '/api/v1/agent-instances/:id/policy', async (ctx) => {
      const agent = this.database.getAgent(ctx.params.id);
      invariant(agent, 'WS_NOT_FOUND', 'Agent instance not found.', 404);
      const project = this.database.getProject(agent.project_id);
      const effective = this.database.latestPolicySnapshot(agent.id);
      return {
        effective,
        role: agent.orchestration_role,
        current_project_revision: project.policy_revision,
        current_system_revision: project.system_policy_revision,
        stale: !effective
          || effective.policy_revision < project.policy_revision
          || effective.system_policy_revision < project.system_policy_revision,
        preview: renderProjectInstructions(project, { role: agent.orchestration_role }),
      };
    });
    route('POST', '/api/v1/agent-instances/:id:wake', async (ctx) => this.#wakeAgent(ctx.params.id, ctx.principal.principal_id));
    route('POST', '/api/v1/agent-instances/:id:stop', async (ctx) => this.#stopAgent(ctx.params.id, ctx.principal.principal_id));
    route('POST', '/api/v1/agent-instances/:id:restart', async (ctx) => {
      await this.#stopAgent(ctx.params.id, ctx.principal.principal_id);
      return this.#wakeAgent(ctx.params.id, ctx.principal.principal_id);
    });

    route('GET', '/api/v1/threads/:id', async (ctx) => {
      const thread = this.database.getThread(ctx.params.id);
      invariant(thread, 'WS_NOT_FOUND', 'Thread not found.', 404);
      return thread;
    });
    route('GET', '/api/v1/threads/:id/messages', async (ctx) => ({
      messages: this.database.listMessages(ctx.params.id, parsePositiveInt(ctx.url.searchParams.get('after'), 0), parsePositiveInt(ctx.url.searchParams.get('limit'), 200, 500)),
    }));
    route('POST', '/api/v1/threads/:id/messages', async (ctx) => {
      const body = await readJSON(ctx.request);
      const idempotency = ctx.request.headers['idempotency-key'];
      const result = this.database.createMessage({
        threadId: ctx.params.id,
        actorId: ctx.principal.principal_id,
        deliveryRole: body.delivery_role || 'user',
        displaySender: body.display_sender || 'You',
        contentParts: body.parts,
        replyToMessageId: body.reply_to_message_id,
        taskId: body.task_id,
        traceId: body.trace_id,
        hopCount: body.hop_count,
        priority: body.priority,
        wakePolicy: body.wake_policy || 'ensure_running',
        idempotencyKey: idempotency,
      });
      this.database.audit({ actorId: ctx.principal.principal_id, action: 'message.send', targetType: 'message', targetId: result.message.id, newState: { delivery_role: result.message.delivery_role, wake_policy: result.message.wake_policy } });
      if (!result.duplicate) queueMicrotask(() => this.#dispatchMessage(result.message.id).catch((error) => this.#logError(error)));
      return result;
    });

    route('GET', '/api/v1/tasks', async (ctx) => ({ tasks: this.database.listTasks(ctx.url.searchParams.get('project'), ctx.url.searchParams.get('state')) }));
    route('POST', '/api/v1/tasks', async (ctx) => {
      const body = await readJSON(ctx.request);
      invariant(!body.specification?.cwd && !body.specification?.absolute_path, 'WS_PATH_INVALID', 'Task working directories are selected by root ID, not host paths.');
      const task = this.database.createTask({
        projectId: body.project_id,
        parentTaskId: body.parent_task_id,
        type: body.type,
        title: body.title,
        specification: body.specification,
        desiredAgentProfileId: body.desired_agent_profile_id,
        assignedAgentInstanceId: body.assigned_agent_instance_id,
        nodeId: body.node_id,
        priority: body.priority,
        retryPolicy: body.retry_policy,
        createdBy: ctx.principal.principal_id,
      });
      queueMicrotask(() => this.#scheduleTask(task.id).catch((error) => this.#logError(error)));
      return task;
    });
    route('GET', '/api/v1/tasks/:id', async (ctx) => {
      const task = this.database.getTask(ctx.params.id);
      invariant(task, 'WS_NOT_FOUND', 'Task not found.', 404);
      return task;
    });
    route('POST', '/api/v1/tasks/:id:cancel', async (ctx) => {
      const task = this.database.getTask(ctx.params.id);
      invariant(task, 'WS_NOT_FOUND', 'Task not found.', 404);
      if (task.node_id && this.broker.isOnline(task.node_id)) await this.broker.request(task.node_id, 'task.cancel', { task_id: task.id });
      return this.database.setTaskState(task.id, 'cancelled', null, ctx.principal.principal_id);
    });
    route('POST', '/api/v1/tasks/:id:retry', async (ctx) => {
      const task = this.database.setTaskState(ctx.params.id, 'pending', null, ctx.principal.principal_id);
      queueMicrotask(() => this.#scheduleTask(task.id).catch((error) => this.#logError(error)));
      return task;
    });

    route('GET', '/api/v1/events', async (ctx) => ({
      events: this.database.listEvents(parsePositiveInt(ctx.url.searchParams.get('after'), 0), {
        project: ctx.url.searchParams.get('project'),
        agent: ctx.url.searchParams.get('agent'),
      }, parsePositiveInt(ctx.url.searchParams.get('limit'), 500, 1_000)),
    }));
    route('GET', '/api/v1/attention', async () => ({ items: this.database.listAttention() }));
    route('GET', '/api/v1/audit', async (ctx) => ({ audit: this.database.listAudit(parsePositiveInt(ctx.url.searchParams.get('limit'), 200, 1_000)) }));

    route('GET', '/api/v1/agent-instances/:id/roots', async (ctx) => ({ roots: this.database.listAgentRoots(ctx.params.id) }));
    route('GET', '/api/v1/roots/:id/entries', async (ctx) => this.#fileRequest(ctx, 'files.entries', {
      path: ctx.url.searchParams.get('path') || '',
      options: {
        includeHidden: ctx.url.searchParams.get('hidden') === 'true',
        sort: ctx.url.searchParams.get('sort') || 'name',
        direction: ctx.url.searchParams.get('direction') || 'asc',
        cursor: ctx.url.searchParams.get('cursor') || 0,
      },
    }, 'files.list'));
    route('GET', '/api/v1/roots/:id/stat', async (ctx) => this.#fileRequest(ctx, 'files.stat', { path: ctx.url.searchParams.get('path') || '' }, 'files.stat'));
    route('GET', '/api/v1/roots/:id/preview', async (ctx) => this.#fileRequest(ctx, 'files.preview', { path: ctx.url.searchParams.get('path') }, 'files.preview'));
    route('GET', '/api/v1/roots/:id/search', async (ctx) => this.#fileRequest(ctx, 'files.search', {
      path: ctx.url.searchParams.get('path') || '',
      query: ctx.url.searchParams.get('query'),
      options: { content: ctx.url.searchParams.get('content') !== 'false' },
    }, 'files.search'));
    route('GET', '/api/v1/roots/:id/git-status', async (ctx) => this.#fileRequest(ctx, 'files.git-status', { path: ctx.url.searchParams.get('path') || '' }, 'files.git_status'));
    route('GET', '/api/v1/roots/:id/download', async (ctx) => {
      const relativePath = ctx.url.searchParams.get('path');
      const result = await this.#fileRequest(ctx, 'files.download', { path: relativePath, max_bytes: 64 * 1024 * 1024 }, 'files.download');
      const bytes = Buffer.from(result.data, 'base64');
      const expected = ctx.url.searchParams.get('expected_etag');
      if (expected && expected !== result.etag) throw new WebSpiderError('WS_FILE_CHANGED', 'File changed since it was previewed.', 412);
      ctx.response.writeHead(200, {
        'content-type': fileMime(result.name),
        'content-length': bytes.length,
        'content-disposition': contentDisposition(result.name),
        etag: result.etag,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
        'content-security-policy': "default-src 'none'; sandbox",
      });
      ctx.response.end(bytes);
      return undefined;
    });
    route('POST', '/api/v1/roots/:id/promote-artifact', async (ctx) => {
      const body = await readJSON(ctx.request);
      const root = this.database.getRoot(ctx.params.id);
      invariant(root, 'WS_ROOT_NOT_FOUND', 'Workspace root not found.', 404);
      const result = await this.#fileRequest(ctx, 'files.download', { path: body.path, max_bytes: 64 * 1024 * 1024 }, 'files.promote_artifact');
      const bytes = Buffer.from(result.data, 'base64');
      const digest = createHash('sha256').update(bytes).digest('hex');
      const directory = path.join(this.stateDir, 'artifacts', digest.slice(0, 2));
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const locator = path.join(directory, digest);
      if (!fs.existsSync(locator)) fs.writeFileSync(locator, bytes, { mode: 0o600, flag: 'wx' });
      const artifact = this.database.createArtifact({
        projectId: root.project_id,
        taskId: body.task_id,
        agentInstanceId: root.agent_instance_id,
        logicalName: body.logical_name || path.basename(body.path),
        sha256: digest,
        sizeBytes: bytes.length,
        mimeType: fileMime(body.path),
        storageLocator: locator,
        sourceRootId: root.id,
        sourceRelativePath: body.path,
        actorId: ctx.principal.principal_id,
      });
      return artifact;
    });

    route('GET', '/api/v1/artifacts', async (ctx) => ({ artifacts: this.database.listArtifacts(ctx.url.searchParams.get('project'), ctx.url.searchParams.get('agent')) }));
    route('GET', '/api/v1/artifacts/:id', async (ctx) => {
      const artifact = this.database.getArtifact(ctx.params.id);
      invariant(artifact, 'WS_ARTIFACT_NOT_FOUND', 'Artifact not found.', 404);
      return artifact;
    });
    route('GET', '/api/v1/artifacts/:id/download', async (ctx) => {
      const artifact = this.database.getArtifact(ctx.params.id);
      invariant(artifact && fs.existsSync(artifact.storage_locator), 'WS_ARTIFACT_NOT_FOUND', 'Artifact not found.', 404);
      const bytes = fs.readFileSync(artifact.storage_locator);
      ctx.response.writeHead(200, {
        'content-type': artifact.mime_type,
        'content-length': bytes.length,
        'content-disposition': contentDisposition(artifact.logical_name),
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      });
      ctx.response.end(bytes);
      return undefined;
    });

    route('POST', '/api/v1/terminals/:id/leases', async (ctx) => {
      const body = await readJSON(ctx.request, 16_384);
      invariant(typeof body.attachment_id === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(body.attachment_id), 'WS_VALIDATION', 'Valid attachment_id is required.');
      const lease = this.database.acquireTerminalLease(ctx.params.id, `${ctx.principal.principal_id}#${body.attachment_id}`);
      this.database.audit({ actorId: ctx.principal.principal_id, action: 'terminal.lease.acquire', targetType: 'terminal', targetId: ctx.params.id, newState: lease });
      return lease;
    });
    route('DELETE', '/api/v1/terminals/:id/leases/:lease', async (ctx) => ({
      released: this.database.releaseTerminalLease(ctx.params.id, ctx.params.lease,
        `${ctx.principal.principal_id}#${ctx.url.searchParams.get('attachment') || ''}`),
    }));
    route('GET', '/api/v1/terminals/:id/log', async (ctx) => {
      const terminal = this.database.getTerminal(ctx.params.id);
      invariant(terminal, 'WS_NOT_FOUND', 'Terminal not found.', 404);
      return this.broker.request(terminal.node_id, 'terminal.snapshot', { terminal_id: terminal.id, max_bytes: 200_000 });
    });
  }

  async #handleRequest(request, response) {
    const requestId = makeId('req');
    this.#securityHeaders(response, requestId);
    try {
      const pathname = new URL(request.url, 'http://webspider.invalid').pathname;
      if (!pathname.startsWith('/api/') && pathname !== '/healthz') {
        this.#serveStatic(pathname, response);
        return;
      }
      const match = this.router.match(request);
      const options = match.route.options || {};
      const principal = options.auth === false ? null : this.#authenticate(request);
      if (options.agentOnly) invariant(principal?.role === 'agent', 'WS_FORBIDDEN', 'This route requires a scoped main-agent token.', 403);
      if (principal?.role === 'agent') {
        const allowed = options.agentScopes || [];
        invariant(allowed.length > 0 && allowed.some((scope) => principal.scopes.includes(scope)),
          'WS_FORBIDDEN', 'This agent token is not valid for the requested route.', 403);
      }
      if (options.csrf !== false && principal && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !principal.viaBearer) {
        invariant(request.headers['x-webspider-csrf'] === principal.csrf_token, 'WS_FORBIDDEN', 'CSRF validation failed.', 403);
      }
      const context = { request, response, params: match.params, url: match.url, principal, requestId };
      const result = await match.route.handler(context);
      if (!response.writableEnded && result !== undefined) sendJSON(response, 200, result);
    } catch (error) {
      if (!response.headersSent) sendError(response, error, requestId);
      else response.destroy();
      if (!(error instanceof WebSpiderError) || error.status >= 500) this.#logError(error);
    }
  }

  #authenticate(request) {
    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ') && secureEqual(authorization.slice(7), this.ownerToken)) {
      return { id: 'cli-owner', principal_id: 'owner:local', role: 'owner', viaBearer: true, expires_at: null };
    }
    if (authorization?.startsWith('Bearer ')) {
      const token = this.database.getAgentControlToken(authorization.slice(7));
      if (token) return { ...token, viaBearer: true };
    }
    const cookies = parseCookies(request.headers.cookie);
    const session = this.database.getSession(cookies.ws_session);
    invariant(session, 'WS_AUTH_REQUIRED', 'Authentication required.', 401);
    return { ...session, viaBearer: false };
  }

  #securityHeaders(response, requestId) {
    response.setHeader('x-request-id', requestId);
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('cross-origin-resource-policy', 'same-origin');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  }

  #serveStatic(pathname, response) {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (!['index.html', 'app.js', 'markdown.js', 'random.js', 'vendor/xterm.mjs', 'vendor/xterm.css', 'vendor/xterm.LICENSE', 'styles.css', 'manifest.webmanifest', 'icon.svg'].includes(relative)) {
      const body = Buffer.from('Not found');
      response.writeHead(404, { 'content-type': 'text/plain', 'content-length': body.length });
      response.end(body);
      return;
    }
    const filePath = path.join(this.webDir, relative);
    if (!fs.existsSync(filePath)) throw new WebSpiderError('WS_NOT_FOUND', 'Portal asset not found.', 404);
    const bytes = fs.readFileSync(filePath);
    response.writeHead(200, {
      'content-type': fileMime(filePath),
      'content-length': bytes.length,
      'cache-control': relative === 'index.html' ? 'no-store' : 'public, max-age=3600',
    });
    response.end(bytes);
  }

  #handleUpgrade(request, socket, head) {
    const url = new URL(request.url, 'http://webspider.invalid');
    if (url.pathname === '/api/v1/node/connect') {
      const connection = acceptWebSocket(request, socket, head);
      if (connection) this.broker.attach(connection);
      return;
    }
    let principal;
    try {
      principal = this.#authenticate(request);
      invariant(isSafeOrigin(request, this.allowedOrigins), 'WS_FORBIDDEN', 'WebSocket Origin is not allowed.', 403);
    } catch (error) {
      rejectWebSocket(socket, error.status || 403, error.message || 'Forbidden');
      return;
    }
    if (url.pathname === '/api/v1/ws/events') {
      this.#attachEventSocket(request, socket, head, url, principal);
      return;
    }
    const terminalMatch = /^\/api\/v1\/ws\/terminals\/([^/]+)$/.exec(url.pathname);
    if (terminalMatch) {
      this.#attachTerminalSocket(request, socket, head, url, principal, decodeURIComponent(terminalMatch[1]));
      return;
    }
    rejectWebSocket(socket, 404, 'Not found');
  }

  #attachEventSocket(request, socket, head, url, principal) {
    const connection = acceptWebSocket(request, socket, head);
    if (!connection) return;
    const after = parsePositiveInt(url.searchParams.get('after'), 0);
    for (const event of this.database.listEvents(after, {}, 1_000)) connection.sendJSON({ type: 'EVENT', event });
    const listener = (event) => connection.sendJSON({ type: 'EVENT', event });
    this.database.on('event', listener);
    connection.on('close', () => this.database.off('event', listener));
    connection.sendJSON({ type: 'READY', principal_id: principal.principal_id });
  }

  #attachTerminalSocket(request, socket, head, url, principal, terminalId) {
    const terminal = this.database.getTerminal(terminalId);
    if (!terminal) {
      rejectWebSocket(socket, 404, 'Terminal not found');
      return;
    }
    const connection = acceptWebSocket(request, socket, head);
    if (!connection) return;
    const attachmentId = url.searchParams.get('attachment') || makeId('att');
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(attachmentId)) {
      connection.close(1008, 'Invalid attachment ID');
      return;
    }
    const leasePrincipal = `${principal.principal_id}#${attachmentId}`;
    const outputListener = (output) => {
      if (output.terminal_id !== terminalId) return;
      connection.sendJSON({
        type: 'OUTPUT',
        sequence_start: output.sequence_start,
        sequence_end: output.sequence_end,
        data: output.bytes.toString('base64'),
      });
    };
    this.broker.on('terminal.output', outputListener);
    connection.on('close', () => this.broker.off('terminal.output', outputListener));
    connection.on('text', (text) => {
      let frame;
      try { frame = JSON.parse(text); } catch { connection.sendJSON({ type: 'ERROR', code: 'WS_INVALID_JSON' }); return; }
      Promise.resolve().then(async () => {
        if (frame.type === 'LEASE_REQUEST') {
          const lease = this.database.acquireTerminalLease(terminalId, leasePrincipal);
          connection.sendJSON({ type: 'LEASE_GRANTED', lease });
          return;
        }
        if (frame.type === 'INPUT') {
          const lease = this.database.validateTerminalLease(terminalId, frame.lease_id, frame.lease_epoch, leasePrincipal);
          const result = await this.broker.request(terminal.node_id, 'terminal.input', { terminal_id: terminalId, data: frame.data });
          connection.sendJSON({ type: 'INPUT_ACK', lease, result });
          return;
        }
        if (frame.type === 'HEARTBEAT') {
          const lease = this.database.validateTerminalLease(terminalId, frame.lease_id, frame.lease_epoch, leasePrincipal);
          connection.sendJSON({ type: 'HEARTBEAT_ACK', lease });
        }
      }).catch((error) => connection.sendJSON({ type: 'ERROR', code: error.code || 'WS_INTERNAL', message: error.message }));
    });
    connection.sendJSON({ type: 'ATTACHED', terminal, mode: 'watch', attachment_id: attachmentId });
    this.broker.request(terminal.node_id, 'terminal.snapshot', { terminal_id: terminalId, max_bytes: 200_000 })
      .then((snapshot) => connection.sendJSON({ type: 'SNAPSHOT', ...snapshot }))
      .catch((error) => connection.sendJSON({ type: 'ERROR', code: error.code, message: error.message }));
  }

  async #wakeAgent(agentId, actor) {
    let agent = this.database.getAgent(agentId);
    invariant(agent, 'WS_NOT_FOUND', 'Agent instance not found.', 404);
    if (['ready', 'busy', 'starting'].includes(agent.state)) return agent;
    const node = this.database.getNode(agent.node_id);
    invariant(node?.status === 'online' && this.broker.isOnline(agent.node_id), 'WS_NODE_OFFLINE', 'Agent node is offline.', 503);
    const profile = this.database.getProfile(agent.profile_id);
    const project = this.database.getProject(agent.project_id);
    const root = this.database.listAgentRoots(agent.id)[0];
    invariant(root, 'WS_ROOT_NOT_FOUND', 'Agent has no active workspace root.', 404);
    invariant(['command', 'pty'].includes(profile.adapter_kind), 'WS_ADAPTER_UNAVAILABLE', `${profile.adapter_kind} adapter is not installed on the node.`, 409);
    this.database.setAgentState(agentId, 'starting', actor);
    let controlToken = null;
    try {
      const renderedInstructions = renderProjectInstructions(project, { role: agent.orchestration_role });
      const policySnapshot = this.database.createPolicySnapshot({
        projectId: project.id,
        agentInstanceId: agent.id,
        agentRole: agent.orchestration_role,
        systemPolicyRevision: project.system_policy_revision,
        policyRevision: project.policy_revision,
        policy: project.policy,
        renderedInstructions,
      });
      let agentControl = null;
      if (agent.orchestration_role === 'main') {
        controlToken = randomToken('wsa');
        const record = this.database.issueAgentControlToken(agent.id, controlToken, MAIN_AGENT_CONTROL_SCOPES);
        agentControl = {
          url: new URL('/api/v1/agent-control', this.url).href,
          token: controlToken,
          scopes: record.scopes,
          expires_at: record.expires_at,
        };
      } else {
        this.database.revokeAgentControlTokens(agent.id);
      }
      await this.broker.request(agent.node_id, 'process.start-agent', {
        agent_instance_id: agent.id,
        terminal_id: agent.terminal_id,
        root_id: root.id,
        argv: [profile.executable, ...profile.arguments],
        environment: profile.environment,
        policy_snapshot: policySnapshot,
        agent_control: agentControl,
      }, { timeoutMs: 30_000 });
      this.database.setTerminalState(agent.terminal_id, 'attached');
      agent = this.database.setAgentState(agentId, 'ready', `node:${agent.node_id}`, { adapter_kind: profile.adapter_kind });
      this.database.audit({ actorId: actor, action: 'agent.wake', targetType: 'agent_instance', targetId: agentId, projectId: agent.project_id, newState: { state: agent.state } });
      await this.#drainDeliveries(agent.node_id);
      return agent;
    } catch (error) {
      if (controlToken) this.database.revokeAgentControlTokens(agent.id);
      this.database.setAgentState(agentId, 'failed', 'hub:reconciler', { error: error.message });
      throw error;
    }
  }

  async #stopAgent(agentId, actor) {
    let agent = this.database.getAgent(agentId);
    invariant(agent, 'WS_NOT_FOUND', 'Agent instance not found.', 404);
    this.database.revokeAgentControlTokens(agent.id);
    if (['stopped', 'failed'].includes(agent.state)) return agent;
    this.database.setAgentState(agentId, 'stopping', actor);
    if (this.broker.isOnline(agent.node_id)) {
      await this.broker.request(agent.node_id, 'process.stop-agent', { agent_instance_id: agent.id });
    }
    this.database.setTerminalState(agent.terminal_id, 'exited');
    agent = this.database.setAgentState(agentId, 'stopped', `node:${agent.node_id}`);
    this.database.audit({ actorId: actor, action: 'agent.stop', targetType: 'agent_instance', targetId: agentId, projectId: agent.project_id });
    return agent;
  }

  async #reconcileNode(nodeId, runtimeInventory, connectionEpoch) {
    const runningAgents = new Set(runtimeInventory
      .filter((runtime) => runtime.kind === 'agent' && runtime.state === 'running' && runtime.agent_instance_id)
      .map((runtime) => runtime.agent_instance_id));
    const agents = this.database.listAgents().filter((agent) => agent.node_id === nodeId);
    for (let agent of agents) {
      if (runningAgents.has(agent.id)) {
        if (!['ready', 'busy'].includes(agent.state)) {
          agent = this.database.setAgentState(agent.id, 'ready', `node:${nodeId}`, {
            recovered: true,
            connection_epoch: connectionEpoch,
          });
        }
        continue;
      }
      if (!['ready', 'busy', 'starting'].includes(agent.state)) continue;
      const previousState = agent.state;
      agent = this.database.setAgentState(agent.id, 'failed', 'hub:reconciler', {
        reason: 'runtime_missing_after_node_reconnect',
        connection_epoch: connectionEpoch,
      });
      const profile = this.database.getProfile(agent.profile_id);
      if (!['always', 'on_failure'].includes(profile.restart_policy?.mode)) continue;
      try {
        agent = await this.#wakeAgent(agent.id, 'hub:reconciler');
        const recovery = this.database.createMessage({
          threadId: agent.active_thread_id,
          actorId: `trigger:runtime-recovery:${agent.id}`,
          deliveryRole: 'user',
          displaySender: 'WebSpider recovery',
          contentParts: [{
            type: 'text',
            text: `WebSpider restarted this agent after the machine or runtime went down. The prior WebSpider thread and project state are durable. Read $WEBSPIDER_RECOVERY_CONTEXT if it is available, reconcile unfinished work from the prior ${previousState} runtime, and continue without asking the user to restate the project. Re-delegate only work that did not complete.`,
          }],
          wakePolicy: 'ensure_running',
          idempotencyKey: `runtime-recovery:${agent.id}:${connectionEpoch || nowISO()}`,
          traceId: makeId('trc'),
          hopCount: 1,
        });
        if (!recovery.duplicate) await this.#dispatchMessage(recovery.message.id);
      } catch (error) {
        this.#logError(error);
      }
    }
  }

  async #dispatchMessage(messageId) {
    const message = this.database.getMessage(messageId);
    if (!message || ['adapter_accepted', 'replied'].includes(message.delivery?.state)) return;
    const thread = this.database.getThread(message.thread_id);
    let agent = this.database.getAgent(thread.primary_agent_instance_id);
    if (!this.broker.isOnline(agent.node_id)) {
      this.database.updateMessageDelivery(messageId, 'queued');
      return;
    }
    if (['stopped', 'hibernated', 'failed'].includes(agent.state)) {
      if (message.wake_policy === 'queue_only') {
        this.database.updateMessageDelivery(messageId, 'queued');
        return;
      }
      this.database.updateMessageDelivery(messageId, 'waking');
      agent = await this.#wakeAgent(agent.id, message.authenticated_actor_id);
    }
    if (agent.state === 'busy' && message.wake_policy !== 'interrupt') {
      this.database.updateMessageDelivery(messageId, 'queued');
      return;
    }
    try {
      const previous = this.database.previousInboundMessage(message.thread_id, message.sequence);
      const elapsedMs = previous
        ? Math.max(0, new Date(message.created_at).getTime() - new Date(previous.created_at).getTime())
        : null;
      const quota = agent.orchestration_role === 'main'
        ? accountQuotaContext(this.database.accountUsageStatus())
        : undefined;
      const receipt = await this.broker.request(agent.node_id, 'message.deliver', {
        agent_instance_id: agent.id,
        message,
        delivery_context: {
          message_timestamp_utc: message.created_at,
          delivered_at_utc: nowISO(),
          previous_message_timestamp_utc: previous?.created_at || null,
          elapsed_since_previous_message_ms: elapsedMs,
          source: message.display_sender,
          account_quota: quota,
        },
      });
      this.database.updateMessageDelivery(messageId, 'adapter_accepted', receipt);
      this.database.appendEvent('thread', message.thread_id, 'message.delivered.v1', `node:${agent.node_id}`, messageId, {
        message_id: messageId,
        agent_instance_id: agent.id,
        receipt,
      }, message.trace_id);
    } catch (error) {
      if (error.code === 'WS_NODE_OFFLINE') this.database.updateMessageDelivery(messageId, 'queued');
      else this.database.updateMessageDelivery(messageId, 'failed', null, error.message);
      throw error;
    }
  }

  async #drainDeliveries(nodeId) {
    for (const delivery of this.database.pendingDeliveries(nodeId)) {
      try { await this.#dispatchMessage(delivery.message_id); } catch (error) { this.#logError(error); }
    }
  }

  async #scheduleTask(taskId) {
    let task = this.database.getTask(taskId);
    if (!task || !['pending', 'runnable'].includes(task.state)) return;
    const agent = task.assigned_agent_instance_id ? this.database.getAgent(task.assigned_agent_instance_id) : null;
    invariant(agent, 'WS_TASK_CONFLICT', 'Command tasks require an assigned agent instance.', 409);
    const root = task.specification.root_id
      ? this.database.getRoot(task.specification.root_id)
      : this.database.listAgentRoots(agent.id)[0];
    invariant(root && root.agent_instance_id === agent.id, 'WS_ROOT_NOT_FOUND', 'Task root is not assigned to the selected agent.', 404);
    invariant(Array.isArray(task.specification.argv) && task.specification.argv.length > 0, 'WS_VALIDATION', 'Command task specification requires argv.');
    const nodeId = task.node_id || agent.node_id;
    this.database.setTaskState(task.id, 'runnable', null, 'hub:scheduler');
    if (!this.broker.isOnline(nodeId)) return;
    const terminal = this.database.createTaskTerminal(agent.id);
    const epoch = this.broker.connectionEpoch(nodeId);
    this.database.createTaskAttempt(task.id, nodeId, agent.id, epoch, randomToken('lease'));
    await this.broker.request(nodeId, 'task.start', {
      task_id: task.id,
      agent_instance_id: agent.id,
      terminal_id: terminal.id,
      root_id: root.id,
      argv: task.specification.argv,
      environment: task.specification.environment || {},
    });
    this.database.setTerminalState(terminal.id, 'attached');
    task = this.database.setTaskState(task.id, 'running', null, `node:${nodeId}`);
    return { task, terminal };
  }

  async #handleNodeEvent({ nodeId, epoch, event }) {
    if (!event?.type) return;
    const data = event.payload || {};
    const runtime = data.runtime || {};
    if (event.type === 'process.started') {
      if (runtime.terminalId) this.database.setTerminalState(runtime.terminalId, 'attached');
      if (runtime.agentInstanceId && runtime.kind === 'agent') this.database.setAgentState(runtime.agentInstanceId, 'ready', `node:${nodeId}`);
      this.database.appendEvent(runtime.kind === 'task' ? 'task' : 'agent', runtime.taskId || runtime.agentInstanceId,
        'runtime.started.v1', `node:${nodeId}`, runtime.id, { ...runtime, node_id: nodeId, connection_epoch: epoch });
      return;
    }
    if (['process.completed', 'process.lost'].includes(event.type)) {
      if (runtime.terminalId) this.database.setTerminalState(runtime.terminalId, 'exited');
      if (runtime.kind === 'agent' && runtime.agentInstanceId) {
        this.database.revokeAgentControlTokens(runtime.agentInstanceId);
        this.database.setAgentState(runtime.agentInstanceId, data.exit_status === 0 ? 'stopped' : 'failed', `node:${nodeId}`, { exit_status: data.exit_status });
      }
      if (runtime.taskId) {
        const success = event.type === 'process.completed' && Number(data.exit_status) === 0;
        this.database.completeTaskAttempt(runtime.taskId, success ? 0 : Number(data.exit_status ?? 255), success ? null : event.type);
        const result = {
          status: success ? 'succeeded' : 'failed',
          summary: success ? 'Detached command completed successfully.' : `Detached command failed with exit status ${data.exit_status ?? 'unknown'}.`,
          metrics: { exit_status: data.exit_status ?? null },
          artifacts: [],
        };
        const task = this.database.setTaskState(runtime.taskId, success ? 'succeeded' : 'failed', result, `node:${nodeId}`);
        if (task.specification.notify_master) await this.#notifyMaster(task, result);
      }
      this.database.appendEvent(runtime.kind === 'task' ? 'task' : 'agent', runtime.taskId || runtime.agentInstanceId,
        event.type === 'process.completed' ? 'runtime.completed.v1' : 'runtime.lost.v1', `node:${nodeId}`, runtime.id, {
          node_id: nodeId,
          connection_epoch: epoch,
          exit_status: data.exit_status,
        });
    }
  }

  async #notifyMaster(task, result) {
    const agents = this.database.listAgents(task.project_id);
    const master = agents.find((agent) => agent.orchestration_role === 'main') || agents[0];
    if (!master) return;
    const created = this.database.createMessage({
      threadId: master.active_thread_id,
      actorId: `trigger:task-completion:${task.id}`,
      deliveryRole: 'user',
      displaySender: `Task ${task.id}`,
      contentParts: [{ type: 'text', text: `Task ${task.title} completed.\n\n${result.summary}` }],
      wakePolicy: 'ensure_running',
      idempotencyKey: `task:${task.id}:completed:master`,
      traceId: makeId('trc'),
      hopCount: 1,
    });
    if (!created.duplicate) await this.#dispatchMessage(created.message.id);
  }

  async #fileRequest(ctx, command, payload, auditAction) {
    const root = this.database.getRoot(ctx.params.id);
    invariant(root && !root.revoked_at, 'WS_ROOT_NOT_FOUND', 'Workspace root not found.', 404);
    if (command === 'files.preview') invariant(root.allow_preview, 'WS_FORBIDDEN', 'Preview is disabled for this root.', 403);
    if (command === 'files.download') invariant(root.allow_download, 'WS_FORBIDDEN', 'Download is disabled for this root.', 403);
    if (command === 'files.search') invariant(root.allow_search, 'WS_FORBIDDEN', 'Search is disabled for this root.', 403);
    let decision = 'allowed';
    try {
      const result = await this.broker.request(root.node_id, command, { root_id: root.id, ...payload });
      this.database.audit({ actorId: ctx.principal.principal_id, action: auditAction, targetType: 'workspace_root', targetId: root.id, projectId: root.project_id, decision, newState: { relative_path: payload.path || '', bytes: result?.size } });
      return result;
    } catch (error) {
      decision = 'denied';
      this.database.audit({ actorId: ctx.principal.principal_id, action: auditAction, targetType: 'workspace_root', targetId: root.id, projectId: root.project_id, decision, newState: { relative_path: payload.path || '', error: error.code } });
      throw error;
    }
  }

  #logError(error) {
    const value = error?.stack || error?.message || String(error);
    process.stderr.write(`[webspider] ${value}\n`);
  }
}
