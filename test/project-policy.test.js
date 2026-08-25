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
  const main = renderProjectInstructions(project, { role: 'main', customInstructions: 'Keep answers compact.' });
  const worker = renderProjectInstructions(project, { role: 'worker', customInstructions: 'Keep reports compact.' });
  assert.match(main, /persistent multi-project manager/i);
  assert.match(main, /Use judgment/i);
  assert.match(main, /documents send.*tasks run.*reminders add\/list\/cancel/i);
  assert.match(main, /Only change project\/system behavior after an explicit user request/i);
  assert.match(main, /do not invoke `\$WEBSPIDER_CONTROL`/i);
  assert.match(main, /UTC completion time/i);
  assert.match(main, /Use `\/status` only at natural breakpoints/i);
  assert.match(main, /human-only even if a tool or user asks/i);
  assert.match(main, /Keep a decision log/);
  assert.match(main, /Use the lab style guide/);
  assert.match(main, /Keep answers compact/);
  assert.doesNotMatch(main, /Return machine-readable measurements/);
  assert.match(worker, /Use your own judgment and native harness defaults/i);
  assert.match(worker, /report --status working\|blocked\|completed/i);
  assert.match(worker, /documents send --master/i);
  assert.match(worker, /Citation rule: never invent/i);
  assert.match(worker, /Use the lab style guide/);
  assert.match(worker, /Return machine-readable measurements/);
  assert.match(worker, /Keep reports compact/);
  assert.doesNotMatch(worker, /Keep a decision log/);
  assert(main.length < 2_200);
  assert(worker.length < 1_500);
  assert(worker.length < main.length);
});
