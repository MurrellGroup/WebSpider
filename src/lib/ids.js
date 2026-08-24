import { randomBytes, randomUUID } from 'node:crypto';

export function makeId(prefix) {
  const time = Date.now().toString(36).padStart(9, '0');
  const random = randomBytes(8).toString('base64url');
  return `${prefix}_${time}${random}`;
}

export function idempotencyKey() {
  return randomUUID();
}

export function randomToken(prefix = 'wst') {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function nowISO() {
  return new Date().toISOString();
}
