import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocketConnection } from '../src/transport/websocket.js';

class FakeSocket extends EventEmitter {
  setNoDelay() {}
  write() { return true; }
  end() {}
}

test('an abruptly disconnected browser cannot crash the hub', () => {
  const socket = new FakeSocket();
  const connection = new WebSocketConnection(socket);
  let closed = false;
  connection.on('close', () => { closed = true; });
  assert.doesNotThrow(() => socket.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' })));
  assert.equal(closed, true);
});
