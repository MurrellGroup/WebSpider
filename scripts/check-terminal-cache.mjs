import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acceptWebSocket } from '../src/transport/websocket.js';

const repository = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const web = path.join(repository, 'web');
const version = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8')).version;
const projects = [
  { id: 'project-one', name: 'Project One', description: '' },
  { id: 'project-two', name: 'Project Two', description: '' },
];
const agents = [
  { id: 'agent-one', terminal_id: 'terminal-one', project_id: 'project-one', project_name: 'Project One', node_name: 'node-one', title: 'Agent One', profile_name: 'Codex', state: 'ready', work_status: 'idle', orchestration_role: 'worker', codex_capable: true, active_thread_id: 'thread-one' },
  { id: 'agent-two', terminal_id: 'terminal-two', project_id: 'project-two', project_name: 'Project Two', node_name: 'node-two', title: 'Agent Two', profile_name: 'Codex', state: 'ready', work_status: 'idle', orchestration_role: 'worker', codex_capable: true, active_thread_id: 'thread-two' },
];
const terminals = {
  'agent-one': [
    { id: 'terminal-one', agent_instance_id: 'agent-one', kind: 'primary_agent', state: 'attached', label: 'Agent One' },
    { id: 'monitor-one', agent_instance_id: 'agent-one', kind: 'task_shell', state: 'attached', label: 'Training monitor' },
    { id: 'shell-one', agent_instance_id: 'agent-one', kind: 'shell', state: 'attached', label: 'Utility shell' },
  ],
  'agent-two': [{ id: 'terminal-two', agent_instance_id: 'agent-two', kind: 'primary_agent', state: 'attached', label: 'Agent Two' }],
};
const terminalState = new Map([
  ['terminal-one', { text: 'terminal-one-ready\r\n', sequence: 20, connections: 0, sockets: new Set() }],
  ['terminal-two', { text: 'terminal-two-ready\r\n', sequence: 20, connections: 0, sockets: new Set() }],
  ['monitor-one', { text: 'monitor-one-ready\r\n', sequence: 19, connections: 0, sockets: new Set() }],
  ['shell-one', { text: 'shell-one-ready\r\n', sequence: 17, connections: 0, sockets: new Set() }],
]);

function sendJSON(response, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
  response.end(body);
}

function appendTerminal(terminalId, text) {
  const terminal = terminalState.get(terminalId);
  const bytes = Buffer.from(text);
  const start = terminal.sequence;
  terminal.sequence += bytes.length;
  terminal.text += text;
  for (const socket of terminal.sockets) socket.sendJSON({
    type: 'OUTPUT', sequence_start: start, sequence_end: terminal.sequence, data: bytes.toString('base64'),
  });
}

const injected = `<script>
const waitFor = async (description, predicate) => {
  for (let index = 0; index < 250; index += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for '+description);
};
const output = () => document.querySelector('#terminal-output')?.textContent || '';
(async () => {
  await waitFor('first terminal snapshot', () => output().includes('terminal-one-ready'));
  document.querySelector('[data-agent-id="agent-two"]').click();
  await waitFor('second terminal snapshot', () => output().includes('terminal-two-ready'));
  await fetch('/test/append?terminal=terminal-one&text='+encodeURIComponent('background-one\\r\\n'));
  document.querySelector('[data-agent-id="agent-one"]').click();
  await waitFor('cached first terminal output', () => output().includes('background-one'));
  document.querySelector('[data-terminal-id="monitor-one"]').click();
  await waitFor('monitor terminal snapshot', () => output().includes('monitor-one-ready'));
  document.querySelector('[data-terminal-id="terminal-one"]').click();
  await waitFor('cached primary terminal', () => output().includes('background-one'));
  await fetch('/test/append?terminal=monitor-one&text='+encodeURIComponent('background-monitor\\r\\n'));
  document.querySelector('[data-terminal-id="monitor-one"]').click();
  await waitFor('cached monitor output', () => output().includes('background-monitor'));
  document.querySelector('[data-terminal-id="shell-one"]').click();
  await waitFor('shell terminal snapshot', () => output().includes('shell-one-ready'));
  document.querySelector('[data-terminal-id="terminal-one"]').click();
  await waitFor('cached primary after shell', () => output().includes('background-one'));
  await fetch('/test/append?terminal=shell-one&text='+encodeURIComponent('background-shell\\r\\n'));
  document.querySelector('[data-terminal-id="shell-one"]').click();
  await waitFor('cached shell output', () => output().includes('background-shell'));
  const stats = await (await fetch('/test/stats')).json();
  const result = document.createElement('pre');
  result.id = 'terminal-cache-result';
  result.textContent = JSON.stringify({ stats, shell: output().includes('background-shell') });
  document.body.append(result);
})().catch(error => {
  const result = document.createElement('pre'); result.id = 'terminal-cache-error'; result.textContent = error.stack; document.body.append(result);
});
</script>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/healthz') return sendJSON(response, { version, portal_build: '' });
  if (url.pathname === '/api/v1/session') return sendJSON(response, { principal_id: 'browser-test' });
  if (url.pathname === '/api/v1/summary') return sendJSON(response, { projects_active: 2, agents_active: 2 });
  if (url.pathname === '/api/v1/projects') return sendJSON(response, { projects: url.searchParams.get('archived') ? [] : projects });
  if (url.pathname === '/api/v1/agent-instances') return sendJSON(response, { agents: url.searchParams.get('archived') ? [] : agents });
  if (url.pathname === '/api/v1/nodes') return sendJSON(response, { nodes: [] });
  if (url.pathname === '/api/v1/recovery/candidates') return sendJSON(response, { candidates: [] });
  if (url.pathname === '/api/v1/tasks') return sendJSON(response, { tasks: [] });
  if (url.pathname === '/api/v1/attention') return sendJSON(response, { items: [] });
  if (url.pathname === '/api/v1/notes') return sendJSON(response, { notes: [] });
  if (url.pathname === '/api/v1/fleet-updates/latest') return sendJSON(response, { update: null });
  const terminalMatch = /^\/api\/v1\/agent-instances\/([^/]+)\/terminals$/.exec(url.pathname);
  if (terminalMatch) return sendJSON(response, { terminals: terminals[decodeURIComponent(terminalMatch[1])] || [] });
  if (url.pathname === '/test/append') {
    appendTerminal(url.searchParams.get('terminal'), url.searchParams.get('text'));
    return sendJSON(response, { ok: true });
  }
  if (url.pathname === '/test/stats') {
    return sendJSON(response, Object.fromEntries([...terminalState].map(([id, state]) => [id, state.connections])));
  }
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const absolute = path.join(web, relative);
  if (!absolute.startsWith(web) || !fs.existsSync(absolute)) { response.writeHead(404); response.end(); return; }
  let body = fs.readFileSync(absolute);
  if (relative === 'index.html') body = Buffer.from(body.toString().replace('</body>', `${injected}</body>`));
  const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  response.writeHead(200, { 'content-type': contentTypes[path.extname(relative)] || 'application/octet-stream' });
  response.end(body);
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://localhost');
  const match = /^\/api\/v1\/ws\/terminals\/([^/]+)$/.exec(url.pathname);
  const connection = acceptWebSocket(request, socket, head);
  if (!connection) return;
  if (!match) {
    connection.sendJSON({ type: 'READY' });
    return;
  }
  const terminalId = decodeURIComponent(match[1]);
  const terminal = terminalState.get(terminalId);
  terminal.connections += 1;
  terminal.sockets.add(connection);
  connection.on('close', () => terminal.sockets.delete(connection));
  connection.sendJSON({ type: 'ATTACHED', mode: 'watch', keyboard_protocol: 'kitty' });
  connection.sendJSON({ type: 'SNAPSHOT', text: terminal.text, sequence: terminal.sequence, state: 'running' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-terminal-cache-'));
try {
  const page = `http://127.0.0.1:${server.address().port}/#/projects/project-one/agents/agent-one/terminal`;
  const dom = await new Promise((resolve, reject) => {
    const chrome = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
      '--window-size=1200,800', '--virtual-time-budget=30000', '--dump-dom', page,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    chrome.stdout.on('data', (chunk) => { stdout += chunk; });
    chrome.stderr.on('data', (chunk) => { stderr += chunk; });
    chrome.on('error', reject);
    chrome.on('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`Chrome exit ${code}: ${stderr}`)));
  });
  const errorMatch = dom.match(/<pre id="terminal-cache-error">([\s\S]*?)<\/pre>/);
  if (errorMatch) throw new Error(`${errorMatch[1].replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&')}\nConnections: ${JSON.stringify(Object.fromEntries([...terminalState].map(([id, state]) => [id, state.connections])))}`);
  const match = dom.match(/<pre id="terminal-cache-result">([^<]+)<\/pre>/);
  assert.ok(match, 'browser completed terminal cache interaction');
  const result = JSON.parse(match[1].replaceAll('&quot;', '"'));
  assert.deepEqual(result.stats, { 'terminal-one': 1, 'terminal-two': 1, 'monitor-one': 1, 'shell-one': 1 });
  assert.equal(result.shell, true);
  console.log(result);
} finally {
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
