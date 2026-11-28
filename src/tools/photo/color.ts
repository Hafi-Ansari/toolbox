// Color: which space a photo is in, an exact Display P3 → sRGB conversion, and small ICC profiles
// for the two spaces when a file names its space without carrying a profile (HEIF nclx).
//
// Display P3 and sRGB share the white point (D65) and the transfer curve; only the primaries differ.
// So the conversion is: undo the curve, one 3×3 matrix, clamp, redo the curve.

export type ColorSpace = "p3" | "srgb" | "other";

/** D50-adapted colorants (ICC rXYZ, gXYZ, bXYZ), as every ICC display profile stores them. */
const COLORANTS: Record<"p3" | "srgb", number[][]> = {
	p3: [
		[0.51512, 0.2412, -0.00105],
		[0.29198, 0.69225, 0.04189],
		[0.1571, 0.06657, 0.78407],
	],
	srgb: [
		[0.43607, 0.22249, 0.01392],
		[0.38515, 0.71687, 0.09708],
		[0.14307, 0.06061, 0.7141],
	],
};

/* ---------- reading ICC */

interface IccTag {
	sig: string;
	offset: number;
	size: number;
}

function iccTags(icc: Uint8Array): { view: DataView; tags: Map<string, IccTag> } | null {
	if (icc.length < 132 || String.fromCharCode(...icc.subarray(36, 40)) !== "acsp") return null;
	const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
	const n = view.getUint32(128);
	const tags = new Map<string, IccTag>();
	for (let i = 0; i < n && 132 + i * 12 + 12 <= icc.length; i++) {
		const at = 132 + i * 12;
		const sig = String.fromCharCode(...icc.subarray(at, at + 4));
		tags.set(sig, { sig, offset: view.getUint32(at + 4), size: view.getUint32(at + 8) });
	}
	return { view, tags };
}

const s15 = (view: DataView, at: number) => view.getInt32(at) / 65536;

function xyz(view: DataView, tag: IccTag | undefined): number[] | null {
	if (!tag || tag.offset + 20 > view.byteLength) return null;
	return [s15(view, tag.offset + 8), s15(view, tag.offset + 12), s15(view, tag.offset + 16)];
}

/** Evaluates an ICC tone curve (curv or para) at x in 0..1; null when unreadable. */
function trc(view: DataView, tag: IccTag | undefined, x: number): number | null {
	if (!tag || tag.offset + 12 > view.byteLength) return null;
	const type = String.fromCharCode(
		view.getUint8(tag.offset),
		view.getUint8(tag.offset + 1),
		view.getUint8(tag.offset + 2),
		view.getUint8(tag.offset + 3),
	);
	if (type === "curv") {
		const n = view.getUint32(tag.offset + 8);
		if (n === 0) return x;
		if (n === 1) return x ** (view.getUint16(tag.offset + 12) / 256);
		if (tag.offset + 12 + n * 2 > view.byteLength) return null;
		const pos = x * (n - 1);
		const i = Math.min(n - 2, Math.floor(pos));
		const a = view.getUint16(tag.offset + 12 + i * 2) / 65535;
		const b = view.getUint16(tag.offset + 12 + (i + 1) * 2) / 65535;
		return a + (b - a) * (pos - i);
	}
	if (type === "para") {
		const fn = view.getUint16(tag.offset + 8);
		const count = [1, 3, 4, 5, 7][fn];
		if (count === undefined || tag.offset + 12 + count * 4 > view.byteLength) return null;
		const p = Array.from({ length: count }, (_, i) => s15(view, tag.offset + 12 + i * 4));
		const [g, a = 1, b = 0, c = 0, d = 0, e = 0, f = 0] = p;
		switch (fn) {
			case 0:
				return x ** g;
			case 1:
				return x >= -b / a ? (a * x + b) ** g : 0;
			case 2:
				return x >= -b / a ? (a * x + b) ** g + c : c;
			case 3:
				return x >= d ? (a * x + b) ** g : c * x;
			case 4:
				return x >= d ? (a * x + b) ** g + e : c * x + f;
		}
	}
	return null;
}

const close = (a: number[], b: number[], tolerance: number) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

/** Recognizes Display P3 and sRGB ICC profiles by their colorants and curves; anything else is "other". */
export function identifyIcc(icc: Uint8Array): ColorSpace {
	const parsed = iccTags(icc);
	if (!parsed) return "other";
	const { view, tags } = parsed;
	if (String.fromCharCode(...icc.subarray(16, 20)) !== "RGB ") return "other";
	const colorants = [xyz(view, tags.get("rXYZ")), xyz(view, tags.get("gXYZ")), xyz(view, tags.get("bXYZ"))];
	if (colorants.some((c) => !c)) return "other";
	// The sRGB curve: 0.5 → 0.2140, 0.1 → 0.0100.
	for (const t of ["rTRC", "gTRC", "bTRC"]) {
		const mid = trc(view, tags.get(t), 0.5);
		const low = trc(view, tags.get(t), 0.1);
		if (mid === null || low === null || Math.abs(mid - 0.214) > 0.006 || Math.abs(low - 0.01) > 0.003) return "other";
	}
	for (const space of ["p3", "srgb"] as const)
		if (COLORANTS[space].every((c, i) => close(c, colorants[i] as number[], 0.004))) return space;
	return "other";
}

/** HEIF nclx: primaries 1 (BT.709) and 12 (P3-D65), each with the sRGB transfer (13). */
export function identifyNclx(nclx: { primaries: number; transfer: number }): ColorSpace {
	if (nclx.transfer !== 13 && nclx.transfer !== 2 /* unspecified */) return "other";
	if (nclx.primaries === 1 || nclx.primaries === 2) return "srgb";
	if (nclx.primaries === 12) return "p3";
	return "other";
}

/* ---------- writing ICC */

const profiles = new Map<"p3" | "srgb", Uint8Array>();

/**
 * A compact ICC v2 display profile (about 600 bytes): desc, cprt, wtpt, the three colorants and a
 * shared sRGB tone curve. Written here rather than shipped as a binary, so its contents are reviewable.
 */
export function iccProfile(space: "p3" | "srgb"): Uint8Array {
	const cached = profiles.get(space);
	if (cached) return cached;
	const enc = new TextEncoder();
	const name = space === "p3" ? "Display P3" : "sRGB";
	const fixed = (v: number) => {
		const b = new Uint8Array(4);
		new DataView(b.buffer).setInt32(0, Math.round(v * 65536));
		return b;
	};
	const xyzTag = (v: number[]) => cat([enc.encode("XYZ "), new Uint8Array(4), ...v.map(fixed)]);
	const desc = (() => {
		// textDescriptionType: ASCII part, then empty Unicode and ScriptCode parts.
		const ascii = enc.encode(`${name}\0`);
		const head = new Uint8Array(12);
		head.set(enc.encode("desc"));
		new DataView(head.buffer).setUint32(8, ascii.length);
		return cat([head, ascii, new Uint8Array(4 + 4 + 2 + 1 + 67)]);
	})();
	const cprt = cat([enc.encode("text"), new Uint8Array(4), enc.encode("CC0 / public domain\0")]);
	// The sRGB curve as a 1024-entry table: exact to well under one 16-bit step.
	const curve = (() => {
		const n = 1024;
		const b = new Uint8Array(12 + n * 2);
		b.set(enc.encode("curv"));
		const v = new DataView(b.buffer);
		v.setUint32(8, n);
		for (let i = 0; i < n; i++) v.setUint16(12 + i * 2, Math.round(srgbToLinear(i / (n - 1)) * 65535));
		return b;
	})();
	const [r, g, b] = COLORANTS[space];
	const tags: [string, Uint8Array][] = [
		["desc", desc],
		["cprt", cprt],
		["wtpt", xyzTag([0.9505, 1, 1.089])],
		["rXYZ", xyzTag(r)],
		["gXYZ", xyzTag(g)],
		["bXYZ", xyzTag(b)],
		["rTRC", curve],
		["gTRC", curve],
		["bTRC", curve],
	];
	// Data blocks, each 4-byte aligned; the three TRC tags share one block.
	const blocks: Uint8Array[] = [];
	const table: { sig: string; offset: number; size: number }[] = [];
	let offset = 128 + 4 + tags.length * 12;
	const seen = new Map<Uint8Array, number>();
	for (const [sig, data] of tags) {
		const known = seen.get(data);
		if (known !== undefined) {
			table.push({ sig, offset: known, size: data.length });
			continue;
		}
		const padded = cat([data, new Uint8Array((4 - (data.length % 4)) % 4)]);
		table.push({ sig, offset, size: data.length });
		seen.set(data, offset);
		blocks.push(padded);
		offset += padded.length;
	}
	const header = new Uint8Array(128);
	const hv = new DataView(header.buffer);
	hv.setUint32(0, offset);
	hv.setUint32(8, 0x02100000); // version 2.1
	header.set(enc.encode("mntrRGB XYZ "), 12);
	hv.setUint16(24, 2026);
	hv.setUint16(26, 1);
	hv.setUint16(28, 1);
	header.set(enc.encode("acsp"), 36);
	// Rendering intent 0 (perceptual); PCS illuminant D50.
	header.set(fixed(0.9642), 68);
	header.set(fixed(1), 72);
	header.set(fixed(0.8249), 76);
	const count = new Uint8Array(4 + tags.length * 12);
	const cv = new DataView(count.buffer);
	cv.setUint32(0, tags.length);
	table.forEach((t, i) => {
		count.set(enc.encode(t.sig), 4 + i * 12);
		cv.setUint32(8 + i * 12, t.offset);
		cv.setUint32(12 + i * 12, t.size);
	});
	const out = cat([header, count, ...blocks]);
	profiles.set(space, out);
	return out;
}

function cat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/* ---------- converting */

export function srgbToLinear(v: number): number {
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(v: number): number {
	return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** Linear Display P3 → linear sRGB (both D65). */
const P3_TO_SRGB = [
	[1.2249401, -0.2249404, 0],
	[-0.0420569, 1.0420571, 0],
	[-0.0196376, -0.0786361, 1.0982735],
];

/** Converts RGBA pixels from Display P3 to sRGB in place; colors outside sRGB are clamped. */
export function p3ToSrgb(pixels: Uint8Array | Uint16Array): void {
	const max = pixels instanceof Uint16Array ? 65535 : 255;
	// Decode through a table indexed by the stored value; encode through a fine table of linear values.
	const decode = new Float32Array(max + 1);
	for (let i = 0; i <= max; i++) decode[i] = srgbToLinear(i / max);
	// Fine enough near black, where the sRGB curve is steepest, to stay within half a step.
	const steps = max === 255 ? 16384 : 65536;
	const encode = new (max === 255 ? Uint8Array : Uint16Array)(steps + 1);
	for (let i = 0; i <= steps; i++) encode[i] = Math.round(linearToSrgb(i / steps) * max);
	const [m0, m1, m2] = P3_TO_SRGB;
	const out = (v: number) => encode[Math.round(Math.min(1, Math.max(0, v)) * steps)];
	for (let i = 0; i < pixels.length; i += 4) {
		const r = decode[pixels[i]];
		const g = decode[pixels[i + 1]];
		const b = decode[pixels[i + 2]];
		pixels[i] = out(m0[0] * r + m0[1] * g + m0[2] * b);
		pixels[i + 1] = out(m1[0] * r + m1[1] * g + m1[2] * b);
		pixels[i + 2] = out(m2[0] * r + m2[1] * g + m2[2] * b);
	}
}
