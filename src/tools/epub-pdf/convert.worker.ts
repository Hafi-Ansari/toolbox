// Runs all conversion work off the main thread. Importing the engine loads and
// compiles MuPDF's WASM (top-level await), after which we signal "ready".
import * as Comlink from "comlink";
import * as mupdf from "mupdf";
import { blockCachedHandle } from "../../lib/pdf/fileStream.ts";
import {
	type EpubToPdfOptions,
	epubToPdf,
	type Format,
	inspect,
	type PdfToEpubOptions,
	type Progress,
	pdfToEpub,
} from "./engine/convert.ts";
import { batchingSink } from "./engine/zip.ts";

// Worker-only API (the "webworker" lib can't be mixed with "dom" in one program).
declare class FileReaderSync {
	readAsArrayBuffer(blob: Blob): ArrayBuffer;
}

/** Synchronous random access into the user's File: nothing is loaded up front. */
function fileHandle(file: File) {
	const reader = new FileReaderSync();
	return blockCachedHandle(
		file.size,
		(pos, len) => new Uint8Array(reader.readAsArrayBuffer(file.slice(pos, pos + len))),
	);
}

/** Forward at most ~10 progress updates per second (plus the final one). */
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

const api = {
	inspect(file: File, format: Format) {
		return inspect(fileHandle(file), format);
	},

	epubToPdf(file: File, opts: EpubToPdfOptions, progress: Progress) {
		const t0 = performance.now();
		const bytes = epubToPdf(fileHandle(file), opts, throttled(progress));
		const result = { bytes, ms: Math.round(performance.now() - t0) };
		return Comlink.transfer(result, [bytes.buffer]);
	},

	pdfToEpub(file: File, opts: PdfToEpubOptions, write: (chunk: Uint8Array) => void, progress: Progress) {
		const { sink, flush } = batchingSink((chunk) => {
			void write(Comlink.transfer(chunk, [chunk.buffer]));
		});
		const result = pdfToEpub(fileHandle(file), opts, sink, throttled(progress));
		flush();
		return result;
	},
};

export type ConverterApi = typeof api;

// MuPDF reports recoverable oddities (e.g. "unknown epub version") on the error console.
// Keep real errors visible, demote warnings to debug.
mupdf.setLog({
	error: (m: string) => console.error(`[mupdf] ${m}`),
	warning: (m: string) => console.debug(`[mupdf] ${m}`),
});

Comlink.expose(api);
self.postMessage({ type: "ready" });
