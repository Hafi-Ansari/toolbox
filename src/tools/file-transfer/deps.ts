// The UI's injection seam (WP5 → WP6). The page never imports presence.ts, client.ts, rtc/, engine/,
// sinks/ or collect.ts directly: it gets everything through one `FtDeps` object, so the same UI runs
// against the real implementations (WP1–WP4) or against the mocks in mock.ts.
//
// WP6: set `REAL` below to `() => import("./real.ts").then((m) => m.realDeps())`, where real.ts builds an
// `FtDeps` from the real modules. The mocks stay reachable with `?mock` in the URL (or
// `window.__ftUseMock = true` in an init script), for UI tests and demos, and are only ever loaded then.
import type {
	Connect,
	CreateEngine,
	Handshake,
	IncomingOffer,
	PeerId,
	Presence,
	ReceiveSink,
	SendFile,
	Signaling,
	SinkContext,
} from "./types.ts";

export interface SinkFactories {
	/**
	 * The default, prompt-free streamed zip (§8.2). It falls back to the memory sink on its own when the
	 * download never starts. Rejects with `FtError("too-big")` when it can't take this offer.
	 */
	zip(ctx: SinkContext, offer: IncomingOffer): Promise<ReceiveSink>;
	/**
	 * Opt-in folder mode (§8.3). Called after the page's own explainer; opens the browser's folder picker.
	 * Resolves null when the person cancels the picker.
	 */
	folder(ctx: SinkContext): Promise<ReceiveSink | null>;
	/** In-memory zip for browsers without the zip stream, up to `tuning.memoryMax` (§8.4). */
	memory(ctx: SinkContext): Promise<ReceiveSink>;
	/** The test sink when `window.__sendTestSink` is set (§8.5), else null. Takes precedence over the others. */
	test(ctx: SinkContext): ReceiveSink | null;
}

export interface Collect {
	/** Files and folders from a drop. Must be called synchronously in the drop handler (the item list expires). */
	fromDrop(data: DataTransfer): Promise<SendFile[]>;
	/** Files from `<input type=file multiple>` (or `webkitdirectory` on touch devices). */
	fromInput(list: FileList): SendFile[];
}

/** What the browser can do (§14), by feature detection only. */
export interface BrowserCaps {
	/** Zip streaming through the service worker is worth trying. */
	zip: boolean;
	/** "Save into a folder…" can be offered (Chromium desktop). */
	folder: boolean;
	/** A touch-first device: no drag and drop, so a "Choose folder" button is offered instead. */
	touch: boolean;
}

export interface FtDeps {
	/** One per page; the page calls `stop()` when it unmounts. */
	createPresence(): Presence;
	/** Lane 0 signaling for a handshake that presence reported. */
	signaling(handshake: Handshake, self: PeerId): Signaling;
	connect: Connect;
	createEngine: CreateEngine;
	sinks: SinkFactories;
	collect: Collect;
	caps(): BrowserCaps;
	/** True for the mocks: the page says it's a demo. */
	demo: boolean;
}

/** WP6 sets this to load the real implementations. While it's null, the page runs on the mocks. */
const REAL: (() => Promise<FtDeps>) | null = null;

declare global {
	interface Window {
		/** Init-script switch for UI tests: run the page on mock.ts even when the real modules exist. */
		__ftUseMock?: boolean;
	}
}

export function wantsMock(): boolean {
	return REAL === null || new URLSearchParams(location.search).has("mock") || window.__ftUseMock === true;
}

export async function loadDeps(): Promise<FtDeps> {
	if (REAL && !wantsMock()) return REAL();
	const { mockDeps } = await import("./mock.ts");
	return mockDeps();
}

/** Feature detection shared by the real and the mock deps (§14). Never user-agent sniffing. */
export function detectCaps(): BrowserCaps {
	const fine = typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;
	const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
	return {
		zip: "serviceWorker" in navigator && "ReadableStream" in window,
		folder: typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function" && fine,
		touch: coarse && !fine,
	};
}
