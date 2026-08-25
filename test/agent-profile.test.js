import test from 'node:test';
import assert from 'node:assert/strict';
import { agentLaunchArguments } from '../src/lib/agent-profile.js';

test('existing Codex profiles with empty arguments receive unattended launch defaults', () => {
  assert.deepEqual(agentLaunchArguments('/usr/local/bin/codex', []), [
    '--ask-for-approval',
    'never',
    '--sandbox',
    'danger-full-access',
  ]);
});

test('explicit profile arguments are preserved', () => {
  assert.deepEqual(agentLaunchArguments('codex', ['--profile', 'review']), ['--profile', 'review']);
  assert.deepEqual(agentLaunchArguments('/bin/bash', []), []);
});
