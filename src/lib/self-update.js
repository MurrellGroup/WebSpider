import { invariant } from './errors.js';

export const WEBSPIDER_VERSION = '0.6.21';
export const WEBSPIDER_REPOSITORY = 'MurrellGroup/WebSpider';
export const WEBSPIDER_UPDATE_PROTOCOL = 1;

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]+)?$/;

export function webSpiderVersionAtLeast(installed, target) {
  const parse = (value) => {
    const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
    return match ? match.slice(1).map(Number) : null;
  };
  const left = parse(installed);
  const right = parse(target);
  if (!left || !right) return installed === target;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

export function validateReleaseVersion(value) {
  const version = String(value || '').trim();
  invariant(VERSION_PATTERN.test(version), 'WS_VALIDATION', 'WebSpider update version is invalid.');
  return version;
}

export function parseReleaseBootstrap(source) {
  const text = String(source || '');
  const repository = text.match(/^repository='([^']+)'$/m)?.[1];
  const version = text.match(/^version='([^']+)'$/m)?.[1];
  invariant(repository === WEBSPIDER_REPOSITORY, 'WS_UPDATE_UNTRUSTED', 'Latest release bootstrap names an unexpected repository.', 502);
  return validateReleaseVersion(version);
}

export async function resolveLatestReleaseVersion(fetchImpl = fetch) {
  const response = await fetchImpl(`https://github.com/${WEBSPIDER_REPOSITORY}/releases/latest/download/WebSpider_Install.run`, {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: 'text/plain' },
  });
  invariant(response.ok, 'WS_UPDATE_UNAVAILABLE', `Could not resolve the latest WebSpider release (HTTP ${response.status}).`, 502);
  const bytes = Buffer.from(await response.arrayBuffer());
  invariant(bytes.length > 0 && bytes.length <= 64 * 1024, 'WS_UPDATE_UNTRUSTED', 'Latest release bootstrap has an unexpected size.', 502);
  return parseReleaseBootstrap(bytes.toString('utf8'));
}

const APPLY_UPDATE_SCRIPT = [
  'set -eu',
  'version=$1',
  'role=$2',
  'hub_url=$3',
  'listen=$4',
  'state_dir=$5',
  'public_base_url=$6',
  'temporary=$(mktemp "${TMPDIR:-/tmp}/webspider-fleet-update.XXXXXX")',
  'cleanup() { rm -f "$temporary"; }',
  'trap cleanup EXIT HUP INT TERM',
  'url="https://github.com/MurrellGroup/WebSpider/releases/download/v${version}/WebSpider_Install.run"',
  'if command -v curl >/dev/null 2>&1; then',
  '  curl --http1.1 -fL --retry 5 --retry-delay 2 -o "$temporary" "$url"',
  'elif command -v wget >/dev/null 2>&1; then',
  '  wget -O "$temporary" "$url"',
  'else',
  '  echo "WebSpider fleet update requires curl or wget." >&2',
  '  exit 1',
  'fi',
  'if [ "$role" = node ]; then',
  '  set -- sh "$temporary" --node "$hub_url" --workspace "$PWD"',
  '  if [ -n "$state_dir" ]; then set -- "$@" --state-dir "$state_dir"; fi',
  '  "$@"',
  'else',
  '  set -- sh "$temporary" --listen "$listen" --workspace "$PWD"',
  '  if [ -n "$state_dir" ]; then set -- "$@" --state-dir "$state_dir"; fi',
  '  if [ -n "$public_base_url" ]; then set -- "$@" --public-base-url "$public_base_url"; fi',
  '  "$@"',
  'fi',
].join('\n');

export function fleetUpdateArgv({ version, role, hubURL = '', listen = '', stateDir = '', publicBaseURL = '' }) {
  const safeVersion = validateReleaseVersion(version);
  invariant(['hub', 'node'].includes(role), 'WS_VALIDATION', 'WebSpider update role must be hub or node.');
  return [
    '/bin/sh', '-c', APPLY_UPDATE_SCRIPT, 'webspider-fleet-update',
    safeVersion, role, String(hubURL || ''), String(listen || ''), String(stateDir || ''), String(publicBaseURL || ''),
  ];
}
