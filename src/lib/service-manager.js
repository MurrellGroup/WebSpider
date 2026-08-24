import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SYSTEMD_NAME = 'webspider.service';
const LAUNCHD_LABEL = 'com.webspider.fabric';
const NODE_SYSTEMD_NAME = 'webspider-node.service';
const NODE_LAUNCHD_LABEL = 'com.webspider.fabric.node';

function xml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

function systemdQuote(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

function defaultRun(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' });
}

function requireSuccess(result, action) {
  if (result?.status === 0) return;
  const detail = String(result?.stderr || result?.stdout || result?.error?.message || '').trim();
  throw new Error(`${action} failed${detail ? `: ${detail}` : ''}`);
}

export function renderSystemdUserUnit({
  executable,
  workspace,
  stateDir,
  listen = '127.0.0.1:7340',
  publicBaseURL = null,
  environmentPath,
}) {
  const command = [
    executable, 'up', '--listen', listen,
    ...(publicBaseURL ? ['--public-base-url', publicBaseURL] : []),
    '--workspace', workspace, '--state-dir', stateDir,
  ].map(systemdQuote).join(' ');
  return `[Unit]
Description=WebSpider persistent agent fabric
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${command}
Restart=always
RestartSec=3
KillMode=process
TimeoutStopSec=15
Environment=${systemdQuote(`PATH=${environmentPath}`)}

[Install]
WantedBy=default.target
`;
}

export function renderLaunchAgent({
  executable,
  workspace,
  stateDir,
  listen = '127.0.0.1:7340',
  publicBaseURL = null,
  environmentPath,
}) {
  const logDir = path.join(stateDir, 'logs');
  const argumentsList = [
    executable, 'up', '--listen', listen,
    ...(publicBaseURL ? ['--public-base-url', publicBaseURL] : []),
    '--workspace', workspace, '--state-dir', stateDir,
  ]
    .map((item) => `      <string>${xml(item)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsList}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(environmentPath)}</string></dict>
  <key>StandardOutPath</key><string>${xml(path.join(logDir, 'webspider.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logDir, 'webspider.error.log'))}</string>
</dict>
</plist>
`;
}

export function renderSystemdNodeUnit({ executable, stateDir, environmentPath }) {
  const command = [executable, 'node', '--state-dir', stateDir].map(systemdQuote).join(' ');
  return `[Unit]
Description=WebSpider persistent worker node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${command}
Restart=always
RestartSec=3
KillMode=process
TimeoutStopSec=15
Environment=${systemdQuote(`PATH=${environmentPath}`)}

[Install]
WantedBy=default.target
`;
}

export function renderNodeLaunchAgent({ executable, stateDir, environmentPath }) {
  const logDir = path.join(stateDir, 'logs');
  const argumentsList = [executable, 'node', '--state-dir', stateDir]
    .map((item) => `      <string>${xml(item)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${NODE_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsList}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(environmentPath)}</string></dict>
  <key>StandardOutPath</key><string>${xml(path.join(logDir, 'webspider-node.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logDir, 'webspider-node.error.log'))}</string>
</dict>
</plist>
`;
}

export function installUserService({
  executable,
  workspace,
  stateDir,
  listen = '127.0.0.1:7340',
  publicBaseURL = null,
  platform = process.platform,
  home = os.homedir(),
  uid = process.getuid?.(),
  username = os.userInfo().username,
  environmentPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  run = defaultRun,
} = {}) {
  const resolvedExecutable = path.resolve(executable);
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedState = path.resolve(stateDir);
  fs.mkdirSync(resolvedState, { recursive: true, mode: 0o700 });

  if (platform === 'linux') {
    const directory = path.join(home, '.config', 'systemd', 'user');
    const serviceFile = path.join(directory, SYSTEMD_NAME);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(serviceFile, renderSystemdUserUnit({
      executable: resolvedExecutable,
      workspace: resolvedWorkspace,
      stateDir: resolvedState,
      listen,
      publicBaseURL,
      environmentPath,
    }), { mode: 0o600 });
    requireSuccess(run('loginctl', ['enable-linger', username]), 'Enabling boot-time user services');
    requireSuccess(run('systemctl', ['--user', 'daemon-reload']), 'Reloading the user service manager');
    requireSuccess(run('systemctl', ['--user', 'enable', '--now', SYSTEMD_NAME]), 'Starting WebSpider');
    requireSuccess(run('systemctl', ['--user', 'restart', SYSTEMD_NAME]), 'Activating the installed WebSpider version');
    return {
      manager: 'systemd-user',
      service_file: serviceFile,
      enabled: true,
      started: true,
      boot_persistent: true,
    };
  }

  if (platform === 'darwin') {
    const directory = path.join(home, 'Library', 'LaunchAgents');
    const serviceFile = path.join(directory, `${LAUNCHD_LABEL}.plist`);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(resolvedState, 'logs'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(serviceFile, renderLaunchAgent({
      executable: resolvedExecutable,
      workspace: resolvedWorkspace,
      stateDir: resolvedState,
      listen,
      publicBaseURL,
      environmentPath,
    }), { mode: 0o600 });
    const domain = `gui/${uid}`;
    run('launchctl', ['bootout', domain, serviceFile]);
    requireSuccess(run('launchctl', ['bootstrap', domain, serviceFile]), 'Installing the WebSpider LaunchAgent');
    requireSuccess(run('launchctl', ['enable', `${domain}/${LAUNCHD_LABEL}`]), 'Enabling WebSpider');
    requireSuccess(run('launchctl', ['kickstart', '-k', `${domain}/${LAUNCHD_LABEL}`]), 'Starting WebSpider');
    return {
      manager: 'launchd',
      service_file: serviceFile,
      enabled: true,
      started: true,
      boot_persistent: true,
    };
  }

  throw new Error(`Automatic service installation is not supported on ${platform}.`);
}

export function installNodeUserService({
  executable,
  stateDir,
  platform = process.platform,
  home = os.homedir(),
  uid = process.getuid?.(),
  username = os.userInfo().username,
  environmentPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  run = defaultRun,
} = {}) {
  const resolvedExecutable = path.resolve(executable);
  const resolvedState = path.resolve(stateDir);
  fs.mkdirSync(resolvedState, { recursive: true, mode: 0o700 });

  if (platform === 'linux') {
    const directory = path.join(home, '.config', 'systemd', 'user');
    const serviceFile = path.join(directory, NODE_SYSTEMD_NAME);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(serviceFile, renderSystemdNodeUnit({
      executable: resolvedExecutable,
      stateDir: resolvedState,
      environmentPath,
    }), { mode: 0o600 });
    requireSuccess(run('loginctl', ['enable-linger', username]), 'Enabling boot-time user services');
    requireSuccess(run('systemctl', ['--user', 'daemon-reload']), 'Reloading the user service manager');
    requireSuccess(run('systemctl', ['--user', 'enable', '--now', NODE_SYSTEMD_NAME]), 'Starting the WebSpider worker node');
    requireSuccess(run('systemctl', ['--user', 'restart', NODE_SYSTEMD_NAME]), 'Activating the installed WebSpider worker version');
    return {
      manager: 'systemd-user',
      service_file: serviceFile,
      enabled: true,
      started: true,
      boot_persistent: true,
      role: 'node',
    };
  }

  if (platform === 'darwin') {
    const directory = path.join(home, 'Library', 'LaunchAgents');
    const serviceFile = path.join(directory, `${NODE_LAUNCHD_LABEL}.plist`);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(resolvedState, 'logs'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(serviceFile, renderNodeLaunchAgent({
      executable: resolvedExecutable,
      stateDir: resolvedState,
      environmentPath,
    }), { mode: 0o600 });
    const domain = `gui/${uid}`;
    run('launchctl', ['bootout', domain, serviceFile]);
    requireSuccess(run('launchctl', ['bootstrap', domain, serviceFile]), 'Installing the WebSpider worker LaunchAgent');
    requireSuccess(run('launchctl', ['enable', `${domain}/${NODE_LAUNCHD_LABEL}`]), 'Enabling the WebSpider worker');
    requireSuccess(run('launchctl', ['kickstart', '-k', `${domain}/${NODE_LAUNCHD_LABEL}`]), 'Starting the WebSpider worker');
    return {
      manager: 'launchd',
      service_file: serviceFile,
      enabled: true,
      started: true,
      boot_persistent: true,
      role: 'node',
    };
  }

  throw new Error(`Automatic worker service installation is not supported on ${platform}.`);
}

export function userServiceStatus({
  platform = process.platform,
  uid = process.getuid?.(),
  run = defaultRun,
} = {}) {
  if (platform === 'linux') {
    const result = run('systemctl', ['--user', 'is-active', SYSTEMD_NAME]);
    return { manager: 'systemd-user', active: result.status === 0, detail: String(result.stdout || '').trim() };
  }
  if (platform === 'darwin') {
    const result = run('launchctl', ['print', `gui/${uid}/${LAUNCHD_LABEL}`]);
    return { manager: 'launchd', active: result.status === 0 };
  }
  return { manager: null, active: false, detail: `Unsupported platform: ${platform}` };
}

export function nodeUserServiceStatus({
  platform = process.platform,
  uid = process.getuid?.(),
  stateDir = null,
  run = defaultRun,
} = {}) {
  let connection = null;
  if (stateDir) {
    try { connection = JSON.parse(fs.readFileSync(path.join(path.resolve(stateDir), 'connection-status.json'), 'utf8')); }
    catch { connection = { connection_state: 'unknown', updated_at: null }; }
  }
  if (platform === 'linux') {
    const result = run('systemctl', ['--user', 'is-active', NODE_SYSTEMD_NAME]);
    return { manager: 'systemd-user', active: result.status === 0, detail: String(result.stdout || '').trim(), role: 'node', connection };
  }
  if (platform === 'darwin') {
    const result = run('launchctl', ['print', `gui/${uid}/${NODE_LAUNCHD_LABEL}`]);
    return { manager: 'launchd', active: result.status === 0, role: 'node', connection };
  }
  return { manager: null, active: false, detail: `Unsupported platform: ${platform}`, role: 'node', connection };
}

export function uninstallUserService({
  platform = process.platform,
  home = os.homedir(),
  uid = process.getuid?.(),
  run = defaultRun,
} = {}) {
  if (platform === 'linux') {
    const serviceFile = path.join(home, '.config', 'systemd', 'user', SYSTEMD_NAME);
    run('systemctl', ['--user', 'disable', '--now', SYSTEMD_NAME]);
    if (fs.existsSync(serviceFile)) fs.unlinkSync(serviceFile);
    run('systemctl', ['--user', 'daemon-reload']);
    return { manager: 'systemd-user', removed: true, service_file: serviceFile };
  }
  if (platform === 'darwin') {
    const serviceFile = path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    run('launchctl', ['bootout', `gui/${uid}`, serviceFile]);
    if (fs.existsSync(serviceFile)) fs.unlinkSync(serviceFile);
    return { manager: 'launchd', removed: true, service_file: serviceFile };
  }
  throw new Error(`Automatic service removal is not supported on ${platform}.`);
}

export function uninstallNodeUserService({
  platform = process.platform,
  home = os.homedir(),
  uid = process.getuid?.(),
  run = defaultRun,
} = {}) {
  if (platform === 'linux') {
    const serviceFile = path.join(home, '.config', 'systemd', 'user', NODE_SYSTEMD_NAME);
    run('systemctl', ['--user', 'disable', '--now', NODE_SYSTEMD_NAME]);
    if (fs.existsSync(serviceFile)) fs.unlinkSync(serviceFile);
    run('systemctl', ['--user', 'daemon-reload']);
    return { manager: 'systemd-user', removed: true, service_file: serviceFile, role: 'node' };
  }
  if (platform === 'darwin') {
    const serviceFile = path.join(home, 'Library', 'LaunchAgents', `${NODE_LAUNCHD_LABEL}.plist`);
    run('launchctl', ['bootout', `gui/${uid}`, serviceFile]);
    if (fs.existsSync(serviceFile)) fs.unlinkSync(serviceFile);
    return { manager: 'launchd', removed: true, service_file: serviceFile, role: 'node' };
  }
  throw new Error(`Automatic worker service removal is not supported on ${platform}.`);
}
