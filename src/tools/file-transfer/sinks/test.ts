// Injectable test sink (SPEC §8.5). Selected when Playwright sets `window.__sendTestSink = true`.
// It keeps each file's bytes until `finishFile` (test files are small), hashes them with
// `crypto.subtle`, and appends `{ path, size, sha256 }` to `window.__sendReceived`.
// Unordered by default; with `window.__sendTestSinkOrdered` it is ordered and checks that bytes really
// arrive in stream order, to exercise the zip path's scheduler.
import { FtError, type ManifestFile, type ReceivedFile, type ReceiveSink } from "../types.ts";
import { sanitizePaths } from "./paths.ts";

/** True when the page should receive into the test sink. */
export const testSinkRequested = (): boolean => typeof window !== "undefined" && window.__sendTestSink === true;

export interface TestSinkOptions {
	/** Defaults to `window.__sendTestSinkOrdered === true`. */
	ordered?: boolean;
	/** Where results go; defaults to `window.__sendReceived` (created if missing). */
	received?: ReceivedFile[];
}

const hex = (buffer: ArrayBuffer) =>
	Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
const protocol = (why: string) => new FtError("protocol", why);

class TestSink implements ReceiveSink {
	readonly mode = "test" as const;
	readonly ordered: boolean;
	private readonly received: ReceivedFile[];
	private files: ManifestFile[] = [];
	private paths: string[] = [];
	private data = new Map<number, Uint8Array<ArrayBuffer>>();
	private done = new Set<number>();
	/** Ordered mode: the stream position (file, offset) the next write must start at or before. */
	private at = { file: 0, offset: 0 };

	constructor(options: TestSinkOptions) {
		this.ordered = options.ordered ?? (typeof window !== "undefined" && window.__sendTestSinkOrdered === true);
		if (options.received) this.received = options.received;
		else {
			window.__sendReceived ??= [];
			this.received = window.__sendReceived;
		}
	}

	async begin(files: ManifestFile[]): Promise<{ skip: number[] }> {
		this.files = [...files].sort((a, b) => a.i - b.i);
		this.paths = sanitizePaths(this.files.map((f) => f.path));
		return { skip: [] };
	}

	async write(file: number, offset: number, data: Uint8Array): Promise<void> {
		const f = this.files[file];
		if (!f || this.done.has(file)) throw protocol("Write to an unknown or finished file.");
		if (!Number.isSafeInteger(offset) || offset < 0 || offset + data.length > f.size)
			throw protocol("Write beyond the end of a file.");
		if (this.ordered) {
			const { file: atFile, offset: atOffset } = this.at;
			const skipsBytes =
				file > atFile &&
				(offset !== 0 ||
					atOffset < this.files[atFile].size ||
					this.files.slice(atFile + 1, file).some((between) => between.size > 0));
			if (file < atFile || (file === atFile && offset > atOffset) || skipsBytes)
				throw protocol(`Out of order: file ${file} at ${offset}, expected file ${atFile} at ${atOffset}.`);
			const end = offset + data.length;
			this.at = file === atFile ? { file, offset: Math.max(atOffset, end) } : { file, offset: end };
		}
		let buffer = this.data.get(file);
		if (!buffer) {
			buffer = new Uint8Array(f.size);
			this.data.set(file, buffer);
		}
		buffer.set(data, offset);
	}

	async finishFile(file: number): Promise<void> {
		const f = this.files[file];
		if (!f) throw protocol("Unknown file.");
		if (this.done.has(file)) return;
		this.done.add(file);
		const bytes = this.data.get(file) ?? new Uint8Array(0);
		this.data.delete(file);
		const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
		this.received.push({ path: this.paths[file], size: f.size, sha256 });
	}

	async finish(): Promise<{ location: string }> {
		for (const f of this.files) if (!this.done.has(f.i)) await this.finishFile(f.i);
		return { location: "test" };
	}

	async abort(): Promise<void> {
		this.data.clear();
	}
}

export function createTestSink(options: TestSinkOptions = {}): ReceiveSink {
	return new TestSink(options);
}
