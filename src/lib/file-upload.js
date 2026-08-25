import { createHash } from 'node:crypto';
import { invariant } from './errors.js';

export const MAX_FILE_UPLOAD_BYTES = 8 * 1024 * 1024;

export function validateFileUpload({ uploadId, filename, mimeType, bytes, sha256 = null }) {
  invariant(typeof uploadId === 'string' && /^upl_[A-Za-z0-9_-]{16,80}$/.test(uploadId),
    'WS_VALIDATION', 'A valid file upload ID is required.');
  invariant(typeof filename === 'string' && filename === filename.normalize('NFC')
    && filename.trim() === filename && filename !== '.' && filename !== '..'
    && !/[\x00-\x1f\x7f/\\]/u.test(filename)
    && Buffer.byteLength(filename, 'utf8') > 0 && Buffer.byteLength(filename, 'utf8') <= 160,
  'WS_VALIDATION', 'Upload filename must be a safe basename of at most 160 UTF-8 bytes.');
  invariant(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_FILE_UPLOAD_BYTES,
    'WS_REQUEST_TOO_LARGE', 'Attached file must contain between 1 byte and 8 MiB.', 413);
  const normalizedMime = typeof mimeType === 'string' && /^[\x20-\x7e]{1,127}$/.test(mimeType)
    ? mimeType.toLowerCase()
    : 'application/octet-stream';
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (sha256 != null) invariant(digest === sha256, 'WS_UPLOAD_INVALID', 'Attached file checksum does not match.', 400);
  return {
    filename,
    mime_type: normalizedMime,
    sha256: digest,
    size_bytes: bytes.length,
  };
}

export function decodeFileBase64(value) {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= 11_200_000,
    'WS_REQUEST_TOO_LARGE', 'Attached file payload is missing or too large.', 413);
  invariant(value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
    'WS_UPLOAD_INVALID', 'Attached file payload is not valid base64.', 400);
  return Buffer.from(value, 'base64');
}
