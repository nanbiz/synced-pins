// Writes dist/synced-pins-<version>.zip holding exactly what the extension
// ships: manifest.json, src/ and the PNG icons.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const archive = join(root, 'dist', `synced-pins-${version}.zip`);

mkdirSync(dirname(archive), { recursive: true });
rmSync(archive, { force: true });
execFileSync('zip', ['-r', '-X', archive, 'manifest.json', 'src', 'icons', '-x', 'icons/*.svg'], { cwd: root, stdio: 'inherit' });
console.log(archive);
