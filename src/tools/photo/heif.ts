// A thin typed wrapper over libheif's C API (libheif-js 1.23, WebAssembly build). It decodes the
// primary image with its transformations applied (rotation, mirroring, crop), and reads what a
// faithful conversion needs: the color profile (ICC or nclx), the EXIF block, and whether the photo
// carries an HDR gain map. The JS helper in libheif-js's README (HeifDecoder.display) returns only
// 8-bit pixels and none of the rest, so it isn't used.
//
// C functions that return a `struct heif_error` by value take a hidden first argument in wasm32: a
// pointer to 12 bytes where the struct is written ({ int code; int subcode; const char* message }).

/** The parts of the Emscripten module this file uses. */
export interface HeifModule {
	HEAPU8: Uint8Array;
	_malloc(size: number): number;
	_free(ptr: number): void;
	[name: `_heif_${string}`]: (...args: number[]) => number;
}

/** libheif-js's module factory (`libheif-wasm/libheif.js`). */
export type HeifFactory = (options: Record<string, unknown>) => unknown;

/** Instantiates libheif with a WASM binary the caller fetched or read. */
export function loadHeif(factory: HeifFactory, wasmBinary: ArrayBuffer | Uint8Array): Promise<HeifModule> {
	return new Promise((resolve, reject) => {
		const options: Record<string, unknown> = {
			wasmBinary,
			// With wasmBinary, initialization may finish before the factory returns: resolve with the
			// object Emscripten filled in, not the return value.
			onRuntimeInitialized: () => resolve(options as unknown as HeifModule),
			onAbort: (what: unknown) => reject(new Error(`libheif failed to start: ${String(what)}`)),
		};
		try {
			factory(options);
		} catch (e) {
			reject(e);
		}
	});
}

export interface Nclx {
	/** ITU-T H.273 color primaries: 1 = BT.709/sRGB, 12 = SMPTE EG 432 (Display P3). */
	primaries: number;
	/** 13 = sRGB curve, 16 = PQ, 18 = HLG. */
	transfer: number;
	matrix: number;
	fullRange: boolean;
}

export interface DecodedHeif {
	width: number;
	height: number;
	/** Bits per channel in the file (8, 10, 12). */
	bitDepth: number;
	/** RGBA, 4 values a pixel: Uint8Array for 8-bit, Uint16Array scaled to 0–65535 otherwise. */
	pixels: Uint8Array | Uint16Array;
	hasAlpha: boolean;
	icc: Uint8Array | null;
	nclx: Nclx | null;
	/** The TIFF structure (starting at "II*\0" or "MM\0*"), without HEIF's 4-byte offset prefix. */
	exif: Uint8Array | null;
	/** An Apple HDR gain map or an ISO 21496-1 `tmap` item: HDR that this conversion doesn't keep. */
	hasGainMap: boolean;
}

const fourcc = (n: number) => String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

// libheif enum values (libheif/heif.h).
const COLORSPACE_RGB = 1;
const CHROMA_RGBA = 11; // interleaved, 8 bits
const CHROMA_RRGGBBAA_LE = 15; // interleaved, 16 bits little endian
const CHANNEL_INTERLEAVED = 10;
const AUX_OMIT_ALPHA = 1 << 1;
const AUX_OMIT_DEPTH = 1 << 2;

export class HeifError extends Error {}

/** Decodes the primary image of a HEIF/HEIC file. Throws HeifError for files libheif can't read. */
export function decodeHeif(m: HeifModule, file: Uint8Array): DecodedHeif {
	const allocs: number[] = [];
	const alloc = (size: number) => {
		const ptr = m._malloc(size);
		if (!ptr) throw new HeifError("Out of memory.");
		allocs.push(ptr);
		return ptr;
	};
	const u32 = (ptr: number) => new DataView(m.HEAPU8.buffer).getUint32(ptr, true);
	const i32 = (ptr: number) => new DataView(m.HEAPU8.buffer).getInt32(ptr, true);
	const cString = (ptr: number) => {
		const heap = m.HEAPU8;
		let end = ptr;
		while (heap[end]) end++;
		return new TextDecoder().decode(heap.subarray(ptr, end));
	};
	const err = alloc(12);
	const check = (what: string) => {
		const code = i32(err);
		if (code !== 0) {
			const message = u32(err + 8) ? cString(u32(err + 8)) : `error ${code}`;
			throw new HeifError(`${what}: ${message}`);
		}
	};

	const data = alloc(file.length);
	m.HEAPU8.set(file, data);
	const ctx = m._heif_context_alloc();
	let handle = 0;
	let image = 0;
	try {
		m._heif_context_read_from_memory(err, ctx, data, file.length, 0);
		check("Not a readable HEIF file");
		const out = alloc(4);
		m._heif_context_get_primary_image_handle(err, ctx, out);
		check("No primary image");
		handle = u32(out);

		const hasAlpha = m._heif_image_handle_has_alpha_channel(handle) !== 0;
		const lumaBits = m._heif_image_handle_get_luma_bits_per_pixel(handle);
		const deep = lumaBits > 8;

		// Color profile. A file can hold both an ICC profile and nclx; read both.
		let icc: Uint8Array | null = null;
		const iccSize = m._heif_image_handle_get_raw_color_profile_size(handle);
		if (iccSize > 0) {
			const buf = alloc(iccSize);
			m._heif_image_handle_get_raw_color_profile(err, handle, buf);
			check("Color profile");
			icc = m.HEAPU8.slice(buf, buf + iccSize);
		}
		let nclx: Nclx | null = null;
		const nclxOut = alloc(4);
		m._heif_image_handle_get_nclx_color_profile(err, handle, nclxOut);
		if (i32(err) === 0 && u32(nclxOut)) {
			const p = u32(nclxOut);
			// struct heif_color_profile_nclx { uint8 version; int primaries; int transfer; int matrix; uint8 full_range; ... }
			nclx = { primaries: i32(p + 4), transfer: i32(p + 8), matrix: i32(p + 12), fullRange: m.HEAPU8[p + 16] !== 0 };
			m._heif_nclx_color_profile_free(p);
		}

		const exif = readExif(m, handle, alloc, err, check, u32);
		const hasGainMap = findGainMap(m, ctx, handle, alloc, err, u32, cString);

		// Decode to interleaved RGBA, with the default options: transformations applied.
		const imageOut = alloc(4);
		m._heif_decode_image(err, handle, imageOut, COLORSPACE_RGB, deep ? CHROMA_RRGGBBAA_LE : CHROMA_RGBA, 0);
		check("Couldn't decode the photo");
		image = u32(imageOut);
		const width = m._heif_image_get_width(image, CHANNEL_INTERLEAVED);
		const height = m._heif_image_get_height(image, CHANNEL_INTERLEAVED);
		const strideOut = alloc(4);
		const plane = m._heif_image_get_plane_readonly2(image, CHANNEL_INTERLEAVED, strideOut);
		if (!plane) throw new HeifError("The decoded photo has no pixels.");
		const stride = u32(strideOut);
		const bitDepth = deep ? m._heif_image_get_bits_per_pixel_range(image, CHANNEL_INTERLEAVED) || lumaBits : 8;

		let pixels: Uint8Array | Uint16Array;
		if (!deep) {
			pixels = new Uint8Array(width * height * 4);
			for (let y = 0; y < height; y++)
				pixels.set(m.HEAPU8.subarray(plane + y * stride, plane + y * stride + width * 4), y * width * 4);
		} else {
			// Values are 0..(2^bitDepth − 1) in 16-bit little-endian slots: scale to the full 16-bit range.
			pixels = new Uint16Array(width * height * 4);
			const max = (1 << bitDepth) - 1;
			const view = new DataView(m.HEAPU8.buffer);
			for (let y = 0; y < height; y++) {
				const row = plane + y * stride;
				for (let x = 0; x < width * 4; x++) {
					const v = view.getUint16(row + x * 2, true);
					pixels[y * width * 4 + x] = Math.round((v * 65535) / max);
				}
			}
		}
		return { width, height, bitDepth, pixels, hasAlpha, icc, nclx, exif, hasGainMap };
	} finally {
		if (image) m._heif_image_release(image);
		if (handle) m._heif_image_handle_release(handle);
		m._heif_context_free(ctx);
		for (const ptr of allocs) m._free(ptr);
	}
}

function readExif(
	m: HeifModule,
	handle: number,
	alloc: (n: number) => number,
	err: number,
	check: (what: string) => void,
	u32: (ptr: number) => number,
): Uint8Array | null {
	const filter = alloc(5);
	m.HEAPU8.set([0x45, 0x78, 0x69, 0x66, 0], filter); // "Exif\0"
	const count = m._heif_image_handle_get_number_of_metadata_blocks(handle, filter);
	if (count <= 0) return null;
	const ids = alloc(count * 4);
	m._heif_image_handle_get_list_of_metadata_block_IDs(handle, filter, ids, count);
	const id = u32(ids);
	const size = m._heif_image_handle_get_metadata_size(handle, id);
	if (size <= 4) return null;
	const buf = alloc(size);
	m._heif_image_handle_get_metadata(err, handle, id, buf);
	check("EXIF");
	const raw = m.HEAPU8.slice(buf, buf + size);
	// HEIF prefixes the TIFF structure with a 4-byte big-endian offset to its header.
	const offset = 4 + new DataView(raw.buffer).getUint32(0, false);
	const tiff = raw.subarray(Math.min(offset, raw.length));
	const tiffHeader = (b: Uint8Array) =>
		(b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0) ||
		(b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42);
	if (tiffHeader(tiff)) return tiff.slice();
	// Some writers get the offset wrong: look for the header near the start.
	for (let i = 0; i < Math.min(raw.length - 4, 64); i++) if (tiffHeader(raw.subarray(i))) return raw.slice(i);
	return null;
}

function findGainMap(
	m: HeifModule,
	ctx: number,
	handle: number,
	alloc: (n: number) => number,
	err: number,
	u32: (ptr: number) => number,
	cString: (ptr: number) => string,
): boolean {
	const options = AUX_OMIT_ALPHA | AUX_OMIT_DEPTH;
	const count = m._heif_image_handle_get_number_of_auxiliary_images(handle, options);
	if (count > 0) {
		const ids = alloc(count * 4);
		m._heif_image_handle_get_list_of_auxiliary_image_IDs(handle, options, ids, count);
		for (let i = 0; i < count; i++) {
			const auxOut = alloc(4);
			m._heif_image_handle_get_auxiliary_image_handle(err, handle, u32(ids + i * 4), auxOut);
			if (new DataView(m.HEAPU8.buffer).getInt32(err, true) !== 0) continue;
			const aux = u32(auxOut);
			const typeOut = alloc(4);
			m._heif_image_handle_get_auxiliary_type(err, aux, typeOut);
			const type = u32(typeOut) ? cString(u32(typeOut)) : "";
			if (u32(typeOut)) m._heif_image_handle_release_auxiliary_type(aux, typeOut);
			m._heif_image_handle_release(aux);
			if (/hdrgainmap/i.test(type)) return true;
		}
	}
	// ISO 21496-1 tone-map items ("tmap"), used for HDR by newer iOS versions.
	const items = m._heif_context_get_number_of_items(ctx);
	if (items > 0) {
		const ids = alloc(items * 4);
		m._heif_context_get_list_of_item_IDs(ctx, ids, items);
		for (let i = 0; i < items; i++)
			if (fourcc(m._heif_item_get_item_type(ctx, u32(ids + i * 4))) === "tmap") return true;
	}
	return false;
}
