// The real codecs, loaded in Node from node_modules: for the unit tests and the e2e checks. The app
// never imports this file (the worker fetches the same WebAssembly over HTTP).
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import jpegDecode, { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import jpegEncode, { init as initJpegEncode } from "@jsquash/jpeg/encode.js";
import { init as initPngDecode, decode as pngDecode } from "@jsquash/png/decode.js";
import pngEncode, { init as initPngEncode } from "@jsquash/png/encode.js";
import type { Codecs } from "./convert.ts";
import { type HeifFactory, type HeifModule, loadHeif } from "./heif.ts";

const require = createRequire(import.meta.url);
const pkg = (name: string) => path.dirname(require.resolve(`${name}/package.json`));
const wasm = (file: string) => WebAssembly.compile(fs.readFileSync(file));

let loaded: Promise<Codecs> | null = null;

export function nodeCodecs(): Promise<Codecs> {
	loaded ??= (async () => {
		const jpeg = pkg("@jsquash/jpeg");
		const png = pkg("@jsquash/png");
		await initJpegEncode(await wasm(path.join(jpeg, "codec/enc/mozjpeg_enc.wasm")));
		await initJpegDecode(await wasm(path.join(jpeg, "codec/dec/mozjpeg_dec.wasm")));
		const pngModule = await wasm(path.join(png, "codec/pkg/squoosh_png_bg.wasm"));
		await initPngEncode(pngModule);
		await initPngDecode(pngModule);
		const heifDir = pkg("libheif-js");
		let heif: Promise<HeifModule> | null = null;
		return {
			heif: () =>
				(heif ??= loadHeif(
					require(path.join(heifDir, "libheif-wasm/libheif.js")) as HeifFactory,
					fs.readFileSync(path.join(heifDir, "libheif-wasm/libheif.wasm")),
				)),
			jpeg: async () => ({ encode: jpegEncode, decode: jpegDecode }),
			png: async () => ({ encode: pngEncode, decode: pngDecode }),
		} as unknown as Codecs;
	})();
	return loaded;
}
