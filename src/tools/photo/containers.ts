// Reading and writing the metadata segments of JPEG and PNG files: the EXIF block (TIFF), the ICC
// profile, and the image size. The encoders write pixels only; these put the profile and EXIF back.
import { unzlibSync, zlibSync } from "fflate";
import { crc32 } from "../../lib/zipWriter.ts";

export interface ContainerInfo {
	width: number;
	height: number;
	/** PNG: 1, 2, 4, 8 or 16. JPEG: 8. */
	bitDepth: number;
	icc: Uint8Array | null;
	exif: Uint8Array | null;
}

const EXIF_ID = [0x45, 0x78, 0x69, 0x66, 0, 0]; // "Exif\0\0"
const ICC_ID = [...new TextEncoder().encode("ICC_PROFILE"), 0];
/** An APP2 segment holds at most 65,533 bytes of data; the ICC header takes 14 of them. */
const ICC_CHUNK = 65_519;
const SEGMENT_MAX = 65_533;

const startsWith = (b: Uint8Array, at: number, id: number[]) => id.every((v, i) => b[at + i] === v);

/* ---------- JPEG */

export function readJpeg(bytes: Uint8Array): ContainerInfo {
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Not a JPEG");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const info: ContainerInfo = { width: 0, height: 0, bitDepth: 8, icc: null, exif: null };
	const iccParts: { seq: number; data: Uint8Array }[] = [];
	let at = 2;
	while (at + 4 <= bytes.length) {
		if (bytes[at] !== 0xff) break;
		const marker = bytes[at + 1];
		if (marker === 0xff) {
			at++; // fill byte
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) break; // EOI, SOS: no more headers
		if (marker >= 0xd0 && marker <= 0xd7) {
			at += 2;
			continue;
		}
		const length = view.getUint16(at + 2);
		const body = at + 4;
		const end = at + 2 + length;
		if (end > bytes.length) break;
		if (marker === 0xe1 && startsWith(bytes, body, EXIF_ID) && !info.exif) info.exif = bytes.slice(body + 6, end);
		if (marker === 0xe2 && startsWith(bytes, body, ICC_ID))
			iccParts.push({ seq: bytes[body + 12], data: bytes.subarray(body + 14, end) });
		const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSof) {
			info.bitDepth = bytes[body];
			info.height = view.getUint16(body + 1);
			info.width = view.getUint16(body + 3);
		}
		at = end;
	}
	if (iccParts.length) {
		iccParts.sort((a, b) => a.seq - b.seq);
		info.icc = concat(iccParts.map((p) => p.data));
	}
	return info;
}

/**
 * Replaces a fresh encoder's header segments (JFIF APP0, any APP1/APP2) with EXIF and the ICC
 * profile, right after SOI. EXIF over one segment's size is dropped; returns whether it fit.
 */
export function writeJpegMeta(
	jpeg: Uint8Array,
	meta: { icc: Uint8Array | null; exif: Uint8Array | null },
): { bytes: Uint8Array; exifDropped: boolean } {
	const view = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
	let at = 2;
	// Skip the encoder's own APPn segments (MozJPEG writes JFIF APP0).
	while (at + 4 <= jpeg.length && jpeg[at] === 0xff && jpeg[at + 1] >= 0xe0 && jpeg[at + 1] <= 0xef)
		at += 2 + view.getUint16(at + 2);
	const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
	let exifDropped = false;
	if (meta.exif) {
		if (meta.exif.length + 6 <= SEGMENT_MAX) parts.push(segment(0xe1, [new Uint8Array(EXIF_ID), meta.exif]));
		else exifDropped = true;
	}
	if (meta.icc?.length) {
		const count = Math.ceil(meta.icc.length / ICC_CHUNK);
		for (let i = 0; i < count; i++) {
			const chunk = meta.icc.subarray(i * ICC_CHUNK, (i + 1) * ICC_CHUNK);
			parts.push(segment(0xe2, [new Uint8Array([...ICC_ID, i + 1, count]), chunk]));
		}
	}
	parts.push(jpeg.subarray(at));
	return { bytes: concat(parts), exifDropped };
}

function segment(marker: number, body: Uint8Array[]): Uint8Array {
	const length = body.reduce((n, b) => n + b.length, 0) + 2;
	const head = new Uint8Array([0xff, marker, length >> 8, length & 255]);
	return concat([head, ...body]);
}

/* ---------- PNG */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const type = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

interface Chunk {
	type: string;
	/** Offset of the chunk (its length field). */
	at: number;
	data: Uint8Array;
}

function chunks(png: Uint8Array): Chunk[] {
	if (!startsWith(png, 0, PNG_SIGNATURE)) throw new Error("Not a PNG");
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const out: Chunk[] = [];
	let at = 8;
	while (at + 12 <= png.length) {
		const length = view.getUint32(at);
		const t = type(png, at + 4);
		if (at + 12 + length > png.length) break;
		out.push({ type: t, at, data: png.subarray(at + 8, at + 8 + length) });
		at += 12 + length;
		if (t === "IEND") break;
	}
	return out;
}

export function readPng(bytes: Uint8Array): ContainerInfo {
	const list = chunks(bytes);
	const ihdr = list.find((c) => c.type === "IHDR");
	if (!ihdr) throw new Error("PNG without IHDR");
	const view = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
	const info: ContainerInfo = {
		width: view.getUint32(0),
		height: view.getUint32(4),
		bitDepth: ihdr.data[8],
		icc: null,
		exif: null,
	};
	const iccp = list.find((c) => c.type === "iCCP");
	if (iccp) {
		const nul = iccp.data.indexOf(0);
		try {
			if (nul > 0 && iccp.data[nul + 1] === 0) info.icc = unzlibSync(iccp.data.subarray(nul + 2));
		} catch {
			info.icc = null;
		}
	}
	const exif = list.find((c) => c.type === "eXIf");
	if (exif) info.exif = exif.data.slice();
	return info;
}

/** Puts iCCP right after IHDR and eXIf before the first IDAT; drops chunks that would conflict. */
export function writePngMeta(png: Uint8Array, meta: { icc: Uint8Array | null; exif: Uint8Array | null }): Uint8Array {
	const list = chunks(png).filter(
		(c) => !["iCCP", "sRGB", "gAMA", "cHRM", "eXIf", "iTXt", "tEXt", "zTXt"].includes(c.type),
	);
	const parts: Uint8Array[] = [new Uint8Array(PNG_SIGNATURE)];
	let exifDone = false;
	for (const c of list) {
		if (c.type === "IDAT" && !exifDone) {
			if (meta.exif?.length) parts.push(pngChunk("eXIf", meta.exif));
			exifDone = true;
		}
		parts.push(pngChunk(c.type, c.data));
		if (c.type === "IHDR" && meta.icc?.length) {
			const name = new TextEncoder().encode("ICC Profile");
			parts.push(pngChunk("iCCP", concat([name, new Uint8Array([0, 0]), zlibSync(meta.icc, { level: 9 })])));
		}
	}
	return concat(parts);
}

function pngChunk(t: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = t.charCodeAt(i);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

/* ---------- */

export function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}
