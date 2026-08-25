import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  fs.writeFileSync(path.join(root, 'figure.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(root, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>');
  fs.writeFileSync(path.join(root, 'paper.pdf'), Buffer.from('%PDF-1.4\n%%EOF\n'));
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

test('media previews are root-confined and allow images, SVG, and PDF without treating SVG as text', async (t) => {
  const value = fixture();
  t.after(() => {
    value.service.close();
    fs.rmSync(value.base, { recursive: true, force: true });
  });
  assert.deepEqual((await value.service.previewMedia('awr_test', 'figure.png')).bytes, Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.match((await value.service.previewMedia('awr_test', 'diagram.svg')).bytes.toString('utf8'), /<svg/);
  assert.match((await value.service.previewMedia('awr_test', 'paper.pdf')).bytes.toString('utf8'), /^%PDF/);
  await assert.rejects(() => value.service.preview('awr_test', 'diagram.svg'), (error) => error.code === 'WS_PREVIEW_UNSAFE');
  await assert.rejects(() => value.service.previewMedia('awr_test', 'README.md'), (error) => error.code === 'WS_PREVIEW_UNSUPPORTED');
  await assert.rejects(() => value.service.previewMedia('awr_test', '../outside/secret.txt'),
    (error) => ['WS_PREVIEW_UNSUPPORTED', 'WS_PATH_ESCAPE_BLOCKED'].includes(error.code));
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

test('document handoffs write checksum-verified immutable inbox files', (t) => {
  const value = fixture();
  t.after(() => {
    value.service.close();
    fs.rmSync(value.base, { recursive: true, force: true });
  });
  const bytes = Buffer.from('# Worker plan\nRun the bounded validation.\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const written = value.service.writeInbox('awr_test', {
    documentId: 'doc_abcdefgh1234', filename: 'worker-plan.md', bytes, sha256,
  });
  assert.equal(written.relative_path, '.webspider/inbox/doc_abcdefgh1234-worker-plan.md');
  assert.equal(written.duplicate, false);
  assert.equal(fs.readFileSync(path.join(value.root, written.relative_path), 'utf8'), bytes.toString('utf8'));
  assert.equal(fs.statSync(path.join(value.root, written.relative_path)).mode & 0o777, 0o600);
  assert.equal(value.service.writeInbox('awr_test', {
    documentId: 'doc_abcdefgh1234', filename: 'worker-plan.md', bytes, sha256,
  }).duplicate, true);
  assert.throws(() => value.service.writeInbox('awr_test', {
    documentId: 'doc_abcdefgh1234', filename: 'worker-plan.md',
    bytes: Buffer.from('different'), sha256: createHash('sha256').update('different').digest('hex'),
  }), (error) => error.code === 'WS_CONFLICT');
});

test('document handoffs reject a symlinked reserved inbox', (t) => {
  const value = fixture();
  fs.symlinkSync(value.outside, path.join(value.root, '.webspider'));
  t.after(() => {
    value.service.close();
    fs.rmSync(value.base, { recursive: true, force: true });
  });
  const bytes = Buffer.from('do not escape');
  assert.throws(() => value.service.writeInbox('awr_test', {
    documentId: 'doc_abcdefgh5678', filename: 'instructions.txt', bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }), (error) => error.code === 'WS_PATH_ESCAPE_BLOCKED');
  assert.equal(fs.existsSync(path.join(value.outside, 'inbox')), false);
});

test('the package-owned Master guide is refreshed atomically inside the workspace', (t) => {
  const value = fixture();
  t.after(() => {
    value.service.close();
    fs.rmSync(value.base, { recursive: true, force: true });
  });
  const first = value.service.writeUserGuide('awr_test', Buffer.from('WebSpider guide version one\n'));
  assert.equal(first.relative_path, '.webspider/WEBSPIDER_USER_GUIDE.txt');
  const guidePath = path.join(value.root, first.relative_path);
  assert.equal(fs.readFileSync(guidePath, 'utf8'), 'WebSpider guide version one\n');
  assert.equal(fs.statSync(guidePath).mode & 0o777, 0o600);
  value.service.writeUserGuide('awr_test', Buffer.from('WebSpider guide version two\n'));
  assert.equal(fs.readFileSync(guidePath, 'utf8'), 'WebSpider guide version two\n');
});

test('the Master guide rejects a symlinked reserved WebSpider path', (t) => {
  const value = fixture();
  fs.symlinkSync(value.outside, path.join(value.root, '.webspider'));
  t.after(() => {
    value.service.close();
    fs.rmSync(value.base, { recursive: true, force: true });
  });
  assert.throws(() => value.service.writeUserGuide('awr_test', Buffer.from('do not escape')),
    (error) => error.code === 'WS_PATH_ESCAPE_BLOCKED');
  assert.equal(fs.existsSync(path.join(value.outside, 'WEBSPIDER_USER_GUIDE.txt')), false);
});

test('clipboard images are checksum-verified and written privately inside the workspace', (t) => {
  const value = fixture();
  t.after(() => {
    value.service.close();
    fs.rmSync(value.base, { recursive: true, force: true });
  });
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const upload = value.service.writeImageUpload('awr_test', {
    uploadId: 'upl_abcdefgh12345678', mimeType: 'image/png', bytes, sha256,
  });
  assert.equal(upload.relative_path, '.webspider/uploads/upl_abcdefgh12345678.png');
  assert.deepEqual(fs.readFileSync(path.join(value.root, upload.relative_path)), bytes);
  assert.equal(fs.statSync(path.join(value.root, upload.relative_path)).mode & 0o777, 0o600);
  assert.equal(value.service.writeImageUpload('awr_test', {
    uploadId: 'upl_abcdefgh12345678', mimeType: 'image/png', bytes, sha256,
  }).duplicate, true);
  assert.throws(() => value.service.writeImageUpload('awr_test', {
    uploadId: 'upl_wrongtype12345678', mimeType: 'image/jpeg', bytes, sha256,
  }), (error) => error.code === 'WS_UPLOAD_INVALID');
});
