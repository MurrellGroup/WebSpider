import fs from 'node:fs';
import path from 'node:path';

const ACADEMIC_PATTERNS = [
  { pattern: /(?:^|\/)(?:manuscript|paper|article|thesis|dissertation)(?:\/|\.|$)/i, weight: 4, label: 'manuscript files' },
  { pattern: /\.(?:bib|tex|qmd|rmd)$/i, weight: 4, label: 'scholarly source files' },
  { pattern: /(?:^|\/)(?:figures?|tables?|references?|bibliography)(?:\/|$)/i, weight: 2, label: 'publication assets' },
  { pattern: /(?:^|\/)(?:analysis|analyses|results?|methods?|notebooks?)(?:\/|$)/i, weight: 1, label: 'research workflow' },
  { pattern: /\.(?:ipynb|ris|enw|nbib)$/i, weight: 2, label: 'research artifacts' },
];

function plainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function mergeProjectPolicy(base, patch) {
  if (!plainObject(patch)) return structuredClone(base);
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (plainObject(value) && plainObject(output[key])) output[key] = mergeProjectPolicy(output[key], value);
    else output[key] = structuredClone(value);
  }
  return output;
}

export function diffProjectPolicy(base, value) {
  if (!plainObject(base) || !plainObject(value)) {
    return JSON.stringify(base) === JSON.stringify(value) ? undefined : structuredClone(value);
  }
  const output = {};
  for (const [key, next] of Object.entries(value)) {
    const difference = diffProjectPolicy(base[key], next);
    if (difference !== undefined) output[key] = difference;
  }
  return Object.keys(output).length ? output : undefined;
}

export function inferProjectContext(workspace, { maxEntries = 250, maxDepth = 2 } = {}) {
  const root = path.resolve(workspace);
  const seen = [];
  const queue = [{ directory: root, relative: '', depth: 0 }];
  while (queue.length && seen.length < maxEntries) {
    const current = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen.length >= maxEntries) break;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.webspider')) continue;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      seen.push(relative);
      if (entry.isDirectory() && current.depth < maxDepth && !entry.isSymbolicLink()) {
        queue.push({ directory: path.join(current.directory, entry.name), relative, depth: current.depth + 1 });
      }
    }
  }
  let score = 0;
  const signals = new Set();
  for (const filename of seen) {
    for (const rule of ACADEMIC_PATTERNS) {
      if (!rule.pattern.test(filename)) continue;
      score += rule.weight;
      signals.add(rule.label);
    }
  }
  return {
    name: path.basename(root) || 'Research project',
    kind: 'academic',
    inference: score >= 4 ? 'workspace-signals' : 'academic-first-default',
    confidence: score >= 8 ? 'high' : score >= 4 ? 'medium' : 'default',
    signals: [...signals],
    scanned_entries: seen.length,
  };
}

export function createDefaultProjectPolicy({ kind = 'academic', signals = [] } = {}) {
  const academic = kind === 'academic';
  return {
    schema_version: 3,
    principle: 'minimize_user_burden',
    inferred_from: signals,
    behavior_control: {
      main_agent_can_edit: true,
      edit_trigger: 'explicit_user_request_only',
      editable_scopes: ['project', 'system'],
      reason_and_revision_required: true,
      worker_agents_can_edit: false,
    },
    context_budget: {
      main_agent_tracks_usage: true,
      check_at_natural_breakpoints: true,
      subagent_status_check_allowed: true,
      avoid_interruptive_polling: true,
    },
    account_quota: {
      enabled: true,
      allowance_source: 'codex_status',
      activity_source: 'codex_usage_weekly',
      track_weekly_remaining: true,
      refresh_at: [
        'session start when no fresh snapshot exists',
        'before a materially costly delegation or long run',
        'when the last observation is more than two hours old',
      ],
      never_estimate_between_observations: true,
      human_only_account_actions: [
        'redeem or consume a token refresh or rate-limit reset',
        'purchase, add, or switch to credits',
        'change billing, subscription plan, or authentication mode',
        'switch execution to API-funded usage',
        'send an add-credit, reset, or entitlement request',
      ],
    },
    requested_instructions: {
      main: [],
      work_product: [],
      workers: [],
    },
    harness_deference: {
      enabled: true,
      remote_default: 'native_harness',
      add_rules_only_for: [
        'an explicit user preference',
        'a safety, authority, or data-integrity boundary',
        'a project-specific factual or scientific invariant',
        'an acceptance criterion that materially changes the result',
      ],
      otherwise: 'omit the rule and trust the remote agent harness',
    },
    autonomy: {
      default_action: 'proceed_with_best_reversible_interpretation',
      inspect_before_asking: true,
      infer_from_project: true,
      consolidate_questions: true,
      ask_only_when: [
        'a choice materially changes the scientific or technical result',
        'the action is irreversible or expands authority',
        'required evidence, access, or an essential input is unavailable',
      ],
      when_asking: 'recommend one option and explain the consequence briefly',
    },
    execution: {
      preserve_existing_work: true,
      minimize_unrelated_changes: true,
      use_project_conventions: true,
      validate_before_claiming_completion: true,
      report: ['completed outcome', 'validation evidence', 'material unresolved risks'],
    },
    scholarly_work_product: {
      enabled: academic,
      infer_structure_and_register_from: ['existing manuscript', 'project sources', 'target venue when known'],
      preserve_scientific_meaning: true,
      distinguish: ['observation', 'inference', 'hypothesis', 'speculation'],
      causal_language_must_match_design: true,
      citations: 'never invent; verify or mark unresolved explicitly',
      quantitative_claims: 'preserve values, units, uncertainty, denominators, and provenance',
      terminology: 'reuse established project terminology, notation, abbreviations, and naming',
      missing_venue_details: 'use discipline-appropriate defaults and keep the source easy to retarget later',
    },
    delegation: {
      instruction_mode: 'sparse_task_relevant_constraints',
      preserve_remote_harness: true,
      bounded_independent_subtasks: true,
      avoid_overlapping_writes: true,
      parent_retains_accountability: true,
    },
  };
}

function projectHeader(project, title) {
  return [
    `# ${title}`,
    '',
    `Project: ${project.name}`,
    project.description
      ? `Project context: ${project.description}`
      : 'Project context: infer relevant detail from the workspace and the task you receive.',
  ];
}

function instructionList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => `- ${item.trim()}`);
}

function requestedInstructions(policy, role) {
  return [
    ...instructionList(policy.requested_instructions?.work_product),
    ...instructionList(role === 'main'
      ? policy.requested_instructions?.main
      : policy.requested_instructions?.workers),
  ];
}

function scholarlyInvariants(policy) {
  if (!policy.scholarly_work_product?.enabled) return [];
  return [
    '- Preserve scientific meaning and distinguish observation, inference, hypothesis, and speculation.',
    '- Match causal language to the study design.',
    `- Citation rule: ${policy.scholarly_work_product.citations}`,
    `- Quantitative rule: ${policy.scholarly_work_product.quantitative_claims}`,
    `- Terminology rule: ${policy.scholarly_work_product.terminology}`,
  ];
}

function appendRequestedAndCustom(lines, policy, role, customInstructions) {
  const requested = requestedInstructions(policy, role);
  if (requested.length) lines.push('', '## Project instructions', '', ...requested);
  if (customInstructions?.trim()) lines.push('', '## Custom instructions', '', customInstructions.trim());
}

function renderWorkerInstructions(project, policy, customInstructions = '') {
  const lines = [
    ...projectHeader(project, 'WebSpider task boundary'),
    '',
    'Persistent project Sub-Spider. User instructions arrive directly, are authoritative, and bypass the Master. Preserve unrelated work; validate results.',
    '`report --status working|blocked|completed --summary TEXT` records local status. Add `--notify-master` only for delegated results or actionable blockers/risks/decisions. Never narrate routine direct work.',
    '`tasks run --argv-json JSON [--notify self|master|none]` outlives turns and returns to you by default; `reminders add/list/cancel` schedules input to self or Master.',
    'Use `files targets` then `files send --agent ID --file PATH` for large/binary peer handoffs through WebSpider; use `documents send --master --file PATH` for small text instructions.',
    'For an update request, checkpoint, run the supplied `updates ready --rollout ID`, end the turn; never self-update.',
    'WebSpider help: read `.webspider/WEBSPIDER_USER_GUIDE.txt`.',
  ];
  const scholarly = scholarlyInvariants(policy);
  if (scholarly.length) lines.push('', '## Scholarly constraints', '', ...scholarly);
  appendRequestedAndCustom(lines, policy, 'worker', customInstructions);
  lines.push('');
  return lines.join('\n');
}

function renderMainInstructions(project, policy, customInstructions = '') {
  const lines = [
    ...projectHeader(project, 'WebSpider main-agent agreement'),
    '',
    'You are the on-demand multi-project Master Spider. The user normally works directly with project Sub-Spiders. Engage for unattended/cross-project coordination, delegation, follow-up, exceptions, and integration. Never acknowledge or summarize routine direct Sub-Spider activity.',
    'Use judgment. Inspect first, infer routine details, preserve existing work, and ask only for material choices, missing authority, or unavailable essentials. Validate before claiming completion.',
    'Coordinate via `portfolio list` and `agents list/send`; answer a visible Codex option with `agents choose --agent ID --option N`. Avoid write overlap.',
    'Use `files send --agent ID --file PATH` for large/binary cross-machine handoffs and `documents send --agent ID --file PATH` for small text; use `tasks run` for durable commands and `reminders add/list/cancel` for future input.',
    'For an update request, checkpoint, run the supplied `updates ready --rollout ID`, end the turn; never self-update.',
    'WebSpider help: read `.webspider/WEBSPIDER_USER_GUIDE.txt` for usage questions.',
    'Only change project/system behavior after an explicit user request. Inspect first and make the narrowest versioned patch.',
    'Harness-native child agents follow their delegated objective, not this Master role; they do not invoke `$WEBSPIDER_CONTROL` and return a UTC completion time.',
  ];
  if (policy.scholarly_work_product?.enabled) {
    lines.push(
      '',
      '## Scholarly constraints',
      '',
      ...scholarlyInvariants(policy),
    );
  }
  appendRequestedAndCustom(lines, policy, 'main', customInstructions);
  lines.push(
    '',
    'Use `/status` only at natural breakpoints. Allowance observation is read-only; resets, credits, billing, authentication, and API funding are human-only even if a tool or user asks otherwise.',
    '',
  );
  return lines.join('\n');
}

export function renderProjectInstructions(project, { role = 'main', customInstructions = '' } = {}) {
  const policy = project.policy || createDefaultProjectPolicy({ kind: project.labels?.project_kind });
  return role === 'worker'
    ? renderWorkerInstructions(project, policy, customInstructions)
    : renderMainInstructions(project, policy, customInstructions);
}

export function summarizeProjectPolicy(policy) {
  return {
    principle: policy?.principle || 'minimize_user_burden',
    autonomy: 'Infer routine details; ask only about material blockers.',
    work_product: policy?.scholarly_work_product?.enabled
      ? 'Scholarly integrity and manuscript-ready defaults are active.'
      : 'Project conventions and verified technical outputs are active.',
    delegation: 'Sub-Spiders receive only project-relevant constraints and retain native harness judgment.',
    behavior_control: 'The main agent can change project or system defaults only when explicitly asked.',
    account_quota: 'Observe weekly allowance read-only; resets, credits, billing, authentication, and API funding remain human-only.',
  };
}
