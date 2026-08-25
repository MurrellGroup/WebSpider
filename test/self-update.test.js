import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fleetUpdateArgv, parseReleaseBootstrap, resolveLatestReleaseVersion, WEBSPIDER_VERSION } from '../src/lib/self-update.js';

test('official latest-release bootstraps resolve to a bounded fixed version', async () => {
  const source = "#!/bin/sh\nrepository='MurrellGroup/WebSpider'\nversion='9.8.7'\n";
  assert.equal(parseReleaseBootstrap(source), '9.8.7');
  assert.equal(await resolveLatestReleaseVersion(async () => new Response(source)), '9.8.7');
  assert.throws(() => parseReleaseBootstrap(source.replace('MurrellGroup/WebSpider', 'attacker/repo')),
    (error) => error.code === 'WS_UPDATE_UNTRUSTED');
});

test('fleet updater pins the release and preserves role-specific installer semantics', () => {
  const argv = fleetUpdateArgv({
    version: '9.8.7', role: 'node', hubURL: 'http://100.64.0.1:7340', stateDir: '/state',
  });
  assert.deepEqual(argv.slice(0, 3), ['/bin/sh', '-c', argv[2]]);
  assert.match(argv[2], /releases\/download\/v\$\{version\}\/WebSpider_Install\.run/);
  assert.match(argv[2], /--node "\$hub_url"/);
  assert.match(argv[2], /--state-dir "\$state_dir"/);
  assert.equal(argv[4], '9.8.7');
  assert.equal(argv[5], 'node');
});

test('package, portal, and fleet protocol use one release version', () => {
  const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(WEBSPIDER_VERSION, packageVersion);
});

test('the detached updater passes preserved node state to the verified installer bootstrap', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-update-command-'));
  const bin = path.join(directory, 'bin');
  const workspace = path.join(directory, 'workspace');
  const bootstrap = path.join(directory, 'bootstrap.sh');
  const capture = path.join(directory, 'installer-args.txt');
  fs.mkdirSync(bin);
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ] || [ "$1" = --output ]; then output=$2; shift 2; else shift; fi
done
cp "$WEBSPIDER_FAKE_BOOTSTRAP" "$output"
`);
  fs.chmodSync(path.join(bin, 'curl'), 0o700);
  fs.writeFileSync(bootstrap, '#!/bin/sh\nprintf "%s\\n" "$@" > "$WEBSPIDER_CAPTURE"\n');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const argv = fleetUpdateArgv({
    version: '9.8.7', role: 'node', hubURL: 'http://100.64.0.1:7340', stateDir: '/private/node-state',
  });
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: workspace,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || ''}`,
      WEBSPIDER_FAKE_BOOTSTRAP: bootstrap,
      WEBSPIDER_CAPTURE: capture,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(capture, 'utf8').trim().split('\n'), [
    '--node', 'http://100.64.0.1:7340', '--workspace', fs.realpathSync(workspace), '--state-dir', '/private/node-state',
  ]);
});
