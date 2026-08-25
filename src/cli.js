import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { Hub } from './hub/hub.js';
import { NodeDaemon } from './node/node-daemon.js';
import { ensurePrivateFile, generateNodeIdentity, signNodeHello } from './lib/security.js';
import { makeId } from './lib/ids.js';
import { hubSynchronizedTimestamp } from './lib/hub-clock.js';
import { agentLaunchArguments } from './lib/agent-profile.js';
import { inferProjectContext } from './lib/project-policy.js';
import {
  installNodeUserService,
  installUserService,
  nodeUserServiceStatus,
  uninstallNodeUserService,
  uninstallUserService,
  userServiceStatus,
} from './lib/service-manager.js';

function parseArgs(argv) {
  const positional = [];
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const equal = value.indexOf('=');
    if (equal > 0) {
      options[value.slice(2, equal)] = value.slice(equal + 1);
      continue;
    }
    const key = value.slice(2);
    if (argv[index + 1] != null && !argv[index + 1].startsWith('--')) options[key] = argv[++index];
    else options[key] = true;
  }
  return { positional, options };
}

function defaultStateDir() {
  return process.env.WEBSPIDER_STATE_DIR
    || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'webspider');
}

function parseListen(value = '127.0.0.1:7340') {
  const lastColon = value.lastIndexOf(':');
  if (lastColon < 0) return { host: value, port: 7340 };
  return { host: value.slice(0, lastColon) || '127.0.0.1', port: Number.parseInt(value.slice(lastColon + 1), 10) };
}

function loadOrCreateIdentity(nodeStateDir, nodeId = null) {
  const identityPath = path.join(nodeStateDir, 'identity.json');
  fs.mkdirSync(nodeStateDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(identityPath)) return JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  const keys = generateNodeIdentity();
  const identity = { nodeId: nodeId || makeId('nod'), ...keys };
  ensurePrivateFile(identityPath, JSON.stringify(identity, null, 2));
  return identity;
}

export function writeNodeConfig(nodeStateDir, config) {
  fs.mkdirSync(nodeStateDir, { recursive: true, mode: 0o700 });
  const destination = path.join(nodeStateDir, 'config.json');
  const temporary = path.join(nodeStateDir, `.config.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, destination);
  fs.chmodSync(destination, 0o600);
}

function loadNodeConfig(nodeStateDir) {
  return JSON.parse(fs.readFileSync(path.join(nodeStateDir, 'config.json'), 'utf8'));
}

export function existingNodeRoots(roots = []) {
  if (!Array.isArray(roots)) return [];
  return roots.filter((root) => {
    try {
      return fs.statSync(root?.path)?.isDirectory();
    } catch {
      return false;
    }
  });
}

function logJSON(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export { hubSynchronizedTimestamp } from './lib/hub-clock.js';

function quickAccessURL(url, ownerToken) {
  const value = new URL(url);
  value.hash = `access_token=${encodeURIComponent(ownerToken)}`;
  return value.href;
}

function findExecutable(name) {
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* try the next PATH entry */ }
  }
  return null;
}

function parseAgentArguments(value) {
  if (!value) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('--agent-args must be a JSON array, for example --agent-args=' + "'[\"--full-auto\"]'");
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('--agent-args must be a JSON array of strings');
  }
  return parsed;
}

export function resolveAgentProfile(options = {}) {
  const explicit = options['agent-command'];
  if (explicit) return {
    id: 'apf_primary',
    name: path.basename(explicit).toLowerCase().includes('codex') ? 'Codex' : 'Primary terminal',
    adapterKind: 'pty',
    executable: explicit,
    arguments: agentLaunchArguments(explicit, parseAgentArguments(options['agent-args'])),
  };
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/bash';
  return {
    id: 'apf_shell',
    name: 'Main terminal',
    adapterKind: 'pty',
    executable: shell,
    arguments: ['-l'],
  };
}

async function waitForSignal(cleanup) {
  await new Promise((resolve) => {
    const done = () => resolve();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  await cleanup();
}

async function runUp(options) {
  const stateDir = path.resolve(options['state-dir'] || defaultStateDir());
  const hubStateDir = path.join(stateDir, 'hub');
  const nodeStateDir = path.join(stateDir, 'node');
  const workspace = path.resolve(options.workspace || process.cwd());
  const projectContext = inferProjectContext(workspace);
  const agentProfile = resolveAgentProfile(options);
  const listen = parseListen(options.listen);
  const identity = loadOrCreateIdentity(nodeStateDir, 'nod_local');
  const hub = new Hub({
    stateDir: hubStateDir,
    listenHost: listen.host,
    listenPort: listen.port,
    publicBaseURL: options['public-base-url'] || null,
    allowedOrigins: options.origin ? [options.origin] : [],
  });
  const bootstrap = hub.bootstrapLocal({
    nodeId: identity.nodeId,
    publicKey: identity.publicKey,
    workspace,
    projectContext,
    agentProfile,
  });
  const listening = await hub.listen();
  const node = new NodeDaemon({
    stateDir: nodeStateDir,
    hubURL: listening.url,
    nodeId: identity.nodeId,
    displayName: 'Local workstation',
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    roots: [{
      id: bootstrap.root_id,
      path: workspace,
      display_name: 'workspace',
      symlink_policy: 'no_symlinks',
      mount_policy: 'allow_nested',
    }],
  });
  node.on('error', (error) => process.stderr.write(`[webspider node] ${error?.message || error}\n`));
  node.start();
  node.once('online', async () => {
    if (options['no-wake']) return;
    try {
      const response = await fetch(`${listening.url}/api/v1/agent-instances/${bootstrap.agent.id}:wake`, {
        method: 'POST',
        headers: { authorization: `Bearer ${listening.ownerToken}` },
      });
      if (!response.ok) process.stderr.write(`[webspider] Initial agent wake failed: ${await response.text()}\n`);
    } catch (error) {
      process.stderr.write(`[webspider] Initial agent wake failed: ${error.message}\n`);
    }
  });
  process.stdout.write(`WebSpider is running at ${listening.url}\n`);
  if (!options['public-base-url'] && ['127.0.0.1', 'localhost', '::1'].includes(listen.host)) {
    process.stdout.write(`Open portal: ${quickAccessURL(listening.url, listening.ownerToken)}\n`);
  }
  process.stdout.write(`Owner token: ${listening.ownerToken}\n`);
  process.stdout.write(`Workspace: ${workspace}\n`);
  process.stdout.write(`Primary session: ${agentProfile.name}\n`);
  process.stdout.write(`Project defaults: academic-first, inferred from ${projectContext.inference}\n`);
  await waitForSignal(async () => {
    await node.stop();
    await hub.close();
  });
}

async function runHub(options) {
  const stateDir = path.resolve(options['state-dir'] || path.join(defaultStateDir(), 'hub'));
  const listen = parseListen(options.listen);
  const hub = new Hub({
    stateDir,
    listenHost: listen.host,
    listenPort: listen.port,
    publicBaseURL: options['public-base-url'] || null,
    allowedOrigins: options.origin ? [options.origin] : [],
  });
  const listening = await hub.listen();
  process.stdout.write(`WebSpider hub is running at ${listening.url}\n`);
  if (!options['public-base-url'] && ['127.0.0.1', 'localhost', '::1'].includes(listen.host)) {
    process.stdout.write(`Open portal: ${quickAccessURL(listening.url, listening.ownerToken)}\n`);
  }
  process.stdout.write(`Owner token: ${listening.ownerToken}\n`);
  await waitForSignal(() => hub.close());
}

function parseRoot(value) {
  const separator = value?.indexOf('=');
  if (!value || separator <= 0) throw new Error('--root must be ROOT_ID=/absolute/local/path');
  const resolved = path.resolve(value.slice(separator + 1));
  return { id: value.slice(0, separator), path: resolved, display_name: path.basename(resolved) || 'workspace' };
}

async function joinNode(options) {
  if (!options.hub || !options.token) throw new Error('node join requires --hub and --token');
  const nodeStateDir = path.resolve(options['state-dir'] || path.join(defaultStateDir(), 'node'));
  if (options.root && options.workspace) throw new Error('Use either --root or --workspace, not both');
  const roots = options.root
    ? [parseRoot(options.root)]
    : options.workspace
      ? [{ id: makeId('awr'), path: path.resolve(options.workspace), display_name: path.basename(path.resolve(options.workspace)) || 'workspace' }]
      : [];
  for (const root of roots) {
    if (!fs.statSync(root.path, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Workspace does not exist: ${root.path}`);
  }
  const identity = loadOrCreateIdentity(nodeStateDir);
  const response = await fetch(new URL('/api/v1/nodes/enroll', options.hub), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: options.token,
      name: options.name || os.hostname(),
      public_key: identity.publicKey,
      labels: { os: process.platform, arch: process.arch },
      capabilities: {
        rooted_files: true,
        detached_processes: process.platform !== 'win32',
        root_ids: roots.map((root) => root.id),
        roots: roots.map((root) => ({ id: root.id, name: root.display_name || 'workspace' })),
        shell: process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
        codex: Boolean(findExecutable('codex')),
      },
    }),
  });
  if (!response.ok) throw new Error(`Enrollment failed: ${await response.text()}`);
  const enrollment = await response.json();
  identity.nodeId = enrollment.node_id;
  fs.writeFileSync(path.join(nodeStateDir, 'identity.json'), JSON.stringify(identity, null, 2), { mode: 0o600 });
  writeNodeConfig(nodeStateDir, { hubURL: options.hub, displayName: enrollment.display_name, roots });
  logJSON({ enrolled: true, node_id: enrollment.node_id, state_dir: nodeStateDir, roots });
}

export async function attachNodeRoot(options) {
  if (!options.token) throw new Error('node attach requires --token');
  const nodeStateDir = path.resolve(options['state-dir'] || path.join(defaultStateDir(), 'node'));
  const identity = loadOrCreateIdentity(nodeStateDir);
  const config = loadNodeConfig(nodeStateDir);
  if (!options.workspace) throw new Error('node attach requires --workspace');
  const workspace = path.resolve(options.workspace);
  if (!fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Workspace does not exist: ${workspace}`);
  }
  const root = { id: makeId('awr'), path: workspace, display_name: path.basename(workspace) || 'workspace' };
  const hub = options.hub || config.hubURL;
  const timestamp = await hubSynchronizedTimestamp(hub);
  const nonce = randomBytes(18).toString('base64url');
  const response = await fetch(new URL('/api/v1/nodes/attach-root', hub), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: options.token,
      node_id: identity.nodeId,
      timestamp,
      nonce,
      signature: signNodeHello(identity.privateKey, identity.nodeId, timestamp, nonce),
      root: { id: root.id, name: root.display_name },
    }),
  });
  if (!response.ok) {
    const failure = await response.text();
    let code = null;
    try { code = JSON.parse(failure)?.error?.code; } catch { /* retain the server response below */ }
    if (response.status === 401 && code === 'WS_NODE_UNKNOWN') {
      return joinNode({
        ...options,
        hub,
        workspace,
        name: options.name || config.displayName || os.hostname(),
      });
    }
    throw new Error(`Project attachment failed: ${failure}`);
  }
  const result = await response.json();
  const retainedRoots = existingNodeRoots(config.roots || []);
  writeNodeConfig(nodeStateDir, {
    ...config,
    hubURL: hub,
    roots: [...retainedRoots.filter((candidate) => candidate.id !== root.id), root],
  });
  logJSON({
    attached: true,
    node_id: identity.nodeId,
    root,
    removed_stale_root_ids: (config.roots || [])
      .filter((candidate) => !retainedRoots.some((retained) => retained.id === candidate.id))
      .map((candidate) => candidate.id),
    agent_id: result.agent_id,
    state_dir: nodeStateDir,
  });
}

async function runNode(options) {
  const nodeStateDir = path.resolve(options['state-dir'] || path.join(defaultStateDir(), 'node'));
  const identity = loadOrCreateIdentity(nodeStateDir);
  const config = loadNodeConfig(nodeStateDir);
  const node = new NodeDaemon({
    stateDir: nodeStateDir,
    hubURL: config.hubURL,
    nodeId: identity.nodeId,
    displayName: config.displayName,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    roots: config.roots || [],
  });
  node.on('online', ({ connection_epoch }) => process.stdout.write(`Node ${identity.nodeId} online (epoch ${connection_epoch})\n`));
  node.on('offline', () => process.stdout.write(`Node ${identity.nodeId} offline; reconnecting\n`));
  node.on('error', (error) => process.stderr.write(`[webspider node] ${error?.message || error}\n`));
  node.start();
  await waitForSignal(() => node.stop());
}

async function createJoinToken(options) {
  if (!options.hub) throw new Error('token create requires --hub');
  const ownerToken = options['owner-token'] || process.env.WEBSPIDER_OWNER_TOKEN;
  if (!ownerToken) throw new Error('Provide --owner-token or WEBSPIDER_OWNER_TOKEN');
  const response = await fetch(new URL('/api/v1/nodes/join-tokens', options.hub), {
    method: 'POST',
    headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: options.name || 'New node' }),
  });
  if (!response.ok) throw new Error(await response.text());
  logJSON(await response.json());
}

function doctor(options) {
  const stateDir = path.resolve(options['state-dir'] || defaultStateDir());
  const checks = [];
  checks.push({ name: 'node_runtime', ok: Number(process.versions.node.split('.')[0]) >= 24, detail: process.version });
  const git = process.platform === 'win32' ? { status: 1 } : BunLikeSpawn('git');
  checks.push({ name: 'git', ok: git.status === 0, required: false });
  const runtimeExecutables = [process.platform === 'darwin' ? 'expect' : 'script', 'mkfifo'];
  for (const executable of runtimeExecutables) {
    const result = process.platform === 'win32' ? { status: 1 } : BunLikeSpawn(executable);
    checks.push({ name: executable, ok: result.status === 0 });
  }
  const databasePath = path.join(stateDir, 'hub', 'webspider.db');
  if (fs.existsSync(databasePath)) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const integrity = database.prepare('PRAGMA integrity_check').get();
    checks.push({ name: 'hub_database', ok: Object.values(integrity)[0] === 'ok', detail: Object.values(integrity)[0] });
    database.close();
  } else checks.push({ name: 'hub_database', ok: true, detail: 'not initialized' });
  const ok = checks.every((check) => check.ok || check.required === false);
  logJSON({ ok, state_dir: stateDir, checks });
  if (!ok) process.exitCode = 1;
}

function showOwnerToken(options) {
  const stateDir = path.resolve(options['state-dir'] || defaultStateDir());
  const tokenPath = path.join(stateDir, 'hub', 'owner.token');
  if (!fs.existsSync(tokenPath)) throw new Error('Owner token not found; start WebSpider first');
  process.stdout.write(`${fs.readFileSync(tokenPath, 'utf8').trim()}\n`);
}

function showMetaSpiderPrompt(options) {
  const repository = options.repository || 'https://github.com/MurrellGroup/WebSpider';
  const workspace = path.resolve(options.workspace || process.cwd());
  process.stdout.write(`You are the Meta-Spider for WebSpider: a user-invoked, break-glass maintainer outside the WebSpider agent hierarchy.

Repository: ${repository}
Maintenance workspace: ${workspace}

Work only inside that maintenance workspace, except for per-user installation and package-manager side effects needed to build or test WebSpider. Read every applicable AGENTS.md before acting. Keep the WebSpider source clone separate from any directory used as a live test project.

Your job is to install, upgrade, diagnose, recover, test, or repair WebSpider itself when I ask. You are not the Master Spider and do not perform ordinary portfolio/project work. Do not routinely prod, supervise, schedule work for, or converse with the Master. Reach into a Master or worker session only when I explicitly request diagnosis/repair or when a bounded interaction is necessary to validate that repair. Preserve durable identities and user work, make the narrowest relevant changes, verify the result, and then hand normal operation back to me and the Master. Ask me before using sudo or expanding beyond the selected WebSpider directory.

Start by cloning or inspecting the repository, reading docs/META_SPIDER.md and the repository instructions, and reporting the current installation/service state before making changes.
`);
}

function serviceCommand(action, options) {
  const executable = path.resolve(options.executable || process.env.WEBSPIDER_EXECUTABLE || process.argv[1]);
  const stateDir = path.resolve(options['state-dir'] || defaultStateDir());
  const workspace = path.resolve(options.workspace || process.cwd());
  if (action === 'install') {
    if (!options.user) throw new Error('service install requires --user');
    return logJSON(installUserService({
      executable,
      workspace,
      stateDir,
      listen: options.listen || '127.0.0.1:7340',
      publicBaseURL: options['public-base-url'] || null,
    }));
  }
  if (action === 'status') return logJSON(userServiceStatus());
  if (action === 'uninstall') {
    if (!options.user) throw new Error('service uninstall requires --user');
    return logJSON(uninstallUserService());
  }
  if (action === 'install-node') {
    if (!options.user) throw new Error('service install-node requires --user');
    return logJSON(installNodeUserService({ executable, stateDir }));
  }
  if (action === 'status-node') return logJSON(nodeUserServiceStatus({ stateDir }));
  if (action === 'uninstall-node') {
    if (!options.user) throw new Error('service uninstall-node requires --user');
    return logJSON(uninstallNodeUserService());
  }
  throw new Error('service requires install --user, install-node --user, status, status-node, uninstall --user, or uninstall-node --user');
}

function BunLikeSpawn(executable) {
  const result = Boolean(findExecutable(executable));
  return { status: result ? 0 : 1 };
}

function help() {
  process.stdout.write(`WebSpider 0.6.4\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  webspider up [--listen 127.0.0.1:7340] [--workspace PATH] [--agent-command PATH] [--agent-args JSON]\n`);
  process.stdout.write(`  webspider hub [--listen 127.0.0.1:7340]\n`);
  process.stdout.write(`  webspider node join --hub URL --token TOKEN [--workspace PATH | --root ID=PATH]\n`);
  process.stdout.write(`  webspider node attach --token TOKEN --workspace PATH [--hub URL] [--state-dir PATH]\n`);
  process.stdout.write(`  webspider node [--state-dir PATH]\n`);
  process.stdout.write(`  webspider token create --hub URL --owner-token TOKEN [--name NAME]\n`);
  process.stdout.write(`  webspider auth token [--state-dir PATH]\n`);
  process.stdout.write(`  webspider meta-spider prompt [--workspace PATH] [--repository URL]\n`);
  process.stdout.write(`  webspider service install --user [--listen HOST:PORT] [--public-base-url URL] [--workspace PATH] [--state-dir PATH]\n`);
  process.stdout.write(`  webspider service install-node --user [--state-dir PATH]\n`);
  process.stdout.write(`  webspider service status\n`);
  process.stdout.write(`  webspider service status-node\n`);
  process.stdout.write(`  webspider service uninstall --user\n`);
  process.stdout.write(`  webspider service uninstall-node --user\n`);
  process.stdout.write(`  webspider doctor [--state-dir PATH]\n`);
}

export async function main(argv) {
  const { positional, options } = parseArgs(argv);
  const command = positional[0] || 'help';
  if (command === 'up') return runUp(options);
  if (command === 'hub') return runHub(options);
  if (command === 'node' && positional[1] === 'join') return joinNode(options);
  if (command === 'node' && positional[1] === 'attach') return attachNodeRoot(options);
  if (command === 'node') return runNode(options);
  if (command === 'token' && positional[1] === 'create') return createJoinToken(options);
  if (command === 'auth' && positional[1] === 'token') return showOwnerToken(options);
  if (command === 'meta-spider' && positional[1] === 'prompt') return showMetaSpiderPrompt(options);
  if (command === 'service') return serviceCommand(positional[1], options);
  if (command === 'doctor') return doctor(options);
  if (['help', '--help', '-h'].includes(command)) return help();
  throw new Error(`Unknown command: ${positional.join(' ')}`);
}
