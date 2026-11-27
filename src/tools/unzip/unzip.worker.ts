import wasmUrl from "7z-wasm/7zz.wasm?url";
import * as Comlink from "comlink";
import { batchingSink, ZipWriter } from "../../lib/zipWriter.ts";
import type { Archive } from "./engine/listing.ts";
import { archiveEngine, fileSource } from "./engine/sevenzip.ts";

export type Output =
	| { type: "file"; index: number }
	| { type: "end" }
	| { type: "bytes"; data: Uint8Array }
	| { type: "progress"; bytes: number; index: number };

async function loadEngine() {
	const response = await fetch(wasmUrl);
	if (!response.ok) throw new Error(`Could not load 7-Zip (${response.status}).`);
	return archiveEngine(await WebAssembly.compile(await response.arrayBuffer()));
}

const engine = await loadEngine();

const api = {
	async list(file: File, password: string) {
		const archive = await engine.list(await fileSource(file), file.name, password);
		return archive;
	},
	async testPassword(file: File, archive: Archive, password: string, index: number) {
		await engine.extract(await fileSource(file), archive, password, new Set([index]), {
			start() {},
			write() {},
			end() {},
		});
	},
	async preview(file: File, archive: Archive, password: string, index: number, limit: number) {
		const bytes = new Uint8Array(Math.min(archive.entries[index].size, limit));
		let offset = 0;
		await engine.extract(await fileSource(file), archive, password, new Set([index]), {
			start() {},
			write(chunk) {
				const prefix = chunk.subarray(0, bytes.length - offset);
				bytes.set(prefix, offset);
				offset += prefix.length;
			},
			end() {},
		});
		return Comlink.transfer(bytes, [bytes.buffer]);
	},
	async extract(
		file: File,
		archive: Archive,
		password: string,
		selected: number[],
		zipPaths: { files: string[]; directories: string[] } | undefined,
		receive: (event: Output) => void,
	) {
		const send = (event: Output) => {
			receive(event.type === "bytes" ? Comlink.transfer(event, [event.data.buffer as ArrayBuffer]) : event);
		};
		const batch = batchingSink((data) => send({ type: "bytes", data }), 1 << 20);
		const zip = zipPaths && new ZipWriter(batch.sink);
		let current: ReturnType<ZipWriter["addStream"]> | undefined;
		let index = 0;
		let bytes = 0;
		let last = 0;
		const progress = () => send({ type: "progress", bytes, index });
		for (const directory of zipPaths?.directories ?? []) zip?.add(`${directory}/`, new Uint8Array(), false);
		await engine.extract(await fileSource(file), archive, password, new Set(selected), {
			start(i) {
				index = i;
				if (zip && zipPaths) current = zip.addStream(zipPaths.files[i], archive.entries[i].size);
				else send({ type: "file", index });
			},
			write(chunk) {
				if (current) current.write(chunk);
				else batch.sink(chunk);
				bytes += chunk.length;
				if (performance.now() - last > 125) {
					last = performance.now();
					progress();
				}
			},
			end() {
				if (current) {
					current.close();
					current = undefined;
				} else {
					batch.flush();
					send({ type: "end" });
				}
			},
		});
		zip?.finish();
		batch.flush();
		// The callback uses a separate MessagePort. Await its reply so all output
		// has reached the save target before the call resolves on the Worker port.
		await receive({ type: "progress", bytes, index });
	},
};

export type UnzipWorker = typeof api;
Comlink.expose(api);
self.postMessage({ type: "ready" });
