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
const windowSize = process.env.WEBSPIDER_LATEX_WINDOW || '1440,1000';
const base = ['\\documentclass{article}', '\\begin{document}', 'Opening sentence.', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'Closing sentence.', '\\end{document}'].join('\n');
const proposal = ['\\documentclass{article}', '\\begin{document}', 'A clearer opening sentence.', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'A stronger closing sentence.', '\\end{document}'].join('\n');
let currentSource = base;
let currentEtag = 'W/"base"';
const transfers = new Map();
const writtenFiles = new Map();
let deliveredMessage = null;
const review = {
  id: 'lrv_browser', rootId: 'root-one', agentId: 'agent-one', agentTitle: 'Writer', threadId: 'thread-one',
  path: 'main.tex', basePath: '.webspider/latex-review-lrv_browser-base.tex',
  proposalPath: '.webspider/latex-review-lrv_browser-proposal.tex', baseEtag: 'W/"base"',
  selection: { from: 41, to: 58, fromLine: 3, fromColumn: 1, toLine: 3, toColumn: 18 },
  instruction: 'Polish the opening and closing.', status: 'ready', decisions: {}, createdAt: new Date().toISOString(),
};

function sendJSON(response, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
  response.end(body);
}

async function readJSON(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const injected = `<script>
localStorage.setItem('webspider_latex_reviews_v1', ${JSON.stringify(JSON.stringify([review]))});
const waitFor = async (description, predicate) => {
  for (let index = 0; index < 400; index += 1) {
    const value = predicate(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for '+description);
};
(async () => {
  const file = await waitFor('LaTeX file row', () => document.querySelector('[data-file-path="main.tex"]'));
  file.click();
  await waitFor('CodeMirror editor', () => document.querySelector('.latex-editor-host .cm-editor'));
  document.querySelector('[data-action="toggle-latex-fullscreen"]').click();
  const fullscreen = document.querySelector('#app-shell').classList.contains('latex-focus-mode');
  document.querySelector('[data-action="toggle-latex-fullscreen"]').click();
  await waitFor('Overleaf status', () => document.querySelector('.overleaf-summary')?.textContent.includes('project123'));
  await fetch('/api/v1/roots/root-one/overleaf/versions?directory=&file=main.tex');
  document.querySelector('[data-overleaf-diff-file="main.tex"]').click();
  for (let index = 0; index < 50 && !document.querySelector('.overleaf-version-grid'); index += 1) await new Promise(resolve => setTimeout(resolve, 20));
  if (!document.querySelector('.overleaf-version-grid')) throw new Error('Overleaf diff failed: '+(document.querySelector('#overleaf-diff-host')?.textContent || 'missing host'));
  const cards = await waitFor('two review chunks', () => document.querySelectorAll('.latex-diff-card').length === 2 && [...document.querySelectorAll('.latex-diff-card')]);
  cards[0].querySelector('[data-decision="accepted"]').click();
  document.querySelectorAll('.latex-diff-card')[1].querySelector('[data-decision="rejected"]').click();
  await waitFor('mixed decisions', () => document.querySelectorAll('.latex-diff-card.accepted').length === 1 && document.querySelectorAll('.latex-diff-card.rejected').length === 1);
  document.querySelector('[data-action="apply-latex-review"]').click();
  await waitFor('accepted source applied', () => document.querySelector('.latex-review-head')?.textContent.includes('Applied'));
  const sourceContent = document.querySelector('.cm-content'); sourceContent.focus();
  sourceContent.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 80));
  document.querySelector('[data-action="tag-latex-selection"]').click();
  const reviewForm = await waitFor('selection review form', () => document.querySelector('#latex-review-form'));
  reviewForm.querySelector('input[name="instruction"]').value = 'Make this declaration clearer.';
  reviewForm.requestSubmit();
  await waitFor('review request delivered', () => document.querySelector('.latex-review-head')?.textContent.includes('Waiting for agent'));
  const saved = await (await fetch('/test/source')).json();
  const delivered = await (await fetch('/test/message')).json();
  const result = document.createElement('pre'); result.id = 'latex-review-result';
  result.textContent = JSON.stringify({
    editor: document.querySelector('.cm-content')?.textContent.includes('A clearer opening sentence.'),
    chunks: document.querySelectorAll('.latex-diff-card').length,
    keptRejectedText: saved.source.includes('Closing sentence.') && !saved.source.includes('A stronger closing sentence.'),
    applied: document.querySelector('[data-review="lrv_browser"] .latex-review-head')?.textContent.includes('Applied'),
    compactRequest: delivered.message.includes('Follow .webspider/LATEX_REVIEW.md (protocol v1).') && !delivered.message.includes('\\documentclass'),
    overleafDiff: document.querySelectorAll('.overleaf-version-grid pre').length === 2,
    fullscreen,
    selectionBasket: Boolean(document.querySelector('.latex-selection-bar')),
  });
  document.body.append(result);
  document.querySelector('[data-action="toggle-latex-fullscreen"]').click();
})().catch(error => { const result = document.createElement('pre'); result.id = 'latex-review-error'; result.textContent = error.stack; document.body.append(result); });
</script>`;

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/healthz') return sendJSON(response, { version, portal_build: '' });
  if (url.pathname === '/api/v1/session') return sendJSON(response, { principal_id: 'browser-test' });
  if (url.pathname === '/api/v1/summary') return sendJSON(response, { projects_active: 1, agents_active: 1 });
  if (url.pathname === '/api/v1/projects') return sendJSON(response, { projects: url.searchParams.get('archived') ? [] : [{ id: 'project-one', name: 'Paper', description: '' }] });
  if (url.pathname === '/api/v1/agent-instances') return sendJSON(response, { agents: url.searchParams.get('archived') ? [] : [{ id: 'agent-one', terminal_id: 'terminal-one', project_id: 'project-one', project_name: 'Paper', node_id: 'node-one', node_name: 'node-one', title: 'Writer', profile_name: 'Codex', state: 'ready', work_status: 'idle', orchestration_role: 'worker', codex_capable: true, active_thread_id: 'thread-one' }] });
  if (url.pathname === '/api/v1/nodes') return sendJSON(response, { nodes: [] });
  if (url.pathname === '/api/v1/recovery/candidates') return sendJSON(response, { candidates: [] });
  if (url.pathname === '/api/v1/tasks') return sendJSON(response, { tasks: [] });
  if (url.pathname === '/api/v1/attention') return sendJSON(response, { items: [] });
  if (url.pathname === '/api/v1/notes') return sendJSON(response, { notes: [] });
  if (url.pathname === '/api/v1/fleet-updates/latest') return sendJSON(response, { update: null });
  if (url.pathname === '/api/v1/agent-instances/agent-one/roots') return sendJSON(response, { roots: [{ id: 'root-one', logical_name: 'workspace' }] });
  if (url.pathname === '/api/v1/roots/root-one/entries') return sendJSON(response, { entries: [{ name: 'main.tex', kind: 'file', size: base.length, mtime: new Date().toISOString() }] });
  if (url.pathname === '/api/v1/roots/root-one/overleaf/status') return sendJSON(response, {
    connected: true, directory: '', project_id: 'project123', project_url: 'https://www.overleaf.com/project/project123',
    remote_branch: 'main', local_branch: 'main', local_head: 'abc123', remote_head: 'def456',
    fetched_at: new Date().toISOString(), ahead: 1, behind: 1, dirty: [], incoming: ['main.tex'],
    outgoing: ['main.tex'], comparison: ['main.tex'], conflicts: ['main.tex'], credential_available: true,
  });
  if (url.pathname === '/api/v1/roots/root-one/overleaf/versions') return sendJSON(response, { file: 'main.tex', local: currentSource, remote: proposal, remote_ref: 'refs/remotes/overleaf/main' });
  if (url.pathname === '/api/v1/roots/root-one/preview') {
    const selected = url.searchParams.get('path');
    if (selected === 'main.tex') return sendJSON(response, { path: selected, content: currentSource, etag: currentEtag });
    if (selected === review.basePath) return sendJSON(response, { path: selected, content: base, etag: 'W/"base"' });
    if (selected === review.proposalPath) return sendJSON(response, { path: selected, content: proposal, etag: 'W/"proposal"' });
  }
  if (url.pathname === '/test/source') return sendJSON(response, { source: currentSource });
  if (url.pathname === '/test/message') return sendJSON(response, { message: deliveredMessage || '' });
  if (request.method === 'POST' && url.pathname === '/api/v1/threads/thread-one/messages') {
    const body = await readJSON(request); deliveredMessage = body.parts?.[0]?.text || '';
    return sendJSON(response, { message: { id: 'message-one' }, duplicate: false });
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/roots/root-one/file-transfers') {
    const body = await readJSON(request);
    transfers.set(body.transfer_id, { destination: body.destination_path, chunks: [] });
    return sendJSON(response, { transfer_id: body.transfer_id, destination_path: body.destination_path, received_bytes: 0 });
  }
  const chunkMatch = /^\/api\/v1\/roots\/root-one\/file-transfers\/([^/]+)\/chunks$/.exec(url.pathname);
  if (request.method === 'POST' && chunkMatch) {
    const body = await readJSON(request); const transfer = transfers.get(decodeURIComponent(chunkMatch[1]));
    transfer.chunks.push(Buffer.from(body.data_base64, 'base64'));
    return sendJSON(response, { received_bytes: body.offset + transfer.chunks.at(-1).length });
  }
  const finishMatch = /^\/api\/v1\/roots\/root-one\/file-transfers\/([^/]+):complete$/.exec(url.pathname);
  if (request.method === 'POST' && finishMatch) {
    const transfer = transfers.get(decodeURIComponent(finishMatch[1]));
    const value = Buffer.concat(transfer.chunks).toString('utf8');
    if (transfer.destination === 'main.tex') { currentSource = value; currentEtag = 'W/"saved"'; }
    else writtenFiles.set(transfer.destination, value);
    return sendJSON(response, { relative_path: transfer.destination, size_bytes: value.length, sha256: 'saved' });
  }
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const absolute = path.join(web, relative);
  if (!absolute.startsWith(web) || !fs.existsSync(absolute)) { response.writeHead(404); response.end(); return; }
  let body = fs.readFileSync(absolute);
  if (relative === 'index.html') body = Buffer.from(body.toString().replace('</body>', `${injected}</body>`));
  const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  response.writeHead(200, { 'content-type': contentTypes[path.extname(relative)] || 'application/octet-stream' }); response.end(body);
});

server.on('upgrade', (request, socket, head) => {
  const connection = acceptWebSocket(request, socket, head);
  connection?.sendJSON({ type: 'READY' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-latex-review-'));
try {
  const page = `http://127.0.0.1:${server.address().port}/#/projects/project-one/agents/agent-one/files`;
  const dom = await new Promise((resolve, reject) => {
    const chromeArgs = [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
      `--window-size=${windowSize}`, '--virtual-time-budget=20000', '--dump-dom', page,
    ];
    if (process.env.WEBSPIDER_LATEX_SCREENSHOT) chromeArgs.splice(-1, 0, `--screenshot=${process.env.WEBSPIDER_LATEX_SCREENSHOT}`);
    const chrome = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    chrome.stdout.on('data', (chunk) => { stdout += chunk; }); chrome.stderr.on('data', (chunk) => { stderr += chunk; });
    chrome.on('error', reject); chrome.on('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`Chrome exit ${code}: ${stderr}`)));
  });
  const error = dom.match(/<pre id="latex-review-error">([\s\S]*?)<\/pre>/);
  if (error) throw new Error(error[1].replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&'));
  const match = dom.match(/<pre id="latex-review-result">([^<]+)<\/pre>/);
  assert.ok(match, 'browser completed LaTeX review interaction');
  const result = JSON.parse(match[1].replaceAll('&quot;', '"'));
  assert.deepEqual(result, { editor: true, chunks: 2, keptRejectedText: true, applied: true, compactRequest: true, overleafDiff: true, fullscreen: true, selectionBasket: true });
  console.log(result);
} finally {
  server.close(); fs.rmSync(profile, { recursive: true, force: true });
}
