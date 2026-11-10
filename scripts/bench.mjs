// Bake benchmark + correctness check, run with `npm run bench [-- input.pdf]`.
// Without an argument it builds a 194-page PDF by joining the four PTT lectures
// from the test vault. Writes bench-out/baked.pdf for inspection.
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const out = 'bench-out';
fs.mkdirSync(out, { recursive: true });
await esbuild.build({
	entryPoints: ['scripts/bench-entry.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: `${out}/bench-entry.mjs`,
	logLevel: 'silent',
});
const { bakePdf, extractFace, PDFDocument } = await import(path.resolve(`${out}/bench-entry.mjs`));

// Usage: npm run bench -- some.pdf [repeat]   (repeat: join the PDF N times, default 4)
const source = process.argv[2];
if (!source) {
	console.error('Usage: npm run bench -- some.pdf [repeat]');
	process.exit(1);
}
const repeat = Number(process.argv[3] ?? 4);
const merged = await PDFDocument.create();
for (let r = 0; r < repeat; r++) {
	const src = await PDFDocument.load(fs.readFileSync(source));
	(await merged.copyPages(src, src.getPageIndices())).forEach((p) => merged.addPage(p));
}
const input = `${out}/large-test.pdf`;
fs.writeFileSync(input, await merged.save());

const original = fs.readFileSync(input);
const fallback = new Uint8Array(fs.readFileSync('node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf'));
const helvetica = '/System/Library/Fonts/Helvetica.ttc';
const primary = fs.existsSync(helvetica) ? extractFace(new Uint8Array(fs.readFileSync(helvetica)), 'Helvetica') : null;
console.log(`main font: ${primary ? 'Helvetica' : 'DejaVu Sans only'}`);

const src = await PDFDocument.load(original);
const pageCount = src.getPageCount();
const boxes = [];
for (let p = 1; p <= pageCount; p += 1) {
	const { width, height } = src.getPage(p - 1).getSize();
	boxes.push({
		id: `b${p}`,
		page: p,
		x: 40,
		y: height - 40,
		text: `Notiz Seite ${p}: Größe, Übung, äöü ÄÖÜ ß\nZweite Zeile: α σ² χ² ≤ → € x̄ ∈ ∪ x₁`,
		fontSize: 14,
		color: '#d00000',
	});
	if (p === 1) boxes.push({ id: 'corner', page: 1, x: width - 120, y: 30, text: 'unten rechts', fontSize: 10, color: '#0044cc' });
}

for (let run = 1; run <= 3; run += 1) {
	const t0 = performance.now();
	const baked = await bakePdf(new Uint8Array(original), boxes, { primary, fallback });
	const ms = performance.now() - t0;
	console.log(`run ${run}: ${pageCount} pages, ${boxes.length} boxes, ${(original.length / 1e6).toFixed(2)} MB -> ${(baked.length / 1e6).toFixed(2)} MB in ${ms.toFixed(0)} ms`);
	if (run === 3) fs.writeFileSync(`${out}/baked.pdf`, baked);
}
