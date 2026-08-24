import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDefaultProjectPolicy,
  inferProjectContext,
  mergeProjectPolicy,
  renderProjectInstructions,
} from '../src/lib/project-policy.js';

test('academic project context and low-burden defaults are inferred without a setup questionnaire', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-policy-'));
  fs.mkdirSync(path.join(workspace, 'manuscript'));
  fs.writeFileSync(path.join(workspace, 'manuscript', 'paper.tex'), '\\documentclass{article}');
  fs.writeFileSync(path.join(workspace, 'references.bib'), '@article{example}');
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const context = inferProjectContext(workspace);
  assert.equal(context.kind, 'academic');
  assert.equal(context.inference, 'workspace-signals');
  assert(context.signals.includes('scholarly source files'));

  const policy = createDefaultProjectPolicy({ kind: context.kind, signals: context.signals });
  assert.equal(policy.principle, 'minimize_user_burden');
  assert.equal(policy.schema_version, 3);
  assert.equal(policy.autonomy.inspect_before_asking, true);
  assert.equal(policy.scholarly_work_product.enabled, true);
  assert.equal(policy.account_quota.track_weekly_remaining, true);
  assert(policy.account_quota.human_only_account_actions.some((item) => item.includes('token refresh')));
});

test('project policy patches preserve inherited defaults and render an actionable agreement', () => {
  const base = createDefaultProjectPolicy();
  const policy = mergeProjectPolicy(base, {
    execution: { minimize_unrelated_changes: false },
    requested_instructions: {
      main: ['Keep a decision log.'],
      work_product: ['Use the lab style guide.'],
      workers: ['Return machine-readable measurements.'],
    },
  });
  assert.equal(policy.execution.minimize_unrelated_changes, false);
  assert.equal(policy.execution.validate_before_claiming_completion, true);
  const project = { name: 'Study', description: '', labels: { project_kind: 'academic' }, policy };
  const main = renderProjectInstructions(project, { role: 'main' });
  const worker = renderProjectInstructions(project, { role: 'worker' });
  assert.match(main, /proceed with the best safe, reversible interpretation/i);
  assert.match(main, /Remote agents are already tuned to their harnesses/i);
  assert.match(main, /If you are a harness-native subagent that inherited this file/i);
  assert.match(main, /Do not invoke `\$WEBSPIDER_CONTROL` from a child thread/i);
  assert.match(main, /Include a UTC completion timestamp/i);
  assert.match(main, /only after the user explicitly asks/i);
  assert.match(main, /Use `\/status` at natural breakpoints/i);
  assert.match(main, /`\/status` is the source for the account rate-limit windows/i);
  assert.match(main, /`\/usage weekly` may be used only as optional supporting token-activity/i);
  assert.match(main, /must NEVER redeem or consume a token refresh/i);
  assert.match(main, /switch work to API-funded usage/i);
  assert.match(main, /This remains forbidden even if .* the user asks/i);
  assert.match(main, /WEBSPIDER_CONTROL usage report --weekly-remaining/i);
  assert.match(main, /Keep a decision log/);
  assert.match(main, /Use the lab style guide/);
  assert.doesNotMatch(main, /Return machine-readable measurements/);
  assert.match(worker, /Use your native harness defaults/i);
  assert.match(worker, /Citation rule: never invent/i);
  assert.match(worker, /Use the lab style guide/);
  assert.match(worker, /Return machine-readable measurements/);
  assert.doesNotMatch(worker, /Keep a decision log/);
  assert.doesNotMatch(worker, /Behavior and default changes/i);
  assert.doesNotMatch(worker, /Weekly account allowance/i);
  assert.doesNotMatch(worker, /Reduce user burden/i);
  assert(worker.length < main.length / 2);
});
