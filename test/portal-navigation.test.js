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

test('agent pages expose compact editable custom instructions', () => {
  assert.match(app, /const primary = \['terminal', 'instructions'/);
  assert.match(app, /id="agent-instructions-form"/);
  assert.match(app, /Custom instructions/);
  assert.match(app, /Keep this short; trust the agent’s judgment/);
  assert.match(app, /\/api\/v1\/agent-instances\/\$\{encodeURIComponent\(agentId\)\}\/instructions/);
  assert.match(app, /Save & restart/);
  assert.match(app, /Full instruction preview/);
});

test('one browser editor manages worker-only instructions without changing the Master', () => {
  assert.match(page, /data-action="show-worker-instructions"/);
  assert.match(app, /id="worker-instructions-form"/);
  assert.match(app, /Worker-only instructions; the Master Spider does not inherit this text/);
  assert.match(app, /requested_instructions: \{ workers: instructions \}/);
  assert.match(app, /orchestration_role !== 'main'/);
  assert.match(app, /Save & restart workers/);
  assert.match(app, /if \(parts\[0\] === 'sub-spider-instructions'\) return renderWorkerInstructions\(\)/);
});

test('project onboarding uses the current hub route', () => {
  assert.match(page, /data-action="onboard-project" title="Add project"/);
  assert.match(app, /if \(action === 'onboard-project'\) return showProjectOnboarding\(\)/);
  assert.match(app, /api\('\/api\/v1\/projects\/onboard'/);
});

test('archived projects have a dedicated restore and guarded-delete view', () => {
  assert.match(page, /data-action="show-archived"/);
  assert.match(app, /api\('\/api\/v1\/projects\?archived=only'/);
  assert.match(app, /if \(parts\[0\] === 'archived'\) return renderArchivedProjects\(\)/);
  assert.match(app, /data-action="archive-project"/);
  assert.match(app, /data-action="restore-project"/);
  assert.match(app, /data-action="delete-project"/);
  assert.match(app, /Type the project name to confirm/);
  assert.match(app, /Workspace files will not be touched/);
});

test('worker command copy supports plain HTTP without the Clipboard API', () => {
  assert.match(app, /navigator\.clipboard\?\.writeText/);
  assert.match(app, /control\.select\(\)/);
  assert.match(app, /document\.execCommand\('copy'\)/);
  assert.match(app, /Command selected; press Ctrl\/Cmd\+C to copy it\./);
});

test('note editor clicks do not reopen the note and discard the active draft', () => {
  assert.match(app, /event\.target\.closest\('\.note-row\[data-note-id\]'\)/);
  assert.doesNotMatch(app, /event\.target\.closest\('\[data-note-id\]'\)/);
});

test('terminal pages begin in watch mode and acquire control only on interaction', () => {
  const hub = fs.readFileSync(path.join(repository, 'src', 'hub', 'hub.js'), 'utf8');
  assert.match(app, /interactive \? 'Take control' : 'Not running'/);
  assert.doesNotMatch(app, /frame\.type === 'ATTACHED'.*LEASE_REQUEST/);
  assert.match(app, /function requestTerminalLease\(\)/);
  assert.match(app, /if \(terminalInputMode\).*requestTerminalLease\(\)/s);
  assert.match(hub, /connection\.on\('close'.*releaseTerminalLease/s);
});
