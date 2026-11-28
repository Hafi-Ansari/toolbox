// "Save into a folder…" (SPEC §8.3): opt-in, Chromium desktop only, because it causes browser prompts
// (the folder picker, then "Let site edit files?"). An in-page explanation comes first (`explainOnce`).
// Files go straight into the chosen folder at their sanitized relative paths. Files already there with
// the same size are skipped; other name clashes get "name (1).ext". Writes are positioned, so lanes can
// deliver ranges in any order; contiguous chunks are joined up to `tuning.coalesce` bytes per write.
// The browser can't set modified times: saved files are dated when they were written.
import { explainOnce } from "../../../lib/confirm.tsx";
import { tuning } from "../tuning.ts";
import { FtError, type ManifestFile, type ReceiveSink, type SinkContext } from "../types.ts";
import { numbered, sanitizePaths } from "./paths.ts";

type PickerWindow = Window & {
	showDirectoryPicker?: (options: { mode: "readwrite"; id?: string }) => Promise<FileSystemDirectoryHandle>;
};

/** §14: offered only where the picker exists and the device has a fine pointer (not touch-only). */
export const canSaveFolder = (): boolean =>
	typeof window !== "undefined" &&
	typeof (window as PickerWindow).showDirectoryPicker === "function" &&
	typeof matchMedia === "function" &&
	matchMedia("(pointer: fine)").matches;

/**
 * Explains the coming prompts in the page (once per device), then opens the folder picker. Call it from
 * the click on "Save into a folder…". Resolves null when the person goes back or cancels the picker.
 */
export async function pickFolderSink(ctx: SinkContext): Promise<ReceiveSink | null> {
	const ok = await explainOnce("file-transfer-folder", {
		title: "Save into a folder",
		message: `Your browser will ask you to pick a folder, then ask permission to save files into it. File Transfer only writes the files ${ctx.peerName} is sending.`,
		confirmLabel: "Continue",
		cancelLabel: "Back",
	});
	if (!ok) return null;
	let root: FileSystemDirectoryHandle | undefined;
	try {
		root = await (window as PickerWindow).showDirectoryPicker?.({ mode: "readwrite", id: "file-transfer-receive" });
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") return null;
		throw error;
	}
	return root ? createFolderSink(root) : null;
}

export interface FolderSinkOptions {
	/** Defaults to `tuning.coalesce`. */
	coalesce?: number;
	/** Defaults to `tuning.maxOpenFiles`. */
	maxOpenFiles?: number;
	/** Bytes accepted but not yet written before `write()` waits. Default 64 MiB. */
	maxBuffered?: number;
}

/** Contiguous bytes of one file waiting to be written in one call. */
interface Run {
	start: number;
	buf: Uint8Array<ArrayBuffer>;
	len: number;
}

interface FileState {
	runs: Run[];
	/** Serializes this file's open, writes and close. */
	chain: Promise<void>;
	writable: Promise<FileSystemWritableFileStream> | null;
}

/** At most this many separate runs per file (two lanes may write one file, §7.4). */
const RUNS_PER_FILE = 2;

const isDom = (e: unknown, name: string) => e instanceof DOMException && e.name === name;

const sinkError = (e: unknown) =>
	e instanceof FtError ? e : new FtError("sink-error", e instanceof Error ? e.message : String(e));

class FolderSink implements ReceiveSink {
	readonly mode = "folder" as const;
	readonly ordered = false;
	private readonly root: FileSystemDirectoryHandle;
	private readonly coalesce: number;
	private readonly maxBuffered: number;
	private files: ManifestFile[] = [];
	/** Target path per file, relative to the root. */
	private targets: string[] = [];
	private skipped = new Set<number>();
	private done = new Set<number>();
	private state = new Map<number, FileState>();
	private dirs = new Map<string, Promise<FileSystemDirectoryHandle>>();
	private free: number;
	private slotWaiters: Array<() => void> = [];
	/** `write()` calls waiting for the disk to catch up; while any wait, slots are granted at once (no deadlock). */
	private pressure = 0;
	private buffered = 0;
	private error: FtError | null = null;
	private aborted = false;

	constructor(root: FileSystemDirectoryHandle, options: FolderSinkOptions) {
		this.root = root;
		this.coalesce = options.coalesce ?? tuning.coalesce;
		this.free = options.maxOpenFiles ?? tuning.maxOpenFiles;
		this.maxBuffered = options.maxBuffered ?? 64 * 1024 * 1024;
	}

	async begin(files: ManifestFile[]): Promise<{ skip: number[] }> {
		this.files = [...files].sort((a, b) => a.i - b.i);
		const paths = sanitizePaths(this.files.map((f) => f.path));
		const claimed = new Set(paths.map((p) => p.toLowerCase()));
		this.targets = paths.slice();
		try {
			for (const [k, path] of paths.entries()) {
				const slash = path.lastIndexOf("/");
				const dir = path.slice(0, slash + 1);
				const name = path.slice(slash + 1);
				const parent = await this.existingDir(dir);
				if (!parent) continue; // the folder isn't there yet: nothing can clash
				const existing = await this.entryAt(parent, name);
				if (existing === "none") continue;
				if (existing !== "dir" && existing.size === this.files[k].size) {
					this.skipped.add(k);
					continue;
				}
				for (let n = 1; ; n++) {
					const candidate = numbered(name, n);
					if (claimed.has((dir + candidate).toLowerCase())) continue;
					if ((await this.entryAt(parent, candidate)) !== "none") continue;
					this.targets[k] = dir + candidate;
					claimed.add((dir + candidate).toLowerCase());
					break;
				}
			}
		} catch (e) {
			throw sinkError(e);
		}
		return { skip: [...this.skipped].sort((a, b) => a - b) };
	}

	async write(file: number, offset: number, data: Uint8Array): Promise<void> {
		this.check();
		const f = this.files[file];
		if (!f || this.skipped.has(file) || this.done.has(file)) throw new FtError("protocol", "Write to a skipped file.");
		if (!Number.isSafeInteger(offset) || offset < 0 || offset + data.length > f.size)
			throw new FtError("protocol", "Write beyond the end of a file.");
		if (!data.length) return;
		const st = this.fileState(file);
		let at = 0;
		while (at < data.length) {
			const pos = offset + at;
			let run = st.runs.find((r) => r.start + r.len === pos && r.len < r.buf.length);
			if (!run) {
				if (st.runs.length >= RUNS_PER_FILE) this.flushRun(file, st, st.runs[0]);
				run = { start: pos, buf: new Uint8Array(Math.min(this.coalesce, f.size - pos)), len: 0 };
				st.runs.push(run);
			}
			const n = Math.min(data.length - at, run.buf.length - run.len);
			run.buf.set(data.subarray(at, at + n), run.len);
			run.len += n;
			at += n;
			this.buffered += n;
			if (run.len === run.buf.length) this.flushRun(file, st, run);
		}
		if (this.buffered > this.maxBuffered) {
			// Too much held back: write out every partial run and wait for the disk. This is the only place a
			// lane waits, so while it does, files waiting for an open-file slot get one at once, beyond
			// `maxOpenFiles` if need be. Otherwise a lane could wait for a file that waits for a slot held by a
			// file whose missing bytes sit behind that same lane: a deadlock (WP6; see sinks.test.ts).
			this.pressure++;
			try {
				this.grantAll();
				for (const [i, s] of this.state) for (const r of [...s.runs]) this.flushRun(i, s, r);
				await Promise.all([...this.state.values()].map((s) => s.chain));
			} finally {
				this.pressure--;
			}
			this.check();
		}
	}

	async finishFile(file: number): Promise<void> {
		this.check();
		if (this.skipped.has(file) || this.done.has(file)) return;
		if (!this.files[file]) throw new FtError("protocol", "Unknown file.");
		const st = this.fileState(file);
		for (const r of [...st.runs]) this.flushRun(file, st, r);
		this.done.add(file);
		st.chain = st.chain
			.then(async () => {
				await (await this.writable(file, st)).close();
				this.release();
			})
			.catch((e) => this.fail(e));
		await st.chain;
		this.state.delete(file);
		this.check();
	}

	async finish(): Promise<{ location: string }> {
		for (const f of this.files) {
			if (this.skipped.has(f.i) || this.done.has(f.i)) continue;
			if (f.size !== 0 && !this.state.has(f.i))
				throw new FtError("sink-error", "A file ended before all its bytes arrived.");
			await this.finishFile(f.i);
		}
		this.check();
		return { location: this.root.name };
	}

	async abort(): Promise<void> {
		this.aborted = true;
		this.error ??= new FtError("sink-error", "Cancelled.");
		const states = [...this.state.values()];
		this.state.clear();
		await Promise.all(
			states.map(async (st) => {
				await st.chain.catch(() => {});
				// Aborting a writable discards it: the file never appears half-written.
				const w = await st.writable?.catch(() => null);
				await w?.abort().catch(() => {});
			}),
		);
	}

	/** Number of files skipped because they were already there. */
	get skippedCount(): number {
		return this.skipped.size;
	}

	/** Where file `i` is saved, relative to the chosen folder. */
	targetOf(i: number): string {
		return this.targets[i];
	}

	private check(): void {
		if (this.error) throw this.error;
	}

	private fail(e: unknown): void {
		this.error ??= sinkError(e);
	}

	private fileState(file: number): FileState {
		let st = this.state.get(file);
		if (!st) {
			st = { runs: [], chain: Promise.resolve(), writable: null };
			this.state.set(file, st);
		}
		return st;
	}

	private flushRun(file: number, st: FileState, run: Run): void {
		st.runs.splice(st.runs.indexOf(run), 1);
		st.chain = st.chain
			.then(async () => {
				if (this.aborted) return;
				const w = await this.writable(file, st);
				await w.write({ type: "write", position: run.start, data: run.buf.subarray(0, run.len) });
			})
			.catch((e) => this.fail(e))
			.finally(() => {
				this.buffered -= run.len;
			});
	}

	/** Opens the file's writable on first use, within the open-files limit. */
	private writable(file: number, st: FileState): Promise<FileSystemWritableFileStream> {
		if (this.error) return Promise.reject(this.error);
		st.writable ??= (async () => {
			await this.acquire();
			try {
				const path = this.targets[file];
				const slash = path.lastIndexOf("/");
				const dir = await this.makeDir(path.slice(0, slash + 1));
				const handle = await dir.getFileHandle(path.slice(slash + 1), { create: true });
				return await handle.createWritable({ keepExistingData: false });
			} catch (e) {
				this.release();
				throw e;
			}
		})();
		return st.writable;
	}

	/** An open-file slot. `free` may go below zero while a lane waits for the disk (see `write`). */
	private async acquire(): Promise<void> {
		if (this.free > 0 || this.pressure > 0) {
			this.free--;
			return;
		}
		// Resolved by `release` or `grantAll`, which hand their slot over (already counted in `free`).
		await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
	}

	private release(): void {
		const next = this.slotWaiters.shift();
		if (next) next();
		else this.free++;
	}

	private grantAll(): void {
		for (const next of this.slotWaiters.splice(0)) {
			this.free--;
			next();
		}
	}

	/** "a/b/" → the handle, created as needed. */
	private makeDir(dir: string): Promise<FileSystemDirectoryHandle> {
		const key = dir.toLowerCase();
		let handle = this.dirs.get(key);
		if (!handle) {
			const parts = dir.split("/").filter(Boolean);
			handle = parts.length
				? this.makeDir(`${parts.slice(0, -1).join("/")}${parts.length > 1 ? "/" : ""}`).then((parent) =>
						parent.getDirectoryHandle(parts[parts.length - 1], { create: true }),
					)
				: Promise.resolve(this.root);
			this.dirs.set(key, handle);
			handle.catch(() => this.dirs.delete(key));
		}
		return handle;
	}

	/** "a/b/" → the handle if it already exists, else null. */
	private async existingDir(dir: string): Promise<FileSystemDirectoryHandle | null> {
		let handle = this.root;
		for (const part of dir.split("/").filter(Boolean)) {
			try {
				handle = await handle.getDirectoryHandle(part);
			} catch (e) {
				if (isDom(e, "NotFoundError")) return null;
				if (isDom(e, "TypeMismatchError"))
					throw new FtError("sink-error", `A file named "${part}" is in the way of a folder.`);
				throw e;
			}
		}
		return handle;
	}

	private async entryAt(dir: FileSystemDirectoryHandle, name: string): Promise<"none" | "dir" | File> {
		try {
			return await (await dir.getFileHandle(name)).getFile();
		} catch (e) {
			if (isDom(e, "NotFoundError")) return "none";
			if (isDom(e, "TypeMismatchError")) return "dir";
			throw e;
		}
	}
}

/** A folder sink writing into `root` (from the picker, or a fake in tests). */
export function createFolderSink(
	root: FileSystemDirectoryHandle,
	options: FolderSinkOptions = {},
): ReceiveSink & {
	readonly skippedCount: number;
	targetOf(i: number): string;
} {
	return new FolderSink(root, options);
}
