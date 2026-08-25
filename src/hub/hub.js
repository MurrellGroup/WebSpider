import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { HubDatabase } from '../db/hub-database.js';
import { NodeBroker } from './node-broker.js';
import { TerminalInputPipeline } from './terminal-input-pipeline.js';
import { Router } from '../lib/router.js';
import { acceptWebSocket, rejectWebSocket } from '../transport/websocket.js';
import { WebSpiderError, invariant } from '../lib/errors.js';
import { contentDisposition, parsePositiveInt, readJSON, sendError, sendJSON } from '../lib/http.js';
import { ensurePrivateFile, isSafeOrigin, parseCookies, secureEqual, sessionSecret, sha256, verifyNodeHello } from '../lib/security.js';
import { makeId, nowISO, randomToken } from '../lib/ids.js';
import { renderProjectInstructions, summarizeProjectPolicy } from '../lib/project-policy.js';
import { agentLaunchArguments } from '../lib/agent-profile.js';
import { decodeImageBase64, validateImageUpload } from '../lib/image-upload.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_DIR = path.resolve(MODULE_DIR, '../../web');
const MAIN_AGENT_CONTROL_SCOPES = [
  'policy:read',
  'policy:write:project',
  'policy:write:system',
  'usage:read',
  'usage:write',
  'agents:read',
  'messages:write',
  'documents:write',
  'tasks:read',
  'tasks:write',
  'reminders:read:self',
  'reminders:write:self',
  'portfolio:read',
  'notes:read:visible',
];
const WORKER_AGENT_CONTROL_SCOPES = [
  'status:write:self',
  'tasks:read',
  'tasks:write',
  'reminders:read:self',
  'reminders:write:self',
  'documents:write',
];
const MAX_TIMER_DELAY_MS = 2_147_000_000;

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
  ['.webp', 'image/webp'],
  ['.pdf', 'application/pdf'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
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
    const portalHash = createHash('sha256');
    for (const asset of ['index.html', 'app.js', 'styles.css', 'markdown.js', 'random.js', 'terminal-output.js']) {
      portalHash.update(fs.readFileSync(path.join(this.webDir, asset)));
    }
    this.portalBuild = portalHash.digest('hex').slice(0, 16);
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(stateDir, 'artifacts'), { recursive: true, mode: 0o700 });
    this.notesDir = path.join(stateDir, 'notes');
    fs.mkdirSync(this.notesDir, { recursive: true, mode: 0o700 });
    this.ownerTokenPath = path.join(stateDir, 'owner.token');
    ensurePrivateFile(this.ownerTokenPath, ownerToken || randomToken('wso'));
    this.ownerToken = fs.readFileSync(this.ownerTokenPath, 'utf8').trim();
    this.database = new HubDatabase(path.join(stateDir, 'webspider.db'));
    this.broker = new NodeBroker(this.database);
    this.agentRuntimes = new Map();
    this.reminderTimers = new Map();
    this.router = new Router();
    this.portalConnections = new Set();
    this.server = http.createServer((request, response) => this.#handleRequest(request, response));
    this.server.on('upgrade', (request, socket, head) => this.#handleUpgrade(request, socket, head));
    this.#registerRoutes();
    this.broker.on('node.event', (envelope) => this.#handleNodeEvent(envelope).catch((error) => this.#logError(error)));
    this.broker.on('error', (error) => this.#logError(error));
    this.database.on('event', (event) => {
      if (event.type === 'node.online.v1') {
        this.#reconcileNode(event.scope_id, event.payload?.runtime_inventory || [], event.payload?.connection_epoch)
          .then(async () => {
            await this.#drainDeliveries(event.scope_id);
            await this.#drainTasks(event.scope_id);
          })
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
    this.#restoreReminders();
    return { url: this.url, ownerToken: this.ownerToken, address };
  }

  async close() {
    for (const timer of this.reminderTimers.values()) clearTimeout(timer);
    this.reminderTimers.clear();
    const closed = new Promise((resolve) => this.server.close(() => resolve()));
    for (const connection of this.portalConnections) connection.close(1001, 'Hub stopping');
    for (const state of this.broker.connections.values()) state.connection.close(1001, 'Hub stopping');
    this.server.closeAllConnections?.();
    await closed;
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

    route('GET', '/healthz', async () => ({
      status: 'ok', version: '0.6.9', portal_build: this.portalBuild, time: nowISO(),
    }), { auth: false, csrf: false });
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
      const changed = policy.revision !== previous.revision;
      if (changed) {
        this.database.audit({
          actorId: ctx.principal.principal_id,
          action: 'system.policy.update',
          targetType: 'system_policy',
          targetId: policy.id,
          previousState: { revision: previous.revision },
          newState: { revision: policy.revision, reason: body.reason || null },
        });
      }
      return { ...policy, changed };
    });
    route('GET', '/api/v1/projects', async (ctx) => {
      const requested = ctx.url.searchParams.get('archived');
      const archived = requested === 'only' ? 'archived' : requested === 'include' ? 'all' : 'active';
      return { projects: this.database.listProjects({ archived }) };
    });
    route('GET', '/api/v1/notes', async () => ({ notes: this.database.listNotes() }));
    route('POST', '/api/v1/notes', async (ctx) => {
      const body = await readJSON(ctx.request, 1_100_000);
      const id = makeId('nte');
      const filename = `${id}.txt`;
      const title = this.#noteTitle(body.title);
      const visibility = this.#noteVisibility(body.visibility);
      const content = this.#noteContent(body.content);
      this.#writeNoteFile(filename, content);
      let note;
      try {
        note = this.database.createNote({ id, title, filename, visibility });
      } catch (error) {
        fs.rmSync(this.#notePath(filename), { force: true });
        throw error;
      }
      this.database.audit({ actorId: ctx.principal.principal_id, action: 'note.create', targetType: 'note', targetId: note.id, newState: { title, visibility } });
      return { ...note, content };
    });
    route('GET', '/api/v1/notes/:id', async (ctx) => this.#noteWithContent(ctx.params.id));
    route('PATCH', '/api/v1/notes/:id', async (ctx) => {
      const previous = this.database.getNote(ctx.params.id);
      invariant(previous, 'WS_NOT_FOUND', 'Note not found.', 404);
      const body = await readJSON(ctx.request, 1_100_000);
      const title = Object.hasOwn(body, 'title') ? this.#noteTitle(body.title) : undefined;
      const visibility = Object.hasOwn(body, 'visibility') ? this.#noteVisibility(body.visibility) : undefined;
      const content = Object.hasOwn(body, 'content') ? this.#noteContent(body.content) : undefined;
      if (content !== undefined) this.#writeNoteFile(previous.filename, content);
      const note = this.database.updateNote(previous.id, {
        title,
        visibility,
      });
      this.database.audit({ actorId: ctx.principal.principal_id, action: 'note.update', targetType: 'note', targetId: note.id, previousState: { title: previous.title, visibility: previous.visibility }, newState: { title: note.title, visibility: note.visibility } });
      return this.#noteWithContent(note.id);
    });
    route('DELETE', '/api/v1/notes/:id', async (ctx) => {
      const note = this.database.deleteNote(ctx.params.id);
      fs.rmSync(this.#notePath(note.filename), { force: true });
      this.database.audit({ actorId: ctx.principal.principal_id, action: 'note.delete', targetType: 'note', targetId: note.id, previousState: { title: note.title, visibility: note.visibility } });
      return { deleted: true, id: note.id };
    });
    route('POST', '/api/v1/projects/onboard', async (ctx) => {
      const body = await readJSON(ctx.request);
      const project = this.database.createProject({
        name: body.project_name,
        description: body.description || '',
        labels: { project_kind: 'academic', context_inference: 'user-onboarded' },
      }, ctx.principal.principal_id);
      const token = randomToken('wsj');
      const invite = this.database.createJoinToken(body.node_name || project.name, token, 600_000, { project_id: project.id });
      this.database.audit({
        actorId: ctx.principal.principal_id,
        action: 'project.worker_invite.create',
        targetType: 'join_token',
        targetId: invite.id,
        projectId: project.id,
        newState: { expires_at: invite.expires_at },
      });
      return { project, invite: { ...invite, token }, hub_url: this.url };
    });
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
    route('POST', '/api/v1/projects/:id:archive', async (ctx) => {
      const previous = this.database.getProject(ctx.params.id);
      const project = this.database.archiveProject(ctx.params.id, ctx.principal.principal_id);
      this.database.audit({
        actorId: ctx.principal.principal_id,
        action: 'project.archive',
        targetType: 'project',
        targetId: project.id,
        projectId: project.id,
        previousState: { archived_at: previous.archived_at },
        newState: { archived_at: project.archived_at },
      });
      return project;
    });
    route('POST', '/api/v1/projects/:id:restore', async (ctx) => {
      const previous = this.database.getProject(ctx.params.id);
      const project = this.database.restoreProject(ctx.params.id, ctx.principal.principal_id);
      this.database.audit({
        actorId: ctx.principal.principal_id,
        action: 'project.restore',
        targetType: 'project',
        targetId: project.id,
        projectId: project.id,
        previousState: { archived_at: previous.archived_at },
        newState: { archived_at: null },
      });
      return project;
    });
    route('DELETE', '/api/v1/projects/:id', async (ctx) => {
      const body = await readJSON(ctx.request, 16_384);
      const project = this.database.getProject(ctx.params.id);
      invariant(project, 'WS_NOT_FOUND', 'Project not found.', 404);
      invariant(body.confirmation === project.name, 'WS_CONFIRMATION_REQUIRED', 'Type the exact project name to delete it.', 409);
      for (const task of this.database.listTasks(project.id)) {
        const timer = this.reminderTimers.get(task.id);
        if (timer) clearTimeout(timer);
        this.reminderTimers.delete(task.id);
      }
      const result = this.database.deleteArchivedProject(project.id);
      this.database.audit({
        actorId: ctx.principal.principal_id,
        action: 'project.delete',
        targetType: 'project',
        targetId: project.id,
        decision: 'allowed_archived_metadata_delete',
        previousState: { name: project.name, archived_at: project.archived_at },
        newState: { deleted: true, workspace_files_deleted: false },
      });
      return result;
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
    route('POST', '/api/v1/projects/:id/agents', async (ctx) => {
      const body = await readJSON(ctx.request);
      const agent = this.#createWorkerAgent({
        projectId: ctx.params.id,
        nodeId: body.node_id,
        nodeRootId: body.node_root_id,
        title: body.title,
        actor: ctx.principal.principal_id,
      });
      return this.#wakeAgent(agent.id, ctx.principal.principal_id);
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

    route('GET', '/api/v1/agent-control/agents', async (ctx) => ({
      agents: this.database.listAgents().filter((agent) => !agent.project_archived_at).map((agent) => ({
        id: agent.id,
        title: agent.title,
        profile_name: agent.profile_name,
        project_id: agent.project_id,
        project_name: agent.project_name,
        node_id: agent.node_id,
        node_name: agent.node_name,
        state: agent.state,
        orchestration_role: agent.orchestration_role,
        work_status: agent.work_status,
        status_summary: agent.status_summary,
        status_updated_at: agent.status_updated_at,
        is_self: agent.id === ctx.principal.agent_instance_id,
      })),
    }), { agentOnly: true, agentScopes: ['agents:read'] });

    route('GET', '/api/v1/agent-control/portfolio', async () => ({
      projects: this.database.listProjects().map((project) => ({
        id: project.id,
        name: project.name,
        description: project.description,
        agents: this.database.listAgents(project.id).map((agent) => ({
          id: agent.id,
          title: agent.title,
          node_id: agent.node_id,
          node_name: agent.node_name,
          runtime_state: agent.state,
          work_status: agent.work_status,
          status_summary: agent.status_summary,
          status_updated_at: agent.status_updated_at,
          last_activity_at: agent.last_activity_at,
        })),
      })),
    }), { agentOnly: true, agentScopes: ['portfolio:read'] });

    route('GET', '/api/v1/agent-control/tasks', async (ctx) => {
      const source = this.database.getAgent(ctx.principal.agent_instance_id);
      const tasks = this.database.listTasks().filter((task) => task.type === 'command');
      return {
        tasks: source.orchestration_role === 'main'
          ? tasks
          : tasks.filter((task) => task.assigned_agent_instance_id === source.id),
      };
    }, { agentOnly: true, agentScopes: ['tasks:read'] });

    route('POST', '/api/v1/agent-control/tasks', async (ctx) => {
      const body = await readJSON(ctx.request, 262_144);
      const source = this.database.getAgent(ctx.principal.agent_instance_id);
      const target = this.database.getAgent(body.agent_id || source.id);
      invariant(target, 'WS_NOT_FOUND', 'Target agent not found.', 404);
      if (source.orchestration_role !== 'main') {
        invariant(target.id === source.id, 'WS_FORBIDDEN', 'A worker can run detached tasks only on itself.', 403);
      }
      invariant(Array.isArray(body.argv) && body.argv.length > 0 && body.argv.length <= 256
        && body.argv.every((argument) => typeof argument === 'string' && argument.length <= 65_536),
      'WS_VALIDATION', 'argv must contain between 1 and 256 string arguments.');
      const delaySeconds = Number(body.delay_seconds || 0);
      invariant(Number.isInteger(delaySeconds) && delaySeconds >= 0 && delaySeconds <= 86_400,
        'WS_VALIDATION', 'delay_seconds must be an integer between 0 and 86400.');
      const title = body.title == null ? `Command on ${target.title || target.id}` : body.title;
      invariant(typeof title === 'string' && title.trim().length > 0 && title.length <= 200,
        'WS_VALIDATION', 'title must be a non-empty string of at most 200 characters.');
      const notifyTarget = body.notify_target
        || (body.notify_master === false ? 'none' : 'master');
      invariant(['none', 'self', 'master'].includes(notifyTarget), 'WS_VALIDATION',
        'notify_target must be none, self, or master.');
      const completionMessage = body.completion_message == null ? '' : body.completion_message;
      invariant(typeof completionMessage === 'string' && completionMessage.length <= 16_384,
        'WS_VALIDATION', 'completion_message must be at most 16384 characters.');
      if (body.root_id) {
        const root = this.database.getRoot(body.root_id);
        invariant(root?.agent_instance_id === target.id, 'WS_ROOT_NOT_FOUND', 'Task root is not assigned to the target agent.', 404);
      }
      const argv = delaySeconds > 0
        ? ['/bin/sh', '-c', 'delay=$1; shift; sleep "$delay"; exec "$@"', 'webspider-delay', String(delaySeconds), ...body.argv]
        : body.argv;
      const task = this.database.createTask({
        projectId: target.project_id,
        type: 'command',
        title: title.trim(),
        specification: {
          argv,
          requested_argv: body.argv,
          delay_seconds: delaySeconds,
          root_id: body.root_id || undefined,
          environment: {},
          notify_target: notifyTarget,
          completion_message: completionMessage.trim(),
        },
        assignedAgentInstanceId: target.id,
        nodeId: target.node_id,
        createdBy: ctx.principal.principal_id,
      });
      this.database.audit({
        actorId: ctx.principal.principal_id,
        action: 'agent.task.create',
        targetType: 'task',
        targetId: task.id,
        projectId: target.project_id,
        decision: 'allowed_scoped_orchestration',
        newState: {
          agent_id: target.id,
          delay_seconds: delaySeconds,
          requested_argv: body.argv,
          notify_target: notifyTarget,
        },
      });
      queueMicrotask(() => this.#scheduleTask(task.id).catch((error) => this.#logError(error)));
      return task;
    }, { agentOnly: true, agentScopes: ['tasks:write'] });

    route('GET', '/api/v1/agent-control/reminders', async (ctx) => ({
      reminders: this.database.listTasks()
        .filter((task) => task.type === 'reminder'
          && task.assigned_agent_instance_id === ctx.principal.agent_instance_id),
    }), { agentOnly: true, agentScopes: ['reminders:read:self'] });

    route('POST', '/api/v1/agent-control/reminders', async (ctx) => {
      const body = await readJSON(ctx.request, 65_536);
      const source = this.database.getAgent(ctx.principal.agent_instance_id);
      const message = body.message;
      invariant(typeof message === 'string' && message.trim().length > 0 && message.length <= 16_384,
        'WS_VALIDATION', 'message must be a non-empty string of at most 16384 characters.');
      const everySeconds = body.every_seconds == null ? null : Number(body.every_seconds);
      invariant(everySeconds == null || (Number.isInteger(everySeconds) && everySeconds >= 1 && everySeconds <= 2_592_000),
        'WS_VALIDATION', 'every_seconds must be an integer between 1 and 2592000.');
      const delaySeconds = body.delay_seconds == null ? everySeconds : Number(body.delay_seconds);
      invariant(Number.isInteger(delaySeconds) && delaySeconds >= 1 && delaySeconds <= 2_592_000,
        'WS_VALIDATION', 'delay_seconds must be an integer between 1 and 2592000.');
      const maxRuns = body.max_runs == null ? null : Number(body.max_runs);
      invariant(maxRuns == null || (Number.isInteger(maxRuns) && maxRuns >= 1 && maxRuns <= 10_000),
        'WS_VALIDATION', 'max_runs must be an integer between 1 and 10000.');
      invariant(everySeconds != null || maxRuns == null || maxRuns === 1, 'WS_VALIDATION',
        'max_runs greater than one requires every_seconds.');
      const deliveryTarget = body.delivery_target || 'self';
      invariant(['self', 'master'].includes(deliveryTarget), 'WS_VALIDATION',
        'delivery_target must be self or master.');
      const title = body.title == null ? `Reminder for ${source.title || source.id}` : body.title;
      invariant(typeof title === 'string' && title.trim().length > 0 && title.length <= 200,
        'WS_VALIDATION', 'title must be a non-empty string of at most 200 characters.');
      const task = this.database.createTask({
        projectId: source.project_id,
        type: 'reminder',
        title: title.trim(),
        specification: {
          message: message.trim(),
          delivery_target: deliveryTarget,
          next_run_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
          repeat_every_seconds: everySeconds,
          max_runs: maxRuns,
          run_count: 0,
        },
        assignedAgentInstanceId: source.id,
        nodeId: source.node_id,
        createdBy: ctx.principal.principal_id,
      });
      this.database.audit({
        actorId: ctx.principal.principal_id,
        action: 'agent.reminder.create',
        targetType: 'task',
        targetId: task.id,
        projectId: source.project_id,
        decision: 'allowed_self_hook',
        newState: {
          delivery_target: deliveryTarget,
          next_run_at: task.specification.next_run_at,
          repeat_every_seconds: everySeconds,
          max_runs: maxRuns,
        },
      });
      this.#armReminder(task);
      return task;
    }, { agentOnly: true, agentScopes: ['reminders:write:self'] });

    route('POST', '/api/v1/agent-control/reminders/:id:cancel', async (ctx) => {
      const task = this.database.getTask(ctx.params.id);
      invariant(task?.type === 'reminder'
        && task.assigned_agent_instance_id === ctx.principal.agent_instance_id,
      'WS_NOT_FOUND', 'Self reminder not found.', 404);
      invariant(['pending', 'runnable'].includes(task.state), 'WS_TASK_CONFLICT',
        'Only an active reminder can be cancelled.', 409);
      const timer = this.reminderTimers.get(task.id);
      if (timer) clearTimeout(timer);
      this.reminderTimers.delete(task.id);
      this.database.audit({
        actorId: ctx.principal.principal_id,
        action: 'agent.reminder.cancel',
        targetType: 'task',
        targetId: task.id,
        projectId: task.project_id,
        decision: 'allowed_self_hook',
      });
      return this.database.setTaskState(task.id, 'cancelled', {
        status: 'cancelled', summary: 'Reminder cancelled before its next delivery.',
      }, ctx.principal.principal_id);
    }, { agentOnly: true, agentScopes: ['reminders:write:self'] });

    route('GET', '/api/v1/agent-control/notes', async () => ({
      notes: this.database.listNotes({ visibility: 'master' }).map((note) => ({
        ...note,
        content: this.#readNoteFile(note.filename),
      })),
    }), { agentOnly: true, agentScopes: ['notes:read:visible'] });

    route('GET', '/api/v1/agent-control/notes/:id', async (ctx) => {
      const note = this.database.getNote(ctx.params.id);
      invariant(note?.visibility === 'master', 'WS_NOT_FOUND', 'Visible note not found.', 404);
      return { ...note, content: this.#readNoteFile(note.filename) };
    }, { agentOnly: true, agentScopes: ['notes:read:visible'] });

    route('POST', '/api/v1/agent-control/report', async (ctx) => {
      const body = await readJSON(ctx.request, 65_536);
      const agent = this.database.updateAgentWorkStatus(
        ctx.principal.agent_instance_id,
        body.status,
        body.summary,
        ctx.principal.principal_id,
      );
      const master = this.database.getAgent('agt_master')
        || this.database.listAgents().find((candidate) => candidate.orchestration_role === 'main');
      let notification = null;
      if (master && master.id !== agent.id) {
        notification = this.database.createMessage({
          threadId: master.active_thread_id,
          actorId: ctx.principal.principal_id,
          deliveryRole: 'user',
          displaySender: `${agent.title} status via WebSpider`,
          contentParts: [{ type: 'text', text: `[${agent.project_name}] ${body.status}: ${body.summary.trim()}` }],
          wakePolicy: 'ensure_running',
          idempotencyKey: body.idempotency_key || makeId('idem'),
          traceId: body.trace_id || makeId('trc'),
          hopCount: 1,
        });
        if (!notification.duplicate) queueMicrotask(() => this.#dispatchMessage(notification.message.id).catch((error) => this.#logError(error)));
      }
      return { agent, notification };
    }, { agentOnly: true, agentScopes: ['status:write:self'] });

    route('POST', '/api/v1/agent-control/agents/:id/messages', async (ctx) => {
      const body = await readJSON(ctx.request, 262_144);
      const target = ctx.params.id === 'master' ? this.#masterAgent() : this.database.getAgent(ctx.params.id);
      invariant(target, 'WS_NOT_FOUND', 'Target agent not found.', 404);
      invariant(target.id !== ctx.principal.agent_instance_id, 'WS_FORBIDDEN', 'Use the current terminal to talk to this agent.', 403);
      invariant(typeof body.message === 'string' && body.message.trim().length > 0 && body.message.length <= 200_000,
        'WS_VALIDATION', 'A message of at most 200000 characters is required.');
      const wakePolicy = body.wake_policy || 'ensure_running';
      invariant(['ensure_running', 'queue_only', 'interrupt'].includes(wakePolicy), 'WS_VALIDATION', 'Invalid wake policy.');
      const source = this.database.getAgent(ctx.principal.agent_instance_id);
      const result = this.database.createMessage({
        threadId: target.active_thread_id,
        actorId: ctx.principal.principal_id,
        deliveryRole: 'user',
        displaySender: `${source?.profile_name || 'WebSpider main agent'} via WebSpider`,
        contentParts: [{ type: 'text', text: body.message }],
        wakePolicy,
        idempotencyKey: body.idempotency_key || makeId('idem'),
        traceId: body.trace_id || makeId('trc'),
        hopCount: 1,
      });
      this.database.audit({
        actorId: ctx.principal.principal_id,
        action: 'agent.message.send',
        targetType: 'agent_instance',
        targetId: target.id,
        projectId: target.project_id,
        decision: 'allowed_scoped_orchestration',
        newState: { message_id: result.message.id, wake_policy: wakePolicy },
      });
      if (!result.duplicate) queueMicrotask(() => this.#dispatchMessage(result.message.id).catch((error) => this.#logError(error)));
      return result;
    }, { agentOnly: true, agentScopes: ['messages:write'] });

    route('POST', '/api/v1/agent-control/agents/:id/documents', async (ctx) => {
      const body = await readJSON(ctx.request, 800_000);
      const source = this.database.getAgent(ctx.principal.agent_instance_id);
      const target = ctx.params.id === 'master' ? this.#masterAgent() : this.database.getAgent(ctx.params.id);
      invariant(target, 'WS_NOT_FOUND', 'Target agent not found.', 404);
      if (source.orchestration_role !== 'main') {
        invariant(target.orchestration_role === 'main', 'WS_FORBIDDEN',
          'A worker can hand a document only to the Master.', 403);
      }
      const filename = body.filename;
      invariant(typeof filename === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(filename)
        && ['.txt', '.md', '.markdown'].includes(path.extname(filename).toLowerCase()),
      'WS_VALIDATION', 'filename must be a safe .txt, .md, or .markdown basename.');
      invariant(typeof body.data_base64 === 'string' && body.data_base64.length > 0
        && body.data_base64.length <= 700_000 && /^[A-Za-z0-9+/]*={0,2}$/.test(body.data_base64),
      'WS_VALIDATION', 'data_base64 must contain a text document of at most 512 KiB.');
      const bytes = Buffer.from(body.data_base64, 'base64');
      invariant(bytes.toString('base64') === body.data_base64, 'WS_VALIDATION', 'data_base64 is not canonical base64.');
      invariant(bytes.length > 0 && bytes.length <= 512 * 1024,
        'WS_REQUEST_TOO_LARGE', 'Document must contain between 1 byte and 512 KiB.', 413);
      let decoded;
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
        throw new WebSpiderError('WS_VALIDATION', 'Document must be valid UTF-8 text.', 400);
      }
      invariant(!decoded.includes('\0'), 'WS_VALIDATION', 'Document must be UTF-8 text without NUL bytes.');
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (body.sha256 != null) invariant(body.sha256 === digest, 'WS_VALIDATION', 'Document checksum does not match.');
      const instruction = body.instruction == null ? 'Read this document and carry out its authorized instructions.' : body.instruction;
      invariant(typeof instruction === 'string' && instruction.trim().length > 0 && instruction.length <= 16_384,
        'WS_VALIDATION', 'instruction must be a non-empty string of at most 16384 characters.');
      const wakePolicy = body.wake_policy || 'ensure_running';
      invariant(['ensure_running', 'queue_only', 'interrupt'].includes(wakePolicy), 'WS_VALIDATION', 'Invalid wake policy.');
      const documentId = makeId('doc');
      const relativePath = `.webspider/inbox/${documentId}-${filename}`;
      const text = [
        '[WebSpider document handoff]',
        `Document ID: ${documentId}`,
        `Filename: ${filename}`,
        `SHA-256: ${digest}`,
        `Local path: ${relativePath}`,
        `Instruction: ${instruction.trim()}`,
        'Read the immutable local inbox copy; do not reconstruct the document from this message.',
      ].join('\n');
      const result = this.database.createMessage({
        threadId: target.active_thread_id,
        actorId: ctx.principal.principal_id,
        deliveryRole: 'user',
        displaySender: `${source.title || source.profile_name || source.id} document via WebSpider`,
        contentParts: [
          { type: 'text', text },
          {
            type: 'document', document_id: documentId, filename, relative_path: relativePath,
            sha256: digest, size_bytes: bytes.length, data_base64: bytes.toString('base64'),
          },
        ],
        wakePolicy,
        idempotencyKey: body.idempotency_key || makeId('idem'),
        traceId: body.trace_id || makeId('trc'),
        hopCount: 1,
      });
      this.database.audit({
        actorId: ctx.principal.principal_id,
        action: 'agent.document.send',
        targetType: 'agent_instance',
        targetId: target.id,
        projectId: target.project_id,
        decision: source.orchestration_role === 'main' ? 'allowed_scoped_orchestration' : 'allowed_worker_to_master',
        newState: { document_id: documentId, filename, relative_path: relativePath, sha256: digest, size_bytes: bytes.length },
      });
      if (!result.duplicate) queueMicrotask(() => this.#dispatchMessage(result.message.id).catch((error) => this.#logError(error)));
      return { ...result, document: { id: documentId, filename, relative_path: relativePath, sha256: digest, size_bytes: bytes.length } };
    }, { agentOnly: true, agentScopes: ['documents:write'] });

    route('GET', '/api/v1/nodes', async () => ({ nodes: this.database.listNodes() }));
    route('POST', '/api/v1/nodes/join-tokens', async (ctx) => {
      const body = await readJSON(ctx.request);
      const token = randomToken('wsj');
      if (body.project_id) {
        const project = this.database.getProject(body.project_id);
        invariant(project, 'WS_NOT_FOUND', 'Project not found.', 404);
        invariant(!project.archived_at, 'WS_PROJECT_ARCHIVED', 'Restore the project before connecting a worker.', 409);
      }
      const record = this.database.createJoinToken(
        body.name || 'New node', token, Math.min(body.ttl_ms || 600_000, 3_600_000),
        body.project_id ? { project_id: body.project_id } : {},
      );
      this.database.audit({ actorId: ctx.principal.principal_id, action: 'node.join_token.create', targetType: 'join_token', targetId: record.id });
      return { ...record, token };
    });
    route('POST', '/api/v1/nodes/enroll', async (ctx) => {
      const body = await readJSON(ctx.request);
      invariant(typeof body.public_key === 'string' && body.public_key.includes('PUBLIC KEY'), 'WS_VALIDATION', 'Valid node public key is required.');
      const node = this.database.consumeJoinToken(body.token, body.public_key, body.name, body);
      let agent = null;
      if (node.enrollment?.project_id) {
        const root = body.capabilities?.roots?.[0];
        invariant(root?.id, 'WS_VALIDATION', 'The invited worker must register a workspace root.');
        agent = this.#createWorkerAgent({
          projectId: node.enrollment.project_id,
          nodeId: node.id,
          nodeRootId: root.id,
          title: this.database.getProject(node.enrollment.project_id)?.name,
          actor: `node:${node.id}`,
        });
        this.database.setAgentState(agent.id, 'starting', `node:${node.id}`, { reason: 'awaiting_initial_connection' });
      }
      this.database.appendEvent('node', node.id, 'node.enrolled.v1', `node:${node.id}`, node.id, { display_name: node.display_name });
      return { node_id: node.id, display_name: node.display_name, protocol_version: 1, agent_id: agent?.id || null };
    }, { auth: false, csrf: false });
    route('POST', '/api/v1/nodes/attach-root', async (ctx) => {
      const body = await readJSON(ctx.request);
      invariant(body.node_id && body.timestamp && body.nonce && body.signature,
        'WS_AUTH_REQUIRED', 'Incomplete node attachment request.', 401);
      const node = this.database.getNode(body.node_id, true);
      invariant(node, 'WS_NODE_UNKNOWN', 'This node identity is not registered with this hub.', 401);
      invariant(Math.abs(Date.now() - Number(body.timestamp)) <= 300_000, 'WS_AUTH_REQUIRED', 'Node attachment signature is stale.', 401);
      invariant(verifyNodeHello(node.public_key, body.node_id, body.timestamp, body.nonce, body.signature),
        'WS_AUTH_REQUIRED', 'Invalid node attachment signature.', 401);
      invariant(body.root?.id && body.root?.name, 'WS_VALIDATION', 'A registered root ID and name are required.');
      const enrollment = this.database.consumeJoinTokenForNode(body.token, node.id);
      invariant(enrollment.project_id, 'WS_VALIDATION', 'This invite is not associated with a project.');
      const capabilities = node.capabilities || {};
      const roots = [...(capabilities.roots || []).filter((root) => root.id !== body.root.id), body.root];
      const updatedNode = this.database.updateNodeCapabilities(node.id, {
        ...capabilities,
        roots,
        root_ids: roots.map((root) => root.id),
      });
      const agent = this.#createWorkerAgent({
        projectId: enrollment.project_id,
        nodeId: node.id,
        nodeRootId: body.root.id,
        title: this.database.getProject(enrollment.project_id)?.name,
        actor: `node:${node.id}`,
      });
      this.database.setAgentState(agent.id, 'starting', `node:${node.id}`, { reason: 'awaiting_root_reload' });
      this.database.appendEvent('node', node.id, 'node.root.attached.v1', `node:${node.id}`, body.root.id, {
        project_id: enrollment.project_id,
        root: body.root,
      });
      return { attached: true, node_id: updatedNode.id, project_id: enrollment.project_id, agent_id: agent.id };
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

    route('GET', '/api/v1/agent-instances', async (ctx) => {
      const requested = ctx.url.searchParams.get('archived');
      const agents = this.database.listAgents(ctx.url.searchParams.get('project'));
      return {
        agents: agents.filter((agent) => requested === 'only' ? agent.project_archived_at : !agent.project_archived_at),
      };
    });
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
      const preview = renderProjectInstructions(project, {
        role: agent.orchestration_role,
        customInstructions: agent.custom_instructions,
      });
      return {
        effective,
        role: agent.orchestration_role,
        custom_instructions: agent.custom_instructions,
        instruction_revision: agent.instruction_revision,
        current_project_revision: project.policy_revision,
        current_system_revision: project.system_policy_revision,
        stale: !effective
          || effective.policy_revision < project.policy_revision
          || effective.system_policy_revision < project.system_policy_revision
          || effective.agent_instruction_revision < agent.instruction_revision
          || effective.content_hash !== sha256(preview),
        preview,
      };
    });
    route('PATCH', '/api/v1/agent-instances/:id/instructions', async (ctx) => {
      const body = await readJSON(ctx.request, 16_384);
      const previous = this.database.getAgent(ctx.params.id);
      invariant(previous, 'WS_NOT_FOUND', 'Agent instance not found.', 404);
      const agent = this.database.updateAgentInstructions(
        ctx.params.id,
        body.instructions ?? '',
        ctx.principal.principal_id,
        { expectedRevision: body.expected_revision },
      );
      const changed = agent.instruction_revision !== previous.instruction_revision;
      if (changed) {
        this.database.audit({
          actorId: ctx.principal.principal_id,
          action: 'agent.instructions.update',
          targetType: 'agent_instance',
          targetId: agent.id,
          projectId: agent.project_id,
          previousState: { instruction_revision: previous.instruction_revision },
          newState: { instruction_revision: agent.instruction_revision },
        });
      }
      return {
        agent_id: agent.id,
        custom_instructions: agent.custom_instructions,
        instruction_revision: agent.instruction_revision,
        changed,
        restart_required: changed && ['ready', 'busy'].includes(agent.state),
      };
    });
    route('POST', '/api/v1/agent-instances/:id:wake', async (ctx) => this.#wakeAgent(ctx.params.id, ctx.principal.principal_id));
    route('POST', '/api/v1/agent-instances/:id:resume-codex', async (ctx) => {
      const body = await readJSON(ctx.request, 16_384);
      let agent = this.database.setAgentCodexSession(ctx.params.id, {
        source: 'user',
        selector: body.use_last ? 'last' : 'id',
        session_id: body.session_id,
      }, ctx.principal.principal_id);
      this.database.audit({
        actorId: ctx.principal.principal_id,
        action: 'agent.codex_session.adopt',
        targetType: 'agent_instance', targetId: agent.id, projectId: agent.project_id,
        newState: { selector: agent.codex_session.selector },
      });
      if (!['stopped', 'failed', 'hibernated'].includes(agent.state)) {
        await this.#stopAgent(agent.id, ctx.principal.principal_id);
      }
      agent = await this.#wakeAgent(agent.id, ctx.principal.principal_id);
      return agent;
    });
    route('DELETE', '/api/v1/agent-instances/:id/codex-session', async (ctx) => {
      const agent = this.database.setAgentCodexSession(ctx.params.id, null, ctx.principal.principal_id);
      this.database.audit({
        actorId: ctx.principal.principal_id,
        action: 'agent.codex_session.detach',
        targetType: 'agent_instance', targetId: agent.id, projectId: agent.project_id,
      });
      return agent;
    });
    route('POST', '/api/v1/agent-instances/:id:stop', async (ctx) => this.#stopAgent(ctx.params.id, ctx.principal.principal_id));
    route('POST', '/api/v1/agent-instances/:id:restart', async (ctx) => {
      await this.#stopAgent(ctx.params.id, ctx.principal.principal_id);
      return this.#wakeAgent(ctx.params.id, ctx.principal.principal_id);
    });
    route('GET', '/api/v1/agent-instances/:id/terminals', async (ctx) => ({
      terminals: this.database.listAgentTerminals(ctx.params.id),
    }));
    route('POST', '/api/v1/agent-instances/:id/terminals', async (ctx) => {
      const body = await readJSON(ctx.request);
      return this.#startShellTab(ctx.params.id, body.label || 'Shell', ctx.principal.principal_id);
    });
    route('POST', '/api/v1/agent-instances/:id/uploads', async (ctx) => {
      const body = await readJSON(ctx.request, 12 * 1024 * 1024);
      const agent = this.database.getAgent(ctx.params.id);
      invariant(agent, 'WS_NOT_FOUND', 'Agent instance not found.', 404);
      invariant(!agent.project_archived_at, 'WS_PROJECT_ARCHIVED', 'Archived projects cannot receive image uploads.', 409);
      const terminal = this.database.getTerminal(body.terminal_id);
      invariant(terminal?.agent_instance_id === agent.id, 'WS_FORBIDDEN', 'Terminal does not belong to this agent.', 403);
      const root = this.database.listAgentRoots(agent.id)[0];
      invariant(root, 'WS_ROOT_NOT_FOUND', 'Agent workspace root is unavailable.', 404);
      invariant(this.broker.isOnline(root.node_id), 'WS_NODE_OFFLINE', 'The workstation is offline; reconnect it before pasting an image.', 503);
      const bytes = decodeImageBase64(body.data_base64);
      const validated = validateImageUpload({
        uploadId: body.upload_id,
        mimeType: body.mime_type,
        bytes,
      });
      const upload = await this.broker.request(root.node_id, 'files.upload-image', {
        root_id: root.node_root_id,
        upload_id: body.upload_id,
        mime_type: validated.mime_type,
        data_base64: body.data_base64,
        sha256: validated.sha256,
      }, { timeoutMs: 60_000 });
      const originalName = String(body.filename || 'clipboard-image')
        .replace(/[\r\n\0]/g, ' ').trim().slice(0, 120) || 'clipboard-image';
      const messageText = [
        '[WebSpider image upload]',
        'The user pasted an image into this agent terminal.',
        `Local path: ${upload.relative_path}`,
        `Original name: ${originalName}`,
        `MIME type: ${upload.mime_type}`,
        `SHA-256: ${upload.sha256}`,
        'Inspect the local image when answering the user.',
      ].join('\n');
      const message = this.database.createMessage({
        threadId: agent.active_thread_id,
        actorId: ctx.principal.principal_id,
        deliveryRole: 'user',
        displaySender: 'You (image paste)',
        contentParts: [{ type: 'text', text: messageText }],
        wakePolicy: 'ensure_running',
        idempotencyKey: `image-upload:${body.upload_id}`,
      });
      this.database.audit({
        actorId: ctx.principal.principal_id,
        action: 'agent.image_upload',
        targetType: 'agent_instance',
        targetId: agent.id,
        projectId: agent.project_id,
        newState: { upload_id: body.upload_id, relative_path: upload.relative_path, mime_type: upload.mime_type, size_bytes: upload.size_bytes },
      });
      if (!message.duplicate) queueMicrotask(() => this.#dispatchMessage(message.message.id).catch((error) => this.#logError(error)));
      return { upload, message: message.message, duplicate: upload.duplicate && message.duplicate };
    });
    route('POST', '/api/v1/terminals/:id:stop', async (ctx) => {
      const terminal = this.database.getTerminal(ctx.params.id);
      invariant(terminal, 'WS_NOT_FOUND', 'Terminal not found.', 404);
      invariant(terminal.kind === 'shell_tab', 'WS_FORBIDDEN', 'Stop the primary agent from its agent controls.', 403);
      if (this.broker.isOnline(terminal.node_id)) {
        await this.broker.request(terminal.node_id, 'terminal.stop', { terminal_id: terminal.id });
      }
      this.database.setTerminalState(terminal.id, 'exited');
      this.database.audit({ actorId: ctx.principal.principal_id, action: 'terminal.stop', targetType: 'terminal', targetId: terminal.id });
      return this.database.getTerminal(terminal.id);
    });
    route('DELETE', '/api/v1/terminals/:id', async (ctx) => {
      const terminal = this.database.getTerminal(ctx.params.id);
      invariant(terminal, 'WS_NOT_FOUND', 'Terminal not found.', 404);
      invariant(['shell_tab', 'task_shell'].includes(terminal.kind), 'WS_FORBIDDEN', 'The primary agent terminal cannot be deleted.', 403);
      const stopProcess = terminal.kind === 'shell_tab' && terminal.state === 'attached';
      if (stopProcess) {
        invariant(this.broker.isOnline(terminal.node_id), 'WS_NODE_OFFLINE', 'The workstation is offline; reconnect it before closing this running shell.', 503);
        await this.broker.request(terminal.node_id, 'terminal.stop', { terminal_id: terminal.id });
        this.database.setTerminalState(terminal.id, 'exited');
      }
      this.database.deleteAuxiliaryTerminal(terminal.id);
      this.database.audit({
        actorId: ctx.principal.principal_id,
        action: 'terminal.delete',
        targetType: 'terminal',
        targetId: terminal.id,
        previousState: { agent_instance_id: terminal.agent_instance_id, label: terminal.label, state: terminal.state },
        newState: { deleted: true, process_stopped: stopProcess, task_continues: terminal.kind === 'task_shell' },
      });
      return { id: terminal.id, deleted: true, process_stopped: stopProcess, task_continues: terminal.kind === 'task_shell' };
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

    route('GET', '/api/v1/tasks', async (ctx) => {
      const activeProjects = new Set(this.database.listProjects().map((project) => project.id));
      return {
        tasks: this.database.listTasks(ctx.url.searchParams.get('project'), ctx.url.searchParams.get('state'))
          .filter((task) => activeProjects.has(task.project_id)),
      };
    });
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
    route('GET', '/api/v1/roots/:id/media-preview', async (ctx) => {
      const relativePath = ctx.url.searchParams.get('path');
      const result = await this.#fileRequest(ctx, 'files.preview-media', {
        path: relativePath, max_bytes: 64 * 1024 * 1024,
      }, 'files.preview_media');
      const bytes = Buffer.from(result.data, 'base64');
      const mimeType = fileMime(result.name);
      invariant(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'application/pdf'].includes(mimeType),
        'WS_PREVIEW_UNSUPPORTED', 'This file type has no inline preview.', 415);
      ctx.response.writeHead(200, {
        'content-type': mimeType,
        'content-length': bytes.length,
        'content-disposition': contentDisposition(result.name).replace(/^attachment/, 'inline'),
        etag: result.etag,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
        'content-security-policy': "default-src 'none'; img-src 'self' data:; frame-ancestors 'self'; sandbox",
      });
      ctx.response.end(bytes);
      return undefined;
    });
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
    const mathJaxFontAsset = /^vendor\/mathjax-fonts\/woff-v2\/[A-Za-z0-9_-]+\.woff$/.test(relative);
    if (!mathJaxFontAsset && !['index.html', 'app.js', 'markdown.js', 'terminal-input.js', 'terminal-output.js', 'terminal-maths.js', 'mathjax-config.js', 'random.js', 'vendor/mathjax.js', 'vendor/mathjax.LICENSE', 'vendor/xterm.mjs', 'vendor/xterm.css', 'vendor/xterm.LICENSE', 'vendor/addon-fit.mjs', 'vendor/addon-fit.LICENSE', 'styles.css', 'manifest.webmanifest', 'icon.svg'].includes(relative)) {
      const body = Buffer.from('Not found');
      response.writeHead(404, { 'content-type': 'text/plain', 'content-length': body.length });
      response.end(body);
      return;
    }
    const filePath = path.join(this.webDir, relative);
    if (!fs.existsSync(filePath)) throw new WebSpiderError('WS_NOT_FOUND', 'Portal asset not found.', 404);
    let bytes = fs.readFileSync(filePath);
    if (relative === 'index.html') {
      bytes = Buffer.from(bytes.toString('utf8').replace('__WEBSPIDER_PORTAL_BUILD__', this.portalBuild));
    }
    response.writeHead(200, {
      'content-type': fileMime(filePath),
      'content-length': bytes.length,
      'cache-control': relative.startsWith('vendor/') ? 'public, max-age=3600' : 'no-cache',
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
    this.portalConnections.add(connection);
    const after = parsePositiveInt(url.searchParams.get('after'), 0);
    for (const event of this.database.listEvents(after, {}, 1_000)) connection.sendJSON({ type: 'EVENT', event });
    const listener = (event) => connection.sendJSON({ type: 'EVENT', event });
    this.database.on('event', listener);
    connection.on('close', () => {
      this.portalConnections.delete(connection);
      this.database.off('event', listener);
    });
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
    this.portalConnections.add(connection);
    connection.once('close', () => this.portalConnections.delete(connection));
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
    const nodeOnlineListener = (event) => {
      if (event.type === 'node.online.v1' && event.scope_id === terminal.node_id) {
        connection.sendJSON({ type: 'RESYNC_REQUIRED', reason: 'node_reconnected' });
      }
    };
    this.database.on('event', nodeOnlineListener);
    let activeLease = null;
    connection.on('close', () => {
      this.broker.off('terminal.output', outputListener);
      this.database.off('event', nodeOnlineListener);
      if (activeLease) this.database.releaseTerminalLease(terminalId, activeLease.id, leasePrincipal);
    });
    let clientAttached = true;
    const inputPipeline = new TerminalInputPipeline({
      sendBatch: async (bytes) => {
        const result = await this.broker.request(terminal.node_id, 'terminal.input', {
          terminal_id: terminalId,
          data: bytes.toString('base64'),
        });
        invariant(Number(result?.accepted_bytes) === bytes.length,
          'WS_TERMINAL_INPUT_UNCERTAIN', 'The node did not acknowledge every terminal input byte.', 502);
        return result;
      },
      acknowledge: (result, frames, acceptedBytes) => {
        if (!clientAttached) return;
        const latest = frames.at(-1) || {};
        connection.sendJSON({
          type: 'INPUT_ACK',
          lease: latest.lease,
          input_sequence: latest.input_sequence,
          accepted_bytes: acceptedBytes,
          result,
        });
      },
      fail: (error) => {
        if (!clientAttached) return;
        connection.sendJSON({
          type: 'ERROR',
          code: error.code || 'WS_TERMINAL_INPUT_UNCERTAIN',
          message: `${error.message} Further terminal input was stopped to avoid loss or reordering.`,
        });
      },
    });
    connection.once('close', () => { clientAttached = false; });
    let controlQueue = Promise.resolve();
    connection.on('text', (text) => {
      let frame;
      try { frame = JSON.parse(text); } catch { connection.sendJSON({ type: 'ERROR', code: 'WS_INVALID_JSON' }); return; }
      try {
        if (frame.type === 'LEASE_REQUEST') {
          const lease = this.database.acquireTerminalLease(terminalId, leasePrincipal);
          activeLease = lease;
          connection.sendJSON({ type: 'LEASE_GRANTED', lease });
          return;
        }
        if (frame.type === 'INPUT') {
          const lease = this.database.validateTerminalLease(terminalId, frame.lease_id, frame.lease_epoch, leasePrincipal);
          const bytes = Buffer.from(String(frame.data || ''), 'base64');
          inputPipeline.enqueue(bytes, { lease, input_sequence: Number(frame.input_sequence || 0) });
          return;
        }
        if (frame.type === 'HEARTBEAT') {
          const lease = this.database.validateTerminalLease(terminalId, frame.lease_id, frame.lease_epoch, leasePrincipal);
          connection.sendJSON({ type: 'HEARTBEAT_ACK', lease });
          return;
        }
        if (frame.type === 'RESIZE') {
          controlQueue = controlQueue.then(async () => {
            const lease = this.database.validateTerminalLease(terminalId, frame.lease_id, frame.lease_epoch, leasePrincipal);
            const result = await this.broker.request(terminal.node_id, 'terminal.resize', {
              terminal_id: terminalId,
              columns: frame.columns,
              rows: frame.rows,
            });
            connection.sendJSON({ type: 'RESIZE_ACK', lease, result });
          }).catch((error) => connection.sendJSON({ type: 'ERROR', code: error.code || 'WS_INTERNAL', message: error.message }));
          return;
        }
      } catch (error) {
        connection.sendJSON({ type: 'ERROR', code: error.code || 'WS_INTERNAL', message: error.message });
      }
    });
    connection.sendJSON({ type: 'ATTACHED', terminal, mode: 'watch', attachment_id: attachmentId });
    this.broker.request(terminal.node_id, 'terminal.snapshot', { terminal_id: terminalId, max_bytes: 200_000 })
      .then((snapshot) => connection.sendJSON({ type: 'SNAPSHOT', ...snapshot }))
      .catch((error) => connection.sendJSON({ type: 'ERROR', code: error.code, message: error.message }));
  }

  #createWorkerAgent({ projectId, nodeId, nodeRootId, title, actor }) {
    const project = this.database.getProject(projectId);
    const node = this.database.getNode(nodeId);
    invariant(project, 'WS_NOT_FOUND', 'Project not found.', 404);
    invariant(node, 'WS_NOT_FOUND', 'Node not found.', 404);
    const roots = Array.isArray(node.capabilities?.roots) ? node.capabilities.roots : [];
    const root = roots.find((candidate) => candidate.id === nodeRootId)
      || (node.capabilities?.root_ids || []).includes(nodeRootId) && { id: nodeRootId, name: 'workspace' };
    invariant(root, 'WS_ROOT_NOT_FOUND', 'The selected node has not registered that workspace root.', 404);
    invariant(node.capabilities?.codex !== false, 'WS_ADAPTER_UNAVAILABLE', 'Codex is not available on the selected node.', 409);
    const profileId = makeId('apf');
    const profile = this.database.createProfile({
      id: profileId,
      name: `Codex ${node.display_name} ${profileId.slice(-6)}`,
      adapterKind: 'pty',
      executable: 'codex',
      arguments: agentLaunchArguments('codex'),
      restartPolicy: { mode: 'on_failure', max_attempts: 3 },
    }, actor);
    const agent = this.database.createAgent({
      profileId: profile.id,
      projectId: project.id,
      nodeId: node.id,
      title: title?.trim() || project.name,
      orchestrationRole: 'worker',
      resumability: 'detached_process',
      root: {
        node_root_id: root.id,
        logical_name: root.name || 'workspace',
        access_mode: 'read_write',
        symlink_policy: 'no_symlinks',
        mount_policy: 'allow_nested',
      },
    }, actor);
    this.database.audit({
      actorId: actor,
      action: 'agent.create',
      targetType: 'agent_instance',
      targetId: agent.id,
      projectId: project.id,
      newState: agent,
    });
    return agent;
  }

  async #startShellTab(agentId, label, actor) {
    const agent = this.database.getAgent(agentId);
    invariant(agent, 'WS_NOT_FOUND', 'Agent instance not found.', 404);
    invariant(!agent.project_archived_at, 'WS_PROJECT_ARCHIVED', 'Restore the project before starting a shell.', 409);
    const node = this.database.getNode(agent.node_id);
    invariant(node?.status === 'online' && this.broker.isOnline(agent.node_id), 'WS_NODE_OFFLINE', 'Agent node is offline.', 503);
    const root = this.database.listAgentRoots(agent.id)[0];
    invariant(root, 'WS_ROOT_NOT_FOUND', 'Agent has no active workspace root.', 404);
    const shell = typeof node.capabilities?.shell === 'string' && node.capabilities.shell.startsWith('/')
      ? node.capabilities.shell
      : node.labels?.os === 'darwin' ? '/bin/zsh' : '/bin/bash';
    const terminal = this.database.createInteractiveTerminal(agent.id, label);
    try {
      await this.broker.request(agent.node_id, 'terminal.start-shell', {
        agent_instance_id: agent.id,
        terminal_id: terminal.id,
        root_id: root.node_root_id,
        argv: [shell, '-l'],
        environment: {},
      });
      this.database.setTerminalState(terminal.id, 'attached');
      this.database.audit({ actorId: actor, action: 'terminal.create', targetType: 'terminal', targetId: terminal.id, projectId: agent.project_id, newState: { label } });
      return this.database.getTerminal(terminal.id);
    } catch (error) {
      this.database.setTerminalState(terminal.id, 'exited');
      throw error;
    }
  }

  async #wakeAgent(agentId, actor) {
    let agent = this.database.getAgent(agentId);
    invariant(agent, 'WS_NOT_FOUND', 'Agent instance not found.', 404);
    invariant(!agent.project_archived_at, 'WS_PROJECT_ARCHIVED', 'Restore the project before starting its agent.', 409);
    if (['ready', 'busy'].includes(agent.state)) return agent;
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
      const renderedInstructions = renderProjectInstructions(project, {
        role: agent.orchestration_role,
        customInstructions: agent.custom_instructions,
      });
      const policySnapshot = this.database.createPolicySnapshot({
        projectId: project.id,
        agentInstanceId: agent.id,
        agentRole: agent.orchestration_role,
        systemPolicyRevision: project.system_policy_revision,
        policyRevision: project.policy_revision,
        policy: project.policy,
        agentInstructions: agent.custom_instructions,
        agentInstructionRevision: agent.instruction_revision,
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
        controlToken = randomToken('wsa');
        const record = this.database.issueAgentControlToken(agent.id, controlToken, WORKER_AGENT_CONTROL_SCOPES);
        agentControl = {
          url: new URL('/api/v1/agent-control', this.url).href,
          token: controlToken,
          scopes: record.scopes,
          expires_at: record.expires_at,
        };
      }
      const started = await this.broker.request(agent.node_id, 'process.start-agent', {
        agent_instance_id: agent.id,
        terminal_id: agent.terminal_id,
        root_id: root.node_root_id,
        argv: [profile.executable, ...agentLaunchArguments(profile.executable, profile.arguments)],
        environment: profile.environment,
        policy_snapshot: policySnapshot,
        agent_control: agentControl,
        codex_session: agent.codex_session,
      }, { timeoutMs: 30_000 });
      if (started?.runtime?.id) this.agentRuntimes.set(agent.id, started.runtime.id);
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
    const agents = this.database.listAgents().filter((agent) => agent.node_id === nodeId);
    for (const agent of agents) this.agentRuntimes.delete(agent.id);
    const runningAgentRuntimes = runtimeInventory
      .filter((runtime) => runtime.kind === 'agent' && runtime.state === 'running' && runtime.agent_instance_id);
    const runningAgents = new Set(runningAgentRuntimes.map((runtime) => runtime.agent_instance_id));
    for (const runtime of runningAgentRuntimes) this.agentRuntimes.set(runtime.agent_instance_id, runtime.id);
    for (let agent of agents) {
      if (agent.project_archived_at) {
        if (runningAgents.has(agent.id)) {
          try {
            await this.broker.request(agent.node_id, 'process.stop-agent', { agent_instance_id: agent.id });
          } catch (error) {
            this.#logError(error);
          }
        }
        this.database.setTerminalState(agent.terminal_id, 'exited');
        if (agent.state !== 'stopped') this.database.setAgentState(agent.id, 'stopped', 'hub:archive-reconciler');
        continue;
      }
      if (runningAgents.has(agent.id)) {
        this.database.setTerminalState(agent.terminal_id, 'attached');
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
      if (previousState === 'starting') {
        try {
          await this.#wakeAgent(agent.id, 'hub:initial-worker-start');
        } catch (error) {
          this.#logError(error);
        }
        continue;
      }
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
        document_root_id: message.content_parts.some((part) => part.type === 'document')
          ? this.database.listAgentRoots(agent.id)[0]?.node_root_id
          : undefined,
        delivery_context: {
          message_timestamp_utc: message.created_at,
          delivered_at_utc: nowISO(),
          previous_message_timestamp_utc: previous?.created_at || null,
          elapsed_since_previous_message_ms: elapsedMs,
          source: message.display_sender,
          account_quota: quota,
        },
      }, { idempotencyKey: message.id });
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

  async #drainTasks(nodeId) {
    for (const task of this.database.listTasks().filter((candidate) => candidate.type === 'command'
      && ['pending', 'runnable'].includes(candidate.state))) {
      const agent = task.assigned_agent_instance_id ? this.database.getAgent(task.assigned_agent_instance_id) : null;
      if ((task.node_id || agent?.node_id) !== nodeId) continue;
      try { await this.#scheduleTask(task.id); } catch (error) { this.#logError(error); }
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
    const terminal = this.database.createTaskTerminal(agent.id, task.title);
    const epoch = this.broker.connectionEpoch(nodeId);
    this.database.createTaskAttempt(task.id, nodeId, agent.id, epoch, randomToken('lease'));
    await this.broker.request(nodeId, 'task.start', {
      task_id: task.id,
      agent_instance_id: agent.id,
      terminal_id: terminal.id,
      root_id: root.node_root_id,
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
      if (runtime.agentInstanceId && runtime.kind === 'agent') {
        this.agentRuntimes.set(runtime.agentInstanceId, runtime.id);
        this.database.setAgentState(runtime.agentInstanceId, 'ready', `node:${nodeId}`);
      }
      this.database.appendEvent(runtime.kind === 'task' ? 'task' : 'agent', runtime.taskId || runtime.agentInstanceId,
        'runtime.started.v1', `node:${nodeId}`, runtime.id, { ...runtime, node_id: nodeId, connection_epoch: epoch });
      return;
    }
    if (['process.completed', 'process.lost'].includes(event.type)) {
      const currentAgentRuntime = runtime.kind === 'agent' && runtime.agentInstanceId
        ? this.agentRuntimes.get(runtime.agentInstanceId)
        : null;
      const staleAgentRuntime = Boolean(currentAgentRuntime && currentAgentRuntime !== runtime.id);
      if (runtime.terminalId && !staleAgentRuntime) this.database.setTerminalState(runtime.terminalId, 'exited');
      if (runtime.kind === 'agent' && runtime.agentInstanceId) {
        if (!staleAgentRuntime) {
          this.agentRuntimes.delete(runtime.agentInstanceId);
          this.database.revokeAgentControlTokens(runtime.agentInstanceId);
          this.database.setAgentState(runtime.agentInstanceId, data.exit_status === 0 ? 'stopped' : 'failed', `node:${nodeId}`, { exit_status: data.exit_status });
        }
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
        if ((task.specification.notify_target || (task.specification.notify_master ? 'master' : 'none')) !== 'none') {
          await this.#notifyTaskCompletion(task, result);
        }
      }
      this.database.appendEvent(runtime.kind === 'task' ? 'task' : 'agent', runtime.taskId || runtime.agentInstanceId,
        event.type === 'process.completed' ? 'runtime.completed.v1' : 'runtime.lost.v1', `node:${nodeId}`, runtime.id, {
          node_id: nodeId,
          connection_epoch: epoch,
          exit_status: data.exit_status,
          stale_runtime: staleAgentRuntime,
          current_runtime_id: staleAgentRuntime ? currentAgentRuntime : undefined,
        });
    }
  }

  #masterAgent() {
    return this.database.getAgent('agt_master')
      || this.database.listAgents().find((agent) => agent.orchestration_role === 'main');
  }

  #hookTarget(sourceAgent, target) {
    return target === 'master' ? this.#masterAgent() : sourceAgent;
  }

  async #notifyTaskCompletion(task, result) {
    const source = this.database.getAgent(task.assigned_agent_instance_id);
    const notifyTarget = task.specification.notify_target
      || (task.specification.notify_master ? 'master' : 'none');
    const target = this.#hookTarget(source, notifyTarget);
    if (!source || !target || notifyTarget === 'none') return;
    const custom = task.specification.completion_message;
    const text = [
      '[WebSpider task completion]',
      `Task ID: ${task.id}`,
      `Title: ${task.title}`,
      `Status: ${result.status}`,
      `Ran on: ${source.title || source.id} (${source.id})`,
      custom ? `Hook message: ${custom}` : '',
      `Result: ${result.summary}`,
    ].filter(Boolean).join('\n');
    const created = this.database.createMessage({
      threadId: target.active_thread_id,
      actorId: `trigger:task-completion:${task.id}`,
      deliveryRole: 'user',
      displaySender: `WebSpider task hook ${task.id}`,
      contentParts: [{ type: 'text', text }],
      wakePolicy: 'ensure_running',
      idempotencyKey: `task:${task.id}:completed:${target.id}`,
      traceId: makeId('trc'),
      hopCount: 1,
    });
    if (!created.duplicate) await this.#dispatchMessage(created.message.id);
  }

  #restoreReminders() {
    for (const task of this.database.listTasks().filter((candidate) => candidate.type === 'reminder'
      && ['pending', 'runnable'].includes(candidate.state))) this.#armReminder(task);
  }

  #armReminder(task) {
    const prior = this.reminderTimers.get(task.id);
    if (prior) clearTimeout(prior);
    this.reminderTimers.delete(task.id);
    if (task.type !== 'reminder' || !['pending', 'runnable'].includes(task.state)) return;
    const nextRun = Date.parse(task.specification.next_run_at);
    if (!Number.isFinite(nextRun)) {
      this.database.setTaskState(task.id, 'failed', {
        status: 'failed', summary: 'Reminder has an invalid next_run_at timestamp.',
      }, 'hub:reminders');
      return;
    }
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextRun - Date.now()));
    const timer = setTimeout(() => {
      this.reminderTimers.delete(task.id);
      const current = this.database.getTask(task.id);
      if (current && Date.parse(current.specification.next_run_at) > Date.now()) {
        this.#armReminder(current);
        return;
      }
      this.#fireReminder(task.id).catch((error) => this.#logError(error));
    }, delay);
    timer.unref?.();
    this.reminderTimers.set(task.id, timer);
  }

  async #fireReminder(taskId) {
    let task = this.database.getTask(taskId);
    if (!task || task.type !== 'reminder' || !['pending', 'runnable'].includes(task.state)) return;
    const source = this.database.getAgent(task.assigned_agent_instance_id);
    const target = this.#hookTarget(source, task.specification.delivery_target || 'self');
    if (!source || !target) {
      this.database.setTaskState(task.id, 'failed', {
        status: 'failed', summary: 'Reminder source or destination agent no longer exists.',
      }, 'hub:reminders');
      return;
    }
    const runCount = Number(task.specification.run_count || 0) + 1;
    const created = this.database.createMessage({
      threadId: target.active_thread_id,
      actorId: `trigger:reminder:${task.id}`,
      deliveryRole: 'user',
      displaySender: `WebSpider reminder ${task.id}`,
      contentParts: [{ type: 'text', text: [
        '[WebSpider scheduled reminder]',
        `Reminder ID: ${task.id}`,
        `Title: ${task.title}`,
        `Run: ${runCount}`,
        `Scheduled by: ${source.title || source.id} (${source.id})`,
        `Message: ${task.specification.message}`,
      ].join('\n') }],
      wakePolicy: 'ensure_running',
      idempotencyKey: `reminder:${task.id}:run:${runCount}:${target.id}`,
      traceId: makeId('trc'),
      hopCount: 1,
    });
    const everySeconds = task.specification.repeat_every_seconds;
    const maxRuns = task.specification.max_runs;
    if (everySeconds && (maxRuns == null || runCount < maxRuns)) {
      task = this.database.updateTaskSpecification(task.id, {
        ...task.specification,
        run_count: runCount,
        last_run_at: nowISO(),
        next_run_at: new Date(Date.now() + Number(everySeconds) * 1000).toISOString(),
      }, 'hub:reminders');
      this.#armReminder(task);
    } else {
      this.database.updateTaskSpecification(task.id, {
        ...task.specification,
        run_count: runCount,
        last_run_at: nowISO(),
      }, 'hub:reminders');
      this.database.setTaskState(task.id, 'succeeded', {
        status: 'succeeded', summary: `Delivered ${runCount} reminder message${runCount === 1 ? '' : 's'}.`,
      }, 'hub:reminders');
    }
    if (created.message.delivery?.state !== 'adapter_accepted') await this.#dispatchMessage(created.message.id);
  }

  async #fileRequest(ctx, command, payload, auditAction) {
    const root = this.database.getRoot(ctx.params.id);
    invariant(root && !root.revoked_at, 'WS_ROOT_NOT_FOUND', 'Workspace root not found.', 404);
    if (['files.preview', 'files.preview-media'].includes(command)) invariant(root.allow_preview, 'WS_FORBIDDEN', 'Preview is disabled for this root.', 403);
    if (command === 'files.download') invariant(root.allow_download, 'WS_FORBIDDEN', 'Download is disabled for this root.', 403);
    if (command === 'files.search') invariant(root.allow_search, 'WS_FORBIDDEN', 'Search is disabled for this root.', 403);
    let decision = 'allowed';
    try {
      const result = await this.broker.request(root.node_id, command, { root_id: root.node_root_id, ...payload });
      this.database.audit({ actorId: ctx.principal.principal_id, action: auditAction, targetType: 'workspace_root', targetId: root.id, projectId: root.project_id, decision, newState: { relative_path: payload.path || '', bytes: result?.size } });
      return result;
    } catch (error) {
      decision = 'denied';
      this.database.audit({ actorId: ctx.principal.principal_id, action: auditAction, targetType: 'workspace_root', targetId: root.id, projectId: root.project_id, decision, newState: { relative_path: payload.path || '', error: error.code } });
      throw error;
    }
  }

  #noteTitle(value) {
    const title = String(value || '').trim();
    invariant(title.length > 0 && title.length <= 120, 'WS_VALIDATION', 'Note title must be between 1 and 120 characters.');
    return title;
  }

  #noteVisibility(value = 'private') {
    invariant(['private', 'master'].includes(value), 'WS_VALIDATION', 'Note visibility must be private or master.');
    return value;
  }

  #noteContent(value = '') {
    invariant(typeof value === 'string', 'WS_VALIDATION', 'Note content must be plain text.');
    invariant(Buffer.byteLength(value, 'utf8') <= 1_048_576, 'WS_REQUEST_TOO_LARGE', 'A note cannot exceed 1 MiB.', 413);
    return value;
  }

  #notePath(filename) {
    invariant(/^nte_[A-Za-z0-9_-]+\.txt$/.test(filename), 'WS_NOTE_STORAGE_INVALID', 'Note storage filename is invalid.', 500);
    return path.join(this.notesDir, filename);
  }

  #writeNoteFile(filename, content) {
    const destination = this.#notePath(filename);
    const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(temporary, destination);
      fs.chmodSync(destination, 0o600);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  #readNoteFile(filename) {
    const filenamePath = this.#notePath(filename);
    const stat = fs.lstatSync(filenamePath, { throwIfNoEntry: false });
    invariant(stat?.isFile() && !stat.isSymbolicLink(), 'WS_NOTE_STORAGE_MISSING', 'Note text file is missing or invalid.', 500);
    invariant(stat.size <= 1_048_576, 'WS_REQUEST_TOO_LARGE', 'The note text file exceeds 1 MiB.', 413);
    return fs.readFileSync(filenamePath, 'utf8');
  }

  #noteWithContent(id) {
    const note = this.database.getNote(id);
    invariant(note, 'WS_NOT_FOUND', 'Note not found.', 404);
    return { ...note, content: this.#readNoteFile(note.filename) };
  }

  #logError(error) {
    const value = error?.stack || error?.message || String(error);
    process.stderr.write(`[webspider] ${value}\n`);
  }
}
