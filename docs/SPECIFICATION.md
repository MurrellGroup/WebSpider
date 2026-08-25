# WebSpider
## Distributed Persistent LLM-Agent Orchestrator — Full Product and Implementation Specification

**Document status:** Proposed implementation specification
**Revision:** 1.0
**Date:** 2026-08-24
**Primary target:** Private/tailnet deployment, single-user or small trusted team
**Implementation philosophy:** One easy-to-install control-plane binary, many lightweight worker nodes, durable state, browser-native interaction, protocol adapters for heterogeneous agents.

---

## 0. Executive summary

WebSpider is a distributed orchestration system for running many persistent LLM agents and long-running tasks across multiple computers while controlling them from one browser-based portal.

The user experience should feel like a cross between:

- `screen`/`tmux`: processes and sessions persist when the UI disconnects;
- an agent control plane: agents, tasks, conversations, approvals, and artifacts are first-class durable objects;
- a browser IDE/operations console: the user can inspect every running agent, watch its conversation or terminal live, inject a message when needed, inspect its project files, and download outputs;
- a distributed message bus: agents on different computers can send durable messages and tasks to one another;
- a personal "master spider": one privileged central agent can supervise all projects and sub-agents without the user manually hopping between machines.

WebSpider deliberately supports two equal interaction modes. In direct project mode, the user opens a persistent Sub-Spider and works with it without routing conversation through the Master. In managed portfolio mode, the user engages the Master for unattended oversight, delegation, follow-up, cross-project coordination, exceptions, and integrated results. Routine direct Sub-Spider status must not consume Master context.

The key architectural decision is that **the orchestration state must not live in the terminal or in the master LLM's context**. WebSpider itself is the source of truth. Terminals, ACP sessions, model conversations, tasks, files, and browser connections are views or execution mechanisms attached to durable WebSpider objects.

The recommended v1 implementation is:

- one Go executable named `webspider`;
- one central **Hub** process;
- one outbound-connected **Node** daemon per worker computer;
- SQLite on the hub and on each node;
- a React/TypeScript single-page application embedded in the Go binary;
- xterm.js for terminal rendering;
- Tailscale Serve or `tsnet` for private network exposure;
- ACP as the preferred local coding-agent adapter;
- a native WebSpider agent protocol/SDK for agents that can integrate directly;
- PTY + dedicated `tmux` sessions as the robust compatibility fallback;
- MCP tools exposed by the hub so the master agent can operate WebSpider;
- optional A2A gateways for independently hosted remote agents;
- durable messages, durable tasks, event-triggered wake-up, approvals, artifacts, audit logs, and per-agent project-root file browsing.

A user should be able to open WebSpider from a laptop, phone, or another browser simultaneously, resume the last active agent or click any project, task, Master, or Sub-Spider and immediately:

1. see what the agent is doing;
2. watch the structured agent interaction and/or raw terminal;
3. inject a new message, queue a follow-up, interrupt, or wake the agent, subject to policy;
4. inspect the filesystem **only inside that agent's authorized project/workspace roots**;
5. preview and download outputs;
6. inspect tasks, tool calls, approvals, logs, and artifacts;
7. navigate back to the master agent without disturbing execution.

No browser disconnection should stop work. No user should need to SSH into worker machines for routine operation.

---

# 1. Goals

## 1.1 Primary goals

WebSpider MUST provide all of the following:

1. **Persistent execution**
   - Agents and long-running commands continue when browsers disconnect.
   - Closing a laptop, changing networks, or opening the portal on a phone does not terminate work.
   - A node-daemon restart should not terminate managed `tmux` sessions.
   - Supported structured-agent sessions should be resumable after process restart where the underlying agent protocol permits it.

2. **One portal for many machines**
   - A central browser UI lists projects, nodes, agents, tasks, messages, approvals, and artifacts across all worker computers.
   - The browser talks only to the hub, not directly to arbitrary worker ports.

3. **A master-spider agent**
   - A privileged but policy-constrained master agent can query and manage all authorized projects through WebSpider tools.
   - It can spawn agents, delegate tasks, send messages, wait on work, retrieve results, and react to completion events.
   - It does not receive raw database credentials or node credentials.

4. **First-class direct project agents**
   - Every Sub-Spider is a normal user-facing project interface, not only a Master-controlled executor.
   - Direct user messages reach the selected Sub-Spider without passing through or notifying the Master.
   - Durable primary-agent messaging, terminal control, files, attachments, tasks, and recovery work for Sub-Spiders as well as the Master.

5. **Cross-machine agent communication**
   - An agent on machine A can message or delegate a task to an agent on machine B through durable WebSpider mailboxes and tasks.
   - Messages persist while nodes are offline and are delivered after reconnect according to policy.

6. **Message injection and wake-up**
   - Human users, agents, triggers, and external jobs can inject messages into an agent's logical conversation.
   - Such messages can wake a hibernated/stopped agent, queue behind a busy turn, or explicitly interrupt if allowed.
   - The audit log always records the real actor even if the target model sees the message in a user-message role.

7. **Deep click-through observability**
   - From the master portal, the user can click into every individual agent/session.
   - They can watch structured messages, tool activity, plans, task state, and terminal output in real time.
   - They can inject messages into the selected session.

8. **Project-root filesystem inspection**
   - Each agent/session exposes a browser file explorer for its authorized workspace/project roots.
   - The user can list directories, preview safe file types, inspect metadata, search within the root, and download files.
   - There MUST NOT be an API that lets the browser specify an arbitrary host absolute path.
   - Path traversal, symlink escape, magic-link escape, and related attacks must be prevented server-side.
   - Files outside authorized roots must remain inaccessible even if a malicious browser modifies requests.

9. **Multi-device access**
   - Multiple browsers can watch the same agent/session simultaneously.
   - Structured chat/task state is shared immediately.
   - Multiple terminals can be attached read-only; terminal input is controlled by a lease to avoid conflicting keystrokes/resizes.

10. **Simple installation**
   - The hub and node roles are subcommands of one binary.
   - A first machine should be able to start WebSpider with one command.
   - Joining another machine should require only a hub URL and one-time enrollment token or an equivalent secure join flow.

11. **Reasonable security behind a VPN/tailnet**
    - WebSpider does not need to be engineered as hostile-internet multi-tenant SaaS in v1.
    - Nevertheless, it must authenticate users and nodes, authorize actions, restrict file roots, defend WebSockets, protect secrets, and maintain audit history.

## 1.2 Secondary goals

- Git-aware project workspaces and task worktrees.
- Durable artifacts with hashes and metadata.
- Mobile-friendly attention/approval handling.
- Protocol-neutral support for many agent products.
- Good CLI support for automation and troubleshooting.
- Event-driven automation without requiring a large external workflow platform.
- Optional interoperability via A2A and AG-UI style event projections.
- Clear upgrade path from one hub/SQLite to clustered deployment/PostgreSQL/NATS if ever needed.

---

# 2. Non-goals for v1

WebSpider v1 is not intended to be:

- Kubernetes;
- a general distributed filesystem;
- a Dropbox replacement;
- a public multi-tenant agent SaaS;
- a model provider or centralized API-billing proxy;
- an exact-once distributed execution system;
- a replacement for Git;
- a full workflow platform on the scale of Temporal;
- a semantic parser for every arbitrary terminal UI;
- a guarantee that a powered-off computer can be remotely awakened;
- a guarantee that a third-party CLI agent can resume after an OS reboot if that CLI provides no resumable session mechanism;
- a security boundary against a root-compromised worker machine.

"Wake agent" means start or resume the agent process and deliver queued work. If the whole computer is asleep or powered off, WebSpider queues the message until the node reconnects. Wake-on-LAN may be added later as an optional node-power plugin.

---

# 3. Research findings and technology choices

This specification deliberately reuses established protocols where they map cleanly to one boundary, but does not try to force one protocol to solve every part of the architecture.

## 3.1 Agent Client Protocol (ACP): preferred local coding-agent adapter

ACP v1 provides the lifecycle WebSpider needs between a local client/controller and a coding agent: initialization, authentication, new/load session, prompt turns, streamed session updates, cancellation, permissions, filesystem methods, and terminal methods. The official ACP overview describes `session/new`, `session/load`, `session/prompt`, `session/update`, `session/cancel`, permission requests, filesystem calls, and terminal operations.

Use ACP **inside a node** to control compatible local agents. Do not use ACP as WebSpider's distributed hub-to-node protocol.

Reference:
- https://agentclientprotocol.com/protocol/v1/overview
- https://agentclientprotocol.com/get-started/agents

The ACP ecosystem currently lists adapters/implementations for many useful agents, including Codex CLI, Claude Agent, Gemini CLI, Cursor, Cline, OpenCode, OpenHands, Goose, and others. WebSpider should therefore prioritize a high-quality ACP adapter before writing provider-specific terminal scraping logic for every product.

## 3.2 A2A: remote independently hosted agent interoperability

A2A defines Agent Cards, messages, tasks, artifacts, streaming updates, and asynchronous push notifications. It is suitable when WebSpider needs to consume or expose an agent as an independently hosted service.

Use A2A at federation boundaries, not as WebSpider's internal event log or node transport.

References:
- https://a2a-protocol.org/latest/specification/
- https://a2a-protocol.org/latest/topics/key-concepts/
- https://a2a-protocol.org/latest/topics/agent-discovery/

## 3.3 MCP: master-spider and agent tool interface

The 2026-07-28 MCP release uses a stateless protocol core and removes protocol-level sessions from the modern wire lifecycle. That makes MCP an excellent way to expose WebSpider operations as tools but a poor place to put WebSpider's durable mailbox/session semantics.

WebSpider should expose tools such as `tasks.create`, `messages.send`, `agents.spawn`, and `artifacts.read` over MCP. Persistent WebSpider state remains in the WebSpider hub database and event model.

Reference:
- https://blog.modelcontextprotocol.io/posts/2026-07-28/

## 3.4 xterm.js: browser terminal renderer

xterm.js is the appropriate terminal renderer. Its security documentation explicitly advises treating terminal data as untrusted and adding application-level authentication/authorization around WebSockets. Its flow-control documentation also explains why fast producers need explicit backpressure across WebSockets.

References:
- https://xtermjs.org/docs/guides/security/
- https://xtermjs.org/docs/guides/flowcontrol/

## 3.5 Tailscale: default private networking

Tailscale Serve can expose a localhost web service to a tailnet over HTTPS and can forward user identity headers. Tailscale also exposes application capabilities and has `tsnet` for embedding a tailnet node directly into a Go application. `tsidp` provides an OIDC/OAuth bridge but is described as experimental, so it should remain optional.

References:
- https://tailscale.com/docs/features/tailscale-serve
- https://tailscale.com/docs/concepts/tailscale-identity
- https://tailscale.com/docs/features/access-control/grants/grants-app-capabilities
- https://tailscale.com/docs/features/tsidp

## 3.6 Traversal-resistant file APIs

Go 1.24 introduced `os.Root`/`os.OpenRoot` for traversal-resistant filesystem operations within a directory tree. On Linux, `openat2(2)` additionally provides controls such as `RESOLVE_BENEATH`, `RESOLVE_IN_ROOT`, `RESOLVE_NO_MAGICLINKS`, `RESOLVE_NO_SYMLINKS`, and `RESOLVE_NO_XDEV`.

WebSpider's file-browser implementation should be capability-rooted using these primitives rather than concatenating a trusted base directory with a user-supplied path.

References:
- https://go.dev/blog/osroot
- https://pkg.go.dev/os#Root
- https://www.man7.org/linux/man-pages/man2/openat2.2.html

---

# 4. Architectural invariants

These are requirements, not suggestions.

## 4.1 Hub is source of truth

The hub owns authoritative state for:

- projects;
- nodes;
- agent profiles and instances;
- logical threads;
- tasks and task attempts;
- durable messages;
- trigger rules;
- permissions/approvals;
- artifact metadata;
- browser/user authorization;
- audit history.

The master agent is a privileged client of this state, not the database owner.

## 4.2 Threads, runtime sessions, terminals, and tasks are distinct

A single agent may simultaneously have:

- one WebSpider logical thread;
- an ACP/vendor runtime session ID;
- one or more terminal sessions;
- one currently running task;
- queued messages;
- workspace roots;
- artifacts.

Destroying any one of these does not automatically destroy the others.

## 4.3 Nodes initiate network connections

Worker nodes establish outbound authenticated connections to the hub.

Benefits:

- no inbound worker ports;
- NAT/firewall simplicity;
- easier laptop/mobile-worker operation;
- one place to enforce browser access policy;
- worker IP changes do not invalidate identity.

## 4.4 Browsers connect only to the hub

The browser never receives node credentials and does not construct worker-machine URLs for privileged operations.

For terminals and files:

```text
Browser <-> Hub <-> Node <-> local process/filesystem
```

The hub authorizes each operation and the node independently validates the scoped command.

## 4.5 Durable control; ephemeral high-volume streams

Durable:

- messages;
- task transitions;
- commands;
- approvals;
- event records;
- completion results;
- artifact metadata.

Ephemeral/resynchronizable:

- terminal byte streams;
- high-frequency progress telemetry;
- transient resource metrics.

Terminal output may be dropped for a slow viewer as long as the viewer can resynchronize. A task-completion event may not be dropped.

## 4.6 At-least-once semantics plus idempotency

WebSpider must not claim exactly-once delivery or execution.

Every durable mutation carries an immutable ID/idempotency key. Receivers persist deduplication state. Retries are expected.

## 4.7 Terminal injection is a compatibility fallback

Preferred delivery order:

1. native WebSpider agent protocol;
2. ACP;
3. A2A for remote hosted agents;
4. provider-specific structured API;
5. PTY/terminal injection.

The UI must label terminal-fallback readiness and delivery quality as best-effort when semantic acknowledgement is unavailable.

## 4.8 Tailnet identity does not replace WebSpider authorization

A machine being allowed to reach the hub at the network layer does not imply permission to control every agent or read every project's files.

## 4.9 Project files are capability rooted

No WebSpider browser-facing or agent-facing file API accepts arbitrary host absolute paths.

A file request is always expressed as:

```text
(root_id, relative_path, operation)
```

The root ID maps server-side to a pre-authorized project/workspace directory on exactly one node.

## 4.10 Raw node paths should normally not leave the node

The browser should see friendly logical paths such as:

```text
workspace://backend-agent/src/main.go
```

rather than:

```text
/home/alice/projects/foo/.webspider/worktrees/task-19/src/main.go
```

Absolute paths may be visible to an owner in diagnostics, but they should not be required for routine API calls.

---

# 5. High-level architecture

```text
                                      +--------------------------------------+
 Laptop browser --------------------->|                                      |
 Phone browser ---------------------->|             WebSpider Hub            |
 Tablet browser --------------------->|                                      |
                                      | Auth / Portal / REST / WebSockets    |
 Master agent ----------- MCP ------->| Registry / Scheduler / Mailboxes     |
 External agent --------- A2A ------->| Tasks / Events / Triggers / Policy   |
 External automation ---- HTTPS ----->| Terminal broker / File broker        |
                                      | Artifacts / Audit / Reconciler       |
                                      +------------------+-------------------+
                                                         |
                               outbound authenticated multiplexed connections
                                                         |
                     +------------------+-----------------+------------------+
                     |                  |                                    |
              +------v-------+   +------v-------+                     +------v-------+
              | Node A       |   | Node B       |                     | Node C       |
              | workstation  |   | GPU server   |                     | laptop       |
              |              |   |              |                     |              |
              | ACP adapters |   | Native agents|                     | ACP adapters |
              | PTY/tmux     |   | task wrapper |                     | PTY/tmux     |
              | file roots   |   | file roots   |                     | file roots   |
              | local spool  |   | local spool  |                     | local spool  |
              +--------------+   +--------------+                     +--------------+
```

---

# 6. Components

## 6.1 Hub

The initial hub should be a **modular monolith**. One process is easier to install, back up, reason about, and secure than a collection of microservices.

Modules:

| Module | Responsibilities |
|---|---|
| API gateway | REST, browser WebSockets, MCP, A2A, authentication |
| Identity service | human sessions, service identities, node enrollment |
| Registry | projects, bindings, nodes, agent profiles, instances, capabilities |
| Scheduler | task placement, resource matching, concurrency, locality |
| Mailbox | immutable messages, recipients, delivery state, deduplication |
| Event store | append-only event history, replay, browser cursors |
| Trigger engine | event -> message/task/webhook/wake actions |
| Policy engine | RBAC, capabilities, project scope, impersonation policy |
| Terminal broker | attachment authorization, leases, stream routing |
| File broker | root-scoped list/stat/read/search/download requests |
| Artifact service | metadata, hashing, retention, streaming/download |
| Permission service | agent approval/elicitation requests |
| Audit service | actual actor, requested action, decision, effect |
| Reconciler | desired state vs node-reported runtime state |
| Backup service | online DB backup and artifact metadata backup |

## 6.2 Node daemon

One rootless node daemon runs per OS user that owns the relevant projects and agent credentials.

Responsibilities:

- maintain one outbound full-duplex hub connection;
- authenticate itself cryptographically;
- keep a local SQLite spool;
- supervise agent processes and long-running tasks;
- own a private WebSpider `tmux` server;
- expose no public filesystem server;
- implement project-root-safe file operations;
- maintain runtime session IDs and adapter metadata;
- collect terminal output/log segments;
- upload events/artifacts/results;
- bridge native-agent SDK calls through a local Unix socket;
- load secrets from local OS facilities;
- report capabilities and resource availability;
- reconcile surviving `tmux` sessions after daemon restart.

## 6.3 Browser portal

The browser application is served by the hub and must work as both desktop SPA and mobile PWA-style UI.

Primary views:

- most recently active agent;
- Master Spider / portfolio management;
- Projects;
- Agent/session detail;
- Task graph/list;
- Terminal;
- Files;
- Artifacts;
- Attention/approvals;
- Nodes;
- Audit/diagnostics.

## 6.4 Master spider

The master spider is represented as a normal `AgentInstance` with a powerful but explicit capability set.

Typical capabilities:

```text
project.read:*
agent.read:*
agent.spawn:approved-profiles
task.create:*
task.read:*
task.cancel:project-scoped
message.send:*
message.deliver_as_user:project-scoped
artifact.read:*
permission.respond:policy-limited
```

Typically withheld:

```text
node.enroll
node.revoke
secret.read_raw
policy.edit
message.deliver_as_system
terminal.control:*
filesystem.read:any_host_path
```

The master may be granted some of these deliberately, but there is no implicit omnipotence.

---

# 7. Core data model

The data model should use stable opaque IDs, e.g. UUIDv7 or ULID-like sortable IDs.

## 7.1 Project

```text
Project
  id
  name
  description
  labels
  default_master_agent_profile_id
  policy_id
  artifact_retention_policy_id
  created_at
  updated_at
```

## 7.2 ProjectBinding

Maps a project to a node-local directory.

```text
ProjectBinding
  id
  project_id
  node_id
  display_name
  local_root_path            # stored on node; encrypted/hidden at hub if desired
  workspace_mode             # existing | git_managed | custom
  git_remote
  default_branch
  read_only
  filesystem_policy_id
  data_labels
  created_at
```

A project may have different paths on different machines.

## 7.3 AgentWorkspaceRoot

This is the authoritative object for portal file access.

```text
AgentWorkspaceRoot
  id
  agent_instance_id
  project_binding_id
  logical_name               # e.g. workspace, outputs, dataset
  local_root_path            # node-resolved; never accepted from browser
  access_mode                # read_only | read_write
  expose_in_portal           # boolean
  allow_download             # boolean
  allow_search               # boolean
  allow_preview              # boolean
  symlink_policy             # contained_only | no_symlinks
  mount_policy               # allow_nested | same_filesystem_only
  created_at
  revoked_at
```

The default agent gets a single logical root named `workspace`.

Git-managed tasks should normally get their own per-task worktree, which becomes their workspace root.

## 7.4 Node

```text
Node
  id
  display_name
  public_key
  credential_version
  connection_epoch
  labels
  capabilities
  adapter_inventory
  resource_capacity
  resource_usage
  status
  last_seen_at
  revoked_at
```

Node status:

```text
enrolling -> online -> degraded -> offline
                  \-> revoked
```

## 7.5 AgentProfile

```text
AgentProfile
  id
  name
  adapter_kind               # acp | native | pty | a2a | provider_native
  executable
  arguments_template
  environment_secret_refs
  model_metadata
  system_instructions
  node_selector
  workspace_policy
  concurrency_limit
  idle_policy
  permission_policy_id
  result_policy
  restart_policy
```

## 7.6 AgentInstance

```text
AgentInstance
  id
  profile_id
  project_id
  node_id
  task_id                    # optional owning task
  active_thread_id
  runtime_handle_id
  state
  resumability
  current_turn_id
  created_at
  last_activity_at
  stopped_at
```

States:

```text
absent
starting
ready
busy
waiting_input
waiting_permission
hibernating
hibernated
failed
stopping
stopped
offline
```

## 7.7 Thread

```text
Thread
  id
  project_id
  primary_agent_instance_id
  title
  status
  last_message_sequence
  created_at
  updated_at
```

A WebSpider thread persists even if the underlying vendor agent loses its own session.

## 7.8 RuntimeSession

```text
RuntimeSession
  id
  thread_id
  node_id
  adapter_kind
  external_session_id
  protocol_version
  resumable
  last_loaded_at
  metadata
```

## 7.9 TerminalSession

```text
TerminalSession
  id
  agent_instance_id
  node_id
  kind                       # primary_agent | task_shell | auxiliary
  tmux_socket_id
  tmux_session_name
  tmux_pane_id
  state
  canonical_columns
  canonical_rows
  controller_lease_id
  created_at
  exited_at
```

## 7.10 Task

```text
Task
  id
  project_id
  parent_task_id
  type                       # agent_turn | command | workflow | external
  title
  specification
  desired_agent_profile_id
  assigned_agent_instance_id
  node_selector
  priority
  state
  retry_policy
  result_id
  created_by
  created_at
```

Task state:

```text
pending -> runnable -> leased -> running -> waiting_input
                                    |-> waiting_permission
                                    |-> succeeded
                                    |-> failed
                                    |-> cancelled
```

## 7.11 TaskAttempt

```text
TaskAttempt
  id
  task_id
  attempt_number
  node_id
  agent_instance_id
  lease_token
  connection_epoch
  started_at
  heartbeat_at
  completed_at
  exit_status
  failure_kind
```

## 7.12 Message

```text
Message
  id
  thread_id
  task_id
  authenticated_actor_id
  delivery_role              # user | assistant | system | tool, policy controlled
  display_sender
  content_parts
  reply_to_message_id
  trace_id
  hop_count
  priority
  wake_policy
  idempotency_key
  created_at
  expires_at
```

Message bodies are immutable.

## 7.13 MessageDelivery

```text
MessageDelivery
  id
  message_id
  recipient_agent_instance_id
  state
  node_command_id
  adapter_receipt
  attempt_count
  last_attempt_at
  delivered_at
  failed_at
  failure_reason
```

## 7.14 Event

```text
Event
  id
  global_sequence
  scope_type
  scope_id
  scope_sequence
  type
  version
  actor_id
  subject_id
  trace_id
  node_local_sequence
  node_timestamp
  hub_timestamp
  payload
```

Examples:

```text
node.online.v1
node.offline.v1
agent.ready.v1
agent.turn.started.v1
agent.turn.completed.v1
agent.permission.requested.v1
task.started.v1
task.completed.v1
task.failed.v1
message.accepted.v1
message.delivered.v1
artifact.created.v1
filesystem.changed.v1
terminal.exited.v1
```

## 7.15 Trigger

```text
Trigger
  id
  project_id
  name
  enabled
  event_filter
  condition_expression
  actions
  cooldown
  dedupe_window
  maximum_hops
  rate_limit
```

Use a constrained expression language such as CEL. Do not allow arbitrary JavaScript or shell execution inside hub trigger definitions.

## 7.16 Artifact

```text
Artifact
  id
  project_id
  task_id
  agent_instance_id
  kind
  logical_name
  sha256
  size_bytes
  mime_type
  storage_backend
  storage_locator
  source_root_id
  source_relative_path
  created_at
  retention_until
```

---

# 8. Portal UX and session click-through

This is a core product feature, not a diagnostics afterthought.

## 8.1 Active-agent home and Master access

With no explicit deep link, the portal resumes the most recently active agent. The Master remains a permanent one-click navigation target and owns the portfolio operational summary. This avoids forcing ordinary direct project work through the Master while preserving immediate access to managed portfolio mode.

Desktop layout:

```text
+----------------------+--------------------------------------+---------------------+
| Projects / Agents    | Master Spider                        | Attention           |
|                      |                                      |                     |
| project-a            | conversation                         | 2 approvals         |
|   master             |                                      | 1 task failed       |
|   backend-agent   ●  |                                      | 1 node offline      |
|   reviewer        ◐  |                                      |                     |
| project-b            |                                      |                     |
|   analysis-agent  ●  |                                      |                     |
+----------------------+--------------------------------------+---------------------+
```

The summary bar should show, for example:

```text
3 projects active | 7 tasks running | 2 awaiting approval | 1 node offline | 4 unread completions
```

## 8.2 Every agent/session is clickable

Any visible agent reference in:

- a master-agent message;
- project sidebar;
- task list;
- task dependency graph;
- notification;
- artifact provenance view;
- audit event;

must link to the same canonical Agent Session Detail page.

Example deep link:

```text
/app/projects/<project-id>/agents/<agent-instance-id>
```

The page remains stable across browser reloads.

## 8.3 Agent Session Detail

Header:

```text
Backend Agent    busy
Node: gpu-box
Task: T-184 Implement parser
Adapter: ACP / structured
Workspace: workspace
Last activity: 12s ago

[Send message] [Queue follow-up] [Interrupt] [Wake] [Stop] [Restart]
```

Tabs:

```text
Conversation | Activity | Terminal | Files | Artifacts | Tasks | Metadata
```

### Conversation tab

Shows the normalized durable WebSpider transcript.

For ACP/native adapters it should render:

- user/agent messages;
- streaming message chunks;
- tool calls and tool results;
- plan updates;
- permission requests;
- elicitation requests;
- files changed/published;
- task state transitions;
- completion reason.

Messages created by automation should display provenance such as:

```text
Automation -> delivered to agent as user message
```

or:

```text
Reviewer Agent -> delivered as user message
```

The model-facing role and actual sender must never be conflated in the UI.

### Activity tab

Chronological event timeline:

```text
10:14:02  task started
10:14:04  ACP session resumed
10:14:08  agent plan updated
10:15:31  tool: test command started
10:17:46  artifact created
10:17:47  task completed
```

Filters:

- messages;
- tools;
- terminal commands;
- files;
- tasks;
- permissions;
- system events.

### Terminal tab

Live xterm.js view of the primary managed terminal.

Controls:

- read-only/watch mode;
- Take Control;
- Release Control;
- Ctrl/Esc/Tab virtual keys on mobile;
- copy selection;
- scrollback search;
- reconnect/resync;
- download terminal log if authorized;
- optional open auxiliary terminal.

### Files tab

A project-root-only file explorer described in detail in section 9. It includes an explicit upload action for placing a file into the open folder without creating an agent message or wake.

### Artifacts tab

Durable promoted outputs with:

- filename/logical name;
- hash;
- size;
- producer;
- task;
- timestamp;
- preview;
- download;
- provenance link back to source workspace path if it still exists.

### Tasks tab

Shows:

- current task;
- parent task;
- child tasks delegated by this agent;
- dependencies;
- retries;
- outputs;
- messages associated with each task.

## 8.4 Watching live interaction

The browser subscribes to durable events after a stored event cursor.

Structured adapter events are appended to the conversation/activity panes in real time. If the browser disconnects, it reconnects with:

```text
after=<last_global_sequence>
```

and the hub replays missed events before returning to live mode.

The user can therefore close and reopen the portal without losing the narrative of what happened.

Terminal streams are different: they may be resynchronized rather than fully replayed from the durable event log. Historical terminal logs are separately available.

## 8.5 Human message injection

A send box is always available on the Conversation tab unless policy forbids messaging.

The UI offers delivery behavior explicitly:

```text
Send now if ready
Queue after current turn
Wake if sleeping
Interrupt current turn and send
Queue only
```

Default:

```text
Wake if necessary + queue after current turn
```

Before privileged `interrupt` delivery, the UI displays the consequences, e.g. current generation/tool execution may be cancelled.

For PTY-only agents where the node cannot prove prompt readiness, the UI must show:

```text
Waiting for safe input state
```

rather than blindly pasting text into a busy full-screen terminal.

## 8.6 Mobile behavior

Mobile is a first-class client, not a shrunken desktop.

Bottom navigation:

```text
Master | Agents | Tasks | Attention | More
```

Within an agent:

```text
Chat | Terminal | Files | Status
```

Terminal opens read-only. The user must tap `Take Control` to obtain the control lease. This prevents a phone's narrow viewport from unexpectedly resizing the canonical terminal while a laptop is using it.

The Attention page prioritizes:

- approvals;
- authentication requests;
- task failures;
- ambiguous terminal input states;
- node outages;
- merge conflicts;
- master-agent questions.

## 8.7 Multiple simultaneous browser clients

Structured state:

- every client receives the same durable events;
- messages written on one device appear on all others;
- drafts are device-local unless explicitly synced.

Terminal state:

- any number of viewers;
- one active controller lease;
- lease may be transferred;
- all viewers see control-holder identity;
- controller disconnect causes lease expiry and automatic release.

Files:

- multiple clients may browse concurrently;
- downloads are independent;
- destructive filesystem mutations are outside v1 browser scope by default; if later enabled, they use optimistic concurrency/preconditions.

---

# 9. Project-root filesystem browser and download subsystem

This section defines a strict security requirement: **the WebSpider portal may browse only explicitly authorized project/workspace roots for the selected agent. It may not browse arbitrary host filesystem locations.**

## 9.1 Security model

The browser must never send:

```json
{"path": "/etc/passwd"}
```

and expect the node to decide whether it is acceptable.

Instead it sends:

```json
{
  "root_id": "awr_01...",
  "relative_path": "results/model.json"
}
```

The hub verifies the human's project/agent permission. The node then verifies that `root_id` is an active root assigned to that agent and performs the operation through a traversal-resistant rooted filesystem handle.

There is **no** generic endpoint of the form:

```text
GET /files?absolute_path=...
```

There is **no** node command that accepts an arbitrary host root supplied by a browser user.

## 9.2 Root lifecycle

Roots are created only from trusted configuration or trusted workspace creation code.

For an existing project:

```text
ProjectBinding.local_root_path -> AgentWorkspaceRoot(workspace)
```

For a Git-managed task:

```text
ProjectBinding
  -> managed worktree path
  -> AgentWorkspaceRoot(workspace)
```

For declared outputs:

```text
workspace/results
  -> optional secondary logical root "outputs"
```

The node resolves the configured root once and opens/pins a rooted handle when possible. Browser requests reference only the root ID.

If the root is deleted, revoked, or no longer owned by the configured project binding, the root becomes unavailable rather than silently retargeting to a new directory with the same pathname.

## 9.3 Go implementation

Use Go 1.24+ `os.Root`/`os.OpenRoot` for portable traversal-resistant operations.

Conceptually:

```go
root, err := os.OpenRoot(configuredRoot)
if err != nil { ... }
defer root.Close()

f, err := root.Open(relativePath)
```

`os.Root` rejects operations that escape the root through `..` or escaping symlinks.

Do **not** implement security with only:

```go
filepath.Join(base, userPath)
filepath.Clean(...)
strings.HasPrefix(...)
```

Those patterns are not sufficient against symlink traversal and race conditions.

## 9.4 Linux hardening

On Linux, the file service should use an `openat2` helper where stronger constraints are needed.

Recommended resolve policy for file content operations:

```text
RESOLVE_BENEATH
RESOLVE_NO_MAGICLINKS
```

Strict mode may additionally use:

```text
RESOLVE_NO_SYMLINKS
RESOLVE_NO_XDEV
```

Tradeoffs:

- `RESOLVE_NO_SYMLINKS` is maximally simple but rejects useful symlinks entirely.
- `os.Root` semantics allow symlinks that remain inside the root.
- `RESOLVE_NO_XDEV` blocks mount-point crossings, including bind mounts, which is strongest confinement but may block intentionally mounted project datasets.

Therefore the default policy should be:

```text
symlink_policy: contained_only
mount_policy: allow_nested
```

with a selectable hardened policy:

```text
symlink_policy: no_symlinks
mount_policy: same_filesystem_only
```

## 9.5 Symlinks

Directory listings may display a symlink as metadata.

Rules:

- a symlink whose target remains inside the authorized root may be followed only under `contained_only` policy;
- a symlink escaping the root is never followed;
- absolute symlinks are not followed for portal content access;
- magic links such as `/proc/.../fd/...` must not provide an escape path;
- download endpoints re-resolve the path using the rooted filesystem API at open time; a prior `stat` result is not trusted as authorization.

The UI should display:

```text
link -> target (inside workspace)
```

or:

```text
link -> external target [blocked]
```

without exposing sensitive external target content.

## 9.6 Special files

The portal must not stream arbitrary special files.

Allowed content-download types by default:

- regular files only.

Directory listing metadata may identify:

- directories;
- symlinks;
- regular files.

Blocked for preview/download:

- device nodes;
- FIFOs;
- Unix sockets;
- procfs-style magic resources;
- other non-regular special files.

If a project deliberately uses a special file, it requires a separate explicit feature; it is not treated as a normal download.

## 9.7 File API

Suggested REST API:

```text
GET /api/v1/agent-instances/{agent}/roots
GET /api/v1/roots/{root}/entries?path=<relative>&cursor=<cursor>
GET /api/v1/roots/{root}/stat?path=<relative>
GET /api/v1/roots/{root}/preview?path=<relative>
GET /api/v1/roots/{root}/download?path=<relative>
GET /api/v1/roots/{root}/search?query=<q>&path=<relative>
GET /api/v1/roots/{root}/git-status?path=<relative>
POST /api/v1/roots/{root}/file-transfers
POST /api/v1/roots/{root}/file-transfers/{transfer}/chunks
POST /api/v1/roots/{root}/file-transfers/{transfer}:complete
POST /api/v1/roots/{root}/promote-artifact
```

The hub substitutes the authenticated user's identity and forwards a signed/scoped command to the node. The node does not trust the hub-supplied relative path until it has resolved it through the root handle.

## 9.8 Directory listing

Response:

```json
{
  "root_id": "awr_01...",
  "path": "results",
  "entries": [
    {
      "name": "summary.md",
      "kind": "file",
      "size": 48122,
      "mtime": "2026-08-24T09:32:11Z",
      "mode": "0644",
      "downloadable": true,
      "previewable": true
    },
    {
      "name": "plots",
      "kind": "directory",
      "mtime": "2026-08-24T09:30:00Z"
    }
  ],
  "next_cursor": null
}
```

Pagination is required for very large directories.

The UI should support:

- breadcrumbs;
- filename sorting;
- size/date sorting;
- hidden file toggle;
- Git status badges;
- recent outputs filter;
- task-produced files filter.

## 9.9 Preview behavior

Safe text previews:

- UTF-8/plain text;
- source code;
- JSON/YAML/TOML;
- logs;
- Markdown rendered with strict sanitization and no arbitrary HTML;
- CSV/TSV with bounded rows/columns.

Binary previews:

- common raster images via fetched bytes/blob URL;
- PDF using a sandboxed viewer or browser-native object isolation;
- audio/video only if explicitly supported and bounded.

Unsafe active content:

- arbitrary HTML should not execute in the WebSpider origin;
- SVG should not be inserted as live same-origin DOM by default;
- project JavaScript is never executed for preview;
- office documents should be download-only unless converted server-side in an isolated process.

Response hardening:

```text
X-Content-Type-Options: nosniff
Content-Security-Policy: restrictive
Content-Disposition: attachment for raw downloads
```

A raw file URL must not become a same-origin script execution primitive.

## 9.10 Preview limits

Configurable defaults:

```text
max_text_preview_bytes: 2 MiB
max_hex_preview_bytes: 1 MiB
max_table_preview_rows: 10,000
max_search_matches: 5,000
max_search_runtime: 10s
```

Large files remain downloadable even if they are not previewed.

## 9.11 Download path

Remote-node download flow:

```text
Browser
  -> authorized GET hub/root/download
Hub
  -> signed FileRead command(node, root_id, relative_path, byte-range)
Node
  -> root-safe open
  -> verify regular file
  -> stream chunks over node connection
Hub
  -> stream to browser with backpressure
```

The hub never asks the node to open a path outside the selected root.

Support HTTP range requests for large files where practical.

## 9.12 Download consistency

A file may change while downloading.

At open time the node returns:

```text
file_handle_id
size
mtime
inode/file-id when available
```

The stream reads from the already-open file descriptor/handle, so path replacement during transfer does not redirect the download to another file.

Optional query:

```text
?expected_etag=<rooted-file-version>
```

can fail with `412 Precondition Failed` if the file changed since the user previewed it.

## 9.13 File search

Filename search can use directory walking through the root API.

Content search may use `ripgrep` only if the node executes it with:

- working directory pinned to the root;
- no user-supplied arbitrary `--glob`/argument injection;
- argument array construction rather than a shell string;
- bounded runtime/output;
- root-contained traversal policy.

A pure-Go search implementation is preferable for strict semantics, with `ripgrep` as an optimized optional backend.

Search results always return root-relative paths.

## 9.14 Git integration

If the workspace is a Git repository, the Files tab may show:

- modified/untracked/staged state;
- diff preview;
- branch/worktree name;
- last commit;
- task-created changes.

Git commands must run with the workspace as a trusted root. Do not accept arbitrary `--git-dir` paths from the browser.

## 9.15 Artifact promotion

The user or an agent can promote a workspace file to a durable artifact.

Flow:

1. safe-open file through workspace root;
2. hash contents;
3. record size, source relative path, task, and producer;
4. copy or stream into artifact storage;
5. emit `artifact.created.v1`;
6. optionally notify the master agent.

The artifact remains available according to retention policy even if the transient worktree is later deleted.

## 9.16 What filesystem confinement does and does not guarantee

Portal confinement guarantees that **WebSpider's file-browser/download APIs** cannot access files outside registered roots.

This does not automatically sandbox a third-party agent process that has ordinary host shell access. If the product requirement is also that the **agent itself** cannot read host files outside its project, the agent must run inside a stronger execution sandbox described in section 22.

The UI should distinguish:

```text
Portal filesystem scope: workspace-only   [guaranteed by WebSpider file API]
Agent process scope:      host-user       [agent may access host files]
```

or:

```text
Portal filesystem scope: workspace-only
Agent process scope:      sandboxed workspace-only
```

This prevents a misleading sense of isolation.

---

# 10. Hub-to-node transport

## 10.1 Connection topology

Each node opens one long-lived outbound WSS connection to the hub.

Transport properties:

- TLS/WSS;
- binary Protobuf frames;
- one connection multiplexing commands, events, terminal streams, agent streams, file streams, artifact streams, and heartbeats;
- explicit application-level node authentication;
- reconnect with sequence/ack state;
- bounded per-stream buffers.

A pure gRPC transport may be added later, but should not be required for v1 deployment through generic HTTPS/Tailscale Serve infrastructure.

## 10.2 Frame envelope

Illustrative protobuf:

```protobuf
message NodeFrame {
  uint32 protocol_version = 1;
  string node_id = 2;
  uint64 connection_epoch = 3;
  uint64 sequence = 4;
  uint64 acknowledges_through = 5;
  string message_id = 6;
  string stream_id = 7;

  oneof body {
    Hello hello = 20;
    ChallengeResponse auth = 21;
    Heartbeat heartbeat = 22;
    Command command = 23;
    CommandReceipt command_receipt = 24;
    EventBatch event_batch = 25;
    StreamOpen stream_open = 26;
    StreamData stream_data = 27;
    StreamClose stream_close = 28;
    ArtifactChunk artifact_chunk = 29;
    FileChunk file_chunk = 30;
  }
}
```

## 10.3 Durable vs stream channels

Durable commands:

- start/stop/restart agent;
- deliver message;
- start task;
- cancel task;
- permission response;
- create terminal attachment;
- file operation authorization descriptor;
- artifact promotion.

These are persisted in the node spool before acknowledgement.

Transient streams:

- terminal bytes;
- file download chunks after the durable/open authorization;
- live telemetry.

## 10.4 Connection epoch fencing

Every successful node login receives a monotonically increasing `connection_epoch`.

Commands include the epoch. If an older network connection comes back to life after a replacement connection has been accepted, its commands/receipts are rejected.

This prevents split-brain node sessions.

---

# 11. Agent adapter architecture

## 11.1 Internal adapter interface

```go
type AgentAdapter interface {
    Probe(ctx context.Context, profile AgentProfile) (Capabilities, error)
    Start(ctx context.Context, spec InstanceSpec) (RuntimeHandle, error)
    Resume(ctx context.Context, session RuntimeSession) (RuntimeHandle, error)
    Send(ctx context.Context, handle RuntimeHandle, msg Message) (DeliveryReceipt, error)
    Cancel(ctx context.Context, handle RuntimeHandle, turnID string) error
    Stop(ctx context.Context, handle RuntimeHandle, mode StopMode) error
    Inspect(ctx context.Context, handle RuntimeHandle) (RuntimeState, error)
    Events(handle RuntimeHandle) <-chan AdapterEvent
}
```

Provider-specific behavior remains behind this contract.

## 11.2 ACP adapter

Lifecycle:

1. spawn ACP agent subprocess;
2. negotiate ACP version and capabilities;
3. authenticate if needed;
4. create or load runtime session;
5. provide project working directory/root configuration;
6. expose WebSpider MCP tools to the agent if configured;
7. deliver messages with `session/prompt`;
8. translate `session/update` notifications into WebSpider events;
9. translate permission/elicitation calls into durable attention items;
10. persist runtime session ID;
11. on process restart, call session load if supported;
12. map prompt completion to task/turn completion.

ACP filesystem callbacks supplied by WebSpider must also respect the agent workspace root. ACP's requirement that protocol file paths be absolute does not mean WebSpider should permit arbitrary absolute host paths; the adapter maps/validates the absolute path against the instance's authorized root before performing an operation.

## 11.3 Native WebSpider adapter and SDK

Local agent connects to:

```text
$XDG_RUNTIME_DIR/webspider/node.sock
```

Functions:

```text
Register
NextMessage
AcknowledgeMessage
Reply
CreateChildTask
UpdateTask
CompleteTask
PublishArtifact
RequestPermission
RequestHumanInput
ReportHealth
```

Illustrative Python:

```python
from webspider_agent import Agent

async with Agent.from_environment() as agent:
    async for message in agent.messages():
        result = await handle(message)
        await agent.reply(
            message,
            text=result.summary,
            artifacts=result.artifacts,
        )
```

Use a short-lived instance token in a mode-0600 file or inherited file descriptor. Do not pass it as a process argument.

## 11.4 PTY adapter

Launches a terminal-oriented CLI in the private WebSpider `tmux` server.

Provider adapter metadata:

```text
launch command
resume command if any
prompt-ready detector
busy detector
auth-required detector
completion detector
multiline-input behavior
interrupt behavior
```

Generic mode:

- prompt regex;
- output quiescence threshold;
- single-line input default;
- explicit `best_effort_readiness=true`.

## 11.5 Command adapter

For long non-agent commands:

```bash
webspider run --project p1 --node gpu-box --detach -- make exhaustive-analysis
```

The node task wrapper:

- launches command in managed `tmux` or direct supervised PTY;
- captures stdout/stderr;
- records exit code;
- atomically writes task completion to node spool;
- publishes declared output paths as artifacts if requested;
- survives hub disconnection;
- emits completion after reconnect if necessary.

## 11.6 A2A gateway

Mapping:

| A2A | WebSpider |
|---|---|
| AgentCard | AgentProfile/capabilities |
| Task | Task + TaskAttempt |
| Message | Message |
| Artifact | Artifact |
| status update | Event |
| push notification | trigger/webhook event |

Hub-mediated routing is preferred because it preserves audit and durability.

---

# 12. Durable messaging and wake-up

## 12.1 Acceptance transaction

A message is acknowledged as accepted only after one database transaction has created:

- immutable Message;
- MessageDelivery rows;
- `message.accepted` event;
- node-command outbox row if dispatch is currently possible.

## 12.2 Safe spoof/delivery-role model

WebSpider may need an automation or another agent to appear to the target LLM as a new user turn. This is supported without falsifying audit provenance.

Example:

```json
{
  "id": "msg_01J...",
  "thread_id": "thr_master_project_a",
  "authenticated_actor": "trigger:task-completion",
  "delivery_role": "user",
  "display_sender": "agent:backend-worker",
  "to": ["agent:master"],
  "parts": [
    {
      "type": "text",
      "text": "Task T-184 completed. Tests passed. Artifact art_92 is ready."
    }
  ],
  "wake": "ensure_running",
  "idempotency_key": "task:T-184:completed:master",
  "trace_id": "tr_01J...",
  "hop_count": 2
}
```

Capabilities:

```text
message.send
message.deliver_as_user
message.deliver_as_system
```

`deliver_as_system` should be highly privileged and normally unavailable to worker agents.

## 12.3 Delivery states

```text
accepted
  -> queued
  -> waking
  -> node_received
  -> adapter_accepted
  -> turn_running
  -> replied
```

Terminal states:

```text
expired
failed
cancelled
undeliverable
```

## 12.4 Wake policies

| Policy | Meaning |
|---|---|
| `queue_only` | persist but do not start a stopped agent |
| `ensure_running` | start/resume as needed then deliver |
| `deliver_when_ready` | queue behind an active turn |
| `interrupt` | cancel active turn then deliver; privileged |
| `fail_if_not_ready` | reject rather than queue |

Default:

```text
ensure_running + deliver_when_ready
```

## 12.5 State-specific behavior

```text
ready              -> deliver immediately
busy               -> queue next turn
starting           -> wait for readiness
hibernated         -> resume/start, then drain queue
waiting_input      -> queue separately and surface attention item
waiting_permission -> preserve queue; do not destroy pending approval
failed             -> apply restart/retry policy
offline            -> durable queue until node reconnects
stopped            -> start only if wake policy permits
```

## 12.6 Deduplication

Node persists delivery command before acknowledging it.

Adapter dedup key:

```text
message_id
```

ACP/native adapters can normally return the original receipt for duplicate delivery.

PTY adapters record a final `input_committed` marker. If a connection fails in the narrow window after terminal input but before acknowledgement, exact semantic deduplication may be impossible. The hub surfaces `delivery_uncertain` instead of pretending certainty.

## 12.7 PTY-safe injection

Never interpolate an injected message into a shell command.

Procedure:

1. validate UTF-8;
2. normalize line endings;
3. remove forbidden control characters;
4. enforce input-size limit;
5. write message to a named tmux buffer using safe stdin/file-descriptor API;
6. paste buffer into the intended pane;
7. emit Enter separately;
8. record pane/session/message ID;
9. update input-commit state.

Provider plugin defines whether multiline paste is safe.

## 12.8 Completion-triggered master wake

Example trigger:

```yaml
kind: Trigger
metadata:
  name: wake-master-on-completion
spec:
  event:
    type: task.completed.v1
    match:
      project_id: project-a

  condition: >
    event.data.notify_master == true

  actions:
    - send:
        to: agent://master/project-a
        delivery_role: user
        wake: ensure_running
        idempotency_key: "notify:${event.subject}:${event.type}"
        template: |
          Task ${event.data.task_id} completed on ${event.data.node_name}.

          Summary:
          ${event.data.result.summary}

          Artifacts:
          ${event.data.result.artifacts}
```

## 12.9 Burst coalescing

If 30 child tasks complete within a short interval, WebSpider should avoid forcing 30 separate master-agent turns.

Optional notification aggregator:

```text
aggregation_window: 5s
max_items: 50
```

produces one digest unless a task is marked urgent.

## 12.10 Loop/cost controls

Every routed event/message carries:

```text
trace_id
hop_count
```

Enforce:

- maximum hop count;
- maximum messages per trace;
- trigger cooldown;
- dedupe window;
- per-agent concurrency;
- maximum child-task depth;
- recipient allow-lists;
- optional token/cost budget;
- per-project hourly action budget.

---

# 13. Terminal subsystem

## 13.1 Private tmux server

Do not reuse the user's normal tmux server.

Example socket:

```text
~/.local/share/webspider/node/tmux/tmux.sock
```

State directory is user-private.

Recommended configuration:

```text
remain-on-exit on
allow-rename off
set-clipboard off
history-limit 100000
window-size manual
```

WebSpider should start tmux with a minimal controlled config and an isolated socket namespace.

## 13.2 Session organization

Prefer one dedicated tmux session per primary interactive agent rather than a huge shared tmux session containing every agent. This prevents one browser attachment from changing another viewer's active window.

Naming:

```text
ws-agent-<short-instance-id>
ws-task-<short-task-id>
```

## 13.3 Browser terminal path

```text
managed process
  <-> tmux pane
  <-> local attach PTY
  <-> node multiplexed WSS
  <-> hub terminal broker
  <-> browser terminal WSS
  <-> xterm.js
```

## 13.4 Control lease

```text
TerminalControlLease
  terminal_id
  attachment_id
  principal_id
  lease_epoch
  acquired_at
  expires_at
```

Rules:

- unlimited read-only attachments;
- one controller;
- only controller may send keyboard input and canonical resize;
- controller sends lease heartbeat;
- disconnected controller lease expires quickly;
- explicit takeover increments lease epoch;
- stale input with old epoch is rejected.

## 13.5 Resizing

Only controller changes canonical PTY/tmux size.

Read-only viewers fit/scroll locally without changing the underlying session.

This is particularly important for phone + laptop coexistence.

## 13.6 Flow control

Implement application-level terminal backpressure.

Each output chunk has a stream sequence. Browser periodically ACKs bytes after xterm.js has processed them.

Server thresholds:

```text
LOW_WATER
HIGH_WATER
MAX_UNACKED
```

At high water:

- pause local attach PTY if possible;
- otherwise bound buffers.

If a viewer falls irrecoverably behind:

1. send `RESYNC_REQUIRED`;
2. close that attachment only;
3. establish a fresh tmux attachment;
4. let tmux redraw current screen.

Other viewers and the underlying process remain unaffected.

## 13.7 Terminal logs

Node records compressed terminal segments:

```text
terminal_id
start_sequence
end_sequence
start_time
end_time
compressed_bytes
sha256
```

Logs may be uploaded lazily to the hub/artifact store according to policy.

Terminal logs are supplemental evidence, not the canonical structured conversation for ACP/native agents.

---

# 14. Task model and scheduling

## 14.1 Scheduling inputs

Node selectors may include:

```yaml
all:
  - os: linux
  - project_binding: project-a
  - gpu.vendor: nvidia
prefer:
  - gpu.vram_gb: ">=24"
```

Scheduler considers:

- online state;
- project workspace availability;
- required adapter;
- model/tool capability;
- concurrency;
- CPU/memory/GPU capacity;
- data locality;
- task affinity;
- current stateful session placement.

## 14.2 Stateful session pinning

A stateful agent instance remains pinned to its current node unless the adapter explicitly declares portable migration.

Do not infer that an ACP/vendor session ID can be loaded on another machine unless the underlying agent guarantees it.

## 14.3 Task DAG

Tasks may depend on other tasks.

```text
T1 research
 |\
 | T2 implementation
 | T3 benchmark
  \ /
   T4 review
```

Hub validates no cycles at task creation/update.

Agents can create child tasks through scoped tools.

## 14.4 Structured result

```json
{
  "status": "succeeded",
  "summary": "Implemented the parser and added 18 tests.",
  "artifacts": [
    {
      "id": "art_01J...",
      "kind": "git_patch",
      "sha256": "...",
      "size": 18427
    }
  ],
  "metrics": {
    "tests_passed": 18,
    "tests_failed": 0
  },
  "suggested_followups": [
    "Run the integration suite on the GPU node."
  ]
}
```

Completion source may be:

- ACP prompt response;
- native `CompleteTask`;
- command exit code;
- A2A terminal task state;
- provider-specific structured response;
- explicit PTY completion sentinel.

WebSpider must not fabricate success from terminal silence.

---

# 15. Workspaces and Git

## 15.1 Existing workspace mode

User binds an existing directory:

```bash
webspider project add \
  --name protein-pipeline \
  --node workstation=/home/me/src/protein-pipeline \
  --node gpu-box=/data/projects/protein-pipeline
```

The node path becomes a registered project binding.

## 15.2 Git-managed workspace mode

```bash
webspider project add \
  --name service-a \
  --git <remote> \
  --workspace-mode git-managed
```

Each task/agent may receive a dedicated worktree:

```text
webspider/<project>/<task-id>/<agent-id>
```

Suggested branch:

```text
webspider/<project>/<task-id>/<agent-id>
```

## 15.3 No implicit cross-machine filesystem sync

WebSpider does not pretend node-local workspaces are identical.

Move state through:

- Git commits/branches/patches;
- WebSpider artifacts;
- explicit file transfer task;
- remote object storage;
- task messages containing references.

Large datasets should be represented through node/data labels rather than copied automatically.

## 15.4 Per-agent workspace visibility

When agents use isolated worktrees, clicking agent A's Files tab shows agent A's root, not another agent's worktree.

If a project intentionally uses a shared existing workspace, multiple agent instances may point to the same root. The UI must clearly label it `shared workspace` and surface concurrent-change risk.

---

# 16. External job integration

Long work initiated outside an agent can wake an agent on completion.

CLI:

```bash
webspider notify \
  --event external.job.completed \
  --project project-a \
  --to agent://master/project-a \
  --wake \
  --data result.json
```

Wrapper:

```bash
ws_run_and_notify agent://master/project-a -- make exhaustive-analysis
```

The wrapper records:

- start time;
- command identity;
- exit status;
- selected logs;
- declared artifacts;
- task/event ID.

Arbitrary unrelated processes cannot be reliably detected unless registered or wrapped.

---

# 17. Browser API

## 17.1 Projects

```text
GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/{id}
PATCH  /api/v1/projects/{id}
```

## 17.2 Nodes

```text
GET    /api/v1/nodes
POST   /api/v1/nodes/join-tokens
POST   /api/v1/nodes/{id}:revoke
POST   /api/v1/nodes/{id}:rename
```

## 17.3 Agents

```text
GET    /api/v1/agent-profiles
POST   /api/v1/agent-profiles
GET    /api/v1/agent-instances
POST   /api/v1/agent-instances
GET    /api/v1/agent-instances/{id}
POST   /api/v1/agent-instances/{id}:wake
POST   /api/v1/agent-instances/{id}:stop
POST   /api/v1/agent-instances/{id}:restart
```

## 17.4 Threads/messages

```text
GET    /api/v1/threads/{id}
GET    /api/v1/threads/{id}/messages
POST   /api/v1/threads/{id}/messages
```

Mutation accepts:

```text
Idempotency-Key: <opaque>
```

## 17.5 Tasks

```text
GET    /api/v1/tasks
POST   /api/v1/tasks
GET    /api/v1/tasks/{id}
POST   /api/v1/tasks/{id}:cancel
POST   /api/v1/tasks/{id}:retry
```

## 17.6 Events

```text
GET /api/v1/events?after=<sequence>&project=<id>
GET /api/v1/ws/events?after=<sequence>
```

## 17.7 Permissions

```text
GET  /api/v1/attention
POST /api/v1/permissions/{id}:respond
POST /api/v1/elicitation/{id}:respond
```

## 17.8 Terminals

```text
POST   /api/v1/terminals/{id}/attachments
POST   /api/v1/terminals/{id}/leases
DELETE /api/v1/terminals/{id}/leases/{lease-id}
GET    /api/v1/ws/terminals/{terminal-id}?attachment=<id>
```

## 17.9 Files

As defined in section 9:

```text
GET  /api/v1/agent-instances/{id}/roots
GET  /api/v1/roots/{root}/entries
GET  /api/v1/roots/{root}/stat
GET  /api/v1/roots/{root}/preview
GET  /api/v1/roots/{root}/download
GET  /api/v1/roots/{root}/search
GET  /api/v1/roots/{root}/git-status
POST /api/v1/roots/{root}/file-transfers
POST /api/v1/roots/{root}/file-transfers/{transfer}/chunks
POST /api/v1/roots/{root}/file-transfers/{transfer}:complete
POST /api/v1/roots/{root}/promote-artifact
```

## 17.10 Artifacts

```text
GET /api/v1/artifacts/{id}
GET /api/v1/artifacts/{id}/download
```

---

# 18. Browser event protocol

## 18.1 Durable event stream

Browser WebSocket:

```text
/api/v1/ws/events?after=<global-sequence>
```

Subscription filters:

```json
{
  "projects": ["p1"],
  "threads": ["t1"],
  "agents": ["a1"],
  "tasks": ["task1"]
}
```

Server sends replay then live events.

## 18.2 Terminal WebSocket frames

```text
ATTACH
OUTPUT
INPUT
RESIZE
LEASE_REQUEST
LEASE_GRANTED
LEASE_REVOKED
ACK_OUTPUT
RESYNC_REQUIRED
EXIT
HEARTBEAT
```

Terminal bytes should use binary frames. Control metadata may use Protobuf or compact JSON.

## 18.3 File streams

File downloads should normally use ordinary HTTP responses from the hub rather than browser WebSockets because HTTP already handles content-disposition, caching, byte ranges, and backpressure well. The hub internally multiplexes the node stream.

Uploads and live agent-to-agent handoffs use bounded chunks rather than whole-file command payloads. Transfer metadata records the last fsynced byte count; an unconfirmed tail is truncated before retry. Each chunk and the complete file are SHA-256 verified, and the completed mode-`0600` file is atomically renamed within the registered root. Agent relays use transient node commands so large payloads never enter Hub or Node command databases. Both nodes must be online and no SSH relationship is assumed.

---

# 19. MCP server exposed by WebSpider

Recommended tools:

```text
webspider.projects.list
webspider.projects.get
webspider.nodes.list
webspider.agents.list
webspider.agents.get
webspider.agents.spawn
webspider.agents.wake
webspider.agents.stop
webspider.threads.read
webspider.messages.send
webspider.tasks.create
webspider.tasks.get
webspider.tasks.list
webspider.tasks.cancel
webspider.tasks.wait
webspider.artifacts.read
webspider.artifacts.list
webspider.permissions.respond
webspider.files.list
webspider.files.read
webspider.files.search
```

Important: MCP filesystem tools must accept WebSpider `root_id` plus relative path, never raw absolute host paths.

For local stdio-only MCP clients, run:

```bash
webspider mcp-bridge --instance <instance-id>
```

The bridge gets a scoped instance credential and forwards requests to the hub.

---

# 20. Security model

## 20.1 Threat assumptions

Assume:

- a browser tab can be compromised;
- terminal output can be malicious;
- an LLM agent can be prompt-injected or intentionally malicious;
- a tailnet peer may reach the service but not be authorized for a project;
- node join tokens can be copied;
- stale node connections can replay messages;
- agents can ask for destructive operations;
- project files can contain hostile names, symlinks, HTML, SVG, and terminal escape sequences;
- a worker node compromise exposes that worker's local data and credentials.

Do not claim protection against a root-compromised node OS.

## 20.2 Tailscale deployment

Default recommended setup:

```text
hub HTTP server -> localhost only
Tailscale Serve -> HTTPS tailnet endpoint
```

Serve strips spoofed Tailscale identity headers before forwarding its own identity headers. Because header-based auth is safe only when traffic cannot bypass the trusted proxy, the hub must listen on loopback in this mode.

Alternative:

- embedded `tsnet` listener;
- OIDC on a normal private HTTPS endpoint;
- local/LAN mode with WebSpider login.

Do not automatically enable Tailscale Funnel.

## 20.3 Browser login/session

Requirements:

- HTTPS;
- Secure/HttpOnly/SameSite cookies;
- CSRF defense on state-changing HTTP requests;
- strict WebSocket Origin check;
- authorization on every WebSocket upgrade;
- no permissive wildcard CORS;
- short idle timeout;
- explicit owner reauthentication for security-sensitive changes where feasible.

## 20.4 Node enrollment

Flow:

1. owner creates one-time join token;
2. hub stores hash only;
3. token expiry default 10 minutes;
4. node generates Ed25519 keypair locally;
5. node connects with token and public key;
6. hub validates policy and consumes token atomically;
7. hub issues node identity/credential metadata;
8. future sessions use signature challenge-response;
9. credentials rotate;
10. node can be revoked instantly.

## 20.5 RBAC for humans

| Role | Access |
|---|---|
| Owner | security, enrollment, policies, secrets metadata, all projects |
| Operator | run agents/tasks, message, control terminals, browse files in assigned projects |
| Viewer | read conversations/tasks/files and read-only terminals in assigned projects |
| Auditor | audit/events without operational control |

Project-specific role bindings are required for multi-user installations.

## 20.6 Agent capability authorization

Examples:

```text
project.read:project-a
task.create:project-a
task.cancel:own
message.send:agent/backend-*
agent.spawn:profile/reviewer
artifact.publish:project-a
files.read:workspace
files.search:workspace
terminal.control:none
secret.use:provider-token
```

## 20.7 Secrets

Default:

- raw provider secrets remain node-local;
- hub stores names/scopes/assignments, not secret plaintext;
- use OS keychain or encrypted node-local vault;
- inject at process spawn through environment/file descriptor/file;
- never place secrets in CLI arguments;
- do not return secret values through browser APIs;
- logs use best-effort redaction but redaction is not a primary security boundary.

## 20.8 Terminal security

Terminal data is untrusted.

Requirements:

- xterm.js renderer APIs;
- never use terminal strings as `innerHTML`;
- sanitize terminal titles;
- custom linkification disabled initially;
- no automatic opening of URLs;
- WSS only;
- authenticated terminal attachment;
- strict input lease validation;
- frame-size/rate limits;
- restrictive CSP;
- no third-party CDN JavaScript on terminal page.

## 20.9 File browser security

Additionally:

- root ID authorization at hub;
- root ID validation again at node;
- traversal-resistant rooted file handle;
- no arbitrary absolute path parameter;
- safe handling of symlinks;
- reject special-file downloads;
- open file before streaming and stream from handle;
- safe MIME/content-disposition;
- no same-origin execution of project HTML/SVG/JS;
- download and preview operations audited.

## 20.10 Audit provenance

Every mutation records:

```text
actual principal
human/service/agent identity
requested delivery role
display sender
target object
project
trace ID
policy decision
client/node identity
previous state
new state
time
```

For file operations record at minimum:

```text
principal
agent instance
root ID
relative path
operation
bytes transferred where appropriate
success/failure
```

Avoid logging file content by default.

---

# 21. Strong agent filesystem isolation

The portal file browser is always root-confined. Separately, WebSpider may run the **agent process itself** with increasing levels of filesystem confinement.

## 21.1 Isolation levels

```text
none
worktree
unix-user
container
```

Potential Linux future mode:

```text
namespace-sandbox
```

using user/mount namespaces and a minimal bind-mounted workspace.

## 21.2 `none`

Agent runs as node user in an arbitrary project directory.

Pros:

- maximal compatibility.

Cons:

- agent can access everything the OS user can access.

UI warning:

```text
Agent execution scope: host user
```

## 21.3 `worktree`

Agent receives an isolated Git worktree but still has host-user filesystem permissions.

This prevents accidental project collisions, not deliberate host access.

## 21.4 `unix-user`

Dedicated OS user owns only the workspace and selected tools/secrets.

Better isolation but operationally heavier.

## 21.5 `container`

Docker/Podman container:

- workspace bind-mounted at `/workspace`;
- optional read-only tool/runtime mounts;
- node MCP/agent socket exposed through a scoped proxy;
- explicit network policy;
- resource limits;
- selected secrets only.

This is the recommended strong-isolation mode for untrusted agents.

## 21.6 Namespace sandbox

On Linux, a future built-in sandbox can use namespaces/landlock/seccomp or a small established sandbox helper. This should be treated as a separate security project with dedicated tests rather than improvised in the orchestration code.

---

# 22. Persistence

## 22.1 Hub SQLite

Use SQLite WAL mode for the initial single-hub deployment.

Recommended pragmas/configuration:

```text
journal_mode = WAL
foreign_keys = ON
synchronous = FULL
busy_timeout = configured
```

Keep DB/WAL on local storage.

Use SQLite online backup API for live backup.

## 22.2 Transactional outbox

Example transaction:

```text
mark task runnable
insert task.runnable event
insert node command outbox row
COMMIT
```

Outbox worker sends node command. If the hub crashes after send but before recording acknowledgement, it may resend; node idempotency handles this.

## 22.3 Node spool

Node-local SQLite stores:

- received commands;
- command receipts;
- node-local event sequence;
- unsent events;
- task-wrapper completion records;
- adapter runtime metadata;
- delivery dedup state;
- artifact upload checkpoints;
- optional terminal segment index.

## 22.4 Reconciliation

After reconnect/restart:

1. node authenticates with new connection epoch;
2. reports managed tmux sessions/process wrappers/runtime handles;
3. hub compares with desired state;
4. known sessions reattach;
5. unknown WebSpider-owned sessions become `orphaned`;
6. missing expected processes become stopped/failed or restart according to policy;
7. node replays unsent events;
8. hub resumes pending message/task dispatch.

## 22.5 Hub outage behavior

During hub outage:

- local agents/jobs continue;
- tmux remains alive;
- node spools task completion and events;
- local native agents can continue already assigned work;
- cross-node routing pauses;
- browser portal is unavailable;
- queued hub-originated messages cannot arrive until reconnect.

When hub returns, durable state reconciles.

---

# 23. Installation and operations

## 23.1 Binary

One executable:

```text
webspider
```

Subcommands:

```text
webspider up
webspider hub
webspider node
webspider ctl
webspider mcp-bridge
webspider task-wrapper
webspider notify
webspider service
webspider doctor
webspider backup
webspider restore
```

## 23.2 First machine

```bash
webspider up --tailnet
```

Responsibilities:

1. create config/state directories;
2. initialize hub DB;
3. initialize local node;
4. detect tmux;
5. detect supported agents/adapters;
6. configure tailnet exposure or embedded tsnet;
7. create owner mapping;
8. optionally install user service;
9. print portal URL.

## 23.3 Join additional machine

Hub:

```bash
webspider node token create --name gpu-workstation
```

Worker:

```bash
webspider node join \
  --hub https://<hub>.ts.net \
  --token wsj_<one-time-token>

webspider service install --user
```

Join verifies:

- hub identity;
- platform;
- local persistence permissions;
- tmux presence;
- agent inventory;
- project directories when preconfigured;
- clock skew;
- key persistence.

## 23.4 Agent discovery

```bash
webspider agents discover
```

Example:

```text
codex       ACP adapter available
claude      ACP adapter available
gemini      ACP adapter available
opencode    ACP available
custom-cli  PTY fallback
```

Discovered profiles must not silently receive broad project/secret capabilities.

## 23.5 Service management

- Linux: `systemd --user`;
- macOS: LaunchAgent;
- Windows initial support: WSL2 + systemd.

Root is not required for normal operation.

## 23.6 Diagnostics

```bash
webspider status
webspider doctor
webspider logs
webspider backup
webspider restore
webspider export <project>
```

`doctor` checks:

- hub reachability;
- tailnet identity;
- node authentication;
- DB integrity;
- disk space;
- tmux;
- agent adapters;
- project path permissions;
- rooted file operations;
- WebSocket Origin policy;
- clock skew;
- secret backend.

---

# 24. Configuration

Illustrative hub config:

```yaml
hub:
  listen: 127.0.0.1:7340
  database: ~/.local/share/webspider/hub/webspider.db

network:
  mode: tailscale-serve
  public_base_url: https://webspider-hub.example-tailnet.ts.net

auth:
  mode: tailscale_identity

security:
  session_idle_timeout: 12h
  csrf: true
  websocket_origin_check: strict
  default_role: none

artifacts:
  backend: local
  path: ~/.local/share/webspider/hub/artifacts

terminal:
  max_viewers_per_terminal: 10
  control_lease_ttl: 15s
  history_limit: 100000

files:
  max_text_preview_bytes: 2097152
  max_search_matches: 5000
  max_search_seconds: 10
  default_symlink_policy: contained_only
  default_mount_policy: allow_nested
```

Node config:

```yaml
node:
  name: gpu-box
  hub: https://webspider-hub.example-tailnet.ts.net
  state_dir: ~/.local/share/webspider/node
  runtime_dir: ~/.cache/webspider/runtime

terminal:
  tmux_socket: ~/.local/share/webspider/node/tmux/tmux.sock

filesystem:
  roots:
    - project: protein-pipeline
      path: /data/projects/protein-pipeline
      mode: read_write

resources:
  labels:
    gpu.vendor: nvidia
    gpu.vram_gb: "48"
```

---

# 25. Backend implementation stack

Recommended:

- Go 1.24+;
- `net/http` or a small HTTP router;
- a mature WebSocket implementation;
- Protocol Buffers for node transport;
- SQLite driver suitable for static distribution;
- `os.Root` for file confinement;
- Linux-specific `openat2` helper for strict mode;
- `os/exec`;
- PTY library;
- Tailscale LocalAPI/`tsnet` integration;
- zstd compression;
- OpenTelemetry-compatible tracing.

Avoid making Redis, Docker, Node.js, NATS, PostgreSQL, or Temporal mandatory for a normal installation.

---

# 26. Frontend implementation stack

Recommended:

- React;
- TypeScript;
- xterm.js;
- small query/cache layer;
- generated API types from OpenAPI/Protobuf where practical;
- `go:embed` for production assets;
- PWA manifest;
- optional service worker for cached shell/notifications;
- virtualized event/message lists for very long sessions.

No production CDN dependency for JavaScript/font assets.

---

# 27. Repository structure

```text
webspider-fabric/
  cmd/webspider/

  internal/
    hub/
      api/
      auth/
      registry/
      scheduler/
      mailbox/
      events/
      triggers/
      policy/
      artifacts/
      terminal/
      files/
      reconcile/
      audit/

    node/
      connector/
      supervisor/
      tmux/
      workspace/
      files/
      spool/
      secrets/
      resources/

    adapters/
      acp/
      native/
      pty/
      command/
      a2a/

    protocol/
    database/
    ids/
    logging/

  proto/

  web/
    src/
      pages/
      components/
      terminal/
      files/
      api/

  sdk/
    python/
    go/
    typescript/

  docs/
    architecture/
    security/
    adapters/
    operations/

  tests/
    integration/
    fault/
    security/
    filesystem/
```

---

# 28. State transitions and important algorithms

## 28.1 Agent wake algorithm

Pseudo-code:

```text
WakeAndDeliver(message, agent):
  lock agent dispatch lane

  if message already has terminal delivery receipt:
      return previous receipt

  if agent.node offline:
      keep queued
      return queued_offline

  switch agent.state:
    ready:
      dispatch

    busy:
      if message.wake_policy == interrupt:
        authorize interrupt
        cancel current turn
        await adapter readiness
        dispatch
      else:
        queue after active turn

    hibernated/stopped:
      if policy allows ensure_running:
        transition -> starting
        start/resume adapter
        await ready
        dispatch
      else:
        keep queued/fail according to policy

    starting:
      queue until ready

    waiting_permission/waiting_input:
      queue; preserve attention request

    failed:
      apply restart policy; otherwise fail

  persist all transitions/events
```

## 28.2 Task lease algorithm

Task attempt gets:

```text
lease_token
node_id
connection_epoch
lease_expiry
```

Node heartbeats renew lease.

On expiry:

- do not immediately run duplicate work if node merely disconnected;
- task enters `lease_uncertain` grace period for non-idempotent work;
- if retry policy permits safe retry, create a new attempt;
- old attempt completion after fencing is recorded as late/stale and requires reconciliation.

## 28.3 File open algorithm

```text
OpenWorkspaceFile(principal, agent, rootID, relativePath, operation):
  authorize principal -> agent/project -> operation
  fetch root metadata
  assert root belongs to agent and is active
  send command containing rootID + relativePath + operation to owning node

Node:
  look up preconfigured rootID locally
  verify command epoch/scope
  validate relativePath encoding and limits
  resolve/open through os.Root/openat2
  reject if path escapes root
  inspect opened object type
  verify operation policy
  return handle/metadata/stream
```

Never trust a canonicalized path string returned from the browser as proof of containment.

---

# 29. Notifications and attention model

Attention items are durable objects derived from events.

Types:

```text
permission_request
human_input_request
authentication_required
task_failure
agent_failure
node_offline
merge_conflict
terminal_input_ambiguous
policy_denial
storage_pressure
```

Fields:

```text
id
project_id
agent_instance_id
task_id
severity
summary
actions
created_at
resolved_at
```

The phone UI should optimize for resolving attention items quickly without opening full terminals.

---

# 30. Permissions and approval workflow

An ACP/native agent permission request becomes:

```text
PermissionRequest
  id
  agent_instance_id
  task_id
  requested_action
  arguments_summary
  risk_class
  adapter_request_handle
  expires_at
```

Policy can:

- automatically allow;
- automatically deny;
- require human approval;
- allow only for specific paths/tools.

Approval may come from:

- browser user;
- master agent only if policy allows agent approval;
- external approval integration later.

Audit records the decision actor.

---

# 31. Filesystem change observation

The Files tab should update when an agent produces outputs.

Node may use:

- Linux inotify;
- macOS FSEvents;
- periodic bounded scan fallback.

Events should be coalesced:

```text
filesystem.changed.v1
```

with root-relative paths.

Do not send every editor temporary-file mutation to the hub indefinitely. Use short debounce windows and a bounded path list; if too many changes occur, send a `root_dirty` event and let the browser refresh directory state on demand.

Filesystem watcher information is advisory. Security decisions still happen during the actual rooted file operation.

---

# 32. Artifact storage

Default local hub artifact backend:

```text
~/.local/share/webspider/hub/artifacts/<sha256-prefix>/<sha256>
```

Content-addressed storage prevents duplicate copies.

Metadata keeps original logical filename separately.

Optional later backends:

- S3-compatible object store;
- remote blob store;
- project-scoped external artifact repository.

Downloads are authorized against artifact metadata even though bytes are content-addressed.

---

# 33. Data retention

Independent retention policies for:

- structured conversations;
- audit events;
- terminal logs;
- artifacts;
- transient worktrees;
- node spool records.

Suggested defaults:

```text
conversation: keep
important audit: keep
terminal logs: 30 days
unpromoted terminal segments: 7 days
artifacts: keep or project configured
completed temporary worktrees: 7 days after successful merge/promotion
```

Deletion should be explicit and audited.

---

# 34. Observability

Metrics:

```text
webspider_nodes_online
webspider_agents_by_state
webspider_tasks_by_state
webspider_message_delivery_latency_seconds
webspider_node_reconnects_total
webspider_terminal_viewers
webspider_terminal_resyncs_total
webspider_file_download_bytes_total
webspider_file_access_denials_total
webspider_trigger_actions_total
webspider_outbox_pending
webspider_node_spool_bytes
```

Tracing:

- propagate W3C trace context through hub -> node -> adapter where possible;
- message `trace_id` remains an application-level correlation key independent of tracing vendor.

Logs:

- structured JSON optional;
- human-readable default for local installs;
- secret redaction;
- no file content in operational logs by default.

---

# 35. Backup and restore

`webspider backup` should produce a consistent bundle containing:

- hub SQLite online backup;
- configuration minus raw secrets;
- node/public identity metadata;
- artifact metadata;
- optionally artifact bytes depending on flag.

Example:

```bash
webspider backup --output webspider-backup-2026-08-24.tar.zst
```

Restore:

```bash
webspider restore <bundle>
```

Node-local secrets are not silently included in hub backups.

Nodes can be re-enrolled after hub disaster recovery.

---

# 36. API/transport versioning

- REST: `/api/v1` major version;
- events: `event.name.v1`;
- node protocol: negotiated version range;
- Protobuf: additive field evolution where possible;
- database migrations embedded and transactional;
- current node software plus previous compatible minor generation supported during rolling upgrades;
- adapter protocol versions independent from node transport versions.

---

# 37. Failure semantics

## 37.1 Browser disconnect

No impact on execution.

## 37.2 Terminal viewer overload

Drop/resync that viewer only.

## 37.3 Hub crash

Nodes continue current work; cross-node routing pauses; reconnect/replay later.

## 37.4 Node daemon crash

Private tmux sessions survive; restarted node daemon reconciles them.

## 37.5 Node OS reboot

Tmux/processes do not survive. Structured sessions resume only when underlying adapter/session mechanism supports it. Otherwise instance becomes stopped and thread remains available.

## 37.6 Worker network outage

Hub marks node offline after heartbeat threshold. Durable messages remain queued. Node spools local events.

## 37.7 Master-agent failure

Other tasks continue. Master is restarted/resumed according to profile. Its WebSpider thread/mailbox remain durable.

## 37.8 Database corruption

Hub refuses unsafe partial operation, surfaces critical state, and directs restore/integrity procedures. Maintain regular backups.

---

# 38. Security-sensitive UX labels

WebSpider should expose security state rather than hiding it.

Examples:

```text
Adapter: ACP (structured)
Message delivery: acknowledged
Agent filesystem isolation: container / workspace-only
Portal file access: workspace-only
Node connection: authenticated
Terminal: watched by 2 clients; controlled by Laptop
```

For weaker PTY agents:

```text
Adapter: PTY fallback
Prompt readiness: heuristic
Message delivery: best effort
Agent filesystem isolation: host user
Portal file access: workspace-only
```

---

# 39. Required tests

## 39.1 Persistence/fault tests

- close all browsers while agent is active;
- kill hub during long task;
- kill node daemon while tmux remains;
- restart node daemon and rediscover tmux;
- reboot node with ACP-resumable session;
- reboot node with non-resumable PTY session;
- disconnect node, queue ten messages, reconnect;
- duplicate every durable node command;
- delay/reorder acknowledgements;
- fill node spool to quota;
- interrupt artifact upload and resume;
- restart hub between message acceptance and node delivery.

## 39.2 Multi-device tests

- phone and laptop observe same structured conversation;
- phone and laptop attach same terminal;
- transfer terminal control;
- disconnect controller without releasing lease;
- attempt input from stale lease epoch;
- phone viewport does not resize desktop-controlled terminal;
- concurrent message sends from two devices;
- reconnect from old browser event cursor;
- simultaneous file downloads.

## 39.3 Filesystem confinement tests

Critical.

Attempt:

```text
../secret
../../../../etc/passwd
absolute paths
empty path edge cases
Unicode separators/normalization tricks
very long path components
symlink -> ../outside
symlink -> /etc/passwd
symlink chain escaping root
symlink race during stat/open
rename race
hard links
/proc/self/fd magic links when reachable
FIFO
Unix socket
device file
bind mount beneath root in strict mode
Windows reserved names in future native Windows build
```

Assertions:

- no request can read outside registered root;
- browser cannot cause node to select a different root via path content;
- download reads from opened handle, not path re-lookup;
- only regular files are downloadable by default;
- search results cannot escape root;
- Git helpers cannot accept external git-dir/work-tree paths;
- preview never executes arbitrary same-origin HTML/JS.

## 39.4 Web security tests

- malicious WebSocket Origin;
- CSRF against message/task mutation;
- forged Tailscale identity header through bypass path;
- expired login session;
- role/project authorization bypass;
- terminal OSC/title payload;
- malicious hyperlink terminal sequence;
- oversized frames;
- rate-limit abuse;
- raw artifact active-content execution.

## 39.5 Node auth tests

- consumed join token reuse;
- expired join token;
- replay signed handshake;
- revoked node key;
- stale connection epoch;
- cloned node state directory/key;
- connection replacement fencing.

## 39.6 Messaging tests

- busy-agent queue;
- wake hibernated agent;
- offline queue;
- duplicate message command;
- interrupt privilege denial;
- system-role spoof denial;
- completion-trigger deduplication;
- loop hop-limit;
- coalesced completion digest.

## 39.7 Adapter contract test suite

Every adapter:

```text
probe
start
ready
send
stream updates
busy queue
cancel
permission request
completion
stop
restart
resume or explicit non-resumable result
duplicate message handling
node disconnect/reconnect
```

---

# 40. Performance targets for v1

These are engineering targets, not hard public SLAs.

On a modest hub:

```text
100 connected nodes
500 registered agent instances
100 simultaneously active agents
100 terminal viewers
10,000,000 durable events in SQLite with indexed paging
```

Interactive goals on tailnet LAN/WAN:

```text
UI event propagation: typically < 250 ms + network latency
message acceptance: typically < 100 ms local DB path
terminal keystroke echo: dominated by network/PTY latency
file listing first page: typically < 500 ms for normal directories
```

Large terminal/file traffic must not starve durable command delivery.

Use stream priorities or separate bounded queues inside the multiplexed connection.

---

# 41. Quotas and resource limits

Per node:

```text
max concurrent agent processes
max concurrent tasks
max terminal attachments
max spool bytes
max terminal log bytes
max file streams
max artifact upload bandwidth
```

Per project:

```text
max active agents
max queued tasks
max trigger actions/hour
max artifact storage
max child-task depth
```

Per browser principal:

```text
max terminal viewers
max concurrent downloads
mutation rate limit
```

---

# 42. Scale-out path

Do not burden v1 with distributed infrastructure.

When single-hub limits become real:

## 42.1 PostgreSQL

Replace hub SQLite with PostgreSQL while preserving repository interfaces.

## 42.2 NATS JetStream

Use for durable node commands/events and cross-hub message distribution.

## 42.3 Connection owner

Each live node WebSocket belongs to one hub instance. Other hub instances route node-bound commands to the connection owner.

## 42.4 Object storage

Move artifacts and terminal segments to S3-compatible storage.

## 42.5 Workflow engine

Temporal can be an optional workflow backend for complex multi-day deterministic business workflows; it should not replace basic WebSpider task/mailbox semantics.

---

# 43. Delivery phases

## Phase A — distributed persistent terminal foundation

Implement:

- hub/node executable roles;
- Tailscale access;
- node enrollment;
- project bindings;
- private tmux server;
- browser terminal;
- terminal control lease;
- SQLite persistence;
- browser event bus;
- reconnect/reconciliation;
- initial project-root Files tab with safe list/stat/download.

Exit criteria:

- closing browser leaves task alive;
- hub restart does not kill node sessions;
- node-daemon restart rediscovers tmux;
- phone and laptop watch same terminal;
- only controller sends input;
- user can browse/download only the selected agent's registered root;
- traversal/symlink escape tests pass.

## Phase B — structured agents and durable messaging

Implement:

- threads/messages;
- ACP adapter;
- native SDK;
- PTY fallback;
- agent states;
- durable mailbox;
- wake/hibernate;
- permission handling;
- master MCP tools;
- provenance-aware injected messages;
- structured Conversation/Activity views;
- Files previews/search/Git status.

Exit criteria:

- offline queued message delivered after reconnect;
- hibernated structured agent resumes and consumes queue;
- busy agent receives follow-up only after current turn;
- duplicate ACP delivery does not create duplicate turn;
- master messages remote sub-agent;
- browser user clicks from master view into remote sub-agent and watches live interaction;
- browser can inject a follow-up into that same session.

## Phase C — tasks, triggers, artifacts

Implement:

- task DAG;
- scheduler;
- command wrapper;
- completion triggers;
- artifact store;
- Git worktrees;
- Attention inbox;
- loop/budget protection;
- artifact promotion directly from Files tab.

Exit criteria:

- long detached command completes durably;
- completion wakes master once;
- task result includes summary/status/artifacts;
- promoted file remains downloadable after worktree cleanup;
- agent-to-agent loops terminate under configured limits.

## Phase D — interoperability and stronger sandboxing

Implement:

- A2A gateway;
- AG-UI compatible projection if useful;
- OIDC provider support;
- container agent isolation;
- optional Linux namespace sandbox;
- PostgreSQL backend;
- optional NATS;
- signed update channel;
- browser push notifications.

---

# 44. Acceptance criteria for the complete product

A WebSpider release matching this specification is successful when the following end-to-end scenario works reliably:

1. User installs WebSpider hub on one machine.
2. User joins two more machines with one-time tokens.
3. User defines a project that exists on workstation and GPU box.
4. User launches a master spider.
5. Master delegates coding to an ACP agent on workstation and a benchmark to a command/native agent on GPU box.
6. User closes laptop browser.
7. All work continues.
8. User opens WebSpider from phone.
9. Master portal shows both remote tasks live.
10. User clicks the coding agent.
11. User sees structured conversation/tool events and may open its raw terminal.
12. User clicks Files and sees only the coding agent's project/worktree root.
13. Attempts to request `../../outside` are rejected server-side.
14. User previews a generated report and downloads it.
15. User injects a message: "also add an integration test".
16. Because the agent is busy, WebSpider queues it after the current turn.
17. GPU benchmark finishes while master is hibernated.
18. Node emits durable completion event.
19. Trigger creates one provenance-preserving user-role message for master and wakes it.
20. Master consumes the completion, reads the artifact, and decides next work.
21. User opens laptop later.
22. Same master thread, sub-agent threads, task timeline, artifacts, and filesystem outputs are present.
23. Laptop takes terminal control from phone without restarting any process.
24. Hub can be restarted and nodes reconnect/reconcile without losing task/message history.

---

# 45. Recommended v1 product definition

The first production-worthy WebSpider should consist of exactly the following conceptual pieces:

```text
One Go binary
One authoritative hub
Any number of outbound-connected nodes
SQLite on hub and nodes
React + xterm.js browser portal
Tailscale-native private access
ACP + native-agent structured adapters
PTY/tmux compatibility fallback
Durable threads/messages/tasks/events/approvals
Master-agent MCP tools
Completion-triggered wake-up
Per-agent session click-through
Live interaction watching
Human message injection
Per-agent root-confined file browser
Safe preview and download
Durable artifacts
Multi-device terminal watching
Single-controller terminal leases
Audit and explicit capabilities
```

The single most important principle is:

> **WebSpider manages durable intent and durable state; agent runtimes and terminals are replaceable execution adapters around that state.**

And the single most important filesystem principle is:

> **The user-facing file browser is capability-rooted by construction. No browser request, agent message, or manipulated URL can turn it into an arbitrary host filesystem browser.**

This architecture provides the desired `screen`-like persistence while also solving the harder distributed problems: durable cross-machine messages, wake-up, auditing, multi-device observation, safe session injection, structured tasks, and tightly scoped access to the outputs each agent creates.

---

# Appendix A — Example project configuration

```yaml
apiVersion: webspider/v1
kind: Project
metadata:
  name: protein-pipeline

spec:
  masterAgentProfile: master-codex

  bindings:
    - node: workstation
      path: /home/alice/src/protein-pipeline
      mode: existing

    - node: gpu-box
      path: /data/projects/protein-pipeline
      mode: existing
      labels:
        dataset.local: large-training-set

  filesystem:
    portal:
      allowPreview: true
      allowDownload: true
      allowSearch: true
      symlinkPolicy: contained_only
      mountPolicy: allow_nested

  limits:
    maxActiveAgents: 12
    maxChildTaskDepth: 6
    maxMessagesPerTrace: 100
```

---

# Appendix B — Example agent profile

```yaml
apiVersion: webspider/v1
kind: AgentProfile
metadata:
  name: backend-coder

spec:
  adapter: acp
  executable: codex-acp-adapter

  nodeSelector:
    all:
      - project_binding: protein-pipeline

  workspace:
    mode: git_worktree
    portalExpose: true

  filesystemIsolation:
    mode: worktree

  permissions:
    policy: coding-default

  idle:
    hibernateAfter: 15m

  restart:
    mode: on_failure
    maxAttempts: 3
```

---

# Appendix C — Example human-injected message request

```http
POST /api/v1/threads/thr_01/messages
Idempotency-Key: 94c38e08-0cc8-45ac-bdf3-f38ec054911f
Content-Type: application/json

{
  "parts": [
    {
      "type": "text",
      "text": "Also add an integration test for the new parser."
    }
  ],
  "delivery_role": "user",
  "wake_policy": "ensure_running",
  "busy_policy": "deliver_when_ready"
}
```

---

# Appendix D — Example filesystem request/response

Request:

```http
GET /api/v1/roots/awr_01/entries?path=results
```

Hub authorization conceptually resolves:

```text
principal -> project -> agent instance -> root ID -> operation:list
```

Node receives:

```json
{
  "command_id": "cmd_01...",
  "root_id": "awr_01...",
  "operation": "list",
  "relative_path": "results"
}
```

No absolute root path crosses the browser API.

---

# Appendix E — Example task completion event

```json
{
  "id": "evt_01...",
  "type": "task.completed.v1",
  "global_sequence": 129883,
  "actor": "node:gpu-box",
  "subject": "task:T-184",
  "trace_id": "tr_01...",
  "payload": {
    "project_id": "project-a",
    "task_id": "T-184",
    "agent_instance_id": "agent-benchmark-7",
    "result": {
      "status": "succeeded",
      "summary": "Benchmark completed.",
      "artifacts": ["art_92"]
    },
    "notify_master": true
  }
}
```

---

# Appendix F — Suggested error codes

```text
WS_AUTH_REQUIRED
WS_FORBIDDEN
WS_PROJECT_FORBIDDEN
WS_NODE_OFFLINE
WS_NODE_REVOKED
WS_AGENT_NOT_READY
WS_AGENT_NON_RESUMABLE
WS_AGENT_DELIVERY_UNCERTAIN
WS_TASK_CONFLICT
WS_TASK_LEASE_EXPIRED
WS_TERMINAL_LEASE_REQUIRED
WS_TERMINAL_LEASE_STALE
WS_TERMINAL_RESYNC_REQUIRED
WS_ROOT_NOT_FOUND
WS_ROOT_REVOKED
WS_PATH_INVALID
WS_PATH_ESCAPE_BLOCKED
WS_SYMLINK_BLOCKED
WS_SPECIAL_FILE_BLOCKED
WS_FILE_CHANGED
WS_FILE_TOO_LARGE_TO_PREVIEW
WS_SEARCH_LIMIT_EXCEEDED
WS_ARTIFACT_NOT_FOUND
WS_TRIGGER_LOOP_LIMIT
WS_RATE_LIMITED
```

---

# Appendix G — Research references

The implementation choices above are grounded in the following primary documentation current as of the document date:

1. Agent Client Protocol v1 overview
   https://agentclientprotocol.com/protocol/v1/overview

2. ACP compatible agents
   https://agentclientprotocol.com/get-started/agents

3. A2A latest specification
   https://a2a-protocol.org/latest/specification/

4. A2A key concepts / Agent Cards / async operations
   https://a2a-protocol.org/latest/topics/key-concepts/
   https://a2a-protocol.org/latest/topics/agent-discovery/

5. MCP 2026-07-28 release
   https://blog.modelcontextprotocol.io/posts/2026-07-28/

6. xterm.js security guidance
   https://xtermjs.org/docs/guides/security/

7. xterm.js flow control guidance
   https://xtermjs.org/docs/guides/flowcontrol/

8. Tailscale Serve
   https://tailscale.com/docs/features/tailscale-serve

9. Tailscale identity and tsnet
   https://tailscale.com/docs/concepts/tailscale-identity

10. Tailscale app capabilities
    https://tailscale.com/docs/features/access-control/grants/grants-app-capabilities

11. Tailscale tsidp
    https://tailscale.com/docs/features/tsidp

12. Go traversal-resistant `os.Root` API
    https://go.dev/blog/osroot
    https://pkg.go.dev/os#Root

13. Linux `openat2(2)` path-resolution controls
    https://www.man7.org/linux/man-pages/man2/openat2.2.html

---

# End of specification
