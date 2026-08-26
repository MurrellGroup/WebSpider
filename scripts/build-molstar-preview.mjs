import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(repository, 'web', 'vendor');
fs.mkdirSync(vendor, { recursive: true });

function normalizedText(value) {
  return String(value).replaceAll('\r\n', '\n').replace(/[ \t]+$/gm, '');
}

await build({
  entryPoints: [path.join(repository, 'scripts', 'molstar-preview-entry.js')],
  outfile: path.join(vendor, 'molstar-preview.mjs'),
  bundle: true,
  format: 'esm',
  minify: true,
  legalComments: 'none',
  target: ['es2022'],
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: '/* Mol* 5.4.2 · MIT · see molstar.LICENSE */' },
});
const bundlePath = path.join(vendor, 'molstar-preview.mjs');
fs.writeFileSync(bundlePath, normalizedText(fs.readFileSync(bundlePath, 'utf8')));

fs.writeFileSync(
  path.join(vendor, 'molstar.LICENSE'),
  `${normalizedText(fs.readFileSync(path.join(repository, 'node_modules', 'molstar', 'LICENSE'), 'utf8')).trim()}\n`,
);

const bundledLicenses = [
  ['immutable', 'LICENSE'],
  ['mutative', 'LICENSE'],
  ['rxjs', 'LICENSE.txt'],
  ['tslib', 'LICENSE.txt'],
].map(([packageName, filename]) => {
  const packageRoot = path.join(repository, 'node_modules', packageName);
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const license = normalizedText(fs.readFileSync(path.join(packageRoot, filename), 'utf8')).trim();
  return `${packageName} ${metadata.version}\n${'-'.repeat(packageName.length + String(metadata.version).length + 1)}\n${license}`;
});
fs.writeFileSync(
  path.join(vendor, 'molstar-THIRD-PARTY-LICENSES.txt'),
  `${bundledLicenses.join('\n\n')}\n`,
);
