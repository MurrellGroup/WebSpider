import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(repository, 'web', 'vendor');
fs.mkdirSync(vendor, { recursive: true });

await build({
  entryPoints: [path.join(repository, 'scripts', 'latex-editor-entry.js')],
  outfile: path.join(vendor, 'latex-editor.mjs'),
  bundle: true,
  format: 'esm',
  minify: true,
  legalComments: 'none',
  target: ['es2022'],
  banner: { js: '/* CodeMirror 6 · MIT · see codemirror-LICENSES.txt */' },
});

const packages = [
  'codemirror',
  '@codemirror/autocomplete',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/legacy-modes',
  '@codemirror/lint',
  '@codemirror/merge',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
  'crelt',
  'style-mod',
  'w3c-keyname',
];
const notices = packages.map((packageName) => {
  const packageRoot = path.join(repository, 'node_modules', packageName);
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const licenseName = ['LICENSE', 'LICENSE.txt'].find((name) => fs.existsSync(path.join(packageRoot, name)));
  const license = licenseName ? fs.readFileSync(path.join(packageRoot, licenseName), 'utf8').trim() : metadata.license;
  return `${packageName} ${metadata.version}\n${'-'.repeat(packageName.length + String(metadata.version).length + 1)}\n${license}`;
});
fs.writeFileSync(path.join(vendor, 'codemirror-LICENSES.txt'), `${notices.join('\n\n')}\n`);
