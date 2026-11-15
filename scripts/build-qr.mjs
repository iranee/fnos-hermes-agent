import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2] ? resolve(process.argv[2]) : join(root, 'app/ui/scripts/qrcode.min.js');
await mkdir(dirname(output), { recursive: true });
const result = await build({
  absWorkingDir: root,
  stdin: { contents: "export { create, toCanvas, toDataURL, toString } from 'qrcode/lib/browser.js';", resolveDir: root },
  outfile: output,
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'QRCode',
  platform: 'browser',
  target: ['es2020'],
  legalComments: 'inline',
  metafile: true,
  banner: { js: '/* Third-party license texts: qrcode.LICENSE */' },
});
const packages = new Set(Object.keys(result.metafile.inputs)
  .filter(name => name.startsWith('node_modules/'))
  .map(name => name.split('/').slice(0, name.split('/')[1].startsWith('@') ? 3 : 2).join('/')));
const notices = [];
for (const directory of [...packages].sort()) {
  const pkg = JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8'));
  let license;
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'license.txt']) {
    try {
      license = await readFile(join(root, directory, name), 'utf8');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!license) throw new Error(`Missing license text: ${pkg.name}@${pkg.version}`);
  notices.push(`${pkg.name}@${pkg.version} (${pkg.license})\n${license.trim()}\n`);
}
await writeFile(join(dirname(output), 'qrcode.LICENSE'), notices.join('\n'), 'utf8');
console.log(`Built ${output}; ${packages.size} bundled package licenses included`);
