import SevenZip, { type FSStream, type SevenZipModule, type SevenZipModuleOptions } from "7z-wasm";
import { type DetectedFormat, detectFile } from "../../../lib/detect.ts";
import { type Archive, type Entry, parseListing, totalBytes } from "./listing.ts";
import { type EntrySink, splitOutput } from "./split.ts";
import { isTarHeader, tarReader } from "./tar.ts";

type Setup = (module: SevenZipModule) => void;
type Bytes = (chunk: Uint8Array) => void;

export interface ArchiveSource {
	path: string;
	mount: Setup;
}

type Options = Omit<Partial<SevenZipModuleOptions>, "stdin"> & {
	noInitialRun: boolean;
	stdin: () => null;
	instantiateWasm?: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => object) => object;
};

/** The CLI isn't reentrant. Reusing compiled code still leaves every run its own heap and FS. */
export async function newSevenZip(
	compiled: WebAssembly.Module,
	print: (line: string) => void,
	printErr: (line: string) => void,
) {
	const options: Options = {
		noInitialRun: true,
		stdin: () => null,
		print,
		printErr,
		instantiateWasm(imports, done) {
			return done(new WebAssembly.Instance(compiled, imports));
		},
	};
	return SevenZip(options as unknown as Partial<SevenZipModuleOptions>);
}

export function redirectStdout(module: SevenZipModule, write: Bytes) {
	// The published typings omit these Emscripten methods' runtime signatures.
	const fs = module.FS as SevenZipModule["FS"] & { getStream(fd: number): FSStream };
	const device = fs.makedev(99, 0);
	fs.registerDevice(device, {
		write(_stream: FSStream, data: Uint8Array, offset: number, length: number) {
			write(data.subarray(offset, offset + length));
			return length;
		},
	});
	fs.mkdev("/dev/archive-output", 0o600, device);
	fs.close(fs.getStream(1));
	fs.open("/dev/archive-output", "w");
}

const extensions: Partial<Record<DetectedFormat, string>> = {
	zip: ".zip",
	epub: ".zip",
	"7z": ".7z",
	rar: ".rar",
	gzip: ".gz",
	bzip2: ".bz2",
	xz: ".xz",
	zstd: ".zst",
	cab: ".cab",
	tar: ".tar",
};

export async function fileSource(file: File): Promise<ArchiveSource> {
	// A filename extension is only a hint for formats whose signature isn't in the first block.
	const suffix = extensions[await detectFile(file)] ?? file.name.match(/\.[a-z\d]{1,12}$/i)?.[0] ?? "";
	const name = `archive${suffix}`;
	return {
		path: `/input/${name}`,
		mount(module) {
			module.FS.mkdir("/input");
			module.FS.mount(module.WORKERFS, { blobs: [{ name, data: file }] }, "/input");
		},
	};
}

const wrapperFormats = new Set(["gzip", "bzip2", "xz", "zstd"]);
const innerTar = /\.(?:tar\.(?:gz|bz2|xz|zst|zstd)|tgz|tbz2?|txz|tzst)$/i;

export function archiveEngine(compiled: WebAssembly.Module) {
	async function run(source: ArchiveSource, password: string, args: string[], output?: Bytes, paths?: string[]) {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const module = await newSevenZip(
			compiled,
			(line) => stdout.push(line),
			(line) => stderr.push(line),
		);
		source.mount(module);
		if (output) redirectStdout(module, output);
		if (paths) module.FS.writeFile("/files.txt", `${paths.join("\n")}\n`);
		let exit: number;
		try {
			exit = Number(
				module.callMain([
					...args,
					"-sccUTF-8",
					"-bsp0",
					"-y",
					`-p${password}`,
					source.path,
					...(paths ? ["@/files.txt"] : []),
				]),
			);
		} catch (error) {
			if (/out of memory|memory access out of bounds|cannot enlarge|allocation failed/i.test(String(error))) {
				throw new Error("OOM");
			}
			throw error;
		}
		if (exit !== 0) {
			const reason = stderr.join("\n");
			if (/wrong password|cannot open encrypted|enter password/i.test(reason)) {
				throw new Error(password ? "WRONG_PASSWORD" : "NEEDS_PASSWORD");
			}
			if (/not enough memory|out of memory|cannot allocate memory/i.test(reason)) throw new Error("OOM");
			if (/unsupported method|is not archive|cannot open the file as archive/i.test(reason))
				throw new Error("UNSUPPORTED");
			if (/missing volume|need.*volume|next volume/i.test(reason)) throw new Error("MISSING_VOLUME");
			throw new Error("CORRUPT");
		}
		return stdout;
	}

	const stream = (source: ArchiveSource, password: string, output: Bytes, paths?: string[]) =>
		run(source, password, ["x", "-so", "-spd", "-ssc", "-scsUTF-8", "-bso0"], output, paths);

	return {
		async list(source: ArchiveSource, name: string, password: string): Promise<Archive> {
			const { format, entries } = parseListing(await run(source, password, ["l", "-slt"]));
			let compressedTar = false;
			if (wrapperFormats.has(format.toLowerCase()) && entries.length === 1) {
				const entry = entries[0];
				const looksLikeTar = innerTar.test(name) || /\.tar$/i.test(entry.path);
				const first = new Uint8Array(512);
				let firstBytes = 0;
				let size = 0;
				const nested: Entry[] = [];
				const tar = tarReader({ start: (e) => nested.push(e), write() {}, end() {} });
				await stream(source, password, (chunk) => {
					size += chunk.length;
					if (firstBytes < first.length) {
						const count = Math.min(first.length - firstBytes, chunk.length);
						first.set(chunk.subarray(0, count), firstBytes);
						firstBytes += count;
						if (firstBytes < first.length) return;
						compressedTar = isTarHeader(first) || (looksLikeTar && first.every((byte) => byte === 0));
						if (compressedTar) tar.write(first);
						chunk = chunk.subarray(count);
					}
					if (compressedTar) tar.write(chunk);
				});
				if (compressedTar) {
					tar.finish();
					return {
						format: `tar.${format === "gzip" ? "gz" : format === "bzip2" ? "bz2" : format === "zstd" ? "zst" : format}`,
						entries: nested,
						total: totalBytes(nested),
						compressedTar,
					};
				}
				entry.size = size;
				if (!entry.path || /^archive(?:\.|$)/i.test(entry.path))
					entry.path = name.replace(/\.[^.]+$/, "") || "uncompressed";
			}
			return { format, entries, total: totalBytes(entries), compressedTar };
		},

		async extract(source: ArchiveSource, archive: Archive, password: string, selected: Set<number>, sink: EntrySink) {
			const entries = archive.entries;
			if (selected.size === 0) return;
			let wanted = false;
			if (archive.compressedTar) {
				let index = 0;
				const tar = tarReader({
					start(entry) {
						const listed = entries[index];
						if (!listed || listed.path !== entry.path || listed.size !== entry.size) {
							throw new Error("Archive headers don't match the extracted contents.");
						}
						wanted = !entry.folder && selected.has(index);
						if (wanted) sink.start(index);
						index++;
					},
					write: (chunk) => {
						if (wanted) sink.write(chunk);
					},
					end() {
						if (wanted) sink.end();
					},
				});
				await stream(source, password, tar.write);
				tar.finish();
				if (index !== entries.length) throw new Error("Archive headers don't match the extracted contents.");
				return;
			}

			const files = entries.flatMap((entry, index) => (entry.folder ? [] : [index]));
			const paths = files.filter((index) => selected.has(index)).map((index) => entries[index].path);
			// Listing replaces controls with underscores. Some names cannot be represented by a list file.
			// Decode in order and discard unselected data in these cases and for repeated names.
			const selectedPaths = new Set(paths);
			const unfiltered =
				wrapperFormats.has(archive.format.toLowerCase()) ||
				paths.length === files.length ||
				paths.some((path) => !path || /[_"\\]|^\s|\s$/.test(path)) ||
				files.filter((index) => selectedPaths.has(entries[index].path)).length !== selectedPaths.size;
			const split = splitOutput(entries, unfiltered ? files : files.filter((index) => selected.has(index)), {
				start(index) {
					wanted = selected.has(index);
					if (wanted) sink.start(index);
				},
				write(chunk) {
					if (wanted) sink.write(chunk);
				},
				end() {
					if (wanted) sink.end();
				},
			});
			await stream(source, password, split.write, unfiltered ? undefined : paths);
			split.finish();
		},
	};
}
