import { createHash } from 'node:crypto';
import { invariant } from './errors.js';

export const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024;

const IMAGE_TYPES = new Map([
  ['image/png', { extension: 'png', matches: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) }],
  ['image/jpeg', { extension: 'jpg', matches: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff }],
  ['image/gif', { extension: 'gif', matches: (bytes) => ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')) }],
  ['image/webp', { extension: 'webp', matches: (bytes) => bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' }],
]);

export function validateImageUpload({ uploadId, mimeType, bytes, sha256 = null }) {
  invariant(typeof uploadId === 'string' && /^upl_[A-Za-z0-9_-]{16,80}$/.test(uploadId),
    'WS_VALIDATION', 'A valid image upload ID is required.');
  const imageType = IMAGE_TYPES.get(String(mimeType || '').toLowerCase());
  invariant(imageType, 'WS_UPLOAD_UNSUPPORTED', 'Paste a PNG, JPEG, GIF, or WebP image.', 415);
  invariant(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_IMAGE_UPLOAD_BYTES,
    'WS_REQUEST_TOO_LARGE', 'Pasted image must contain between 1 byte and 8 MiB.', 413);
  invariant(imageType.matches(bytes), 'WS_UPLOAD_INVALID', 'Pasted image bytes do not match their declared image type.', 400);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (sha256 != null) invariant(digest === sha256, 'WS_UPLOAD_INVALID', 'Pasted image checksum does not match.', 400);
  return { extension: imageType.extension, mime_type: String(mimeType).toLowerCase(), sha256: digest, size_bytes: bytes.length };
}

export function decodeImageBase64(value) {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= 11_200_000,
    'WS_REQUEST_TOO_LARGE', 'Pasted image payload is missing or too large.', 413);
  invariant(value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
    'WS_UPLOAD_INVALID', 'Pasted image payload is not valid base64.', 400);
  return Buffer.from(value, 'base64');
}
