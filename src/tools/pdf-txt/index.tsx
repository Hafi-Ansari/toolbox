import * as Comlink from "comlink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { detectFile } from "../../lib/detect.ts";
import { formatBytes, formatDuration, swapExtension } from "../../lib/format.ts";
import { Icon } from "../../lib/Icon.tsx";
import { openSaveTarget } from "../../lib/saveFile.ts";
import { Button, Card, Chip, FileDrop, Note, Pills, Progress } from "../../lib/ui.tsx";
import { startWorker, type WorkerHandle } from "../../lib/worker.ts";
import {
	type Box,
	type Flag,
	type Mode,
	type OutLine,
	type Override,
	PASSAGE_KIND,
	type Selected,
	selectionSpan,
	type TxtResult,
	txtLines,
} from "./engine/index.ts";
import { selectedLines } from "./engine/select.ts";
import { before as earlier } from "./engine/source.ts";
import { OcrPanel } from "./OcrPanel.tsx";
import { findOverride, loadOverrides, OverrideList, saveOverrides } from "./Overrides.tsx";
import s from "./PdfTxt.module.css";
import type { LoadedBook, TxtApi } from "./txt.worker.ts";

/* ---------- Options */

interface Options {
	indent: boolean;
	matter: boolean;
}

const DEFAULTS: Options = { indent: true, matter: false };
const STORAGE_KEY = "toolbox.pdf-txt.options";

function loadOptions(): Options {
	try {
		return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
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
	| { kind: "reading"; file: File; done: number; total: number; started: number }
	| { kind: "ready"; file: File; book: LoadedBook; mode: Mode; result: TxtResult; ms: number; overrides: Override[] }
	| { kind: "error"; file?: File; message: string };

const createWorker = () =>
	startWorker<TxtApi>(() => new Worker(new URL("./txt.worker.ts", import.meta.url), { type: "module" }));

function message(e: unknown): string {
	const text = e instanceof Error ? e.message : String(e);
	if (/password/i.test(text)) return "This file is password-protected. Remove the password and try again.";
	if (/memory|allocation|OOM/i.test(text)) return "Ran out of memory. Try closing other tabs, or a smaller file.";
	return `Reading the PDF failed: ${text}`;
}

const FLAG_LABELS: Record<Flag["kind"], string> = {
	"image-only": "Needs OCR",
	"empty-page": "Empty page",
	"furniture-removed": "Removed page furniture",
	"furniture-kept": "Possible page furniture",
	"low-confidence-title": "Uncertain title",
	"wrap-joined": "Joined wrapped line",
	"possible-wrap": "Possible wrapped line",
	"ocr-noise": "Possible OCR misreading",
	"ocr-fixed": "OCR correction",
	"ocr-added": "Added by OCR",
	"ocr-replaced": "Replaced by OCR",
	"ocr-differs": "OCR reads differently",
	"ocr-page": "Read by OCR",
};

/** Flags worth a reader's attention first; the rest are informational. */
const REVIEW_FIRST: Flag["kind"][] = [
	"image-only",
	"low-confidence-title",
	"ocr-noise",
	"furniture-kept",
	"possible-wrap",
	"ocr-added",
	"ocr-replaced",
	"ocr-differs",
];

export default function PdfTxtTool() {
	const [state, setState] = useState<State>({ kind: "idle" });
	const [engine, setEngine] = useState<"loading" | "ready" | "failed">("loading");
	const worker = useRef<WorkerHandle<TxtApi> | null>(null);
	const run = useRef(0);

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

	useEffect(() => {
		spawn();
		return () => worker.current?.terminate();
	}, [spawn]);

	async function choose(file: File) {
		const id = ++run.current;
		const started = performance.now();
		setState({ kind: "reading", file, done: 0, total: 0, started });
		try {
			if ((await detectFile(file)) !== "pdf") throw new Error("NOT_PDF");
			const api = await (worker.current ?? spawn()).api;
			const onProgress = Comlink.proxy((done: number, total: number) => {
				if (id !== run.current) return;
				setState((st) => (st.kind === "reading" ? { ...st, done, total } : st));
			});
			const book = await api.load(file, onProgress);
			const overrides = loadOverrides(file);
			const result = await api.convert(book.mode, overrides);
			if (id !== run.current) return;
			setState({ kind: "ready", file, book, mode: book.mode, result, ms: performance.now() - started, overrides });
		} catch (e) {
			if (id !== run.current) return;
			const notPdf = e instanceof Error && e.message === "NOT_PDF";
			setState({ kind: "error", file, message: notPdf ? "This doesn't look like a PDF file." : message(e) });
			if (!notPdf) spawn();
		}
	}

	/** Re-converts in `mode`, with new overrides when given (saved for the file). */
	async function changeMode(mode: Mode, overrides?: Override[]) {
		if (state.kind !== "ready") return;
		const id = ++run.current;
		const next = overrides ?? state.overrides;
		try {
			const api = await (worker.current ?? spawn()).api;
			const result = await api.convert(mode, next);
			if (id !== run.current) return;
			if (overrides) saveOverrides(state.file, overrides);
			setState((st) => (st.kind === "ready" ? { ...st, mode, result, overrides: next } : st));
		} catch (e) {
			if (id === run.current) setState({ kind: "error", file: state.file, message: message(e) });
		}
	}

	function cancel() {
		run.current++;
		spawn(); // terminating the worker stops reading instantly
		setState({ kind: "idle" });
	}

	const reset = () => {
		run.current++;
		setState({ kind: "idle" });
	};

	return (
		<div className={s.page}>
			<header className={s.intro}>
				<h1>
					PDF <span className={s.arrow}>→</span> TXT
				</h1>
				<p className={s.lead}>
					Turn a book of poems or prose into clean plain text: one verse line or one sentence per line, page numbers and
					running heads removed. Check it against the printed page before you save. Nothing leaves your device.
				</p>
			</header>

			<Card className={s.panel}>
				{state.kind === "idle" ? (
					<FileDrop
						accept=".pdf,application/pdf"
						title="Drop a PDF"
						hint={
							<>
								or click to choose a file · poetry or prose is detected automatically
								{engine === "loading" && <span className={s.engine}> · loading engine…</span>}
							</>
						}
						onFile={choose}
					/>
				) : state.kind === "ready" ? (
					<Review
						key={`${state.file.name}:${state.file.size}:${state.file.lastModified}`}
						state={state}
						worker={worker}
						onMode={changeMode}
						onReset={reset}
					/>
				) : (
					<div className={s.workspace}>
						<div className={s.fileRow}>
							{state.file && (
								<Chip
									badge="PDF"
									name={state.file.name}
									meta={formatBytes(state.file.size)}
									to={state.kind === "reading" ? "TXT" : undefined}
								/>
							)}
							<Button variant="ghost" icon="x" onClick={state.kind === "reading" ? cancel : reset}>
								{state.kind === "reading" ? "Cancel" : "Change file"}
							</Button>
						</div>
						{engine === "failed" && (
							<Note tone="danger">The engine couldn't load. Check your connection and reload the page.</Note>
						)}
						{state.kind === "reading" && (
							<Progress
								value={state.done}
								max={state.total}
								label={state.total ? `Reading pages · ${state.done} / ${state.total}` : "Opening…"}
								detail={formatDuration(performance.now() - state.started)}
							/>
						)}
						{state.kind === "error" && <Note tone="danger">{state.message}</Note>}
					</div>
				)}
			</Card>

			{state.kind !== "ready" && (
				<ul className={s.facts}>
					<li>
						<Icon name="lock" size={16} />
						<span>
							<strong>Private.</strong> Nothing is uploaded. The PDF is read on this device.
						</span>
					</li>
					<li>
						<Icon name="book" size={16} />
						<span>
							<strong>Made for books.</strong> Finds each poem or chapter, keeps stanzas and indents, drops page
							furniture.
						</span>
					</li>
					<li>
						<Icon name="text" size={16} />
						<span>
							<strong>Scans too.</strong> A scan's text layer is used as it is; OCR, run on this device, reads pages
							without one and repairs garbled lines.
						</span>
					</li>
				</ul>
			)}
		</div>
	);
}

/* ---------- Review: text beside the printed page */

function Review({
	state,
	worker,
	onMode,
	onReset,
}: {
	state: Extract<State, { kind: "ready" }>;
	worker: React.RefObject<WorkerHandle<TxtApi> | null>;
	onMode: (mode: Mode, overrides?: Override[]) => Promise<void>;
	onReset: () => void;
}) {
	const { file, book, result, mode, overrides } = state;
	const [options, setOptions] = useState<Options>(loadOptions);
	const lines = useMemo(
		() => txtLines(result, { indent: options.indent, matter: options.matter }),
		[result, options.indent, options.matter],
	);
	const generated = useMemo(() => (lines.length ? `${lines.map((l) => l.text).join("\n")}\n` : ""), [lines]);
	const [text, setText] = useState(generated);
	const [edited, setEdited] = useState(false);
	const [page, setPage] = useState(() => lines[0]?.page ?? 0);
	const [mark, setMark] = useState<{ box: Box; page: number; tone: "line" | "flag" } | null>(null);
	const [saved, setSaved] = useState<string | null>(null);
	const area = useRef<HTMLTextAreaElement>(null);
	const panes = useRef<HTMLDivElement>(null);
	/** The printed passage behind the caret or selection, for "Keep printed lines" / "Reflow as prose". */
	const [selected, setSelected] = useState<Selected | null>(null);
	/** An override to show once the text is rebuilt after adding or undoing it. */
	const pending = useRef<Override | null>(null);

	// A new conversion (mode or options changed) replaces the text.
	useEffect(() => {
		setText(generated);
		setEdited(false);
	}, [generated]);

	const discardEdits = () =>
		!edited || window.confirm("This rebuilds the text from the PDF and discards your edits. Continue?");

	const update = (patch: Partial<Options>) => {
		if (!discardEdits()) return;
		setOptions((o) => {
			const next = { ...o, ...patch };
			saveOptions(next);
			return next;
		});
	};

	const works = result.works.filter((w) => w.kind !== "matter" || options.matter);
	const counts = {
		works: result.works.filter((w) => w.kind === "work").length,
		needsOcr: result.flags.filter((f) => f.kind === "image-only").length,
	};
	const flags = useMemo(() => {
		const rank = (f: Flag) => (REVIEW_FIRST.includes(f.kind) ? 0 : 1);
		return [...result.flags].sort((a, b) => rank(a) - rank(b) || a.page - b.page);
	}, [result.flags]);
	const reviewCount = flags.filter((f) => REVIEW_FIRST.includes(f.kind)).length;
	const size = useMemo(
		() => ({ bytes: new TextEncoder().encode(text).length, lines: text.split("\n").length - 1 }),
		[text],
	);

	/** Shows the source of the line holding the caret. */
	const followCaret = () => {
		const el = area.current;
		if (!el) return;
		let line = 0;
		for (let i = el.value.indexOf("\n"); i >= 0 && i < el.selectionStart; i = el.value.indexOf("\n", i + 1)) line++;
		const sel = selectedLines(el.value, el.selectionStart, el.selectionEnd);
		setSelected(selectionSpan(lines, sel.first, sel.last, sel.caret));
		const src = lines[line];
		if (!src) return;
		setPage(src.page);
		setMark(src.box ? { box: src.box, page: src.page, tone: "line" } : null);
	};

	/** Selects output lines `index` to `last` in the text and scrolls them into view. */
	const selectLine = (index: number, last = index) => {
		const el = area.current;
		if (!el || index < 0) return;
		let start = 0;
		for (let i = 0; i < index; i++) {
			const next = el.value.indexOf("\n", start);
			if (next < 0) break;
			start = next + 1;
		}
		let end = el.value.indexOf("\n", start);
		for (let i = index; i < last && end >= 0; i++) end = el.value.indexOf("\n", end + 1);
		// Focus first: an unfocused textarea doesn't keep (or show) its selection.
		el.focus({ preventScroll: true });
		el.setSelectionRange(start, end < 0 ? el.value.length : end);
		el.scrollTop = Math.max(0, caretTop(el, start) - el.clientHeight / 3);
	};

	const showFlag = (f: Flag) => {
		// The list sits below the panes: bring them into view to show the flagged spot.
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		panes.current?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
		setPage(f.page);
		setMark(f.box ? { box: f.box, page: f.page, tone: "flag" } : null);
		selectLine(lineFor(lines, f));
	};

	/** Shows where an override sits: its lines selected, its passage marked on the page. */
	const showOverride = (o: Override) => {
		const at = findOverride(lines, o);
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		panes.current?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
		setPage(at.page);
		setMark(at.box ? { box: at.box, page: at.page, tone: "line" } : null);
		selectLine(at.first, at.last);
	};

	// After a re-conversion for an override, show the passage it changed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once the rebuilt text is in place
	useEffect(() => {
		const o = pending.current;
		if (!o || text !== generated) return;
		pending.current = null;
		showOverride(o);
	}, [text, generated, lines]);

	const changeOverrides = (next: Override[], show: Override) => {
		if (!discardEdits()) return;
		pending.current = show;
		setSelected(null);
		void onMode(mode, next);
	};

	/** The passage override of this mode that already covers the selection, if any: the button then undoes it. */
	const covering = selected
		? overrides.find(
				(o) =>
					o.kind === PASSAGE_KIND[mode] &&
					!earlier(selected.span.from, o.span.from) &&
					!earlier(o.span.to, selected.span.to),
			)
		: undefined;

	const togglePassage = () => {
		if (covering)
			return changeOverrides(
				overrides.filter((o) => o !== covering),
				covering,
			);
		if (!selected) return;
		// A new passage absorbs the ones it overlaps.
		const kind = PASSAGE_KIND[mode];
		let span = selected.span;
		const rest = overrides.filter((o) => {
			if (o.kind !== kind || earlier(o.span.to, span.from) || earlier(span.to, o.span.from)) return true;
			span = {
				from: earlier(o.span.from, span.from) ? o.span.from : span.from,
				to: earlier(span.to, o.span.to) ? o.span.to : span.to,
			};
			return false;
		});
		const added: Override = { kind, span, text: selected.text };
		changeOverrides([...rest, added], added);
	};

	const joinFlag = (f: Flag) => {
		if (!f.box) return;
		const added: Override = { kind: "join", at: { page: f.page, y: (f.box.y0 + f.box.y1) / 2 }, text: f.text };
		changeOverrides([...overrides, added], added);
	};

	const showWork = (index: number) => {
		const w = result.works[index];
		if (!w) return;
		setPage(w.page);
		setMark(w.titleBox ? { box: w.titleBox, page: w.page, tone: "line" } : null);
		selectLine(lines.findIndex((l) => l.work === index && l.text.trim() !== ""));
	};

	async function download() {
		const name = swapExtension(file.name, "txt");
		const out = await openSaveTarget(name, "text/plain", "Plain text").catch(() => null);
		if (!out) return;
		out.write(new TextEncoder().encode(text));
		await out.close();
		setSaved(`${out.kind === "disk" ? "Saved" : "Downloaded"} ${name}`);
	}

	const kindWord = mode === "poetry" ? "poems" : "chapters";
	const summary = [
		`${counts.works} ${counts.works === 1 ? kindWord.replace(/s$/, "") : kindWord}`,
		`${book.pages} pages`,
		result.detection === "layout" ? "found by layout" : "found by bookmarks",
		formatDuration(state.ms),
	].join(" · ");

	return (
		<div className={s.workspace}>
			<div className={s.fileRow}>
				<Chip badge="PDF" name={file.name} meta={summary} to="TXT" />
				<Button variant="ghost" icon="x" onClick={() => discardEdits() && onReset()}>
					Change file
				</Button>
			</div>

			<div className={s.options}>
				<Pills
					label="Book type"
					value={mode}
					options={[
						{ value: "poetry", label: "Poetry" },
						{ value: "prose", label: "Prose" },
					]}
					onChange={(m) => discardEdits() && void onMode(m)}
				/>
				{mode === "poetry" && (
					<Pills
						label="Indents"
						value={options.indent ? "keep" : "drop"}
						options={[
							{ value: "keep", label: "Keep" },
							{ value: "drop", label: "Remove" },
						]}
						onChange={(v) => update({ indent: v === "keep" })}
					/>
				)}
				<Pills
					label="Front & back matter"
					value={options.matter ? "include" : "omit"}
					options={[
						{ value: "omit", label: "Leave out" },
						{ value: "include", label: "Include" },
					]}
					onChange={(v) => update({ matter: v === "include" })}
				/>
				<p className={s.modeHint}>
					{mode === "poetry"
						? "One printed line per line, stanzas separated by a blank line."
						: "One sentence per line, paragraphs separated by a blank line."}{" "}
					Works are separated by three empty lines.
				</p>
			</div>

			{counts.needsOcr === book.pages ? (
				<Note tone="info">
					Every page of this PDF is a scan without a text layer, so its words exist only as images. Run OCR below to
					read them.
				</Note>
			) : counts.needsOcr > 0 ? (
				<Note tone="info">
					{counts.needsOcr === 1 ? "1 page is a scan" : `${counts.needsOcr} pages are scans`} without a text layer.
					Their words are missing from the text until you run OCR; they're listed under <strong>Review</strong>.
				</Note>
			) : book.ocr > book.pages / 2 ? (
				<Note tone="info">
					This is a scanned book with a text layer from OCR. Scanner misreadings carry over, so check lines against the
					page, especially italics and spaced-out letters.
				</Note>
			) : null}

			<OcrPanel
				worker={worker}
				page={page}
				pages={book.pages}
				result={result}
				edited={edited}
				confirmDiscard={discardEdits}
				onConverted={() => onMode(mode)}
			/>

			<div ref={panes} className={s.review}>
				<section className={s.textPane} aria-label="Text">
					<div className={s.paneBar}>
						<span className={s.paneTitle}>Text{edited && <span className={s.edited}> · edited</span>}</span>
						<span className={s.paneMeta}>{size.lines ? `${size.lines} lines` : ""}</span>
						<button
							type="button"
							className={s.barButton}
							disabled={!selected}
							onClick={togglePassage}
							title={
								covering
									? "Undo this change: convert the passage like the rest of the book"
									: mode === "prose"
										? "Keep the selected passage (or the paragraph at the caret) line by line, as printed: for verse quoted in prose"
										: "Reflow the selected passage (or the stanza at the caret) into sentences: for a prose poem or a note"
							}
						>
							{covering
								? mode === "prose"
									? "Undo kept lines"
									: "Undo reflow"
								: mode === "prose"
									? "Keep printed lines"
									: "Reflow as prose"}
						</button>
						{edited && (
							<Button
								variant="ghost"
								onClick={() => {
									if (!discardEdits()) return;
									setText(generated);
									setEdited(false);
								}}
							>
								Revert
							</Button>
						)}
					</div>
					<textarea
						ref={area}
						className={s.text}
						value={text}
						spellCheck={false}
						aria-label="Extracted text"
						onChange={(e) => {
							setText(e.target.value);
							setEdited(true);
						}}
						onSelect={followCaret}
						onKeyUp={followCaret}
						onMouseUp={followCaret}
					/>
				</section>

				<section className={s.pagePane} aria-label="Printed page">
					<div className={s.paneBar}>
						<button
							type="button"
							className={s.iconButton}
							onClick={() => setPage((p) => Math.max(0, p - 1))}
							disabled={page <= 0}
							aria-label="Previous page"
						>
							<Icon name="back" size={16} />
						</button>
						<span className={s.paneTitle}>
							Page {page + 1} <span className={s.paneMeta}>of {book.pages}</span>
						</span>
						<button
							type="button"
							className={s.iconButton}
							onClick={() => setPage((p) => Math.min(book.pages - 1, p + 1))}
							disabled={page >= book.pages - 1}
							aria-label="Next page"
						>
							<Icon name="arrow" size={16} />
						</button>
						{works.length > 1 && (
							<select
								className={s.jump}
								aria-label="Go to work"
								value={String(
									result.works.findIndex((w) => page >= w.page && page <= w.endPage && w.kind !== "matter"),
								)}
								onChange={(e) => showWork(Number(e.target.value))}
							>
								<option value="-1" disabled>
									Go to…
								</option>
								{result.works.map((w, i) =>
									w.kind === "matter" && !options.matter ? null : (
										// biome-ignore lint/suspicious/noArrayIndexKey: the index is the work's identity (it is also the value)
										<option key={`${i}:${w.page}`} value={String(i)}>
											{w.kind === "section" ? "§ " : ""}
											{w.title || "Untitled"} · p. {w.page + 1}
										</option>
									),
								)}
							</select>
						)}
					</div>
					<PageView worker={worker} index={page} mark={mark?.page === page ? mark : null} />
				</section>
			</div>

			<OverrideList
				overrides={overrides}
				mode={mode}
				onShow={showOverride}
				onUndo={(o) =>
					changeOverrides(
						overrides.filter((x) => x !== o),
						o,
					)
				}
			/>

			<details className={s.flags} open={reviewCount > 0 && reviewCount <= 40}>
				<summary>
					Review{" "}
					<span className={s.paneMeta}>
						· {reviewCount} to check · {flags.length - reviewCount} notes
					</span>
				</summary>
				{flags.length ? (
					<ul>
						{flags.map((f, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: flags are a fixed list per conversion; two can share kind and page
							<li key={`${f.kind}:${f.page}:${i}`} className={f.kind === "possible-wrap" ? s.override : undefined}>
								<button type="button" onClick={() => showFlag(f)} className={s.flag}>
									<span className={REVIEW_FIRST.includes(f.kind) ? s.flagKind : s.flagNote}>{FLAG_LABELS[f.kind]}</span>
									<span className={s.flagPage}>p. {f.page + 1}</span>
									<span className={s.flagReason}>{f.reason}</span>
								</button>
								{f.kind === "possible-wrap" && f.box && (
									<button
										type="button"
										className={s.barButton}
										onClick={() => joinFlag(f)}
										title="Join this line to the line above: one long verse line wrapped by the layout"
									>
										Join
									</button>
								)}
							</li>
						))}
					</ul>
				) : (
					<p className={s.paneMeta}>Nothing flagged.</p>
				)}
			</details>

			{saved && <Note tone="success">{saved}</Note>}

			<div className={s.actions}>
				<Button icon="download" disabled={!text.trim()} onClick={download}>
					Download TXT
				</Button>
				<span className={s.shortcut}>{formatBytes(size.bytes)} · UTF-8 · LF line endings</span>
			</div>
		</div>
	);
}

/** The output line a flag points at: the line printed where the flag sits, else the first line from its page. */
function lineFor(lines: OutLine[], f: Flag): number {
	if (f.box) {
		const y = f.box.y0;
		const hit = lines.findIndex((l) => l.page === f.page && l.box && Math.abs(l.box.y0 - y) < 3);
		if (hit >= 0) return hit;
	}
	if (f.text) {
		const hit = lines.findIndex((l) => l.page === f.page && l.text.includes(f.text ?? ""));
		if (hit >= 0) return hit;
	}
	const onPage = lines.findIndex((l) => l.page >= f.page && l.text);
	return onPage;
}

/** Pixel offset of character `pos` inside a textarea, measured with a mirror element (handles wrapped lines). */
function caretTop(el: HTMLTextAreaElement, pos: number): number {
	const mirror = document.createElement("div");
	const css = getComputedStyle(el);
	for (const p of [
		"fontFamily",
		"fontSize",
		"lineHeight",
		"letterSpacing",
		"tabSize",
		"whiteSpace",
		"wordBreak",
	] as const)
		mirror.style[p] = css[p];
	mirror.style.whiteSpace = "pre-wrap";
	mirror.style.overflowWrap = "anywhere";
	mirror.style.position = "absolute";
	mirror.style.visibility = "hidden";
	mirror.style.boxSizing = "border-box";
	mirror.style.width = `${el.clientWidth}px`;
	mirror.style.padding = css.padding;
	mirror.textContent = el.value.slice(0, pos);
	document.body.append(mirror);
	const top = mirror.scrollHeight - Number.parseFloat(css.lineHeight || "20");
	mirror.remove();
	return top;
}

/* ---------- Page image */

function PageView({
	worker,
	index,
	mark,
}: {
	worker: React.RefObject<WorkerHandle<TxtApi> | null>;
	index: number;
	mark: { box: Box; tone: "line" | "flag" } | null;
}) {
	const holder = useRef<HTMLDivElement>(null);
	const cache = useRef(new Map<number, { url: string; width: number; height: number }>());
	const [shown, setShown] = useState<{ index: number; url: string; width: number; height: number } | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let live = true;
		const cached = cache.current.get(index);
		if (cached) {
			setShown({ index, ...cached });
			return;
		}
		setFailed(false);
		const cssWidth = Math.max(320, holder.current?.clientWidth ?? 600);
		(async () => {
			try {
				const api = await worker.current?.api;
				if (!api) return;
				const r = await api.render(index, cssWidth, Math.min(2, window.devicePixelRatio || 1));
				const url = URL.createObjectURL(new Blob([r.png as Uint8Array<ArrayBuffer>], { type: "image/png" }));
				const entry = { url, width: r.width, height: r.height };
				cache.current.set(index, entry);
				// Keep a handful of pages; release the rest.
				for (const [k, v] of cache.current)
					if (cache.current.size > 12 && k !== index) {
						URL.revokeObjectURL(v.url);
						cache.current.delete(k);
					}
				if (live) setShown({ index, ...entry });
			} catch {
				if (live) setFailed(true);
			}
		})();
		return () => {
			live = false;
		};
	}, [index, worker]);

	useEffect(() => {
		const c = cache.current;
		return () => {
			for (const v of c.values()) URL.revokeObjectURL(v.url);
			c.clear();
		};
	}, []);

	const pct = (n: number, of: number) => `${(n / of) * 100}%`;
	return (
		<div ref={holder} className={s.sheetHolder}>
			{failed ? (
				<p className={s.paneMeta}>This page couldn't be drawn.</p>
			) : shown ? (
				<div
					className={s.sheet}
					style={{ aspectRatio: `${shown.width} / ${shown.height}`, opacity: shown.index === index ? 1 : 0.4 }}
				>
					<img src={shown.url} alt={`Page ${shown.index + 1}`} draggable={false} />
					{mark && shown.index === index && (
						<span
							className={mark.tone === "flag" ? s.markFlag : s.markLine}
							style={{
								left: pct(mark.box.x0 - 3, shown.width),
								top: pct(mark.box.y0 - 2, shown.height),
								width: pct(mark.box.x1 - mark.box.x0 + 6, shown.width),
								height: pct(mark.box.y1 - mark.box.y0 + 4, shown.height),
							}}
						/>
					)}
				</div>
			) : (
				<div className={s.sheetLoading} aria-busy="true" />
			)}
		</div>
	);
}
