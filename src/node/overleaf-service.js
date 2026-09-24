import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { WebSpiderError, invariant } from '../lib/errors.js';
import { validateRelativePath } from './root-fs.js';

const MAX_GIT_OUTPUT = 4 * 1024 * 1024;
const OVERLEAF_HOST = 'git.overleaf.com';

function atomicPrivateJSON(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, 0o600);
}

function atomicPrivateText(filename, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, value, { mode, flag: 'wx' });
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, mode);
}

function outputError(result, fallback) {
  const message = String(result.stderr || result.stdout || '').trim().slice(0, 2_000);
  return message || fallback;
}

function boundedText(buffer, chunk, child) {
  const next = buffer + chunk;
  if (Buffer.byteLength(next) > MAX_GIT_OUTPUT) {
    child.kill('SIGKILL');
    throw new WebSpiderError('WS_OVERLEAF_OUTPUT_LIMIT', 'Git produced too much output.', 413);
  }
  return next;
}

async function spawnGit(directory, args, { environment = {}, askpass = null, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...environment, GIT_TERMINAL_PROMPT: '0' };
    if (askpass) {
      env.GIT_ASKPASS = askpass.helper;
      env.GIT_ASKPASS_REQUIRE = 'force';
      env.WEBSPIDER_OVERLEAF_TOKEN_FILE = askpass.tokenFile;
    }
    const child = spawn('git', ['-C', directory, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    child.stdout.on('data', (chunk) => {
      try { stdout = boundedText(stdout, chunk, child); } catch (error) { finish(() => reject(error)); }
    });
    child.stderr.on('data', (chunk) => {
      try { stderr = boundedText(stderr, chunk, child); } catch (error) { finish(() => reject(error)); }
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('exit', (code, signal) => finish(() => resolve({ status: code, signal, stdout, stderr })));
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new WebSpiderError('WS_OVERLEAF_TIMEOUT', 'The Overleaf Git operation timed out.', 504)));
    }, timeoutMs);
    timer.unref?.();
  });
}

export function normalizeOverleafProjectURL(value) {
  invariant(typeof value === 'string' && value.length <= 1_024, 'WS_VALIDATION', 'An Overleaf project URL is required.');
  let parsed;
  try { parsed = new URL(value.trim()); } catch {
    throw new WebSpiderError('WS_VALIDATION', 'Enter a valid Overleaf project URL.', 400);
  }
  const validUsername = parsed.hostname === OVERLEAF_HOST ? (!parsed.username || parsed.username === 'git') : !parsed.username;
  invariant(parsed.protocol === 'https:' && ['www.overleaf.com', OVERLEAF_HOST].includes(parsed.hostname)
    && validUsername && !parsed.password && !parsed.search && !parsed.hash,
  'WS_VALIDATION', 'Use an HTTPS overleaf.com project URL without embedded credentials.');
  const parts = parsed.pathname.split('/').filter(Boolean);
  const projectId = parsed.hostname === 'www.overleaf.com' && parts[0] === 'project' ? parts[1]
    : parsed.hostname === OVERLEAF_HOST ? parts[0] : null;
  invariant(projectId && /^[A-Za-z0-9_-]{4,128}$/.test(projectId) && parts.length === (parsed.hostname === OVERLEAF_HOST ? 1 : 2),
    'WS_VALIDATION', 'The Overleaf project URL does not contain a valid project ID.');
  return { projectId, webURL: `https://www.overleaf.com/project/${projectId}`, gitURL: `https://git@${OVERLEAF_HOST}/${projectId}` };
}

class CredentialStore {
  constructor(directory, secret) {
    this.directory = directory;
    this.filename = path.join(directory, 'credentials.json');
    this.key = createHash('sha256').update('webspider-overleaf-v1\0').update(String(secret)).digest();
    this.memory = new Map();
  }

  #load() {
    try {
      const stat = fs.lstatSync(this.filename);
      invariant(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
        'WS_OVERLEAF_CREDENTIALS_UNSAFE', 'Overleaf credential storage permissions are unsafe.', 500);
      return JSON.parse(fs.readFileSync(this.filename, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  has(name = 'default') {
    return this.memory.has(name) || Boolean(this.#load()[name]);
  }

  get(name = 'default') {
    if (this.memory.has(name)) return this.memory.get(name);
    const record = this.#load()[name];
    if (!record) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(record.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new WebSpiderError('WS_OVERLEAF_AUTH_REQUIRED', 'The saved Overleaf credential cannot be opened. Reconnect Overleaf.', 401);
    }
  }

  set(token, { remember = true, name = 'default' } = {}) {
    this.memory.set(name, token);
    if (!remember) {
      const records = this.#load();
      if (records[name]) {
        delete records[name];
        if (Object.keys(records).length) atomicPrivateJSON(this.filename, records);
        else try { fs.unlinkSync(this.filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const records = this.#load();
    records[name] = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    atomicPrivateJSON(this.filename, records);
  }
}

function parseNames(value) {
  return String(value || '').split('\0').filter(Boolean);
}

function parseStatus(value) {
  const records = String(value || '').split('\0');
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const entry = { status, path: record.slice(3) };
    if (/[RC]/.test(status)) entry.original_path = records[++index] || null;
    entries.push(entry);
  }
  return entries;
}

function combineRelative(directory, filename) {
  return [directory, filename].filter(Boolean).join('/');
}

export class OverleafService {
  constructor({ stateDir, rootService, secret, environment = {} }) {
    this.stateDir = stateDir;
    this.rootService = rootService;
    this.environment = environment;
    this.credentials = new CredentialStore(stateDir, secret);
    this.connectionsPath = path.join(stateDir, 'connections.json');
    this.operationQueue = Promise.resolve();
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.askpassHelper = path.join(stateDir, 'askpass.sh');
    atomicPrivateText(this.askpassHelper,
      '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" git ;; *) exec cat "$WEBSPIDER_OVERLEAF_TOKEN_FILE" ;; esac\n',
      0o700);
  }

  async serialized(operation) {
    const previous = this.operationQueue;
    let release;
    this.operationQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  #connections() {
    try { return JSON.parse(fs.readFileSync(this.connectionsPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }

  #relative(rootId, relative) {
    return relative == null ? this.#connections()[rootId]?.directory || '' : relative;
  }

  #rememberConnection(rootId, directory, projectId) {
    const connections = this.#connections();
    connections[rootId] = { directory, project_id: projectId };
    atomicPrivateJSON(this.connectionsPath, connections);
  }

  #directory(rootId, relative = '', create = false) {
    return this.rootService.resolveDirectory(rootId, relative, { create });
  }

  async #git(directory, args, { token = null, timeoutMs } = {}) {
    let tokenFile = null;
    try {
      let askpass = null;
      if (token) {
        tokenFile = path.join(this.stateDir, `credential-${randomBytes(12).toString('hex')}`);
        fs.writeFileSync(tokenFile, token, { mode: 0o600, flag: 'wx' });
        askpass = { helper: this.askpassHelper, tokenFile };
      }
      const result = await spawnGit(directory, args, { environment: this.environment, askpass, timeoutMs });
      if (result.status !== 0) {
        const message = outputError(result, 'The Overleaf Git operation failed.');
        if (/authentication failed|invalid credentials|could not read password|access denied/i.test(message)) {
          throw new WebSpiderError('WS_OVERLEAF_AUTH_REQUIRED', 'Overleaf rejected the saved authentication token. Reconnect Overleaf.', 401);
        }
        throw new WebSpiderError('WS_OVERLEAF_GIT_FAILED', message, 409);
      }
      return result.stdout;
    } finally {
      if (tokenFile) try { fs.unlinkSync(tokenFile); } catch { /* best effort */ }
    }
  }

  #token() {
    const token = this.credentials.get();
    invariant(token, 'WS_OVERLEAF_AUTH_REQUIRED', 'Connect an Overleaf authentication token on this workstation.', 401);
    return token;
  }

  async #repository(rootId, relative = null) {
    relative = this.#relative(rootId, relative);
    const directory = this.#directory(rootId, relative);
    const top = (await this.#git(directory, ['rev-parse', '--show-toplevel'])).trim();
    invariant(fs.realpathSync(top) === directory, 'WS_OVERLEAF_REPOSITORY_MISMATCH',
      'Choose the top-level directory of the manuscript Git repository.', 409);
    const remoteURL = (await this.#git(directory, ['config', '--get', 'remote.overleaf.url'])).trim();
    const project = normalizeOverleafProjectURL(remoteURL);
    let branch = (await this.#git(directory, ['config', '--get', 'webspider.overleafBranch']).catch(() => '')).trim();
    if (!branch) branch = 'main';
    return { directory, relative, project, branch, remoteRef: `refs/remotes/overleaf/${branch}` };
  }

  async #refExists(directory, ref) {
    try { await this.#git(directory, ['rev-parse', '--verify', '--quiet', ref]); return true; } catch { return false; }
  }

  async #fetch(repository, token = this.#token()) {
    await this.#git(repository.directory,
      ['fetch', '--prune', 'overleaf', `+refs/heads/${repository.branch}:${repository.remoteRef}`],
      { token, timeoutMs: 180_000 });
    const fetchedAt = new Date().toISOString();
    await this.#git(repository.directory, ['config', 'webspider.overleafFetchedAt', fetchedAt]);
    return fetchedAt;
  }

  async connect({ rootId, directory: relative = '', projectURL, token = '', remember = true }) {
    validateRelativePath(relative);
    const project = normalizeOverleafProjectURL(projectURL);
    invariant((!token || (typeof token === 'string' && token.length >= 8 && token.length <= 1_024 && !/[\r\n\0]/.test(token))),
      'WS_VALIDATION', 'The Overleaf token is invalid.');
    const credential = token || this.credentials.get();
    invariant(credential, 'WS_OVERLEAF_AUTH_REQUIRED', 'Paste an Overleaf Git authentication token.', 401);
    const directory = this.#directory(rootId, relative, true);
    let createdRepository = false;
    let addedRemote = false;
    let repositoryExists = true;
    try { await this.#git(directory, ['rev-parse', '--git-dir']); } catch { repositoryExists = false; }
    if (!repositoryExists) {
      const entries = fs.readdirSync(directory).filter((name) => name !== '.webspider');
      invariant(entries.length === 0, 'WS_OVERLEAF_DIRECTORY_NOT_EMPTY',
        'This directory contains user files and is not a Git repository. Choose an empty directory.', 409, { entries: entries.slice(0, 20) });
      await this.#git(directory, ['init', '--initial-branch=main']);
      createdRepository = true;
      const infoExclude = path.join(directory, '.git', 'info', 'exclude');
      fs.appendFileSync(infoExclude, '\n.webspider/\n');
    } else {
      const top = (await this.#git(directory, ['rev-parse', '--show-toplevel'])).trim();
      invariant(fs.realpathSync(top) === directory, 'WS_OVERLEAF_REPOSITORY_MISMATCH',
        'Choose the top-level directory of the manuscript Git repository.', 409);
    }
    try {
      const existing = (await this.#git(directory, ['config', '--get', 'remote.overleaf.url']).catch(() => '')).trim();
      if (existing) invariant(normalizeOverleafProjectURL(existing).projectId === project.projectId,
        'WS_CONFLICT', 'This repository already has an Overleaf remote for another project.', 409);
      else {
        await this.#git(directory, ['remote', 'add', 'overleaf', project.gitURL]);
        addedRemote = true;
      }
      const symref = await this.#git(directory, ['ls-remote', '--symref', 'overleaf', 'HEAD'], { token: credential, timeoutMs: 120_000 });
      const branch = symref.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m)?.[1] || 'main';
      invariant(/^[A-Za-z0-9._/-]{1,160}$/.test(branch) && !branch.includes('..'), 'WS_OVERLEAF_GIT_FAILED', 'Overleaf returned an invalid branch name.', 502);
      await this.#git(directory, ['config', 'webspider.overleafBranch', branch]);
      const repository = { directory, relative, project, branch, remoteRef: `refs/remotes/overleaf/${branch}` };
      await this.#fetch(repository, credential);
      if (!await this.#refExists(directory, 'HEAD')) {
        await this.#git(directory, ['checkout', '-B', branch, '--track', repository.remoteRef]);
      }
      this.credentials.set(credential, { remember: remember !== false });
      this.#rememberConnection(rootId, relative, project.projectId);
      return this.status({ rootId, directory: relative });
    } catch (error) {
      if (createdRepository) {
        try { fs.rmSync(path.join(directory, '.git'), { recursive: true, force: true }); } catch { /* leave recoverable evidence */ }
      } else if (addedRemote) {
        try { await this.#git(directory, ['remote', 'remove', 'overleaf']); } catch { /* leave a token-free recoverable remote */ }
      }
      throw error;
    }
  }

  async status({ rootId, directory: relative = null, fetch = false }) {
    const repository = await this.#repository(rootId, relative);
    let fetchedAt = (await this.#git(repository.directory, ['config', '--get', 'webspider.overleafFetchedAt']).catch(() => '')).trim() || null;
    if (fetch) fetchedAt = await this.#fetch(repository);
    const hasHead = await this.#refExists(repository.directory, 'HEAD');
    const hasRemote = await this.#refExists(repository.directory, repository.remoteRef);
    const branch = (await this.#git(repository.directory, ['branch', '--show-current']).catch(() => '')).trim() || '(detached)';
    const workspacePathspec = ['.', ':(exclude).webspider', ':(exclude).webspider/**'];
    const dirty = parseStatus(await this.#git(repository.directory, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', ...workspacePathspec]));
    let ahead = 0;
    let behind = 0;
    let incoming = [];
    let outgoing = [];
    let comparison = [];
    let conflicts = [];
    if (hasHead && hasRemote) {
      const counts = (await this.#git(repository.directory, ['rev-list', '--left-right', '--count', `HEAD...${repository.remoteRef}`])).trim().split(/\s+/).map(Number);
      [ahead, behind] = counts;
      incoming = parseNames(await this.#git(repository.directory, ['diff', '--name-only', '-z', `HEAD..${repository.remoteRef}`]));
      outgoing = parseNames(await this.#git(repository.directory, ['diff', '--name-only', '-z', `${repository.remoteRef}..HEAD`]));
      comparison = parseNames(await this.#git(repository.directory, ['diff', '--name-only', '-z', repository.remoteRef, '--', ...workspacePathspec]));
      const base = (await this.#git(repository.directory, ['merge-base', 'HEAD', repository.remoteRef]).catch(() => '')).trim();
      if (base) {
        const localChanged = new Set(parseNames(await this.#git(repository.directory, ['diff', '--name-only', '-z', `${base}..HEAD`])));
        for (const entry of dirty) {
          localChanged.add(entry.path);
          if (entry.original_path) localChanged.add(entry.original_path);
        }
        const remoteChanged = parseNames(await this.#git(repository.directory, ['diff', '--name-only', '-z', `${base}..${repository.remoteRef}`]));
        conflicts = remoteChanged.filter((name) => localChanged.has(name));
      }
    }
    return {
      connected: true,
      directory: repository.relative,
      project_id: repository.project.projectId,
      project_url: repository.project.webURL,
      remote_url: repository.project.gitURL,
      remote_branch: repository.branch,
      local_branch: branch,
      local_head: hasHead ? (await this.#git(repository.directory, ['rev-parse', '--short=12', 'HEAD'])).trim() : null,
      remote_head: hasRemote ? (await this.#git(repository.directory, ['rev-parse', '--short=12', repository.remoteRef])).trim() : null,
      fetched_at: fetchedAt,
      ahead, behind, dirty, incoming, outgoing, comparison, conflicts,
      credential_available: this.credentials.has(),
    };
  }

  async diff({ rootId, directory: relative = null, kind = 'comparison', file = '' }) {
    invariant(['local', 'incoming', 'outgoing', 'comparison'].includes(kind), 'WS_VALIDATION', 'Unknown Overleaf diff kind.');
    if (file) validateRelativePath(file, { allowEmpty: false });
    const repository = await this.#repository(rootId, relative);
    const range = {
      local: ['HEAD'],
      incoming: [`HEAD..${repository.remoteRef}`],
      outgoing: [`${repository.remoteRef}..HEAD`],
      comparison: [repository.remoteRef],
    }[kind];
    const args = ['diff', '--no-ext-diff', '--no-color', '--unified=4', ...range];
    if (file) args.push('--', file);
    return { kind, file: file || null, patch: await this.#git(repository.directory, args) };
  }

  async versions({ rootId, directory: relative = null, file }) {
    validateRelativePath(file, { allowEmpty: false });
    const repository = await this.#repository(rootId, relative);
    let local = null;
    let remote = null;
    try { local = (await this.rootService.preview(rootId, combineRelative(repository.relative, file))).content; }
    catch (error) { if (error.code !== 'WS_NOT_FOUND') throw error; }
    try { remote = await this.#git(repository.directory, ['show', `${repository.remoteRef}:${file}`]); }
    catch (error) { if (!/does not exist|exists on disk|Path .* does not exist/i.test(error.message)) throw error; }
    invariant(local != null || remote != null, 'WS_NOT_FOUND', 'This file does not exist locally or on the fetched Overleaf revision.', 404);
    return { file, local, remote, remote_ref: repository.remoteRef };
  }

  async pull({ rootId, directory: relative = null }) {
    const repository = await this.#repository(rootId, relative);
    await this.#fetch(repository);
    const state = await this.status({ rootId, directory: relative });
    invariant(state.dirty.length === 0, 'WS_OVERLEAF_DIRTY', 'Commit or discard local working-tree changes before pulling.', 409);
    invariant(!(state.ahead > 0 && state.behind > 0), 'WS_OVERLEAF_DIVERGED',
      'Local and Overleaf histories diverged. Review and resolve them instead of pulling automatically.', 409);
    await this.#git(repository.directory, ['merge', '--ff-only', repository.remoteRef]);
    return this.status({ rootId, directory: relative });
  }

  async push({ rootId, directory: relative = null, commitMessage = '' }) {
    const repository = await this.#repository(rootId, relative);
    await this.#fetch(repository);
    let state = await this.status({ rootId, directory: relative });
    invariant(state.behind === 0, 'WS_OVERLEAF_BEHIND', 'Overleaf has newer changes. Pull or resolve them before pushing.', 409);
    const reservedTracked = parseNames(await this.#git(repository.directory, ['ls-files', '-z', '--', '.webspider']));
    invariant(reservedTracked.length === 0, 'WS_OVERLEAF_RESERVED_TRACKED',
      'Remove the reserved .webspider directory from Git tracking before pushing to Overleaf.', 409);
    if (state.dirty.length) {
      invariant(typeof commitMessage === 'string' && commitMessage.trim().length > 0 && commitMessage.length <= 500,
        'WS_OVERLEAF_DIRTY', 'Enter a commit message to commit local manuscript changes before pushing.', 409);
      const changedPaths = [...new Set(state.dirty.flatMap((entry) => [entry.path, entry.original_path]).filter(Boolean))];
      await this.#git(repository.directory, ['add', '--all', '--', ...changedPaths]);
      await this.#git(repository.directory, ['commit', '-m', commitMessage.trim()]);
      state = await this.status({ rootId, directory: relative });
    }
    invariant(state.local_head, 'WS_OVERLEAF_EMPTY', 'There is no local commit to push.', 409);
    await this.#git(repository.directory, ['push', 'overleaf', `HEAD:refs/heads/${repository.branch}`], { token: this.#token(), timeoutMs: 180_000 });
    await this.#git(repository.directory, ['update-ref', repository.remoteRef, 'HEAD']);
    return this.status({ rootId, directory: relative });
  }
}
