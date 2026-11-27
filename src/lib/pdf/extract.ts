// Reads one PDF page into a PageModel: positioned lines with their font size
// and style, grouped into MuPDF's blocks, plus what kind of page it is (born
// digital, an OCR layer over a scan, or a scan with no text at all).
import * as mupdf from "mupdf";
import { type ImageBlock, isJunkText, type PageModel } from "./heuristics.ts";

/** Where a tool that keeps pictures puts them. Tools that only want text pass none. */
export interface PageImages {
	/** Stores an embedded image; null when it should be dropped (decoration, masks). */
	add(image: mupdf.Image): Omit<ImageBlock, "kind"> | null;
	/** Stores the whole page rendered as one picture (a cover, a plate, a scanned figure). */
	render(page: mupdf.Page): Omit<ImageBlock, "kind">;
}

export interface ExtractOptions {
	images?: PageImages;
}

/** Share of the page an image covers. Scanned pages are one page-sized image (or a few stacked layers). */
function coverage(bbox: number[], bounds: number[]): number {
	const w = Math.min(bbox[2], bounds[2]) - Math.max(bbox[0], bounds[0]);
	const h = Math.min(bbox[3], bounds[3]) - Math.max(bbox[1], bounds[1]);
	const area = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]);
	return w > 0 && h > 0 && area > 0 ? (w * h) / area : 0;
}

/**
 * True when a page has almost no ink: a blank leaf of a scanned book, show-through and all.
 * Rendered at full size (72 dpi): smaller renders blur small print into the paper tone, which
 * made scanned pages of small type look blank (they then never got offered for OCR). Ink is
 * what is much darker than the paper (its 90th-percentile tone): show-through never is.
 * Measured: real blank leaves 0 inked pixels per 10,000, a small-print poem scan 46.
 */
export function isBlankPage(page: mupdf.Page): boolean {
	const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, true);
	try {
		const px = pix.getPixels();
		const hist = new Uint32Array(256);
		for (const v of px) hist[v]++;
		let paper = 255;
		for (let v = 0, seen = 0; v < 256; v++) {
			seen += hist[v];
			if (seen >= px.length * 0.9) {
				paper = v;
				break;
			}
		}
		let ink = 0;
		for (let v = 0; v < paper - 80; v++) ink += hist[v];
		return ink / px.length < 0.0002;
	} finally {
		pix.destroy();
	}
}

export function extractPage(page: mupdf.Page, index: number, opts: ExtractOptions = {}): PageModel {
	const { images } = opts;
	const bounds = page.getBounds();
	const [bx0, by0, bx1, by1] = bounds;
	const model: PageModel = { index, width: bx1 - bx0, height: by1 - by0, blocks: [] };
	// Page-covering images are not kept as they come: on a scanned page they
	// are the scan itself, and the text layer above them is what matters.
	let scanned = false;
	// No "paragraph-break"/"segment": those wrap content in structure blocks that walk() skips.
	// Paragraphs are rebuilt by the heuristics instead.
	// "dehyphenate" only affects asText(): walk() still reports each printed line
	// whole, line-final hyphen included. Words are joined later, by joinLines(),
	// and only where a tool reflows lines into paragraphs.
	const st = page.toStructuredText("preserve-images,preserve-whitespace,dehyphenate");
	let line: {
		chars: string[];
		sizes: Map<number, number>;
		bold: number;
		italic: number;
		n: number;
		bbox: number[];
	} | null = null;
	let lines: PageModel["blocks"][number] | null = null;
	st.walk({
		onImageBlock(bbox, _transform, image) {
			if (coverage(bbox, bounds) >= 0.85) {
				scanned = true;
				return;
			}
			const img = images?.add(image);
			if (img) model.blocks.push({ kind: "image", ...img });
		},
		beginTextBlock() {
			lines = { kind: "text", lines: [] };
		},
		beginLine(bbox) {
			line = { chars: [], sizes: new Map(), bold: 0, italic: 0, n: 0, bbox };
		},
		onChar(c, _origin, font, size) {
			if (!line) return;
			line.chars.push(c);
			if (c.trim()) {
				const k = Math.round(size * 2) / 2;
				line.sizes.set(k, (line.sizes.get(k) ?? 0) + 1);
				line.n++;
				if (font.isBold()) line.bold++;
				if (font.isItalic()) line.italic++;
			}
		},
		endLine() {
			if (line && lines?.kind === "text") {
				const text = line.chars.join("");
				if (text.trim()) {
					let size = 0;
					let best = -1;
					for (const [s, count] of line.sizes) if (count > best) [size, best] = [s, count];
					const [x0, y0, x1, y1] = line.bbox;
					lines.lines.push({
						text,
						x0: x0 - bx0,
						y0: y0 - by0,
						x1: x1 - bx0,
						y1: y1 - by0,
						size,
						bold: line.bold > line.n / 2,
						italic: line.italic > line.n / 2,
					});
				}
			}
			line = null;
		},
		endTextBlock() {
			if (lines?.kind === "text" && lines.lines.length) model.blocks.push(lines);
			lines = null;
		},
	});
	st.destroy();

	if (scanned) {
		const text = model.blocks
			.flatMap((b) => (b.kind === "text" ? b.lines.map((l) => l.text) : []))
			.join(" ")
			.trim();
		if (index === 0 && images) {
			// A first page drawn over a full-page picture is a cover: keep it as a picture.
			model.blocks = [{ kind: "image", ...images.render(page) }];
		} else if (!text) {
			// An image-only page (a plate, a photo, a scan without OCR, or a blank leaf).
			if (!isBlankPage(page)) {
				model.imageOnly = true;
				if (images) model.blocks.push({ kind: "image", ...images.render(page) });
			}
		} else if (isJunkText(text)) {
			// OCR noise from show-through on an otherwise blank leaf.
			model.blocks = model.blocks.filter((b) => b.kind !== "text");
		} else {
			model.ocr = true;
		}
	}
	return model;
}
