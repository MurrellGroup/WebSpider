import { renderMarkdown } from './markdown.js';
import { randomIdentifier } from './random.js';
import { prepareTerminalMaths, terminalBufferText } from './terminal-maths.js';
import { directKeyInput, enqueueTerminalData, kittySequence } from './terminal-input.js';
import { Terminal } from './vendor/xterm.mjs';
import { FitAddon } from './vendor/addon-fit.mjs';

const PORTAL_VERSION = '0.6.5';
const PORTAL_BUILD = document.querySelector('meta[name="webspider-portal-build"]')?.content || '';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  session: null,
  summary: {},
  projects: [],
  archivedProjects: [],
  agents: [],
  archivedAgents: [],
  nodes: [],
  tasks: [],
  attention: [],
  notes: [],
  selectedNoteId: null,
  selectedProject: null,
  selectedAgent: null,
  terminals: [],
  selectedTerminalId: null,
  tab: 'terminal',
  eventSocket: null,
  terminalSocket: null,
  terminalLease: null,
  terminalLeaseRequested: false,
  terminalSequence: 0,
  terminalHeartbeat: null,
  terminalEmulator: null,
  terminalFitAddon: null,
  terminalInputSubscription: null,
  terminalResizeObserver: null,
  terminalDimensions: null,
  terminalKeyboardProtocol: false,
  terminalBracketedPaste: false,
  terminalProtocolTail: '',
  terminalPendingInput: [],
  terminalInputBuffer: '',
  terminalInputTimer: null,
  terminalInputSequence: 0,
  terminalInputAcknowledged: 0,
  terminalCompositionTimer: null,
  terminalText: '',
  terminalView: localStorage.getItem('webspider_terminal_view') === 'reading'
    ? 'maths'
    : localStorage.getItem('webspider_terminal_view') || 'terminal',
  terminalInputMode: 'direct',
  terminalRenderTimer: null,
  terminalMathsGeneration: 0,
  terminalImageUploading: false,
  filePath: '',
  fileShowHidden: false,
  activeRoot: null,
  previewPath: null,
  previewMode: 'source',
};

function h(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function formatTime(value, withDate = false) {
  if (!value) return '—';
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, withDate
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

function formatBytes(value) {
  if (value == null) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function accountUsageLabel(usage) {
  if (!usage?.snapshot || !usage.weekly) {
    return 'Not observed yet; the main agent will check `/status` at a natural breakpoint.';
  }
  const freshness = usage.stale ? 'observation is stale' : 'fresh observation';
  const reset = usage.weekly.resets_at ? ` · resets ${formatTime(usage.weekly.resets_at, true)}` : '';
  return `${usage.weekly.remaining_percent}% remaining · observed ${formatTime(usage.snapshot.observed_at, true)} · ${freshness}${reset}`;
}

function csrf() {
  const match = document.cookie.match(/(?:^|; )ws_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = { ...(options.headers || {}) };
  if (options.body != null) headers['content-type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method)) headers['x-webspider-csrf'] = csrf();
  const response = await fetch(path, {
    method,
    headers,
    body: options.body == null ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
  });
  const type = response.headers.get('content-type') || '';
  const value = type.includes('json') ? await response.json() : await response.text();
  if (response.status === 401) {
    showLogin();
    throw Object.assign(new Error(value?.error?.message || 'Authentication required'), { code: value?.error?.code });
  }
  if (!response.ok) throw Object.assign(new Error(value?.error?.message || value || response.statusText), { code: value?.error?.code });
  return value;
}

function toast(message, bad = false) {
  const element = $('#toast');
  element.textContent = message;
  element.style.borderColor = bad ? 'rgba(251,125,136,.45)' : '';
  element.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add('hidden'), 3800);
}

function friendlyError(error) {
  const messages = {
    WS_NODE_OFFLINE: 'The workstation is offline. Durable work remains queued and can resume when it reconnects.',
    WS_AGENT_NOT_READY: 'The agent is still starting. Your request is safe to retry in a moment.',
    WS_TERMINAL_LEASE_REQUIRED: 'Another device currently controls this terminal. Watching remains available.',
    WS_TERMINAL_LEASE_STALE: 'Terminal control moved to another session. Take control again if needed.',
    WS_ROOT_REVOKED: 'The workspace moved or changed identity. Reconnect the project root before continuing.',
    WS_PREVIEW_UNSAFE: 'This file is download-only because rendering it here could execute active content.',
    WS_VERSION_MISMATCH: 'The portal and running hub are different versions. Restart the WebSpider hub service.',
    WS_INSTRUCTION_REVISION_CONFLICT: 'These instructions changed in another session. Reload and review before saving.',
    WS_POLICY_REVISION_CONFLICT: 'Global instructions changed in another session. Reload and review before saving.',
    WS_PROJECT_ACTIVE: 'Stop project agents and finish or cancel active tasks first.',
    WS_PROJECT_PROTECTED: 'The Master Spider project is protected.',
    WS_PROJECT_ARCHIVED: 'Restore this project before using it.',
    WS_CONFIRMATION_REQUIRED: 'The project name did not match.',
  };
  return messages[error?.code] || error?.message || 'WebSpider could not complete that action.';
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function openModal(content) {
  const modal = $('#modal');
  $('#modal-content').innerHTML = content;
  modal.showModal();
  $('input, textarea, select', modal)?.focus();
}

function closeModal() {
  $('#modal')?.close();
}

function workerInstallCommand(invite, nodeName) {
  const bootstrap = 'https://github.com/MurrellGroup/WebSpider/releases/latest/download/WebSpider_Install.run';
  return `i=$(mktemp);curl --http1.1 -fL --retry 5 -o "$i" ${bootstrap}&&sh "$i" --node ${shellQuote(invite.hub_url)} --token ${shellQuote(invite.token)} --workspace "$PWD" --name ${shellQuote(nodeName)}`;
}

async function copyControlValue(control) {
  if (!control) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(control.value);
      return true;
    } catch {
      // Plain HTTP and restrictive browser policies may reject the modern API.
    }
  }
  control.focus();
  control.select();
  control.setSelectionRange?.(0, control.value.length);
  return typeof document.execCommand === 'function' && document.execCommand('copy');
}

function showWorkerCommand({ project, invite, hub_url: hubURL }, nodeName) {
  openModal(`<div class="modal-header"><div><h2>${h(project.name)}</h2><p>Run once inside the project directory on the worker machine.</p></div><button data-action="close-modal" title="Close">×</button></div><div class="modal-body"><textarea id="worker-command" class="command-output" readonly>${h(workerInstallCommand({ ...invite, hub_url: hubURL }, nodeName))}</textarea><div class="modal-actions"><span>Invite expires ${h(formatTime(invite.expires_at, true))}</span><button class="primary" data-action="copy-worker-command">Copy command</button></div></div>`);
}

function showProjectOnboarding() {
  openModal(`<form id="onboard-project-form"><div class="modal-header"><div><h2>Add research project</h2><p>Create the project and its persistent worker.</p></div><button type="button" data-action="close-modal" title="Close">×</button></div><div class="modal-body form-grid"><label>Project name<input name="project_name" required maxlength="120"></label><label>Worker machine name<input name="node_name" required maxlength="120" placeholder="gpu-box"></label><label>Description<textarea name="description" maxlength="1000"></textarea></label><div class="modal-actions"><button type="button" class="secondary" data-action="close-modal">Cancel</button><button type="submit" class="primary">Create project</button></div></div></form>`);
}

function showProjectConnection(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  openModal(`<form id="connect-project-form" data-project-id="${h(projectId)}"><div class="modal-header"><div><h2>Connect ${h(project?.name || 'project')}</h2><p>Install its persistent worker on the machine that owns the project directory.</p></div><button type="button" data-action="close-modal" title="Close">×</button></div><div class="modal-body form-grid"><label>Worker machine name<input name="node_name" required maxlength="120" placeholder="gpu-box"></label><div class="modal-actions"><button type="button" class="secondary" data-action="close-modal">Cancel</button><button type="submit" class="primary">Create worker command</button></div></div></form>`);
}

function showTerminalForm() {
  openModal(`<form id="add-terminal-form"><div class="modal-header"><div><h2>New terminal</h2><p>${h(state.selectedAgent?.node_name || '')}</p></div><button type="button" data-action="close-modal" title="Close">×</button></div><div class="modal-body form-grid"><label>Tab name<input name="label" required maxlength="80" value="Monitor"></label><div class="modal-actions"><button type="button" class="secondary" data-action="close-modal">Cancel</button><button type="submit" class="primary">Open terminal</button></div></div></form>`);
}

function showCodexSessionForm() {
  const agent = state.selectedAgent;
  openModal(`<form id="codex-session-form"><div class="modal-header"><div><h2>Adopt an existing Codex session</h2><p>${h(agent.node_name)} · always resumes inside this agent's registered project directory.</p></div><button type="button" data-action="close-modal" title="Close">×</button></div><div class="modal-body form-grid">
    <label class="checkbox-row"><input type="checkbox" name="use_last" checked> Use the latest Codex session for this project</label>
    <label>Session UUID or name<input name="session_id" maxlength="200" placeholder="Optional when latest is selected"></label>
    <p class="muted">The session must already exist for the same user on this workstation. Adopting it restarts this agent; project instructions and workspace confinement still apply.</p>
    <div class="modal-actions">${agent.codex_session ? '<button type="button" class="secondary" data-action="detach-codex-session">Stop adopting external session</button>' : ''}<button type="button" class="secondary" data-action="close-modal">Cancel</button><button type="submit" class="primary">Adopt & restart</button></div>
  </div></form>`);
}

function showLogin() {
  $('#login-view').classList.remove('hidden');
  $('#app-shell').classList.add('hidden');
  state.eventSocket?.close();
}

function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
}

function closeMobileSidebar() {
  $('.sidebar')?.classList.remove('mobile-open');
}

function showVersionMismatch(hubVersion) {
  showApp();
  closeTerminal();
  $('#main-view').innerHTML = `<div class="page">${pageHeader('Restart required', 'The browser portal and running hub do not match')}<div class="page-content"><section class="panel"><div class="panel-header"><h2>Hub process is stale</h2><span>portal ${h(PORTAL_VERSION)} · hub ${h(hubVersion || 'unknown')}</span></div><div class="panel-body"><p class="muted">Restart the WebSpider service on the hub machine, then reload this page.</p><pre class="command-output">systemctl --user restart webspider.service</pre></div></section></div></div>`;
}

function closeTerminal() {
  state.terminalSocket?.close();
  state.terminalSocket = null;
  if (state.terminalHeartbeat) clearInterval(state.terminalHeartbeat);
  state.terminalHeartbeat = null;
  state.terminalLease = null;
  state.terminalLeaseRequested = false;
  state.terminalPendingInput = [];
  clearTimeout(state.terminalInputTimer);
  state.terminalInputTimer = null;
  clearTimeout(state.terminalCompositionTimer);
  state.terminalCompositionTimer = null;
  state.terminalInputBuffer = '';
  state.terminalInputSequence = 0;
  state.terminalInputAcknowledged = 0;
  state.terminalInputSubscription?.dispose();
  state.terminalInputSubscription = null;
  state.terminalResizeObserver?.disconnect();
  state.terminalResizeObserver = null;
  state.terminalFitAddon = null;
  state.terminalDimensions = null;
  state.terminalKeyboardProtocol = false;
  state.terminalBracketedPaste = false;
  state.terminalProtocolTail = '';
  clearTimeout(state.terminalRenderTimer);
  state.terminalRenderTimer = null;
  state.terminalMathsGeneration += 1;
  state.terminalEmulator?.dispose();
  state.terminalEmulator = null;
}

function consumeAccessToken() {
  const match = location.hash.match(/^#access_token=(.+)$/);
  if (!match) return null;
  let token = null;
  try { token = decodeURIComponent(match[1]); } catch { token = match[1]; }
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  return token;
}

async function loadData() {
  const health = await api('/healthz');
  if (health.portal_build && PORTAL_BUILD && health.portal_build !== PORTAL_BUILD) {
    location.reload();
    throw new Error('The portal was updated; reloading the latest interface.');
  }
  if (health.version !== PORTAL_VERSION) {
    showVersionMismatch(health.version);
    throw Object.assign(new Error(`Portal ${PORTAL_VERSION} requires hub ${PORTAL_VERSION}; running hub is ${health.version || 'unknown'}.`), { code: 'WS_VERSION_MISMATCH' });
  }
  const [summary, projects, archivedProjects, agents, archivedAgents, nodes, tasks, attention, notes] = await Promise.all([
    api('/api/v1/summary'),
    api('/api/v1/projects'),
    api('/api/v1/projects?archived=only'),
    api('/api/v1/agent-instances'),
    api('/api/v1/agent-instances?archived=only'),
    api('/api/v1/nodes'),
    api('/api/v1/tasks'),
    api('/api/v1/attention'),
    api('/api/v1/notes'),
  ]);
  Object.assign(state, {
    summary,
    projects: projects.projects,
    archivedProjects: archivedProjects.projects,
    agents: agents.agents,
    archivedAgents: archivedAgents.agents,
    nodes: nodes.nodes,
    tasks: tasks.tasks,
    attention: attention.items,
    notes: notes.notes,
  });
  if (state.selectedProject) state.selectedProject = state.projects.find((project) => project.id === state.selectedProject.id) || null;
  if (state.selectedAgent) state.selectedAgent = state.agents.find((agent) => agent.id === state.selectedAgent.id) || null;
  renderSidebar();
  renderAttention();
}

function renderSidebar() {
  $('#project-tree').innerHTML = state.projects.map((project) => {
    const agents = state.agents.filter((agent) => agent.project_id === project.id);
    return `<section class="project-group">
      <button class="project-heading ${state.selectedProject?.id === project.id ? 'selected' : ''}" data-project-id="${h(project.id)}">${h(project.name)}</button>
      ${agents.map((agent) => `<button class="agent-link ${state.selectedAgent?.id === agent.id ? 'selected' : ''}" data-agent-id="${h(agent.id)}">
        <i class="state-dot ${h(agent.state)}"></i>
        <span class="name">${h(agent.title || agent.profile_name)}</span>
        <span class="adapter">${h(agent.work_status !== 'idle' ? agent.work_status : agent.state)}</span>
      </button>`).join('') || '<div class="muted" style="font-size:10px;padding:8px 27px">No agents</div>'}
    </section>`;
  }).join('');
}

function renderAttention() {
  const offline = state.nodes.filter((node) => node.status !== 'online');
  $('#attention-panel').innerHTML = `<div class="attention-head"><strong>Attention</strong><span class="attention-count">${state.attention.length}</span></div>
    <div class="attention-body">
      ${state.attention.length ? state.attention.map((item) => `<article class="attention-item"><span class="severity">${h(item.severity)} · ${h(item.type)}</span><p>${h(item.summary)}</p></article>`).join('') : '<div class="attention-empty">Nothing needs a decision.<br>WebSpider will keep watch.</div>'}
      <section class="node-mini"><h3>Node fabric</h3>${state.nodes.map((node) => `<div class="node-mini-row"><i class="state-dot ${h(node.status)}"></i><span>${h(node.display_name)}</span><small>${h(node.status)}</small></div>`).join('')}</section>
      ${offline.length ? `<div class="attention-item"><span class="severity">Node status</span><p>${offline.length} node${offline.length === 1 ? ' is' : 's are'} offline. Durable work remains queued.</p></div>` : ''}
    </div>`;
}

function pageHeader(title, subtitle, actions = '') {
  return `<header class="page-header"><div class="page-title"><h1>${h(title)}</h1><p>${h(subtitle)}</p></div>${actions ? `<div class="header-actions">${actions}</div>` : ''}</header>`;
}

function summaryItem(value, label) {
  return `<div class="summary-item"><strong>${Number(value || 0)}</strong><span>${h(label)}</span></div>`;
}

function renderPortfolioRows() {
  const projects = state.projects.filter((project) => project.id !== 'prj_local' || state.projects.length === 1);
  if (!projects.length) return '<div class="empty"><div><strong>No research projects yet</strong><p>Add the first project from the sidebar.</p></div></div>';
  return projects.map((project) => {
    const agents = state.agents.filter((agent) => agent.project_id === project.id);
    const worker = agents.find((agent) => agent.orchestration_role === 'worker') || agents[0];
    const status = worker?.work_status || (worker ? worker.state : 'not connected');
    return `<button class="portfolio-row" data-project-id="${h(project.id)}"><i class="state-dot ${h(worker?.state || 'offline')}"></i><span><strong>${h(project.name)}</strong><small>${h(worker?.status_summary || (worker ? `${worker.node_name} · ${worker.state}` : 'Worker not connected'))}</small></span><span class="status-pill ${h(status)}">${h(status)}</span></button>`;
  }).join('');
}

function masterAgent() {
  return state.agents.find((agent) => agent.orchestration_role === 'main')
    || state.agents.find((agent) => agent.id === 'agt_master')
    || null;
}

async function openMasterTerminal() {
  const master = masterAgent();
  if (master) return renderAgent(master.id, 'terminal');
  return renderHome();
}

async function renderHome() {
  state.selectedProject = null;
  state.selectedAgent = null;
  closeTerminal();
  renderSidebar();
  history.replaceState(null, '', '#/overview');
  $('#main-view').innerHTML = `<div class="page">
    ${pageHeader('Master Spider', 'Research portfolio and persistent agent fabric', '<button class="primary" data-action="onboard-project">Add project</button><button data-action="refresh">Refresh</button>')}
    <div class="page-content">
      <div class="summary-strip">
        ${summaryItem(state.summary.projects_active, 'active projects')}
        ${summaryItem(state.summary.agents_active, 'active agents')}
        ${summaryItem(state.summary.tasks_running, 'tasks running')}
        ${summaryItem(state.summary.awaiting_approval, 'awaiting attention')}
        ${summaryItem(state.summary.nodes_offline, 'nodes offline')}
      </div>
      <section class="panel portfolio-panel"><div class="panel-header"><h2>Research portfolio</h2><span>${state.projects.length} projects</span></div><div class="portfolio-list">${renderPortfolioRows()}</div></section>
      <div class="grid-2 home-grid">
        <section class="panel"><div class="panel-header"><h2>Fabric activity</h2><span>durable event stream</span></div><div id="home-events" class="panel-body event-list"><div class="loading">Loading events…</div></div></section>
        <div>
          <section class="panel"><div class="panel-header"><h2>Security posture</h2><span>explicit scopes</span></div><div class="panel-body security-card">
            <div class="security-line"><span>Portal file access</span><strong>workspace-only</strong></div>
            <div class="security-line"><span>Node transport</span><strong>outbound + signed</strong></div>
            <div class="security-line"><span>Message provenance</span><strong>immutable actor</strong></div>
            <div class="security-line"><span>Terminal control</span><strong>single lease</strong></div>
          </div></section>
          <section class="panel" style="margin-top:18px"><div class="panel-header"><h2>Running work</h2><span>${state.tasks.filter((task) => task.state === 'running').length} active</span></div><div class="panel-body task-list">${renderTaskRows(state.tasks.slice(0, 6))}</div></section>
        </div>
      </div>
    </div>
  </div>`;
  const events = await api('/api/v1/events?limit=20');
  const target = $('#home-events');
  if (target) target.innerHTML = renderEventRows(events.events.slice().reverse());
}

async function renderProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId) || await api(`/api/v1/projects/${encodeURIComponent(projectId)}`);
  state.selectedProject = project;
  state.selectedAgent = null;
  closeTerminal();
  renderSidebar();
  const agents = state.agents
    .filter((agent) => agent.project_id === project.id)
    .sort((left, right) => new Date(right.last_activity_at) - new Date(left.last_activity_at));
  const primaryAgent = agents.find((agent) => agent.orchestration_role === 'main') || agents[0] || null;
  const canArchive = !agents.some((agent) => agent.orchestration_role === 'main');
  const tasks = state.tasks.filter((task) => task.project_id === project.id);
  const [policy, artifacts, accountUsage] = await Promise.all([
    api(`/api/v1/projects/${encodeURIComponent(project.id)}/policy`),
    api(`/api/v1/artifacts?project=${encodeURIComponent(project.id)}`),
    api('/api/v1/account-usage'),
  ]);
  const running = tasks.filter((task) => ['running', 'runnable'].includes(task.state));
  const completed = tasks.filter((task) => task.state === 'succeeded');
  $('#main-view').innerHTML = `<div class="page">
    ${pageHeader(project.name, project.description || 'Persistent project workspace and worker state', `${primaryAgent ? `<button class="primary" data-agent-id="${h(primaryAgent.id)}">Open agent</button>` : `<button class="primary" data-action="connect-project" data-project-id="${h(project.id)}">Connect worker</button>`}${canArchive ? `<button data-action="archive-project" data-project-id="${h(project.id)}">Archive</button>` : ''}`)}
    <div class="page-content project-workspace">
      <section class="steer-card">
        <div><p class="eyebrow">STEER THE OUTCOME</p><h2>What should move forward?</h2><p>Give the goal at the level you care about. The agent inherits the project agreement, inspects existing work, and resolves routine implementation choices.</p></div>
        ${primaryAgent ? `<form id="project-message-form" data-target-agent-id="${h(primaryAgent.id)}" data-thread-id="${h(primaryAgent.active_thread_id)}"><textarea name="message" required placeholder="For example: turn the current results into a submission-ready manuscript draft…"></textarea><div><span>${h(primaryAgent.work_status || 'idle')}${primaryAgent.status_summary ? ` · ${h(primaryAgent.status_summary)}` : ''}</span><button type="submit" class="primary">Start or continue</button></div></form>` : '<div class="empty compact"><div><strong>No worker connected</strong><p>Connect a machine from this project header.</p></div></div>'}
      </section>
      <div class="project-summary">
        ${summaryItem(agents.length, 'agents')}${summaryItem(running.length, 'active tasks')}${summaryItem(completed.length, 'completed tasks')}${summaryItem(artifacts.artifacts.length, 'kept artifacts')}
      </div>
      <div class="grid-2 project-grid">
        <section class="panel"><div class="panel-header"><h2>Project agents</h2><span>${agents.length} sessions</span></div><div class="portfolio-list">${agents.map((agent) => `<button class="portfolio-row" data-agent-id="${h(agent.id)}"><i class="state-dot ${h(agent.state)}"></i><span><strong>${h(agent.title || agent.profile_name)}</strong><small>${h(agent.status_summary || `${agent.node_name} · ${agent.state}`)}</small></span><span class="status-pill ${h(agent.work_status)}">${h(agent.work_status)}</span></button>`).join('') || '<div class="empty compact"><div><strong>Waiting for worker</strong></div></div>'}</div></section>
        <section class="panel policy-card"><div class="panel-header"><h2>Main-agent defaults</h2><span>system r${h(policy.system_revision)} · project r${h(policy.revision)}</span></div><div class="panel-body"><div class="policy-line"><i>1</i><div><strong>Infer routine details</strong><p>${h(policy.summary.autonomy)}</p></div></div><div class="policy-line"><i>2</i><div><strong>Produce the work product</strong><p>${h(policy.summary.work_product)}</p></div></div><div class="policy-line"><i>3</i><div><strong>Respect worker harnesses</strong><p>${h(policy.summary.delegation)}</p></div></div><div class="policy-line"><i>4</i><div><strong>Editable when you ask</strong><p>${h(policy.summary.behavior_control)} Tell the main agent what outcome you want changed; no settings form is required.</p></div></div><div class="policy-line"><i>5</i><div><strong>Weekly account allowance</strong><p>${h(accountUsageLabel(accountUsage))}</p><p>${h(policy.summary.account_quota)}</p></div></div><details class="policy-details"><summary>View the main-agent agreement</summary><div class="markdown-body">${renderMarkdown(policy.rendered_instructions)}</div></details></div></section>
      </div>
    </div>
  </div>`;
  history.replaceState(null, '', `#/projects/${encodeURIComponent(project.id)}`);
}

function renderArchivedProjects() {
  state.selectedProject = null;
  state.selectedAgent = null;
  closeTerminal();
  renderSidebar();
  const rows = state.archivedProjects.map((project) => {
    const agents = state.archivedAgents.filter((agent) => agent.project_id === project.id);
    const latest = agents.slice().sort((left, right) => new Date(right.last_activity_at) - new Date(left.last_activity_at))[0];
    return `<article class="archived-row">
      <div><strong>${h(project.name)}</strong><small>Archived ${h(formatTime(project.archived_at, true))}${latest ? ` · ${h(latest.node_name)} · ${h(latest.state)}` : ''}</small></div>
      <span>${agents.length} agent${agents.length === 1 ? '' : 's'}</span>
      <div><button data-action="restore-project" data-project-id="${h(project.id)}">Restore</button><button class="danger" data-action="delete-project" data-project-id="${h(project.id)}">Delete permanently</button></div>
    </article>`;
  }).join('');
  $('#main-view').innerHTML = `<div class="page">
    ${pageHeader('Archived projects', 'Hidden from the active portfolio; workspace files remain untouched')}
    <div class="page-content"><section class="panel"><div class="panel-header"><h2>Archive</h2><span>${state.archivedProjects.length} projects</span></div><div class="archived-list">${rows || '<div class="empty"><div><strong>No archived projects</strong><p>Archived projects will appear here and can be restored.</p></div></div>'}</div></section></div>
  </div>`;
  history.replaceState(null, '', '#/archived');
}

async function renderWorkerInstructions() {
  state.selectedProject = null;
  state.selectedAgent = null;
  closeTerminal();
  renderSidebar();
  const system = await api('/api/v1/system/policy');
  const instructions = system.policy.requested_instructions?.workers || [];
  const runningWorkers = state.agents.filter((agent) => agent.orchestration_role !== 'main'
    && ['ready', 'busy'].includes(agent.state));
  $('#main-view').innerHTML = `<div class="page">
    ${pageHeader('All sub-spiders', 'Worker-only instructions; the Master Spider does not inherit this text')}
    <div class="page-content"><section class="panel instruction-card">
      <div class="panel-header"><h2>Shared worker instructions</h2><span>system r${h(system.revision)}</span></div>
      <form id="worker-instructions-form" class="instruction-editor" data-revision="${h(system.revision)}">
        <label for="worker-global-instructions">One compact instruction per line</label>
        <textarea id="worker-global-instructions" name="instructions" maxlength="4000" placeholder="For example: return benchmark results as CSV.">${h(instructions.join('\n'))}</textarea>
        <div class="instruction-actions"><span>Inherited by every registered worker on its next launch. ${runningWorkers.length} worker${runningWorkers.length === 1 ? '' : 's'} currently running.</span><div><button type="submit" name="apply" value="save">Save</button><button type="submit" class="primary" name="apply" value="restart">Save & restart workers</button></div></div>
      </form>
    </section></div>
  </div>`;
  history.replaceState(null, '', '#/sub-spider-instructions');
}

function renderEventRows(events) {
  if (!events.length) return '<div class="empty"><div><strong>No events yet</strong><p>Agent, task, message, and node transitions will appear here.</p></div></div>';
  return events.map((event) => `<div class="event-row">
    <time class="event-time">${h(formatTime(event.hub_timestamp))}</time><i class="event-dot"></i>
    <div><strong>${h(event.type.replace(/\.v\d+$/, '').replaceAll('.', ' · '))}</strong><small>${h(event.actor_id)} → ${h(event.subject_id)}</small></div>
  </div>`).join('');
}

function agentTabs() {
  const primary = ['terminal', 'instructions', 'files', 'conversation', 'artifacts'];
  const secondary = ['activity', 'tasks', 'metadata'];
  const button = (tab) => `<button class="${state.tab === tab ? 'selected' : ''}" data-tab="${tab}">${tab[0].toUpperCase()}${tab.slice(1)}</button>`;
  return `${primary.map(button).join('')}<details class="tab-more" ${secondary.includes(state.tab) ? 'open' : ''}><summary>More</summary><div>${secondary.map(button).join('')}</div></details>`;
}

async function renderAgent(agentId, tab = 'terminal') {
  state.selectedAgent = state.agents.find((agent) => agent.id === agentId) || (await api(`/api/v1/agent-instances/${encodeURIComponent(agentId)}`));
  state.selectedProject = state.projects.find((project) => project.id === state.selectedAgent.project_id) || null;
  state.tab = tab;
  renderSidebar();
  const agent = state.selectedAgent;
  const resumable = ['stopped', 'failed', 'hibernated'].includes(agent.state);
  const codexAction = agent.codex_capable ? '<button data-action="adopt-codex-session">Adopt Codex session…</button>' : '';
  const actionMenu = `<details class="action-menu"><summary>Agent actions</summary><div>${codexAction}${resumable ? '' : '<button class="danger" data-action="stop-agent">Stop agent</button>'}</div></details>`;
  $('#main-view').innerHTML = `<div class="page">
    ${pageHeader(agent.title || agent.profile_name, `${agent.project_name} · ${agent.node_name} · ${agent.work_status}${agent.status_summary ? ` · ${agent.status_summary}` : ''}`, `
      <span class="status-pill ${h(agent.state)}">${h(agent.state)}</span>
      ${agent.orchestration_role === 'main' ? '<button class="mobile-primary" data-action="overview">Portfolio</button>' : ''}
      ${resumable ? '<button class="primary" data-action="wake-agent">Resume agent</button>' : ''}${codexAction || !resumable ? actionMenu : ''}`)}
    <nav class="tabs">${agentTabs()}</nav>
    <div id="agent-content" class="page-content ${tab === 'terminal' ? 'terminal-page-content' : ''}"><div class="loading">Loading ${h(tab)}…</div></div>
  </div>`;
  history.replaceState(null, '', `#/projects/${encodeURIComponent(agent.project_id)}/agents/${encodeURIComponent(agent.id)}/${tab}`);
  await renderAgentTab();
}

async function renderAgentTab() {
  const agent = state.selectedAgent;
  if (!agent) return;
  closeTerminal();
  if (state.tab === 'conversation') return renderConversation(agent);
  if (state.tab === 'activity') return renderActivity(agent);
  if (state.tab === 'terminal') return renderTerminal(agent);
  if (state.tab === 'instructions') return renderInstructions(agent);
  if (state.tab === 'files') return renderFiles(agent);
  if (state.tab === 'artifacts') return renderArtifacts(agent);
  if (state.tab === 'tasks') return renderAgentTasks(agent);
  if (state.tab === 'metadata') return renderMetadata(agent);
}

async function renderConversation(agent) {
  const data = await api(`/api/v1/threads/${encodeURIComponent(agent.active_thread_id)}/messages`);
  $('#agent-content').innerHTML = `<section class="conversation">
    <div class="message-list">${data.messages.length ? data.messages.map(renderMessage).join('') : `<div class="empty conversation-empty"><div><strong>What outcome should move forward?</strong><p>Describe the result, not every implementation detail. The agent will inspect the project, apply its inherited defaults, and ask only about material blockers.</p><div class="suggestion-row"><button data-suggest-message="Review the project and continue the highest-value unfinished work.">Continue important work</button><button data-suggest-message="Review the current results and prepare a manuscript-ready technical summary.">Draft results summary</button><button data-suggest-message="Audit the project for the most important correctness or reproducibility risk and fix it.">Check reproducibility</button></div></div></div>`}</div>
    <form class="composer" id="message-form">
      <textarea name="message" placeholder="Describe the outcome you want…" required></textarea>
      <div class="composer-footer"><details class="composer-options"><summary>Delivery options</summary><label>When to deliver<select name="wake"><option value="ensure_running">Automatically at the next safe point</option><option value="deliver_when_ready">After the current turn</option><option value="queue_only">Queue without waking</option><option value="interrupt">Interrupt current work</option></select></label><small>WebSpider normally wakes the agent and queues safely.</small></details><button type="submit" class="primary">Send</button></div>
    </form>
  </section>`;
  const list = $('.message-list');
  list?.lastElementChild?.scrollIntoView({ block: 'end' });
}

function renderMessage(message) {
  const text = message.content_parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  const actual = message.authenticated_actor_id !== message.display_sender ? `${message.authenticated_actor_id} → delivered as ${message.delivery_role}` : message.delivery_role;
  return `<article class="message ${h(message.delivery_role)}">
    <div class="message-avatar">${h((message.display_sender || '?').slice(0, 2).toUpperCase())}</div>
    <div class="message-body"><div class="message-meta"><strong>${h(message.display_sender)}</strong><time>${h(formatTime(message.created_at))}</time><span>#${message.sequence}</span></div><div class="message-text markdown-body">${renderMarkdown(text)}</div><div class="delivery-note">${h(actual)} · ${h(message.delivery?.state || 'accepted')}</div></div>
  </article>`;
}

async function renderActivity(agent) {
  const data = await api(`/api/v1/events?agent=${encodeURIComponent(agent.id)}&limit=500`);
  $('#agent-content').innerHTML = `<section class="panel"><div class="panel-header"><h2>Activity timeline</h2><span>${data.events.length} durable events</span></div><div class="panel-body event-list">${renderEventRows(data.events.slice().reverse())}</div></section>`;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value || '');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64ToText(value) {
  return new TextDecoder().decode(base64ToBytes(value));
}

function applyTerminalView() {
  const layout = $('#terminal-layout');
  if (!layout) return;
  layout.dataset.view = state.terminalView;
  $$('[data-terminal-view]').forEach((button) => button.classList.toggle('selected', button.dataset.terminalView === state.terminalView));
  localStorage.setItem('webspider_terminal_view', state.terminalView);
}

function applyTerminalInputMode() {
  const form = $('#terminal-compose-form');
  if (!form) return;
  const composing = state.terminalInputMode === 'compose';
  form.classList.toggle('hidden', !composing);
  $$('[data-terminal-input-mode]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.terminalInputMode === state.terminalInputMode);
  });
  if (composing) $('#terminal-compose')?.focus();
  else state.terminalEmulator?.focus();
}

function submitTerminalComposition(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');
  if (!normalized || state.terminalCompositionTimer) return false;
  const payload = state.terminalBracketedPaste ? `\u001b[200~${normalized}\u001b[201~` : normalized;
  const payloadBytes = new TextEncoder().encode(payload).length;
  const settleMilliseconds = Math.min(1_000, 150 + (Math.ceil(payloadBytes / 4_096) * 25));
  transmitTerminalInput(payload);
  state.terminalCompositionTimer = setTimeout(() => {
    state.terminalEmulator?.focus();
    queueTerminalInput('\r');
    state.terminalCompositionTimer = setTimeout(() => {
      state.terminalCompositionTimer = null;
      const form = $('#terminal-compose-form');
      const textarea = $('#terminal-compose');
      const button = form?.querySelector('button[type="submit"]');
      if (textarea) textarea.readOnly = false;
      if (button) button.disabled = false;
      textarea?.focus();
    }, 75);
  }, settleMilliseconds);
  const form = $('#terminal-compose-form');
  const textarea = $('#terminal-compose');
  const button = form?.querySelector('button[type="submit"]');
  if (textarea) textarea.readOnly = true;
  if (button) button.disabled = true;
  return true;
}

function updateTerminalMaths(immediate = false) {
  clearTimeout(state.terminalRenderTimer);
  if (state.terminalView === 'terminal' && !immediate) return;
  const render = async () => {
    const maths = $('#terminal-maths');
    const buffer = state.terminalEmulator?.buffer?.active;
    if (!maths || !buffer) return;
    const transcript = terminalBufferText(buffer);
    const generation = ++state.terminalMathsGeneration;
    const pinnedToBottom = maths.scrollHeight - maths.scrollTop - maths.clientHeight < 48;
    window.MathJax?.typesetClear?.([maths]);
    if (!transcript) {
      maths.innerHTML = '<div class="terminal-maths-empty">Maths output will appear here as the agent writes.</div>';
      return;
    }
    const content = document.createElement('div');
    content.className = 'terminal-maths-transcript';
    content.textContent = prepareTerminalMaths(transcript);
    maths.replaceChildren(content);
    try {
      await window.MathJax?.typesetPromise?.([content]);
    } catch (error) {
      console.warn('MathJax could not typeset the terminal transcript.', error);
    }
    if (generation === state.terminalMathsGeneration && pinnedToBottom) maths.scrollTop = maths.scrollHeight;
  };
  if (immediate) void render();
  else state.terminalRenderTimer = setTimeout(render, 180);
}

async function uploadPastedTerminalImages(files) {
  if (state.terminalImageUploading) {
    toast('An image upload is already in progress.', true);
    return;
  }
  const terminal = state.terminals.find((candidate) => candidate.id === state.selectedTerminalId);
  if (!state.selectedAgent || !terminal) return;
  state.terminalImageUploading = true;
  try {
    for (const file of files.slice(0, 4)) {
      if (file.size > 8 * 1024 * 1024) throw new Error('Pasted images must be 8 MiB or smaller.');
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
        throw new Error('Paste a PNG, JPEG, GIF, or WebP image.');
      }
      toast(`Uploading ${file.name || 'clipboard image'}…`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await api(`/api/v1/agent-instances/${encodeURIComponent(state.selectedAgent.id)}/uploads`, {
        method: 'POST',
        body: {
          upload_id: `upl_${randomIdentifier()}`,
          terminal_id: terminal.id,
          filename: file.name || 'clipboard-image',
          mime_type: file.type,
          data_base64: bytesToBase64(bytes),
        },
      });
      toast(`Image sent to the agent: ${result.upload.relative_path}`);
    }
  } catch (error) {
    toast(friendlyError(error), true);
  } finally {
    state.terminalImageUploading = false;
  }
}

document.addEventListener('paste', (event) => {
  if (!event.target.closest('#terminal-output, #terminal-compose')) return;
  const images = [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (!images.length) return;
  event.preventDefault();
  void uploadPastedTerminalImages(images);
}, true);

function transmitTerminalInput(data) {
  if (!data) return;
  if (!state.terminalLease || state.terminalSocket?.readyState !== WebSocket.OPEN) {
    state.terminalPendingInput.push(data);
    requestTerminalLease();
    return;
  }
  const bytes = new TextEncoder().encode(data);
  const maxChunkBytes = 48 * 1024;
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(bytes.length, start + maxChunkBytes);
    if (end < bytes.length) while (end > start && (bytes[end] & 0xc0) === 0x80) end -= 1;
    const chunk = bytes.slice(start, end);
    state.terminalInputSequence += 1;
    state.terminalSocket.send(JSON.stringify({
      type: 'INPUT',
      lease_id: state.terminalLease.id,
      lease_epoch: state.terminalLease.lease_epoch,
      input_sequence: state.terminalInputSequence,
      data: bytesToBase64(chunk),
    }));
    start = end;
  }
}

function requestTerminalLease() {
  if (state.terminalLease || state.terminalLeaseRequested || state.terminalSocket?.readyState !== WebSocket.OPEN) return;
  state.terminalLeaseRequested = true;
  const button = $('#terminal-control');
  if (button) button.textContent = 'Requesting control';
  state.terminalSocket.send(JSON.stringify({ type: 'LEASE_REQUEST' }));
}

function queueTerminalInput(data) {
  if (!data) return;
  let encoded = data;
  let terminalEvent = false;
  let delay = 8;
  if (state.terminalKeyboardProtocol) {
    const named = new Map([['\r', 13], ['\t', 9], ['\u007f', 127], ['\u001b', 27]]);
    if (named.has(data)) {
      encoded = kittySequence(named.get(data));
      terminalEvent = true;
    }
    else if (data.length === 1 && data.charCodeAt(0) >= 1 && data.charCodeAt(0) <= 26) {
      encoded = kittySequence(96 + data.charCodeAt(0), 5);
      terminalEvent = true;
    }
  }
  if (terminalEvent && state.terminalInputBuffer) {
    clearTimeout(state.terminalInputTimer);
    state.terminalInputTimer = null;
    const pending = state.terminalInputBuffer;
    state.terminalInputBuffer = '';
    transmitTerminalInput(pending);
    delay = 30;
  }
  state.terminalInputBuffer += encoded;
  clearTimeout(state.terminalInputTimer);
  state.terminalInputTimer = setTimeout(() => {
    const batch = state.terminalInputBuffer;
    state.terminalInputBuffer = '';
    state.terminalInputTimer = null;
    transmitTerminalInput(batch);
  }, delay);
}

function handleTerminalData(data) {
  enqueueTerminalData(data, {
    controlled: Boolean(state.terminalLease),
    requestPending: state.terminalLeaseRequested,
    requestControl: requestTerminalLease,
    enqueue: queueTerminalInput,
  });
}

function handleTerminalKey(event) {
  const input = directKeyInput(event, state.terminalKeyboardProtocol);
  if (input == null) return true;
  event.preventDefault();
  handleTerminalData(input);
  return false;
}

function observeTerminalProtocol(text) {
  const combined = state.terminalProtocolTail + text;
  for (const match of combined.matchAll(/\u001b\[(>|<)\d*u/g)) {
    state.terminalKeyboardProtocol = match[1] === '>';
  }
  for (const match of combined.matchAll(/\u001b\[\?2004([hl])/g)) {
    state.terminalBracketedPaste = match[1] === 'h';
  }
  state.terminalProtocolTail = combined.slice(-16);
  const output = $('#terminal-output');
  if (output) output.dataset.keyboardProtocol = String(state.terminalKeyboardProtocol);
}

function flushTerminalInput() {
  const pending = state.terminalPendingInput;
  state.terminalPendingInput = [];
  for (const data of pending) transmitTerminalInput(data);
}

function transmitTerminalResize() {
  const dimensions = state.terminalDimensions;
  if (!dimensions || !state.terminalLease || state.terminalSocket?.readyState !== WebSocket.OPEN) return;
  state.terminalSocket.send(JSON.stringify({
    type: 'RESIZE',
    lease_id: state.terminalLease.id,
    lease_epoch: state.terminalLease.lease_epoch,
    columns: dimensions.columns,
    rows: dimensions.rows,
  }));
}

function fitTerminal() {
  if (!state.terminalEmulator || !state.terminalFitAddon || state.terminalView === 'maths') return;
  state.terminalFitAddon.fit();
  const dimensions = { columns: state.terminalEmulator.cols, rows: state.terminalEmulator.rows };
  const output = $('#terminal-output');
  if (output) {
    output.dataset.columns = String(dimensions.columns);
    output.dataset.rows = String(dimensions.rows);
  }
  if (dimensions.columns === state.terminalDimensions?.columns && dimensions.rows === state.terminalDimensions?.rows) return;
  state.terminalDimensions = dimensions;
  transmitTerminalResize();
}

async function renderTerminal(agent) {
  closeTerminal();
  state.terminalText = '';
  const data = await api(`/api/v1/agent-instances/${encodeURIComponent(agent.id)}/terminals`);
  state.terminals = data.terminals.filter((item) => item.kind === 'primary_agent' || item.state !== 'exited');
  const terminal = state.terminals.find((candidate) => candidate.id === state.selectedTerminalId)
    || state.terminals.find((candidate) => candidate.id === agent.terminal_id)
    || state.terminals[0];
  if (!terminal) {
    $('#agent-content').innerHTML = '<div class="empty"><div><strong>No terminal available</strong></div></div>';
    return;
  }
  state.selectedTerminalId = terminal.id;
  const agentEnded = ['stopped', 'failed', 'hibernated'].includes(agent.state);
  const interactive = terminal.state === 'attached' && !(terminal.kind === 'primary_agent' && agentEnded);
  if (!['terminal', 'maths', 'split'].includes(state.terminalView)) state.terminalView = 'terminal';
  $('#agent-content').innerHTML = `<section class="terminal-shell">
    <div class="terminal-session-tabs">${state.terminals.map((item) => {
    const label = item.kind === 'primary_agent' ? agent.title || 'Agent'
      : item.kind === 'task_shell' && item.label === 'Terminal' ? `Task ${item.id.slice(-4)}` : item.label;
    return `<div class="terminal-tab ${item.id === terminal.id ? 'selected' : ''}"><button class="terminal-select" data-terminal-id="${h(item.id)}"><i class="state-dot ${h(item.state === 'attached' ? 'ready' : item.state)}"></i><span>${h(label)}</span></button>${item.kind !== 'primary_agent' ? `<button class="terminal-tab-close" data-action="close-terminal" data-terminal-id="${h(item.id)}" aria-label="Close ${h(label)} terminal tab" title="${item.kind === 'task_shell' ? 'Dismiss task terminal; the task keeps running' : 'Close terminal and stop its shell'}">×</button>` : ''}</div>`;
  }).join('')}<button class="terminal-add" data-action="add-terminal" title="New terminal" aria-label="New terminal tab">+</button></div>
    <div class="terminal-toolbar"><div class="terminal-lights"><i></i><i></i><i></i></div><span>${h(agent.node_name)} / ${h(terminal.label)}</span>${interactive ? '<div class="terminal-input-switch" aria-label="Terminal input mode"><button data-terminal-input-mode="direct">Direct</button><button data-terminal-input-mode="compose">Text box</button></div>' : ''}<div class="terminal-view-switch" aria-label="Terminal view"><button data-terminal-view="terminal">Terminal</button><button data-terminal-view="maths">Maths</button><button data-terminal-view="split">Split</button></div>${agentEnded && terminal.kind === 'primary_agent' ? '<button class="primary" id="terminal-control" data-action="wake-agent">Restart agent</button>' : `<button class="secondary" id="terminal-control" data-action="take-control">${interactive ? 'Take control' : 'Not running'}</button>`}</div>
    <div id="terminal-layout" class="terminal-layout" data-view="${h(state.terminalView)}"><div id="terminal-output" class="terminal-output" aria-label="Interactive agent terminal"></div><div id="terminal-maths" class="terminal-maths" aria-live="polite"><div class="terminal-maths-empty">Maths output will appear here as the agent writes.</div></div></div>
    ${interactive ? '<form id="terminal-compose-form" class="terminal-compose hidden"><textarea id="terminal-compose" name="text" aria-label="Terminal text box" placeholder="Write before sending to the terminal"></textarea><button class="primary" type="submit">Send</button></form>' : ''}
  </section>`;
  applyTerminalView();
  applyTerminalInputMode();
  const emulator = new Terminal({
    cols: 120,
    rows: 36,
    cursorBlink: true,
    convertEol: false,
    scrollback: 10_000,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.15,
    theme: {
      background: '#07090d',
      foreground: '#d7e0e3',
      cursor: '#8ef0c7',
      selectionBackground: '#28483f',
    },
  });
  const fitAddon = new FitAddon();
  emulator.loadAddon(fitAddon);
  state.terminalEmulator = emulator;
  state.terminalFitAddon = fitAddon;
  emulator.attachCustomKeyEventHandler(handleTerminalKey);
  emulator.open($('#terminal-output'));
  fitTerminal();
  state.terminalResizeObserver = new ResizeObserver(() => requestAnimationFrame(fitTerminal));
  state.terminalResizeObserver.observe($('#terminal-output'));
  if (interactive) {
    const output = $('#terminal-output');
    output.addEventListener('pointerdown', requestTerminalLease);
    output.addEventListener('keydown', requestTerminalLease, true);
    state.terminalInputSubscription = emulator.onData(handleTerminalData);
  }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const attachment = sessionStorage.getItem('webspider_attachment') || randomIdentifier();
  sessionStorage.setItem('webspider_attachment', attachment);
  state.terminalSequence = 0;
  const socket = new WebSocket(`${protocol}//${location.host}/api/v1/ws/terminals/${encodeURIComponent(terminal.id)}?attachment=${encodeURIComponent(attachment)}`);
  state.terminalSocket = socket;
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    if (!state.terminalEmulator) return;
    if (frame.type === 'SNAPSHOT') {
      observeTerminalProtocol(frame.text || '');
      if (Number(frame.sequence || 0) >= state.terminalSequence) {
        state.terminalText = frame.text || '';
        state.terminalEmulator.reset();
        state.terminalEmulator.write(state.terminalText, () => updateTerminalMaths(true));
        state.terminalSequence = Number(frame.sequence || 0);
      }
    }
    if (frame.type === 'OUTPUT' && Number(frame.sequence_end) > state.terminalSequence) {
      const bytes = base64ToBytes(frame.data);
      const overlap = Math.max(0, state.terminalSequence - Number(frame.sequence_start));
      const addition = new TextDecoder().decode(overlap ? bytes.slice(overlap) : bytes);
      state.terminalText += addition;
      observeTerminalProtocol(addition);
      state.terminalEmulator.write(overlap ? bytes.slice(overlap) : bytes, () => updateTerminalMaths());
      state.terminalSequence = Number(frame.sequence_end);
    }
    if (frame.type === 'RESIZE_ACK') {
      const output = $('#terminal-output');
      if (output) output.dataset.ptyResized = String(frame.result?.resized === true);
    }
    if (frame.type === 'INPUT_ACK') {
      state.terminalInputAcknowledged = Math.max(state.terminalInputAcknowledged, Number(frame.input_sequence || 0));
      const output = $('#terminal-output');
      if (output) output.dataset.inputAcknowledged = String(state.terminalInputAcknowledged);
    }
    if (frame.type === 'LEASE_GRANTED') {
      state.terminalLease = frame.lease;
      state.terminalLeaseRequested = false;
      $('#terminal-control').textContent = 'In Control';
      flushTerminalInput();
      transmitTerminalResize();
      if (state.terminalInputMode === 'direct') state.terminalEmulator.focus();
      if (state.terminalHeartbeat) clearInterval(state.terminalHeartbeat);
      state.terminalHeartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN && state.terminalLease) socket.send(JSON.stringify({
          type: 'HEARTBEAT',
          lease_id: state.terminalLease.id,
          lease_epoch: state.terminalLease.lease_epoch,
        }));
      }, 5_000);
    }
    if (frame.type === 'ERROR') {
      if (['WS_TERMINAL_LEASE_REQUIRED', 'WS_TERMINAL_LEASE_STALE'].includes(frame.code)) {
        state.terminalLease = null;
        state.terminalLeaseRequested = false;
        state.terminalPendingInput = [];
        const button = $('#terminal-control');
        if (button) button.textContent = 'Take control';
      }
      toast(`${frame.code}: ${frame.message || 'Terminal error'}`, true);
    }
  });
  socket.addEventListener('close', () => {
    if (state.terminalHeartbeat) clearInterval(state.terminalHeartbeat);
    state.terminalHeartbeat = null;
    state.terminalLease = null;
    state.terminalLeaseRequested = false;
    const button = $('#terminal-control');
    if (button) button.textContent = 'Reconnect';
  });
}

async function renderFiles(agent) {
  const data = await api(`/api/v1/agent-instances/${encodeURIComponent(agent.id)}/roots`);
  state.activeRoot = data.roots[0] || null;
  state.filePath = '';
  state.fileShowHidden = false;
  state.previewPath = null;
  state.previewMode = 'source';
  if (!state.activeRoot) {
    $('#agent-content').innerHTML = '<div class="empty"><div><strong>No exposed root</strong><p>This agent has no project root available to the portal.</p></div></div>';
    return;
  }
  $('#agent-content').innerHTML = `<div class="file-layout"><section class="file-pane"><div id="file-toolbar" class="file-toolbar"></div><div id="file-rows" class="file-rows"></div></section><section class="preview-pane"><div id="preview-header" class="preview-header"><strong>No file selected</strong></div><div id="preview-content" class="preview-content source-preview">Select a text, image, SVG, or PDF file to preview it here. Markdown and math are rendered automatically; source is always one click away.</div></section></div>`;
  await loadDirectory();
}

async function loadDirectory() {
  const root = state.activeRoot;
  const data = await api(`/api/v1/roots/${encodeURIComponent(root.id)}/entries?path=${encodeURIComponent(state.filePath)}&hidden=${state.fileShowHidden}`);
  const parts = state.filePath ? state.filePath.split('/') : [];
  const crumbs = [{ name: root.logical_name, path: '' }, ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }))];
  $('#file-toolbar').innerHTML = `${crumbs.map((crumb) => `<button class="breadcrumb" data-file-dir="${h(crumb.path)}">${h(crumb.name)}</button>`).join('<span class="muted">/</span>')}<button class="file-hidden-toggle ${state.fileShowHidden ? 'selected' : ''}" data-action="toggle-hidden-files" aria-pressed="${state.fileShowHidden}">${state.fileShowHidden ? 'Hide hidden' : 'Show hidden'}</button><input id="file-search" class="file-search" placeholder="Search" aria-label="Search files">`;
  $('#file-rows').innerHTML = data.entries.length ? data.entries.map((entry) => `<button class="file-row ${h(entry.kind)}" data-file-name="${h(entry.name)}" data-file-kind="${h(entry.kind)}">
    <span class="file-icon">${entry.kind === 'directory' ? '▰' : entry.kind === 'symlink' ? '↗' : '▤'}</span><span class="file-name">${h(entry.name)}</span><span class="file-size">${h(formatBytes(entry.size))}</span><span class="file-date">${h(formatTime(entry.mtime))}</span>
  </button>`).join('') : '<div class="empty"><div><strong>Empty directory</strong><p>No visible entries in this workspace path.</p></div></div>';
}

async function previewFile(name) {
  const relative = state.filePath ? `${state.filePath}/${name}` : name;
  state.previewPath = relative;
  const markdown = /\.(?:md|markdown|qmd|rmd)$/i.test(relative);
  const image = /\.(?:png|jpe?g|gif|webp|svg)$/i.test(relative);
  const pdf = /\.pdf$/i.test(relative);
  state.previewMode = markdown ? 'rendered' : 'source';
  $('#preview-header').innerHTML = `<strong>${h(relative)}</strong><div class="preview-actions">${markdown ? '<div class="preview-mode-switch"><button data-preview-mode="rendered" class="selected">Readable</button><button data-preview-mode="source">Source</button></div>' : ''}<button data-action="promote-artifact">Keep as artifact</button><a href="/api/v1/roots/${encodeURIComponent(state.activeRoot.id)}/download?path=${encodeURIComponent(relative)}">Download</a></div>`;
  const content = $('#preview-content');
  content.textContent = 'Loading preview…';
  if (image || pdf) {
    const source = `/api/v1/roots/${encodeURIComponent(state.activeRoot.id)}/media-preview?path=${encodeURIComponent(relative)}`;
    content.className = 'preview-content media-preview';
    content.replaceChildren();
    if (image) {
      const element = document.createElement('img');
      element.className = 'image-preview';
      element.alt = `Preview of ${relative}`;
      element.src = source;
      content.append(element);
    } else {
      const element = document.createElement('iframe');
      element.className = 'document-preview';
      element.title = `Preview of ${relative}`;
      element.src = source;
      content.append(element);
      const fallback = document.createElement('p');
      fallback.className = 'muted media-preview-fallback';
      fallback.textContent = 'If your browser cannot display this PDF, use Download.';
      content.append(fallback);
    }
    return;
  }
  try {
    const preview = await api(`/api/v1/roots/${encodeURIComponent(state.activeRoot.id)}/preview?path=${encodeURIComponent(relative)}`);
    content.dataset.source = preview.content;
    if (state.previewMode === 'rendered') {
      content.className = 'preview-content markdown-body';
      content.innerHTML = renderMarkdown(preview.content);
    } else {
      content.className = 'preview-content source-preview';
      content.textContent = preview.content;
    }
  } catch (error) {
    content.className = 'preview-content source-preview';
    content.textContent = friendlyError(error);
  }
}

function setPreviewMode(mode) {
  const content = $('#preview-content');
  if (!content?.dataset.source) return;
  state.previewMode = mode;
  $$('[data-preview-mode]').forEach((button) => button.classList.toggle('selected', button.dataset.previewMode === mode));
  if (mode === 'rendered') {
    content.className = 'preview-content markdown-body';
    content.innerHTML = renderMarkdown(content.dataset.source);
  } else {
    content.className = 'preview-content source-preview';
    content.textContent = content.dataset.source;
  }
}

async function searchFiles(query) {
  const result = await api(`/api/v1/roots/${encodeURIComponent(state.activeRoot.id)}/search?path=${encodeURIComponent(state.filePath)}&query=${encodeURIComponent(query)}`);
  $('#file-rows').innerHTML = result.results.length ? result.results.map((entry) => `<button class="file-row ${h(entry.kind)}" data-search-path="${h(entry.path)}" data-search-kind="${h(entry.kind)}">
    <span class="file-icon">${entry.kind === 'directory' ? '▰' : '⌕'}</span><span class="file-name">${h(entry.path)}${entry.line ? `:${entry.line}` : ''}<small style="display:block;color:var(--muted-2);overflow:hidden;text-overflow:ellipsis">${h(entry.excerpt || entry.match)}</small></span><span class="file-size"></span><span class="file-date">${h(entry.match)}</span>
  </button>`).join('') : '<div class="empty"><div><strong>No matches</strong><p>Search stays within this registered workspace root.</p></div></div>';
}

async function renderArtifacts(agent) {
  const data = await api(`/api/v1/artifacts?agent=${encodeURIComponent(agent.id)}`);
  $('#agent-content').innerHTML = `<section class="panel"><div class="panel-header"><h2>Durable artifacts</h2><span>${data.artifacts.length} promoted outputs</span></div><div class="panel-body artifact-list">${data.artifacts.length ? `<table class="data-table"><thead><tr><th>Name</th><th>Kind</th><th>Size</th><th>Hash</th><th>Created</th><th></th></tr></thead><tbody>${data.artifacts.map((artifact) => `<tr><td>${h(artifact.logical_name)}</td><td>${h(artifact.kind)}</td><td>${h(formatBytes(artifact.size_bytes))}</td><td class="mono">${h(artifact.sha256.slice(0, 12))}</td><td>${h(formatTime(artifact.created_at, true))}</td><td><a href="/api/v1/artifacts/${encodeURIComponent(artifact.id)}/download" class="muted">Download</a></td></tr>`).join('')}</tbody></table>` : '<div class="empty"><div><strong>No artifacts yet</strong><p>Promote a file from the Files tab to preserve it independently of the workspace.</p></div></div>'}</div></section>`;
}

function renderTaskRows(tasks) {
  if (!tasks.length) return '<div class="empty"><div><strong>No tasks yet</strong><p>Detached command tasks will remain durable while the browser is closed.</p></div></div>';
  return tasks.map((task) => `<div class="event-row"><time class="event-time">${h(formatTime(task.created_at))}</time><i class="state-dot ${h(task.state)}"></i><div><strong>${h(task.title)}</strong><small>${h(task.type)} · <span class="status-pill ${h(task.state)}">${h(task.state)}</span></small></div></div>`).join('');
}

async function renderAgentTasks(agent) {
  const tasks = state.tasks.filter((task) => task.assigned_agent_instance_id === agent.id);
  $('#agent-content').innerHTML = `<section class="panel"><div class="panel-header"><h2>Agent tasks</h2><span>${tasks.length} total</span></div><div class="panel-body task-list">${renderTaskRows(tasks)}</div></section>`;
}

async function renderInstructions(agent) {
  const policy = await api(`/api/v1/agent-instances/${encodeURIComponent(agent.id)}/policy`);
  const activeRevision = policy.effective?.agent_instruction_revision || 0;
  $('#agent-content').innerHTML = `<section class="panel instruction-card">
    <div class="panel-header"><h2>${agent.orchestration_role === 'main' ? 'Master' : 'Worker'} instructions</h2><span>saved r${h(policy.instruction_revision)} · active r${h(activeRevision)}</span></div>
    <form id="agent-instructions-form" class="instruction-editor" data-revision="${h(policy.instruction_revision)}">
      <label for="agent-custom-instructions">Custom instructions</label>
      <textarea id="agent-custom-instructions" name="instructions" maxlength="4000" placeholder="A few durable preferences for this agent…">${h(policy.custom_instructions || '')}</textarea>
      <div class="instruction-actions"><span>${policy.stale ? 'Saved changes need a restart.' : 'Active now.'} Keep this short; trust the agent’s judgment.</span><div><button type="submit" name="apply" value="save">Save</button><button type="submit" class="primary" name="apply" value="restart">Save & restart</button></div></div>
    </form>
    <details class="policy-details"><summary>Full instruction preview</summary><div class="markdown-body">${renderMarkdown(policy.preview)}</div></details>
    ${policy.stale && policy.effective ? `<details class="policy-details"><summary>Currently active snapshot</summary><div class="markdown-body">${renderMarkdown(policy.effective.rendered_instructions)}</div></details>` : ''}
  </section>`;
}

async function renderMetadata(agent) {
  const [policy, accountUsage] = await Promise.all([
    api(`/api/v1/agent-instances/${encodeURIComponent(agent.id)}/policy`),
    api('/api/v1/account-usage'),
  ]);
  const fields = {
    'Agent instance': agent.id,
    'Profile': `${agent.profile_name} (${agent.profile_id})`,
    'Project': `${agent.project_name} (${agent.project_id})`,
    'Node': `${agent.node_name} (${agent.node_id})`,
    'Orchestration role': agent.orchestration_role === 'main' ? 'Main agent' : 'Worker agent',
    'Behavior control': agent.can_edit_behavior ? 'Scoped project + system edits, only by explicit user request' : 'None; native harness defaults are preserved',
    'Logical thread': agent.active_thread_id,
    'Terminal': agent.terminal_id,
    'Resumability': agent.resumability,
    ...(agent.codex_capable ? { 'Codex session': agent.codex_session
      ? `External ${agent.codex_session.selector === 'last' ? 'latest-in-project' : agent.codex_session.session_id}`
      : 'WebSpider-managed; crash recovery resumes the latest local session when available' } : {}),
    'Portal filesystem scope': 'workspace-only',
    'Agent execution scope': 'host user',
    'Instruction snapshot': policy.effective ? `${policy.effective.id} · system r${policy.effective.system_policy_revision} · project r${policy.effective.policy_revision}` : 'Applied when the agent next starts',
    'Instruction mode': agent.orchestration_role === 'main' ? 'Main-agent defaults and control boundary' : 'Sparse task-relevant constraints; native harness retained',
    'Inbound time context': 'Message UTC · delivery UTC · elapsed since prior inbound',
    ...(agent.orchestration_role === 'main' ? {
      'Weekly account allowance': accountUsageLabel(accountUsage),
      'Account actions': 'Observation only; resets, credits, billing, authentication, and API funding are human-only',
    } : {}),
    'Agreement state': policy.stale ? 'Updated defaults available; restart to apply' : 'Current',
    'Created': formatTime(agent.created_at, true),
    'Last activity': formatTime(agent.last_activity_at, true),
  };
  $('#agent-content').innerHTML = `<dl class="metadata-grid">${Object.entries(fields).map(([key, value]) => `<dt>${h(key)}</dt><dd class="${String(value).includes('_') ? 'mono' : ''}">${h(value)}</dd>`).join('')}</dl>`;
}

async function renderNodes() {
  state.selectedProject = null;
  state.selectedAgent = null;
  renderSidebar();
  $('#main-view').innerHTML = `<div class="page">${pageHeader('Nodes', 'Outbound authenticated worker connections')}<div class="page-content"><section class="panel"><div class="panel-header"><h2>Node fabric</h2><span>${state.nodes.length} enrolled</span></div><div class="panel-body"><table class="data-table"><thead><tr><th>Node</th><th>Status</th><th>Epoch</th><th>Last seen</th><th>Capabilities</th></tr></thead><tbody>${state.nodes.map((node) => `<tr><td><strong>${h(node.display_name)}</strong><br><span class="mono muted">${h(node.id)}</span></td><td><span class="status-pill ${h(node.status)}">${h(node.status)}</span></td><td>${h(node.connection_epoch)}</td><td>${h(formatTime(node.last_seen_at, true))}</td><td class="mono">${h(Object.keys(node.capabilities || {}).join(', '))}</td></tr>`).join('')}</tbody></table></div></section></div></div>`;
}

async function renderAudit() {
  state.selectedProject = null;
  state.selectedAgent = null;
  const data = await api('/api/v1/audit?limit=300');
  $('#main-view').innerHTML = `<div class="page">${pageHeader('Audit', 'Actual actors, policy decisions, and durable effects')}<div class="page-content"><section class="panel"><div class="panel-header"><h2>Mutation history</h2><span>${data.audit.length} records</span></div><div class="panel-body"><table class="data-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Decision</th></tr></thead><tbody>${data.audit.map((item) => `<tr><td>${h(formatTime(item.created_at, true))}</td><td class="mono">${h(item.actor_id)}</td><td>${h(item.action)}</td><td class="mono">${h(item.target_id)}</td><td>${h(item.decision)}</td></tr>`).join('')}</tbody></table></div></section></div></div>`;
}

async function renderAllTasks() {
  state.selectedProject = null;
  state.selectedAgent = null;
  $('#main-view').innerHTML = `<div class="page">${pageHeader('Tasks', 'Durable scheduling and detached execution')}<div class="page-content"><section class="panel"><div class="panel-header"><h2>Task registry</h2><span>${state.tasks.length} total</span></div><div class="panel-body task-list">${renderTaskRows(state.tasks)}</div></section></div></div>`;
}

async function refreshNotes() {
  const data = await api('/api/v1/notes');
  state.notes = data.notes;
}

async function renderNotes(noteId = state.selectedNoteId) {
  state.selectedProject = null;
  state.selectedAgent = null;
  closeTerminal();
  renderSidebar();
  const selected = noteId && state.notes.some((note) => note.id === noteId) ? noteId : state.notes[0]?.id || null;
  state.selectedNoteId = selected;
  const note = selected ? await api(`/api/v1/notes/${encodeURIComponent(selected)}`) : null;
  $('#main-view').innerHTML = `<div class="page">
    ${pageHeader('Notes', 'Plaintext notes stored on this hub machine', '<button class="primary mobile-primary" data-action="new-note">New note</button>')}
    <div class="page-content notes-page">
      <aside class="notes-list" aria-label="Notes">${state.notes.length ? state.notes.map((item) => `<button class="note-row ${item.id === selected ? 'selected' : ''}" data-note-id="${h(item.id)}"><strong>${h(item.title)}</strong><span>${item.visibility === 'master' ? 'Visible to Master' : 'Just for me'} · ${h(formatTime(item.updated_at, true))}</span></button>`).join('') : '<div class="empty compact"><div><strong>No notes yet</strong><p>Create a plaintext note on the hub.</p></div></div>'}</aside>
      <section class="note-editor">${note ? `<form id="note-form" data-note-id="${h(note.id)}"><div class="note-editor-head"><input name="title" aria-label="Note title" maxlength="120" value="${h(note.title)}" required><label class="note-visibility"><input type="checkbox" name="master_visible" ${note.visibility === 'master' ? 'checked' : ''}><span>Visible to Master</span></label></div><textarea name="content" aria-label="Note text" maxlength="1048576" spellcheck="true">${h(note.content)}</textarea><div class="note-editor-actions"><span>${h(note.filename)}</span><button type="button" class="danger" data-action="delete-note">Delete</button><button type="submit" class="primary">Save</button></div></form>` : '<div class="empty"><div><strong>Select or create a note</strong><p>Notes are private unless you explicitly make one visible to the Master Spider.</p></div></div>'}</section>
    </div>
  </div>`;
  history.replaceState(null, '', selected ? `#/notes/${encodeURIComponent(selected)}` : '#/notes');
}

function connectEvents() {
  state.eventSocket?.close();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/api/v1/ws/events?after=0`);
  state.eventSocket = socket;
  socket.addEventListener('open', () => $('#connection-dot').classList.add('live'));
  socket.addEventListener('open', async () => {
    try {
      const health = await api('/healthz');
      if (health.portal_build && PORTAL_BUILD && health.portal_build !== PORTAL_BUILD) location.reload();
    } catch {}
  });
  socket.addEventListener('close', () => {
    $('#connection-dot').classList.remove('live');
    if (state.session) setTimeout(connectEvents, 1500);
  });
  socket.addEventListener('message', (message) => {
    const frame = JSON.parse(message.data);
    if (frame.type !== 'EVENT') return;
    const previousAgentState = state.selectedAgent?.state;
    clearTimeout(connectEvents.refreshTimer);
    connectEvents.refreshTimer = setTimeout(() => loadData().then(() => {
      if (state.selectedAgent) {
        if (state.tab === 'terminal' && state.selectedAgent.state !== previousAgentState) {
          renderAgent(state.selectedAgent.id, state.tab);
          return;
        }
        if (['conversation', 'activity', 'tasks', 'artifacts'].includes(state.tab)) renderAgent(state.selectedAgent.id, state.tab);
        return;
      }
      if (state.selectedProject) renderProject(state.selectedProject.id);
    }).catch(() => {}), 180);
  });
}

async function routeFromHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'overview') return renderHome();
  if (parts[0] === 'home') return openMasterTerminal();
  if (parts[0] === 'sub-spider-instructions') return renderWorkerInstructions();
  if (parts[0] === 'archived') return renderArchivedProjects();
  if (parts[0] === 'notes') return renderNotes(parts[1] ? decodeURIComponent(parts[1]) : null);
  const agentIndex = parts.indexOf('agents');
  if (agentIndex >= 0 && parts[agentIndex + 1]) return renderAgent(decodeURIComponent(parts[agentIndex + 1]), parts[agentIndex + 2] || 'terminal');
  if (parts[0] === 'projects' && parts[1]) return renderProject(decodeURIComponent(parts[1]));
  const mostRecentAgent = masterAgent() || state.agents.slice().sort((left, right) => new Date(right.last_activity_at) - new Date(left.last_activity_at))[0];
  if (mostRecentAgent) return renderAgent(mostRecentAgent.id, 'terminal');
  if (state.projects[0]) return renderProject(state.projects[0].id);
  return renderHome();
}

document.addEventListener('click', async (event) => {
  const suggested = event.target.closest('[data-suggest-message]');
  if (suggested) {
    const composer = $('#message-form textarea[name="message"]');
    if (composer) {
      composer.value = suggested.dataset.suggestMessage;
      composer.focus();
    }
    return;
  }
  const projectButton = event.target.closest('.project-heading[data-project-id], .portfolio-row[data-project-id]');
  if (projectButton) { closeMobileSidebar(); return renderProject(projectButton.dataset.projectId); }
  const agentButton = event.target.closest('[data-agent-id]');
  if (agentButton) { closeMobileSidebar(); return renderAgent(agentButton.dataset.agentId, 'terminal'); }
  const terminalButton = event.target.closest('.terminal-select[data-terminal-id]');
  if (terminalButton && state.selectedAgent) {
    state.selectedTerminalId = terminalButton.dataset.terminalId;
    closeTerminal();
    return renderTerminal(state.selectedAgent);
  }
  const noteButton = event.target.closest('.note-row[data-note-id]');
  if (noteButton) { closeMobileSidebar(); return renderNotes(noteButton.dataset.noteId); }
  const terminalView = event.target.closest('[data-terminal-view]');
  if (terminalView) {
    state.terminalView = terminalView.dataset.terminalView;
    applyTerminalView();
    updateTerminalMaths(true);
    requestAnimationFrame(fitTerminal);
    return;
  }
  const terminalInputMode = event.target.closest('[data-terminal-input-mode]');
  if (terminalInputMode) {
    state.terminalInputMode = terminalInputMode.dataset.terminalInputMode;
    const terminal = state.terminals.find((candidate) => candidate.id === state.selectedTerminalId);
    if (state.terminalInputMode === 'direct' || terminal?.kind !== 'primary_agent') requestTerminalLease();
    applyTerminalInputMode();
    return;
  }
  const previewMode = event.target.closest('[data-preview-mode]');
  if (previewMode) return setPreviewMode(previewMode.dataset.previewMode);
  const tab = event.target.closest('[data-tab]');
  if (tab && state.selectedAgent) return renderAgent(state.selectedAgent.id, tab.dataset.tab);
  const directory = event.target.closest('[data-file-dir]');
  if (directory) { state.filePath = directory.dataset.fileDir; return loadDirectory(); }
  const searchResult = event.target.closest('[data-search-path]');
  if (searchResult) {
    const relative = searchResult.dataset.searchPath;
    if (searchResult.dataset.searchKind === 'directory') { state.filePath = relative; return loadDirectory(); }
    const slash = relative.lastIndexOf('/');
    state.filePath = slash < 0 ? '' : relative.slice(0, slash);
    return previewFile(slash < 0 ? relative : relative.slice(slash + 1));
  }
  const file = event.target.closest('[data-file-name]');
  if (file) {
    if (file.dataset.fileKind === 'directory') { state.filePath = state.filePath ? `${state.filePath}/${file.dataset.fileName}` : file.dataset.fileName; return loadDirectory(); }
    return previewFile(file.dataset.fileName);
  }
  const actionTarget = event.target.closest('[data-action]');
  const action = actionTarget?.dataset.action;
  if (!action) return;
  try {
    if (action === 'master') { closeMobileSidebar(); return openMasterTerminal(); }
    if (action === 'overview') { closeMobileSidebar(); return renderHome(); }
    if (action === 'onboard-project') return showProjectOnboarding();
    if (action === 'connect-project') return showProjectConnection(event.target.closest('[data-project-id]').dataset.projectId);
    if (action === 'add-terminal') return showTerminalForm();
    if (action === 'adopt-codex-session') return showCodexSessionForm();
    if (action === 'close-modal') return closeModal();
    if (action === 'copy-worker-command') {
      const copied = await copyControlValue($('#worker-command'));
      return toast(copied ? 'Worker command copied' : 'Command selected; press Ctrl/Cmd+C to copy it.', !copied);
    }
    if (action === 'close-terminal') {
      const terminalId = actionTarget.dataset.terminalId;
      await api(`/api/v1/terminals/${encodeURIComponent(terminalId)}`, { method: 'DELETE' });
      if (state.selectedTerminalId === terminalId) state.selectedTerminalId = state.selectedAgent.terminal_id;
      toast('Terminal tab closed.');
      return renderTerminal(state.selectedAgent);
    }
    if (action === 'detach-codex-session') {
      await api(`/api/v1/agent-instances/${encodeURIComponent(state.selectedAgent.id)}/codex-session`, { method: 'DELETE' });
      closeModal();
      await loadData();
      toast('External Codex session detached; future crash recovery uses WebSpider-managed sessions.');
      return renderAgent(state.selectedAgent.id, state.tab);
    }
    if (action === 'refresh') { await loadData(); return routeFromHash(); }
    if (action === 'show-nodes') { closeMobileSidebar(); return renderNodes(); }
    if (action === 'show-worker-instructions') { closeMobileSidebar(); return renderWorkerInstructions(); }
    if (action === 'show-archived') { closeMobileSidebar(); return renderArchivedProjects(); }
    if (action === 'show-notes') { closeMobileSidebar(); return renderNotes(); }
    if (action === 'show-audit') { closeMobileSidebar(); return renderAudit(); }
    if (action === 'show-tasks') { closeMobileSidebar(); return renderAllTasks(); }
    if (action === 'toggle-hidden-files') {
      state.fileShowHidden = !state.fileShowHidden;
      return loadDirectory();
    }
    if (action === 'mobile-agents') return $('.sidebar').classList.toggle('mobile-open');
    if (action === 'show-attention') return $('#attention-panel').classList.toggle('mobile-open');
    if (action === 'show-more') {
      $('.sidebar').classList.add('mobile-open');
      $('.sidebar-footer')?.scrollIntoView({ block: 'end' });
      return;
    }
    if (action === 'archive-project') {
      const projectId = actionTarget.dataset.projectId;
      const project = state.projects.find((item) => item.id === projectId)
        || await api(`/api/v1/projects/${encodeURIComponent(projectId)}`);
      if (!confirm(`Archive ${project.name}? It will be hidden but all WebSpider history will be kept.`)) return;
      actionTarget.disabled = true;
      toast(`Archiving ${project.name}…`);
      try {
        await api(`/api/v1/projects/${encodeURIComponent(project.id)}:archive`, { method: 'POST' });
      } catch (error) {
        actionTarget.disabled = false;
        throw error;
      }
      await loadData();
      toast(`${project.name} archived.`);
      return renderArchivedProjects();
    }
    if (action === 'restore-project') {
      const project = state.archivedProjects.find((item) => item.id === actionTarget.dataset.projectId);
      if (!project) return;
      await api(`/api/v1/projects/${encodeURIComponent(project.id)}:restore`, { method: 'POST' });
      await loadData();
      toast(`${project.name} restored.`);
      return renderProject(project.id);
    }
    if (action === 'delete-project') {
      const project = state.archivedProjects.find((item) => item.id === actionTarget.dataset.projectId);
      if (!project) return;
      const confirmation = prompt(`Permanently delete WebSpider's records for ${project.name}? Workspace files will not be touched.\n\nType the project name to confirm:`);
      if (confirmation == null) return;
      await api(`/api/v1/projects/${encodeURIComponent(project.id)}`, {
        method: 'DELETE', body: { confirmation },
      });
      await loadData();
      toast(`${project.name} deleted; workspace files were not touched.`);
      return renderArchivedProjects();
    }
    if (action === 'new-note') {
      actionTarget.disabled = true;
      const editor = $('.note-editor');
      if (editor) editor.innerHTML = '<div class="loading">Creating note…</div>';
      try {
        const note = await api('/api/v1/notes', { method: 'POST', body: { title: 'Untitled note', content: '', visibility: 'private' } });
        await refreshNotes();
        return renderNotes(note.id);
      } catch (error) {
        actionTarget.disabled = false;
        await renderNotes();
        throw error;
      }
    }
    if (action === 'delete-note') {
      if (!state.selectedNoteId || !confirm('Delete this note permanently?')) return;
      await api(`/api/v1/notes/${encodeURIComponent(state.selectedNoteId)}`, { method: 'DELETE' });
      state.selectedNoteId = null;
      await refreshNotes();
      toast('Note deleted');
      return renderNotes();
    }
    if (action === 'logout') { await api('/api/v1/auth/logout', { method: 'POST' }); state.session = null; return showLogin(); }
    if (action === 'wake-agent') { await api(`/api/v1/agent-instances/${encodeURIComponent(state.selectedAgent.id)}:wake`, { method: 'POST' }); toast('Agent is ready'); await loadData(); return renderAgent(state.selectedAgent.id, state.tab); }
    if (action === 'stop-agent') { await api(`/api/v1/agent-instances/${encodeURIComponent(state.selectedAgent.id)}:stop`, { method: 'POST' }); toast('Stop requested'); await loadData(); return renderAgent(state.selectedAgent.id, state.tab); }
    if (action === 'take-control') {
      if (!state.terminalSocket || state.terminalSocket.readyState !== WebSocket.OPEN) return renderTerminal(state.selectedAgent);
      requestTerminalLease();
    }
    if (action === 'promote-artifact') {
      if (!state.previewPath) return;
      const artifact = await api(`/api/v1/roots/${encodeURIComponent(state.activeRoot.id)}/promote-artifact`, {
        method: 'POST',
        body: { path: state.previewPath, logical_name: state.previewPath.split('/').at(-1) },
      });
      toast(`Promoted ${artifact.logical_name}`);
    }
  } catch (error) { toast(friendlyError(error), true); }
});

document.addEventListener('submit', async (event) => {
  if (event.target.id === 'terminal-compose-form') {
    event.preventDefault();
    const textarea = $('#terminal-compose');
    const terminal = state.terminals.find((candidate) => candidate.id === state.selectedTerminalId);
    if (terminal?.kind === 'primary_agent') {
      const message = textarea?.value || '';
      if (!message) return;
      const button = event.target.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await api(`/api/v1/threads/${encodeURIComponent(state.selectedAgent.active_thread_id)}/messages`, {
          method: 'POST',
          headers: { 'idempotency-key': randomIdentifier() },
          body: { parts: [{ type: 'text', text: message }], delivery_role: 'user', wake_policy: 'ensure_running' },
        });
        textarea.value = '';
        textarea.focus();
      } catch (error) { toast(friendlyError(error), true); }
      finally { button.disabled = false; }
      return;
    }
    const submitted = submitTerminalComposition(textarea?.value || '');
    if (textarea && submitted) {
      textarea.value = '';
    }
    return;
  }
  if (event.target.id === 'note-form') {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await api(`/api/v1/notes/${encodeURIComponent(event.target.dataset.noteId)}`, {
        method: 'PATCH',
        body: {
          title: form.get('title'),
          content: form.get('content'),
          visibility: form.get('master_visible') ? 'master' : 'private',
        },
      });
      await refreshNotes();
      toast('Note saved');
      return renderNotes(event.target.dataset.noteId);
    } catch (error) { toast(friendlyError(error), true); }
    return;
  }
  if (event.target.id === 'onboard-project-form') {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      const result = await api('/api/v1/projects/onboard', {
        method: 'POST',
        body: { project_name: form.get('project_name'), node_name: form.get('node_name'), description: form.get('description') },
      });
      await loadData();
      showWorkerCommand(result, form.get('node_name'));
    } catch (error) { toast(friendlyError(error), true); }
    return;
  }
  if (event.target.id === 'connect-project-form') {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      const invite = await api('/api/v1/nodes/join-tokens', {
        method: 'POST',
        body: { project_id: event.target.dataset.projectId, name: form.get('node_name') },
      });
      const project = state.projects.find((item) => item.id === event.target.dataset.projectId);
      showWorkerCommand({ project, invite, hub_url: location.origin }, form.get('node_name'));
    } catch (error) { toast(friendlyError(error), true); }
    return;
  }
  if (event.target.id === 'add-terminal-form') {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      const terminal = await api(`/api/v1/agent-instances/${encodeURIComponent(state.selectedAgent.id)}/terminals`, {
        method: 'POST', body: { label: form.get('label') },
      });
      closeModal();
      state.selectedTerminalId = terminal.id;
      return renderTerminal(state.selectedAgent);
    } catch (error) { toast(friendlyError(error), true); }
    return;
  }
  if (event.target.id === 'codex-session-form') {
    event.preventDefault();
    const form = new FormData(event.target);
    const useLast = Boolean(form.get('use_last'));
    const sessionId = String(form.get('session_id') || '').trim();
    if (!useLast && !sessionId) return toast('Enter a Codex session UUID/name or select latest.', true);
    const button = event.target.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const agentId = state.selectedAgent.id;
      await api(`/api/v1/agent-instances/${encodeURIComponent(agentId)}:resume-codex`, {
        method: 'POST', body: { use_last: useLast, session_id: sessionId || null },
      });
      closeModal();
      await loadData();
      toast('Codex session adopted in the registered project directory.');
      return renderAgent(agentId, 'terminal');
    } catch (error) { toast(friendlyError(error), true); }
    finally { button.disabled = false; }
    return;
  }
  if (event.target.id === 'agent-instructions-form') {
    event.preventDefault();
    const agentId = state.selectedAgent.id;
    const form = new FormData(event.target);
    const restart = event.submitter?.value === 'restart';
    const buttons = [...event.target.querySelectorAll('button[type="submit"]')];
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const update = await api(`/api/v1/agent-instances/${encodeURIComponent(agentId)}/instructions`, {
        method: 'PATCH',
        body: {
          instructions: form.get('instructions'),
          expected_revision: Number(event.target.dataset.revision),
        },
      });
      if (restart) await api(`/api/v1/agent-instances/${encodeURIComponent(agentId)}:restart`, { method: 'POST' });
      await loadData();
      toast(restart
        ? `${update.changed ? 'Instructions saved' : 'Instructions unchanged'}; agent restarted.`
        : update.changed ? 'Instructions saved; restart when ready.' : 'Instructions unchanged.');
      return renderAgent(agentId, 'instructions');
    } catch (error) { toast(friendlyError(error), true); }
    finally { buttons.forEach((button) => { button.disabled = false; }); }
    return;
  }
  if (event.target.id === 'worker-instructions-form') {
    event.preventDefault();
    const form = new FormData(event.target);
    const restart = event.submitter?.value === 'restart';
    const instructions = String(form.get('instructions') || '').split(/\r?\n/)
      .map((line) => line.trim()).filter(Boolean);
    const buttons = [...event.target.querySelectorAll('button[type="submit"]')];
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const update = await api('/api/v1/system/policy', {
        method: 'PATCH',
        body: {
          expected_revision: Number(event.target.dataset.revision),
          reason: 'Owner updated shared sub-spider instructions in the portal.',
          patch: { requested_instructions: { workers: instructions } },
        },
      });
      let restarted = 0;
      if (restart) {
        const workers = state.agents.filter((agent) => agent.orchestration_role !== 'main'
          && ['ready', 'busy'].includes(agent.state));
        for (const worker of workers) {
          await api(`/api/v1/agent-instances/${encodeURIComponent(worker.id)}:restart`, { method: 'POST' });
          restarted += 1;
        }
        await loadData();
      }
      toast(restart
        ? `${update.changed ? 'Instructions saved' : 'Instructions unchanged'}; ${restarted} worker${restarted === 1 ? '' : 's'} restarted.`
        : update.changed ? 'Sub-spider instructions saved for future launches.' : 'Sub-spider instructions unchanged.');
      return renderWorkerInstructions();
    } catch (error) { toast(friendlyError(error), true); }
    finally { buttons.forEach((button) => { button.disabled = false; }); }
    return;
  }
  if (event.target.id === 'login-form') {
    event.preventDefault();
    $('#login-error').textContent = '';
    try {
      state.session = await api('/api/v1/auth/login', { method: 'POST', body: { token: new FormData(event.target).get('token') } });
      event.target.reset();
      showApp();
      await loadData();
      connectEvents();
      await routeFromHash();
    } catch (error) { $('#login-error').textContent = error.message; }
  }
  if (event.target.id === 'message-form') {
    event.preventDefault();
    const form = new FormData(event.target);
    const button = $('button[type="submit"]', event.target);
    button.disabled = true;
    try {
      await api(`/api/v1/threads/${encodeURIComponent(state.selectedAgent.active_thread_id)}/messages`, {
        method: 'POST',
        headers: { 'idempotency-key': randomIdentifier() },
        body: { parts: [{ type: 'text', text: form.get('message') }], delivery_role: 'user', wake_policy: form.get('wake') },
      });
      event.target.reset();
      await renderConversation(state.selectedAgent);
    } catch (error) { toast(friendlyError(error), true); }
    finally { button.disabled = false; }
  }
  if (event.target.id === 'project-message-form') {
    event.preventDefault();
    const form = new FormData(event.target);
    const button = $('button[type="submit"]', event.target);
    button.disabled = true;
    try {
      await api(`/api/v1/threads/${encodeURIComponent(event.target.dataset.threadId)}/messages`, {
        method: 'POST',
        headers: { 'idempotency-key': randomIdentifier() },
        body: { parts: [{ type: 'text', text: form.get('message') }], delivery_role: 'user', wake_policy: 'ensure_running' },
      });
      await loadData();
      return renderAgent(event.target.dataset.targetAgentId, 'conversation');
    } catch (error) { toast(friendlyError(error), true); }
    finally { button.disabled = false; }
  }
});

document.addEventListener('keydown', (event) => {
  if (event.target.id === 'file-search' && event.key === 'Enter') {
    event.preventDefault();
    const query = event.target.value.trim();
    if (query) searchFiles(query).catch((error) => toast(friendlyError(error), true));
    else loadDirectory().catch((error) => toast(friendlyError(error), true));
    return;
  }
});

window.addEventListener('hashchange', () => routeFromHash().catch((error) => toast(friendlyError(error), true)));

async function init() {
  const accessToken = consumeAccessToken();
  try {
    state.session = accessToken
      ? await api('/api/v1/auth/login', { method: 'POST', body: { token: accessToken } })
      : await api('/api/v1/session');
    showApp();
    await loadData();
    connectEvents();
    await routeFromHash();
  } catch (error) {
    if (error?.code === 'WS_VERSION_MISMATCH') return;
    showLogin();
  }
}

init();
