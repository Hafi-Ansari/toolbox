import * as Comlink from "comlink";
import { useCallback, useEffect, useRef, useState } from "react";
import { detectFile } from "../../lib/detect.ts";
import { formatBytes, formatDuration, swapExtension } from "../../lib/format.ts";
import { Icon } from "../../lib/Icon.tsx";
import { canStreamToDisk, openSaveTarget, type SaveTarget, willAskWhereToSave } from "../../lib/saveFile.ts";
import { Button, Card, Chip, FileDrop, Kbd, Note, Pills, Progress } from "../../lib/ui.tsx";
import { startWorker, type WorkerHandle } from "../../lib/worker.ts";
import type { ConverterApi } from "./convert.worker.ts";
import s from "./EpubPdf.module.css";
import type { InputInfo } from "./engine/convert.ts";

/* ---------- Options */

const PAGE_SIZES = {
	a5: { label: "A5", width: 420, height: 595 },
	"6x9": { label: "6×9 in", width: 432, height: 648 },
	a4: { label: "A4", width: 595, height: 842 },
	letter: { label: "Letter", width: 612, height: 792 },
} as const;
type PageSize = keyof typeof PAGE_SIZES;

const MARGINS = { narrow: 36, normal: 54, wide: 72 } as const;
type Margin = keyof typeof MARGINS;

type FontSize = "10" | "11" | "12" | "14";
type Mode = "reflow" | "fixed";
type Quality = "standard" | "high";

interface Options {
	pageSize: PageSize;
	fontSize: FontSize;
	margin: Margin;
	mode: Mode;
	quality: Quality;
}

const DEFAULTS: Options = { pageSize: "a5", fontSize: "11", margin: "normal", mode: "reflow", quality: "standard" };
const STORAGE_KEY = "toolbox.epub-pdf.options";

function loadOptions(): Options {
	try {
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
		return { ...DEFAULTS, ...saved };
	} catch {
		return DEFAULTS;
	}
}

function saveOptions(o: Options) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(o));
	} catch {
		// Storage can be unavailable (private mode); options just won't persist.
	}
}

/* ---------- State */

type State =
	| { kind: "idle" }
	| { kind: "inspecting"; file: File }
	| { kind: "ready"; file: File; info: InputInfo }
	| { kind: "converting"; file: File; info: InputInfo; done: number; total: number; label: string; started: number }
	| { kind: "done"; file: File; info: InputInfo; outName: string; outSize: number; ms: number; via: SaveTarget["kind"] }
	| { kind: "error"; file?: File; info?: InputInfo; message: string };

const createWorker = () =>
	startWorker<ConverterApi>(() => new Worker(new URL("./convert.worker.ts", import.meta.url), { type: "module" }));

function message(e: unknown): string {
	const text = e instanceof Error ? e.message : String(e);
	if (/password/i.test(text)) return "This file is password-protected. Remove the password and try again.";
	if (/memory|allocation|OOM/i.test(text)) return "Ran out of memory. Try closing other tabs, or a smaller file.";
	return `Conversion failed: ${text}`;
}

export default function EpubPdfTool() {
	const [state, setState] = useState<State>({ kind: "idle" });
	const [options, setOptions] = useState<Options>(loadOptions);
	const [engine, setEngine] = useState<"loading" | "ready" | "failed">("loading");
	const worker = useRef<WorkerHandle<ConverterApi> | null>(null);
	const run = useRef(0);
	const target = useRef<SaveTarget | null>(null);

	const spawn = useCallback(() => {
		worker.current?.terminate();
		const w = createWorker();
		worker.current = w;
		setEngine("loading");
		w.api.then(
			() => worker.current === w && setEngine("ready"),
			() => worker.current === w && setEngine("failed"),
		);
		return w;
	}, []);

	// Start loading the engine as soon as the page opens, so it is ready by the time a file is chosen.
	useEffect(() => {
		spawn();
		return () => worker.current?.terminate();
	}, [spawn]);

	const update = (patch: Partial<Options>) =>
		setOptions((o) => {
			const next = { ...o, ...patch };
			saveOptions(next);
			return next;
		});

	async function choose(file: File) {
		const id = ++run.current;
		setState({ kind: "inspecting", file });
		try {
			const format = await detectFile(file);
			if (format !== "pdf" && format !== "epub") {
				throw new Error(
					format === "zip" ? "This is a zip archive, not an EPUB." : "This doesn't look like a PDF or EPUB file.",
				);
			}
			const api = await (worker.current ?? spawn()).api;
			const info = await api.inspect(file, format);
			if (id !== run.current) return;
			if (info.format === "pdf" && info.looksScanned) update({ mode: "fixed" });
			setState({ kind: "ready", file, info });
		} catch (e) {
			if (id !== run.current) return;
			const text = e instanceof Error ? e.message : String(e);
			setState({ kind: "error", file, message: /PDF or EPUB|zip archive/.test(text) ? text : message(e) });
		}
	}

	async function convert(file: File, info: InputInfo) {
		const id = ++run.current;
		const toPdf = info.format === "epub";
		const outName = swapExtension(file.name, toPdf ? "pdf" : "epub");
		let out: SaveTarget | null;
		try {
			out = await openSaveTarget(
				outName,
				toPdf ? "application/pdf" : "application/epub+zip",
				toPdf ? "PDF document" : "EPUB book",
				file.size,
			);
		} catch (e) {
			setState({ kind: "error", file, info, message: message(e) });
			return;
		}
		if (!out) return; // save dialog cancelled
		target.current = out;
		const started = performance.now();
		setState({ kind: "converting", file, info, done: 0, total: info.pages, label: "Starting", started });

		const onProgress = Comlink.proxy((done: number, total: number, label: string) => {
			if (id !== run.current) return;
			setState((st) => (st.kind === "converting" ? { ...st, done, total, label } : st));
		});

		try {
			const api = await (worker.current ?? spawn()).api;
			let outSize = 0;
			if (toPdf) {
				const size = PAGE_SIZES[options.pageSize];
				const { bytes } = await api.epubToPdf(
					file,
					{
						width: size.width,
						height: size.height,
						fontSize: Number(options.fontSize),
						margin: MARGINS[options.margin],
					},
					onProgress,
				);
				out.write(bytes);
				outSize = bytes.length;
			} else {
				// Chunks arrive on their own channel, so wait until every byte the worker reported has landed.
				let received = 0;
				let expected = Number.POSITIVE_INFINITY;
				let settle: () => void = () => {};
				const allReceived = new Promise<void>((resolve) => {
					settle = resolve;
				});
				const write = Comlink.proxy((chunk: Uint8Array) => {
					received += chunk.length;
					out.write(chunk);
					if (received >= expected) settle();
				});
				const high = options.quality === "high";
				const result = await api.pdfToEpub(
					file,
					{ mode: options.mode, dpi: high ? 220 : 150, quality: high ? 88 : 80 },
					write,
					onProgress,
				);
				expected = result.bytes;
				if (received >= expected) settle();
				await allReceived;
				outSize = result.bytes;
			}
			if (id !== run.current) return;
			setState((st) => (st.kind === "converting" ? { ...st, done: st.total, label: "Saving" } : st));
			await out.close();
			if (id !== run.current) return;
			setState({ kind: "done", file, info, outName, outSize, ms: performance.now() - started, via: out.kind });
		} catch (e) {
			await out.abort();
			if (id !== run.current) return;
			setState({ kind: "error", file, info, message: message(e) });
			spawn(); // fresh engine after a failure
		} finally {
			if (target.current === out) target.current = null;
		}
	}

	function cancel() {
		run.current++;
		void target.current?.abort();
		target.current = null;
		spawn(); // terminating the worker stops the conversion instantly
		setState((st) => (st.kind === "converting" ? { kind: "ready", file: st.file, info: st.info } : st));
	}

	const reset = () => {
		run.current++;
		setState({ kind: "idle" });
	};

	return (
		<div className={s.page}>
			<header className={s.intro}>
				<h1>
					EPUB <span className={s.swap}>⇄</span> PDF
				</h1>
				<p className={s.lead}>
					Turn ebooks into PDFs and PDFs into ebooks. Everything runs in your browser, so files never leave your device
					and there's no size limit.
				</p>
			</header>

			<Card className={s.panel}>
				{state.kind === "idle" ? (
					<FileDrop
						accept=".epub,.pdf,application/epub+zip,application/pdf"
						title="Drop an EPUB or PDF"
						hint={
							<>
								or click to choose a file · direction is detected automatically
								{engine === "loading" && <span className={s.engine}> · loading engine…</span>}
							</>
						}
						onFile={choose}
					/>
				) : (
					<Workspace
						state={state}
						options={options}
						engine={engine}
						onOptions={update}
						onConvert={convert}
						onCancel={cancel}
						onReset={reset}
					/>
				)}
			</Card>

			<ul className={s.facts}>
				<li>
					<Icon name="lock" size={16} />
					<span>
						<strong>Private.</strong> Nothing is uploaded. Conversion happens on this device.
					</span>
				</li>
				<li>
					<Icon name="book" size={16} />
					<span>
						<strong>Any size.</strong>{" "}
						{canStreamToDisk()
							? "Files are read on demand, and very large outputs stream straight to disk."
							: "Files are read on demand; very large outputs need enough free memory."}
					</span>
				</li>
				<li>
					<Icon name="code" size={16} />
					<span>
						<strong>Open source.</strong> Built on MuPDF, licensed AGPL-3.0.
					</span>
				</li>
			</ul>
		</div>
	);
}

/* ---------- Workspace (file chosen) */

function Workspace({
	state,
	options,
	engine,
	onOptions,
	onConvert,
	onCancel,
	onReset,
}: {
	state: Exclude<State, { kind: "idle" }>;
	options: Options;
	engine: "loading" | "ready" | "failed";
	onOptions: (patch: Partial<Options>) => void;
	onConvert: (file: File, info: InputInfo) => void;
	onCancel: () => void;
	onReset: () => void;
}) {
	const file = state.file;
	const info = "info" in state ? state.info : undefined;
	const busy = state.kind === "converting" || state.kind === "inspecting";
	const toPdf = info?.format === "epub";

	// Enter starts the conversion (a key press counts as the user gesture the save dialog needs).
	const canConvert = state.kind === "ready" && engine === "ready";
	useEffect(() => {
		if (!canConvert || !info || !file) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Enter" || e.repeat || e.defaultPrevented) return;
			const t = e.target as HTMLElement | null;
			if (t && (t.tagName === "BUTTON" || t.tagName === "A")) return; // let focused controls handle Enter
			e.preventDefault();
			onConvert(file, info);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [canConvert, file, info, onConvert]);

	const meta = [file && formatBytes(file.size), info?.pages ? `${info.pages} pages` : null, info?.title || null]
		.filter(Boolean)
		.join(" · ");

	return (
		<div className={s.workspace}>
			<div className={s.fileRow}>
				{file && (
					<Chip
						badge={info ? info.format.toUpperCase() : "…"}
						name={file.name}
						meta={state.kind === "inspecting" ? "Reading file…" : meta}
						to={info ? (toPdf ? "PDF" : "EPUB") : undefined}
					/>
				)}
				<Button variant="ghost" icon="x" onClick={onReset} disabled={state.kind === "converting"}>
					Change file
				</Button>
			</div>

			{engine === "failed" && (
				<Note tone="danger">The conversion engine couldn't load. Check your connection and reload the page.</Note>
			)}

			{info?.format === "pdf" && info.looksScanned && state.kind === "ready" && (
				<Note tone="info">
					This PDF looks scanned (little or no selectable text), so <strong>Fixed layout</strong> is selected: each page
					becomes an image, exactly as printed.
				</Note>
			)}

			{info && (
				<div className={s.options}>
					{toPdf ? (
						<>
							<Pills
								label="Page size"
								value={options.pageSize}
								disabled={busy}
								options={(Object.keys(PAGE_SIZES) as PageSize[]).map((k) => ({ value: k, label: PAGE_SIZES[k].label }))}
								onChange={(pageSize) => onOptions({ pageSize })}
							/>
							<Pills
								label="Font size"
								value={options.fontSize}
								disabled={busy}
								options={(["10", "11", "12", "14"] as FontSize[]).map((v) => ({ value: v, label: `${v} pt` }))}
								onChange={(fontSize) => onOptions({ fontSize })}
							/>
							<Pills
								label="Margins"
								value={options.margin}
								disabled={busy}
								options={[
									{ value: "narrow", label: "Narrow" },
									{ value: "normal", label: "Normal" },
									{ value: "wide", label: "Wide" },
								]}
								onChange={(margin) => onOptions({ margin })}
							/>
						</>
					) : (
						<>
							<Pills
								label="Layout"
								value={options.mode}
								disabled={busy}
								options={[
									{ value: "reflow", label: "Reflowable text" },
									{ value: "fixed", label: "Fixed pages" },
								]}
								onChange={(mode) => onOptions({ mode })}
							/>
							{options.mode === "fixed" && (
								<Pills
									label="Image quality"
									value={options.quality}
									disabled={busy}
									options={[
										{ value: "standard", label: "Standard" },
										{ value: "high", label: "High" },
									]}
									onChange={(quality) => onOptions({ quality })}
								/>
							)}
							<p className={s.modeHint}>
								{options.mode === "reflow"
									? "Text reflows to any screen and font size. Complex layouts (tables, multi-column, equations) may come out imperfect."
									: "Every page is kept exactly as it looks, as an image. Best for comics, scans and design-heavy PDFs; text can't be resized."}
							</p>
						</>
					)}
				</div>
			)}

			{state.kind === "converting" && (
				<Progress
					value={state.done}
					max={state.total}
					label={state.total ? `${state.label} · ${state.done} / ${state.total}` : `${state.label}…`}
					detail={
						state.done > 0
							? `${Math.round((performance.now() - state.started) / state.done)} ms/page`
							: formatDuration(performance.now() - state.started)
					}
				/>
			)}

			{state.kind === "done" && (
				<Note tone="success">
					{state.via === "disk" ? "Saved" : "Downloaded"} <strong>{state.outName}</strong> ·{" "}
					{formatBytes(state.outSize)} · {formatDuration(state.ms)}
				</Note>
			)}

			{state.kind === "error" && <Note tone="danger">{state.message}</Note>}

			<div className={s.actions}>
				{state.kind === "converting" ? (
					<Button variant="ghost" icon="x" onClick={onCancel}>
						Cancel
					</Button>
				) : state.kind === "done" ? (
					<>
						<Button icon="upload" onClick={onReset}>
							Convert another
						</Button>
						<Button variant="ghost" onClick={() => file && info && onConvert(file, info)}>
							Convert again
						</Button>
					</>
				) : (
					<Button
						icon="swap"
						disabled={!info || !file || engine !== "ready" || busy}
						onClick={() => info && file && onConvert(file, info)}
					>
						{info ? `Convert to ${toPdf ? "PDF" : "EPUB"}` : "Convert"}
					</Button>
				)}
				{state.kind === "ready" && (
					<span className={s.shortcut}>
						{willAskWhereToSave(state.file.size) ? "You'll choose where to save" : "Saves to your downloads"} ·{" "}
						<Kbd>Enter</Kbd>
					</span>
				)}
			</div>
		</div>
	);
}
