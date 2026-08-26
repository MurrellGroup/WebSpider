import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { nowISO } from '../lib/ids.js';

function decode(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export class NodeDatabase {
  constructor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY,
        connection_epoch INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,
        received_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS processes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        agent_instance_id TEXT,
        context_id TEXT,
        task_id TEXT,
        terminal_id TEXT,
        root_id TEXT,
        argv_json TEXT NOT NULL,
        pid INTEGER NOT NULL,
        pgid INTEGER NOT NULL,
        keeper_pid INTEGER,
        host_boot_id TEXT,
        process_identity TEXT,
        keeper_process_identity TEXT,
        input_fifo TEXT NOT NULL,
        output_log TEXT NOT NULL,
        exit_file TEXT NOT NULL,
        state TEXT NOT NULL,
        output_offset INTEGER NOT NULL DEFAULT 0,
        completion_reported INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_spool (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
    `);
    const processColumns = this.db.prepare('PRAGMA table_info(processes)').all().map((column) => column.name);
    if (!processColumns.includes('keeper_pid')) this.db.exec('ALTER TABLE processes ADD COLUMN keeper_pid INTEGER');
    if (!processColumns.includes('host_boot_id')) this.db.exec('ALTER TABLE processes ADD COLUMN host_boot_id TEXT');
    if (!processColumns.includes('process_identity')) this.db.exec('ALTER TABLE processes ADD COLUMN process_identity TEXT');
    if (!processColumns.includes('keeper_process_identity')) this.db.exec('ALTER TABLE processes ADD COLUMN keeper_process_identity TEXT');
    if (!processColumns.includes('context_id')) this.db.exec('ALTER TABLE processes ADD COLUMN context_id TEXT');
    this.db.exec('UPDATE processes SET context_id = agent_instance_id WHERE context_id IS NULL AND agent_instance_id IS NOT NULL');
  }

  close() { this.db.close(); }

  getCommand(id) {
    const row = this.db.prepare('SELECT * FROM commands WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, payload: decode(row.payload_json, {}), result: decode(row.result_json), error: decode(row.error_json) };
  }

  acceptCommand(id, epoch, type, payload) {
    const prior = this.getCommand(id);
    if (prior) return { duplicate: true, command: prior };
    this.db.prepare(`INSERT INTO commands
      (id, connection_epoch, type, payload_json, state, received_at) VALUES (?, ?, ?, ?, 'received', ?)`)
      .run(id, epoch, type, JSON.stringify(payload), nowISO());
    return { duplicate: false, command: this.getCommand(id) };
  }

  completeCommand(id, result, error = null) {
    this.db.prepare(`UPDATE commands SET state = ?, result_json = ?, error_json = ?, completed_at = ? WHERE id = ?`)
      .run(error ? 'failed' : 'completed', JSON.stringify(result ?? null), JSON.stringify(error ?? null), nowISO(), id);
  }

  upsertProcess(process) {
    this.db.prepare(`INSERT INTO processes
      (id, kind, agent_instance_id, context_id, task_id, terminal_id, root_id, argv_json, pid, pgid, keeper_pid,
       host_boot_id, process_identity, keeper_process_identity, input_fifo, output_log, exit_file, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET pid=excluded.pid, pgid=excluded.pgid, state=excluded.state,
        keeper_pid=excluded.keeper_pid, host_boot_id=excluded.host_boot_id,
        process_identity=excluded.process_identity, keeper_process_identity=excluded.keeper_process_identity,
        context_id=COALESCE(processes.context_id, excluded.context_id),
        updated_at=excluded.updated_at`)
      .run(process.id, process.kind, process.agentInstanceId || null, process.contextId || process.agentInstanceId || null, process.taskId || null,
        process.terminalId || null, process.rootId || null, JSON.stringify(process.argv), process.pid,
        process.pgid, process.keeperPid || null, process.hostBootId || null, process.processIdentity || null,
        process.keeperProcessIdentity || null,
        process.inputFifo, process.outputLog, process.exitFile, process.state, process.createdAt, nowISO());
  }

  listProcesses() {
    return this.db.prepare('SELECT * FROM processes ORDER BY created_at').all().map((row) => ({
      id: row.id,
      kind: row.kind,
      agentInstanceId: row.agent_instance_id,
      contextId: row.context_id || row.agent_instance_id || null,
      taskId: row.task_id,
      terminalId: row.terminal_id,
      rootId: row.root_id,
      argv: decode(row.argv_json, []),
      pid: Number(row.pid),
      pgid: Number(row.pgid),
      keeperPid: row.keeper_pid == null ? null : Number(row.keeper_pid),
      hostBootId: row.host_boot_id || null,
      processIdentity: row.process_identity || null,
      keeperProcessIdentity: row.keeper_process_identity || null,
      inputFifo: row.input_fifo,
      outputLog: row.output_log,
      exitFile: row.exit_file,
      state: row.state,
      outputOffset: Number(row.output_offset),
      completionReported: Boolean(row.completion_reported),
      createdAt: row.created_at,
    }));
  }

  getProcess(id) {
    return this.listProcesses().find((process) => process.id === id) || null;
  }

  getProcessByTerminal(terminalId) {
    const row = this.db.prepare('SELECT id FROM processes WHERE terminal_id = ? ORDER BY created_at DESC LIMIT 1').get(terminalId);
    return row ? this.getProcess(row.id) : null;
  }

  getProcessByAgent(agentId) {
    const row = this.db.prepare("SELECT id FROM processes WHERE agent_instance_id = ? AND kind = 'agent' ORDER BY created_at DESC LIMIT 1").get(agentId);
    return row ? this.getProcess(row.id) : null;
  }

  claimProcess(id, { expectedAgentInstanceId, agentInstanceId, terminalId, rootId }) {
    const result = this.db.prepare(`UPDATE processes
      SET agent_instance_id = ?, terminal_id = ?, root_id = ?, updated_at = ?
      WHERE id = ? AND agent_instance_id = ? AND kind = 'agent' AND state = 'running'`)
      .run(agentInstanceId, terminalId, rootId, nowISO(), id, expectedAgentInstanceId);
    return Number(result.changes) === 1 ? this.getProcess(id) : null;
  }

  updateProcessOffset(id, offset) {
    this.db.prepare('UPDATE processes SET output_offset = ?, updated_at = ? WHERE id = ?').run(offset, nowISO(), id);
  }

  finishProcess(id, state, reported = false) {
    this.db.prepare('UPDATE processes SET state = ?, completion_reported = ?, updated_at = ? WHERE id = ?')
      .run(state, Number(reported), nowISO(), id);
  }

  markCompletionReported(id) {
    this.db.prepare('UPDATE processes SET completion_reported = 1, updated_at = ? WHERE id = ?').run(nowISO(), id);
  }

  spoolEvent(id, type, payload) {
    this.db.prepare(`INSERT OR IGNORE INTO event_spool
      (id, type, payload_json, state, created_at) VALUES (?, ?, ?, 'pending', ?)`)
      .run(id, type, JSON.stringify(payload), nowISO());
  }

  pendingEvents() {
    return this.db.prepare(`SELECT * FROM event_spool WHERE state = 'pending' ORDER BY sequence`).all().map((row) => ({
      id: row.id,
      type: row.type,
      payload: decode(row.payload_json, {}),
      created_at: row.created_at,
    }));
  }

  markEventSent(id) {
    this.db.prepare(`UPDATE event_spool SET state = 'sent', sent_at = ? WHERE id = ?`).run(nowISO(), id);
  }
}
