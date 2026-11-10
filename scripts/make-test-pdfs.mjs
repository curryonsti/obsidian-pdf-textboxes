// Builds edge-case PDFs for stress tests: node scripts/make-test-pdfs.mjs <out-dir> <some.pdf> [more.pdf ...]
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFName, PDFString, StandardFonts, degrees, rgb } from 'pdf-lib';

const [outDir, ...sources] = process.argv.slice(2);
if (!outDir || !sources.length) {
	console.error('usage: node scripts/make-test-pdfs.mjs <out-dir> <source.pdf> [...]');
	process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const save = async (name, doc) => fs.writeFileSync(path.join(outDir, name), await doc.save());

// 1. big: all sources three times
const big = await PDFDocument.create();
for (let r = 0; r < 3; r++)
	for (const s of sources) {
		const src = await PDFDocument.load(fs.readFileSync(s));
		(await big.copyPages(src, src.getPageIndices())).forEach((p) => big.addPage(p));
	}
await save(`Big ${big.getPageCount()} pages.pdf`, big);

// 2. rotated pages (0/90/180/270)
const rot = await PDFDocument.create();
const font = await rot.embedFont(StandardFonts.Helvetica);
for (const a of [0, 90, 180, 270]) {
	const p = rot.addPage([595, 842]);
	p.drawText(`Page rotated ${a}°  (top-left marker)`, { x: 40, y: 800, size: 18, font });
	p.setRotation(degrees(a));
}
await save('Rotated pages.pdf', rot);

// 3. fillable form
const form = await PDFDocument.create();
const fp = form.addPage([595, 842]);
fp.drawText('Form with two fields', { x: 40, y: 800, size: 18, font: await form.embedFont(StandardFonts.Helvetica) });
const f = form.getForm();
f.createTextField('name').addToPage(fp, { x: 40, y: 700, width: 200, height: 24 });
f.createCheckBox('agree').addToPage(fp, { x: 40, y: 650, width: 18, height: 18 });
await save('Form fields.pdf', form);

// 4. "signed": a signature dictionary with /ByteRange (structure only)
const signed = await PDFDocument.load(fs.readFileSync(sources[0]));
const sig = signed.context.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', ByteRange: [0, 0, 0, 0], Contents: PDFString.of('') });
const sigRef = signed.context.register(sig);
signed.catalog.set(PDFName.of('PTBTestSig'), sigRef);
await save('Signed (test).pdf', signed);

// 5. scanned: image-only page (no text layer)
const scan = await PDFDocument.create();
const sp = scan.addPage([595, 842]);
sp.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(0.96, 0.95, 0.9) });
for (let i = 0; i < 30; i++) sp.drawRectangle({ x: 60, y: 760 - i * 22, width: 300 + ((i * 37) % 160), height: 8, color: rgb(0.2, 0.2, 0.2) });
await save('Scanned (no text).pdf', scan);
console.log('written to', outDir);
