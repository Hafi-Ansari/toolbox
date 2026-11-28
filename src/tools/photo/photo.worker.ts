// The photo converter's worker: decodes and encodes one photo at a time, off the main thread.
// Each codec's WebAssembly is fetched and compiled the first time a photo needs it, so a JPEG → PNG
// batch never downloads the HEIC decoder.

import decWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm?url";
import encWasm from "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm?url";
import pngWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm?url";
import * as Comlink from "comlink";
import heifWasm from "libheif-js/libheif-wasm/libheif.wasm?url";
import { type Codecs, type ConvertOptions, convert, type InputKind } from "./convert.ts";
import { type HeifFactory, loadHeif } from "./heif.ts";

async function bytes(url: string): Promise<ArrayBuffer> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Couldn't load the photo converter (${response.status}).`);
	return response.arrayBuffer();
}

const once = <T>(load: () => Promise<T>) => {
	let pending: Promise<T> | null = null;
	return () => {
		pending ??= load().catch((e) => {
			pending = null;
			throw e;
		});
		return pending;
	};
};

const codecs: Codecs = {
	heif: once(async () => {
		const [module, wasm] = await Promise.all([import("libheif-js/libheif-wasm/libheif.js"), bytes(heifWasm)]);
		const factory = ((module as { default?: unknown }).default ?? module) as HeifFactory;
		return loadHeif(factory, wasm);
	}),
	jpeg: once(async () => {
		const [enc, dec, encModule, decModule] = await Promise.all([
			import("@jsquash/jpeg/encode.js"),
			import("@jsquash/jpeg/decode.js"),
			bytes(encWasm).then((b) => WebAssembly.compile(b)),
			bytes(decWasm).then((b) => WebAssembly.compile(b)),
		]);
		await enc.init(encModule);
		await dec.init(decModule);
		return { encode: enc.default, decode: dec.default } as unknown as Awaited<ReturnType<Codecs["jpeg"]>>;
	}),
	png: once(async () => {
		const [enc, dec, module] = await Promise.all([
			import("@jsquash/png/encode.js"),
			import("@jsquash/png/decode.js"),
			bytes(pngWasm).then((b) => WebAssembly.compile(b)),
		]);
		await enc.init(module);
		await dec.init(module);
		return { encode: enc.default, decode: dec.decode } as unknown as Awaited<ReturnType<Codecs["png"]>>;
	}),
};

const api = {
	async convert(file: Blob, kind: InputKind, options: ConvertOptions) {
		const input = new Uint8Array(await file.arrayBuffer());
		const result = await convert(input, kind, options, codecs);
		// The input buffer is handed back unchanged when no conversion was needed: copy it then.
		const out = result.bytes.buffer === input.buffer ? result.bytes.slice() : result.bytes;
		return Comlink.transfer({ ...result, bytes: out }, [out.buffer]);
	},
};

export type PhotoWorker = typeof api;
Comlink.expose(api);
self.postMessage({ type: "ready" });
