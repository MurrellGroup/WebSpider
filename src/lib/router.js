import { URL } from 'node:url';
import { WebSpiderError } from './errors.js';

function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const suffixIndex = segment.indexOf(':', 1);
      const key = segment.slice(1, suffixIndex < 0 ? undefined : suffixIndex);
      const suffix = suffixIndex < 0 ? '' : segment.slice(suffixIndex);
      keys.push(key);
      return `([^/:]+)${suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    })
    .join('/');
  return { regex: new RegExp(`^${source}/?$`), keys };
}

export class Router {
  #routes = [];

  add(method, pattern, handler, options = {}) {
    const compiled = compile(pattern);
    this.#routes.push({ method, pattern, handler, ...compiled, options });
    return this;
  }

  match(request) {
    const url = new URL(request.url, 'http://webspider.invalid');
    for (const route of this.#routes) {
      if (route.method !== request.method) continue;
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      const params = Object.create(null);
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1]);
      });
      return { route, params, url };
    }
    throw new WebSpiderError('WS_NOT_FOUND', 'Resource not found.', 404);
  }
}
