import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(repository, 'web', 'app.js'), 'utf8');
const page = fs.readFileSync(path.join(repository, 'web', 'index.html'), 'utf8');
const packageVersion = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')).version;

test('portal and hub version are synchronized and version skew is explicit', () => {
  const hub = fs.readFileSync(path.join(repository, 'src', 'hub', 'hub.js'), 'utf8');
  const selfUpdate = fs.readFileSync(path.join(repository, 'src', 'lib', 'self-update.js'), 'utf8');
  assert.match(app, new RegExp(`const PORTAL_VERSION = '${packageVersion.replaceAll('.', '\\.')}'`));
  assert.match(selfUpdate, new RegExp(`WEBSPIDER_VERSION = '${packageVersion.replaceAll('.', '\\.')}'`));
  assert.match(hub, /version: this\.version/);
  assert.match(app, /health\.version !== PORTAL_VERSION/);
  assert.match(app, /health\.portal_build.*PORTAL_BUILD/);
  assert.match(app, /location\.reload\(\)/);
  assert.match(app, /showVersionMismatch\(health\.version\)/);
  assert.match(app, /systemctl --user restart webspider\.service/);
});

test('Nodes exposes a Hub-last coordinated update with persistent owner rescue controls', () => {
  assert.match(app, /data-action="prepare-fleet-update"/);
  assert.match(app, /updates remote nodes first and the Hub last/i);
  assert.match(app, /data-action="override-fleet-blockers"/);
  assert.match(app, /Override \/ rescue/);
  assert.match(app, /data-action="stop-fleet-task"/);
  assert.match(app, /Stop task and continue/);
  assert.match(app, /data-action="allow-fleet-task"/);
  assert.match(app, /Keep task running and continue/);
  assert.match(app, /Only offline nodes remain/i);
  assert.match(app, /data-action="cancel-fleet-update"/);
  assert.match(app, /codex sessions in their registered project directories/i);
});

test('Master Spider navigation opens its terminal and portfolio is separate', () => {
  assert.match(page, /class="nav-master selected" data-action="master"/);
  assert.match(page, /<strong>Master Spider<\/strong><small>On-demand portfolio manager<\/small>/);
  assert.match(app, /if \(action === 'master'\).*openMasterTerminal\(\)/);
  assert.match(app, /if \(parts\[0\] === 'home'\) return openMasterTerminal\(\)/);
  assert.match(app, /orchestration_role === 'main'.*data-action="overview".*Portfolio/);
  assert.match(app, /history\.replaceState\(null, '', '#\/overview'\)/);
});

test('an unlinked portal session resumes the most recently active agent instead of forcing the Master', () => {
  assert.match(app, /const mostRecentAgent = state\.agents\.slice\(\)/);
  assert.match(app, /sort\(\(left, right\) => new Date\(right\.last_activity_at \|\| 0\)/);
  assert.match(app, /\|\| masterAgent\(\)/);
});

test('agent pages expose compact editable custom instructions', () => {
  assert.match(app, /const primary = \['terminal', 'instructions'/);
  assert.match(app, /id="agent-instructions-form"/);
  assert.match(app, /Custom instructions/);
  assert.match(app, /Keep this short; trust the agent’s judgment/);
  assert.match(app, /\/api\/v1\/agent-instances\/\$\{encodeURIComponent\(agentId\)\}\/instructions/);
  assert.match(app, /Save & restart/);
  assert.match(app, /Full instruction preview/);
  assert.match(app, /Instructions unchanged/);
});

test('Codex agents expose existing-session adoption with registered-root wording', () => {
  assert.match(app, /data-action="adopt-codex-session"/);
  assert.match(app, /id="codex-session-form"/);
  assert.match(app, /latest Codex session for this project/);
  assert.match(app, /registered project directory/);
  assert.match(app, /:resume-codex/);
  assert.match(app, /codex-session.*method: 'DELETE'/s);
});

test('one browser editor manages Sub-Spider-only instructions without changing the Master', () => {
  assert.match(page, /data-action="show-worker-instructions"/);
  assert.match(app, /id="worker-instructions-form"/);
  assert.match(app, /Sub-Spider-only instructions; the Master Spider does not inherit this text/);
  assert.match(app, /requested_instructions: \{ workers: instructions \}/);
  assert.match(app, /orchestration_role !== 'main'/);
  assert.match(app, /Save & restart workers/);
  assert.match(app, /if \(parts\[0\] === 'sub-spider-instructions'\) return renderWorkerInstructions\(\)/);
});

test('project onboarding uses the current hub route', () => {
  assert.match(page, /data-action="onboard-project" title="Add project"/);
  assert.match(app, /if \(action === 'onboard-project'\) return showProjectOnboarding\(\)/);
  assert.match(app, /api\('\/api\/v1\/projects\/onboard'/);
});

test('project pages present the Sub-Spider as a direct first-class interaction target', () => {
  assert.match(app, /Open \$\{primaryAgent\.orchestration_role === 'main' \? 'Master' : 'Sub-Spider'\}/);
  assert.match(app, /Direct to \$\{h\(primaryAgent\.title \|\| 'agent'\)\}/);
  assert.match(app, /<h2>Project defaults<\/h2>/);
  assert.match(app, /View the Master agreement/);
  assert.match(app, /View the Sub-Spider agreement/);
  assert.match(app, /policy\.rendered_worker_instructions/);
});

test('mobile navigation keeps project actions available and More opens the navigation drawer', () => {
  const styles = fs.readFileSync(path.join(repository, 'web', 'styles.css'), 'utf8');
  assert.doesNotMatch(styles, /header-actions button:not\(\.mobile-primary\).*display: none/);
  assert.doesNotMatch(styles, /header-actions \.action-menu.*display: none/);
  assert.match(app, /if \(action === 'show-more'\).*openMobileSidebar/s);
  assert.match(app, /function closeMobileSidebar\(\)/);
  assert.match(app, /function openMobileSidebar\(/);
  assert.match(page, /data-action="close-mobile-agents"/);
  assert.match(page, /data-action="mobile-agents" aria-controls="agent-navigation" aria-expanded="false"/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.sidebar \{[^}]*position: fixed;[^}]*inset: 0;[^}]*height: 100dvh;/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.sidebar \.project-tree \{[^}]*overflow-y: auto;/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.main-view \{[^}]*height: calc\(100dvh[^}]*overflow-y: auto;/);
});

test('archived projects have a dedicated restore and guarded-delete view', () => {
  assert.match(page, /data-action="show-archived"/);
  assert.match(app, /api\('\/api\/v1\/projects\?archived=only'/);
  assert.match(app, /if \(parts\[0\] === 'archived'\) return renderArchivedProjects\(\)/);
  assert.match(app, /data-action="archive-project"/);
  assert.match(app, /data-action="restore-project"/);
  assert.match(app, /data-action="delete-project"/);
  assert.match(app, /Type the project name to confirm/);
  assert.match(app, /Workspace files will not be touched/);
});

test('worker command copy supports plain HTTP without the Clipboard API', () => {
  assert.match(app, /navigator\.clipboard\?\.writeText/);
  assert.match(app, /control\.select\(\)/);
  assert.match(app, /document\.execCommand\('copy'\)/);
  assert.match(app, /Command selected; press Ctrl\/Cmd\+C to copy it\./);
});

test('login preserves the useful authentication error returned by the hub', () => {
  assert.match(app, /response\.status === 401[\s\S]*value\?\.error\?\.message \|\| 'Authentication required'/);
  assert.match(app, /code: value\?\.error\?\.code/);
});

test('PDB and CIF files use a lazy local Mol* preview with compact chain controls', () => {
  const styles = fs.readFileSync(path.join(repository, 'web', 'styles.css'), 'utf8');
  const source = fs.readFileSync(path.join(repository, 'scripts', 'molstar-preview-entry.js'), 'utf8');
  const vendor = fs.statSync(path.join(repository, 'web', 'vendor', 'molstar-preview.mjs'));
  assert.match(app, /pdb\|cif\|mmcif/);
  assert.match(app, /import\('\.\/vendor\/molstar-preview\.mjs'\)/);
  assert.match(app, /\/download\?path=/);
  assert.match(app, /closeStructurePreview\(\)/);
  assert.match(source, /new PluginContext\(\{ actions: \[\], behaviors: \[\], animations: \[\] \}\)/);
  assert.match(source, /All \(\$\{chains\.length\}\)/);
  assert.match(source, /Distinct chains/);
  assert.match(source, /\['cartoon', 'Cartoon'\].*\['surface', 'Surface'\].*\['sidechain', 'Side chains'\]/s);
  assert.match(source, /label_asym_id/);
  assert.match(source, /StructureSelectionQueries\.sidechainWithTrace/);
  assert.match(source, /colorInput\.addEventListener\('change'/);
  assert.match(styles, /\.structure-controls/);
  assert(vendor.size > 100_000 && vendor.size < 4_000_000);
});

test('note editor clicks do not reopen the note and discard the active draft', () => {
  assert.match(app, /event\.target\.closest\('\.note-row\[data-note-id\]'\)/);
  assert.doesNotMatch(app, /event\.target\.closest\('\[data-note-id\]'\)/);
  assert.match(app, /Creating note…/);
});

test('project navigation does not intercept controls inside project forms', () => {
  assert.match(app, /closest\('\.project-heading\[data-project-id\], \.portfolio-row\[data-project-id\]'\)/);
  assert.doesNotMatch(app, /closest\('\[data-project-id\]:not\(\[data-action\]\)'\)/);
});

test('terminal pages begin in watch mode and acquire control only on interaction', () => {
  const hub = fs.readFileSync(path.join(repository, 'src', 'hub', 'hub.js'), 'utf8');
  const terminalInput = fs.readFileSync(path.join(repository, 'web', 'terminal-input.js'), 'utf8');
  assert.match(app, /interactive \? 'Take control' : 'Not running'/);
  assert.doesNotMatch(app, /frame\.type === 'ATTACHED'.*LEASE_REQUEST/);
  assert.match(app, /function requestTerminalLease\(\)/);
  assert.match(app, /if \(terminalInputMode\).*requestTerminalLease\(\)/s);
  assert.match(app, /function handleTerminalData\(data\)[\s\S]*enqueueTerminalData/);
  assert.match(terminalInput, /if \(!controlled && !requestPending\) requestControl\?\.\(\);[\s\S]*enqueue\?\.\(data\)/);
  assert.match(app, /const input = directKeyInput\(event,[\s\S]*event\.preventDefault\(\);[\s\S]*handleTerminalData\(input\)/);
  assert.match(app, /clipboardCopyShortcut\(event, state\.terminalEmulator\?\.hasSelection\(\)\)[\s\S]*return false/);
  assert.match(app, /terminal\?\.kind === 'primary_agent' && state\.selectedAgent\?\.codex_capable/);
  assert.match(app, /frame\.type === 'ATTACHED' && frame\.keyboard_protocol === 'kitty'/);
  assert.match(hub, /keyboard_protocol: terminal\.kind === 'primary_agent' && terminalAgent\?\.codex_capable \? 'kitty' : null/);
  assert.match(app, /socket\.addEventListener\('open',[\s\S]*terminalPendingInput\.length[\s\S]*requestTerminalLease\(\)/);
  assert.match(app, /addEventListener\('pointerdown', requestTerminalLease\)/);
  assert.match(app, /emulator\.onData\(handleTerminalData\)/);
  assert.match(app, /frame\.type === 'OUTPUT'\) queueTerminalOutput\(frame\)/);
  assert.match(app, /frame\.type === 'RESYNC_REQUIRED'\) void resyncTerminalOutput\(\)/);
  assert.match(app, /reconcileTerminalOutput\(state\.terminalSequence/);
  assert.match(app, /terminalSnapshotReady \|\| state\.terminalResyncing/);
  assert.match(hub, /node\.online\.v1'[\s\S]*RESYNC_REQUIRED/);
  assert.doesNotMatch(app, /emulator\.onData\(queueTerminalInput\)/);
  assert.doesNotMatch(app, /if \(state\.terminalInputMode === 'direct'\) emulator\.focus\(\)/);
  assert.match(hub, /connection\.on\('close'.*releaseTerminalLease/s);
  assert.match(hub, /new TerminalInputPipeline/);
  assert.doesNotMatch(hub, /let terminalQueue = Promise\.resolve/);
  assert.match(hub, /frame\.type === 'HEARTBEAT'[\s\S]*HEARTBEAT_ACK[\s\S]*frame\.type === 'RESIZE'/);
});

test('every non-primary terminal tab has an explicit close control', () => {
  assert.match(app, /class="terminal-tab-close"/);
  assert.match(app, /aria-label="Close .* terminal tab"/);
  assert.match(app, /method: 'DELETE'/);
  assert.match(app, /Terminal tab closed\./);
  assert.match(app, /item\.kind === 'primary_agent' \|\| item\.state !== 'exited'/);
  assert.match(app, /item\.kind !== 'primary_agent'/);
  assert.match(app, /Dismiss task terminal; the task keeps running/);
  assert.match(app, /async function renderTerminal\(agent\) \{\s*closeTerminal\(\)/);
});

test('terminal display has an explicit deep refresh and repairs its layout after window changes', () => {
  assert.match(app, /data-action="refresh-terminal"[^>]*aria-label="Refresh terminal display"/);
  assert.match(app, /async function refreshTerminalDisplay\(\)/);
  assert.match(app, /resyncTerminalOutput\(\{ reportFailure: false \}\)/);
  assert.match(app, /action === 'refresh-terminal'[\s\S]*actionTarget\.textContent = 'Refreshing…'/);
  assert.match(app, /Terminal display rebuilt/);
  assert.match(app, /function refreshTerminalLayout\(\{ syncPty = false \} = \{\}\)/);
  assert.match(app, /fitTerminal\(\{ redraw: true, syncPty \}\)/);
  assert.match(app, /emulator\.refresh\(0, emulator\.rows - 1\)/);
  assert.match(app, /changed \|\| syncPty/);
  assert.match(app, /window\.addEventListener\('focus', \(\) => refreshTerminalLayout\(\)\)/);
  assert.match(app, /window\.addEventListener\('resize', \(\) => refreshTerminalLayout\(\)\)/);
  assert.match(app, /document\.addEventListener\('visibilitychange'/);
  assert.match(app, /terminalResizeObserver = new ResizeObserver/);
});

test('Maths mode preserves the xterm transcript and typesets only equations', () => {
  const styles = fs.readFileSync(path.join(repository, 'web', 'styles.css'), 'utf8');
  assert.match(app, /data-terminal-view="maths">Maths/);
  assert.doesNotMatch(app, /data-terminal-view="reading">Readable/);
  assert.match(app, /terminalBufferText\(buffer\)/);
  assert.match(app, /prepareTerminalMaths\(transcript\)/);
  assert.match(app, /MathJax\?\.typesetPromise/);
  assert.match(styles, /terminal-maths-transcript.*white-space: pre-wrap/);
  assert.doesNotMatch(styles, /data-view="reading"/);
});

test('pasting a clipboard image stages it and Enter uploads it to the agent workspace', () => {
  assert.match(app, /addEventListener\('paste'/);
  assert.match(app, /stagePastedTerminalImages\(images\);\n\}, true\);/);
  assert.match(app, /item\.type\.startsWith\('image\/'\)/);
  assert.match(app, /terminalAttachmentCommitKey\(event, currentTerminalAttachmentCount\(\) > 0, terminalKeyState\)/);
  assert.match(app, /void sendStagedTerminalAttachments\(\)/);
  assert.match(app, /Ready · press Enter to upload and send/);
  assert.match(app, /URL\.createObjectURL\(file\)/);
  assert.match(app, /class="terminal-image-previews"/);
  assert.match(app, /\/api\/v1\/agent-instances\/\$\{encodeURIComponent\(entry\.agentId\)\}\/uploads/);
  assert.match(app, /data_base64: bytesToBase64\(bytes\)/);
  assert.match(app, /Image sent to the agent/);
});

test('browser file attachments stage for the selected agent and send only on plain Enter', () => {
  assert.match(app, /data-action="choose-terminal-files"/);
  assert.match(app, /id="terminal-file-input"[^>]*type="file"[^>]*multiple/);
  assert.match(app, /stageAttachedTerminalFiles/);
  assert.match(app, /\/file-uploads/);
  assert.match(app, /File sent to the agent/);
  assert.match(app, /terminalComposeEnterAction\(event, terminalKeyState\)/);
  assert.match(app, /if \(hasAttachments && !await sendStagedTerminalAttachments\(\)\) return/);
});

test('Files tab uploads into the open folder without messaging the agent', () => {
  assert.match(app, /id="workspace-file-input"[^>]*type="file"[^>]*multiple/);
  assert.match(app, /data-action="choose-workspace-files"/);
  assert.match(app, /Upload into workspace/);
  assert.match(app, /This does not message, wake, or otherwise notify the agent/);
  assert.match(app, /Keep both \(recommended\)/);
  assert.match(app, /Replace the existing file/);
  assert.match(app, /\/file-transfers/);
  assert.match(app, /received_bytes/);
  assert.match(app, /retryWorkspaceUploadRequest/);
  assert.match(app, /uploaded without messaging the agent/);
});

test('every primary agent Text box is described and delivered as a direct durable message', () => {
  assert.match(app, /terminal\.kind === 'primary_agent'[\s\S]*Draft a durable message directly to/);
  assert.match(app, /if \(terminal\?\.kind === 'primary_agent'\)/);
  assert.match(app, /state\.selectedAgent\.active_thread_id/);
});

test('Text box drafts persist independently across agent and terminal navigation', () => {
  assert.match(app, /terminalDrafts: loadTerminalDrafts\(\)/);
  assert.match(app, /saveTerminalDraft\(state\.terminalDrafts, event\.target\.dataset\.terminalId, event\.target\.value\)/);
  assert.match(app, /terminalDraft\(state\.terminalDrafts, terminal\.id\)/);
  assert.match(app, /clearTerminalDraft\(state\.terminalDrafts, terminal\.id\)/);
});

test('file browser can reveal hidden workspace files explicitly', () => {
  assert.match(app, /fileShowHidden: false/);
  assert.match(app, /hidden=\$\{state\.fileShowHidden\}/);
  assert.match(app, /data-action="toggle-hidden-files"/);
  assert.match(app, /Show hidden/);
});

test('file viewer renders safe inline image, SVG, and PDF previews', () => {
  const styles = fs.readFileSync(path.join(repository, 'web', 'styles.css'), 'utf8');
  assert.match(app, /\(\?:png\|jpe\?g\|gif\|webp\|svg\)/);
  assert.match(app, /media-preview\?path=/);
  assert.match(app, /document\.createElement\('img'\)/);
  assert.match(app, /document\.createElement\('iframe'\)/);
  assert.match(styles, /\.image-preview/);
  assert.match(styles, /\.document-preview/);
});
