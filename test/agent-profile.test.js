import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentLaunchArguments, CODEX_STABLE_MODEL_ARGUMENTS, hasStableCodexModelArguments,
} from '../src/lib/agent-profile.js';

test('existing Codex profiles with empty arguments receive unattended launch defaults', () => {
  assert.deepEqual(agentLaunchArguments('/usr/local/bin/codex', []), [
    '--ask-for-approval',
    'never',
    '--sandbox',
    'danger-full-access',
    ...CODEX_STABLE_MODEL_ARGUMENTS,
  ]);
});

test('explicit Codex profile arguments are preserved with stable-model safeguards appended', () => {
  const argumentsList = agentLaunchArguments('codex', ['--profile', 'review']);
  assert.deepEqual(argumentsList, ['--profile', 'review', ...CODEX_STABLE_MODEL_ARGUMENTS]);
  assert.equal(hasStableCodexModelArguments(argumentsList), true);
  assert.deepEqual(agentLaunchArguments('/bin/bash', []), []);
});

test('stable-model safeguards override conflicting profile config and remain idempotent', () => {
  const configured = [
    '--profile', 'review',
    '-c', 'notice.hide_rate_limit_model_nudge=false',
    '--config', 'tui.keymap.composer.submit=["enter"]',
  ];
  const once = agentLaunchArguments('codex', configured);
  const twice = agentLaunchArguments('codex', once);
  assert.deepEqual(once, ['--profile', 'review', ...CODEX_STABLE_MODEL_ARGUMENTS]);
  assert.deepEqual(twice, once);
  assert.equal(hasStableCodexModelArguments(configured), false);
  assert.deepEqual(agentLaunchArguments('codex', ['--', 'literal prompt']), [
    ...CODEX_STABLE_MODEL_ARGUMENTS, '--', 'literal prompt',
  ]);
});
