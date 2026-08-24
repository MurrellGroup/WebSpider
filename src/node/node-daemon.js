import { EventEmitter } from 'node:events';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { NodeDatabase } from '../db/node-database.js';
import { RootedFileService } from './root-fs.js';
import { ProcessSupervisor } from './process-supervisor.js';
import { makeId, nowISO } from '../lib/ids.js';
import { signNodeHello } from '../lib/security.js';
import { WebSpiderError } from '../lib/errors.js';

function websocketURL(hubURL) {
  const url = new URL('/api/v1/node/connect', hubURL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function serializeError(error) {
  return {
    code: error?.code || 'WS_NODE_ERROR',
    message: error?.message || 'Node command failed.',
    status: error?.status || 500,
    details: error?.details,
  };
}

function elapsedLabel(milliseconds) {
  if (milliseconds == null) return 'first inbound message in this thread';
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!parts.length || (days === 0 && hours === 0)) parts.push(`${seconds}s`);
  return `${parts.join(' ')} since the previous inbound message`;
}

function accountQuotaLines(quota) {
  if (quota == null) return [];
  if (!quota.available) {
    return ['Weekly account allowance: not yet observed; use `/status` at the next natural breakpoint.'];
  }
  const state = quota.stale ? 'stale' : 'fresh';
  const reset = quota.resets_at ? `; resets ${quota.resets_at}` : '';
  return [
    `Weekly account allowance: ${quota.remaining_percent}% remaining (observed ${quota.observed_at} via ${quota.source}; ${state}${reset}).`,
  ];
}

export function formatInboundMessage(message, context = {}) {
  const text = (message?.content_parts || [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  const timestamp = context.message_timestamp_utc || message?.created_at || nowISO();
  const delivered = context.delivered_at_utc || timestamp;
  const source = String(context.source || message?.display_sender || message?.authenticated_actor_id || 'unknown')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 160);
  return [
    '[WebSpider inbound message]',
    `Message timestamp (UTC): ${timestamp}`,
    `Delivered (UTC): ${delivered}`,
    `Source: ${source}`,
    `Elapsed: ${elapsedLabel(context.elapsed_since_previous_message_ms)}`,
    ...accountQuotaLines(context.account_quota),
    '',
    text,
  ].join('\n');
}

export class NodeDaemon extends EventEmitter {
  constructor({ stateDir, hubURL, nodeId, displayName, publicKey, privateKey, roots = [], reconnect = true }) {
    super();
    this.stateDir = stateDir;
    this.hubURL = hubURL;
    this.nodeId = nodeId;
    this.displayName = displayName;
    this.publicKey = publicKey;
    this.privateKey = privateKey;
    this.roots = roots;
    this.reconnect = reconnect;
    this.database = new NodeDatabase(path.join(stateDir, 'node.db'));
    this.rootService = new RootedFileService(roots);
    this.supervisor = new ProcessSupervisor({ stateDir, database: this.database, rootService: this.rootService });
    this.socket = null;
    this.epoch = 0;
    this.stopped = true;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.backoffMs = 500;

    this.supervisor.on('output', (output) => this.#send({
      type: 'terminal_output',
      connection_epoch: this.epoch,
      terminal_id: output.terminal_id,
      sequence_start: output.sequence_start,
      sequence_end: output.sequence_end,
      data: output.bytes.toString('base64'),
    }));
    this.supervisor.on('state', (event) => this.#spoolEvent(event.type, event));
    this.supervisor.on('error', (error) => this.emit('error', error));
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.supervisor.start();
    this.#connect();
  }

  async stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.supervisor.stop();
    if (this.socket && this.socket.readyState < 2) this.socket.close(1000, 'Node stopping');
    this.rootService.close();
    this.database.close();
  }

  #connect() {
    if (this.stopped) return;
    const socket = new WebSocket(websocketURL(this.hubURL));
    this.socket = socket;
    socket.addEventListener('open', () => {
      const timestamp = Date.now();
      const nonce = randomBytes(18).toString('base64url');
      socket.send(JSON.stringify({
        type: 'hello',
        protocol_version: 1,
        node_id: this.nodeId,
        timestamp,
        nonce,
        signature: signNodeHello(this.privateKey, this.nodeId, timestamp, nonce),
        capabilities: this.#capabilities(),
        adapter_inventory: this.#adapterInventory(),
      }));
    });
    socket.addEventListener('message', (message) => {
      try {
        const frame = JSON.parse(String(message.data));
        this.#onFrame(frame).catch((error) => this.emit('error', error));
      } catch (error) {
        this.emit('error', error);
      }
    });
    socket.addEventListener('close', () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.epoch = 0;
      this.emit('offline');
      if (!this.stopped && this.reconnect) {
        this.reconnectTimer = setTimeout(() => this.#connect(), this.backoffMs);
        this.reconnectTimer.unref?.();
        this.backoffMs = Math.min(15_000, this.backoffMs * 2);
      }
    });
    socket.addEventListener('error', (error) => this.emit('error', error.error || error));
  }

  #capabilities() {
    return {
      os: process.platform,
      arch: process.arch,
      runtime: `node-${process.version}`,
      rooted_files: true,
      detached_processes: process.platform !== 'win32',
      terminal_transport: 'script+fifo',
      root_ids: this.roots.map((root) => root.id),
    };
  }

  #adapterInventory() {
    return [
      { kind: 'command', available: true },
      { kind: 'pty', available: process.platform !== 'win32', readiness: 'best_effort' },
      { kind: 'native', available: false },
      { kind: 'acp', available: false },
    ];
  }

  #send(frame) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  async #onFrame(frame) {
    if (frame.type === 'hello_ack') {
      this.epoch = Number(frame.connection_epoch);
      this.backoffMs = 500;
      this.emit('online', { connection_epoch: this.epoch });
      this.heartbeatTimer = setInterval(() => this.#send({
        type: 'heartbeat',
        connection_epoch: this.epoch,
        timestamp: Date.now(),
        capabilities: this.#capabilities(),
      }), frame.heartbeat_interval_ms || 5_000);
      this.heartbeatTimer.unref?.();
      for (const event of this.database.pendingEvents()) this.#sendEvent(event);
      return;
    }
    if (frame.type === 'node_event_ack') {
      this.database.markEventSent(frame.event_id);
      return;
    }
    if (frame.type === 'command') {
      if (Number(frame.connection_epoch) !== this.epoch) return;
      await this.#handleCommand(frame);
    }
  }

  async #handleCommand(frame) {
    const accepted = this.database.acceptCommand(frame.command_id, this.epoch, frame.command_type, frame.payload || {});
    if (accepted.duplicate && ['completed', 'failed'].includes(accepted.command.state)) {
      this.#send({
        type: 'command_receipt',
        connection_epoch: this.epoch,
        command_id: frame.command_id,
        result: accepted.command.result,
        error: accepted.command.error,
        duplicate: true,
      });
      return;
    }
    try {
      const result = await this.#dispatch(frame.command_type, frame.payload || {});
      this.database.completeCommand(frame.command_id, result);
      this.#send({ type: 'command_receipt', connection_epoch: this.epoch, command_id: frame.command_id, result });
    } catch (error) {
      const serialized = serializeError(error);
      this.database.completeCommand(frame.command_id, null, serialized);
      this.#send({ type: 'command_receipt', connection_epoch: this.epoch, command_id: frame.command_id, error: serialized });
    }
  }

  async #dispatch(type, payload) {
    switch (type) {
      case 'files.entries':
        return this.rootService.entries(payload.root_id, payload.path || '', payload.options || {});
      case 'files.stat':
        return this.rootService.stat(payload.root_id, payload.path || '');
      case 'files.preview':
        return this.rootService.preview(payload.root_id, payload.path);
      case 'files.download': {
        const file = await this.rootService.readFile(payload.root_id, payload.path, { maxBytes: payload.max_bytes });
        return { ...file, bytes: undefined, data: file.bytes.toString('base64') };
      }
      case 'files.search':
        return this.rootService.search(payload.root_id, payload.query, payload.path || '', payload.options || {});
      case 'files.git-status':
        return this.rootService.gitStatus(payload.root_id, payload.path || '');
      case 'process.start-agent': {
        const existing = this.database.getProcessByAgent(payload.agent_instance_id);
        if (existing && existing.state === 'running') return { runtime: existing, resumed: true };
        const runtime = this.supervisor.launch({
          kind: 'agent',
          agentInstanceId: payload.agent_instance_id,
          terminalId: payload.terminal_id,
          rootId: payload.root_id,
          argv: payload.argv,
          environment: payload.environment,
          policySnapshot: payload.policy_snapshot,
          agentControl: payload.agent_control,
        });
        return { runtime };
      }
      case 'process.stop-agent': {
        const runtime = this.database.getProcessByAgent(payload.agent_instance_id);
        if (!runtime) return { state: 'stopped', already_stopped: true };
        return this.supervisor.stopProcess(runtime.id, payload.signal || 'SIGTERM');
      }
      case 'task.start': {
        const existing = this.database.listProcesses().find((runtime) => runtime.taskId === payload.task_id);
        if (existing) return { runtime: existing, duplicate: true };
        const runtime = this.supervisor.launch({
          kind: 'task',
          taskId: payload.task_id,
          agentInstanceId: payload.agent_instance_id,
          terminalId: payload.terminal_id,
          rootId: payload.root_id,
          argv: payload.argv,
          environment: payload.environment,
        });
        return { runtime };
      }
      case 'task.cancel': {
        const runtime = this.database.listProcesses().find((item) => item.taskId === payload.task_id);
        if (!runtime) return { state: 'cancelled', already_stopped: true };
        return this.supervisor.stopProcess(runtime.id, 'SIGTERM');
      }
      case 'message.deliver': {
        const text = formatInboundMessage(payload.message, payload.delivery_context);
        const receipt = this.supervisor.message(payload.agent_instance_id, text);
        return { ...receipt, message_id: payload.message?.id, adapter: 'pty', certainty: 'best_effort' };
      }
      case 'terminal.input':
        return this.supervisor.input(payload.terminal_id, Buffer.from(payload.data || '', 'base64'));
      case 'terminal.snapshot':
        return this.supervisor.snapshot(payload.terminal_id, payload.max_bytes);
      default:
        throw new WebSpiderError('WS_NODE_COMMAND_UNSUPPORTED', `Unsupported node command: ${type}`, 400);
    }
  }

  #spoolEvent(type, payload) {
    const event = { id: makeId('nev'), type, payload, node_timestamp: nowISO() };
    this.database.spoolEvent(event.id, event.type, event);
    this.#sendEvent(event);
  }

  #sendEvent(event) {
    this.#send({ type: 'node_event', connection_epoch: this.epoch, event: event.payload?.id ? event.payload : event });
  }
}
