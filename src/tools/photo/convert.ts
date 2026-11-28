// One photo in, one photo out (README: "How the photo converter works"). Pure apart from the codecs,
// which are passed in so the worker loads each one only when a photo needs it, and tests can run the
// whole pipeline in Node.
import { type ColorSpace, iccProfile, identifyIcc, identifyNclx, p3ToSrgb } from "./color.ts";
import { readJpeg, readPng, writeJpegMeta, writePngMeta } from "./containers.ts";
import { editExif, readExif, takenDate } from "./exif.ts";
import { decodeHeif, type HeifModule } from "./heif.ts";
import type { OutputFormat } from "./names.ts";
import { orient, type Pixels } from "./rotate.ts";

export type InputKind = "heic" | "jpeg" | "png";

interface RawImage {
	data: Uint8Array | Uint8ClampedArray | Uint16Array;
	width: number;
	height: number;
}

export interface Codecs {
	heif(): Promise<HeifModule>;
	jpeg(): Promise<{
		encode(image: RawImage, options: Record<string, unknown>): Promise<ArrayBuffer>;
		decode(buffer: ArrayBuffer, options: { preserveOrientation: boolean }): Promise<RawImage>;
	}>;
	png(): Promise<{
		encode(image: RawImage, options: { bitDepth: 8 | 16 }): Promise<ArrayBuffer>;
		decode(buffer: ArrayBuffer, options: { bitDepth: 8 | 16 }): Promise<RawImage>;
	}>;
}

export interface ConvertOptions {
	format: OutputFormat;
	/** JPEG quality, 1–100. */
	quality: number;
	/** Convert Display P3 photos to sRGB (for sites that drop color profiles). */
	srgb: boolean;
	stripGps: boolean;
}

export interface Converted {
	bytes: Uint8Array;
	width: number;
	height: number;
	/** Things the person should know about this photo. */
	notes: string[];
	/** When the photo was taken (camera's local time), for the zip entry's date. */
	taken: Date | null;
	/** The output's color space, for the list. */
	color: "Display P3" | "sRGB" | "its own color profile";
}

export const JPEG_OPTIONS = {
	// Baseline: progressive saved ~3% at twice the time (24 MP: 2.0 s vs 4.3 s), which adds up in a batch.
	progressive: false,
	optimize_coding: true,
	// Full color resolution (4:4:4): no chroma subsampling, so colored edges stay sharp.
	auto_subsample: false,
	chroma_subsample: 1,
	separate_chroma_quality: false,
};

export class ConvertError extends Error {}

const toBuffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

export async function convert(
	input: Uint8Array,
	kind: InputKind,
	options: ConvertOptions,
	codecs: Codecs,
): Promise<Converted> {
	const notes: string[] = [];

	// 1. Decode to upright RGBA, with the profile and EXIF from the source.
	let image: Pixels;
	let icc: Uint8Array | null = null;
	let space: ColorSpace | "untagged" = "untagged";
	let exif: Uint8Array | null = null;
	let hasAlpha = false;
	if (kind === "heic") {
		const heif = await codecs.heif();
		let decoded: ReturnType<typeof decodeHeif>;
		try {
			decoded = decodeHeif(heif, input);
		} catch (e) {
			throw new ConvertError(e instanceof Error ? e.message : String(e));
		}
		image = { data: decoded.pixels, width: decoded.width, height: decoded.height };
		hasAlpha = decoded.hasAlpha;
		exif = decoded.exif;
		if (decoded.icc) {
			icc = decoded.icc;
			space = identifyIcc(icc);
		} else if (decoded.nclx) {
			space = identifyNclx(decoded.nclx);
			if (space !== "other") icc = iccProfile(space);
			else notes.push("Its color space has no standard profile; colors may look slightly different.");
		}
		if (decoded.hasGainMap) notes.push("HDR brightness isn't kept: saved as the standard version.");
		// libheif applied the rotation already; the EXIF orientation is reset below.
	} else {
		let meta: ReturnType<typeof readJpeg>;
		try {
			meta = kind === "jpeg" ? readJpeg(input) : readPng(input);
		} catch {
			throw new ConvertError(`This ${kind === "jpeg" ? "JPEG" : "PNG"} couldn't be read.`);
		}
		exif = meta.exif;
		if (meta.icc) {
			icc = meta.icc;
			space = identifyIcc(icc);
		}
		// Already in the asked-for format, and nothing to change: hand it back untouched rather than
		// re-encode (a JPEG would lose a little quality each time).
		const changes = (options.srgb && space === "p3") || (options.stripGps && !!exif && readExif(exif).hasGps);
		if (kind === options.format && !changes) {
			const info = exif ? readExif(exif) : null;
			return {
				bytes: input,
				width: meta.width,
				height: meta.height,
				notes: [`Already a ${kind === "jpeg" ? "JPEG" : "PNG"}: kept as it was.`],
				taken: info ? takenDate(info) : null,
				color: space === "p3" ? "Display P3" : space === "other" ? "its own color profile" : "sRGB",
			};
		}
		let raw: RawImage;
		try {
			if (kind === "jpeg") {
				raw = await (await codecs.jpeg()).decode(toBuffer(input), { preserveOrientation: false });
			} else {
				raw = await (await codecs.png()).decode(toBuffer(input), { bitDepth: meta.bitDepth === 16 ? 16 : 8 });
			}
		} catch {
			throw new ConvertError(`This ${kind === "jpeg" ? "JPEG" : "PNG"} couldn't be read.`);
		}
		const data =
			raw.data instanceof Uint16Array
				? raw.data
				: new Uint8Array(raw.data.buffer, raw.data.byteOffset, raw.data.length);
		const orientation = exif ? readExif(exif).orientation : 1;
		image = orient({ data, width: raw.width, height: raw.height }, orientation);
		if (kind === "png") hasAlpha = hasTransparency(image.data);
	}
	const info = exif ? readExif(exif) : null;

	// 2. Color: keep the source space, unless asked for sRGB and the photo is Display P3.
	let color: Converted["color"] = space === "p3" ? "Display P3" : space === "other" ? "its own color profile" : "sRGB";
	if (options.srgb && space === "p3") {
		p3ToSrgb(image.data);
		icc = iccProfile("srgb");
		color = "sRGB";
	}

	// 3. EXIF: upright, no thumbnail, and no location when asked.
	let outExif: Uint8Array | null = null;
	if (exif) {
		outExif = editExif(exif, { stripGps: options.stripGps });
		if (!outExif) notes.push("Its EXIF details couldn't be read, so they weren't copied.");
	}

	// 4. Encode.
	let bytes: Uint8Array;
	if (options.format === "jpeg") {
		let rgba = image.data instanceof Uint16Array ? to8bit(image.data) : image.data;
		if (hasAlpha && hasTransparency(rgba)) {
			rgba = flattenOnWhite(rgba);
			notes.push("Transparent areas were filled with white: JPEG can't store transparency.");
		}
		const jpeg = await codecs.jpeg();
		const encoded = new Uint8Array(
			await jpeg.encode(
				{
					data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length),
					width: image.width,
					height: image.height,
				},
				{
					...JPEG_OPTIONS,
					quality: Math.max(1, Math.min(100, Math.round(options.quality))),
					chroma_quality: options.quality,
				},
			),
		);
		const written = writeJpegMeta(encoded, { icc, exif: outExif });
		if (written.exifDropped) notes.push("Its EXIF details were too large for a JPEG, so they weren't copied.");
		bytes = written.bytes;
	} else {
		const png = await codecs.png();
		const deep = image.data instanceof Uint16Array;
		const encoded = new Uint8Array(
			await png.encode(
				deep
					? { data: image.data, width: image.width, height: image.height }
					: {
							data: new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.length),
							width: image.width,
							height: image.height,
						},
				{ bitDepth: deep ? 16 : 8 },
			),
		);
		bytes = writePngMeta(encoded, { icc, exif: outExif });
	}

	return {
		bytes,
		width: image.width,
		height: image.height,
		notes,
		taken: info ? takenDate(info) : null,
		color,
	};
}

function hasTransparency(data: Uint8Array | Uint16Array): boolean {
	const opaque = data instanceof Uint16Array ? 65535 : 255;
	for (let i = 3; i < data.length; i += 4) if (data[i] !== opaque) return true;
	return false;
}

function to8bit(data: Uint16Array): Uint8Array {
	const out = new Uint8Array(data.length);
	for (let i = 0; i < data.length; i++) out[i] = (data[i] + 128) / 257;
	return out;
}

/** Composites RGBA onto white (alpha becomes 255). */
function flattenOnWhite(data: Uint8Array): Uint8Array {
	const out = new Uint8Array(data.length);
	for (let i = 0; i < data.length; i += 4) {
		const a = data[i + 3];
		const k = 255 - a;
		out[i] = (data[i] * a + 255 * k + 127) / 255;
		out[i + 1] = (data[i + 1] * a + 255 * k + 127) / 255;
		out[i + 2] = (data[i + 2] * a + 255 * k + 127) / 255;
		out[i + 3] = 255;
	}
	return out;
}
