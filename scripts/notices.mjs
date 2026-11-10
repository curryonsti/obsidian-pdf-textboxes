// Writes THIRD_PARTY_NOTICES.md for every npm package bundled into main.js
// (including the inline worker) plus the embedded DejaVu Sans font.
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

const inputs = new Set();
for (const entry of ['src/main.ts', 'src/bake.worker.ts']) {
	const r = await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		write: false,
		metafile: true,
		logLevel: 'silent',
		platform: entry.includes('worker') ? 'browser' : 'node',
		external: ['obsidian', 'electron', ...builtinModules],
		loader: { '.ttf': 'binary' },
		plugins: [{ name: 'skip-worker', setup: (b) => b.onResolve({ filter: /^worker:/ }, () => ({ path: 'w', external: true })) }],
	});
	Object.keys(r.metafile.inputs).forEach((i) => inputs.add(i));
}
const pkgs = new Map();
for (const i of inputs) {
	const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(i);
	if (m) pkgs.set(m[1], path.join('node_modules', m[1]));
}
let out = '# Third-party notices\n\nPDF Text Boxes bundles the following software. Their licences apply to the bundled parts.\n';
for (const [name, dir] of [...pkgs].sort()) {
	const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
	const lic = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
	const author = pj.author ? (typeof pj.author === 'string' ? pj.author : pj.author.name) : name;
	const text = lic
		? fs.readFileSync(path.join(dir, lic), 'utf8').trim()
		: pj.license === 'MIT'
			? MIT(author)
			: `License: ${pj.license}, ${author}`;
	out += `\n## ${name} ${pj.version} (${pj.license ?? 'see below'})\n\n\`\`\`\n${text}\n\`\`\`\n`;
}
console.log('packages:', [...pkgs.keys()].join(', '));
fs.writeFileSync('THIRD_PARTY_NOTICES.md', out);

function MIT(holder) {
	return `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
}
