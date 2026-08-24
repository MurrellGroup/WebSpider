import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveAgentProfile, writeNodeConfig } from '../src/cli.js';

test('the default profile is a persistent login shell', () => {
  const profile = resolveAgentProfile();
  assert.equal(profile.id, 'apf_shell');
  assert.equal(profile.name, 'Main terminal');
  assert.deepEqual(profile.arguments, ['-l']);
});

test('one explicit agent command resolves without a full profile specification', () => {
  const profile = resolveAgentProfile({
    'agent-command': '/opt/tools/codex',
    'agent-args': '["--example"]',
  });
  assert.equal(profile.name, 'Codex');
  assert.equal(profile.executable, '/opt/tools/codex');
  assert.deepEqual(profile.arguments, ['--example']);
});

test('agent arguments reject ambiguous shell text', () => {
  assert.throws(() => resolveAgentProfile({
    'agent-command': '/opt/tools/codex',
    'agent-args': '--example unsafe',
  }), /JSON array/);
});

test('node configuration updates preserve newly attached project roots', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-node-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeNodeConfig(directory, { roots: [{ id: 'awr_one', path: '/project/one' }] });
  writeNodeConfig(directory, { roots: [
    { id: 'awr_one', path: '/project/one' },
    { id: 'awr_two', path: '/project/two' },
  ] });
  const stored = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
  assert.deepEqual(stored.roots.map((root) => root.id), ['awr_one', 'awr_two']);
  assert.equal(fs.statSync(path.join(directory, 'config.json')).mode & 0o777, 0o600);
});
