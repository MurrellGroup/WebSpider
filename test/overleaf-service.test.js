import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OverleafService, normalizeOverleafProjectURL } from '../src/node/overleaf-service.js';
import { RootedFileService } from '../src/node/root-fs.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(directory, args, environment = {}) {
  const result = spawnSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', env: { ...process.env, ...environment },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function fixture() {
  fs.mkdirSync(path.join(repository, 'Sandbox'), { recursive: true });
  const base = fs.mkdtempSync(path.join(repository, 'Sandbox', 'overleaf-test-'));
  const seed = path.join(base, 'seed');
  const remotes = path.join(base, 'remotes');
  const remote = path.join(remotes, 'project123');
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(seed);
  fs.mkdirSync(remotes);
  fs.mkdirSync(path.join(workspace, '.webspider'), { recursive: true });
  git(seed, ['init', '--initial-branch=main']);
  git(seed, ['config', 'user.name', 'Overleaf Test']);
  git(seed, ['config', 'user.email', 'overleaf@example.invalid']);
  fs.writeFileSync(path.join(seed, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nRemote v1\n\\end{document}\n');
  git(seed, ['add', 'main.tex']);
  git(seed, ['commit', '-m', 'Initial manuscript']);
  git(base, ['clone', '--bare', seed, remote]);
  const environment = {
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_CEILING_DIRECTORIES: base,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://git@git.overleaf.com/',
  };
  const rootService = new RootedFileService([{ id: 'awr_overleaf', path: workspace }]);
  const service = new OverleafService({ stateDir: path.join(base, 'state'), rootService, secret: 'node-private-key', environment });
  return { base, seed, remote, workspace, environment, rootService, service };
}

test('Overleaf URLs normalize without embedding the token', () => {
  assert.deepEqual(normalizeOverleafProjectURL('https://www.overleaf.com/project/project123'), {
    projectId: 'project123',
    webURL: 'https://www.overleaf.com/project/project123',
    gitURL: 'https://git@git.overleaf.com/project123',
  });
  assert.equal(normalizeOverleafProjectURL('https://git@git.overleaf.com/project123').projectId, 'project123');
  assert.throws(() => normalizeOverleafProjectURL('https://example.com/project/project123'), { code: 'WS_VALIDATION' });
  assert.throws(() => normalizeOverleafProjectURL('https://token@git.overleaf.com/project123'), { code: 'WS_VALIDATION' });
});

test('Overleaf connection, comparison, push, and pull preserve node-local credentials', async (t) => {
  const value = fixture();
  t.after(() => {
    value.rootService.close();
    fs.rmSync(value.base, { recursive: true, force: true });
  });
  const token = 'secret-overleaf-token-123';
  let status = await value.service.connect({
    rootId: 'awr_overleaf', directory: '', projectURL: 'https://www.overleaf.com/project/project123', token, remember: true,
  });
  assert.equal(status.connected, true);
  assert.equal(status.remote_branch, 'main');
  assert.equal(fs.readFileSync(path.join(value.workspace, 'main.tex'), 'utf8').includes('Remote v1'), true);
  assert.equal(fs.readFileSync(path.join(value.workspace, '.git', 'config'), 'utf8').includes(token), false);
  assert.equal(fs.readFileSync(path.join(value.base, 'state', 'credentials.json'), 'utf8').includes(token), false);
  assert.equal(fs.statSync(path.join(value.base, 'state', 'credentials.json')).mode & 0o077, 0);

  git(value.workspace, ['config', 'user.name', 'Local Writer']);
  git(value.workspace, ['config', 'user.email', 'writer@example.invalid']);
  fs.writeFileSync(path.join(value.workspace, 'main.tex'), fs.readFileSync(path.join(value.workspace, 'main.tex'), 'utf8').replace('Remote v1', 'Local v2'));
  status = await value.service.status({ rootId: 'awr_overleaf' });
  assert.equal(status.dirty.length, 1);
  assert.deepEqual(status.comparison, ['main.tex']);
  const versions = await value.service.versions({ rootId: 'awr_overleaf', file: 'main.tex' });
  assert.match(versions.local, /Local v2/);
  assert.match(versions.remote, /Remote v1/);
  status = await value.service.push({ rootId: 'awr_overleaf', commitMessage: 'Local revision' });
  assert.equal(status.ahead, 0);
  assert.match(git(value.remote, ['show', 'main:main.tex']), /Local v2/);

  const collaborator = path.join(value.base, 'collaborator');
  git(value.base, ['clone', value.remote, collaborator]);
  git(collaborator, ['config', 'user.name', 'Overleaf Collaborator']);
  git(collaborator, ['config', 'user.email', 'collaborator@example.invalid']);
  fs.writeFileSync(path.join(collaborator, 'main.tex'), fs.readFileSync(path.join(collaborator, 'main.tex'), 'utf8').replace('Local v2', 'Overleaf v3'));
  git(collaborator, ['add', 'main.tex']);
  git(collaborator, ['commit', '-m', 'Overleaf revision']);
  git(collaborator, ['push', 'origin', 'main']);

  status = await value.service.status({ rootId: 'awr_overleaf', fetch: true });
  assert.equal(status.behind, 1);
  assert.deepEqual(status.incoming, ['main.tex']);
  const incoming = await value.service.diff({ rootId: 'awr_overleaf', kind: 'incoming', file: 'main.tex' });
  assert.match(incoming.patch, /Overleaf v3/);
  status = await value.service.pull({ rootId: 'awr_overleaf' });
  assert.equal(status.behind, 0);
  assert.match(fs.readFileSync(path.join(value.workspace, 'main.tex'), 'utf8'), /Overleaf v3/);

  const reopened = new OverleafService({
    stateDir: path.join(value.base, 'state'), rootService: value.rootService, secret: 'node-private-key', environment: value.environment,
  });
  const reopenedStatus = await reopened.status({ rootId: 'awr_overleaf', fetch: true });
  assert.equal(reopenedStatus.credential_available, true);
  await reopened.connect({
    rootId: 'awr_overleaf', directory: '', projectURL: 'https://www.overleaf.com/project/project123',
    token: '', remember: false,
  });
  assert.equal(fs.existsSync(path.join(value.base, 'state', 'credentials.json')), false);
  const afterForget = new OverleafService({
    stateDir: path.join(value.base, 'state'), rootService: value.rootService, secret: 'node-private-key', environment: value.environment,
  });
  assert.equal((await afterForget.status({ rootId: 'awr_overleaf' })).credential_available, false);
});

test('Overleaf connection refuses a non-repository directory containing user files', async (t) => {
  const value = fixture();
  t.after(() => {
    value.rootService.close();
    fs.rmSync(value.base, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(value.workspace, 'do-not-overwrite.txt'), 'important');
  await assert.rejects(value.service.connect({
    rootId: 'awr_overleaf', directory: '', projectURL: 'https://www.overleaf.com/project/project123',
    token: 'secret-overleaf-token-123', remember: false,
  }), { code: 'WS_OVERLEAF_DIRECTORY_NOT_EMPTY' });
  assert.equal(fs.readFileSync(path.join(value.workspace, 'do-not-overwrite.txt'), 'utf8'), 'important');
  assert.equal(fs.existsSync(path.join(value.workspace, '.git')), false);
});
