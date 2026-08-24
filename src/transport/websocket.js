import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

function frame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = body.length;
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket, head = Buffer.alloc(0)) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.socket.setNoDelay(true);
    this.socket.on('data', (chunk) => this.#consume(chunk));
    this.socket.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        this.emit('close');
      }
    });
    this.socket.on('error', (error) => {
      if (this.listenerCount('error') > 0) this.emit('error', error);
      if (!this.closed) {
        this.closed = true;
        this.emit('close');
      }
    });
    if (head.length) this.#consume(head);
  }

  sendText(value) {
    if (!this.closed) this.socket.write(frame(0x1, Buffer.from(String(value))));
  }

  sendJSON(value) {
    this.sendText(JSON.stringify(value));
  }

  sendBinary(value) {
    if (!this.closed) this.socket.write(frame(0x2, Buffer.from(value)));
  }

  ping(value = '') {
    if (!this.closed) this.socket.write(frame(0x9, Buffer.from(value)));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBytes = Buffer.from(reason).subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.socket.write(frame(0x8, payload));
    this.socket.end();
    this.closed = true;
    this.emit('close', code, reason);
  }

  #consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (!final) return this.close(1003, 'Fragmented frames are not supported');
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const large = this.buffer.readBigUInt64BE(2);
        if (large > BigInt(MAX_FRAME_BYTES)) return this.close(1009, 'Frame too large');
        length = Number(large);
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) return this.close(1009, 'Frame too large');
      const maskBytes = masked ? 4 : 0;
      if (this.buffer.length < offset + maskBytes + length) return;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskBytes;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      }
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        this.close(code, payload.subarray(2).toString('utf8'));
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(frame(0xA, payload));
        continue;
      }
      if (opcode === 0xA) {
        this.emit('pong', payload);
        continue;
      }
      if (opcode === 0x1) this.emit('text', payload.toString('utf8'));
      else if (opcode === 0x2) this.emit('binary', payload);
      else this.close(1003, 'Unsupported frame type');
    }
  }
}

export function acceptWebSocket(request, socket, head = Buffer.alloc(0)) {
  const key = request.headers['sec-websocket-key'];
  const version = request.headers['sec-websocket-version'];
  if (!key || version !== '13') {
    rejectWebSocket(socket, 400, 'Invalid WebSocket handshake');
    return null;
  }
  const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));
  return new WebSocketConnection(socket, head);
}

export function rejectWebSocket(socket, status = 403, reason = 'Forbidden') {
  const body = Buffer.from(reason);
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n`);
  socket.write(body);
  socket.destroy();
}
