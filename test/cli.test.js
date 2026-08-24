import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentProfile } from '../src/cli.js';

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
