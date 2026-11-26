// How pages are OCR'd, shared by the app and scripts/pdf-txt-ocr.ts. Measured
// on real books (see engine/ocr.ts): 300 dpi grey, LSTM with the best_int model,
// PSM 4 (one column of variable-size text). The default PSM 3 silently dropped
// a title and a whole row; PSM 6 and 11 invent rows on blank and divider pages.
import type { PSM } from "tesseract.js";

export const OCR_DPI = 300;

export const OCR_PARAMS = {
	tessedit_pageseg_mode: "4" as PSM,
	// Keeps the gaps of spaced-out rows; the merge turns wide gaps into spaces.
	preserve_interword_spaces: "1",
	// The image carries no resolution of its own (see pgm), so say it.
	user_defined_dpi: String(OCR_DPI),
};

/**
 * A grey pixmap as a binary PGM: a header and the raw pixels. Tesseract
 * reads it as fast as a PNG, and making it costs nothing (PNG encoding took
 * about 40 ms a page).
 */
export function pgm(width: number, height: number, pixels: ArrayLike<number>): Uint8Array<ArrayBuffer> {
	const head = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
	const out = new Uint8Array(head.length + pixels.length);
	out.set(head);
	out.set(pixels, head.length);
	return out;
}
