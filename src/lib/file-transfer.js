import { invariant } from './errors.js';

export const FILE_TRANSFER_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_TRANSFER_BYTES = 64 * 1024 * 1024 * 1024;

export function validateTransferId(value) {
  invariant(typeof value === 'string' && /^xfr_[A-Za-z0-9_-]{16,80}$/.test(value),
    'WS_VALIDATION', 'A valid file transfer ID is required.');
  return value;
}

export function validateTransferSize(value) {
  const size = Number(value);
  invariant(Number.isSafeInteger(size) && size >= 0 && size <= MAX_FILE_TRANSFER_BYTES,
    'WS_REQUEST_TOO_LARGE', 'Transferred files may be at most 64 GiB.', 413);
  return size;
}

export function validateTransferConflict(value = 'error') {
  invariant(['error', 'rename', 'overwrite'].includes(value), 'WS_VALIDATION',
    'File conflict handling must be error, rename, or overwrite.');
  return value;
}

export function validateTransferFilename(value) {
  invariant(typeof value === 'string' && value === value.normalize('NFC')
    && value.trim() === value && value !== '.' && value !== '..'
    && !/[\x00-\x1f\x7f/\\]/u.test(value)
    && Buffer.byteLength(value, 'utf8') > 0 && Buffer.byteLength(value, 'utf8') <= 160,
  'WS_VALIDATION', 'Transfer filename must be a safe basename of at most 160 UTF-8 bytes.');
  return value;
}

export function decodeTransferChunk(value) {
  const maximumBase64 = Math.ceil(FILE_TRANSFER_CHUNK_BYTES / 3) * 4;
  invariant(typeof value === 'string' && value.length <= maximumBase64
    && value.length % 4 === 0,
  'WS_UPLOAD_INVALID', 'File transfer chunk is not valid base64.', 400);
  const bytes = Buffer.from(value, 'base64');
  invariant(bytes.length <= FILE_TRANSFER_CHUNK_BYTES && bytes.toString('base64') === value,
    'WS_UPLOAD_INVALID', 'File transfer chunk is not canonical base64.', 400);
  return bytes;
}
