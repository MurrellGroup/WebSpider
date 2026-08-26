import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { makeId, nowISO } from '../lib/ids.js';
import { WebSpiderError, invariant } from '../lib/errors.js';
import { sha256 } from '../lib/security.js';
import { createDefaultProjectPolicy, diffProjectPolicy, mergeProjectPolicy } from '../lib/project-policy.js';

const AGENT_CONTROL_ALLOWED_SCOPES = new Set([
  'policy:read',
  'policy:write:project',
  'policy:write:system',
  'usage:read',
  'usage:write',
  'agents:read',
  'messages:write',
  'prompts:answer',
  'documents:write',
  'files:transfer',
  'tasks:read',
  'tasks:write',
  'reminders:read:self',
  'reminders:write:self',
  'portfolio:read',
  'notes:read:visible',
  'status:write:self',
  'updates:write:self',
]);

const NO_EXPIRY_TIMESTAMP = '9999-12-31T23:59:59.999Z';
const AGENT_CONTROL_LIFECYCLE_MIGRATION = 1;
const AGENT_CONTROL_ACTIVE_STATES = new Set(['starting', 'ready', 'busy']);

function decode(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function encode(value) {
  return JSON.stringify(value ?? null);
}

function bool(value) {
  return Boolean(value);
}

function systemPolicyRow(row) {
  if (!row) return null;
  const overrides = decode(row.policy_json, {});
  return {
    id: row.id,
    revision: Number(row.revision || 1),
    overrides,
    policy: mergeProjectPolicy(createDefaultProjectPolicy(), overrides),
    updated_at: row.updated_at,
  };
}

function projectRow(row, systemPolicy = { revision: 1, overrides: {} }) {
  if (!row) return null;
  const labels = decode(row.labels_json, {});
  const contextualDefaults = createDefaultProjectPolicy({
    kind: labels.project_kind || 'academic',
    signals: labels.inference_signals || [],
  });
  const policyOverrides = decode(row.policy_overrides_json, {});
  const policy = mergeProjectPolicy(mergeProjectPolicy(
    contextualDefaults,
    systemPolicy.overrides || {},
  ), policyOverrides);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    labels,
    policy,
    policy_overrides: policyOverrides,
    policy_revision: Number(row.policy_revision || 1),
    system_policy_revision: Number(systemPolicy.revision || 1),
    archived_at: row.archived_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function nodeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    display_name: row.display_name,
    status: row.status,
    connection_epoch: row.connection_epoch,
    labels: decode(row.labels_json, {}),
    capabilities: decode(row.capabilities_json, {}),
    adapter_inventory: decode(row.adapter_inventory_json, []),
    last_seen_at: row.last_seen_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
  };
}

function profileRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    adapter_kind: row.adapter_kind,
    executable: row.executable,
    arguments: decode(row.arguments_json, []),
    environment: decode(row.environment_json, {}),
    restart_policy: decode(row.restart_policy_json, { mode: 'on_failure', max_attempts: 3 }),
    created_at: row.created_at,
  };
}

function agentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    profile_id: row.profile_id,
    profile_name: row.profile_name,
    project_id: row.project_id,
    project_name: row.project_name,
    project_archived_at: row.project_archived_at || null,
    node_id: row.node_id,
    node_name: row.node_name,
    title: row.title || row.profile_name,
    task_id: row.task_id,
    active_thread_id: row.active_thread_id,
    orchestration_role: row.orchestration_role || 'worker',
    can_edit_behavior: row.orchestration_role === 'main',
    state: row.state,
    resumability: row.resumability,
    current_turn_id: row.current_turn_id,
    created_at: row.created_at,
    last_activity_at: row.last_activity_at,
    stopped_at: row.stopped_at,
    work_status: row.work_status || 'idle',
    status_summary: row.status_summary || '',
    status_updated_at: row.status_updated_at,
    custom_instructions: row.custom_instructions || '',
    instruction_revision: Number(row.instruction_revision || 1),
    codex_session: decode(row.codex_session_json),
    resume_managed_once: bool(row.resume_managed_once),
    recovery_pending: bool(row.recovery_pending),
    codex_capable: path.basename(String(row.profile_executable || '')).toLowerCase().includes('codex'),
  };
}

function messageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    thread_id: row.thread_id,
    sequence: row.sequence,
    task_id: row.task_id,
    authenticated_actor_id: row.authenticated_actor_id,
    delivery_role: row.delivery_role,
    display_sender: row.display_sender,
    content_parts: decode(row.content_parts_json, []),
    reply_to_message_id: row.reply_to_message_id,
    trace_id: row.trace_id,
    hop_count: row.hop_count,
    priority: row.priority,
    wake_policy: row.wake_policy,
    idempotency_key: row.idempotency_key,
    created_at: row.created_at,
    expires_at: row.expires_at,
    delivery: row.delivery_state ? {
      state: row.delivery_state,
      delivered_at: row.delivered_at,
      failure_reason: row.failure_reason,
    } : undefined,
  };
}

function taskRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    parent_task_id: row.parent_task_id,
    type: row.type,
    title: row.title,
    specification: decode(row.specification_json, {}),
    desired_agent_profile_id: row.desired_agent_profile_id,
    assigned_agent_instance_id: row.assigned_agent_instance_id,
    node_id: row.node_id,
    priority: row.priority,
    state: row.state,
    retry_policy: decode(row.retry_policy_json, {}),
    result: decode(row.result_json, null),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function eventRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    global_sequence: row.global_sequence,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    scope_sequence: row.scope_sequence,
    type: row.type,
    version: row.version,
    actor_id: row.actor_id,
    subject_id: row.subject_id,
    trace_id: row.trace_id,
    hub_timestamp: row.hub_timestamp,
    payload: decode(row.payload_json, {}),
  };
}

function accountUsageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    agent_instance_id: row.agent_instance_id,
    project_id: row.project_id,
    source: row.source,
    observed_at: row.observed_at,
    rate_limits: decode(row.rate_limits_json, []),
    token_activity: decode(row.token_activity_json, null),
    created_at: row.created_at,
  };
}

function noteRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    filename: row.filename,
    visibility: row.visibility,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const ACTIVE_FLEET_UPDATE_STATES = [
  'waiting_for_agents',
  'waiting_for_tasks',
  'waiting_for_nodes',
  'stopping_agents',
  'updating_nodes',
  'updating_hub',
  'resuming_agents',
];

function fleetUpdateRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    target_version: row.target_version,
    state: row.state,
    requested_by: row.requested_by,
    node_ids: decode(row.node_ids_json, []),
    agent_ids: decode(row.agent_ids_json, []),
    ready_agents: decode(row.ready_agents_json, {}),
    allowed_task_ids: decode(row.allowed_task_ids_json, []),
    node_status: decode(row.node_status_json, {}),
    error: row.error || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
  };
}

export class HubDatabase extends EventEmitter {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS system_policies (
        id TEXT PRIMARY KEY,
        policy_json TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        labels_json TEXT NOT NULL DEFAULT '{}',
        policy_json TEXT NOT NULL DEFAULT '{}',
        policy_overrides_json TEXT NOT NULL DEFAULT '{}',
        policy_revision INTEGER NOT NULL DEFAULT 1,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS policy_snapshots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        agent_instance_id TEXT REFERENCES agent_instances(id),
        agent_role TEXT NOT NULL DEFAULT 'worker',
        system_policy_revision INTEGER NOT NULL DEFAULT 1,
        policy_revision INTEGER NOT NULL,
        policy_json TEXT NOT NULL,
        agent_instructions TEXT NOT NULL DEFAULT '',
        agent_instruction_revision INTEGER NOT NULL DEFAULT 1,
        rendered_instructions TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        credential_version INTEGER NOT NULL DEFAULT 1,
        connection_epoch INTEGER NOT NULL DEFAULT 0,
        labels_json TEXT NOT NULL DEFAULT '{}',
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        adapter_inventory_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'offline',
        last_seen_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS join_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS agent_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        adapter_kind TEXT NOT NULL,
        executable TEXT NOT NULL,
        arguments_json TEXT NOT NULL DEFAULT '[]',
        environment_json TEXT NOT NULL DEFAULT '{}',
        restart_policy_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_instances (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        node_id TEXT NOT NULL REFERENCES nodes(id),
        task_id TEXT,
        active_thread_id TEXT,
        orchestration_role TEXT NOT NULL DEFAULT 'worker',
        state TEXT NOT NULL,
        resumability TEXT NOT NULL,
        current_turn_id TEXT,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        stopped_at TEXT,
        work_status TEXT NOT NULL DEFAULT 'idle',
        status_summary TEXT NOT NULL DEFAULT '',
        status_updated_at TEXT,
        custom_instructions TEXT NOT NULL DEFAULT '',
        instruction_revision INTEGER NOT NULL DEFAULT 1,
        codex_session_json TEXT,
        resume_managed_once INTEGER NOT NULL DEFAULT 0,
        recovery_pending INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS agent_control_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        agent_instance_id TEXT NOT NULL REFERENCES agent_instances(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        scopes_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS account_usage_snapshots (
        id TEXT PRIMARY KEY,
        agent_instance_id TEXT NOT NULL REFERENCES agent_instances(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        source TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        rate_limits_json TEXT NOT NULL DEFAULT '[]',
        token_activity_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        primary_agent_instance_id TEXT NOT NULL REFERENCES agent_instances(id),
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        last_message_sequence INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_roots (
        id TEXT PRIMARY KEY,
        agent_instance_id TEXT NOT NULL REFERENCES agent_instances(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        node_id TEXT NOT NULL REFERENCES nodes(id),
        logical_name TEXT NOT NULL,
        access_mode TEXT NOT NULL,
        expose_in_portal INTEGER NOT NULL,
        allow_download INTEGER NOT NULL,
        allow_search INTEGER NOT NULL,
        allow_preview INTEGER NOT NULL,
        symlink_policy TEXT NOT NULL,
        mount_policy TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        node_root_id TEXT,
        UNIQUE(agent_instance_id, logical_name)
      );

      CREATE TABLE IF NOT EXISTS terminal_sessions (
        id TEXT PRIMARY KEY,
        agent_instance_id TEXT NOT NULL REFERENCES agent_instances(id),
        node_id TEXT NOT NULL REFERENCES nodes(id),
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        canonical_columns INTEGER NOT NULL DEFAULT 120,
        canonical_rows INTEGER NOT NULL DEFAULT 36,
        created_at TEXT NOT NULL,
        exited_at TEXT,
        label TEXT NOT NULL DEFAULT 'Terminal'
      );

      CREATE TABLE IF NOT EXISTS terminal_leases (
        id TEXT PRIMARY KEY,
        terminal_id TEXT NOT NULL UNIQUE REFERENCES terminal_sessions(id),
        principal_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id),
        sequence INTEGER NOT NULL,
        task_id TEXT,
        authenticated_actor_id TEXT NOT NULL,
        delivery_role TEXT NOT NULL,
        display_sender TEXT NOT NULL,
        content_parts_json TEXT NOT NULL,
        reply_to_message_id TEXT,
        trace_id TEXT NOT NULL,
        hop_count INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 0,
        wake_policy TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        UNIQUE(thread_id, sequence),
        UNIQUE(thread_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS message_deliveries (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id),
        recipient_agent_instance_id TEXT NOT NULL REFERENCES agent_instances(id),
        state TEXT NOT NULL,
        node_command_id TEXT,
        adapter_receipt_json TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        delivered_at TEXT,
        failed_at TEXT,
        failure_reason TEXT,
        UNIQUE(message_id, recipient_agent_instance_id)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        parent_task_id TEXT REFERENCES tasks(id),
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        specification_json TEXT NOT NULL,
        desired_agent_profile_id TEXT,
        assigned_agent_instance_id TEXT,
        node_id TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        retry_policy_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_attempts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt_number INTEGER NOT NULL,
        node_id TEXT NOT NULL REFERENCES nodes(id),
        agent_instance_id TEXT,
        lease_token TEXT NOT NULL,
        connection_epoch INTEGER NOT NULL,
        state TEXT NOT NULL,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        completed_at TEXT,
        exit_status INTEGER,
        failure_kind TEXT,
        UNIQUE(task_id, attempt_number)
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        task_id TEXT,
        agent_instance_id TEXT,
        kind TEXT NOT NULL,
        logical_name TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        storage_locator TEXT NOT NULL,
        source_root_id TEXT,
        source_relative_path TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attention_items (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        agent_instance_id TEXT,
        task_id TEXT,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL,
        actions_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        global_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        scope_sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        actor_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        hub_timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        connection_epoch INTEGER,
        command_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        acknowledged_at TEXT,
        result_json TEXT,
        failure_reason TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        project_id TEXT,
        decision TEXT NOT NULL,
        previous_state_json TEXT,
        new_state_json TEXT,
        trace_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS browser_sessions (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL UNIQUE,
        principal_id TEXT NOT NULL,
        role TEXT NOT NULL,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        filename TEXT NOT NULL UNIQUE,
        visibility TEXT NOT NULL DEFAULT 'private',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fleet_updates (
        id TEXT PRIMARY KEY,
        target_version TEXT NOT NULL,
        state TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        node_ids_json TEXT NOT NULL DEFAULT '[]',
        agent_ids_json TEXT NOT NULL DEFAULT '[]',
        ready_agents_json TEXT NOT NULL DEFAULT '{}',
        allowed_task_ids_json TEXT NOT NULL DEFAULT '[]',
        node_status_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS idempotency (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(scope, key)
      );

      CREATE INDEX IF NOT EXISTS idx_events_scope ON events(scope_type, scope_id, global_sequence);
      CREATE INDEX IF NOT EXISTS idx_events_time ON events(hub_timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_agents_project ON agent_instances(project_id, state);
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, state, created_at);
      CREATE INDEX IF NOT EXISTS idx_outbox_node ON outbox(node_id, state, created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_policy_snapshots_agent ON policy_snapshots(agent_instance_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_control_tokens_agent ON agent_control_tokens(agent_instance_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_account_usage_observed ON account_usage_snapshots(observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_fleet_updates_created ON fleet_updates(created_at DESC);
    `);
    const projectColumns = new Set(this.db.prepare('PRAGMA table_info(projects)').all().map((column) => column.name));
    if (!projectColumns.has('policy_json')) this.db.exec("ALTER TABLE projects ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}'");
    if (!projectColumns.has('policy_revision')) this.db.exec('ALTER TABLE projects ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 1');
    if (!projectColumns.has('archived_at')) this.db.exec('ALTER TABLE projects ADD COLUMN archived_at TEXT');
    if (!projectColumns.has('policy_overrides_json')) {
      this.db.exec("ALTER TABLE projects ADD COLUMN policy_overrides_json TEXT NOT NULL DEFAULT '{}'");
      const select = this.db.prepare('SELECT id, labels_json, policy_json FROM projects');
      const update = this.db.prepare('UPDATE projects SET policy_overrides_json = ? WHERE id = ?');
      for (const row of select.all()) {
        const labels = decode(row.labels_json, {});
        const base = createDefaultProjectPolicy({
          kind: labels.project_kind || 'academic',
          signals: labels.inference_signals || [],
        });
        const legacy = mergeProjectPolicy(base, decode(row.policy_json, {}));
        const overrides = diffProjectPolicy(base, legacy) || {};
        delete overrides.schema_version;
        update.run(encode(overrides), row.id);
      }
    }
    const agentColumns = new Set(this.db.prepare('PRAGMA table_info(agent_instances)').all().map((column) => column.name));
    if (!agentColumns.has('orchestration_role')) this.db.exec("ALTER TABLE agent_instances ADD COLUMN orchestration_role TEXT NOT NULL DEFAULT 'worker'");
    if (!agentColumns.has('work_status')) this.db.exec("ALTER TABLE agent_instances ADD COLUMN work_status TEXT NOT NULL DEFAULT 'idle'");
    if (!agentColumns.has('status_summary')) this.db.exec("ALTER TABLE agent_instances ADD COLUMN status_summary TEXT NOT NULL DEFAULT ''");
    if (!agentColumns.has('status_updated_at')) this.db.exec('ALTER TABLE agent_instances ADD COLUMN status_updated_at TEXT');
    if (!agentColumns.has('custom_instructions')) this.db.exec("ALTER TABLE agent_instances ADD COLUMN custom_instructions TEXT NOT NULL DEFAULT ''");
    if (!agentColumns.has('instruction_revision')) this.db.exec('ALTER TABLE agent_instances ADD COLUMN instruction_revision INTEGER NOT NULL DEFAULT 1');
    if (!agentColumns.has('codex_session_json')) this.db.exec('ALTER TABLE agent_instances ADD COLUMN codex_session_json TEXT');
    if (!agentColumns.has('resume_managed_once')) this.db.exec('ALTER TABLE agent_instances ADD COLUMN resume_managed_once INTEGER NOT NULL DEFAULT 0');
    if (!agentColumns.has('recovery_pending')) this.db.exec('ALTER TABLE agent_instances ADD COLUMN recovery_pending INTEGER NOT NULL DEFAULT 0');
    const fleetColumns = new Set(this.db.prepare('PRAGMA table_info(fleet_updates)').all().map((column) => column.name));
    if (!fleetColumns.has('allowed_task_ids_json')) this.db.exec("ALTER TABLE fleet_updates ADD COLUMN allowed_task_ids_json TEXT NOT NULL DEFAULT '[]'");
    const joinColumns = new Set(this.db.prepare('PRAGMA table_info(join_tokens)').all().map((column) => column.name));
    if (!joinColumns.has('metadata_json')) this.db.exec("ALTER TABLE join_tokens ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
    const rootColumns = new Set(this.db.prepare('PRAGMA table_info(workspace_roots)').all().map((column) => column.name));
    if (!rootColumns.has('node_root_id')) this.db.exec('ALTER TABLE workspace_roots ADD COLUMN node_root_id TEXT');
    this.db.exec('UPDATE workspace_roots SET node_root_id = id WHERE node_root_id IS NULL');
    const terminalColumns = new Set(this.db.prepare('PRAGMA table_info(terminal_sessions)').all().map((column) => column.name));
    if (!terminalColumns.has('label')) this.db.exec("ALTER TABLE terminal_sessions ADD COLUMN label TEXT NOT NULL DEFAULT 'Terminal'");
    this.db.prepare("UPDATE agent_instances SET orchestration_role = 'main' WHERE id = 'agt_master'").run();
    const snapshotColumns = new Set(this.db.prepare('PRAGMA table_info(policy_snapshots)').all().map((column) => column.name));
    if (!snapshotColumns.has('agent_role')) this.db.exec("ALTER TABLE policy_snapshots ADD COLUMN agent_role TEXT NOT NULL DEFAULT 'worker'");
    if (!snapshotColumns.has('system_policy_revision')) this.db.exec('ALTER TABLE policy_snapshots ADD COLUMN system_policy_revision INTEGER NOT NULL DEFAULT 1');
    if (!snapshotColumns.has('agent_instructions')) this.db.exec("ALTER TABLE policy_snapshots ADD COLUMN agent_instructions TEXT NOT NULL DEFAULT ''");
    if (!snapshotColumns.has('agent_instruction_revision')) this.db.exec('ALTER TABLE policy_snapshots ADD COLUMN agent_instruction_revision INTEGER NOT NULL DEFAULT 1');
    this.db.prepare(`INSERT OR IGNORE INTO system_policies (id, policy_json, revision, updated_at)
      VALUES ('default', '{}', 1, ?)`).run(nowISO());
    if (!this.db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
      .get(AGENT_CONTROL_LIFECYCLE_MIGRATION)) {
      const appliedAt = nowISO();
      this.transaction(() => {
        // Before this migration, a healthy long-running process lost control
        // after twelve hours. Preserve only tokens belonging to an agent whose
        // recorded runtime is still active; terminal states remain expired.
        this.db.prepare(`UPDATE agent_control_tokens SET expires_at = ?
          WHERE revoked_at IS NULL AND agent_instance_id IN (
            SELECT id FROM agent_instances WHERE state IN ('starting', 'ready', 'busy')
          )`).run(NO_EXPIRY_TIMESTAMP);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(AGENT_CONTROL_LIFECYCLE_MIGRATION, appliedAt);
      });
    }
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createFleetUpdate({
    id = makeId('upd'), targetVersion, nodeIds = [], agentIds = [], requestedBy = 'owner:local',
  }) {
    invariant(!this.getActiveFleetUpdate(), 'WS_UPDATE_ACTIVE', 'A WebSpider fleet update is already active.', 409);
    invariant(typeof targetVersion === 'string' && targetVersion.length > 0 && targetVersion.length <= 80,
      'WS_VALIDATION', 'A bounded target version is required.');
    const nodes = [...new Set(nodeIds.map(String))];
    const agents = [...new Set(agentIds.map(String))];
    const now = nowISO();
    this.db.prepare(`INSERT INTO fleet_updates
      (id, target_version, state, requested_by, node_ids_json, agent_ids_json,
       ready_agents_json, node_status_json, created_at, updated_at, started_at)
      VALUES (?, ?, 'waiting_for_agents', ?, ?, ?, '{}', '{}', ?, ?, ?)`)
      .run(id, targetVersion, requestedBy, encode(nodes), encode(agents), now, now, now);
    const update = this.getFleetUpdate(id);
    this.appendEvent('fleet_update', id, 'fleet_update.preparing.v1', requestedBy, id, {
      target_version: targetVersion,
      node_ids: nodes,
      agent_ids: agents,
    });
    return update;
  }

  getFleetUpdate(id) {
    return fleetUpdateRow(this.db.prepare('SELECT * FROM fleet_updates WHERE id = ?').get(id));
  }

  getActiveFleetUpdate() {
    const placeholders = ACTIVE_FLEET_UPDATE_STATES.map(() => '?').join(', ');
    return fleetUpdateRow(this.db.prepare(`SELECT * FROM fleet_updates WHERE state IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`)
      .get(...ACTIVE_FLEET_UPDATE_STATES));
  }

  latestFleetUpdate() {
    return fleetUpdateRow(this.db.prepare('SELECT * FROM fleet_updates ORDER BY created_at DESC LIMIT 1').get());
  }

  markFleetAgentReady(id, agentId, actor, { override = false } = {}) {
    const update = this.getFleetUpdate(id);
    invariant(update && ['waiting_for_agents', 'waiting_for_tasks', 'waiting_for_nodes'].includes(update.state),
      'WS_UPDATE_NOT_WAITING', 'This fleet update is no longer accepting readiness acknowledgements.', 409);
    invariant(update.agent_ids.includes(agentId), 'WS_FORBIDDEN', 'This agent is not part of the fleet update.', 403);
    if (update.ready_agents[agentId]) return update;
    const readyAgents = {
      ...update.ready_agents,
      [agentId]: { ready_at: nowISO(), actor_id: actor, override: Boolean(override) },
    };
    const changed = nowISO();
    this.db.prepare('UPDATE fleet_updates SET ready_agents_json = ?, updated_at = ? WHERE id = ?')
      .run(encode(readyAgents), changed, id);
    this.appendEvent('fleet_update', id, 'fleet_update.agent_ready.v1', actor, agentId, {
      agent_id: agentId,
      override: Boolean(override),
    });
    return this.getFleetUpdate(id);
  }

  overrideFleetAgentReadiness(id, actor) {
    let update = this.getFleetUpdate(id);
    invariant(update && ['waiting_for_agents', 'waiting_for_tasks', 'waiting_for_nodes'].includes(update.state),
      'WS_UPDATE_NOT_WAITING', 'This fleet update is no longer accepting readiness overrides.', 409);
    for (const agentId of update.agent_ids) {
      if (!update.ready_agents[agentId]) update = this.markFleetAgentReady(id, agentId, actor, { override: true });
    }
    return update;
  }

  allowFleetTask(id, taskId, actor) {
    const update = this.getFleetUpdate(id);
    invariant(update && ['waiting_for_agents', 'waiting_for_tasks', 'waiting_for_nodes'].includes(update.state),
      'WS_UPDATE_NOT_WAITING', 'This fleet update is no longer accepting task overrides.', 409);
    const task = this.getTask(taskId);
    invariant(task && task.type === 'command' && task.specification?.fleet_update_id !== id,
      'WS_NOT_FOUND', 'Active blocking task not found.', 404);
    invariant(['pending', 'runnable', 'running', 'cancel_requested'].includes(task.state),
      'WS_TASK_NOT_ACTIVE', 'This task is no longer an active update blocker.', 409);
    if (update.allowed_task_ids.includes(taskId)) return update;
    const allowedTaskIds = [...update.allowed_task_ids, taskId];
    this.db.prepare('UPDATE fleet_updates SET allowed_task_ids_json = ?, updated_at = ? WHERE id = ?')
      .run(encode(allowedTaskIds), nowISO(), id);
    this.appendEvent('fleet_update', id, 'fleet_update.task_allowed.v1', actor, taskId, { task_id: taskId });
    return this.getFleetUpdate(id);
  }

  setFleetUpdateNodeStatus(id, nodeId, status) {
    const update = this.getFleetUpdate(id);
    invariant(update, 'WS_NOT_FOUND', 'Fleet update not found.', 404);
    invariant(update.node_ids.includes(nodeId), 'WS_VALIDATION', 'Node is not part of the fleet update.');
    const nodeStatus = { ...update.node_status, [nodeId]: { ...(update.node_status[nodeId] || {}), ...status } };
    this.db.prepare('UPDATE fleet_updates SET node_status_json = ?, updated_at = ? WHERE id = ?')
      .run(encode(nodeStatus), nowISO(), id);
    return this.getFleetUpdate(id);
  }

  setFleetUpdateState(id, state, { error = null } = {}, actor = 'hub:fleet-update') {
    const update = this.getFleetUpdate(id);
    invariant(update, 'WS_NOT_FOUND', 'Fleet update not found.', 404);
    const allowed = new Set([...ACTIVE_FLEET_UPDATE_STATES, 'completed', 'failed', 'cancelled']);
    invariant(allowed.has(state), 'WS_VALIDATION', 'Invalid fleet update state.');
    const now = nowISO();
    const completedAt = ['completed', 'failed', 'cancelled'].includes(state) ? now : null;
    this.db.prepare(`UPDATE fleet_updates SET state = ?, error = ?, updated_at = ?,
      completed_at = COALESCE(?, completed_at) WHERE id = ?`)
      .run(state, error, now, completedAt, id);
    this.appendEvent('fleet_update', id, `fleet_update.${state}.v1`, actor, id, {
      previous_state: update.state,
      target_version: update.target_version,
      error,
    });
    return this.getFleetUpdate(id);
  }

  createSession(secret, csrfToken, principalId = 'owner:local', role = 'owner') {
    const now = nowISO();
    // Browser sessions remain valid until explicit logout/revocation. The
    // column is retained for database compatibility with existing installs.
    const id = makeId('ses');
    this.db.prepare(`INSERT INTO browser_sessions
      (id, secret_hash, principal_id, role, csrf_token, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, sha256(secret), principalId, role, csrfToken, now, now, NO_EXPIRY_TIMESTAMP);
    return { id, principal_id: principalId, role, csrf_token: csrfToken, expires_at: null };
  }

  getSession(secret) {
    if (!secret) return null;
    const row = this.db.prepare(`SELECT * FROM browser_sessions
      WHERE secret_hash = ? AND revoked_at IS NULL`).get(sha256(secret));
    if (!row) return null;
    this.db.prepare('UPDATE browser_sessions SET last_seen_at = ? WHERE id = ?').run(nowISO(), row.id);
    return {
      id: row.id,
      principal_id: row.principal_id,
      role: row.role,
      csrf_token: row.csrf_token,
      expires_at: null,
    };
  }

  revokeSession(id) {
    this.db.prepare('UPDATE browser_sessions SET revoked_at = ? WHERE id = ?').run(nowISO(), id);
  }

  issueAgentControlToken(agentInstanceId, token, scopes, ttlMs = null) {
    const agent = this.getAgent(agentInstanceId);
    invariant(agent, 'WS_NOT_FOUND', 'Agent instance not found.', 404);
    invariant(!agent.project_archived_at, 'WS_PROJECT_ARCHIVED', 'Restore the project before starting its agent.', 409);
    invariant(Array.isArray(scopes) && scopes.length > 0, 'WS_VALIDATION', 'At least one control scope is required.');
    invariant(scopes.every((scope) => AGENT_CONTROL_ALLOWED_SCOPES.has(scope)), 'WS_FORBIDDEN',
      'Agent control scopes are limited to the orchestration allowlist.', 403);
    if (agent.orchestration_role !== 'main') {
      const workerScopes = new Set([
        'status:write:self',
        'tasks:read',
        'tasks:write',
        'reminders:read:self',
        'reminders:write:self',
        'documents:write',
        'files:transfer',
        'updates:write:self',
      ]);
      invariant(scopes.every((scope) => workerScopes.has(scope)), 'WS_FORBIDDEN',
        'A worker agent can only report status, manage its own detached tasks, and schedule its own hooks.', 403);
    }
    const now = nowISO();
    const storedExpiry = ttlMs == null ? NO_EXPIRY_TIMESTAMP : new Date(Date.now() + ttlMs).toISOString();
    const record = {
      id: makeId('act'),
      agent_instance_id: agent.id,
      project_id: agent.project_id,
      scopes: [...new Set(scopes)],
      created_at: now,
      expires_at: ttlMs == null ? null : storedExpiry,
    };
    this.transaction(() => {
      this.db.prepare('UPDATE agent_control_tokens SET revoked_at = ? WHERE agent_instance_id = ? AND revoked_at IS NULL')
        .run(now, agent.id);
      this.db.prepare(`INSERT INTO agent_control_tokens
        (id, token_hash, agent_instance_id, project_id, scopes_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        record.id, sha256(token), record.agent_instance_id, record.project_id,
        encode(record.scopes), record.created_at, storedExpiry,
      );
    });
    return record;
  }

  getAgentControlToken(token) {
    if (!token) return null;
    const row = this.db.prepare(`SELECT t.*, a.orchestration_role FROM agent_control_tokens t
      JOIN agent_instances a ON a.id = t.agent_instance_id
      JOIN projects p ON p.id = t.project_id AND p.archived_at IS NULL
      WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?`).get(sha256(token), nowISO());
    if (!row) return null;
    return {
      id: row.id,
      principal_id: `agent:${row.agent_instance_id}`,
      role: 'agent',
      agent_instance_id: row.agent_instance_id,
      project_id: row.project_id,
      scopes: decode(row.scopes_json, []),
      expires_at: row.expires_at === NO_EXPIRY_TIMESTAMP ? null : row.expires_at,
    };
  }

  revokeAgentControlTokens(agentInstanceId) {
    const result = this.db.prepare('UPDATE agent_control_tokens SET revoked_at = ? WHERE agent_instance_id = ? AND revoked_at IS NULL')
      .run(nowISO(), agentInstanceId);
    return Number(result.changes) > 0;
  }

  createAccountUsageSnapshot({
    agentInstanceId, source, observedAt = nowISO(), rateLimits, tokenActivity = null,
  }, actor = `agent:${agentInstanceId}`) {
    const agent = this.getAgent(agentInstanceId);
    invariant(agent?.orchestration_role === 'main', 'WS_FORBIDDEN', 'Only a main agent can report account allowance.', 403);
    invariant(typeof source === 'string' && /^[a-z0-9][a-z0-9._-]{2,63}$/i.test(source),
      'WS_VALIDATION', 'A bounded usage source is required.');
    invariant(Array.isArray(rateLimits) && rateLimits.length > 0 && rateLimits.length <= 16,
      'WS_VALIDATION', 'One to sixteen rate-limit windows are required.');
    const observed = new Date(observedAt);
    invariant(Number.isFinite(observed.getTime()) && observed.getTime() <= Date.now() + 300_000,
      'WS_VALIDATION', 'observed_at must be a valid timestamp that is not in the future.');
    const normalizedLimits = rateLimits.map((limit) => {
      invariant(limit && typeof limit === 'object' && !Array.isArray(limit), 'WS_VALIDATION', 'Each rate limit must be an object.');
      const windowMinutes = Number(limit.window_minutes);
      const remaining = limit.remaining_percent == null ? 100 - Number(limit.used_percent) : Number(limit.remaining_percent);
      const used = limit.used_percent == null ? 100 - remaining : Number(limit.used_percent);
      invariant(typeof limit.name === 'string' && /^[a-z0-9][a-z0-9._-]{1,63}$/i.test(limit.name),
        'WS_VALIDATION', 'Each rate-limit name must be bounded.');
      invariant(Number.isFinite(windowMinutes) && windowMinutes > 0 && windowMinutes <= 525_600,
        'WS_VALIDATION', 'Each rate-limit window must use valid minutes.');
      invariant(Number.isFinite(used) && Number.isFinite(remaining)
        && used >= 0 && used <= 100 && remaining >= 0 && remaining <= 100
        && Math.abs((used + remaining) - 100) < 0.11,
      'WS_VALIDATION', 'used_percent and remaining_percent must be complementary percentages.');
      const resetsAt = limit.resets_at == null ? null : new Date(limit.resets_at);
      invariant(resetsAt == null || Number.isFinite(resetsAt.getTime()), 'WS_VALIDATION', 'resets_at must be a valid timestamp.');
      return {
        name: limit.name,
        window_minutes: windowMinutes,
        used_percent: Math.round(used * 10) / 10,
        remaining_percent: Math.round(remaining * 10) / 10,
        resets_at: resetsAt?.toISOString() || null,
      };
    });
    invariant(tokenActivity == null || (typeof tokenActivity === 'object' && !Array.isArray(tokenActivity)),
      'WS_VALIDATION', 'token_activity must be an object when supplied.');
    let normalizedActivity = null;
    if (tokenActivity != null) {
      const tokens = Number(tokenActivity.tokens);
      invariant(tokenActivity.period === 'weekly', 'WS_VALIDATION', 'token_activity.period must be weekly.');
      invariant(Number.isSafeInteger(tokens) && tokens >= 0, 'WS_VALIDATION', 'token_activity.tokens must be a non-negative integer.');
      invariant(typeof tokenActivity.source === 'string' && /^[a-z0-9][a-z0-9._-]{2,63}$/i.test(tokenActivity.source),
        'WS_VALIDATION', 'token_activity.source must be bounded.');
      normalizedActivity = { period: 'weekly', tokens, source: tokenActivity.source };
    }
    const snapshot = {
      id: makeId('use'),
      agent_instance_id: agent.id,
      project_id: agent.project_id,
      source,
      observed_at: observed.toISOString(),
      rate_limits: normalizedLimits,
      token_activity: normalizedActivity,
      created_at: nowISO(),
    };
    this.db.prepare(`INSERT INTO account_usage_snapshots
      (id, agent_instance_id, project_id, source, observed_at, rate_limits_json, token_activity_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      snapshot.id, snapshot.agent_instance_id, snapshot.project_id, snapshot.source,
      snapshot.observed_at, encode(snapshot.rate_limits),
      snapshot.token_activity == null ? null : encode(snapshot.token_activity), snapshot.created_at,
    );
    this.appendEvent('system', 'account-usage', 'account.usage.observed.v1', actor, snapshot.id, {
      source: snapshot.source,
      observed_at: snapshot.observed_at,
      rate_limits: snapshot.rate_limits,
    });
    return snapshot;
  }

  latestAccountUsageSnapshot() {
    return accountUsageRow(this.db.prepare(
      'SELECT * FROM account_usage_snapshots ORDER BY observed_at DESC, created_at DESC LIMIT 1',
    ).get());
  }

  accountUsageStatus(staleAfterMs = 7_200_000) {
    const snapshot = this.latestAccountUsageSnapshot();
    if (!snapshot) return { snapshot: null, weekly: null, stale: true, age_ms: null };
    const ageMs = Math.max(0, Date.now() - new Date(snapshot.observed_at).getTime());
    const weekly = snapshot.rate_limits.find((limit) => limit.name.toLowerCase().includes('week'))
      || snapshot.rate_limits.find((limit) => limit.window_minutes >= 10_080)
      || null;
    return { snapshot, weekly, stale: ageMs > staleAfterMs, age_ms: ageMs };
  }

  createJoinToken(displayName, token, ttlMs = 600_000, metadata = {}) {
    const created = nowISO();
    const record = {
      id: makeId('jtk'),
      display_name: displayName,
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
      created_at: created,
    };
    this.db.prepare(`INSERT INTO join_tokens
      (id, token_hash, display_name, expires_at, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(record.id, sha256(token), record.display_name, record.expires_at, record.created_at, encode(metadata));
    return record;
  }

  consumeJoinToken(token, publicKey, requestedName, metadata = {}) {
    return this.transaction(() => {
      const now = nowISO();
      const row = this.db.prepare(`SELECT * FROM join_tokens
        WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`).get(sha256(token), now);
      invariant(row, 'WS_AUTH_REQUIRED', 'Join token is invalid, expired, or already used.', 401);
      const node = this.createNode({
        id: makeId('nod'),
        displayName: requestedName || row.display_name,
        publicKey,
        labels: metadata.labels,
        capabilities: metadata.capabilities,
        adapterInventory: metadata.adapter_inventory,
      });
      this.db.prepare('UPDATE join_tokens SET consumed_at = ? WHERE id = ?').run(now, row.id);
      return { ...node, enrollment: decode(row.metadata_json, {}) };
    });
  }

  consumeJoinTokenForNode(token, nodeId) {
    return this.transaction(() => {
      const now = nowISO();
      const row = this.db.prepare(`SELECT * FROM join_tokens
        WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`).get(sha256(token), now);
      invariant(row, 'WS_AUTH_REQUIRED', 'Join token is invalid, expired, or already used.', 401);
      invariant(this.getNode(nodeId, true), 'WS_AUTH_REQUIRED', 'Unknown node.', 401);
      this.db.prepare('UPDATE join_tokens SET consumed_at = ? WHERE id = ?').run(now, row.id);
      return decode(row.metadata_json, {});
    });
  }

  updateNodeCapabilities(id, capabilities) {
    invariant(this.getNode(id, true), 'WS_NOT_FOUND', 'Node not found.', 404);
    this.db.prepare('UPDATE nodes SET capabilities_json = ? WHERE id = ?').run(encode(capabilities || {}), id);
    return this.getNode(id);
  }

  createNode({ id = makeId('nod'), displayName, publicKey, labels = {}, capabilities = {}, adapterInventory = [] }) {
    const now = nowISO();
    this.db.prepare(`INSERT INTO nodes
      (id, display_name, public_key, labels_json, capabilities_json, adapter_inventory_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'offline', ?)`)
      .run(id, displayName, publicKey, encode(labels), encode(capabilities), encode(adapterInventory), now);
    return this.getNode(id, true);
  }

  ensureNode(input) {
    const existing = this.getNode(input.id, true);
    if (existing) return existing;
    return this.createNode(input);
  }

  ensureLocalNode(input) {
    const existing = this.getNode(input.id, true);
    if (!existing) return this.createNode(input);
    invariant(existing.labels?.location === 'local', 'WS_CONFLICT', 'Only the trusted local node credential can be refreshed.', 409);
    if (existing.public_key !== input.publicKey) {
      this.db.prepare(`UPDATE nodes SET public_key = ?, credential_version = credential_version + 1,
        status = 'offline' WHERE id = ?`).run(input.publicKey, input.id);
    }
    return this.getNode(input.id, true);
  }

  getNode(id, includeKey = false) {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
    if (!row) return null;
    const value = nodeRow(row);
    if (includeKey) value.public_key = row.public_key;
    return value;
  }

  listNodes() {
    return this.db.prepare('SELECT * FROM nodes ORDER BY display_name').all().map(nodeRow);
  }

  connectNode(id, capabilities = {}, adapterInventory = []) {
    const node = this.getNode(id, true);
    invariant(node, 'WS_AUTH_REQUIRED', 'Unknown node.', 401);
    invariant(!node.revoked_at, 'WS_NODE_REVOKED', 'Node has been revoked.', 403);
    const epoch = Number(node.connection_epoch) + 1;
    const now = nowISO();
    this.db.prepare(`UPDATE nodes SET connection_epoch = ?, status = 'online', last_seen_at = ?,
      capabilities_json = ?, adapter_inventory_json = ? WHERE id = ?`)
      .run(epoch, now, encode(capabilities), encode(adapterInventory), id);
    return { ...this.getNode(id), connection_epoch: epoch };
  }

  heartbeatNode(id, metadata = {}) {
    this.db.prepare(`UPDATE nodes SET last_seen_at = ?, status = 'online',
      capabilities_json = COALESCE(?, capabilities_json) WHERE id = ? AND revoked_at IS NULL`)
      .run(nowISO(), metadata.capabilities ? encode(metadata.capabilities) : null, id);
  }

  disconnectNode(id, epoch) {
    this.db.prepare(`UPDATE nodes SET status = 'offline' WHERE id = ? AND connection_epoch = ? AND revoked_at IS NULL`)
      .run(id, epoch);
  }

  createProject({ id = makeId('prj'), name, description = '', labels = {}, policy = null }, actor = 'owner:local') {
    invariant(name?.trim(), 'WS_VALIDATION', 'Project name is required.');
    const now = nowISO();
    const policyOverrides = policy || {};
    const resolvedPolicy = mergeProjectPolicy(mergeProjectPolicy(
      createDefaultProjectPolicy({ kind: labels.project_kind || 'academic', signals: labels.inference_signals || [] }),
      this.getSystemPolicy().overrides,
    ), policyOverrides);
    this.db.prepare(`INSERT INTO projects
      (id, name, description, labels_json, policy_json, policy_overrides_json, policy_revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, name.trim(), description, encode(labels), encode(resolvedPolicy), encode(policyOverrides), now, now);
    const project = this.getProject(id);
    this.appendEvent('project', id, 'project.created.v1', actor, id, project);
    return project;
  }

  getSystemPolicy() {
    return systemPolicyRow(this.db.prepare("SELECT * FROM system_policies WHERE id = 'default'").get());
  }

  updateSystemPolicy(patch, { actor = 'owner:local', expectedRevision = null, reason = '' } = {}) {
    const previous = this.getSystemPolicy();
    invariant(patch && typeof patch === 'object' && !Array.isArray(patch), 'WS_VALIDATION', 'Policy patch must be an object.');
    if (expectedRevision != null) {
      invariant(Number(expectedRevision) === previous.revision, 'WS_POLICY_REVISION_CONFLICT',
        'System defaults changed since they were inspected.', 409,
        { expected_revision: Number(expectedRevision), current_revision: previous.revision });
    }
    const overrides = mergeProjectPolicy(previous.overrides, patch);
    if (encode(overrides) === encode(previous.overrides)) return previous;
    const revision = previous.revision + 1;
    const updated = nowISO();
    this.db.prepare("UPDATE system_policies SET policy_json = ?, revision = ?, updated_at = ? WHERE id = 'default'")
      .run(encode(overrides), revision, updated);
    this.appendEvent('system', 'default-policy', 'system.policy.updated.v1', actor, 'default-policy', {
      previous_revision: previous.revision,
      revision,
      reason,
    });
    return this.getSystemPolicy();
  }

  getProject(id) {
    return projectRow(this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id), this.getSystemPolicy());
  }

  listProjects({ archived = 'active' } = {}) {
    invariant(['active', 'archived', 'all'].includes(archived), 'WS_VALIDATION', 'Invalid project archive filter.');
    const systemPolicy = this.getSystemPolicy();
    const where = archived === 'active' ? 'WHERE archived_at IS NULL'
      : archived === 'archived' ? 'WHERE archived_at IS NOT NULL' : '';
    return this.db.prepare(`SELECT * FROM projects ${where} ORDER BY name`).all().map((row) => projectRow(row, systemPolicy));
  }

  archiveProject(id, actor = 'owner:local') {
    const project = this.getProject(id);
    invariant(project, 'WS_NOT_FOUND', 'Project not found.', 404);
    invariant(!project.archived_at, 'WS_PROJECT_ARCHIVED', 'Project is already archived.', 409);
    invariant(!this.listAgents(id).some((agent) => agent.orchestration_role === 'main'),
      'WS_PROJECT_PROTECTED', 'The Master Spider project cannot be archived.', 409);
    invariant(!this.listAgents(id).some((agent) => ['ready', 'busy', 'starting', 'stopping'].includes(agent.state)),
      'WS_PROJECT_ACTIVE', 'Stop every running project agent before archiving.', 409);
    invariant(!this.listTasks(id).some((task) => ['pending', 'runnable', 'running', 'cancel_requested'].includes(task.state)),
      'WS_PROJECT_ACTIVE', 'Cancel or finish every active project task before archiving.', 409);
    invariant(!this.db.prepare(`SELECT 1 FROM terminal_sessions t
      JOIN agent_instances a ON a.id = t.agent_instance_id
      WHERE a.project_id = ? AND t.kind = 'shell_tab' AND t.state = 'attached' LIMIT 1`).get(id),
    'WS_PROJECT_ACTIVE', 'Stop every running project shell before archiving.', 409);
    const archivedAt = nowISO();
    this.transaction(() => {
      this.db.prepare('UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?').run(archivedAt, archivedAt, id);
      this.db.prepare(`UPDATE agent_control_tokens SET revoked_at = ?
        WHERE project_id = ? AND revoked_at IS NULL`).run(archivedAt, id);
    });
    this.appendEvent('project', id, 'project.archived.v1', actor, id, { archived_at: archivedAt });
    return this.getProject(id);
  }

  restoreProject(id, actor = 'owner:local') {
    const project = this.getProject(id);
    invariant(project, 'WS_NOT_FOUND', 'Project not found.', 404);
    invariant(project.archived_at, 'WS_PROJECT_NOT_ARCHIVED', 'Project is not archived.', 409);
    this.db.prepare('UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ?').run(nowISO(), id);
    this.appendEvent('project', id, 'project.restored.v1', actor, id, {});
    return this.getProject(id);
  }

  deleteArchivedProject(id) {
    const project = this.getProject(id);
    invariant(project, 'WS_NOT_FOUND', 'Project not found.', 404);
    invariant(project.archived_at, 'WS_PROJECT_NOT_ARCHIVED', 'Archive the project before deleting it.', 409);
    invariant(!this.listAgents(id).some((agent) => agent.orchestration_role === 'main'),
      'WS_PROJECT_PROTECTED', 'The Master Spider project cannot be deleted.', 409);
    invariant(!this.listAgents(id).some((agent) => ['ready', 'busy', 'starting', 'stopping'].includes(agent.state)),
      'WS_PROJECT_ACTIVE', 'Stop every running project agent before deleting.', 409);
    invariant(!this.listTasks(id).some((task) => ['pending', 'runnable', 'running', 'cancel_requested'].includes(task.state)),
      'WS_PROJECT_ACTIVE', 'Cancel or finish every active project task before deleting.', 409);
    const agents = this.listAgents(id);
    const profileIds = [...new Set(agents.map((agent) => agent.profile_id))];
    const agentIds = agents.map((agent) => agent.id);
    const threadIds = this.db.prepare('SELECT id FROM threads WHERE project_id = ?').all(id).map((row) => row.id);
    const taskIds = this.db.prepare('SELECT id FROM tasks WHERE project_id = ?').all(id).map((row) => row.id);
    const terminalIds = this.db.prepare(`SELECT t.id FROM terminal_sessions t
      JOIN agent_instances a ON a.id = t.agent_instance_id WHERE a.project_id = ?`).all(id).map((row) => row.id);
    const messageIds = this.db.prepare(`SELECT m.id FROM messages m
      JOIN threads t ON t.id = m.thread_id WHERE t.project_id = ?`).all(id).map((row) => row.id);
    const associatedIds = [...new Set([id, ...agentIds, ...threadIds, ...taskIds, ...terminalIds, ...messageIds])];
    this.transaction(() => {
      this.db.prepare(`DELETE FROM terminal_leases WHERE terminal_id IN (
        SELECT t.id FROM terminal_sessions t JOIN agent_instances a ON a.id = t.agent_instance_id WHERE a.project_id = ?
      )`).run(id);
      this.db.prepare(`DELETE FROM message_deliveries WHERE recipient_agent_instance_id IN (
        SELECT id FROM agent_instances WHERE project_id = ?
      ) OR message_id IN (
        SELECT m.id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.project_id = ?
      )`).run(id, id);
      this.db.prepare('DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ?)').run(id);
      this.db.prepare('DELETE FROM task_attempts WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)').run(id);
      this.db.prepare('DELETE FROM artifacts WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM attention_items WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM agent_control_tokens WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM account_usage_snapshots WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM policy_snapshots WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM workspace_roots WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM terminal_sessions WHERE agent_instance_id IN (SELECT id FROM agent_instances WHERE project_id = ?)').run(id);
      this.db.prepare('DELETE FROM threads WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM tasks WHERE project_id = ?').run(id);
      const deleteEvent = this.db.prepare('DELETE FROM events WHERE scope_id = ? OR subject_id = ?');
      const deleteAudit = this.db.prepare('DELETE FROM audit_log WHERE target_id = ?');
      for (const associatedId of associatedIds) {
        deleteEvent.run(associatedId, associatedId);
        deleteAudit.run(associatedId);
      }
      this.db.prepare('DELETE FROM audit_log WHERE project_id = ?').run(id);
      for (const token of this.db.prepare('SELECT id, metadata_json FROM join_tokens').all()) {
        if (decode(token.metadata_json, {}).project_id === id) this.db.prepare('DELETE FROM join_tokens WHERE id = ?').run(token.id);
      }
      this.db.prepare('DELETE FROM agent_instances WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      for (const profileId of profileIds) {
        this.db.prepare('DELETE FROM agent_profiles WHERE id = ? AND NOT EXISTS (SELECT 1 FROM agent_instances WHERE profile_id = ?)')
          .run(profileId, profileId);
      }
    });
    return { id: project.id, name: project.name, deleted: true };
  }

  createNote({ id = makeId('nte'), title, filename, visibility = 'private' }) {
    invariant(title?.trim(), 'WS_VALIDATION', 'Note title is required.');
    invariant(filename?.trim(), 'WS_VALIDATION', 'Note filename is required.');
    invariant(['private', 'master'].includes(visibility), 'WS_VALIDATION', 'Note visibility must be private or master.');
    const now = nowISO();
    this.db.prepare(`INSERT INTO notes (id, title, filename, visibility, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, title.trim(), filename, visibility, now, now);
    return this.getNote(id);
  }

  getNote(id) {
    return noteRow(this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id));
  }

  listNotes({ visibility = null } = {}) {
    const rows = visibility
      ? this.db.prepare('SELECT * FROM notes WHERE visibility = ? ORDER BY updated_at DESC').all(visibility)
      : this.db.prepare('SELECT * FROM notes ORDER BY updated_at DESC').all();
    return rows.map(noteRow);
  }

  updateNote(id, { title, visibility }) {
    const previous = this.getNote(id);
    invariant(previous, 'WS_NOT_FOUND', 'Note not found.', 404);
    const nextTitle = title == null ? previous.title : String(title).trim();
    const nextVisibility = visibility == null ? previous.visibility : visibility;
    invariant(nextTitle, 'WS_VALIDATION', 'Note title is required.');
    invariant(['private', 'master'].includes(nextVisibility), 'WS_VALIDATION', 'Note visibility must be private or master.');
    this.db.prepare('UPDATE notes SET title = ?, visibility = ?, updated_at = ? WHERE id = ?')
      .run(nextTitle, nextVisibility, nowISO(), id);
    return this.getNote(id);
  }

  deleteNote(id) {
    const note = this.getNote(id);
    invariant(note, 'WS_NOT_FOUND', 'Note not found.', 404);
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
    return note;
  }

  updateProjectPolicy(id, patch, actor = 'owner:local', { expectedRevision = null, reason = '' } = {}) {
    const previous = this.getProject(id);
    invariant(previous, 'WS_NOT_FOUND', 'Project not found.', 404);
    invariant(patch && typeof patch === 'object' && !Array.isArray(patch), 'WS_VALIDATION', 'Policy patch must be an object.');
    if (expectedRevision != null) {
      invariant(Number(expectedRevision) === previous.policy_revision, 'WS_POLICY_REVISION_CONFLICT',
        'Project defaults changed since they were inspected.', 409,
        { expected_revision: Number(expectedRevision), current_revision: previous.policy_revision });
    }
    const policyOverrides = mergeProjectPolicy(previous.policy_overrides, patch);
    const labels = previous.labels;
    const policy = mergeProjectPolicy(mergeProjectPolicy(
      createDefaultProjectPolicy({ kind: labels.project_kind || 'academic', signals: labels.inference_signals || [] }),
      this.getSystemPolicy().overrides,
    ), policyOverrides);
    const revision = previous.policy_revision + 1;
    this.db.prepare('UPDATE projects SET policy_json = ?, policy_overrides_json = ?, policy_revision = ?, updated_at = ? WHERE id = ?')
      .run(encode(policy), encode(policyOverrides), revision, nowISO(), id);
    const project = this.getProject(id);
    this.appendEvent('project', id, 'project.policy.updated.v1', actor, id, {
      policy_revision: revision,
      previous_revision: previous.policy_revision,
      reason,
    });
    return project;
  }

  createPolicySnapshot({
    projectId, agentInstanceId = null, agentRole = 'worker', systemPolicyRevision = 1,
    policyRevision, policy, agentInstructions = '', agentInstructionRevision = 1, renderedInstructions,
  }, actor = 'hub:policy') {
    invariant(this.getProject(projectId), 'WS_NOT_FOUND', 'Project not found.', 404);
    const snapshot = {
      id: makeId('pol'),
      project_id: projectId,
      agent_instance_id: agentInstanceId,
      agent_role: agentRole,
      system_policy_revision: systemPolicyRevision,
      policy_revision: policyRevision,
      policy,
      agent_instructions: agentInstructions,
      agent_instruction_revision: agentInstructionRevision,
      rendered_instructions: renderedInstructions,
      content_hash: sha256(renderedInstructions),
      created_at: nowISO(),
    };
    this.db.prepare(`INSERT INTO policy_snapshots
      (id, project_id, agent_instance_id, agent_role, system_policy_revision, policy_revision,
       policy_json, agent_instructions, agent_instruction_revision, rendered_instructions, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      snapshot.id, snapshot.project_id, snapshot.agent_instance_id, snapshot.agent_role,
      snapshot.system_policy_revision, snapshot.policy_revision,
      encode(snapshot.policy), snapshot.agent_instructions, snapshot.agent_instruction_revision,
      snapshot.rendered_instructions, snapshot.content_hash, snapshot.created_at,
    );
    this.appendEvent('project', projectId, 'project.policy.snapshot.created.v1', actor, snapshot.id, {
      agent_instance_id: agentInstanceId,
      agent_role: agentRole,
      system_policy_revision: systemPolicyRevision,
      policy_revision: policyRevision,
      content_hash: snapshot.content_hash,
    });
    return snapshot;
  }

  latestPolicySnapshot(agentInstanceId) {
    const row = this.db.prepare('SELECT * FROM policy_snapshots WHERE agent_instance_id = ? ORDER BY created_at DESC LIMIT 1').get(agentInstanceId);
    if (!row) return null;
    return {
      id: row.id,
      project_id: row.project_id,
      agent_instance_id: row.agent_instance_id,
      agent_role: row.agent_role || 'worker',
      system_policy_revision: Number(row.system_policy_revision || 1),
      policy_revision: row.policy_revision,
      policy: decode(row.policy_json, {}),
      agent_instructions: row.agent_instructions || '',
      agent_instruction_revision: Number(row.agent_instruction_revision || 1),
      rendered_instructions: row.rendered_instructions,
      content_hash: row.content_hash,
      created_at: row.created_at,
    };
  }

  createProfile({ id = makeId('apf'), name, adapterKind = 'command', executable = '/bin/bash', arguments: args = [], environment = {}, restartPolicy = {} }, actor = 'owner:local') {
    invariant(['command', 'pty', 'native', 'acp'].includes(adapterKind), 'WS_VALIDATION', 'Unsupported adapter kind.');
    const created = nowISO();
    this.db.prepare(`INSERT INTO agent_profiles
      (id, name, adapter_kind, executable, arguments_json, environment_json, restart_policy_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, name, adapterKind, executable, encode(args), encode(environment), encode(restartPolicy), created);
    const profile = this.getProfile(id);
    this.appendEvent('profile', id, 'agent.profile.created.v1', actor, id, profile);
    return profile;
  }

  getProfile(id) {
    return profileRow(this.db.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(id));
  }

  listProfiles() {
    return this.db.prepare('SELECT * FROM agent_profiles ORDER BY name').all().map(profileRow);
  }

  createAgent({
    id = makeId('agt'), profileId, projectId, nodeId, title, taskId = null,
    resumability = 'process', root = null, orchestrationRole = 'worker',
  }, actor = 'owner:local') {
    const profile = this.getProfile(profileId);
    const project = this.getProject(projectId);
    const node = this.getNode(nodeId);
    invariant(profile && project && node, 'WS_VALIDATION', 'Profile, project, and node must exist.');
    invariant(!project.archived_at, 'WS_PROJECT_ARCHIVED', 'Restore the project before adding an agent.', 409);
    invariant(['main', 'worker'].includes(orchestrationRole), 'WS_VALIDATION', 'Agent role must be main or worker.');
    const created = nowISO();
    const threadId = makeId('thr');
    const terminalId = makeId('trm');
    const rootRecord = root ? {
      id: root.id || makeId('awr'),
      node_root_id: root.node_root_id || root.id,
      logical_name: root.logical_name || 'workspace',
      access_mode: root.access_mode || 'read_only',
      expose_in_portal: root.expose_in_portal ?? true,
      allow_download: root.allow_download ?? true,
      allow_search: root.allow_search ?? true,
      allow_preview: root.allow_preview ?? true,
      symlink_policy: root.symlink_policy || 'no_symlinks',
      mount_policy: root.mount_policy || 'allow_nested',
    } : null;
    this.transaction(() => {
      this.db.prepare(`INSERT INTO agent_instances
        (id, profile_id, project_id, node_id, task_id, orchestration_role, state, resumability, created_at, last_activity_at)
        VALUES (?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?)`)
        .run(id, profileId, projectId, nodeId, taskId, orchestrationRole, resumability, created, created);
      this.db.prepare(`INSERT INTO threads
        (id, project_id, primary_agent_instance_id, title, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)`)
        .run(threadId, projectId, id, title || profile.name, created, created);
      this.db.prepare('UPDATE agent_instances SET active_thread_id = ? WHERE id = ?').run(threadId, id);
      this.db.prepare(`INSERT INTO terminal_sessions
        (id, agent_instance_id, node_id, kind, state, created_at)
        VALUES (?, ?, ?, 'primary_agent', 'detached', ?)`)
        .run(terminalId, id, nodeId, created);
      if (rootRecord) {
        this.db.prepare(`INSERT INTO workspace_roots
          (id, node_root_id, agent_instance_id, project_id, node_id, logical_name, access_mode, expose_in_portal,
           allow_download, allow_search, allow_preview, symlink_policy, mount_policy, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(rootRecord.id, rootRecord.node_root_id, id, projectId, nodeId, rootRecord.logical_name, rootRecord.access_mode,
            Number(rootRecord.expose_in_portal), Number(rootRecord.allow_download), Number(rootRecord.allow_search),
            Number(rootRecord.allow_preview), rootRecord.symlink_policy, rootRecord.mount_policy, created);
      }
    });
    const agent = this.getAgent(id);
    this.appendEvent('agent', id, 'agent.created.v1', actor, id, { ...agent, terminal_id: terminalId, root_id: rootRecord?.id });
    return { ...agent, terminal_id: terminalId, root_id: rootRecord?.id };
  }

  getAgent(id) {
    const row = this.db.prepare(`SELECT a.*, p.name AS profile_name, p.executable AS profile_executable,
      pr.name AS project_name, pr.archived_at AS project_archived_at,
      n.display_name AS node_name, t.title AS title FROM agent_instances a
      JOIN agent_profiles p ON p.id = a.profile_id
      JOIN projects pr ON pr.id = a.project_id
      JOIN nodes n ON n.id = a.node_id
      LEFT JOIN threads t ON t.id = a.active_thread_id WHERE a.id = ?`).get(id);
    if (!row) return null;
    const value = agentRow(row);
    const terminal = this.db.prepare('SELECT id, state FROM terminal_sessions WHERE agent_instance_id = ? ORDER BY created_at LIMIT 1').get(id);
    value.terminal_id = terminal?.id;
    value.terminal_state = terminal?.state;
    return value;
  }

  listAgents(projectId = null) {
    const sql = `SELECT a.*, p.name AS profile_name, pr.name AS project_name, n.display_name AS node_name
      FROM agent_instances a JOIN agent_profiles p ON p.id = a.profile_id
      JOIN projects pr ON pr.id = a.project_id JOIN nodes n ON n.id = a.node_id
      ${projectId ? 'WHERE a.project_id = ?' : ''} ORDER BY a.created_at`;
    const rows = projectId ? this.db.prepare(sql).all(projectId) : this.db.prepare(sql).all();
    return rows.map((row) => this.getAgent(row.id));
  }

  setAgentRole(id, role) {
    invariant(['main', 'worker'].includes(role), 'WS_VALIDATION', 'Agent role must be main or worker.');
    invariant(this.getAgent(id), 'WS_NOT_FOUND', 'Agent instance not found.', 404);
    this.db.prepare('UPDATE agent_instances SET orchestration_role = ? WHERE id = ?').run(role, id);
    if (role !== 'main') this.revokeAgentControlTokens(id);
    return this.getAgent(id);
  }

  setAgentCodexSession(id, session, actor = 'owner:local') {
    const agent = this.getAgent(id);
    invariant(agent, 'WS_NOT_FOUND', 'Agent instance not found.', 404);
    invariant(agent.codex_capable, 'WS_ADAPTER_UNAVAILABLE', 'This agent profile does not launch Codex.', 409);
    let normalized = null;
    if (session) {
      invariant(session.source === 'user', 'WS_VALIDATION', 'Only user-owned Codex sessions can be adopted explicitly.');
      invariant(['last', 'id'].includes(session.selector), 'WS_VALIDATION', 'Choose the latest project session or provide a session ID.');
      let sessionId = null;
      if (session.selector === 'id') {
        sessionId = String(session.session_id || '').trim();
        invariant(sessionId.length > 0 && sessionId.length <= 200 && !/[\x00-\x1f\x7f]/u.test(sessionId),
          'WS_VALIDATION', 'Codex session ID or name must contain 1-200 printable characters.');
      }
      normalized = { source: 'user', selector: session.selector, session_id: sessionId };
    }
    this.db.prepare('UPDATE agent_instances SET codex_session_json = ? WHERE id = ?')
      .run(normalized ? encode(normalized) : null, id);
    this.appendEvent('agent', id, 'agent.codex_session.configured.v1', actor, id, {
      configured: Boolean(normalized), selector: normalized?.selector || null,
    });
    return this.getAgent(id);
  }

  setAgentManagedResumePending(id, pending = true) {
    invariant(this.getAgent(id), 'WS_NOT_FOUND', 'Agent instance not found.', 404);
    this.db.prepare('UPDATE agent_instances SET resume_managed_once = ? WHERE id = ?').run(Number(Boolean(pending)), id);
    return this.getAgent(id);
  }

  updateAgentInstructions(id, instructions, actor = 'owner:local', { expectedRevision = null } = {}) {
    const previous = this.getAgent(id);
    invariant(previous, 'WS_NOT_FOUND', 'Agent instance not found.', 404);
    invariant(typeof instructions === 'string', 'WS_VALIDATION', 'Custom instructions must be text.');
    const normalized = instructions.replace(/\r\n?/g, '\n').trim();
    invariant(!normalized.includes('\0'), 'WS_VALIDATION', 'Custom instructions contain forbidden content.');
    invariant(Buffer.byteLength(normalized, 'utf8') <= 4_000, 'WS_VALIDATION', 'Custom instructions must be 4 KB or less.');
    if (expectedRevision != null) {
      invariant(Number(expectedRevision) === previous.instruction_revision, 'WS_INSTRUCTION_REVISION_CONFLICT',
        'Agent instructions changed since they were opened.', 409,
        { expected_revision: Number(expectedRevision), current_revision: previous.instruction_revision });
    }
    if (normalized === previous.custom_instructions) return previous;
    const revision = previous.instruction_revision + 1;
    this.db.prepare('UPDATE agent_instances SET custom_instructions = ?, instruction_revision = ? WHERE id = ?')
      .run(normalized, revision, id);
    this.appendEvent('agent', id, 'agent.instructions.updated.v1', actor, id, {
      previous_revision: previous.instruction_revision,
      instruction_revision: revision,
    });
    return this.getAgent(id);
  }

  setAgentState(id, state, actor = 'hub:reconciler', payload = {}) {
    const previous = this.getAgent(id);
    invariant(previous, 'WS_NOT_FOUND', 'Agent instance not found.', 404);
    const changedAt = nowISO();
    const stopped = ['stopped', 'failed'].includes(state) ? changedAt : null;
    this.transaction(() => {
      this.db.prepare(`UPDATE agent_instances SET state = ?, last_activity_at = ?, stopped_at = ? WHERE id = ?`)
        .run(state, changedAt, stopped, id);
      if (!AGENT_CONTROL_ACTIVE_STATES.has(state)) {
        this.db.prepare(`UPDATE agent_control_tokens SET revoked_at = ?
          WHERE agent_instance_id = ? AND revoked_at IS NULL`).run(changedAt, id);
      }
    });
    const current = this.getAgent(id);
    this.appendEvent('agent', id, `agent.${state}.v1`, actor, id, { previous_state: previous.state, ...payload });
    return current;
  }

  setAgentRecoveryPending(id, pending, actor = 'hub:recovery-reconciler', payload = {}) {
    const previous = this.getAgent(id);
    invariant(previous, 'WS_NOT_FOUND', 'Agent instance not found.', 404);
    const normalized = Boolean(pending);
    if (previous.recovery_pending === normalized) return previous;
    this.db.prepare('UPDATE agent_instances SET recovery_pending = ?, last_activity_at = ? WHERE id = ?')
      .run(Number(normalized), nowISO(), id);
    this.appendEvent('agent', id, normalized ? 'agent.recovery.pending.v1' : 'agent.recovery.cleared.v1', actor, id, payload);
    return this.getAgent(id);
  }

  updateAgentWorkStatus(id, status, summary, actor = `agent:${id}`) {
    invariant(['idle', 'working', 'blocked', 'completed'].includes(status), 'WS_VALIDATION', 'Invalid worker status.');
    invariant(typeof summary === 'string' && summary.trim().length > 0 && summary.length <= 4_000,
      'WS_VALIDATION', 'A status summary of at most 4000 characters is required.');
    invariant(this.getAgent(id), 'WS_NOT_FOUND', 'Agent instance not found.', 404);
    const updated = nowISO();
    this.db.prepare('UPDATE agent_instances SET work_status = ?, status_summary = ?, status_updated_at = ?, last_activity_at = ? WHERE id = ?')
      .run(status, summary.trim(), updated, updated, id);
    this.appendEvent('agent', id, 'agent.status.reported.v1', actor, id, { status, summary: summary.trim() });
    return this.getAgent(id);
  }

  getThread(id) {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id,
      project_id: row.project_id,
      primary_agent_instance_id: row.primary_agent_instance_id,
      title: row.title,
      status: row.status,
      last_message_sequence: row.last_message_sequence,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  listMessages(threadId, after = 0, limit = 200) {
    return this.db.prepare(`SELECT m.*, d.state AS delivery_state, d.delivered_at, d.failure_reason
      FROM messages m LEFT JOIN message_deliveries d ON d.message_id = m.id
      WHERE m.thread_id = ? AND m.sequence > ? ORDER BY m.sequence LIMIT ?`)
      .all(threadId, after, limit).map(messageRow);
  }

  getMessage(id) {
    const row = this.db.prepare(`SELECT m.*, d.state AS delivery_state, d.delivered_at, d.failure_reason
      FROM messages m LEFT JOIN message_deliveries d ON d.message_id = m.id WHERE m.id = ?`).get(id);
    return messageRow(row);
  }

  previousInboundMessage(threadId, beforeSequence) {
    const row = this.db.prepare(`SELECT m.*, d.state AS delivery_state, d.delivered_at, d.failure_reason
      FROM messages m LEFT JOIN message_deliveries d ON d.message_id = m.id
      WHERE m.thread_id = ? AND m.sequence < ? ORDER BY m.sequence DESC LIMIT 1`)
      .get(threadId, beforeSequence);
    return messageRow(row);
  }

  pendingDeliveries(nodeId = null) {
    const sql = `SELECT d.message_id, d.recipient_agent_instance_id, d.state, a.node_id
      FROM message_deliveries d JOIN agent_instances a ON a.id = d.recipient_agent_instance_id
      WHERE d.state IN ('accepted','queued','waking') ${nodeId ? 'AND a.node_id = ?' : ''}
      ORDER BY d.last_attempt_at, d.id`;
    return (nodeId ? this.db.prepare(sql).all(nodeId) : this.db.prepare(sql).all()).map((row) => ({
      ...row,
      message: this.getMessage(row.message_id),
    }));
  }

  createMessage({
    threadId, actorId, deliveryRole = 'user', displaySender, contentParts,
    replyToMessageId = null, taskId = null, traceId = makeId('trc'), hopCount = 0,
    priority = 0, wakePolicy = 'ensure_running', idempotencyKey,
  }) {
    invariant(idempotencyKey, 'WS_IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required.', 400);
    invariant(['user', 'assistant', 'tool'].includes(deliveryRole), 'WS_FORBIDDEN', 'Requested delivery role is not permitted.', 403);
    const prior = this.db.prepare('SELECT * FROM messages WHERE thread_id = ? AND idempotency_key = ?')
      .get(threadId, idempotencyKey);
    if (prior) return { message: this.getMessage(prior.id), duplicate: true };
    const thread = this.getThread(threadId);
    invariant(thread, 'WS_NOT_FOUND', 'Thread not found.', 404);
    const recipient = this.getAgent(thread.primary_agent_instance_id);
    invariant(recipient && !recipient.project_archived_at, 'WS_PROJECT_ARCHIVED', 'Archived projects cannot receive messages.', 409);
    invariant(Array.isArray(contentParts) && contentParts.length > 0, 'WS_VALIDATION', 'Message content is required.');
    invariant(hopCount <= 16, 'WS_TRIGGER_LOOP_LIMIT', 'Message hop limit exceeded.', 429);
    const messageId = makeId('msg');
    const deliveryId = makeId('mdl');
    const created = nowISO();
    let sequence;
    this.transaction(() => {
      sequence = Number(this.db.prepare('SELECT last_message_sequence FROM threads WHERE id = ?').get(threadId).last_message_sequence) + 1;
      this.db.prepare(`INSERT INTO messages
        (id, thread_id, sequence, task_id, authenticated_actor_id, delivery_role, display_sender,
         content_parts_json, reply_to_message_id, trace_id, hop_count, priority, wake_policy,
         idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(messageId, threadId, sequence, taskId, actorId, deliveryRole, displaySender || actorId,
          encode(contentParts), replyToMessageId, traceId, hopCount, priority, wakePolicy,
          idempotencyKey, created);
      this.db.prepare(`INSERT INTO message_deliveries
        (id, message_id, recipient_agent_instance_id, state) VALUES (?, ?, ?, 'accepted')`)
        .run(deliveryId, messageId, thread.primary_agent_instance_id);
      this.db.prepare('UPDATE threads SET last_message_sequence = ?, updated_at = ? WHERE id = ?')
        .run(sequence, created, threadId);
    });
    const message = messageRow(this.db.prepare(`SELECT m.*, d.state AS delivery_state
      FROM messages m JOIN message_deliveries d ON d.message_id = m.id WHERE m.id = ?`).get(messageId));
    this.appendEvent('thread', threadId, 'message.accepted.v1', actorId, messageId, message, traceId);
    return { message, duplicate: false };
  }

  updateMessageDelivery(messageId, state, receipt = null, failureReason = null) {
    const now = nowISO();
    this.db.prepare(`UPDATE message_deliveries SET state = ?, adapter_receipt_json = ?,
      attempt_count = attempt_count + 1, last_attempt_at = ?, delivered_at = ?, failed_at = ?, failure_reason = ?
      WHERE message_id = ?`)
      .run(state, encode(receipt), now, state === 'adapter_accepted' ? now : null,
        state === 'failed' ? now : null, failureReason, messageId);
  }

  createTask({
    id = makeId('tsk'), projectId, parentTaskId = null, type = 'command', title,
    specification = {}, desiredAgentProfileId = null, assignedAgentInstanceId = null,
    nodeId = null, priority = 0, retryPolicy = {}, createdBy = 'owner:local',
  }) {
    const project = this.getProject(projectId);
    invariant(project, 'WS_VALIDATION', 'Project does not exist.');
    invariant(!project.archived_at, 'WS_PROJECT_ARCHIVED', 'Archived projects cannot accept new tasks.', 409);
    if (parentTaskId) {
      invariant(parentTaskId !== id, 'WS_TASK_CONFLICT', 'A task cannot depend on itself.', 409);
      invariant(this.getTask(parentTaskId), 'WS_VALIDATION', 'Parent task does not exist.');
    }
    const now = nowISO();
    this.db.prepare(`INSERT INTO tasks
      (id, project_id, parent_task_id, type, title, specification_json, desired_agent_profile_id,
       assigned_agent_instance_id, node_id, priority, state, retry_policy_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
      .run(id, projectId, parentTaskId, type, title, encode(specification), desiredAgentProfileId,
        assignedAgentInstanceId, nodeId, priority, encode(retryPolicy), createdBy, now, now);
    const task = this.getTask(id);
    this.appendEvent('task', id, 'task.created.v1', createdBy, id, task);
    return task;
  }

  getTask(id) {
    return taskRow(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
  }

  listTasks(projectId = null, state = null) {
    const conditions = [];
    const args = [];
    if (projectId) { conditions.push('project_id = ?'); args.push(projectId); }
    if (state) { conditions.push('state = ?'); args.push(state); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM tasks ${where} ORDER BY priority DESC, created_at DESC`).all(...args).map(taskRow);
  }

  setTaskState(id, state, result = null, actor = 'hub:scheduler') {
    const task = this.getTask(id);
    invariant(task, 'WS_NOT_FOUND', 'Task not found.', 404);
    this.db.prepare('UPDATE tasks SET state = ?, result_json = COALESCE(?, result_json), updated_at = ? WHERE id = ?')
      .run(state, result == null ? null : encode(result), nowISO(), id);
    const updated = this.getTask(id);
    this.appendEvent('task', id, `task.${state}.v1`, actor, id, { result: updated.result, previous_state: task.state });
    return updated;
  }

  updateTaskSpecification(id, specification, actor = 'hub:scheduler') {
    const task = this.getTask(id);
    invariant(task, 'WS_NOT_FOUND', 'Task not found.', 404);
    invariant(specification && typeof specification === 'object' && !Array.isArray(specification),
      'WS_VALIDATION', 'Task specification must be an object.');
    this.db.prepare('UPDATE tasks SET specification_json = ?, updated_at = ? WHERE id = ?')
      .run(encode(specification), nowISO(), id);
    const updated = this.getTask(id);
    this.appendEvent('task', id, 'task.updated.v1', actor, id, {
      previous_specification: task.specification,
      specification: updated.specification,
    });
    return updated;
  }

  createTaskAttempt(taskId, nodeId, agentInstanceId, connectionEpoch, leaseToken) {
    const prior = this.db.prepare('SELECT MAX(attempt_number) AS n FROM task_attempts WHERE task_id = ?').get(taskId);
    const attempt = Number(prior.n || 0) + 1;
    const id = makeId('tat');
    const now = nowISO();
    this.db.prepare(`INSERT INTO task_attempts
      (id, task_id, attempt_number, node_id, agent_instance_id, lease_token, connection_epoch, state, started_at, heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`)
      .run(id, taskId, attempt, nodeId, agentInstanceId, leaseToken, connectionEpoch, now, now);
    return { id, task_id: taskId, attempt_number: attempt, lease_token: leaseToken, connection_epoch: connectionEpoch };
  }

  completeTaskAttempt(taskId, exitStatus, failureKind = null) {
    this.db.prepare(`UPDATE task_attempts SET state = ?, completed_at = ?, exit_status = ?, failure_kind = ?
      WHERE id = (SELECT id FROM task_attempts WHERE task_id = ? ORDER BY attempt_number DESC LIMIT 1)`)
      .run(exitStatus === 0 ? 'succeeded' : 'failed', nowISO(), exitStatus, failureKind, taskId);
  }

  getRoot(id) {
    const row = this.db.prepare('SELECT * FROM workspace_roots WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id,
      node_root_id: row.node_root_id || row.id,
      agent_instance_id: row.agent_instance_id,
      project_id: row.project_id,
      node_id: row.node_id,
      logical_name: row.logical_name,
      access_mode: row.access_mode,
      expose_in_portal: bool(row.expose_in_portal),
      allow_download: bool(row.allow_download),
      allow_search: bool(row.allow_search),
      allow_preview: bool(row.allow_preview),
      symlink_policy: row.symlink_policy,
      mount_policy: row.mount_policy,
      created_at: row.created_at,
      revoked_at: row.revoked_at,
      logical_uri: `workspace://${row.agent_instance_id}/${row.logical_name}`,
    };
  }

  listAgentRoots(agentId) {
    return this.db.prepare(`SELECT id FROM workspace_roots
      WHERE agent_instance_id = ? AND expose_in_portal = 1 AND revoked_at IS NULL ORDER BY logical_name`)
      .all(agentId).map((row) => this.getRoot(row.id));
  }

  getTerminal(id) {
    const row = this.db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get(id);
    if (!row) return null;
    return {
      id: row.id,
      agent_instance_id: row.agent_instance_id,
      node_id: row.node_id,
      kind: row.kind,
      state: row.state,
      canonical_columns: row.canonical_columns,
      canonical_rows: row.canonical_rows,
      created_at: row.created_at,
      exited_at: row.exited_at,
      label: row.label || 'Terminal',
    };
  }

  createTaskTerminal(agentInstanceId, label = 'Task') {
    const agent = this.getAgent(agentInstanceId);
    invariant(agent, 'WS_NOT_FOUND', 'Agent instance not found.', 404);
    const id = makeId('trm');
    this.db.prepare(`INSERT INTO terminal_sessions
      (id, agent_instance_id, node_id, kind, state, label, created_at)
      VALUES (?, ?, ?, 'task_shell', 'detached', ?, ?)`)
      .run(id, agentInstanceId, agent.node_id, String(label || 'Task').slice(0, 80), nowISO());
    return this.getTerminal(id);
  }

  createInteractiveTerminal(agentInstanceId, label = 'Shell') {
    const agent = this.getAgent(agentInstanceId);
    invariant(agent, 'WS_NOT_FOUND', 'Agent instance not found.', 404);
    invariant(typeof label === 'string' && label.trim().length > 0 && label.length <= 80,
      'WS_VALIDATION', 'A terminal label of at most 80 characters is required.');
    const id = makeId('trm');
    this.db.prepare(`INSERT INTO terminal_sessions
      (id, agent_instance_id, node_id, kind, state, label, created_at)
      VALUES (?, ?, ?, 'shell_tab', 'detached', ?, ?)`)
      .run(id, agentInstanceId, agent.node_id, label.trim(), nowISO());
    return this.getTerminal(id);
  }

  listAgentTerminals(agentInstanceId) {
    return this.db.prepare('SELECT id FROM terminal_sessions WHERE agent_instance_id = ? ORDER BY created_at')
      .all(agentInstanceId).map((row) => this.getTerminal(row.id));
  }

  deleteAuxiliaryTerminal(id) {
    const terminal = this.getTerminal(id);
    invariant(terminal, 'WS_NOT_FOUND', 'Terminal not found.', 404);
    invariant(['shell_tab', 'task_shell'].includes(terminal.kind), 'WS_FORBIDDEN', 'The primary agent terminal cannot be deleted.', 403);
    this.transaction(() => {
      this.db.prepare('DELETE FROM terminal_leases WHERE terminal_id = ?').run(id);
      this.db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(id);
    });
    return terminal;
  }

  setTerminalState(id, state) {
    this.db.prepare('UPDATE terminal_sessions SET state = ?, exited_at = ? WHERE id = ?')
      .run(state, state === 'exited' ? nowISO() : null, id);
  }

  acquireTerminalLease(terminalId, principalId, ttlMs = 15_000) {
    invariant(this.getTerminal(terminalId), 'WS_NOT_FOUND', 'Terminal not found.', 404);
    const now = new Date();
    const existing = this.db.prepare('SELECT * FROM terminal_leases WHERE terminal_id = ?').get(terminalId);
    if (existing && new Date(existing.expires_at) > now && existing.principal_id !== principalId) {
      throw new WebSpiderError('WS_TERMINAL_LEASE_REQUIRED', 'Terminal is controlled by another client.', 409, {
        controller: existing.principal_id,
        expires_at: existing.expires_at,
      });
    }
    const epoch = Number(existing?.lease_epoch || 0) + 1;
    const lease = {
      id: makeId('tls'),
      terminal_id: terminalId,
      principal_id: principalId,
      lease_epoch: epoch,
      acquired_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    };
    this.transaction(() => {
      this.db.prepare('DELETE FROM terminal_leases WHERE terminal_id = ?').run(terminalId);
      this.db.prepare(`INSERT INTO terminal_leases
        (id, terminal_id, principal_id, lease_epoch, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(lease.id, terminalId, principalId, epoch, lease.acquired_at, lease.expires_at);
    });
    return lease;
  }

  validateTerminalLease(terminalId, leaseId, epoch, principalId, renew = true) {
    const lease = this.db.prepare('SELECT * FROM terminal_leases WHERE terminal_id = ?').get(terminalId);
    invariant(lease, 'WS_TERMINAL_LEASE_REQUIRED', 'Take control before sending terminal input.', 409);
    invariant(lease.id === leaseId && Number(lease.lease_epoch) === Number(epoch) && lease.principal_id === principalId,
      'WS_TERMINAL_LEASE_STALE', 'Terminal control lease is stale.', 409);
    // An expired row may be renewed by its exact prior controller when nobody has taken
    // it over. A takeover replaces the row/id/epoch above, so the old client stays fenced.
    // This prevents background-tab timer throttling from discarding the first new key.
    invariant(renew || new Date(lease.expires_at) > new Date(),
      'WS_TERMINAL_LEASE_STALE', 'Terminal control lease expired.', 409);
    if (renew) {
      lease.expires_at = new Date(Date.now() + 15_000).toISOString();
      this.db.prepare('UPDATE terminal_leases SET expires_at = ? WHERE id = ?').run(lease.expires_at, lease.id);
    }
    return lease;
  }

  releaseTerminalLease(terminalId, leaseId, principalId) {
    const result = this.db.prepare('DELETE FROM terminal_leases WHERE terminal_id = ? AND id = ? AND principal_id = ?')
      .run(terminalId, leaseId, principalId);
    return result.changes > 0;
  }

  appendEvent(scopeType, scopeId, type, actorId, subjectId, payload = {}, traceId = makeId('trc')) {
    const last = this.db.prepare('SELECT MAX(scope_sequence) AS sequence FROM events WHERE scope_type = ? AND scope_id = ?')
      .get(scopeType, scopeId);
    const event = {
      id: makeId('evt'),
      scope_type: scopeType,
      scope_id: scopeId,
      scope_sequence: Number(last.sequence || 0) + 1,
      type,
      version: 1,
      actor_id: actorId,
      subject_id: subjectId,
      trace_id: traceId,
      hub_timestamp: nowISO(),
      payload,
    };
    const result = this.db.prepare(`INSERT INTO events
      (id, scope_type, scope_id, scope_sequence, type, version, actor_id, subject_id, trace_id, hub_timestamp, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.id, event.scope_type, event.scope_id, event.scope_sequence, event.type, event.version,
        event.actor_id, event.subject_id, event.trace_id, event.hub_timestamp, encode(event.payload));
    event.global_sequence = Number(result.lastInsertRowid);
    queueMicrotask(() => this.emit('event', event));
    return event;
  }

  listEvents(after = 0, filters = {}, limit = 500) {
    const conditions = ['global_sequence > ?'];
    const args = [after];
    if (filters.project) {
      conditions.push(`(scope_id = ? OR json_extract(payload_json, '$.project_id') = ?)`);
      args.push(filters.project, filters.project);
    }
    if (filters.agent) {
      conditions.push(`(scope_id = ? OR json_extract(payload_json, '$.agent_instance_id') = ?)`);
      args.push(filters.agent, filters.agent);
    }
    args.push(limit);
    return this.db.prepare(`SELECT * FROM events WHERE ${conditions.join(' AND ')}
      ORDER BY global_sequence LIMIT ?`).all(...args).map(eventRow);
  }

  getOutbox(id) {
    const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
    return row ? {
      ...row,
      payload: decode(row.payload_json, {}),
      result: decode(row.result_json),
    } : null;
  }

  createOutbox(nodeId, commandType, payload, id = makeId('cmd')) {
    const createdAt = nowISO();
    this.db.prepare(`INSERT OR IGNORE INTO outbox
      (id, node_id, command_type, payload_json, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`)
      .run(id, nodeId, commandType, encode(payload), createdAt);
    return this.getOutbox(id);
  }

  markOutboxSent(id, epoch) {
    this.db.prepare(`UPDATE outbox SET state = 'sent', connection_epoch = ?, attempts = attempts + 1, sent_at = ? WHERE id = ?`)
      .run(epoch, nowISO(), id);
  }

  markOutboxResult(id, result, error = null) {
    this.db.prepare(`UPDATE outbox SET state = ?, acknowledged_at = ?, result_json = ?, failure_reason = ? WHERE id = ?`)
      .run(error ? 'failed' : 'acknowledged', nowISO(), encode(result), error, id);
  }

  pendingOutbox(nodeId) {
    return this.db.prepare(`SELECT * FROM outbox WHERE node_id = ? AND state IN ('pending','sent') ORDER BY created_at`)
      .all(nodeId).map((row) => ({ ...row, payload: decode(row.payload_json, {}), result: decode(row.result_json) }));
  }

  audit({ actorId, action, targetType, targetId, projectId = null, decision = 'allowed', previousState = null, newState = null, traceId = makeId('trc') }) {
    const record = { id: makeId('aud'), actor_id: actorId, action, target_type: targetType, target_id: targetId,
      project_id: projectId, decision, trace_id: traceId, created_at: nowISO() };
    this.db.prepare(`INSERT INTO audit_log
      (id, actor_id, action, target_type, target_id, project_id, decision, previous_state_json,
       new_state_json, trace_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, actorId, action, targetType, targetId, projectId, decision,
        encode(previousState), encode(newState), traceId, record.created_at);
    return record;
  }

  listAudit(limit = 200) {
    return this.db.prepare('SELECT * FROM audit_log ORDER BY sequence DESC LIMIT ?').all(limit).map((row) => ({
      ...row,
      previous_state: decode(row.previous_state_json),
      new_state: decode(row.new_state_json),
      previous_state_json: undefined,
      new_state_json: undefined,
    }));
  }

  listAttention() {
    return this.db.prepare('SELECT * FROM attention_items WHERE resolved_at IS NULL ORDER BY created_at DESC').all().map((row) => ({
      id: row.id,
      project_id: row.project_id,
      agent_instance_id: row.agent_instance_id,
      task_id: row.task_id,
      type: row.type,
      severity: row.severity,
      summary: row.summary,
      actions: decode(row.actions_json, []),
      created_at: row.created_at,
    }));
  }

  createArtifact(input) {
    const artifact = {
      id: makeId('art'),
      project_id: input.projectId,
      task_id: input.taskId || null,
      agent_instance_id: input.agentInstanceId || null,
      kind: input.kind || 'file',
      logical_name: input.logicalName,
      sha256: input.sha256,
      size_bytes: input.sizeBytes,
      mime_type: input.mimeType || 'application/octet-stream',
      storage_locator: input.storageLocator,
      source_root_id: input.sourceRootId || null,
      source_relative_path: input.sourceRelativePath || null,
      created_at: nowISO(),
    };
    this.db.prepare(`INSERT INTO artifacts
      (id, project_id, task_id, agent_instance_id, kind, logical_name, sha256, size_bytes, mime_type,
       storage_locator, source_root_id, source_relative_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...Object.values(artifact));
    this.appendEvent('artifact', artifact.id, 'artifact.created.v1', input.actorId || 'hub:artifact-service', artifact.id, artifact);
    return artifact;
  }

  getArtifact(id) {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
    return row || null;
  }

  listArtifacts(projectId = null, agentInstanceId = null) {
    const conditions = [];
    const args = [];
    if (projectId) { conditions.push('project_id = ?'); args.push(projectId); }
    if (agentInstanceId) { conditions.push('agent_instance_id = ?'); args.push(agentInstanceId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM artifacts ${where} ORDER BY created_at DESC`).all(...args);
  }

  countSummary() {
    const value = (sql, ...args) => Number(this.db.prepare(sql).get(...args).n || 0);
    return {
      projects_active: value('SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NULL'),
      projects_archived: value('SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NOT NULL'),
      tasks_running: value("SELECT COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.state = 'running' AND p.archived_at IS NULL"),
      awaiting_approval: value('SELECT COUNT(*) AS n FROM attention_items WHERE resolved_at IS NULL'),
      nodes_offline: value("SELECT COUNT(*) AS n FROM nodes WHERE status = 'offline'"),
      agents_active: value("SELECT COUNT(*) AS n FROM agent_instances a JOIN projects p ON p.id = a.project_id WHERE a.state IN ('ready','busy','starting','stopping') AND p.archived_at IS NULL"),
    };
  }
}
