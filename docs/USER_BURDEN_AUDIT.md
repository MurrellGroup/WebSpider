# User-burden audit

## Product invariant

The user steers project outcomes. WebSpider and its agents own routine discovery, decomposition, implementation detail, validation, state tracking, and recovery. A user should not need to translate an academic goal into an orchestration specification before useful work begins.

The default behavior is therefore:

1. inspect available project state before asking;
2. infer conventional, reversible, low-risk details;
3. act and validate when the likely interpretation is safe;
4. ask only when the answer materially changes the result, expands authority, or supplies an unavailable essential input;
5. consolidate necessary questions and recommend one option;
6. preserve every inferred assumption in inspectable project/run metadata.

Hard safety and permission boundaries remain enforced by WebSpider. Reducing burden does not mean silently expanding authority.

A second invariant applies to delegation: central coordination must not become remote-agent micromanagement. Worker harnesses are already tuned for their environments. WebSpider communicates the objective and only the constraints that materially protect the requested result; it does not restate generic planning, tool-use, reporting, or style doctrine.

A third invariant applies to interaction topology: direct user-to-Sub-Spider project work and Master-managed portfolio work are both first-class. The user should not have to route ordinary project conversation through the Master. The Master becomes central when explicitly entrusted with unattended oversight, delegation, follow-up, cross-project coordination, exceptions, or integration. Routine direct worker status must not consume the Master context.

## Audit findings and corrections

| Surface | Previous burden | Correction |
| --- | --- | --- |
| Installation and local start | Required extraction, a separately installed runtime, a platform choice, and a foreground development command | Publish native tagged-release installers plus one platform-detecting, checksum-verifying bootstrap; record the workspace, install and enable the native user service, and start immediately |
| Reboot recovery | Durable records existed, but the user had to restart services and reconstruct a lost PTY agent manually | Reconcile node runtime inventory before dispatch, restart missing previously-running agents, attach bounded prior terminal context, and inject one durable continuation message |
| Local sign-in | Required copying a long owner token into the portal | Print a loopback-only fragment URL that exchanges the token and removes it before routing; retain manual entry as fallback |
| Project setup | Project record contained only a name and free-form labels | Create an academic-first working agreement automatically, with structured policy and human-readable rendering |
| Agent spawn | No durable record of the defaults an agent received | Resolve and persist an immutable policy snapshot for every launch |
| Codex instructions | Adapter-specific integration would be required | Compose existing global guidance with the project agreement in a private managed `CODEX_HOME/AGENTS.md` |
| Landing page | Opened on fabric operations or forced the Master | Open the most recently active agent terminal; keep the Master and operational overview one click away |
| Direct project work | Treated workers mainly as Master-controlled executors | Make every Sub-Spider a first-class persistent user interface with direct Terminal, durable Text box/Conversation messages, files, attachments, and project-local status |
| Master context | Every worker lifecycle report interrupted the Master | Persist worker status without a Master message by default; require explicit notification for delegated results, requested milestones, blockers, material risks, or actionable decisions |
| Project steering | Required navigating to an agent before expressing intent | Add a project-level outcome box that selects the active agent and safe delivery behavior automatically |
| Message delivery | Exposed four scheduling choices on every message | Use “next safe point” by default; move alternate delivery semantics under progressive disclosure |
| Agent controls | Wake and stop were equally prominent | Sending wakes automatically; show Resume only when needed and place Stop under agent actions |
| Navigation | Seven peer tabs competed for attention | Keep Conversation, Files, Terminal, and Artifacts primary; group operational detail under More |
| Empty conversation | Supplied no useful starting affordance | Explain outcome-level steering and offer three editable, non-destructive starting prompts |
| Technical output | Messages, Markdown files, and terminal math were plain text | Add a sanitized Markdown/MathML reading layer with raw/source toggles |
| Errors | Surfaced internal error codes without recovery meaning | Translate common runtime failures into state and recovery-oriented explanations |
| Policy transparency | Defaults risked becoming invisible prompt behavior | Add project agreement summaries, full rendered policy, revision numbers, agent snapshot IDs, and stale-policy status |
| Behavior changes | Required an owner to discover policy JSON and call an administrative API | Let the user ask the main agent in ordinary language; give that agent a scoped, audited helper and require an explicit-request reason |
| Remote-agent prompting | Copied the full central agreement into every delegated agent | Compile by role: comprehensive main-agent context, sparse worker constraints, native harness preserved |
| Configuration scope | One project policy could not express a reusable cross-project change | Layer independent system and project overrides with optimistic revisions |
| Session context | The main agent had no durable guidance to notice context pressure | Use `/status` lightly at natural breakpoints, including optional subagent observations |
| Weekly allowance | Raw token volume was conflated with the user's remaining weekly capacity | Persist the percentage actually reported by `/status`, timestamp it, mark it stale after two hours, and show it automatically in the portal and inbound envelopes |
| Account actions | Provider usage surfaces can colocate observation with reset or payment actions | Make all resets, token refreshes, credits, billing, plan, authentication, entitlement, and API-funding actions human-only; expose no agent command or endpoint for them |
| Time awareness | Queued and triggered messages did not tell the agent how much time had passed | Add source, UTC timestamp, and elapsed time to every delivered inbound envelope automatically |

## Shared default policy

Every project receives an effective policy even when the user provides only a workspace. Built-in defaults are overlaid first by system overrides and then by project overrides. The defaults cover:

- inspect-before-asking autonomy;
- safe reversible action;
- preservation of existing work;
- verification before completion claims;
- manuscript-ready scholarly work products;
- citation non-fabrication;
- preservation of scientific meaning, quantitative provenance, units, uncertainty, and terminology;
- sparse, task-relevant delegation and parent accountability;
- deference to each worker's native harness;
- explicit-request-only main-agent behavior control;
- separate session-context and read-only weekly-allowance awareness;
- a hard human-only boundary for all account-changing actions.

Customization is not part of the critical path. The user can ask the main agent to make a project-specific or system-wide change without specifying a JSON schema. The main agent inspects current values, makes the narrowest patch, supplies the user-request reason, and reports restart impact. Independent system and project revisions affect new launches; running sessions visibly become stale rather than silently changing mid-run.

Workers cannot edit policy. Their launch instructions deliberately exclude central orchestration doctrine and behavior-control details, while explicitly recognizing direct user instructions as normal authoritative project work.

## Progressive-disclosure rule

An option belongs in the default surface only when a user commonly needs it to express intent or resolve a current decision. Delivery timing, policy internals, process lifecycle operations, audit metadata, and raw terminal control remain available, but do not compete with the primary work. Behavior changes are expressed to the main agent as outcomes; WebSpider does not replace that natural-language path with an exhaustive settings form.

## Remaining audit items

The following require later structured-adapter or multi-user work and are not misrepresented as complete:

- automatic target-journal discovery and import of current author instructions;
- verified reference-library resolution and claim-to-source linking;
- document-section ownership, redlines, and multi-author review;
- one-action approval responses in the Attention inbox;
- automatic recovery recommendations derived from structured ACP failure events;
- role-aware defaults for teams rather than the current owner-only portal;
- measured usability testing across desktop and mobile academic workflows.

These should follow the same invariant: infer and recommend first, expose exhaustive configuration only when the user chooses to inspect or override it.
