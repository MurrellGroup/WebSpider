import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(repository, 'web', 'app.js'), 'utf8');
const page = fs.readFileSync(path.join(repository, 'web', 'index.html'), 'utf8');
const packageVersion = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')).version;

test('portal and hub version are synchronized and version skew is explicit', () => {
  const hub = fs.readFileSync(path.join(repository, 'src', 'hub', 'hub.js'), 'utf8');
  assert.match(app, new RegExp(`const PORTAL_VERSION = '${packageVersion.replaceAll('.', '\\.')}'`));
  assert.match(hub, new RegExp(`version: '${packageVersion.replaceAll('.', '\\.')}'`));
  assert.match(app, /health\.version !== PORTAL_VERSION/);
  assert.match(app, /showVersionMismatch\(health\.version\)/);
  assert.match(app, /systemctl --user restart webspider\.service/);
});

test('Master Spider navigation opens its terminal and portfolio is separate', () => {
  assert.match(page, /class="nav-master selected" data-action="master"/);
  assert.match(page, /<strong>Master Spider<\/strong><small>Persistent terminal<\/small>/);
  assert.match(app, /if \(action === 'master'\) return openMasterTerminal\(\)/);
  assert.match(app, /if \(parts\[0\] === 'home'\) return openMasterTerminal\(\)/);
  assert.match(app, /orchestration_role === 'main'.*data-action="overview".*Portfolio/);
  assert.match(app, /history\.replaceState\(null, '', '#\/overview'\)/);
});

test('project onboarding uses the current hub route', () => {
  assert.match(page, /data-action="onboard-project" title="Add project"/);
  assert.match(app, /if \(action === 'onboard-project'\) return showProjectOnboarding\(\)/);
  assert.match(app, /api\('\/api\/v1\/projects\/onboard'/);
});
