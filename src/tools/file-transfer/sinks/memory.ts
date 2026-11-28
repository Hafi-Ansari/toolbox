// Memory fallback (SPEC §8.4): the same zip as the stream sink, built into a Blob, then saved with
// exactly one download through an object URL. For browsers where the service-worker stream can't
// start (iOS, Safari). Batches over `tuning.memoryMax` are refused with `FtError("too-big")`.
import { batchingSink } from "../../../lib/zipWriter.ts";
import { tuning } from "../tuning.ts";
import { FtError, type ManifestFile, type ReceiveSink, type SinkContext } from "../types.ts";
import { downloadName, planZip, ZipFeed } from "./zipFeed.ts";

/** True when a batch of these files fits the memory fallback (compare with `hello.caps.memoryMax`). */
export const fitsInMemory = (files: readonly Pick<ManifestFile, "size">[], max = tuning.memoryMax) =>
	files.reduce((n, f) => n + f.size, 0) <= max;

/** Saves a Blob as one download, without a prompt. */
export function saveBlob(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.hidden = true;
	document.body.append(a);
	a.click();
	a.remove();
	// Revoking at once can cancel the download in some browsers.
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface MemorySinkOptions {
	/** Defaults to `tuning.memoryMax`. */
	max?: number;
	/** Where the finished archive goes; defaults to `saveBlob`. Tests capture it here. */
	save?: (blob: Blob, name: string) => void;
}

class MemorySink implements ReceiveSink {
	readonly mode = "memory" as const;
	readonly ordered = true;
	private readonly name: string;
	private readonly options: MemorySinkOptions;
	private parts: Uint8Array<ArrayBuffer>[] = [];
	private feed: ZipFeed | null = null;
	private flushParts: (() => void) | null = null;

	constructor(ctx: SinkContext, options: MemorySinkOptions) {
		this.name = downloadName(ctx.peerName);
		this.options = options;
	}

	async begin(files: ManifestFile[]): Promise<{ skip: number[] }> {
		if (!fitsInMemory(files, this.options.max)) throw new FtError("too-big");
		const plan = planZip(files);
		// Coalesce the many small pieces into ~4 MiB parts (batchingSink copies them).
		const { sink, flush } = batchingSink((chunk) => this.parts.push(chunk as Uint8Array<ArrayBuffer>));
		this.flushParts = flush;
		this.feed = new ZipFeed(plan, sink);
		return { skip: [] };
	}

	async write(file: number, offset: number, data: Uint8Array): Promise<void> {
		this.active().write(file, offset, data);
	}

	async finishFile(file: number): Promise<void> {
		this.active().finishFile(file);
	}

	async finish(): Promise<{ location: string }> {
		this.active().finish();
		this.flushParts?.();
		const blob = new Blob(this.parts, { type: "application/zip" });
		this.parts = [];
		this.feed = null;
		(this.options.save ?? saveBlob)(blob, this.name);
		return { location: this.name };
	}

	async abort(): Promise<void> {
		this.parts = [];
		this.feed = null;
	}

	private active(): ZipFeed {
		if (!this.feed) throw new FtError("sink-error", "The zip isn't open.");
		return this.feed;
	}
}

export function createMemorySink(ctx: SinkContext, options: MemorySinkOptions = {}): ReceiveSink {
	return new MemorySink(ctx, options);
}
