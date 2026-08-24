import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { WebSpiderError, invariant } from '../lib/errors.js';
import { verifyNodeHello } from '../lib/security.js';

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
        state: ['running', 'stopping', 'exited', 'failed', 'lost'].includes(runtime.state) ? runtime.state : 'lost',
        created_at: runtime.created_at || null,
      }))
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
      this.database.markOutboxResult(frame.command_id, frame.result, frame.error?.message || null);
      const pending = this.pending.get(frame.command_id);
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

  async request(nodeId, commandType, payload, { timeoutMs = 30_000 } = {}) {
    const item = this.database.createOutbox(nodeId, commandType, payload);
    return this.#dispatch(item, timeoutMs);
  }

  async #dispatch(item, timeoutMs) {
    const state = this.connections.get(item.node_id);
    if (!state) throw new WebSpiderError('WS_NODE_OFFLINE', 'Owning node is offline; command remains queued.', 503, { command_id: item.id });
    this.database.markOutboxSent(item.id, state.epoch);
    state.connection.sendJSON({
      type: 'command',
      protocol_version: 1,
      connection_epoch: state.epoch,
      command_id: item.id,
      command_type: item.command_type,
      payload: item.payload,
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(item.id);
        reject(new WebSpiderError('WS_NODE_OFFLINE', 'Timed out waiting for node command acknowledgement.', 504, { command_id: item.id }));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(item.id, { resolve, reject, timer });
    });
  }

  async #replay(nodeId) {
    for (const row of this.database.pendingOutbox(nodeId)) {
      if (this.pending.has(row.id)) continue;
      try {
        await this.#dispatch({
          id: row.id,
          node_id: row.node_id,
          command_type: row.command_type,
          payload: row.payload,
        }, 30_000);
      } catch (error) {
        if (error.code !== 'WS_NODE_OFFLINE') this.emit('error', error);
        break;
      }
    }
  }
}
