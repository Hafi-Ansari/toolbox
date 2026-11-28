// WP6: the page's real dependencies (deps.ts `FtDeps`), built from the work packages:
//   presence and signaling  client.ts + presence.ts (WP1), against api/file-transfer.ts
//   lanes                   rtc/lanes.ts `connect` (WP4)
//   engine                  engine/engine.ts `createEngine` (WP2)
//   sinks and collect       sinks/*, collect.ts (WP3)
// Loaded lazily by deps.ts, so the mocks and the real modules never share a bundle chunk.
import { createApiClient, loadIdentity, signalingFor } from "./client.ts";
import { fromDrop, fromInput } from "./collect.ts";
import { type BrowserCaps, detectCaps, type FtDeps } from "./deps.ts";
import { createEngine } from "./engine/engine.ts";
import { createPresence } from "./presence.ts";
import { connect } from "./rtc/lanes.ts";
import { createFolderSink } from "./sinks/folder.ts";
import { createMemorySink, fitsInMemory } from "./sinks/memory.ts";
import { createTestSink, testSinkRequested } from "./sinks/test.ts";
import { canStreamZip, createZipStreamSink, serviceWorker } from "./sinks/zipStream.ts";
import { tuning } from "./tuning.ts";
import { type ApiClient, FtError, type ManifestFile, type ReceiveSink } from "./types.ts";

type PickerWindow = Window & {
	showDirectoryPicker?: (options: { mode: "readwrite"; id?: string }) => Promise<FileSystemDirectoryHandle>;
};

/**
 * A sink whose `begin()` already ran (in the Accept click), handing its answer to the engine's own
 * `begin()` call. Starting the download right in the click ties every batch's download to its own user
 * interaction, which is what lets Chromium allow it without "This site is trying to download multiple
 * files" (§9; its download limiter lets one download through after each click). And a batch the memory
 * fallback can't take is refused before anything is accepted.
 */
function begun(sink: ReceiveSink, result: { skip: number[] }): ReceiveSink {
	let used = false;
	return {
		get mode() {
			return sink.mode;
		},
		get ordered() {
			return sink.ordered;
		},
		begin: async (files: ManifestFile[]) => {
			if (used) return sink.begin(files);
			used = true;
			return result;
		},
		write: (file, offset, data) => sink.write(file, offset, data),
		finishFile: (file) => sink.finishFile(file),
		finish: () => sink.finish(),
		abort: (reason) => sink.abort(reason),
	};
}

export function realDeps(): FtDeps {
	const { identity } = loadIdentity();
	const api: ApiClient = createApiClient(identity);
	const caps = (): BrowserCaps => ({ ...detectCaps(), zip: canStreamZip() });

	return {
		demo: false,
		createPresence: () => createPresence({ api, identity, profile: loadIdentity().profile }),
		signaling: (handshake, self) => signalingFor(api, self, handshake),
		connect: async (opts) => {
			const session = await connect(opts);
			// Have the zip service worker installed before the first Accept, so the download starts at once.
			if (canStreamZip()) serviceWorker().catch(() => {});
			return session;
		},
		createEngine: (session) => createEngine(session),
		sinks: {
			async zip(ctx, offer) {
				if (!canStreamZip() && !fitsInMemory(offer.files)) throw new FtError("too-big");
				const sink = createZipStreamSink(ctx);
				// Opens the download now (or falls back to memory, which may refuse with too-big).
				const result = await sink.begin(offer.files);
				return begun(sink, result);
			},
			async folder() {
				// The page has explained the two prompts already (OfferCard), in the click that brings us here.
				let root: FileSystemDirectoryHandle | undefined;
				try {
					root = await (window as PickerWindow).showDirectoryPicker?.({
						mode: "readwrite",
						id: "file-transfer-receive",
					});
				} catch (e) {
					if (e instanceof DOMException && e.name === "AbortError") return null;
					throw new FtError("sink-error", e instanceof Error ? e.message : String(e));
				}
				return root ? createFolderSink(root) : null;
			},
			memory: async (ctx) => createMemorySink(ctx, { max: tuning.memoryMax }),
			test: () => (testSinkRequested() ? createTestSink() : null),
		},
		collect: {
			fromDrop: async (data) => (await fromDrop(data)).files,
			fromInput: (list) => fromInput(list).files,
		},
		caps,
	};
}
