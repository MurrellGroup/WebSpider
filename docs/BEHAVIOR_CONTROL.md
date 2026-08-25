# Behavior control and agent autonomy

## Guiding boundary

WebSpider separates orchestration authority from worker execution behavior.

- The **main agent** may change project or system defaults, but only after an explicit user request.
- A **worker agent** is also a first-class direct user interface for its project. Direct user messages go to that worker without passing through the Master. Its automation credential is self-confined to status, detached work in its registered root, and hooks addressed only to itself or the Master; it never receives behavior-control or general orchestration authority.
- Remote agents keep their native harness defaults for planning, tools, execution, and reporting.
- WebSpider adds a remote-agent rule only when it protects an explicit user preference, a safety or authority boundary, a project-specific factual invariant, or a result-changing acceptance criterion.

This is intentionally asymmetric in authority, not importance. Direct project work with a Sub-Spider and managed portfolio work through the Master are both normal. The Master needs portfolio context and a coordination surface when engaged; a project agent needs its project boundary and the user's direct objective, not central orchestration doctrine.

## Role-aware instruction compilation

Every launch still receives an immutable instruction snapshot, but the snapshot is compiled for the agent's role.

| Main-agent snapshot | Worker snapshot |
| --- | --- |
| Low-burden project defaults | Project identity and task boundary |
| Scholarly work-product defaults | Only result-critical scholarly invariants |
| Delegation and integration accountability | Native harness explicitly preserved |
| Session-context and weekly-allowance awareness | No generic planning or tool rules |
| Explicit-request-only behavior control | Self-status, self-task, and self/master hook controls only |

Codex continues to discover the resulting instructions through its normal layered `AGENTS.md` mechanism. WebSpider composes inherited user guidance with the role-specific snapshot in a private managed `CODEX_HOME`; it does not modify the workspace or the user's original Codex home.

A Codex-native subagent spawned inside the main session may see the parent's global instruction layer and inherits the parent runtime permission mode. The main snapshot therefore starts with a role-scope boundary: a native child discards the main-only orchestration, reporting, and control sections, keeps its own harness behavior, and follows the delegated objective plus result-critical constraints. The only transport-level addition is a UTC completion timestamp in its returned result. WebSpider does not replace Codex's tuned built-in worker or explorer definitions.

## Layered defaults

Effective project behavior is resolved in this order:

1. built-in safe defaults;
2. system-level overrides;
3. project-level overrides.

A compact per-agent custom instruction is appended after those layers. The owner edits it on that agent's **Instructions** tab. Saving increments an agent-specific revision; **Save & restart** creates a new immutable snapshot immediately, while ordinary **Save** leaves the running snapshot unchanged until its next restart.

System edits therefore affect every project that has not deliberately overridden the same field. Both layers have independent monotonic revisions. An update must name the revision it inspected; a concurrent change produces `WS_POLICY_REVISION_CONFLICT` instead of silently overwriting newer intent.

Durable natural-language behavior is stored in three explicit channels:

- `requested_instructions.main` for central orchestration behavior;
- `requested_instructions.work_product` for technical or manuscript outputs regardless of producer;
- `requested_instructions.workers` for the exceptional case where the user explicitly wants a remote-agent constraint.

The portal's **Sub-spider instructions** page edits the system-level `workers` channel once for every registered worker while leaving the Master unchanged. Save applies it on each worker's next launch; **Save & restart workers** immediately refreshes currently running workers. Per-agent **Instructions** tabs remain the narrower override for one specific spider.

The first two make a central writing guide or project convention directly editable. The worker channel is empty by default and should remain so unless the rule passes the remote-harness threshold.

Running agents retain their immutable launch snapshot. The portal marks it stale when the system, project, or per-agent instruction revision advances.

## Main-agent control workflow

At launch, the main terminal receives a short-lived, revocable bearer token and the path to a dependency-free helper. A Codex process started inside that shell inherits both. The token is accepted only by allowlisted portfolio, policy, usage-observation, agent-inventory, and cross-agent message endpoints and is rejected by ordinary WebSpider APIs.

Review the complete research portfolio before coordinating work:

```bash
$WEBSPIDER_CONTROL portfolio list
```

Discover and message another WebSpider-managed agent:

```bash
$WEBSPIDER_CONTROL agents list
$WEBSPIDER_CONTROL agents send --agent AGENT_ID --message 'Check the benchmark and report the result.'
```

For a long instruction, runbook, or result that must arrive byte-for-byte, send a document instead of pasting it into a terminal:

```bash
$WEBSPIDER_CONTROL documents send --agent AGENT_ID --file validation-plan.md \
  --instruction 'Read the inbox copy and execute the authorized validation.'
```

The helper uploads at most 512 KiB of UTF-8 `.txt`, `.md`, or `.markdown` content with its SHA-256 digest. The durable message retains the bytes while a node is offline. At delivery, the node atomically writes a mode-`0600` copy under `.webspider/inbox/<document-id>-<filename>` inside the target's registered root, verifies its checksum and confinement, and then injects a short user-role handoff containing the ID, digest, path, and instruction. A retry is idempotent. Workers can use `documents send --master`; they cannot send a document to a peer.

For a large or binary file already inside the sending agent's workspace, use the live file relay:

```bash
$WEBSPIDER_CONTROL files targets
$WEBSPIDER_CONTROL files send --agent AGENT_ID --file results/dataset.bin \
  --instruction 'Use this dataset for the next benchmark.'
```

This does not require SSH or shared storage. The scoped helper sends only a path relative to its registered workspace. With both nodes online, the Hub streams at most 8 MiB at a time from the source root into a mode-`0600` temporary file under the destination's `.webspider/inbox/`, verifies each chunk and the complete SHA-256 digest, then atomically publishes the file and delivers its exact path. Chunk payloads bypass the durable Hub outbox and Node command-receipt databases. `files targets` exposes only destination IDs/titles and online state to a worker; it does not expose the portfolio or grant task/message authority. Use `--transfer-id ID` to resume the same confirmed partial transfer after an interruption.

Detached commands can be launched immediately or after a bounded delay. They are durable across hub disconnects and are started when an offline target reconnects:

```bash
$WEBSPIDER_CONTROL tasks list
$WEBSPIDER_CONTROL tasks run --agent AGENT_ID --title 'Delayed validation' --delay-seconds 30 \
  --notify master --completion-message 'Review this validation' --argv-json '["npm","test"]'
```

The completion hook is stored with the task. After the detached process exits, WebSpider delivers a new user-role message containing the task ID, status, execution agent, optional hook text, and result. `--notify self` returns it to the agent on which the task ran, `--notify master` sends it to the Master, and `--notify none` records the result without starting another agent turn. A worker may omit `--agent`, in which case its own identity is used; the hub rejects any worker attempt to select a different agent.

If `--notify` is omitted, work scheduled directly by a Sub-Spider returns to that Sub-Spider; work scheduled by the Master returns to the Master. Thus direct project work stays local without weakening managed delegation.

Durable messages to the current agent's future self—or, for a worker, to the Master—use the same persisted task store:

```bash
$WEBSPIDER_CONTROL reminders add --message 'Review all blocked projects' --every-seconds 1200 --target self
$WEBSPIDER_CONTROL reminders list
$WEBSPIDER_CONTROL reminders cancel --reminder REMINDER_ID
```

`--delay-seconds` creates or delays the first delivery. `--every-seconds` repeats and fires first after that interval when no separate delay is supplied. `--max-runs` bounds a recurring hook. Each firing is a durable, idempotent user-role message with the reminder ID and run number; schedules are restored after a hub restart, and queued delivery survives an offline destination.

Use `--file PATH` instead of `--message` for a longer prompt. The hub records the main agent as the actual actor, delivers the target message in the user role, and queues or wakes the target through the normal durable delivery path.

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

The token is revoked when the agent stops, fails, exits, loses main-agent status, or wakes into a replacement session. Each independent worker receives a separate helper token restricted by both scope and route invariants: it may report its own state, list/run its own detached tasks, list/create/cancel its own hooks, and make a root-confined live file handoff to an explicit Spider destination. It cannot run commands on another agent, choose an arbitrary hook destination, inspect the portfolio, message peers, or edit policy. It may record meaningful transitions without interrupting the Master:

```bash
$WEBSPIDER_CONTROL report --status working --summary 'Running the preregistered benchmark.'
$WEBSPIDER_CONTROL report --status blocked --summary 'GPU allocation is unavailable; CPU fallback changes the deadline.'
$WEBSPIDER_CONTROL report --status completed --file result-summary.txt
```

The hub derives the worker identity from the token, persists the report, and updates the portfolio. Reporting does not message the Master by default. The worker adds `--notify-master` only when the Master delegated the result, requested that milestone, or must act on a blocker, material risk, or decision. Routine user-directed work stays local. A harness-native subagent is a thread inside the main runtime rather than an independently authenticated WebSpider principal; it can inherit the parent process environment, so the role-scope instruction explicitly forbids using the helper from a child thread. PTY fallback cannot cryptographically distinguish those internal threads.

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
- `GET` and `POST /api/v1/agent-control/tasks` with `tasks:read` / `tasks:write`; worker requests are filtered and forced to the authenticated worker.
- `GET` and `POST /api/v1/agent-control/reminders`, plus `POST /api/v1/agent-control/reminders/{id}:cancel`, with self-reminder scopes; ownership comes from the authenticated token and destinations are only `self` or `master`.
- `POST /api/v1/agent-control/agents/{id}/documents` with `documents:write`; main agents may target registered agents, while worker targets are forced to the Master role.
- `GET /api/v1/agent-control/files/targets` and `POST /api/v1/agent-control/agents/{id}/files` with `files:transfer`; destination discovery is bounded and the source is forced to the authenticated agent's registered root.

The patch body requires:

```json
{
  "scope": "project",
  "patch": {},
  "reason": "User explicitly requested ...",
  "expected_revision": 3
}
```

Owner-authenticated agent, project, and system policy endpoints remain available. Per-agent custom text is normally edited in the browser; broader defaults can still be changed by explicitly asking the Master or using the administrative API.
