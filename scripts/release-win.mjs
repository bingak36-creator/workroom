import { spawn } from 'node:child_process';
import { promises as fs, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64에서 빌드와 UI 검증을 실행하세요.');
const outputName = process.env.WORKROOM_OUTPUT_DIR || 'release-win-preview';
const output = path.join(root, outputName);

async function run(executable, args, extra = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...extra }, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} exited ${code}`)));
  });
}
const node = (script, args = [], extra = {}) => run(process.execPath, [path.join(root, script), ...args], extra);

await node('scripts/check-release.mjs');
await node('scripts/verify.mjs');
await node('scripts/smoke.mjs');
await node('node_modules/electron-builder/out/cli/cli.js', ['--config', 'electron-builder.config.cjs', '--win', '--x64', '--publish', 'never'], {
  WORKROOM_OUTPUT_DIR: outputName,
  WORKROOM_SIGNED_RELEASE: '0',
  CSC_IDENTITY_AUTO_DISCOVERY: 'false'
});
const app = path.join(output, 'win-unpacked', 'Workroom.exe');
await fs.access(app);
await node('scripts/smoke.mjs', [], { WORKROOM_APP: app });

const checksums = [];
for (const file of (await fs.readdir(output)).filter(name => /\.(?:exe|zip)$/.test(name)).sort()) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(output, file))) hash.update(chunk);
  checksums.push(`${hash.digest('hex')}  ${file}`);
}
if (checksums.length !== 2) throw new Error('Windows installer and ZIP were not both created.');
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const manifest = { at: new Date().toISOString(), version: pkg.version, electron: pkg.devDependencies.electron,
  platform: 'win32', arch: 'x64', signing: 'unsigned preview', published: false,
  checksums: checksums.map(line => ({ sha256: line.slice(0, 64), file: line.slice(66) })) };
await fs.writeFile(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
