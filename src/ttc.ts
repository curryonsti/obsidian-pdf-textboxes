/**
 * Minimal TrueType collection (.ttc) support without any dependencies, so it
 * can run on the main thread: pick a face and rebuild it as a standalone .ttf
 * that both the browser (FontFace) and pdf-lib can use.
 */

const TTCF = 0x74746366; // 'ttcf'
const NAME = 0x6e616d65; // 'name'

/**
 * Returns a standalone font. For a collection, the face whose PostScript name
 * equals `preferredName` is used, otherwise the first face. Plain .ttf/.otf
 * input is returned unchanged.
 */
export function extractFace(bytes: Uint8Array, preferredName?: string): Uint8Array {
	const dv = view(bytes);
	if (dv.getUint32(0) !== TTCF) return bytes;
	const numFonts = dv.getUint32(8);
	const offsets = Array.from({ length: numFonts }, (_, i) => dv.getUint32(12 + 4 * i));
	let faceOffset = offsets[0]!;
	if (preferredName) {
		const match = offsets.find((o) => postscriptName(dv, o) === preferredName);
		if (match !== undefined) faceOffset = match;
	}
	return buildFace(bytes, dv, faceOffset);
}

function view(bytes: Uint8Array) {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function tableRecords(dv: DataView, faceOffset: number) {
	const numTables = dv.getUint16(faceOffset + 4);
	return Array.from({ length: numTables }, (_, i) => {
		const rec = faceOffset + 12 + 16 * i;
		return {
			tag: dv.getUint32(rec),
			checksum: dv.getUint32(rec + 4),
			offset: dv.getUint32(rec + 8),
			length: dv.getUint32(rec + 12),
		};
	});
}

/** PostScript name (name ID 6) of the face at `faceOffset`, or null. */
function postscriptName(dv: DataView, faceOffset: number): string | null {
	const name = tableRecords(dv, faceOffset).find((t) => t.tag === NAME);
	if (!name) return null;
	const count = dv.getUint16(name.offset + 2);
	const strings = name.offset + dv.getUint16(name.offset + 4);
	for (let i = 0; i < count; i++) {
		const r = name.offset + 6 + 12 * i;
		const platform = dv.getUint16(r);
		const nameId = dv.getUint16(r + 6);
		if (nameId !== 6) continue;
		const len = dv.getUint16(r + 8);
		const off = strings + dv.getUint16(r + 10);
		let s = '';
		if (platform === 3 || platform === 0) {
			for (let j = 0; j < len; j += 2) s += String.fromCharCode(dv.getUint16(off + j));
		} else {
			for (let j = 0; j < len; j++) s += String.fromCharCode(dv.getUint8(off + j));
		}
		return s;
	}
	return null;
}

function buildFace(bytes: Uint8Array, dv: DataView, faceOffset: number): Uint8Array {
	const tables = tableRecords(dv, faceOffset);
	const headerSize = 12 + 16 * tables.length;
	const pad = (n: number) => (n + 3) & ~3;
	const total = tables.reduce((sum, t) => sum + pad(t.length), headerSize);
	const out = new Uint8Array(total);
	const ov = new DataView(out.buffer);
	out.set(bytes.subarray(faceOffset, faceOffset + 12), 0); // sfnt version + search fields
	let pos = headerSize;
	tables.forEach((t, i) => {
		const rec = 12 + 16 * i;
		ov.setUint32(rec, t.tag);
		ov.setUint32(rec + 4, t.checksum);
		ov.setUint32(rec + 8, pos);
		ov.setUint32(rec + 12, t.length);
		out.set(bytes.subarray(t.offset, t.offset + t.length), pos);
		pos += pad(t.length);
	});
	return out;
}
