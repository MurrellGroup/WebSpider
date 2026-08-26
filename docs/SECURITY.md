# Security model

## Protected boundaries

The implementation protects the following boundaries:

1. Browser users cannot select a host path. Every file request carries a hub-issued root ID and normalized relative path.
2. The hub checks that the root is active and authorized; the node independently looks up that root ID in local configuration.
3. Nodes authenticate with Ed25519 signatures. Timestamp/nonce replay checks and monotonically increasing epochs fence stale connections.
4. Durable commands are persisted at the node before execution and deduplicated by immutable command ID.
5. Browser mutations require an authenticated HttpOnly session and a matching CSRF token. WebSockets require the session plus an allowed Origin. Owner browser sessions use a long-lived sliding cookie and remain valid until explicit logout or server-side revocation; this deliberate single-owner usability tradeoff makes device security and tailnet confinement important.
6. Terminal input requires the current principal, lease ID, and lease epoch; another viewer cannot type or resize implicitly.
7. Actual message actors, requested model-facing roles, targets, and effects are separate fields in events and audit records.
8. Orchestration and behavior-control authority is issued only to a main-role agent. Its process-lifecycle token is accepted only by dedicated portfolio, visible-note-read, messaging, detached-task, policy, and usage-observation routes; policy writes require a matching scope, expected revision, and recorded user-request reason. Detached tasks require a registered target agent and one of that agent's registered roots.
9. A worker receives a distinct token for self status, self-owned detached tasks, self-owned hooks, and root-confined live file relay. The authenticated identity selects the status, task owner/root, reminder owner, and file source root. A worker task cannot target another agent; a worker hook can deliver only to that worker or the Master. File destination discovery exposes only bounded Spider metadata and does not grant peer message/task authority. A worker cannot inspect the portfolio, send arbitrary messages, or edit policy.
10. Account authority is deliberately absent. The allowlist contains only orchestration, detached-task, policy, self-status, and observation scopes; there is no route or helper action for token refreshes, rate-limit resets, credits, purchases, billing, plans, authentication, entitlements, or API-funded execution.
11. Note bodies are mode-`0600` plaintext files inside the hub's mode-`0700` state directory. Notes default to private. Only the owner can create, edit, delete, or change visibility; the main agent can read only notes explicitly marked visible, and worker tokens receive no note scope.
12. Agent document handoffs accept only bounded UTF-8 text with safe text/Markdown basenames. The hub records the digest and bytes in a durable target-specific message. The node writes only beneath a reserved `.webspider/inbox` directory in the target's registered root, rejects symlinked inbox components, verifies the checksum, uses an atomic mode-`0600` file, and treats matching retries as duplicates. Workers may target only the Master.
13. Quiet browser workspace uploads and agent-to-agent file relays use transfer IDs, normalized relative paths, bounded 8 MiB chunks, confirmed offsets, per-chunk SHA-256, a complete-file SHA-256, mode-`0600` temporary files, and atomic final rename. Browser uploads are owner/CSRF protected and do not notify the agent. Agent relay tokens can list only bounded destination metadata and can transfer only from their own registered root to an explicit Spider's registered root. The Hub holds one chunk in memory and does not persist chunk payloads in either command database. Both nodes must be online; no SSH or shared filesystem trust is assumed.

Loopback CLI starts print an optional quick-access URL with the owner token in the fragment. Fragments are not sent in HTTP requests; the portal removes it from the address bar before exchanging it for the normal HttpOnly session. Remote/public-base deployments print no quick-access link and retain manual token entry.

The self-installer writes only under the invoking user's configuration, data, executable, and application directories. Linux boot persistence uses `systemd --user` plus lingering; macOS uses a user LaunchAgent. Service definitions contain absolute executable, workspace, and state paths and never embed the owner token. Every platform-specific asset contains the native runtime that its filename declares and refuses to run on a different target. Tag builds run and smoke-test on the corresponding native GitHub-hosted runner. The small release bootstrap downloads only the matching versioned asset and executes it only after its SHA-256 digest matches that Release's `SHA256SUMS`.

## Rooted file algorithm

At registration, the node canonicalizes a trusted configured directory, opens it, and records its device/inode identity. Browser data never participates in that step.

For each operation the service:

1. rejects absolute paths, `.`/`..`, empty components, NULs, Windows separators, ambiguous Unicode separators, overlong paths, and overlong components;
2. walks metadata under the registered anchor and applies the configured symlink policy;
3. opens with `O_NOFOLLOW` in strict mode and directory/type flags where applicable;
4. checks the opened descriptor's target remains beneath the same pinned root identity;
5. verifies the opened object is a regular file before reading;
6. streams from the already-open descriptor, not a later path lookup.

On Linux with `/proc/self/fd`, the descriptor path itself is the anchor and validation target. In restricted environments without `/proc`, the fallback compares device/inode identity before and after open/list operations and rejects a deleted, renamed, or replaced root. The final Go distribution should replace this module with Go 1.24 `os.Root` plus `openat2` strict-mode flags, which provides the strongest race-resistant cross-platform contract specified by the product.

Directory listings may show symlink metadata, but a blocked target is not followed and only a basename-like target label is exposed. FIFOs, devices, sockets, and other special files are rejected before opening for content.

## Content safety

- Text preview is bounded and requires valid UTF-8 without NULs.
- HTML, SVG, and JavaScript are never returned through the preview API.
- Downloads are attachments with `nosniff` and a sandboxed content policy.
- Raw terminal bytes are handled by xterm. The separate Maths view reads xterm's parsed text buffer, assigns it through `textContent`, preserves terminal whitespace, and invokes a locally bundled MathJax only on recognized TeX delimiters; it never interprets terminal text as HTML or Markdown.
- Clipboard images are owner-only, capped at 8 MiB, restricted to PNG/JPEG/GIF/WebP, checked against file signatures and SHA-256 on both hub and node, and atomically written mode `0600` beneath the target workspace's symlink-confined `.webspider/uploads/` directory. SVG is intentionally rejected.
- Browser file attachments are owner-only, capped at four staged files and 8 MiB per file, checksum-verified on both hub and node, assigned an unguessable upload prefix, and atomically written mode `0600` beneath the selected agent workspace's symlink-confined `.webspider/uploads/` directory. Filenames are basename-only and bounded; uploaded bytes are never executed by the upload path.
- Files-tab workspace uploads are owner-only, CSRF-protected, chunked, capped at 64 GiB per file, and confined to the folder selected beneath the registered root. Stop/rename/overwrite conflict behavior is explicit. No message or agent wake is produced. A confirmed-offset metadata record lets the same live browser selection retry transient failures without trusting an unconfirmed partial tail.
- Inbound agent envelopes use hub-generated ISO UTC timestamps and elapsed durations. Display sources are flattened to one bounded line before delivery; stored user content is not rewritten.
- Conversation and Markdown-file rendering use the same dependency-free escaping pipeline; arbitrary HTML and image embedding are not supported.
- PDB/CIF previews fetch bytes through the existing authenticated, root-confined attachment route and parse/render them locally with a pinned, lazy-loaded Mol* library bundle. No structure bytes are sent to a CDN or hosted viewer, and the standard Mol* application UI is not exposed. Preview loading is capped at 64 MiB.
- Terminal titles, automatic links, clipboard control, and same-origin active file rendering are not implemented.

## Threat assumptions and limitations

- A root-compromised worker can read or forge that worker's data. WebSpider is not a boundary against the worker OS administrator.
- The portal file API is workspace-confined, but PTY agents currently run with the node user's host permissions. The Metadata tab labels this distinction.
- Automatically managed Codex profiles use noninteractive approval mode and `danger-full-access` unless the profile has explicit arguments. This avoids approval deadlocks and Linux user-namespace failures, but it is not an OS sandbox: enroll only machines and host-user accounts on which the main agent is authorized to execute work.
- WebSpider creates a private per-session Codex home containing the effective `AGENTS.md` and exports it into the persistent login shell. A manually launched `codex` therefore receives the project agreement and scoped control helper. Existing Codex configuration is linked from the same host-user account, excluding instruction, session, log, and temporary directories. This does not create a new OS permission boundary; Codex executes as that host user.
- A main agent receives its scoped control token in its process environment and node launch command. Hub and node state directories must remain private to their service account. The token remains valid across Hub reconnects while that exact managed agent instance is active, and is revoked on stop, exit, failure, role removal, project archival, or replacement wake. A host administrator can still inspect that host user's process environment and private state.
- Agent control tokens are denied on every ordinary authenticated route, and issuance rejects unknown scopes. Main tokens permit portfolio reads, explicitly visible note reads, policy changes, usage observations, a bounded agent inventory, provenance-preserving messages/document handoffs/live file relays, arbitrary detached commands within a registered target agent workspace, and one narrowly bounded `1`–`9` prompt-choice keystroke to a live Codex Sub-Spider. Prompt choice is main-only, restricted to the primary terminal, and fenced by the same exclusive lease as browser input; it creates no durable message and PTY prompt readiness remains best-effort. The task scope is intentionally powerful: the command runs with the target node user's host permissions, just like its PTY agent, and must be used only for user-authorized work. Worker task authority is equally powerful inside that worker's own registered root but cannot select any other agent or root. Worker reminders are owned by the authenticated worker and can address only itself or the Master; worker documents can target only the Master; worker file relay can read only its own registered root and write only a selected Spider's reserved inbox while both nodes are online. Completion and reminder hooks use durable user-role deliveries, stable idempotency keys, explicit task/reminder IDs, and bounded text; they do not grant general messaging authority. Neither token grants owner access or general project, note-write, arbitrary file-write, artifact, broad terminal, administrative, or account operations. `usage:write` means writing a timestamped observation record; it confers no provider-account mutation authority. Harness-native subagent threads inherit the parent runtime permission mode and may share its process environment; the compiled role-scope instruction forbids child-thread control use, but the PTY adapter cannot enforce a separate cryptographic identity for an internal harness thread.
- The current browser portal has one owner role. Schema boundaries support later project RBAC, but multi-user role bindings are not implemented.
- Tailscale Serve supplies private reachability; it does not replace WebSpider authentication or authorization.
- The detached PTY fallback (`script` on Linux and `expect` on macOS) reports best-effort semantic delivery. It cannot prove a third-party full-screen CLI is waiting at a prompt.
- Artifact downloads remain bounded to 64 MiB per current command. The dedicated chunked file-transfer path supports files up to 64 GiB; it requires both nodes online and does not yet provide offline blob storage.
- Raw provider secrets and ACP credentials are not managed because ACP/native adapters are not included in this slice.

## Test coverage

The built-in tests cover:

- traversal, absolute paths, Windows paths, Unicode separators, and normalization edge cases;
- internal and escaping symlinks under strict and contained policies;
- special-file blocking and active-preview denial;
- root deletion/replacement revocation;
- idempotent message acceptance;
- stale and competing terminal leases;
- one-time and expired node join tokens;
- SQLite reopen persistence;
- detached process exit/log/output behavior;
- unauthenticated API denial, CSRF enforcement, restrictive CSP;
- a real signed outbound node connection and end-to-end root file request.
- project-bound worker enrollment, multiple project roots on one signed node, persistent worker status reports, explicit master notification, and independent shell tabs;
- project-policy inference, inheritance, versioning, and launch snapshots;
- layered system/project overrides, revision-conflict rejection, main-only control tokens, route confinement, and revocation;
- role-specific sparse worker instructions, separate `/status` and `/usage weekly` awareness, observed weekly-allowance snapshots, and timestamped inbound envelopes;
- rejection of unknown agent-control scopes and absence of account-mutation routes;
- managed Codex `AGENTS.md` composition without modifying the project workspace;
- scoped cross-agent discovery/messaging with preserved actor provenance;
- restart-durable, self-owned reminders; bounded recurrence; cancellation; and self/master hook destinations;
- worker self-task confinement and task-completion user-role hook metadata;
- durable cross-node text-document handoffs, checksum/idempotency behavior, and symlinked-inbox rejection;
- standard per-user environment inheritance for agents/tasks and service PATH inclusion of the per-user binary directory;
- complete terminal control-key input, browser-to-PTY resizing, and Codex enhanced-keyboard translation;
- sanitized Markdown, safe-link handling, terminal escape removal, and MathML rendering.
- disk-backed note CRUD, private-by-default visibility, and main-only reads of explicitly visible notes;
- terminal text-box composition across terminals with and without bracketed-paste mode;
- persistent worker connection diagnostics and authenticated-online installer verification.
- protected project archive/restore, inactive-work guards, archived-project authority revocation, exact-name permanent metadata deletion, and preservation of workspace files.
