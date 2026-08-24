import { WebSpiderError, asWebSpiderError } from './errors.js';

export async function readJSON(request, maxBytes = 1_048_576) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new WebSpiderError('WS_REQUEST_TOO_LARGE', 'Request body is too large.', 413);
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new WebSpiderError('WS_INVALID_JSON', 'Request body is not valid JSON.', 400);
  }
}

export function sendJSON(response, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

export function sendError(response, error, requestId) {
  const normalized = asWebSpiderError(error);
  sendJSON(response, normalized.status, {
    error: {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details,
      request_id: requestId,
    },
  });
}

export function parsePositiveInt(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, maximum);
}

export function contentDisposition(filename) {
  const safe = String(filename).replace(/[\r\n"\\]/g, '_').slice(0, 240) || 'download';
  return `attachment; filename="${safe}"`;
}
