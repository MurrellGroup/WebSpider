import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { WebSpiderError, invariant } from '../lib/errors.js';
import { verifyNodeHello } from '../lib/security.js';

const TRANSIENT_COMMANDS = new Set([
  'terminal.input',
  'terminal.resize',
  'terminal.snapshot',
]);

function replayableCommand(commandType) {
  return !TRANSIENT_COMMANDS.has(commandType) && !commandType.startsWith('files.');
}

function durableCommandId(commandType, idempotencyKey) {
  const digest = createHash('sha256').update(commandType).update('\0').update(String(idempotencyKey)).digest('base64url');
  return `cmd_${digest.slice(0, 40)}`;
}

export class NodeBroker extends EventEmitter {
  constructor(database) {
    super();
    this.database = database;
    this.connections = new Map();
    this.pending = new Map();
    this.nonces = new Map();
  }

  attach(connection) {
    let authenticated = null;
    const authTimer = setTimeout(() => connection.close(1008, 'Authentication timeout'), 10_000);
    authTimer.unref?.();

    connection.on('text', (text) => {
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        connection.close(1007, 'Invalid JSON');
        return;
      }
      if (!authenticated) {
        if (frame.type !== 'hello') {
          connection.close(1008, 'Authentication required');
          return;
        }
        try {
          authenticated = this.#authenticate(frame, connection);
          clearTimeout(authTimer);
        } catch (error) {
          connection.close(1008, error.message);
        }
        return;
      }
      this.#handleFrame(authenticated, frame);
    });

    connection.on('close', () => {
      clearTimeout(authTimer);
      if (!authenticated) return;
      const current = this.connections.get(authenticated.nodeId);
      if (current?.connection === connection && current.epoch === authenticated.epoch) {
        this.#rejectPending(authenticated.nodeId, authenticated.epoch);
        this.connections.delete(authenticated.nodeId);
        this.database.disconnectNode(authenticated.nodeId, authenticated.epoch);
        this.database.appendEvent('node', authenticated.nodeId, 'node.offline.v1', 'hub:connection', authenticated.nodeId, {
          node_id: authenticated.nodeId,
          connection_epoch: authenticated.epoch,
        });
      }
    });

    connection.on('error', (error) => this.emit('error', error));
  }

  #authenticate(frame, connection) {
    const { node_id: nodeId, timestamp, nonce, signature } = frame;
    invariant(nodeId && timestamp && nonce && signature, 'WS_AUTH_REQUIRED', 'Incomplete node handshake.', 401);
    invariant(Math.abs(Date.now() - Number(timestamp)) < 60_000, 'WS_AUTH_REQUIRED', 'Node handshake expired.', 401);
    const nonceKey = `${nodeId}:${nonce}`;
    invariant(!this.nonces.has(nonceKey), 'WS_AUTH_REQUIRED', 'Node handshake replayed.', 401);
    const node = this.database.getNode(nodeId, true);
    invariant(node, 'WS_AUTH_REQUIRED', 'Unknown node.', 401);
    invariant(!node.revoked_at, 'WS_NODE_REVOKED', 'Node is revoked.', 403);
    invariant(verifyNodeHello(node.public_key, nodeId, timestamp, nonce, signature), 'WS_AUTH_REQUIRED', 'Invalid node signature.', 401);
    this.nonces.set(nonceKey, Date.now());
    for (const [key, usedAt] of this.nonces) if (Date.now() - usedAt > 120_000) this.nonces.delete(key);

    const connected = this.database.connectNode(nodeId, frame.capabilities || {}, frame.adapter_inventory || []);
    const prior = this.connections.get(nodeId);
    if (prior) prior.connection.close(1008, 'Replaced by newer connection');
    const state = { nodeId, epoch: connected.connection_epoch, connection };
    this.connections.set(nodeId, state);
    connection.sendJSON({
      type: 'hello_ack',
      protocol_version: 1,
      node_id: nodeId,
      connection_epoch: state.epoch,
      heartbeat_interval_ms: 5_000,
    });
    const runtimeInventory = Array.isArray(frame.runtime_inventory)
      ? frame.runtime_inventory.slice(0, 1_000).filter((runtime) => runtime && typeof runtime === 'object').map((runtime) => ({
        id: String(runtime.id || '').slice(0, 160),
        kind: runtime.kind === 'task' ? 'task' : 'agent',
        agent_instance_id: runtime.agent_instance_id ? String(runtime.agent_instance_id).slice(0, 160) : null,
        task_id: runtime.task_id ? String(runtime.task_id).slice(0, 160) : null,
        terminal_id: runtime.terminal_id ? String(runtime.terminal_id).slice(0, 160) : null,
        root_id: runtime.root_id ? String(runtime.root_id).slice(0, 160) : null,
        executable: runtime.executable ? String(runtime.executable).slice(0, 160) : null,
        state: ['running', 'stopping', 'exited', 'failed', 'lost'].includes(runtime.state) ? runtime.state : 'lost',
        created_at: Number.isFinite(Date.parse(runtime.created_at)) ? new Date(runtime.created_at).toISOString() : null,
      })).filter((runtime) => runtime.id)
      : [];
    this.database.appendEvent('node', nodeId, 'node.online.v1', `node:${nodeId}`, nodeId, {
      node_id: nodeId,
      connection_epoch: state.epoch,
      capabilities: frame.capabilities || {},
      runtime_inventory: runtimeInventory,
    });
    this.#replay(nodeId).catch((error) => this.emit('error', error));
    return state;
  }

  #handleFrame(state, frame) {
    const current = this.connections.get(state.nodeId);
    if (!current || current.epoch !== state.epoch) return;
    if (frame.connection_epoch != null && Number(frame.connection_epoch) !== state.epoch) {
      state.connection.close(1008, 'Stale connection epoch');
      return;
    }
    if (frame.type === 'heartbeat') {
      this.database.heartbeatNode(state.nodeId, frame);
      state.connection.sendJSON({ type: 'heartbeat_ack', connection_epoch: state.epoch, timestamp: Date.now() });
      return;
    }
    if (frame.type === 'command_receipt') {
      const pending = this.pending.get(frame.command_id);
      if (pending && (pending.nodeId !== state.nodeId || pending.epoch !== state.epoch)) return;
      const durable = pending?.transient ? null : this.database.getOutbox(frame.command_id);
      if (!pending && frame.transient) return;
      if (durable?.node_id && durable.node_id !== state.nodeId) return;
      if (durable) this.database.markOutboxResult(frame.command_id, frame.result, frame.error?.message || null);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(frame.command_id);
        if (frame.error) pending.reject(new WebSpiderError(frame.error.code || 'WS_NODE_ERROR', frame.error.message || 'Node command failed.', frame.error.status || 500, frame.error.details));
        else pending.resolve(frame.result);
      }
      return;
    }
    if (frame.type === 'terminal_output') {
      this.emit('terminal.output', {
        node_id: state.nodeId,
        terminal_id: frame.terminal_id,
        sequence_start: frame.sequence_start,
        sequence_end: frame.sequence_end,
        bytes: Buffer.from(frame.data, 'base64'),
      });
      return;
    }
    if (frame.type === 'node_event') {
      this.emit('node.event', { nodeId: state.nodeId, epoch: state.epoch, event: frame.event });
      state.connection.sendJSON({ type: 'node_event_ack', connection_epoch: state.epoch, event_id: frame.event?.id });
      return;
    }
  }

  isOnline(nodeId) {
    return this.connections.has(nodeId);
  }

  connectionEpoch(nodeId) {
    return this.connections.get(nodeId)?.epoch || null;
  }

  async request(nodeId, commandType, payload, { timeoutMs = 30_000, idempotencyKey = null } = {}) {
    const commandId = idempotencyKey == null ? undefined : durableCommandId(commandType, idempotencyKey);
    const item = this.database.createOutbox(nodeId, commandType, payload, commandId);
    if (item.state === 'acknowledged') return item.result;
    if (item.state === 'failed') {
      throw new WebSpiderError('WS_NODE_ERROR', item.failure_reason || 'Node command previously failed.', 500, { command_id: item.id });
    }
    return this.#dispatch(item, timeoutMs);
  }

  async requestTransient(nodeId, commandType, payload, { timeoutMs = 30_000 } = {}) {
    const state = this.connections.get(nodeId);
    if (!state) throw new WebSpiderError('WS_NODE_OFFLINE',
      'Owning node is offline; live file transfer cannot continue.', 503);
    const commandId = `cmd_trn_${randomBytes(18).toString('base64url')}`;
    let resolvePending;
    let rejectPending;
    const promise = new Promise((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    const timer = setTimeout(() => {
      this.pending.delete(commandId);
      rejectPending(new WebSpiderError('WS_NODE_OFFLINE',
        'Timed out waiting for a live file transfer response.', 504, { command_id: commandId }));
    }, timeoutMs);
    timer.unref?.();
    this.pending.set(commandId, {
      promise,
      resolve: resolvePending,
      reject: rejectPending,
      timer,
      nodeId,
      epoch: state.epoch,
      replayable: false,
      transient: true,
    });
    state.connection.sendJSON({
      type: 'command',
      protocol_version: 1,
      connection_epoch: state.epoch,
      command_id: commandId,
      command_type: commandType,
      payload,
      transient: true,
    });
    return promise;
  }

  async #dispatch(item, timeoutMs) {
    const active = this.pending.get(item.id);
    if (active) return active.promise;
    const state = this.connections.get(item.node_id);
    if (!state) {
      if (!replayableCommand(item.command_type)) {
        this.database.markOutboxResult(item.id, null, 'Transient command was not queued while the node was offline.');
      }
      throw new WebSpiderError('WS_NODE_OFFLINE', replayableCommand(item.command_type)
        ? 'Owning node is offline; command remains queued.'
        : 'Owning node is offline; transient command was not queued.', 503, { command_id: item.id });
    }
    this.database.markOutboxSent(item.id, state.epoch);
    let resolvePending;
    let rejectPending;
    const promise = new Promise((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    const timer = setTimeout(() => {
      this.pending.delete(item.id);
      if (!replayableCommand(item.command_type)) {
        this.database.markOutboxResult(item.id, null, 'Timed out waiting for transient node command acknowledgement.');
      }
      rejectPending(new WebSpiderError('WS_NODE_OFFLINE', 'Timed out waiting for node command acknowledgement.', 504, { command_id: item.id }));
    }, timeoutMs);
    timer.unref?.();
    this.pending.set(item.id, {
      promise,
      resolve: resolvePending,
      reject: rejectPending,
      timer,
      nodeId: item.node_id,
      epoch: state.epoch,
      replayable: replayableCommand(item.command_type),
    });
    state.connection.sendJSON({
      type: 'command',
      protocol_version: 1,
      connection_epoch: state.epoch,
      command_id: item.id,
      command_type: item.command_type,
      payload: item.payload,
    });
    return promise;
  }

  #rejectPending(nodeId, epoch) {
    for (const [id, pending] of this.pending) {
      if (pending.nodeId !== nodeId || pending.epoch !== epoch) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (!pending.replayable && !pending.transient) {
        this.database.markOutboxResult(id, null, 'Node disconnected before acknowledging transient command.');
      }
      pending.reject(new WebSpiderError('WS_NODE_OFFLINE', 'Node disconnected before acknowledging command.', 503, { command_id: id }));
    }
  }

  async #replay(nodeId) {
    for (const row of this.database.pendingOutbox(nodeId)) {
      if (!replayableCommand(row.command_type)) {
        this.database.markOutboxResult(row.id, null, 'Transient command expired before the node reconnected.');
        continue;
      }
      try {
        await this.#dispatch(row, 30_000);
      } catch (error) {
        if (error.code !== 'WS_NODE_OFFLINE') this.emit('error', error);
        break;
      }
    }
  }
}
