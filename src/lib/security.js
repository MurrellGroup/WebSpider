import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function generateNodeIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export function signNodeHello(privateKey, nodeId, timestamp, nonce) {
  const payload = `${nodeId}|${timestamp}|${nonce}`;
  return sign(null, Buffer.from(payload), privateKey).toString('base64url');
}

export function verifyNodeHello(publicKey, nodeId, timestamp, nonce, signature) {
  const payload = `${nodeId}|${timestamp}|${nonce}`;
  return verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'base64url'));
}

export function ensurePrivateFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, contents, { mode: 0o600, flag: 'wx' });
  }
  fs.chmodSync(filePath, 0o600);
}

export function sessionSecret() {
  return randomBytes(32).toString('base64url');
}

export function parseCookies(header = '') {
  const result = Object.create(null);
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

export function isSafeOrigin(request, configuredOrigins = []) {
  const origin = request.headers.origin;
  if (!origin) return false;
  if (configuredOrigins.includes(origin)) return true;
  const host = request.headers.host;
  return origin === `http://${host}` || origin === `https://${host}`;
}
