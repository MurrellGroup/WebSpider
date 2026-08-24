import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('GitHub Actions builds every supported native target before publishing a tag', () => {
  const workflow = fs.readFileSync(path.join(repository, '.github/workflows/ci-release.yml'), 'utf8');
  const readme = fs.readFileSync(path.join(repository, 'README.md'), 'utf8');
  for (const [target, runner] of [
    ['linux-x64', 'ubuntu-24.04'],
    ['linux-arm64', 'ubuntu-24.04-arm'],
    ['darwin-x64', 'macos-15-intel'],
    ['darwin-arm64', 'macos-15'],
  ]) {
    assert.match(workflow, new RegExp(`target: ${target}\\n\\s+runner: ${runner}`));
  }
  assert.match(workflow, /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow, /test "\$GITHUB_REF_NAME" = "v\$version"/);
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"/);
  assert.match(workflow, /release\/SHA256SUMS/);
  assert.match(workflow, /release\/WebSpider_Install\.run/);
  assert.match(readme, /gh release download --repo MurrellGroup\/WebSpider --pattern WebSpider_Install\.run/);
  assert.match(readme, /--dir "\$installer_dir"/);
  assert.doesNotMatch(readme, /--clobber/);
  assert.match(readme, /export GH_TOKEN=/);
  assert.doesNotMatch(readme, /OWNER\/REPOSITORY/);
  assert.match(fs.readFileSync(path.join(repository, '.gitignore'), 'utf8'), /^dist\/$/m);
});

test('installer builder refuses to cross-label a runtime', () => {
  const current = `${process.platform}-${process.arch}`;
  const wrong = current === 'linux-arm64' ? 'linux-x64' : 'linux-arm64';
  const result = spawnSync('sh', [path.join(repository, 'scripts/build-self-installer.sh')], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, WEBSPIDER_TARGET: wrong },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must be built on its target architecture/);
});

test('release bootstrap is rendered with a fixed repository and version', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'webspider-release-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, 'WebSpider_Install.run');
  const rendered = spawnSync('sh', [
    path.join(repository, 'scripts/render-release-bootstrap.sh'),
    'example/webspider',
    '9.8.7',
    output,
  ], { cwd: repository, encoding: 'utf8' });
  assert.equal(rendered.status, 0, rendered.stderr);
  const source = fs.readFileSync(output, 'utf8');
  assert.match(source, /repository='example\/webspider'/);
  assert.match(source, /version='9\.8\.7'/);
  assert.doesNotMatch(source, /@GITHUB_REPOSITORY@|@WEBSPIDER_VERSION@/);
  assert.match(source, /SHA256SUMS/);
  assert.match(source, /GH_TOKEN/);
  assert.match(source, /Authorization: Bearer/);
  assert.match(source, /Accept: application\/octet-stream/);
  assert.match(source, /api\.github\.com\/repos\/\$repository\/releases\/tags\/v\$version/);
  assert.match(source, /actual.*expected|expected.*actual/s);
  assert.equal(spawnSync('sh', ['-n', output]).status, 0);
});
