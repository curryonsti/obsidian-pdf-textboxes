// Builds dist/pdf-textboxes-<version>.zip: a folder you can drop into
// <vault>/.obsidian/plugins/ (run `npm run package`, which builds first).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const dir = path.join('dist', manifest.id);
fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
for (const f of ['main.js', 'manifest.json', 'styles.css']) fs.copyFileSync(f, path.join(dir, f));
const zip = `${manifest.id}-${manifest.version}.zip`;
execFileSync('zip', ['-r', '-q', '-X', zip, manifest.id], { cwd: 'dist' });
console.log(`dist/${zip} (${(fs.statSync(path.join('dist', zip)).size / 1e6).toFixed(1)} MB)`);
