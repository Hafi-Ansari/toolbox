// Video → Transcript: Whisper in the browser. Drop a video or audio file, get "[HH:MM:SS] text"
// lines beside a player of the same file. README: "How Transcribe works".
import * as Comlink from "comlink";
import { useEffect, useMemo, useRef, useState } from "react";
import { confirm } from "../../lib/confirm.tsx";
import { formatBytes, formatDuration, swapExtension } from "../../lib/format.ts";
import { openSaveTarget } from "../../lib/saveFile.ts";
import { Button, Card, Chip, FileDrop, Label, Note, Pills, Progress } from "../../lib/ui.tsx";
import { startWorker, type WorkerHandle } from "../../lib/worker.ts";
import type { MediaInfo } from "./engine/audio.ts";
import { type Segment, timestamp, toSrt, toTxt } from "./engine/format.ts";
import { LANGUAGES } from "./engine/languages.ts";
import { autoModel, type Device, MODELS, type ModelId, modelById } from "./engine/models.ts";
import s from "./Transcribe.module.css";
import type { LoadProgress, Probe, TranscribeApi, Update } from "./transcribe.worker.ts";

type State =
	| { kind: "idle" }
	| { kind: "inspecting"; file: File }
	| { kind: "ready"; file: File; info: MediaInfo }
	| { kind: "loading"; file: File; info: MediaInfo; progress: LoadProgress }
	| { kind: "working"; file: File; info: MediaInfo; done: number; started: number; segments: Segment[] }
	| { kind: "done"; file: File; info: MediaInfo; segments: Segment[]; elapsedMs: number; speechSeconds: number }
	| { kind: "error"; file?: File; info?: MediaInfo; message: string; segments?: Segment[] };

interface Options {
	model: ModelId | "auto";
	language: string;
	/** "wasm" runs on the processor even where WebGPU works (a fallback if the GPU path misbehaves). */
	device: "auto" | "wasm";
}

const STORAGE_KEY = "toolbox.transcribe.options";
const ACCEPT = "video/*,audio/*,.mp4,.m4v,.mov,.mkv,.webm,.mp3,.m4a,.aac,.wav,.ogg,.oga,.opus,.flac";
const CACHE_NAME = "transformers-cache"; // transformers.js's Cache Storage bucket

function loadOptions(): Options {
	try {
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Options> | null;
		return {
			model: MODELS.some((m) => m.id === saved?.model) ? (saved?.model as ModelId) : "auto",
			language: LANGUAGES.some(([code]) => code === saved?.language) ? (saved?.language as string) : "en",
			device: saved?.device === "wasm" ? "wasm" : "auto",
		};
	} catch {
		return { model: "auto", language: "en", device: "auto" };
	}
}

const createWorker = () =>
	startWorker<TranscribeApi>(
		() => new Worker(new URL("./transcribe.worker.ts", import.meta.url), { type: "module", name: "transcribe" }),
	);

function errorText(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	if (msg.startsWith("UNREADABLE")) return "This file couldn't be read as video or audio.";
	if (msg.startsWith("NO_AUDIO")) return "This file has no audio track.";
	if (msg.startsWith("CODEC"))
		return typeof AudioDecoder === "undefined"
			? "This browser can't decode audio inside video files. Use a current Chrome, Edge, Firefox, or Safari 26 or later."
			: `This browser can't decode this file's audio (${msg.slice(6) || "unknown codec"}). Try Chrome or Edge, or convert the audio to AAC, MP3 or Opus first.`;
	if (/fetch|network|Failed to load/i.test(msg))
		return `The model couldn't be downloaded (${msg}). Check your connection and try again.`;
	return msg;
}

/** Keeps the screen awake during a long run (no permission prompt). */
function useWakeLock(active: boolean) {
	useEffect(() => {
		if (!active) return;
		type Sentinel = { release(): Promise<void> };
		const nav = navigator as { wakeLock?: { request(type: "screen"): Promise<Sentinel> } };
		let lock: Sentinel | null = null;
		let stopped = false;
		const take = () => {
			if (document.visibilityState !== "visible") return;
			nav.wakeLock?.request("screen").then(
				(l) => {
					if (stopped) void l.release();
					else lock = l;
				},
				() => {},
			);
		};
		take();
		document.addEventListener("visibilitychange", take);
		return () => {
			stopped = true;
			document.removeEventListener("visibilitychange", take);
			void lock?.release().catch(() => {});
		};
	}, [active]);
}

export default function Transcribe() {
	const [state, setState] = useState<State>({ kind: "idle" });
	const [options, setOptions] = useState<Options>(loadOptions);
	const [probe, setProbe] = useState<Probe | null>(null);
	const [engine, setEngine] = useState<"loading" | "ready" | "failed">("loading");
	const worker = useRef<WorkerHandle<TranscribeApi> | null>(null);
	const run = useRef(0);

	const spawn = () => {
		worker.current?.terminate();
		const handle = createWorker();
		worker.current = handle;
		setEngine("loading");
		handle.api.then(
			async (api) => {
				const p = await api.probe();
				if (worker.current !== handle) return;
				setProbe(p);
				setEngine("ready");
			},
			() => worker.current === handle && setEngine("failed"),
		);
		return handle;
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: one worker per page visit
	useEffect(() => {
		spawn();
		return () => worker.current?.terminate();
	}, []);

	useEffect(() => {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
		} catch {
			// Private windows may refuse storage; defaults come back next time.
		}
	}, [options]);

	const device: Device = probe?.webgpu && options.device === "auto" ? "webgpu" : "wasm";
	// A model the device can't run in reasonable time (Turbo on the processor) falls back to Auto.
	const picked = options.model !== "auto" && modelById(options.model).devices.includes(device) ? options.model : null;
	const modelId = picked ?? autoModel(device);
	const model = modelById(modelId);
	const busy = state.kind === "inspecting" || state.kind === "loading" || state.kind === "working";
	useWakeLock(state.kind === "loading" || state.kind === "working");

	async function choose(file: File) {
		const id = ++run.current;
		setState({ kind: "inspecting", file });
		try {
			const api = await (worker.current ?? spawn()).api;
			const info = await api.inspect(file);
			if (id === run.current) setState({ kind: "ready", file, info });
		} catch (e) {
			if (id === run.current) setState({ kind: "error", file, message: errorText(e) });
		}
	}

	async function start() {
		if (state.kind !== "ready" && !(state.kind === "error" && state.info && state.file)) return;
		const file = state.file as File;
		const info = state.info as MediaInfo;
		const id = ++run.current;
		const live = (patch: (s: State) => State) => id === run.current && setState(patch);
		setState({ kind: "loading", file, info, progress: { loaded: 0, total: 0, preparing: false } });
		const segments: Segment[] = [];
		try {
			const api = await (worker.current ?? spawn()).api;
			await api.load(
				modelId,
				device,
				Comlink.proxy((progress: LoadProgress) => live((s) => (s.kind === "loading" ? { ...s, progress } : s))),
			);
			const started = performance.now();
			live(() => ({ kind: "working", file, info, done: 0, started, segments: [] }));
			const result = await api.transcribe(
				file,
				{ language: model.englishOnly ? null : options.language },
				Comlink.proxy((u: Update) => {
					segments.push(...u.segments);
					live((s) => (s.kind === "working" ? { ...s, done: u.done, segments: [...segments] } : s));
				}),
			);
			live(() => ({
				kind: "done",
				file,
				info: result.info,
				segments: result.segments,
				elapsedMs: result.elapsedMs,
				speechSeconds: result.speechSeconds,
			}));
		} catch (e) {
			live(() => ({ kind: "error", file, info, message: errorText(e), segments }));
		}
	}

	function cancel() {
		run.current++;
		spawn(); // terminating the worker stops everything at once; the next run reloads the model (from cache)
		setState((s) => (s.kind === "working" || s.kind === "loading" ? { kind: "ready", file: s.file, info: s.info } : s));
	}

	function reset() {
		run.current++;
		if (busy) spawn();
		setState({ kind: "idle" });
	}

	async function removeModels() {
		const ok = await confirm({
			title: "Remove downloaded models?",
			message:
				"The Whisper models this page downloaded are kept in this browser so later runs start at once. Removing them frees the space; the next run downloads its model again.",
			confirmLabel: "Remove",
		});
		if (!ok) return;
		await caches.delete(CACHE_NAME).catch(() => false);
		setStorage(await storageUsed());
	}

	const [storage, setStorage] = useState<number | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh after each run finishes
	useEffect(() => {
		void storageUsed().then(setStorage);
	}, [state.kind === "done"]);

	const file = "file" in state ? state.file : undefined;
	const info = "info" in state ? state.info : undefined;
	const segments = "segments" in state ? (state.segments ?? []) : [];

	return (
		<div className={s.page} data-wide-page={file && info ? "medium" : undefined}>
			<header className={s.intro}>
				<h1>
					Video <span className={s.arrow}>→</span> Transcript
				</h1>
				<p className={s.lead}>
					Turn a lecture, meeting or any video or audio file into a timestamped text transcript with Whisper, the speech
					recognition model, running on your own device. The file is never uploaded.
				</p>
			</header>

			<Card className={s.panel}>
				{state.kind === "idle" ? (
					<FileDrop
						accept={ACCEPT}
						title="Drop a video or audio file"
						hint={
							<>
								or click to choose · MP4, MOV, MKV, WebM, MP3, M4A, WAV, FLAC…
								{engine === "loading" && <span className={s.engine}> · loading engine…</span>}
							</>
						}
						onFile={choose}
					/>
				) : (
					<div className={s.workspace}>
						<div className={s.fileRow}>
							{file && (
								<Chip
									badge={info?.hasVideo ? "VIDEO" : "AUDIO"}
									name={file.name}
									meta={[formatBytes(file.size), info?.duration ? clock(info.duration) : ""]
										.filter(Boolean)
										.join(" · ")}
									to={busy ? "TXT" : undefined}
								/>
							)}
							{state.kind === "loading" || state.kind === "working" ? (
								<Button variant="ghost" icon="x" onClick={cancel}>
									Cancel
								</Button>
							) : (
								<Button variant="ghost" icon="x" onClick={reset}>
									Change file
								</Button>
							)}
						</div>

						{engine === "failed" && (
							<Note tone="danger">The engine couldn't load. Check your connection and reload the page.</Note>
						)}

						{(state.kind === "ready" || (state.kind === "error" && state.info)) && (
							<Settings
								options={options}
								onChange={(patch) => setOptions((o) => ({ ...o, ...patch }))}
								device={device}
								probe={probe}
								modelId={modelId}
								duration={info?.duration ?? 0}
								onStart={start}
								disabled={engine !== "ready"}
							/>
						)}

						{state.kind === "inspecting" && <Progress value={0} max={0} label="Opening…" />}
						{state.kind === "loading" && <ModelProgress progress={state.progress} sizeMB={model.sizeMB[device]} />}
						{state.kind === "working" && <WorkProgress state={state} />}
						{state.kind === "error" && <Note tone="danger">{state.message}</Note>}
						{state.kind === "done" && (
							<Note tone="success">
								{segments.length} lines from {clock(state.info.duration || state.speechSeconds)} of{" "}
								{state.info.hasVideo ? "video" : "audio"} in {formatDuration(state.elapsedMs)}.
							</Note>
						)}

						{file && info && (state.kind === "working" || state.kind === "done" || segments.length > 0) && (
							<Review
								file={file}
								info={info}
								segments={segments}
								finished={state.kind === "done"}
								following={state.kind === "working"}
							/>
						)}
					</div>
				)}
			</Card>

			{storage !== null && storage > 50e6 && !busy && (
				<p className={s.storage}>
					Downloaded models use about {formatBytes(storage)} of this browser's storage.{" "}
					<button type="button" className={s.linkButton} onClick={removeModels}>
						Remove them
					</button>
				</p>
			)}
		</div>
	);
}

async function storageUsed(): Promise<number | null> {
	try {
		const has = await caches.has(CACHE_NAME);
		if (!has) return 0;
		return (await navigator.storage.estimate()).usage ?? null;
	} catch {
		return null;
	}
}

/** "1:02:03" or "13:22" */
function clock(seconds: number): string {
	const t = Math.max(0, Math.floor(seconds));
	const h = Math.floor(t / 3600);
	const m = Math.floor((t % 3600) / 60);
	const sec = t % 60;
	return h
		? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
		: `${m}:${String(sec).padStart(2, "0")}`;
}

function Settings({
	options,
	onChange,
	device,
	probe,
	modelId,
	duration,
	onStart,
	disabled,
}: {
	options: Options;
	onChange: (patch: Partial<Options>) => void;
	device: Device;
	probe: Probe | null;
	modelId: ModelId;
	duration: number;
	onStart: () => void;
	disabled: boolean;
}) {
	const model = modelById(modelId);
	const choices = MODELS.filter((m) => m.devices.includes(device));
	return (
		<div className={s.settings}>
			{probe?.webgpu && (
				<Pills
					label="Run on"
					value={options.device}
					options={[
						{ value: "auto", label: "Graphics card" },
						{ value: "wasm", label: "Processor" },
					]}
					onChange={(d) => onChange({ device: d })}
				/>
			)}
			<Pills
				label="Model"
				value={choices.some((m) => m.id === options.model) ? options.model : "auto"}
				options={[
					{ value: "auto", label: `Auto (${modelById(autoModel(device)).label})` },
					...choices.map((m) => ({ value: m.id, label: m.label })),
				]}
				onChange={(model) => onChange({ model })}
			/>
			<label className={s.field}>
				<Label>Spoken language</Label>
				<select
					value={model.englishOnly ? "en" : options.language}
					disabled={model.englishOnly}
					onChange={(e) => onChange({ language: e.target.value })}
				>
					{LANGUAGES.map(([code, name]) => (
						<option key={code} value={code}>
							{name}
						</option>
					))}
				</select>
			</label>
			<p className={s.hint}>
				{model.note} Runs on{" "}
				{device === "webgpu" ? "your graphics card (WebGPU)" : `the processor (${probe?.threads ?? 1} threads)`}. The
				first run downloads about {formatBytes(model.sizeMB[device] * 1e6)} from Hugging Face, once; this browser keeps
				it. {duration > 0 && estimate(modelId, device, duration)}
			</p>
			<div>
				<Button icon="text" onClick={onStart} disabled={disabled}>
					Transcribe
				</Button>
			</div>
		</div>
	);
}

/**
 * Media seconds transcribed per second, measured on a desktop with an RTX 4060 Ti and a 12-core
 * Ryzen (README, "How Video → Transcript works"). Laptops and older machines are slower.
 */
const SPEED: Partial<Record<`${ModelId}/${Device}`, number>> = {
	"turbo/webgpu": 12,
	"small/wasm": 4.6,
	"base/wasm": 9,
};

function estimate(id: ModelId, device: Device, duration: number): string {
	const speed = SPEED[`${id}/${device}`];
	if (!speed) return "";
	return `On a fast desktop this takes about ${formatDuration((duration / speed) * 1000)}; expect longer on a laptop.`;
}

function ModelProgress({ progress, sizeMB }: { progress: LoadProgress; sizeMB: number }) {
	if (progress.preparing) return <Progress value={0} max={0} label="Preparing the model…" />;
	const total = progress.total || sizeMB * 1e6;
	return (
		<Progress
			value={progress.loaded}
			max={total}
			label={`Loading the model · ${formatBytes(progress.loaded)} of ${formatBytes(total)}`}
			detail="downloaded once, then kept"
		/>
	);
}

function WorkProgress({ state }: { state: Extract<State, { kind: "working" }> }) {
	const elapsed = performance.now() - state.started;
	const total = state.info.duration;
	const remaining = state.done > 5 && total > state.done ? (elapsed / state.done) * (total - state.done) : null;
	return (
		<Progress
			value={state.done}
			max={total}
			label={`Transcribing · ${clock(state.done)} of ${total ? clock(total) : "?"}`}
			detail={remaining === null ? formatDuration(elapsed) : `about ${formatDuration(remaining)} left`}
		/>
	);
}

function Review({
	file,
	info,
	segments,
	finished,
	following,
}: {
	file: File;
	info: MediaInfo;
	segments: Segment[];
	finished: boolean;
	following: boolean;
}) {
	const url = useMemo(() => URL.createObjectURL(file), [file]);
	useEffect(() => () => URL.revokeObjectURL(url), [url]);
	const player = useRef<HTMLVideoElement & HTMLAudioElement>(null);
	const list = useRef<HTMLOListElement>(null);
	const [now, setNow] = useState(-1);
	const [query, setQuery] = useState("");

	const current = useMemo(() => {
		let i = -1;
		for (let k = 0; k < segments.length && segments[k].start <= now; k++) i = k;
		return i;
	}, [segments, now]);

	// While transcribing, keep the newest line in view (unless the reader has scrolled up).
	// biome-ignore lint/correctness/useExhaustiveDependencies: on new lines
	useEffect(() => {
		const el = list.current;
		if (!following || !el || query) return;
		if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
	}, [segments.length]);

	const needle = query.trim().toLowerCase();
	const shown = useMemo(() => {
		if (!needle) return segments.map((_, i) => i);
		const keep = new Set<number>();
		segments.forEach((seg, i) => {
			if (seg.text.toLowerCase().includes(needle))
				for (const k of [i - 1, i, i + 1]) if (k >= 0 && k < segments.length) keep.add(k);
		});
		return [...keep].sort((a, b) => a - b);
	}, [segments, needle]);
	const matches = needle ? segments.filter((seg) => seg.text.toLowerCase().includes(needle)).length : 0;

	const seek = (t: number) => {
		const el = player.current;
		if (!el) return;
		el.currentTime = t;
		void el.play().catch(() => {});
	};

	async function save(kind: "txt" | "srt") {
		const text = kind === "txt" ? toTxt(segments) : toSrt(segments);
		const bytes = new TextEncoder().encode(text);
		const out = await openSaveTarget(
			swapExtension(file.name, kind),
			kind === "txt" ? "text/plain" : "application/x-subrip",
			kind === "txt" ? "Plain text" : "Subtitles",
			bytes.length,
		).catch(() => null);
		if (!out) return;
		out.write(bytes);
		await out.close();
	}

	const Media = info.hasVideo ? "video" : "audio";
	return (
		<div className={s.review}>
			<div className={s.playerCol}>
				<Media
					ref={player}
					className={info.hasVideo ? s.video : s.audio}
					src={url}
					controls
					preload="metadata"
					onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
					onSeeked={(e) => setNow(e.currentTarget.currentTime)}
				/>
				{finished && (
					<div className={s.downloads}>
						<Button icon="download" onClick={() => save("txt")} disabled={!segments.length}>
							Download TXT
						</Button>
						<Button variant="ghost" icon="download" onClick={() => save("srt")} disabled={!segments.length}>
							Download SRT
						</Button>
					</div>
				)}
			</div>
			<div className={s.transcriptCol}>
				<div className={s.findRow}>
					<input
						type="search"
						className={s.find}
						placeholder="Find in transcript"
						aria-label="Find in transcript"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
					/>
					{needle && (
						<span className={s.matches} role="status">
							{matches} {matches === 1 ? "match" : "matches"}
						</span>
					)}
				</div>
				<ol className={s.lines} ref={list} aria-label="Transcript">
					{shown.map((i, n) => {
						const seg = segments[i];
						const gap = n > 0 && shown[n - 1] !== i - 1;
						return (
							<li key={i} className={gap ? s.gap : undefined}>
								<button
									type="button"
									className={i === current ? `${s.line} ${s.current}` : s.line}
									onClick={() => seek(seg.start)}
									aria-current={i === current || undefined}
								>
									<span className={s.time}>[{timestamp(seg.start)}]</span>{" "}
									<span>{needle ? highlight(seg.text, needle) : seg.text}</span>
								</button>
							</li>
						);
					})}
					{following && <li className={s.pending}>Listening…</li>}
				</ol>
			</div>
		</div>
	);
}

function highlight(text: string, needle: string) {
	const parts: (string | React.ReactElement)[] = [];
	const lower = text.toLowerCase();
	let at = 0;
	for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, at)) {
		parts.push(text.slice(at, i), <mark key={i}>{text.slice(i, i + needle.length)}</mark>);
		at = i + needle.length;
	}
	parts.push(text.slice(at));
	return parts;
}
