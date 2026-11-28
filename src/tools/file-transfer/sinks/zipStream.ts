// The default receive mode (SPEC §8.2): one prompt-free download, "Transfer from <peer> <date time>.zip", streamed
// through the service worker public/ft-sw.js. Store-only ZIP64 with modified times, an exact
// Content-Length from zipSize, keepalive pings, and a started-check: if the service worker's fetch
// handler doesn't run within 5 s, `begin()` falls back to the memory sink (§8.4) before any byte is
// written. The bytes are written on the main thread; CRC32 runs at several hundred MB/s there.
import { ZIP_STREAM } from "../tuning.ts";
import {
	FtError,
	type ManifestFile,
	type PortToSw,
	type ReceiveSink,
	type SinkContext,
	type SinkMode,
	type SwOpen,
	type SwToPage,
} from "../types.ts";
import { createMemorySink, type MemorySinkOptions } from "./memory.ts";
import { downloadName, planZip, ZipFeed } from "./zipFeed.ts";

/**
 * WebKit: every browser on iOS (Chrome and Firefox there are WebKit too) and Safari on the Mac. Its page
 * reads a service worker's download response, so the started-check passes and every byte flows, but
 * the download that "Save…" then starts never arrives: it sat at 0 KB in Chrome on an iPhone. So
 * WebKit uses the memory fallback, as SPEC §8.4 intends.
 */
export function isWebKitOnly(nav: Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints"> = navigator): boolean {
	const ua = nav.userAgent;
	if (/iPad|iPhone|iPod/.test(ua)) return true;
	// iPadOS reports itself as a Mac; a touch screen gives it away.
	if (nav.platform === "MacIntel" && nav.maxTouchPoints > 1) return true;
	return /Safari\//.test(ua) && /Version\//.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua);
}

/** §14 feature detection. The started-check decides the rest. */
export const canStreamZip = (): boolean =>
	typeof navigator !== "undefined" &&
	"serviceWorker" in navigator &&
	typeof ReadableStream === "function" &&
	!isWebKitOnly();

/** Bytes the page queues for the service worker before `write()` waits. */
const PAGE_HIGH_WATER = 8 * 1024 * 1024;

let ready: Promise<ServiceWorker> | null = null;

/** Registers the service worker once per page and resolves with the activated worker. */
export function serviceWorker(): Promise<ServiceWorker> {
	ready ??= (async () => {
		const reg = await navigator.serviceWorker.register(ZIP_STREAM.swUrl, { scope: ZIP_STREAM.scope });
		// Prefer a newer worker that is still installing: it will take over the scope (skipWaiting).
		const sw = reg.installing ?? reg.waiting ?? reg.active;
		if (!sw) throw new Error("Service worker did not install.");
		if (sw.state !== "activated") {
			await new Promise<void>((resolve, reject) => {
				const check = () => {
					if (sw.state === "activated") resolve();
					else if (sw.state === "redundant") reject(new Error("Service worker became redundant."));
				};
				sw.addEventListener("statechange", check);
				check();
			});
		}
		return sw;
	})();
	ready.catch(() => {
		ready = null;
	});
	return ready;
}

function randomId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fetch the download after this even without "opened" (a service worker cached from before it existed). */
const OPENED_FALLBACK_MS = 1000;

const wait = (ms: number) => new Promise<false>((resolve) => setTimeout(() => resolve(false), ms));

/** One streamed download through the service worker. */
export class SwDownload {
	/** Resolves true when the service worker's fetch handler ran, false after `startedTimeoutMs`. */
	readonly started: Promise<boolean>;
	private readonly port: MessagePort;
	private readonly frame: HTMLIFrameElement;
	private readonly ping: ReturnType<typeof setInterval>;
	private queue: ArrayBuffer[] = [];
	private queued = 0;
	private credit = 0;
	private sent = 0;
	private error: FtError | null = null;
	private closed = false;
	private waiters: Array<() => void> = [];

	private constructor(sw: ServiceWorker, name: string, length: number | null, timeoutMs: number) {
		const channel = new MessageChannel();
		this.port = channel.port1;
		const id = randomId();
		let onStarted: (v: boolean) => void = () => {};
		const started = new Promise<boolean>((resolve) => {
			onStarted = resolve;
		});
		this.started = Promise.race([started, wait(timeoutMs)]);
		this.frame = document.createElement("iframe");
		this.frame.hidden = true;
		this.frame.title = "Download";
		const src = `${ZIP_STREAM.scope}${id}/${encodeURIComponent(name)}`;
		// Fetch only once the worker holds the entry ("opened"): the message and the fetch reach it by
		// different routes, and a fetch that arrives first gets "This download has ended." (404). A worker
		// from before "opened" existed never answers, so fetch anyway after a short wait.
		let fetched = false;
		const fetchNow = () => {
			if (fetched || this.closed || this.error) return;
			fetched = true;
			this.frame.src = src;
		};
		setTimeout(fetchNow, OPENED_FALLBACK_MS);
		this.port.onmessage = (event: MessageEvent<SwToPage>) => {
			const msg = event.data;
			if ("want" in msg) {
				this.credit += msg.want;
				this.pump();
			} else if (msg.type === "opened") fetchNow();
			else if (msg.type === "started") onStarted(true);
			else if (msg.type === "cancelled") this.fail(new FtError("sink-error", "The download was cancelled."));
		};
		const open: SwOpen = { type: "open", id, name, length, port: channel.port2 };
		sw.postMessage(open, [channel.port2]);
		this.ping = setInterval(() => sw.postMessage({ type: "ping" }), ZIP_STREAM.pingMs);
		document.body.append(this.frame);
	}

	static async open(name: string, length: number | null, timeoutMs: number = ZIP_STREAM.startedTimeoutMs) {
		return new SwDownload(await serviceWorker(), name, length, timeoutMs);
	}

	/** Bytes handed to the service worker so far. */
	get bytesSent(): number {
		return this.sent;
	}

	/** Queues a chunk; ownership moves to the service worker when it is sent. */
	push(chunk: ArrayBuffer): void {
		if (this.error) throw this.error;
		if (this.closed) throw new FtError("sink-error", "The download has ended.");
		if (!chunk.byteLength) return;
		this.queue.push(chunk);
		this.queued += chunk.byteLength;
		this.pump();
	}

	/** Resolves once the queue is at most `limit` bytes; rejects if the download failed. */
	async drain(limit = PAGE_HIGH_WATER): Promise<void> {
		while (!this.error && this.queued > limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
		if (this.error) throw this.error;
	}

	/** Sends everything queued, then ends the stream. */
	async end(): Promise<void> {
		await this.drain(0);
		this.port.postMessage({ type: "end" } satisfies PortToSw);
		this.stop();
	}

	abort(reason: string): void {
		if (this.closed) return;
		try {
			this.port.postMessage({ type: "abort", reason } satisfies PortToSw);
		} catch {
			// Port already gone.
		}
		this.fail(new FtError("sink-error", reason));
		this.stop();
	}

	private pump(): void {
		while (this.credit > 0 && this.queue.length) {
			const chunk = this.queue.shift() as ArrayBuffer;
			this.queued -= chunk.byteLength;
			this.credit -= chunk.byteLength;
			this.sent += chunk.byteLength;
			this.port.postMessage(chunk satisfies PortToSw, [chunk]);
		}
		this.wake();
	}

	private fail(error: FtError): void {
		this.error ??= error;
		this.queue = [];
		this.queued = 0;
		this.wake();
	}

	private wake(): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const w of waiters) w();
	}

	private stop(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.ping);
		// The download manager owns the response by now; drop the frame a little later.
		setTimeout(() => {
			this.frame.remove();
			this.port.close();
		}, 30_000);
	}
}

/** Joins the pieces `ZipWriter` emitted during one call into one transferable buffer (copying them). */
function merge(parts: Uint8Array[]): ArrayBuffer {
	let length = 0;
	for (const p of parts) length += p.length;
	const out = new Uint8Array(length);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out.buffer;
}

export interface ZipStreamOptions {
	/** Fall back to the in-memory zip (≤ `tuning.memoryMax`) when the stream can't start. Default true. */
	fallback?: boolean;
	/** Started-check timeout; tests shorten it. */
	startedTimeoutMs?: number;
	/** Options for the memory fallback. */
	memory?: MemorySinkOptions;
}

class ZipStreamSink implements ReceiveSink {
	readonly ordered = true;
	private readonly ctx: SinkContext;
	private readonly options: ZipStreamOptions;
	private readonly name: string;
	private download: SwDownload | null = null;
	private feed: ZipFeed | null = null;
	private length = 0;
	private parts: Uint8Array[] = [];
	/** Set when the stream couldn't start and the memory sink took over. */
	private inner: ReceiveSink | null = null;

	constructor(ctx: SinkContext, options: ZipStreamOptions) {
		this.ctx = ctx;
		this.options = options;
		this.name = downloadName(ctx.peerName);
	}

	get mode(): SinkMode {
		return this.inner ? this.inner.mode : "zip";
	}

	async begin(files: ManifestFile[]): Promise<{ skip: number[] }> {
		const plan = planZip(files);
		let download: SwDownload | null = null;
		if (canStreamZip()) {
			try {
				download = await SwDownload.open(this.name, plan.length, this.options.startedTimeoutMs);
				if (!(await download.started)) {
					download.abort("The download didn't start.");
					download = null;
				}
			} catch {
				download = null;
			}
		}
		if (!download) {
			// Nothing has been written yet, so the memory fallback can still take over (§8.2).
			if (this.options.fallback === false) throw new FtError("zip-unsupported");
			this.inner = createMemorySink(this.ctx, this.options.memory);
			return this.inner.begin(files);
		}
		this.download = download;
		this.length = plan.length;
		this.feed = new ZipFeed(plan, (chunk) => this.parts.push(chunk));
		return { skip: [] };
	}

	async write(file: number, offset: number, data: Uint8Array): Promise<void> {
		if (this.inner) return this.inner.write(file, offset, data);
		this.active().write(file, offset, data);
		await this.flush();
	}

	async finishFile(file: number): Promise<void> {
		if (this.inner) return this.inner.finishFile(file);
		this.active().finishFile(file);
		await this.flush();
	}

	async finish(): Promise<{ location: string }> {
		if (this.inner) return this.inner.finish();
		const feed = this.active();
		const download = this.download as SwDownload;
		feed.finish();
		await this.flush();
		if (feed.bytesWritten !== this.length) {
			// zipSize and ZipWriter disagree: the browser would reject the download anyway.
			download.abort("Archive length mismatch.");
			throw new FtError("sink-error", "The zip came out a different size than announced.");
		}
		await download.end();
		return { location: this.name };
	}

	async abort(reason: string): Promise<void> {
		if (this.inner) return this.inner.abort(reason);
		this.download?.abort(reason);
		this.feed = null;
	}

	private active(): ZipFeed {
		if (!this.feed) throw new FtError("sink-error", "The zip download isn't open.");
		return this.feed;
	}

	private async flush(): Promise<void> {
		const download = this.download as SwDownload;
		if (this.parts.length) {
			const buffer = merge(this.parts);
			this.parts = [];
			download.push(buffer);
		}
		await download.drain();
	}
}

/**
 * The default sink. `begin()` opens the download and waits for the started-check; without a working
 * service worker it becomes the memory sink (`mode` then reads "memory"), which rejects batches over
 * `tuning.memoryMax` with `FtError("too-big")`.
 */
export function createZipStreamSink(ctx: SinkContext, options: ZipStreamOptions = {}): ReceiveSink {
	return new ZipStreamSink(ctx, options);
}
