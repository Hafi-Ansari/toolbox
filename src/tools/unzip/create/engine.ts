// Creates an archive with 7-Zip ("7zz a"). Inputs are read from /src (WORKERFS in the
// browser, so files are read in ranges on demand). The archive is written to a device
// node that forwards each positioned write, so the output never sits in the WASM heap.
import type { SevenZipModule } from "7z-wasm";
import { Gzip } from "fflate";
import { newSevenZip, redirectStdout } from "../engine/sevenzip.ts";
import { type CreateOptions, extension, GZIP_LEVELS, sevenZipSwitches } from "./options.ts";

export const SOURCE = "/src";

export interface CreateSource {
	/** Populate SOURCE with the files and folders to add. */
	mount(module: SevenZipModule): void;
}

export interface CreateSink {
	/** `chunk` is a view into 7-Zip's memory: copy it to keep it. */
	write(position: number, chunk: Uint8Array): void;
	/** 7-Zip shrinks the file after rewriting an entry that didn't compress (ZIP). */
	truncate(size: number): void;
	/** Bytes read from the inputs so far and the file being read. */
	progress?(bytes: number, path: string): void;
}

type Node = object;
type Stream = { path?: string; position: number; node: Node };
interface LooseFS {
	open(path: string, flags: number | string, mode?: number): Stream;
	read(stream: Stream, buffer: Uint8Array, offset: number, length: number, position?: number): number;
	mkdir(path: string): void;
	mkdev(path: string, mode: number, dev: number): void;
	makedev(major: number, minor: number): number;
	registerDevice(dev: number, ops: object): void;
	chdir(path: string): void;
	ftruncate(fd: number, length: number): void;
	getStream(fd: number): Stream | null;
	ErrnoError: new (errno: number) => Error;
}

/** Emscripten passes HEAP8 (signed) views; everything downstream expects bytes. */
const bytes = (data: ArrayBufferView, offset: number, length: number) =>
	new Uint8Array(data.buffer, data.byteOffset + offset, length);

const O_CREAT = 0o100;
const O_EXCL = 0o200;
const O_TRUNC = 0o1000;
const EIO = 29;
const EINVAL = 28;

export async function createArchive(
	compiled: WebAssembly.Module,
	source: CreateSource,
	options: CreateOptions,
	sink: CreateSink,
): Promise<{ size: number }> {
	const stderr: string[] = [];
	const module = await newSevenZip(
		compiled,
		() => {},
		(line) => stderr.push(line),
	);
	const fs = module.FS as unknown as LooseFS;
	source.mount(module);

	// Count input bytes for progress, and name a file the browser can no longer read.
	let unreadable: string | undefined;
	// Count each file's furthest byte: ZIP re-reads a file it stores after compression didn't pay.
	let bytesRead = 0;
	const reached = new Map<string, number>();
	const read = fs.read;
	fs.read = (stream, buffer, offset, length, position) => {
		const path = stream.path?.startsWith(`${SOURCE}/`) ? stream.path.slice(SOURCE.length + 1) : undefined;
		try {
			const start = position ?? stream.position;
			const count = read.call(fs, stream, buffer, offset, length, position);
			if (path !== undefined) {
				const before = reached.get(path) ?? 0;
				if (start + count > before) {
					reached.set(path, start + count);
					bytesRead += start + count - before;
				}
				sink.progress?.(bytesRead, path);
			}
			return count;
		} catch (error) {
			if (error instanceof fs.ErrnoError) throw error;
			unreadable ??= path ?? "a file";
			throw new fs.ErrnoError(EIO);
		}
	};

	let size = 0;
	let gzip: Gzip | undefined;
	let target: string;
	if (options.format === "tar.gz") {
		target = "/out.tar";
		gzip = new Gzip({ level: GZIP_LEVELS[options.level] }, (chunk) => {
			sink.write(size, chunk);
			size += chunk.length;
		});
		const stream = gzip;
		redirectStdout(module, (chunk) => stream.push(bytes(chunk, 0, chunk.length).slice()));
	} else {
		fs.mkdir("/out");
		target = `/out/archive${extension(options.format)}`;
		const device = fs.makedev(98, 0);
		fs.registerDevice(device, {
			write(_stream: Stream, data: Uint8Array, offset: number, length: number, position: number) {
				sink.write(position, bytes(data, offset, length));
				size = Math.max(size, position + length);
				return length;
			},
			read: () => 0,
			llseek(stream: Stream, offset: number, whence: number) {
				const at = (whence === 1 ? stream.position : whence === 2 ? size : 0) + offset;
				if (at < 0) throw new fs.ErrnoError(EINVAL);
				return at;
			},
		});
		// 7-Zip must see no archive at the path (or it would try to update it), so the
		// device appears only when 7-Zip creates the file.
		const open = fs.open;
		let created = false;
		const ftruncate = fs.ftruncate;
		fs.ftruncate = (fd, length) => {
			if (fs.getStream(fd)?.path !== target) return ftruncate.call(fs, fd, length);
			size = length;
			sink.truncate(length);
		};
		fs.open = (path, flags, mode) => {
			if (path === target && typeof flags === "number" && flags & O_CREAT) {
				if (!created) fs.mkdev(target, 0o600, device);
				created = true;
				return open.call(fs, path, flags & ~(O_CREAT | O_EXCL | O_TRUNC), mode);
			}
			return open.call(fs, path, flags, mode);
		};
	}

	fs.chdir(SOURCE);
	let exit: number;
	try {
		exit = Number(module.callMain(["a", ...sevenZipSwitches(options), target, "*"]));
	} catch (error) {
		// A read error surfaces as an uncaught C++ exception (a bare number).
		if (unreadable !== undefined) throw new Error(`UNREADABLE:${unreadable}`);
		if (/out of memory|memory access out of bounds|cannot enlarge|allocation failed|Aborted/i.test(String(error))) {
			throw new Error("OOM");
		}
		if (typeof error === "number") throw new Error("7-Zip stopped with an internal error.");
		throw error;
	}
	if (unreadable !== undefined) throw new Error(`UNREADABLE:${unreadable}`);
	const reason = stderr.join("\n");
	if (exit === 8 || /not enough memory|out of memory|cannot allocate memory/i.test(reason)) throw new Error("OOM");
	if (exit !== 0)
		throw new Error(`7-Zip could not create the archive. ${reason.trim().split("\n").pop() ?? ""}`.trim());
	if (gzip) gzip.push(new Uint8Array(), true);
	return { size };
}

/** Browser source: files are WORKERFS nodes, read lazily from the File objects. */
export function workerSource(files: { path: string; file: File }[], directories: string[]): CreateSource {
	return {
		mount(module) {
			const fs = module.FS as unknown as LooseFS & {
				mount(type: object, options: object, path: string): void;
				lookupPath(path: string): { node: Node };
			};
			const workerfs = module.WORKERFS as unknown as {
				createNode(parent: Node, name: string, mode: number, dev: number, contents?: Blob, mtime?: Date): Node;
				DIR_MODE: number;
				FILE_MODE: number;
			};
			fs.mkdir(SOURCE);
			fs.mount(module.WORKERFS, { blobs: [] }, SOURCE);
			const root = fs.lookupPath(SOURCE).node;
			const folders = new Map<string, Node>([["", root]]);
			const folder = (path: string): Node => {
				const known = folders.get(path);
				if (known) return known;
				const slash = path.lastIndexOf("/");
				const node = workerfs.createNode(
					folder(path.slice(0, Math.max(0, slash))),
					path.slice(slash + 1),
					workerfs.DIR_MODE,
					0,
				) as { mode: number };
				// WORKERFS marks everything rwx for all; store ordinary permissions instead.
				node.mode = 0o40755;
				folders.set(path, node);
				return node;
			};
			for (const directory of directories) folder(directory);
			for (const { path, file } of files) {
				const slash = path.lastIndexOf("/");
				const node = workerfs.createNode(
					folder(path.slice(0, Math.max(0, slash))),
					path.slice(slash + 1),
					workerfs.FILE_MODE,
					0,
					file,
					new Date(file.lastModified || Date.now()),
				) as { mode: number };
				node.mode = 0o100644;
			}
		},
	};
}

/** Coalesces contiguous writes into batches of about `size` bytes. */
export function positionedBatcher(forward: (position: number, data: Uint8Array) => void, size = 1 << 20) {
	let buffer = new Uint8Array(size);
	let start = 0;
	let length = 0;
	const flush = () => {
		if (length === 0) return;
		if (length === size) {
			forward(start, buffer);
			buffer = new Uint8Array(size);
		} else forward(start, buffer.slice(0, length));
		length = 0;
	};
	return {
		write(position: number, chunk: Uint8Array) {
			if (length && position !== start + length) flush();
			let offset = 0;
			while (offset < chunk.length) {
				if (length === 0) start = position + offset;
				const count = Math.min(size - length, chunk.length - offset);
				buffer.set(chunk.subarray(offset, offset + count), length);
				length += count;
				offset += count;
				if (length === size) flush();
			}
		},
		flush,
	};
}
