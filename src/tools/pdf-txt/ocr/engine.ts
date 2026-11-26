// tesseract.js in its own Web Worker, started only when OCR is first asked for.
// Every file it needs is served by this site (hashed under /assets/, cached
// for good), so nothing is fetched from a CDN and OCR keeps working offline
// once loaded. The ?url imports are plain strings: nothing downloads until
// startOcr() runs.
import modelUrl from "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url";
import workerUrl from "tesseract.js/dist/worker.min.js?url";
import corePlainUrl from "tesseract.js-core/tesseract-core-lstm.wasm.js?url";
import coreRelaxedUrl from "tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js?url";
import coreSimdUrl from "tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url";
import { fromTesseract, type OcrPage } from "../engine/ocr.ts";
import { OCR_PARAMS } from "./params.ts";

/** What the first use downloads: the recognizer (≈1.1 MB compressed) and the English model (≈3 MB). */
export const OCR_DOWNLOAD = "about 4 MB";

// Feature probes from wasm-feature-detect (Apache-2.0): tiny modules that validate only with SIMD.
const SIMD = [
	0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
];
const RELAXED_SIMD = [
	0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15,
	253, 128, 2, 11,
];
const supports = (bytes: number[]) => {
	try {
		return WebAssembly.validate(new Uint8Array(bytes));
	} catch {
		return false;
	}
};

/** The fastest build of the recognizer this browser runs (all LSTM-only: the model has no legacy engine). */
function coreUrl(): string {
	if (supports(RELAXED_SIMD)) return coreRelaxedUrl;
	if (supports(SIMD)) return coreSimdUrl;
	return corePlainUrl;
}

const absolute = (url: string) => new URL(url, self.location.href).href;

export interface OcrEngine {
	/** Reads one rendered page (`scale` image pixels per PDF point). */
	recognize(image: Uint8Array, page: number, scale: number): Promise<OcrPage>;
	/** Stops at once, mid-page included. */
	terminate(): void;
}

/** Loads tesseract.js and the English model. `onLoad` reports loading steps (0..1). */
export async function startOcr(onLoad?: (step: string, progress: number) => void): Promise<OcrEngine> {
	const { createWorker, OEM } = await import("tesseract.js");
	const worker = await createWorker("eng", OEM.LSTM_ONLY, {
		// tesseract.js runs these in a blob: worker, so they must be absolute.
		workerPath: absolute(workerUrl),
		corePath: absolute(coreUrl()),
		// tesseract.js fetches `${langPath}/eng.traineddata.gz`. The model is a hashed
		// asset, so its URL is given whole; the "#" turns the appended part into a
		// fragment, which fetch() leaves out.
		langPath: `${absolute(modelUrl)}#`,
		gzip: true,
		// The browser's HTTP cache keeps the files; no second copy in IndexedDB.
		cacheMethod: "none",
		logger: (m) => onLoad?.(m.status, m.progress),
	});
	await worker.setParameters(OCR_PARAMS);
	let live = true;
	return {
		async recognize(image, page, scale) {
			// A Blob is the typed way in; tesseract.js reads it back into bytes (PGM, see params.ts).
			const blob = new Blob([image as Uint8Array<ArrayBuffer>]);
			const { data } = await worker.recognize(blob, {}, { blocks: true, text: false });
			return fromTesseract(data.blocks, page, scale);
		},
		terminate() {
			if (live) void worker.terminate();
			live = false;
		},
	};
}
