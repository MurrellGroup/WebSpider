# Behavior control and agent autonomy

## Guiding boundary

WebSpider separates orchestration authority from worker execution behavior.

- The **main agent** may change project or system defaults, but only after an explicit user request.
- A **worker agent** receives no behavior-control credential.
- Remote agents keep their native harness defaults for planning, tools, execution, and reporting.
- WebSpider adds a remote-agent rule only when it protects an explicit user preference, a safety or authority boundary, a project-specific factual invariant, or a result-changing acceptance criterion.

This is intentionally asymmetric. The main agent needs durable project context and a small control surface; a remote specialist normally needs an objective, material context, constraints, and success criteria—not a second harness written by the orchestrator.

## Role-aware instruction compilation

Every launch still receives an immutable instruction snapshot, but the snapshot is compiled for the agent's role.

| Main-agent snapshot | Worker snapshot |
| --- | --- |
| Low-burden project defaults | Project identity and task boundary |
| Scholarly work-product defaults | Only result-critical scholarly invariants |
| Delegation and integration accountability | Native harness explicitly preserved |
| Session-context and weekly-allowance awareness | No generic planning or tool rules |
| Explicit-request-only behavior control | No control instructions or credential |

Codex continues to discover the resulting instructions through its normal layered `AGENTS.md` mechanism. WebSpider composes inherited user guidance with the role-specific snapshot in a private managed `CODEX_HOME`; it does not modify the workspace or the user's original Codex home.

A Codex-native subagent spawned inside the main session may see the parent's global instruction layer and inherits the parent runtime permission mode. The main snapshot therefore starts with a role-scope boundary: a native child discards the main-only orchestration, reporting, and control sections, keeps its own harness behavior, and follows the delegated objective plus result-critical constraints. The only transport-level addition is a UTC completion timestamp in its returned result. WebSpider does not replace Codex's tuned built-in worker or explorer definitions.

## Layered defaults

Effective project behavior is resolved in this order:

1. built-in safe defaults;
2. system-level overrides;
3. project-level overrides.

System edits therefore affect every project that has not deliberately overridden the same field. Both layers have independent monotonic revisions. An update must name the revision it inspected; a concurrent change produces `WS_POLICY_REVISION_CONFLICT` instead of silently overwriting newer intent.

Durable natural-language behavior is stored in three explicit channels:

- `requested_instructions.main` for central orchestration behavior;
- `requested_instructions.work_product` for technical or manuscript outputs regardless of producer;
- `requested_instructions.workers` for the exceptional case where the user explicitly wants a remote-agent constraint.

The first two make a central writing guide or project convention directly editable. The worker channel is empty by default and should remain so unless the rule passes the remote-harness threshold.

Running agents retain their immutable launch snapshot. The portal marks a snapshot stale when either the system or project revision advances, and the control response reports that a restart is required.

## Main-agent control workflow

At launch, a main agent receives a short-lived, revocable bearer token and the path to a dependency-free helper. The token is accepted only by allowlisted policy and usage-observation endpoints and is rejected by ordinary WebSpider APIs.

Inspect current values:

```bash
$WEBSPIDER_CONTROL policy show
```

Patch the current project after the user asks:

```bash
$WEBSPIDER_CONTROL policy patch \
  --scope project \
  --json '{"scholarly_work_product":{"citations":"verify against primary sources"}}' \
  --reason 'User explicitly requested stricter citation defaults'
```

Use `--scope system` only when the user's request clearly applies across projects. The helper fetches the current revision and sends it with the patch. Every accepted edit records the actual agent actor, scope, prior and new revision, and supplied user-request reason in the audit log.

The token is revoked when the agent stops, fails, exits, loses main-agent status, or wakes into a replacement session. Independent WebSpider worker instances never receive one. A harness-native subagent is a thread inside the main runtime rather than an independently authenticated WebSpider principal; it can inherit the parent process environment, so the role-scope instruction explicitly forbids using the helper from a child thread. PTY fallback cannot cryptographically distinguish those internal threads.

## Context, account allowance, and time awareness

WebSpider keeps three related values separate:

| Signal | Read source | Meaning |
| --- | --- | --- |
| Session context | `/status` | Context consumed by the current session; relevant to compaction and handoff |
| Account allowance | `/status` | Remaining provider rate-limit percentage, including the weekly window when reported |
| Token activity | `/usage weekly` | Optional weekly account activity; it does not determine the remaining percentage |

The main agent checks at natural breakpoints: when a session begins without a fresh observation, before a materially costly delegation or long run, or when the last account observation is over two hours old. It never estimates between observations. A subagent may return an explicit `/status` or `/usage weekly` observation when useful; the main agent owns the durable snapshot and avoids polling that displaces useful work.

After reading the provider output, the main agent can record it without managing the account:

```bash
$WEBSPIDER_CONTROL usage show
$WEBSPIDER_CONTROL usage report --weekly-remaining 60 \
  --resets-at 2026-08-28T10:00:00Z \
  --weekly-tokens 987654 \
  --source codex-status
```

The helper has no reset, purchase, credit, billing, authentication, entitlement, or API-funding operation. The hub rejects every unrecognized control scope, and no account-mutation route exists. An agent must never redeem or consume a token refresh or rate-limit reset, purchase/add/switch credits, change billing/plan/authentication, switch to API-funded usage, or send/confirm an entitlement request. This remains a human-only action even when a user asks the agent to do it; the agent may explain the option but must leave the action to the user.

Every delivered inbound message is wrapped with WebSpider-generated metadata:

- message and delivery timestamps in UTC;
- authenticated/display source;
- elapsed time since the preceding inbound message in that thread.

The envelope applies equally to direct user messages, delegated-agent messages, and task-completion triggers. Stored message content remains unchanged; the metadata is added only at delivery so transcript rendering and idempotency semantics remain stable.

## API contract

Main-agent tokens can access only:

- `GET /api/v1/agent-control/policy` with `policy:read`;
- `PATCH /api/v1/agent-control/policy` with the matching `policy:write:project` or `policy:write:system` scope;
- `GET /api/v1/agent-control/usage` with `usage:read`;
- `POST /api/v1/agent-control/usage` with `usage:write`, which stores an observation only.

The patch body requires:

```json
{
  "scope": "project",
  "patch": {},
  "reason": "User explicitly requested ...",
  "expected_revision": 3
}
```

Owner-authenticated system and project policy endpoints remain available for administration, but the normal product path is simply to tell the main agent what behavior should change.
