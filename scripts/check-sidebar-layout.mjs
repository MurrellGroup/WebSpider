import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

// Isolated real-browser layout check: no live Hub, credentials, or agents.
const web = new URL('../web/', import.meta.url);
const html = fs.readFileSync(new URL('index.html', web), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace(/<link\b[^>]*>/g, '')
  .replace('</head>', `<style>${fs.readFileSync(new URL('styles.css', web), 'utf8')}</style></head>`)
  .replace('</body>', `<script>
document.querySelector('#login-screen')?.remove();
document.querySelectorAll('body > section').forEach(e => e.remove());
document.querySelector('#app-shell').classList.remove('hidden');
document.querySelector('.sidebar').classList.add('mobile-open');
const tree = document.querySelector('#project-tree');
tree.innerHTML = Array.from({length: 80}, (_,i) => '<div class="project-group"><button class="project-heading">Project '+i+'</button><button class="agent-link"><span></span><span class="name">Agent '+i+'</span></button></div>').join('')
  + '<details class="inactive-projects"><summary><span>Inactive projects</span><span class="inactive-count">2</span></summary><div class="inactive-project-list"><button>Hidden project one</button><button>Hidden project two</button></div></details>';
window.addEventListener('load', () => {
  const inactive = document.querySelector('.inactive-projects');
  const inactiveList = document.querySelector('.inactive-project-list');
  const inactiveHidden = getComputedStyle(inactiveList).display === 'none';
  inactive.open = true;
  const inactiveVisibleAfterOpen = getComputedStyle(inactiveList).display !== 'none';
  tree.scrollTop = tree.scrollHeight;
  const notes = document.querySelector('[data-action="show-notes"]');
  const box = notes.getBoundingClientRect();
  const result = {width: innerWidth, height: innerHeight, scrolled: tree.scrollTop,
    notesVisible: box.top >= 0 && box.bottom <= innerHeight && box.right <= innerWidth,
    sidebarHeight: document.querySelector('.sidebar').getBoundingClientRect().height,
    inactiveHidden, inactiveVisibleAfterOpen};
  const out = document.createElement('pre'); out.id='layout-result'; out.textContent=JSON.stringify(result); document.body.append(out);
});
</script></body>`);
const server = http.createServer((req,res) => { res.setHeader('Content-Type','text/html'); res.end(html); });
await new Promise(r => server.listen(0,'127.0.0.1',r));
try {
  for (const [width,height] of [[1440,900],[1024,600],[1440,420],[412,820]]) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(),'webspider-sidebar-'));
    try {
      const output = await new Promise((resolve,reject) => {
        const child = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', ['--headless=new','--no-sandbox','--disable-gpu',
          '--no-first-run', `--user-data-dir=${profile}`, `--window-size=${width},${height}`, '--virtual-time-budget=800',
          '--dump-dom', `http://127.0.0.1:${server.address().port}`], {stdio:['ignore','pipe','ignore']});
        let text=''; child.stdout.on('data',chunk=>text+=chunk); child.on('error',reject);
        child.on('exit',code=>code===0?resolve(text):reject(Error('Chrome exit '+code)));
      });
      const match = output.match(/<pre id="layout-result">([^<]+)<\/pre>/);
      assert.ok(match,'Browser produced layout measurements');
      const result=JSON.parse(match[1]); console.log(result);
      assert.ok(result.scrolled > 0,'Agent list must scroll');
      assert.ok(result.notesVisible,'Notes must stay reachable in the viewport');
      assert.ok(result.sidebarHeight <= result.height,'Sidebar must not expand beyond viewport');
      assert.ok(result.inactiveHidden,'Inactive project names must remain hidden while collapsed');
      assert.ok(result.inactiveVisibleAfterOpen,'Inactive project names must appear after opening the dropdown');
    } finally { fs.rmSync(profile,{recursive:true,force:true}); }
  }
} finally { server.close(); }
