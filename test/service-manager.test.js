import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  installNodeUserService,
  installUserService,
  renderNodeLaunchAgent,
  renderLaunchAgent,
  renderSystemdNodeUnit,
  renderSystemdUserUnit,
  nodeUserServiceStatus,
  uninstallNodeUserService,
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
    listen: '0.0.0.0:7340',
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
  assert.match(unit, /--listen.*0\.0\.0\.0:7340/);
  assert.match(unit, new RegExp(`${home.replaceAll('\\', '\\\\')}/\\.local/bin`));
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
    listen: '0.0.0.0:7340',
    publicBaseURL: 'https://spider.example.edu',
    environmentPath: '/home/me/.local/bin:/usr/bin:/bin',
  });
  assert.match(unit, /ExecStart=.*webspider.*up.*--listen.*0\.0\.0\.0:7340.*--public-base-url.*spider\.example\.edu.*--workspace.*project.*--state-dir/);
  const plist = renderLaunchAgent({
    executable: '/Users/me/.local/bin/webspider',
    workspace: '/Users/me/project & notes',
    stateDir: '/Users/me/Library/Application Support/WebSpider',
    listen: '100.64.0.10:7340',
    environmentPath: '/usr/local/bin:/usr/bin:/bin',
  });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /project &amp; notes/);
  assert.match(plist, /100\.64\.0\.10:7340/);
});

test('worker services run the enrolled node persistently without starting another hub', () => {
  const unit = renderSystemdNodeUnit({
    executable: '/home/me/.local/bin/webspider',
    stateDir: '/home/me/.local/share/webspider/node',
    environmentPath: '/home/me/.local/bin:/usr/bin:/bin',
  });
  assert.match(unit, /ExecStart=.*webspider.*node.*--state-dir/);
  assert.doesNotMatch(unit, /webspider.*up|--listen/);
  const plist = renderNodeLaunchAgent({
    executable: '/Users/me/.local/bin/webspider',
    stateDir: '/Users/me/Library/Application Support/WebSpider/node',
    environmentPath: '/usr/local/bin:/usr/bin:/bin',
  });
  assert.match(plist, /com\.webspider\.fabric\.node/);
  assert.match(plist, /<string>node<\/string>/);
  assert.doesNotMatch(plist, /<string>up<\/string>/);
});

test('Linux worker service installation is boot-persistent and separately removable', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-node-service-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const run = (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '' }; };
  const result = installNodeUserService({
    executable: path.join(home, 'bin', 'webspider'),
    stateDir: path.join(home, 'state', 'node'),
    platform: 'linux', home, username: 'researcher', run,
  });
  assert.equal(result.boot_persistent, true);
  const unit = fs.readFileSync(result.service_file, 'utf8');
  assert.match(unit, /webspider-node\.service|persistent worker node/);
  assert.match(unit, new RegExp(`${home.replaceAll('\\', '\\\\')}/\\.local/bin`));
  assert(calls.some((call) => call.join(' ') === 'systemctl --user enable --now webspider-node.service'));
  const removed = uninstallNodeUserService({ platform: 'linux', home, run });
  assert.equal(removed.removed, true);
  assert.equal(fs.existsSync(result.service_file), false);
});

test('worker service status includes the last authenticated hub connection state', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-node-status-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(stateDir, 'connection-status.json'), JSON.stringify({
    connection_state: 'online', node_id: 'nod_test', connection_epoch: 3,
  }));
  const result = nodeUserServiceStatus({
    stateDir, platform: 'linux', run: () => ({ status: 0, stdout: 'active\n' }),
  });
  assert.equal(result.active, true);
  assert.equal(result.connection.connection_state, 'online');
  assert.equal(result.connection.connection_epoch, 3);
});
