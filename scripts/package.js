// Writes dist/synced-pins-<version>.zip holding exactly what the extension
// ships: manifest.json, src/ and the PNG icons.
//
// The service worker script is named after the version. Chromium keeps
// running the worker it registered for an unpacked extension when the same
// extension is loaded again from a new folder with a new version, as long as
// the worker's script name is unchanged, so with a fixed name an update
// loaded unpacked would keep the old code. A new name is a new script, which
// Chromium registers afresh, modules it imports included.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const { version } = manifest;
const archive = join(root, 'dist', `synced-pins-${version}.zip`);
const stage = join(root, 'dist', 'stage');
const worker = `src/background-${version}.js`;

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'icons'), { recursive: true });
cpSync(join(root, 'src'), join(stage, 'src'), { recursive: true });
renameSync(join(stage, manifest.background.service_worker), join(stage, worker));
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify({ ...manifest, background: { ...manifest.background, service_worker: worker } }, null, 2)}\n`);
for (const icon of readdirSync(join(root, 'icons')).filter((name) => name.endsWith('.png'))) {
  cpSync(join(root, 'icons', icon), join(stage, 'icons', icon));
}

rmSync(archive, { force: true });
execFileSync('zip', ['-r', '-X', archive, 'manifest.json', 'src', 'icons'], { cwd: stage, stdio: 'inherit' });
rmSync(stage, { recursive: true });
console.log(archive);
