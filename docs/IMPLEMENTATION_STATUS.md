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
| Detached terminal process | Complete with substitute | Native PTY bridge + FIFO + detached process group replaces tmux in this runtime. State/log/exit markers reconcile after daemon restart; host boot IDs and process-start identities fence PID reuse. |
| Machine-reboot agent recovery | Complete for Codex session resume + PTY reconstruction | Reconnected nodes send runtime inventory. Missing previously-running Codex agents resume the latest session in their per-agent managed Codex home and registered root; every replacement also receives the bounded terminal tail and one durable recovery message. An interrupted turn can still require reconciliation. |
| Coordinated fleet update | Complete for official per-user releases | Durable per-agent readiness replaces stale status inference. Persistent owner rescue controls audit missing-acknowledgement overrides and per-command stop/continue decisions; only offline machines remain non-overridable. Remote nodes update first, the Hub last, versions are verified on reconnect, and previously-running Codex sessions resume in registered roots. |
| Existing Codex session adoption | Complete | The owner can select the latest cwd-scoped user session or provide a UUID/name. Node-side launch adds `codex resume -C <registered-root>` and an isolated instruction home references the workstation user's session store; no arbitrary host path crosses the Hub API. |
| Multi-view terminal | Complete | Bundled xterm.js ANSI/VT rendering, direct browser keyboard input, Codex/Kitty enhanced-key translation, browser-to-PTY resize propagation, live/snapshot watch path, and one controller lease with stale-epoch rejection. |
| Screen-like terminal tabs | Complete | Every agent has one addressable primary Codex terminal plus independently named login-shell tabs for monitoring and ad hoc commands. Auxiliary shells never receive orchestration messages. |
| SQLite persistence | Complete | WAL, foreign keys, synchronous FULL, busy timeout, hub and node schemas. |
| Durable event replay | Complete | Global and scope sequences; replay-then-live WebSocket. |
| Root-safe files | Complete for implemented platform | List, stat, text preview, isolated inline PNG/JPEG/GIF/WebP/SVG/PDF preview, lazy local Mol* PDB/CIF preview with per-chain controls, download, search, Git status; no absolute-path API. See security notes. |
| Tailscale | Deployment integration | Loopback default and documented Tailscale Serve setup; embedded `tsnet` is not included. |

## Phase B — structured agents and messaging

| Capability | Status | Notes |
|---|---:|---|
| Threads and immutable messages | Complete | Transactional acceptance, delivery row, event, idempotency, actor provenance, and delivery-time UTC/elapsed envelopes. |
| Offline queue and wake | Complete | Delivery remains queued while offline and drains on node-online; `ensure_running` wakes PTY agents. |
| PTY fallback | Complete | Delivery explicitly reports `best_effort` certainty. |
| Conversation/activity UI | Complete | Canonical agent deep link, transcript, event timeline, message injection. |
| Direct Sub-Spider interaction | Complete across registered nodes | Direct project work is a first-class normal mode. The selected Sub-Spider opens on its persistent terminal; its primary Text box and Conversation tab create durable messages directly to that agent without routing through the Master. |
| Role-aware project agreement | Complete for PTY/Codex launch boundary | System/project policy is snapshotted at every launch and compiled by role. Sub-Spiders are told that direct user work is authoritative and local; the Master is told to become central only for explicitly engaged unattended or cross-project management. |
| Portfolio orchestration | Complete | The on-demand Master helper lists projects and durable worker state, discovers registered agents, and sends durable provenance-preserving instructions with queue/wake semantics. Worker reports update portfolio status locally and notify the Master only by explicit opt-in. |
| Numbered prompt answers | Complete for Codex PTY agents | The Master can send one bare `1`–`9` choice to a visibly waiting Sub-Spider prompt without creating a wrapped message. Browser/Master input is lease-fenced and delivery is explicitly best-effort. |
| Scoped agent control | Complete | Main tokens support portfolio orchestration, explicit-request policy changes, and usage observations. Worker tokens support only `status:write:self`; they cannot inspect or command the fabric. |
| Hub notes | Complete | Plaintext files live under private hub state. Notes default to owner-only; the main agent may read only explicitly visible notes and workers have no notes scope. |
| Terminal composer | Complete | Direct xterm input remains available. On every primary Master or Sub-Spider terminal, the Text box sends a durable message to that selected agent; on auxiliary shells it observes bracketed-paste mode before sending to the PTY. Enter sends and Shift+Enter inserts a newline. Unsent drafts are terminal-scoped and survive navigation/reload in the current browser tab. |
| Clipboard image handoff | Complete | Keyboard/context-menu paste stages visibly; Enter writes a private checksum-verified workspace copy and durably tells the owning agent its local path. PNG/JPEG/GIF/WebP are capped at 8 MiB. |
| Browser file attachment | Complete | Attach file stages up to four files for the selected Master or Sub-Spider; nothing uploads before Enter. Private checksum-verified copies are written under that agent's registered root and announced directly to it. |
| Quiet workspace upload | Complete | Files-tab uploads stream up to 64 GiB into the open registered-root folder with explicit conflict handling and confirmed-offset retry. They do not message or wake the agent. |
| Agent-to-agent file relay | Complete for live online nodes | Master and Sub-Spiders can discover scoped destinations and relay large/binary files without SSH. The Hub forwards bounded transient chunks; nodes verify chunk/full hashes and atomically publish under the destination inbox. Offline blob queuing is intentionally not included. |
| Worker online verification | Complete | Node services persist connection state and installers require an authenticated hub acknowledgement before reporting success. The Hub's built-in local identity is isolated from an enrolled same-machine worker so restarts cannot make the two daemons displace each other. |
| Session-context awareness | Complete as instruction behavior | The main agreement uses `/status` at natural breakpoints and permits explicit subagent observations without routine polling. |
| Weekly account allowance | Complete for observed PTY fallback data | `/status` is the percentage source; `/usage weekly` is optional activity. The main agent can persist read-only snapshots, which are timestamped, stale-marked, shown in the portal, and added to main-agent inbound envelopes. Direct structured App Server rate-limit reads are not yet bundled. |
| Human-only account controls | Complete as a hard authority boundary | The agent helper and API expose no reset, refresh, credit, billing, authentication, entitlement, or API-funding operation. Unknown control scopes are rejected. |
| Academic work-product defaults | Complete as shared default policy | Scholarly integrity, terminology continuity, evidence/quantitative preservation, citation non-fabrication, and work-product-oriented defaults require no onboarding questionnaire. Venue-specific profiles and automated reference resolution remain future work. |
| Technical output and Maths mode | Complete | Conversation and Markdown previews use the dependency-free sanitized renderer. Terminal Maths mode preserves xterm's parsed transcript layout while locally bundled MathJax typesets recognized TeX equations; the raw terminal remains available. |
| Safe previews/search/Git | Complete | Bounded UTF-8 previews, active-content denial, pure runtime search, fixed-argument Git invocation. |
| ACP adapter | Not yet implemented | Adapter boundary and data model are ready; no ACP subprocess client is bundled. |
| Native agent SDK | Not yet implemented | Environment fields are reserved, but the Unix-socket SDK is not bundled. |
| MCP server | Not yet implemented | REST operations cover the same objects; MCP tool exposure remains work. |
| Permission/elicitation round-trip | Schema/UI foundation | Attention schema and view exist; adapter request handles and response endpoints remain work. |

## Phase C — tasks, triggers, artifacts

| Capability | Status | Notes |
|---|---:|---|
| Detached command tasks | Complete | Attempts, leases/epochs, runtime events, logs, exit status, structured result. |
| Completion notification | Complete, fixed trigger | A Sub-Spider task defaults to a self hook and a Master task defaults to a Master hook; explicit `self`, `master`, or `none` targeting emits one idempotent provenance-preserving message when requested. General CEL triggers are not included. |
| Artifact promotion | Complete | Root-safe open, SHA-256 content-addressed storage, metadata, audit, download. |
| Attention inbox | Foundation | Durable table and responsive panel; approval response workflows remain work. |
| Task DAG | Partial | Parent/child representation is present. Dependency sets and full cycle validation are not. |
| Git worktrees | Not yet implemented | Existing-workspace mode is implemented. |
| General scheduler | Partial | Online node/root/agent placement works for explicitly assigned command tasks; selectors and resource scoring are not. |

## Phase D

A2A, OIDC providers, container/namespace isolation, PostgreSQL, NATS, browser push, and cryptographically signed release manifests are not part of this vertical slice. Fleet updates use HTTPS plus the official release's published SHA-256 asset list.

## Runtime substitution

The product specification recommends a Go 1.24 binary with React and xterm.js. This workspace did not provide a Go toolchain, tmux, React, or xterm.js, and network-free reproducibility was prioritized. The implementation therefore uses:

- Node.js 24 built-in SQLite instead of Go + a bundled driver;
- a self-contained DOM application instead of React;
- a bundled xterm.js interactive terminal plus a sanitized Markdown/MathML reading view;
- native `script`/`expect` PTY bridges + detached process groups instead of tmux.

The API shapes, object identities, hub/node boundary, event semantics, node spool, lease model, and root-capability model follow the specification so these runtime substitutions can be replaced module by module.
