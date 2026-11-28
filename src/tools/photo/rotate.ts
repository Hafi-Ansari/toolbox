// Applies an EXIF orientation (1–8) to RGBA pixels, so the result is upright with Orientation 1.

export interface Pixels<T extends Uint8Array | Uint16Array = Uint8Array | Uint16Array> {
	data: T;
	width: number;
	height: number;
}

/**
 * For each orientation, where output pixel (x, y) reads from in the stored image (w × h).
 * Orientations 5–8 swap width and height.
 */
const SOURCE: Record<number, (x: number, y: number, w: number, h: number) => [number, number]> = {
	2: (x, y, w) => [w - 1 - x, y],
	3: (x, y, w, h) => [w - 1 - x, h - 1 - y],
	4: (x, y, _w, h) => [x, h - 1 - y],
	5: (x, y) => [y, x],
	6: (x, y, _w, h) => [y, h - 1 - x],
	7: (x, y, w, h) => [w - 1 - y, h - 1 - x],
	8: (x, y, w) => [w - 1 - y, x],
};

export function orient<T extends Uint8Array | Uint16Array>(src: Pixels<T>, orientation: number): Pixels<T> {
	const from = SOURCE[orientation];
	if (!from) return src;
	const { width: w, height: h, data } = src;
	const swap = orientation >= 5;
	const ow = swap ? h : w;
	const oh = swap ? w : h;
	const out = new (data.constructor as new (n: number) => T)(data.length);
	// Copy whole pixels as 32-bit words (8-bit) or 64-bit pairs (16-bit) for speed.
	if (data instanceof Uint8Array) {
		const s = new Uint32Array(data.buffer, data.byteOffset, data.length / 4);
		const d = new Uint32Array(out.buffer, out.byteOffset, out.length / 4);
		for (let y = 0; y < oh; y++)
			for (let x = 0; x < ow; x++) {
				const [sx, sy] = from(x, y, w, h);
				d[y * ow + x] = s[sy * w + sx];
			}
	} else {
		const s = new BigUint64Array(data.buffer, data.byteOffset, data.length / 4);
		const d = new BigUint64Array(out.buffer, out.byteOffset, out.length / 4);
		for (let y = 0; y < oh; y++)
			for (let x = 0; x < ow; x++) {
				const [sx, sy] = from(x, y, w, h);
				d[y * ow + x] = s[sy * w + sx];
			}
	}
	return { data: out, width: ow, height: oh };
}
