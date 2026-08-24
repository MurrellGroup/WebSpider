import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { RootedFileService, validateRelativePath } from '../src/node/root-fs.js';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-root-'));
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'results'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'README.md'), '# Workspace\nneedle in allowed file\n');
  fs.writeFileSync(path.join(root, 'results', 'summary.txt'), 'summary needle\n');
  fs.writeFileSync(path.join(root, '.hidden'), 'hidden');
  fs.writeFileSync(path.join(root, 'unsafe.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'external-link'));
  fs.symlinkSync(path.join(root, 'README.md'), path.join(root, 'internal-link'));
  spawnSync('mkfifo', [path.join(root, 'named-pipe')]);
  const service = new RootedFileService([{ id: 'awr_test', path: root, symlink_policy: 'no_symlinks' }]);
  return { base, root, outside, service };
}

test('relative path validation rejects traversal and host paths', () => {
  assert.deepEqual(validateRelativePath('results/summary.txt'), ['results', 'summary.txt']);
  for (const invalid of ['../secret', 'a/../../secret', '/etc/passwd', 'C:\\Windows\\system.ini', 'a//b', './x', 'a/..', 'a\u2215b']) {
    assert.throws(() => validateRelativePath(invalid), (error) => ['WS_PATH_INVALID', 'WS_PATH_ESCAPE_BLOCKED'].includes(error.code));
  }
});

test('rooted reads, listings, preview, and search stay inside the registered root', async (t) => {
  const value = fixture();
  t.after(() => {
    value.service.close();
    fs.rmSync(value.base, { recursive: true, force: true });
  });
  const listing = await value.service.entries('awr_test');
  assert(listing.entries.some((entry) => entry.name === 'README.md'));
  assert(!listing.entries.some((entry) => entry.name === '.hidden'));
  const preview = await value.service.preview('awr_test', 'README.md');
  assert.match(preview.content, /Workspace/);
  const search = await value.service.search('awr_test', 'needle');
  assert(search.results.some((entry) => entry.path === 'README.md'));
  assert(search.results.every((entry) => !entry.path.includes('outside')));
});

test('escaping symlinks, internal symlinks in strict mode, and special files are blocked', async (t) => {
  const value = fixture();
  t.after(() => {
    value.service.close();
    fs.rmSync(value.base, { recursive: true, force: true });
  });
  await assert.rejects(() => value.service.readFile('awr_test', 'external-link'), (error) => error.code === 'WS_SYMLINK_BLOCKED');
  await assert.rejects(() => value.service.readFile('awr_test', 'internal-link'), (error) => error.code === 'WS_SYMLINK_BLOCKED');
  await assert.rejects(() => value.service.readFile('awr_test', 'named-pipe'), (error) => error.code === 'WS_SPECIAL_FILE_BLOCKED');
  const link = await value.service.stat('awr_test', 'external-link');
  assert.equal(link.kind, 'symlink');
  assert.equal(link.downloadable, false);
  assert.equal(link.link_scope, 'blocked_external_or_broken');
});

test('active content is never returned through the preview API', async (t) => {
  const value = fixture();
  t.after(() => {
    value.service.close();
    fs.rmSync(value.base, { recursive: true, force: true });
  });
  await assert.rejects(() => value.service.preview('awr_test', 'unsafe.html'), (error) => error.code === 'WS_PREVIEW_UNSAFE');
  const download = await value.service.readFile('awr_test', 'unsafe.html');
  assert.match(download.bytes.toString('utf8'), /script/);
});

test('contained-only policy may follow an internal symlink but never an external one', async (t) => {
  const value = fixture();
  value.service.close();
  value.service = new RootedFileService([{ id: 'awr_test', path: value.root, symlink_policy: 'contained_only' }]);
  t.after(() => {
    value.service.close();
    fs.rmSync(value.base, { recursive: true, force: true });
  });
  const internal = await value.service.readFile('awr_test', 'internal-link');
  assert.match(internal.bytes.toString('utf8'), /Workspace/);
  await assert.rejects(() => value.service.readFile('awr_test', 'external-link'), (error) => error.code === 'WS_PATH_ESCAPE_BLOCKED');
});

test('a deleted or replaced root path is revoked rather than silently retargeted', async (t) => {
  const value = fixture();
  const moved = `${value.root}-moved`;
  fs.renameSync(value.root, moved);
  fs.mkdirSync(value.root);
  fs.writeFileSync(path.join(value.root, 'secret.txt'), 'replacement data');
  t.after(() => {
    value.service.close();
    fs.rmSync(value.base, { recursive: true, force: true });
  });
  await assert.rejects(() => value.service.readFile('awr_test', 'secret.txt'), (error) => error.code === 'WS_ROOT_REVOKED');
});
