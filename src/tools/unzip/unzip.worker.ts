import wasmUrl from "7z-wasm/7zz.wasm?url";
import * as Comlink from "comlink";
import { batchingSink, ZipWriter } from "../../lib/zipWriter.ts";
import { createArchive, positionedBatcher, workerSource } from "./create/engine.ts";
import type { CreateOptions } from "./create/options.ts";
import type { Archive } from "./engine/listing.ts";
import { archiveEngine, fileSource } from "./engine/sevenzip.ts";

export type Output =
	| { type: "file"; index: number }
	| { type: "end" }
	| { type: "bytes"; data: Uint8Array }
	| { type: "progress"; bytes: number; index: number };

export type CreateOutput =
	| { type: "write"; position: number; data: Uint8Array }
	| { type: "truncate"; size: number }
	| { type: "progress"; bytes: number; path: string }
	| { type: "done"; size: number };

async function compile() {
	const response = await fetch(wasmUrl);
	if (!response.ok) throw new Error(`Could not load 7-Zip (${response.status}).`);
	return WebAssembly.compile(await response.arrayBuffer());
}

const compiled = await compile();
const engine = archiveEngine(compiled);

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
	async create(
		files: { path: string; file: File }[],
		directories: string[],
		options: CreateOptions,
		receive: (event: CreateOutput) => void,
	) {
		const batch = positionedBatcher((position, data) =>
			receive(Comlink.transfer({ type: "write", position, data }, [data.buffer as ArrayBuffer])),
		);
		let last = 0;
		const { size } = await createArchive(compiled, workerSource(files, directories), options, {
			write: batch.write,
			truncate(size) {
				batch.flush();
				receive({ type: "truncate", size });
			},
			progress(bytes, path) {
				if (performance.now() - last < 125) return;
				last = performance.now();
				receive({ type: "progress", bytes, path });
			},
		});
		batch.flush();
		// Await the reply on the callback port so every write has arrived before this resolves.
		await receive({ type: "done", size });
	},
};

export type UnzipWorker = typeof api;
Comlink.expose(api);
self.postMessage({ type: "ready" });
