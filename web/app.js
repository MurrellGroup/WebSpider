import { renderMarkdown, stripTerminalFormatting } from './markdown.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  session: null,
  summary: {},
  projects: [],
  agents: [],
  nodes: [],
  tasks: [],
  attention: [],
  selectedProject: null,
  selectedAgent: null,
  tab: 'conversation',
  eventSocket: null,
  terminalSocket: null,
  terminalLease: null,
  terminalSequence: 0,
  terminalHeartbeat: null,
  terminalText: '',
  terminalView: localStorage.getItem('webspider_terminal_view') || 'reading',
  terminalRenderTimer: null,
  filePath: '',
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
  if (response.status === 401) {
    showLogin();
    throw new Error('Authentication required');
  }
  const type = response.headers.get('content-type') || '';
  const value = type.includes('json') ? await response.json() : await response.text();
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
  };
  return messages[error?.code] || error?.message || 'WebSpider could not complete that action.';
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

function consumeAccessToken() {
  const match = location.hash.match(/^#access_token=(.+)$/);
  if (!match) return null;
  let token = null;
  try { token = decodeURIComponent(match[1]); } catch { token = match[1]; }
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  return token;
}

async function loadData() {
  const [summary, projects, agents, nodes, tasks, attention] = await Promise.all([
    api('/api/v1/summary'),
    api('/api/v1/projects'),
    api('/api/v1/agent-instances'),
    api('/api/v1/nodes'),
    api('/api/v1/tasks'),
    api('/api/v1/attention'),
  ]);
  Object.assign(state, {
    summary,
    projects: projects.projects,
    agents: agents.agents,
    nodes: nodes.nodes,
    tasks: tasks.tasks,
    attention: attention.items,
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
        <span class="name">${h(agent.profile_name)}</span>
        <span class="adapter">${h(agent.state)}</span>
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

async function renderHome() {
  state.selectedProject = null;
  state.selectedAgent = null;
  state.terminalSocket?.close();
  renderSidebar();
  history.replaceState(null, '', '#/home');
  $('#main-view').innerHTML = `<div class="page">
    ${pageHeader('Master Spider', 'Durable intent, live execution across the fabric', '<button data-action="refresh">Refresh state</button>')}
    <div class="page-content">
      <div class="summary-strip">
        ${summaryItem(state.summary.projects_active, 'active projects')}
        ${summaryItem(state.summary.agents_active, 'active agents')}
        ${summaryItem(state.summary.tasks_running, 'tasks running')}
        ${summaryItem(state.summary.awaiting_approval, 'awaiting attention')}
        ${summaryItem(state.summary.nodes_offline, 'nodes offline')}
      </div>
      <div class="grid-2">
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
  state.terminalSocket?.close();
  renderSidebar();
  const agents = state.agents
    .filter((agent) => agent.project_id === project.id)
    .sort((left, right) => new Date(right.last_activity_at) - new Date(left.last_activity_at));
  const primaryAgent = agents.find((agent) => agent.orchestration_role === 'main') || agents[0] || null;
  const tasks = state.tasks.filter((task) => task.project_id === project.id);
  const [policy, artifacts, accountUsage] = await Promise.all([
    api(`/api/v1/projects/${encodeURIComponent(project.id)}/policy`),
    api(`/api/v1/artifacts?project=${encodeURIComponent(project.id)}`),
    api('/api/v1/account-usage'),
  ]);
  const running = tasks.filter((task) => ['running', 'runnable'].includes(task.state));
  const completed = tasks.filter((task) => task.state === 'succeeded');
  $('#main-view').innerHTML = `<div class="page">
    ${pageHeader(project.name, project.description || 'WebSpider infers routine detail from the workspace and project history', primaryAgent ? `<button class="primary" data-agent-id="${h(primaryAgent.id)}">Open agent</button>` : '')}
    <div class="page-content project-workspace">
      <section class="steer-card">
        <div><p class="eyebrow">STEER THE OUTCOME</p><h2>What should move forward?</h2><p>Give the goal at the level you care about. The agent inherits the project agreement, inspects existing work, and resolves routine implementation choices.</p></div>
        ${primaryAgent ? `<form id="project-message-form" data-target-agent-id="${h(primaryAgent.id)}" data-thread-id="${h(primaryAgent.active_thread_id)}"><textarea name="message" required placeholder="For example: turn the current results into a submission-ready manuscript draft…"></textarea><div><span>Safe defaults and validation are automatic.</span><button type="submit" class="primary">Start or continue</button></div></form>` : '<div class="empty compact"><div><strong>No project agent yet</strong><p>Connect a project-capable node; WebSpider will apply the project defaults automatically when an agent is created.</p></div></div>'}
      </section>
      <div class="project-summary">
        ${summaryItem(agents.length, 'agents')}${summaryItem(running.length, 'active tasks')}${summaryItem(completed.length, 'completed tasks')}${summaryItem(artifacts.artifacts.length, 'kept artifacts')}
      </div>
      <div class="grid-2 project-grid">
        <section class="panel"><div class="panel-header"><h2>Current work</h2><span>${running.length ? `${running.length} active` : 'nothing requires setup'}</span></div><div class="panel-body task-list">${renderTaskRows(tasks.slice(0, 8))}</div></section>
        <section class="panel policy-card"><div class="panel-header"><h2>Main-agent defaults</h2><span>system r${h(policy.system_revision)} · project r${h(policy.revision)}</span></div><div class="panel-body"><div class="policy-line"><i>1</i><div><strong>Infer routine details</strong><p>${h(policy.summary.autonomy)}</p></div></div><div class="policy-line"><i>2</i><div><strong>Produce the work product</strong><p>${h(policy.summary.work_product)}</p></div></div><div class="policy-line"><i>3</i><div><strong>Respect worker harnesses</strong><p>${h(policy.summary.delegation)}</p></div></div><div class="policy-line"><i>4</i><div><strong>Editable when you ask</strong><p>${h(policy.summary.behavior_control)} Tell the main agent what outcome you want changed; no settings form is required.</p></div></div><div class="policy-line"><i>5</i><div><strong>Weekly account allowance</strong><p>${h(accountUsageLabel(accountUsage))}</p><p>${h(policy.summary.account_quota)}</p></div></div><details class="policy-details"><summary>View the main-agent agreement</summary><div class="markdown-body">${renderMarkdown(policy.rendered_instructions)}</div></details></div></section>
      </div>
    </div>
  </div>`;
  history.replaceState(null, '', `#/projects/${encodeURIComponent(project.id)}`);
}

function renderEventRows(events) {
  if (!events.length) return '<div class="empty"><div><strong>No events yet</strong><p>Agent, task, message, and node transitions will appear here.</p></div></div>';
  return events.map((event) => `<div class="event-row">
    <time class="event-time">${h(formatTime(event.hub_timestamp))}</time><i class="event-dot"></i>
    <div><strong>${h(event.type.replace(/\.v\d+$/, '').replaceAll('.', ' · '))}</strong><small>${h(event.actor_id)} → ${h(event.subject_id)}</small></div>
  </div>`).join('');
}

function agentTabs() {
  const primary = ['conversation', 'files', 'terminal', 'artifacts'];
  const secondary = ['activity', 'tasks', 'metadata'];
  const button = (tab) => `<button class="${state.tab === tab ? 'selected' : ''}" data-tab="${tab}">${tab[0].toUpperCase()}${tab.slice(1)}</button>`;
  return `${primary.map(button).join('')}<details class="tab-more" ${secondary.includes(state.tab) ? 'open' : ''}><summary>More</summary><div>${secondary.map(button).join('')}</div></details>`;
}

async function renderAgent(agentId, tab = state.tab) {
  state.selectedAgent = state.agents.find((agent) => agent.id === agentId) || (await api(`/api/v1/agent-instances/${encodeURIComponent(agentId)}`));
  state.selectedProject = state.projects.find((project) => project.id === state.selectedAgent.project_id) || null;
  state.tab = tab;
  renderSidebar();
  const agent = state.selectedAgent;
  const resumable = ['stopped', 'failed', 'hibernated'].includes(agent.state);
  $('#main-view').innerHTML = `<div class="page">
    ${pageHeader(agent.profile_name, `${agent.node_name} · ${agent.profile_name} · last activity ${formatTime(agent.last_activity_at)}`, `
      <span class="status-pill ${h(agent.state)}">${h(agent.state)}</span>
      ${resumable ? '<button class="primary" data-action="wake-agent">Resume agent</button>' : `<details class="action-menu"><summary>Agent actions</summary><div><button class="danger" data-action="stop-agent">Stop agent</button></div></details>`}`)}
    <nav class="tabs">${agentTabs()}</nav>
    <div id="agent-content" class="page-content"><div class="loading">Loading ${h(tab)}…</div></div>
  </div>`;
  history.replaceState(null, '', `#/projects/${encodeURIComponent(agent.project_id)}/agents/${encodeURIComponent(agent.id)}/${tab}`);
  await renderAgentTab();
}

async function renderAgentTab() {
  const agent = state.selectedAgent;
  if (!agent) return;
  state.terminalSocket?.close();
  if (state.terminalHeartbeat) clearInterval(state.terminalHeartbeat);
  state.terminalHeartbeat = null;
  state.terminalSocket = null;
  if (state.tab === 'conversation') return renderConversation(agent);
  if (state.tab === 'activity') return renderActivity(agent);
  if (state.tab === 'terminal') return renderTerminal(agent);
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
  for (const byte of bytes) binary += String.fromCharCode(byte);
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

function updateTerminalReading(immediate = false) {
  clearTimeout(state.terminalRenderTimer);
  const render = () => {
    const readable = $('#terminal-readable');
    if (!readable) return;
    const normalized = stripTerminalFormatting(state.terminalText);
    readable.innerHTML = normalized.trim()
      ? renderMarkdown(normalized)
      : '<div class="terminal-reading-empty">Readable output will appear here as the agent writes.</div>';
    readable.scrollTop = readable.scrollHeight;
  };
  if (immediate) render();
  else state.terminalRenderTimer = setTimeout(render, 120);
}

async function renderTerminal(agent) {
  state.terminalText = '';
  if (!['terminal', 'reading', 'split'].includes(state.terminalView)) state.terminalView = 'reading';
  $('#agent-content').innerHTML = `<section class="terminal-shell">
    <div class="terminal-toolbar"><div class="terminal-lights"><i></i><i></i><i></i></div><span>${h(agent.node_name)} / ${h(agent.terminal_id)}</span><div class="terminal-view-switch" aria-label="Terminal view"><button data-terminal-view="reading">Readable</button><button data-terminal-view="terminal">Raw</button><button data-terminal-view="split">Split</button></div><button class="secondary" id="terminal-control" data-action="take-control">Take control</button></div>
    <div id="terminal-layout" class="terminal-layout" data-view="${h(state.terminalView)}"><pre id="terminal-output" class="terminal-output" aria-label="Raw terminal output"></pre><div id="terminal-readable" class="terminal-readable markdown-body" aria-live="polite"><div class="terminal-reading-empty">Readable output will appear here as the agent writes.</div></div></div>
    <textarea id="terminal-input" class="terminal-input" disabled aria-label="Terminal input" placeholder="Control lease required"></textarea>
  </section>`;
  applyTerminalView();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const attachment = sessionStorage.getItem('webspider_attachment') || crypto.randomUUID().replaceAll('-', '');
  sessionStorage.setItem('webspider_attachment', attachment);
  state.terminalSequence = 0;
  const socket = new WebSocket(`${protocol}//${location.host}/api/v1/ws/terminals/${encodeURIComponent(agent.terminal_id)}?attachment=${encodeURIComponent(attachment)}`);
  state.terminalSocket = socket;
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data);
    const output = $('#terminal-output');
    if (!output) return;
    if (frame.type === 'SNAPSHOT' && Number(frame.sequence || 0) >= state.terminalSequence) {
      state.terminalText = frame.text || '';
      output.textContent = state.terminalText;
      state.terminalSequence = Number(frame.sequence || 0);
      updateTerminalReading(true);
    }
    if (frame.type === 'OUTPUT' && Number(frame.sequence_end) > state.terminalSequence) {
      const bytes = base64ToBytes(frame.data);
      const overlap = Math.max(0, state.terminalSequence - Number(frame.sequence_start));
      const addition = new TextDecoder().decode(overlap ? bytes.slice(overlap) : bytes);
      state.terminalText += addition;
      output.textContent += addition;
      state.terminalSequence = Number(frame.sequence_end);
      updateTerminalReading();
    }
    if (frame.type === 'LEASE_GRANTED') {
      state.terminalLease = frame.lease;
      $('#terminal-input').disabled = false;
      $('#terminal-input').placeholder = 'Type here only when direct terminal input is needed';
      $('#terminal-control').textContent = 'In Control';
      $('#terminal-input').focus();
      if (state.terminalHeartbeat) clearInterval(state.terminalHeartbeat);
      state.terminalHeartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN && state.terminalLease) socket.send(JSON.stringify({
          type: 'HEARTBEAT',
          lease_id: state.terminalLease.id,
          lease_epoch: state.terminalLease.lease_epoch,
        }));
      }, 5_000);
    }
    if (frame.type === 'ERROR') toast(`${frame.code}: ${frame.message || 'Terminal error'}`, true);
    output.scrollTop = output.scrollHeight;
  });
  socket.addEventListener('close', () => {
    if (state.terminalHeartbeat) clearInterval(state.terminalHeartbeat);
    state.terminalHeartbeat = null;
    const button = $('#terminal-control');
    if (button) button.textContent = 'Reconnect';
  });
}

async function renderFiles(agent) {
  const data = await api(`/api/v1/agent-instances/${encodeURIComponent(agent.id)}/roots`);
  state.activeRoot = data.roots[0] || null;
  state.filePath = '';
  state.previewPath = null;
  state.previewMode = 'source';
  if (!state.activeRoot) {
    $('#agent-content').innerHTML = '<div class="empty"><div><strong>No exposed root</strong><p>This agent has no project root available to the portal.</p></div></div>';
    return;
  }
  $('#agent-content').innerHTML = `<div class="file-layout"><section class="file-pane"><div id="file-toolbar" class="file-toolbar"></div><div id="file-rows" class="file-rows"></div></section><section class="preview-pane"><div id="preview-header" class="preview-header"><strong>No file selected</strong></div><div id="preview-content" class="preview-content source-preview">Select a safe text file to preview it here. Markdown and math are rendered automatically; source is always one click away.</div></section></div>`;
  await loadDirectory();
}

async function loadDirectory() {
  const root = state.activeRoot;
  const data = await api(`/api/v1/roots/${encodeURIComponent(root.id)}/entries?path=${encodeURIComponent(state.filePath)}`);
  const parts = state.filePath ? state.filePath.split('/') : [];
  const crumbs = [{ name: root.logical_name, path: '' }, ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }))];
  $('#file-toolbar').innerHTML = `${crumbs.map((crumb) => `<button class="breadcrumb" data-file-dir="${h(crumb.path)}">${h(crumb.name)}</button>`).join('<span class="muted">/</span>')}<input id="file-search" class="file-search" placeholder="Search" aria-label="Search files">`;
  $('#file-rows').innerHTML = data.entries.length ? data.entries.map((entry) => `<button class="file-row ${h(entry.kind)}" data-file-name="${h(entry.name)}" data-file-kind="${h(entry.kind)}">
    <span class="file-icon">${entry.kind === 'directory' ? '▰' : entry.kind === 'symlink' ? '↗' : '▤'}</span><span class="file-name">${h(entry.name)}</span><span class="file-size">${h(formatBytes(entry.size))}</span><span class="file-date">${h(formatTime(entry.mtime))}</span>
  </button>`).join('') : '<div class="empty"><div><strong>Empty directory</strong><p>No visible entries in this workspace path.</p></div></div>';
}

async function previewFile(name) {
  const relative = state.filePath ? `${state.filePath}/${name}` : name;
  state.previewPath = relative;
  const markdown = /\.(?:md|markdown|qmd|rmd)$/i.test(relative);
  state.previewMode = markdown ? 'rendered' : 'source';
  $('#preview-header').innerHTML = `<strong>${h(relative)}</strong><div class="preview-actions">${markdown ? '<div class="preview-mode-switch"><button data-preview-mode="rendered" class="selected">Readable</button><button data-preview-mode="source">Source</button></div>' : ''}<button data-action="promote-artifact">Keep as artifact</button><a href="/api/v1/roots/${encodeURIComponent(state.activeRoot.id)}/download?path=${encodeURIComponent(relative)}">Download</a></div>`;
  const content = $('#preview-content');
  content.textContent = 'Loading preview…';
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

function connectEvents() {
  state.eventSocket?.close();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/api/v1/ws/events?after=0`);
  state.eventSocket = socket;
  socket.addEventListener('open', () => $('#connection-dot').classList.add('live'));
  socket.addEventListener('close', () => {
    $('#connection-dot').classList.remove('live');
    if (state.session) setTimeout(connectEvents, 1500);
  });
  socket.addEventListener('message', (message) => {
    const frame = JSON.parse(message.data);
    if (frame.type !== 'EVENT') return;
    clearTimeout(connectEvents.refreshTimer);
    connectEvents.refreshTimer = setTimeout(() => loadData().then(() => {
      if (state.selectedAgent && ['conversation', 'activity', 'tasks', 'artifacts'].includes(state.tab)) renderAgent(state.selectedAgent.id, state.tab);
      else if (state.selectedProject) renderProject(state.selectedProject.id);
    }).catch(() => {}), 180);
  });
}

async function routeFromHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'home') return renderHome();
  const agentIndex = parts.indexOf('agents');
  if (agentIndex >= 0 && parts[agentIndex + 1]) return renderAgent(decodeURIComponent(parts[agentIndex + 1]), parts[agentIndex + 2] || 'conversation');
  if (parts[0] === 'projects' && parts[1]) return renderProject(decodeURIComponent(parts[1]));
  const mostRecentAgent = state.agents.slice().sort((left, right) => new Date(right.last_activity_at) - new Date(left.last_activity_at))[0];
  if (mostRecentAgent) return renderAgent(mostRecentAgent.id, 'conversation');
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
  const projectButton = event.target.closest('[data-project-id]');
  if (projectButton) return renderProject(projectButton.dataset.projectId);
  const agentButton = event.target.closest('[data-agent-id]');
  if (agentButton) return renderAgent(agentButton.dataset.agentId, 'conversation');
  const terminalView = event.target.closest('[data-terminal-view]');
  if (terminalView) {
    state.terminalView = terminalView.dataset.terminalView;
    applyTerminalView();
    updateTerminalReading(true);
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
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  try {
    if (action === 'home') return renderHome();
    if (action === 'refresh') { await loadData(); return routeFromHash(); }
    if (action === 'show-nodes') return renderNodes();
    if (action === 'show-audit') return renderAudit();
    if (action === 'show-tasks') return renderAllTasks();
    if (action === 'mobile-agents') return $('.sidebar').classList.toggle('mobile-open');
    if (action === 'show-attention') return $('#attention-panel').classList.toggle('mobile-open');
    if (action === 'show-more') return renderNodes();
    if (action === 'logout') { await api('/api/v1/auth/logout', { method: 'POST' }); state.session = null; return showLogin(); }
    if (action === 'wake-agent') { await api(`/api/v1/agent-instances/${encodeURIComponent(state.selectedAgent.id)}:wake`, { method: 'POST' }); toast('Agent is ready'); await loadData(); return renderAgent(state.selectedAgent.id, state.tab); }
    if (action === 'stop-agent') { await api(`/api/v1/agent-instances/${encodeURIComponent(state.selectedAgent.id)}:stop`, { method: 'POST' }); toast('Stop requested'); await loadData(); return renderAgent(state.selectedAgent.id, state.tab); }
    if (action === 'take-control') {
      if (!state.terminalSocket || state.terminalSocket.readyState !== WebSocket.OPEN) return renderTerminal(state.selectedAgent);
      state.terminalSocket.send(JSON.stringify({ type: 'LEASE_REQUEST' }));
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
        headers: { 'idempotency-key': crypto.randomUUID() },
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
        headers: { 'idempotency-key': crypto.randomUUID() },
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
  if (event.target.id !== 'terminal-input' || event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  const value = event.target.value;
  if (!value || !state.terminalLease || state.terminalSocket?.readyState !== WebSocket.OPEN) return;
  const bytes = new TextEncoder().encode(`${value}\n`);
  state.terminalSocket.send(JSON.stringify({
    type: 'INPUT',
    lease_id: state.terminalLease.id,
    lease_epoch: state.terminalLease.lease_epoch,
    data: bytesToBase64(bytes),
  }));
  event.target.value = '';
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
  } catch {
    showLogin();
  }
}

init();
