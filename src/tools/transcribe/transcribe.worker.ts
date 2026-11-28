// The transcription worker: decodes the media's audio (Mediabunny + WebCodecs), cuts it into
// windows, and runs Whisper on each (transformers.js on onnxruntime-web, WebGPU or WASM).
// transformers.js is imported only here, so opening the tool's page stays light.

import {
	type AutomaticSpeechRecognitionPipeline,
	env,
	LogitsProcessor,
	LogitsProcessorList,
	pipeline,
	type Tensor,
} from "@huggingface/transformers";
import * as Comlink from "comlink";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { MediaError, type MediaInfo, openMedia } from "./engine/audio.ts";
import { Chunker, RATE, type Window } from "./engine/chunk.ts";
import { cleanSegments } from "./engine/clean.ts";
import type { Segment } from "./engine/format.ts";
import { type Device, type ModelId, modelById } from "./engine/models.ts";

// Runtime files are served by this site (hashed under /assets/), not jsDelivr.
// Threads need SharedArrayBuffer, which only a cross-origin-isolated page has (see vercel.json).
const THREADS = self.crossOriginIsolated ? Math.max(1, Math.min(8, navigator.hardwareConcurrency - 1)) : 1;
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } };
if (onnx.wasm) {
	onnx.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
	onnx.wasm.numThreads = THREADS;
}
env.allowLocalModels = false;
env.useBrowserCache = true;

export interface Probe {
	webgpu: boolean;
	/** The GPU can run fp16 shaders (needed for half-precision models). */
	f16: boolean;
	isolated: boolean;
	threads: number;
}

export interface LoadProgress {
	loaded: number;
	/** The model's size from the model table. */
	total: number;
	/** True once the files are in and the model is being compiled for the device. */
	preparing: boolean;
}

export interface Update {
	/** Media seconds transcribed so far. */
	done: number;
	/** Segments added since the last update. */
	segments: Segment[];
}

export interface Result {
	info: MediaInfo;
	segments: Segment[];
	/** Seconds of audio actually sent to Whisper (after removing long silences). */
	speechSeconds: number;
	elapsedMs: number;
}

/**
 * Whisper may open a window with a late timestamp ("<|20.00|>") and so skip everything before it.
 * Its generation config caps the first timestamp (max_initial_timestamp_index: 50, i.e. 1 s, the
 * default faster-whisper applies too), but transformers.js 4.3 returns before applying that cap at
 * the first position. This processor applies it. One instance per generate() call: it takes the
 * first input length it sees as the start of generation.
 */
class FirstTimestampCap extends LogitsProcessor {
	private begin = -1;
	private readonly firstBanned: number;

	constructor(timestampBegin: number, maxIndex: number) {
		super();
		this.firstBanned = timestampBegin + maxIndex + 1;
	}

	_call(inputIds: bigint[][], logits: Tensor): Tensor {
		const vocab = logits.dims.at(-1) ?? 0;
		const data = logits.data as Float32Array; // [batch, vocab], row-major
		for (let i = 0; i < inputIds.length; i++) {
			if (this.begin < 0) this.begin = inputIds[i].length;
			if (inputIds[i].length === this.begin)
				data.fill(Number.NEGATIVE_INFINITY, i * vocab + this.firstBanned, (i + 1) * vocab);
		}
		return logits;
	}
}

function firstTimestampCap(): LogitsProcessorList | undefined {
	const config = asr?.model.generation_config as
		| { no_timestamps_token_id?: number; max_initial_timestamp_index?: number }
		| undefined;
	if (config?.no_timestamps_token_id === undefined) return undefined;
	const list = new LogitsProcessorList();
	list.push(new FirstTimestampCap(config.no_timestamps_token_id + 1, config.max_initial_timestamp_index ?? 50));
	return list;
}

/** A window is decoded again from its last timestamp when at least this much audio is left over… */
const MIN_LEFT_SECONDS = 2;
/** …at most this many times in all. */
const MAX_PASSES = 4;

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let loadedKey = "";

interface GpuNavigator {
	gpu?: {
		requestAdapter(): Promise<{
			features: { has(name: string): boolean };
			info?: { isFallbackAdapter?: boolean };
			isFallbackAdapter?: boolean;
		} | null>;
	};
}

const api = {
	async probe(): Promise<Probe> {
		let webgpu = false;
		let f16 = false;
		try {
			const adapter = await (navigator as GpuNavigator).gpu?.requestAdapter();
			// A software (fallback) adapter is slower than WASM: treat it as no GPU.
			webgpu = !!adapter && !adapter.info?.isFallbackAdapter && !adapter.isFallbackAdapter;
			f16 = !!adapter?.features.has("shader-f16");
		} catch {
			// No WebGPU: WASM it is.
		}
		return { webgpu, f16, isolated: self.crossOriginIsolated, threads: THREADS };
	},

	/** Checks the file has a decodable audio track, before any model download. */
	async inspect(file: File): Promise<MediaInfo> {
		const media = await openMedia(file);
		media.dispose();
		return media.info;
	},

	async load(id: ModelId, device: Device, onProgress: (p: LoadProgress) => void): Promise<void> {
		const key = `${id}/${device}`;
		if (asr && loadedKey === key) return;
		await asr?.dispose();
		asr = null;
		const spec = modelById(id);
		// Bytes read per file (from the network, or from Cache Storage on later runs). The
		// library's own "progress_total" also counts files it only probes for size (the 2.5 GB
		// fp32 encoder, for one), so the total comes from the model table instead.
		const files = new Map<string, number>();
		const total = spec.sizeMB[device] * 1e6;
		let last = 0;
		asr = await pipeline("automatic-speech-recognition", spec.repo, {
			device,
			dtype: spec.dtype[device] as never,
			progress_callback: (info: { status: string; file?: string; loaded?: number }) => {
				if (info.status !== "progress" || !info.file) return;
				files.set(info.file, info.loaded ?? 0);
				const now = performance.now();
				if (now - last < 100) return;
				last = now;
				const loaded = [...files.values()].reduce((a, b) => a + b, 0);
				onProgress({ loaded: Math.min(loaded, total), total, preparing: loaded >= total * 0.98 });
			},
		});
		loadedKey = key;
		onProgress({ loaded: total, total, preparing: true });
	},

	async transcribe(file: File, options: { language: string | null }, onUpdate: (u: Update) => void): Promise<Result> {
		if (!asr) throw new Error("NO_MODEL");
		const started = performance.now();
		const media = await openMedia(file);
		const chunker = new Chunker();
		const segments: Segment[] = [];
		let speech = 0;

		const decode = async (audio: Float32Array) =>
			(await asr?.(audio, {
				return_timestamps: true,
				logits_processor: firstTimestampCap(),
				...(options.language ? { language: options.language, task: "transcribe" } : {}),
			})) as { text: string; chunks?: { timestamp: [number | null, number | null]; text: string }[] };

		const run = async (w: Window) => {
			speech += w.audio.length / RATE;
			const length = w.audio.length / RATE;
			const raw: Segment[] = [];
			// Whisper sometimes stops before the window's end (an end-of-text right after a
			// segment), leaving speech untranscribed. Like faster-whisper's seek, decode again from
			// the last timestamp while speech remains.
			let offset = 0;
			for (let pass = 0; pass < MAX_PASSES; pass++) {
				const out = await decode(w.audio.subarray(Math.round(offset * RATE)));
				const rest = length - offset;
				let reached = 0;
				for (const c of out.chunks ?? [{ timestamp: [0, null] as [number, null], text: out.text }]) {
					const a = Math.min(rest, c.timestamp[0] ?? 0);
					let b = Math.min(rest, Math.max(a, c.timestamp[1] ?? rest));
					// A segment far longer than its words could take ("by O. Henry." over 22 s) has
					// swallowed speech Whisper never wrote down: end it where its words plausibly end,
					// and decode the rest again.
					const words = c.text.trim().split(/\s+/).length;
					const stretched = b - a > 4 + words && !w.quiet(w.toMedia(offset + a), w.toMedia(offset + b));
					if (stretched) b = a + 1 + 0.6 * words;
					reached = Math.max(reached, b);
					raw.push({ start: w.toMedia(offset + a), end: w.toMedia(offset + b), text: c.text });
					if (stretched) break;
				}
				if (reached < 0.5 || rest - reached < MIN_LEFT_SECONDS) break; // done, or no headway
				offset += reached;
				if (w.quiet(w.toMedia(offset), w.end)) break; // only silence left
			}
			const kept = cleanSegments(raw, w.quiet, segments.at(-1));
			segments.push(...kept);
			onUpdate({ done: w.end, segments: kept });
		};

		try {
			for await (const piece of media.samples()) for (const w of chunker.push(piece)) await run(w);
			for (const w of chunker.flush()) await run(w);
		} catch (e) {
			if (e instanceof MediaError) throw e;
			throw new Error(e instanceof Error ? e.message : String(e));
		} finally {
			media.dispose();
		}
		onUpdate({ done: media.info.duration, segments: [] });
		return { info: media.info, segments, speechSeconds: speech, elapsedMs: performance.now() - started };
	},
};

export type TranscribeApi = typeof api;

Comlink.expose(api);
self.postMessage({ type: "ready" });
