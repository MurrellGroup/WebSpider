# Implementation status

The current repository is an executable secure vertical slice, not a claim that every Phase D feature in the 4,000-line product specification has already shipped. This table identifies exact behavior so deployment decisions do not rely on ambiguous labels.

## Phase A — distributed persistent terminal foundation

| Capability | Status | Notes |
|---|---:|---|
| One-command installation | Complete for Linux/macOS x64/ARM64 releases | A tagged GitHub Actions matrix builds and clean-install-tests four native `.run` assets, each with its matching runtime embedded. The Release also contains a stable platform-selecting bootstrap and `SHA256SUMS`; users install without Node.js or a package manager. Generated binaries remain Release assets rather than source-controlled files. |
| Boot service | Complete for Linux/macOS user services | `systemd --user` with lingering on Linux and LaunchAgent on macOS; both use restart-on-failure semantics and the persisted workspace/state paths. |
| Hub and node roles | Complete | One CLI entry point; nodes connect outbound. |
| Node enrollment | Complete | Hashed one-time token, expiry, Ed25519 identity, replay window, epoch fencing. |
| Project and agent roots | Complete | Hub stores logical root metadata; node alone maps root IDs to host paths. |
| Detached terminal process | Complete with substitute | Native PTY bridge (`script` on Linux, `expect` on macOS) + FIFO + detached process group replaces tmux in this runtime. State/log/exit markers reconcile after daemon restart. |
| Machine-reboot agent recovery | Complete for PTY fallback reconstruction | Reconnected nodes send runtime inventory. Missing previously-running main or worker agents restart under their profile policy, receive the tail of the prior terminal log through `WEBSPIDER_RECOVERY_CONTEXT`, and receive one durable recovery message. Native third-party in-flight turns are reconstructed, not magically resumed. |
| Multi-view terminal | Complete | Bundled xterm.js ANSI/VT rendering, direct browser keyboard input, live/snapshot watch path, and one controller lease with stale-epoch rejection. |
| SQLite persistence | Complete | WAL, foreign keys, synchronous FULL, busy timeout, hub and node schemas. |
| Durable event replay | Complete | Global and scope sequences; replay-then-live WebSocket. |
| Root-safe files | Complete for implemented platform | List, stat, text preview, download, search, Git status; no absolute-path API. See security notes. |
| Tailscale | Deployment integration | Loopback default and documented Tailscale Serve setup; embedded `tsnet` is not included. |

## Phase B — structured agents and messaging

| Capability | Status | Notes |
|---|---:|---|
| Threads and immutable messages | Complete | Transactional acceptance, delivery row, event, idempotency, actor provenance, and delivery-time UTC/elapsed envelopes. |
| Offline queue and wake | Complete | Delivery remains queued while offline and drains on node-online; `ensure_running` wakes PTY agents. |
| PTY fallback | Complete | Delivery explicitly reports `best_effort` certainty. |
| Conversation/activity UI | Complete | Canonical agent deep link, transcript, event timeline, message injection. |
| Low-burden project steering | Complete for local vertical slice | Active conversation is the default landing surface; routine delivery and process controls use inferred defaults and progressive disclosure. |
| Role-aware project agreement | Complete for PTY/Codex launch boundary | System/project policy is snapshotted at every launch and compiled by role. Auto-detected Codex receives it through a managed global `AGENTS.md`; other PTY adapters receive policy paths in their environment. Main instructions cover orchestration; worker instructions preserve native harness behavior and carry only result-critical constraints. |
| Main-agent behavior control | Complete | Explicit-user-request-only project/system patches use short-lived scoped tokens, revision preconditions, mandatory reasons, audit records, and a materialized helper. Workers receive no token. |
| Session-context awareness | Complete as instruction behavior | The main agreement uses `/status` at natural breakpoints and permits explicit subagent observations without routine polling. |
| Weekly account allowance | Complete for observed PTY fallback data | `/status` is the percentage source; `/usage weekly` is optional activity. The main agent can persist read-only snapshots, which are timestamped, stale-marked, shown in the portal, and added to main-agent inbound envelopes. Direct structured App Server rate-limit reads are not yet bundled. |
| Human-only account controls | Complete as a hard authority boundary | The agent helper and API expose no reset, refresh, credit, billing, authentication, entitlement, or API-funding operation. Unknown control scopes are rejected. |
| Academic work-product defaults | Complete as central default policy | Scholarly integrity, terminology continuity, evidence/quantitative preservation, citation non-fabrication, and work-product-oriented defaults require no onboarding questionnaire. Venue-specific profiles and automated reference resolution remain future work. |
| Readable technical output | Complete with dependency-free renderer | Conversation, Markdown-family preview, and terminal reading mode support sanitized Markdown, tables, code, links, and a practical MathML subset. Raw terminal output remains available. |
| Safe previews/search/Git | Complete | Bounded UTF-8 previews, active-content denial, pure runtime search, fixed-argument Git invocation. |
| ACP adapter | Not yet implemented | Adapter boundary and data model are ready; no ACP subprocess client is bundled. |
| Native agent SDK | Not yet implemented | Environment fields are reserved, but the Unix-socket SDK is not bundled. |
| MCP server | Not yet implemented | REST operations cover the same objects; MCP tool exposure remains work. |
| Permission/elicitation round-trip | Schema/UI foundation | Attention schema and view exist; adapter request handles and response endpoints remain work. |

## Phase C — tasks, triggers, artifacts

| Capability | Status | Notes |
|---|---:|---|
| Detached command tasks | Complete | Attempts, leases/epochs, runtime events, logs, exit status, structured result. |
| Completion notification | Complete, fixed trigger | `notify_master` selects the project's main role and emits one idempotent provenance-preserving, timestamped master message. General CEL triggers are not included. |
| Artifact promotion | Complete | Root-safe open, SHA-256 content-addressed storage, metadata, audit, download. |
| Attention inbox | Foundation | Durable table and responsive panel; approval response workflows remain work. |
| Task DAG | Partial | Parent/child representation is present. Dependency sets and full cycle validation are not. |
| Git worktrees | Not yet implemented | Existing-workspace mode is implemented. |
| General scheduler | Partial | Online node/root/agent placement works for explicitly assigned command tasks; selectors and resource scoring are not. |

## Phase D

A2A, OIDC providers, container/namespace isolation, PostgreSQL, NATS, browser push, and signed updates are not part of this vertical slice.

## Runtime substitution

The product specification recommends a Go 1.24 binary with React and xterm.js. This workspace did not provide a Go toolchain, tmux, React, or xterm.js, and network-free reproducibility was prioritized. The implementation therefore uses:

- Node.js 24 built-in SQLite instead of Go + a bundled driver;
- a self-contained DOM application instead of React;
- a bundled xterm.js interactive terminal plus a sanitized Markdown/MathML reading view;
- native `script`/`expect` PTY bridges + detached process groups instead of tmux.

The API shapes, object identities, hub/node boundary, event semantics, node spool, lease model, and root-capability model follow the specification so these runtime substitutions can be replaced module by module.
