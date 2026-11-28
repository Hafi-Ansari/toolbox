// Reads the audio track of a video or audio file as a stream of 16 kHz mono samples: Mediabunny
// demuxes (reading the File in ranges, never whole) and decodes through WebCodecs, then the
// resampler brings it to Whisper's rate. Replaces the manual `ffmpeg -ac 1 -ar 16000` step.

import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, type InputAudioTrack } from "mediabunny";
import { RATE } from "./chunk.ts";
import { downmix, Resampler } from "./resample.ts";

export class MediaError extends Error {
	readonly code: "UNREADABLE" | "NO_AUDIO" | "CODEC";
	constructor(code: MediaError["code"], detail?: string) {
		super(detail ? `${code}:${detail}` : code); // the message is what survives the trip out of the worker
		this.code = code;
	}
}

export interface MediaInfo {
	/** Seconds; 0 when the container doesn't say. */
	duration: number;
	hasVideo: boolean;
	codec: string;
	channels: number;
	sampleRate: number;
}

export interface OpenedMedia {
	info: MediaInfo;
	/** Yields 16 kHz mono pieces from time 0, in order. */
	samples(): AsyncGenerator<Float32Array>;
	dispose(): void;
}

/** Gaps in the track longer than this are filled with silence so times stay on the media's clock. */
const MAX_FILL_SECONDS = 600;

export async function openMedia(file: File): Promise<OpenedMedia> {
	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	let track: InputAudioTrack | null;
	let hasVideo: boolean;
	try {
		track = await input.getPrimaryAudioTrack();
		hasVideo = (await input.getPrimaryVideoTrack()) !== null;
	} catch {
		input.dispose();
		throw new MediaError("UNREADABLE");
	}
	if (!track) {
		input.dispose();
		throw new MediaError("NO_AUDIO");
	}
	const codec = track.codec ?? "unknown";
	if (!(await track.canDecode())) {
		input.dispose();
		throw new MediaError("CODEC", codec);
	}
	const duration = await input.computeDuration().catch(() => 0);
	const audioTrack = track;

	async function* samples(): AsyncGenerator<Float32Array> {
		const sink = new AudioSampleSink(audioTrack);
		let resampler: Resampler | null = null;
		let clock = 0; // seconds of audio emitted so far (before resampling)
		for await (const sample of sink.samples()) {
			try {
				const frames = sample.numberOfFrames;
				if (frames === 0) continue;
				resampler ??= new Resampler(sample.sampleRate, RATE);
				// Decoders prime with a few samples before 0; drop those.
				let skip = sample.timestamp < 0 ? Math.min(frames, Math.round(-sample.timestamp * sample.sampleRate)) : 0;
				const gap = sample.timestamp - clock;
				if (gap > 0.01 && gap < MAX_FILL_SECONDS) {
					const fill = resampler.push(new Float32Array(Math.round(gap * sample.sampleRate)));
					clock += gap;
					if (fill.length) yield fill;
				} else if (gap < -0.01 && sample.timestamp >= 0) {
					skip = Math.max(skip, Math.min(frames, Math.round(-gap * sample.sampleRate))); // overlap
				}
				if (skip >= frames) continue;
				const planes: Float32Array[] = [];
				for (let ch = 0; ch < sample.numberOfChannels; ch++) {
					const plane = new Float32Array(frames);
					sample.copyTo(plane, { planeIndex: ch, format: "f32-planar" });
					planes.push(skip ? plane.subarray(skip) : plane);
				}
				clock += (frames - skip) / sample.sampleRate;
				const out = resampler.push(downmix(planes));
				if (out.length) yield out;
			} finally {
				sample.close();
			}
		}
		if (resampler) {
			const tail = resampler.flush();
			if (tail.length) yield tail;
		}
	}

	return {
		info: {
			duration,
			hasVideo,
			codec,
			channels: audioTrack.numberOfChannels,
			sampleRate: audioTrack.sampleRate,
		},
		samples,
		dispose: () => input.dispose(),
	};
}
