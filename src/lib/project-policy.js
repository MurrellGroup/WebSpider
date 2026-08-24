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

function renderWorkerInstructions(project, policy) {
  const lines = [
    ...projectHeader(project, 'WebSpider task boundary'),
    '',
    'Use your native harness defaults for planning, tool choice, execution, and reporting. The main agent supplies the objective, material constraints, and acceptance criteria; do not infer additional workflow rules.',
  ];
  const scholarly = scholarlyInvariants(policy);
  if (scholarly.length) {
    lines.push('', '## Result-critical scholarly constraints', '', ...scholarly);
  }
  const requested = requestedInstructions(policy, 'worker');
  if (requested.length) {
    lines.push('', '## User-requested durable defaults', '', ...requested);
  }
  lines.push('', 'Preserve existing work outside the task boundary and validate the requested result.', '');
  return lines.join('\n');
}

function renderMainInstructions(project, policy) {
  const lines = [
    ...projectHeader(project, 'WebSpider main-agent agreement'),
    '',
    '## Role scope',
    '',
    'This agreement governs the top-level WebSpider main agent. If you are a harness-native subagent that inherited this file, do not adopt the main-only orchestration, behavior-control, or reporting sections below. Use your native harness behavior and follow only the delegated objective, its material constraints and acceptance criteria, and any result-critical project invariants included in your task. Do not invoke `$WEBSPIDER_CONTROL` from a child thread. Include a UTC completion timestamp in the result you return to the main thread.',
    '',
    '## Reduce user burden',
    '',
    'The user steers outcomes; you own routine implementation detail. Inspect the project and proceed with the best safe, reversible interpretation instead of requesting an exhaustive specification.',
    'Ask only when a choice materially changes the result, an action is irreversible or needs new authority, or an essential input is unavailable. Consolidate necessary questions and lead with a recommendation.',
    '',
    '## Execution defaults',
    '',
    '- Preserve existing work and avoid unrelated changes.',
    '- Follow conventions already established in the project.',
    '- Validate the result before claiming completion.',
    '- Return the completed outcome, validation evidence, and only material unresolved risks.',
  ];
  if (policy.scholarly_work_product?.enabled) {
    lines.push(
      '',
      '## Scholarly work products',
      '',
      '- Produce manuscript- or publication-ready work when that is the requested outcome, not merely advice about how the user could produce it.',
      ...scholarlyInvariants(policy),
      '- If venue details are absent, use discipline-appropriate defaults and keep the source easy to retarget.',
    );
  }
  const requested = requestedInstructions(policy, 'main');
  if (requested.length) {
    lines.push('', '## User-requested durable defaults', '', ...requested);
  }
  lines.push(
    '',
    '## Remote-agent autonomy',
    '',
    'Remote agents are already tuned to their harnesses. Delegate the objective, material context, real constraints, and success criteria—do not prescribe their planning process, tool choices, conversational style, or generic workflow.',
    'A rule must earn its place: add one only for an explicit user preference, a safety or authority boundary, a project-specific factual invariant, or an acceptance criterion that materially changes the result. Otherwise omit it and let the remote harness work.',
    'Keep delegated work bounded and avoid overlapping writes. You remain accountable for integration and final verification.',
    '',
    '## Session context awareness',
    '',
    'Stay aware of this session\'s context window without interruptive polling. Use `/status` at natural breakpoints when context pressure could affect scope, delegation, compaction, or handoff. A subagent may return its own `/status` observation when useful, but do not turn usage checks into routine chatter.',
    '',
    '## Weekly account allowance',
    '',
    'Keep account allowance distinct from the current session context. `/status` is the source for the account rate-limit windows and their remaining allowance, including the weekly percentage when the harness reports it. `/usage weekly` may be used only as optional supporting token-activity information; raw token counts are not a substitute for the remaining weekly percentage.',
    'At a natural breakpoint, check `/status` when there is no fresh allowance snapshot, before a materially costly delegation or long run, or when the last observation is more than two hours old. Never estimate the percentage between observations. After observing it, store the read-only snapshot with `$WEBSPIDER_CONTROL usage report --weekly-remaining PERCENT` and add `--resets-at ISO` or `--weekly-tokens COUNT` only when those values were actually shown.',
    'Account management is a hard human-only boundary. You may observe and report allowance, but you must NEVER redeem or consume a token refresh or rate-limit reset; purchase, add, or switch to credits; change billing, subscription, authentication, or funding mode; switch work to API-funded usage; or send/confirm a reset, credit, or entitlement request. This remains forbidden even if a tool exposes it or the user asks you to do it: explain that the user must perform the account action personally. Do not use bare `/usage`; use the explicit read-only `/usage weekly` form when activity data is useful.',
    'WebSpider inbound envelopes include message time, delivery time, source, and elapsed time since the prior inbound message. Use that context to re-check stale assumptions after a meaningful gap.',
    '',
    '## Behavior and default changes',
    '',
    'You may edit WebSpider project or system defaults only after the user explicitly asks you to change behavior or defaults. Never make such changes proactively, infer consent from an ordinary task, or delegate the change to a worker.',
    'Use the scoped `$WEBSPIDER_CONTROL` helper. Inspect current values first, make the narrowest patch that satisfies the request, include the user-request reason, and report the changed scope and restart impact. Store durable natural-language defaults under `requested_instructions.main`, `requested_instructions.work_product`, or—only when the user explicitly wants remote behavior constrained—`requested_instructions.workers`.',
    '',
    'Examples:',
    '',
    '- `$WEBSPIDER_CONTROL policy show`',
    '- `$WEBSPIDER_CONTROL policy patch --scope project --json \'{"scholarly_work_product":{"citations":"verify against primary sources"}}\' --reason \'User explicitly requested stricter citation defaults\'`',
    '- `$WEBSPIDER_CONTROL usage show`',
    '- `$WEBSPIDER_CONTROL usage report --weekly-remaining 60 --source codex-status`',
    '',
  );
  return lines.join('\n');
}

export function renderProjectInstructions(project, { role = 'main' } = {}) {
  const policy = project.policy || createDefaultProjectPolicy({ kind: project.labels?.project_kind });
  return role === 'worker' ? renderWorkerInstructions(project, policy) : renderMainInstructions(project, policy);
}

export function summarizeProjectPolicy(policy) {
  return {
    principle: policy?.principle || 'minimize_user_burden',
    autonomy: 'Infer routine details; ask only about material blockers.',
    work_product: policy?.scholarly_work_product?.enabled
      ? 'Scholarly integrity and manuscript-ready defaults are active.'
      : 'Project conventions and verified technical outputs are active.',
    delegation: 'Give remote agents only task-relevant constraints; preserve their native harness defaults.',
    behavior_control: 'The main agent can change project or system defaults only when explicitly asked.',
    account_quota: 'Observe weekly allowance read-only; resets, credits, billing, authentication, and API funding remain human-only.',
  };
}
