import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  installUserService,
  renderLaunchAgent,
  renderSystemdUserUnit,
  uninstallUserService,
} from '../src/lib/service-manager.js';

test('Linux service installation enables a boot-persistent user service', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-service-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: command === 'systemctl' && args.includes('is-active') ? 'active\n' : '' };
  };
  const result = installUserService({
    executable: path.join(home, 'bin', 'webspider'),
    workspace: path.join(home, 'Research Project'),
    stateDir: path.join(home, 'state'),
    platform: 'linux',
    home,
    username: 'researcher',
    environmentPath: `${home}/bin:/usr/bin:/bin`,
    run,
  });
  assert.equal(result.boot_persistent, true);
  const unit = fs.readFileSync(result.service_file, 'utf8');
  assert.match(unit, /Restart=always/);
  assert.match(unit, /KillMode=process/);
  assert.match(unit, /Research Project/);
  assert(calls.some((call) => call.join(' ') === 'loginctl enable-linger researcher'));
  assert(calls.some((call) => call.join(' ') === 'systemctl --user enable --now webspider.service'));
  assert(calls.some((call) => call.join(' ') === 'systemctl --user restart webspider.service'));
  const removed = uninstallUserService({ platform: 'linux', home, run });
  assert.equal(removed.removed, true);
  assert.equal(fs.existsSync(result.service_file), false);
});

test('service definitions preserve executable, workspace, state, and restart semantics', () => {
  const unit = renderSystemdUserUnit({
    executable: '/home/me/.local/bin/webspider',
    workspace: '/home/me/project',
    stateDir: '/home/me/.local/share/webspider',
    environmentPath: '/home/me/.local/bin:/usr/bin:/bin',
  });
  assert.match(unit, /ExecStart=.*webspider.*up.*--workspace.*project.*--state-dir/);
  const plist = renderLaunchAgent({
    executable: '/Users/me/.local/bin/webspider',
    workspace: '/Users/me/project & notes',
    stateDir: '/Users/me/Library/Application Support/WebSpider',
    environmentPath: '/usr/local/bin:/usr/bin:/bin',
  });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /project &amp; notes/);
});
