export class WebSpiderError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'WebSpiderError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function invariant(condition, code, message, status = 400, details) {
  if (!condition) throw new WebSpiderError(code, message, status, details);
}

export function asWebSpiderError(error) {
  if (error instanceof WebSpiderError) return error;
  if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return new WebSpiderError('WS_CONFLICT', 'The resource already exists.', 409);
  }
  return new WebSpiderError('WS_INTERNAL', 'An internal error occurred.', 500);
}
