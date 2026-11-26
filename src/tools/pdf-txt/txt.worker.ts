// Runs PDF reading, conversion and page rendering off the main thread. The
// document stays open between calls: pages are read once, then switching
// modes re-converts from the cached page models, and the preview renders
// single pages on demand.
import * as Comlink from "comlink";
import * as mupdf from "mupdf";
import { meta, openDocument, type Progress } from "../../lib/pdf/document.ts";
import { blockCachedHandle } from "../../lib/pdf/fileStream.ts";
import type { OutlineEntry, PageModel } from "../../lib/pdf/heuristics.ts";
import { guessMode } from "./engine/guess.ts";
import { convert, type Mode, type TxtResult } from "./engine/index.ts";
import { readPdf } from "./engine/read.ts";

declare class FileReaderSync {
	readAsArrayBuffer(blob: Blob): ArrayBuffer;
}

function fileHandle(file: File) {
	const reader = new FileReaderSync();
	return blockCachedHandle(
		file.size,
		(pos, len) => new Uint8Array(reader.readAsArrayBuffer(file.slice(pos, pos + len))),
	);
}

function throttled(progress: Progress): Progress {
	let last = 0;
	return (done, total, phase) => {
		const now = performance.now();
		if (now - last > 100 || done === total) {
			last = now;
			void progress(done, total, phase);
		}
	};
}

let doc: mupdf.Document | null = null;
let book: { pages: PageModel[]; outline: OutlineEntry[] } | null = null;

export interface LoadedBook {
	title: string;
	author: string;
	pages: number;
	/** The mode the book's shape suggests. */
	mode: Mode;
	/** Pages that are scans with no text layer. */
	imageOnly: number;
	/** Pages whose text is an OCR layer over a scan. */
	ocr: number;
}

export interface RenderedPage {
	png: Uint8Array;
	/** Page size in PDF points, for placing highlight boxes. */
	width: number;
	height: number;
}

const api = {
	load(file: File, progress: Progress): LoadedBook {
		doc?.destroy();
		doc = null;
		book = null;
		const opened = openDocument(fileHandle(file), "pdf");
		doc = opened;
		book = readPdf(opened, throttled(progress));
		return {
			title: meta(opened, "info:Title"),
			author: meta(opened, "info:Author"),
			pages: book.pages.length,
			mode: guessMode(book.pages),
			imageOnly: book.pages.filter((p) => p.imageOnly).length,
			ocr: book.pages.filter((p) => p.ocr).length,
		};
	},

	convert(mode: Mode): TxtResult {
		if (!book) throw new Error("No book is open.");
		return convert(book.pages, book.outline, { mode });
	},

	/** Renders one page as PNG, `cssWidth` pixels wide at the given device pixel ratio. */
	render(index: number, cssWidth: number, ratio: number): RenderedPage {
		if (!doc) throw new Error("No book is open.");
		const page = doc.loadPage(index);
		try {
			const [x0, y0, x1, y1] = page.getBounds();
			const width = x1 - x0;
			const scale = Math.min(4, (cssWidth * ratio) / width);
			const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
			try {
				const png = pix.asPNG().slice();
				return Comlink.transfer({ png, width, height: y1 - y0 }, [png.buffer]);
			} finally {
				pix.destroy();
			}
		} finally {
			page.destroy();
		}
	},
};

export type TxtApi = typeof api;

mupdf.setLog({
	error: (m: string) => console.error(`[mupdf] ${m}`),
	warning: (m: string) => console.debug(`[mupdf] ${m}`),
});

Comlink.expose(api);
self.postMessage({ type: "ready" });
