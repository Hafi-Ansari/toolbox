// The zip half of the ordered sinks (zip stream §8.2, memory fallback §8.4): turns the receiver's
// in-order `write`/`finishFile` calls into `ZipWriter.addStream` entries, one per manifest file, in
// manifest order. Store-only, ZIP64 when needed, with modified times. `planZip` fixes the entry names
// and the exact archive length before any byte is written.
import { type ChunkSink, ZipWriter } from "../../../lib/zipWriter.ts";
import { zipName } from "../tuning.ts";
import { FtError, type ManifestFile } from "../types.ts";
import { sanitizePaths, sanitizeSegment } from "./paths.ts";
import { type ZipEntrySpec, zipSize } from "./zipSize.ts";

/** The download's file name: "Photos from Calm Otter.zip", sanitized like any path segment. */
export function downloadName(peerName: string): string {
	return sanitizeSegment(zipName(peerName)) || "Photos.zip";
}

export interface ZipPlan {
	/** Manifest files ordered by `i` (dense from 0). */
	files: ManifestFile[];
	/** Entry names and options, index-aligned with `files`. */
	entries: ZipEntrySpec[];
	/** Exact archive length in bytes. */
	length: number;
	/** Sum of the file sizes. */
	bytes: number;
}

export function planZip(manifest: readonly ManifestFile[]): ZipPlan {
	const files = [...manifest].sort((a, b) => a.i - b.i);
	files.forEach((f, k) => {
		if (f.i !== k) throw new FtError("protocol", "Manifest file indexes are not dense.");
	});
	const names = sanitizePaths(files.map((f) => f.path));
	const entries = files.map((f, k): ZipEntrySpec => {
		const e: ZipEntrySpec = { name: names[k], size: f.size };
		// mtime 0 means "unknown": keep the fixed date rather than claim 1970.
		if (f.mtime > 0) e.modified = f.mtime;
		return e;
	});
	return { files, entries, length: zipSize(entries), bytes: files.reduce((n, f) => n + f.size, 0) };
}

const protocol = (why: string) => new FtError("protocol", why);

export class ZipFeed {
	private readonly zip: ZipWriter;
	private readonly plan: ZipPlan;
	/** The entry being written. */
	private cur: { file: number; done: number; entry: ReturnType<ZipWriter["addStream"]> } | null = null;
	/** Next manifest file to open; everything below it (except `cur`) is closed. */
	private next = 0;
	private finished = false;

	constructor(plan: ZipPlan, out: ChunkSink) {
		this.plan = plan;
		this.zip = new ZipWriter(out);
	}

	get bytesWritten(): number {
		return this.zip.bytesWritten;
	}

	/** Bytes must arrive in stream order. Bytes below what is already written are dropped (requeued duplicates). */
	write(file: number, offset: number, data: Uint8Array): void {
		if (this.isClosed(file)) {
			if (offset + data.length > this.plan.files[file].size) throw protocol("Write beyond the end of a file.");
			return;
		}
		const cur = this.enter(file);
		if (offset > cur.done) throw protocol("Zip stream bytes arrived out of order.");
		if (offset + data.length <= cur.done) return;
		const fresh = data.subarray(cur.done - offset);
		if (cur.done + fresh.length > this.plan.files[file].size) throw protocol("Write beyond the end of a file.");
		cur.entry.write(fresh);
		cur.done += fresh.length;
	}

	finishFile(file: number): void {
		if (this.isClosed(file)) return;
		this.enter(file);
		this.closeCurrent();
	}

	/** Closes the last entries and writes the central directory. */
	finish(): void {
		if (this.finished) return;
		if (this.cur) this.closeCurrent();
		this.skipEmptyUpTo(this.plan.files.length);
		this.zip.finish();
		this.finished = true;
	}

	private isClosed(file: number): boolean {
		if (!Number.isSafeInteger(file) || file < 0 || file >= this.plan.files.length) throw protocol("Unknown file.");
		if (this.finished) throw protocol("Write after finish.");
		return file < this.next && this.cur?.file !== file;
	}

	private enter(file: number) {
		if (this.cur?.file === file) return this.cur;
		if (this.cur) this.closeCurrent();
		this.skipEmptyUpTo(file);
		const f = this.plan.files[file];
		const spec = this.plan.entries[file];
		this.cur = { file, done: 0, entry: this.zip.addStream(spec.name, f.size, spec.modified) };
		this.next = file + 1;
		return this.cur;
	}

	private closeCurrent(): void {
		const cur = this.cur;
		if (!cur) return;
		if (cur.done !== this.plan.files[cur.file].size) throw protocol("A file ended before all its bytes arrived.");
		cur.entry.close();
		this.cur = null;
	}

	/** Files before `file` that never saw a write must be empty: they are written as they are. */
	private skipEmptyUpTo(file: number): void {
		for (; this.next < file; this.next++) {
			const f = this.plan.files[this.next];
			if (f.size !== 0) throw protocol("Zip stream skipped a file.");
			const spec = this.plan.entries[this.next];
			this.zip.addStream(spec.name, 0, spec.modified).close();
		}
	}
}
