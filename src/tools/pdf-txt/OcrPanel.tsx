// On-demand OCR for PDF → TXT: reads scanned pages (or any one page) with
// tesseract.js, hands the results to the txt worker, and asks the tool to
// convert again. The txt worker keeps the results, so later mode switches
// include them. OCR fills gaps in a page's text and flags disagreements; it
// never replaces a page that has text (see engine/ocr.ts).
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../lib/Icon.tsx";
import { Button, Note, Progress } from "../../lib/ui.tsx";
import type { WorkerHandle } from "../../lib/worker.ts";
import type { Flag, TxtResult } from "./engine/index.ts";
import s from "./Ocr.module.css";
import { OCR_DOWNLOAD, type OcrEngine, startOcr } from "./ocr/engine.ts";
import type { TxtApi } from "./txt.worker.ts";

/** Rough cost of a page before any is measured: 0.5–0.6 s for verse in Edge, more for dense prose. */
const MS_PER_PAGE = 1000;

function roughly(ms: number): string {
	const s = Math.max(1, Math.round(ms / 1000));
	if (s < 60) return `${s} s`;
	const min = Math.round(s / 60);
	return `${min} min`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface Job {
	total: number;
	done: number;
	/** The page being read. */
	page: number;
	/** Set while tesseract.js loads (first use downloads it). */
	loading: boolean;
	started: number;
}

export function OcrPanel({
	worker,
	page,
	pages,
	result,
	edited,
	confirmDiscard,
	onConverted,
}: {
	worker: React.RefObject<WorkerHandle<TxtApi> | null>;
	/** The page shown beside the text (0-based). */
	page: number;
	pages: number;
	result: TxtResult;
	/** The text has been edited by hand. */
	edited: boolean;
	/** Asks before OCR rebuilds edited text; false keeps the edits. */
	confirmDiscard: () => boolean;
	/** Converts again with the current mode and options, so the OCR results show. */
	onConverted: () => Promise<void>;
}) {
	const [scans, setScans] = useState<number[] | null>(null);
	/** Every page lacked text when the book was read: a scanned book without a text layer. */
	const [allScans, setAllScans] = useState(false);
	const [done, setDone] = useState<ReadonlySet<number>>(new Set());
	const [job, setJob] = useState<Job | null>(null);
	const [message, setMessage] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
	const engine = useRef<OcrEngine | null>(null);
	const run = useRef(0);
	// The latest callbacks: a long run must convert with the mode chosen meanwhile.
	const latest = useRef({ edited, confirmDiscard, onConverted });
	latest.current = { edited, confirmDiscard, onConverted };
	/** The user already agreed to lose their edits when this run started. */
	const agreed = useRef(false);

	useEffect(() => {
		let live = true;
		(async () => {
			const api = await worker.current?.api;
			if (!api) return;
			const [list, read] = await Promise.all([api.scanPages(), api.ocrPages()]);
			if (!live) return;
			setScans(list.pages);
			setAllScans(list.textless === pages && pages > 0);
			setDone(new Set(read));
		})().catch(() => live && setScans([]));
		return () => {
			live = false;
		};
	}, [worker, pages]);

	useEffect(
		() => () => {
			run.current++;
			engine.current?.terminate();
		},
		[],
	);

	/** Converts again, asking first if the text was edited since the run started. */
	async function reconvert(): Promise<boolean> {
		if (!agreed.current && !latest.current.confirmDiscard()) {
			setMessage({
				tone: "info",
				text: "OCR is done, and your edited text was kept. Revert the text or switch modes to see what OCR read.",
			});
			return false;
		}
		await latest.current.onConverted();
		return true;
	}

	async function start(targets: number[]) {
		if (!targets.length || job) return;
		if (!latest.current.confirmDiscard()) return;
		agreed.current = latest.current.edited;
		const id = ++run.current;
		const live = () => id === run.current;
		setMessage(null);
		setJob({ total: targets.length, done: 0, page: targets[0], loading: !engine.current, started: performance.now() });
		let read = 0;
		try {
			const api = await worker.current?.api;
			if (!api) throw new Error("The converter isn't running.");
			// Rendering the first page overlaps with loading OCR; after that, page n+1 renders while page n is read.
			let next = api.renderForOcr(targets[0]);
			next.catch(() => {});
			engine.current ??= await startOcr();
			if (!live()) return;
			setJob((j) => j && { ...j, loading: false, started: performance.now() });
			for (let k = 0; k < targets.length; k++) {
				const { image, scale } = await next;
				if (!live()) return;
				if (k + 1 < targets.length) {
					next = api.renderForOcr(targets[k + 1]);
					next.catch(() => {});
				}
				setJob((j) => j && { ...j, page: targets[k] });
				const ocr = await engine.current.recognize(image, targets[k], scale);
				if (!live()) return;
				await api.addOcr(ocr);
				read++;
				setDone((d) => new Set([...d, targets[k]]));
				setJob((j) => j && { ...j, done: k + 1 });
			}
			await reconvert();
		} catch (e) {
			if (!live()) return;
			engine.current?.terminate();
			engine.current = null;
			const text = e instanceof Error ? e.message : String(e);
			setMessage({ tone: "danger", text: `OCR failed: ${text}` });
			if (read) await reconvert().catch(() => {});
		} finally {
			if (live()) setJob(null);
		}
	}

	async function cancel() {
		run.current++;
		// Terminating stops tesseract mid-page; pages already read are kept.
		engine.current?.terminate();
		engine.current = null;
		const finished = job?.done ?? 0;
		setJob(null);
		if (finished) await reconvert().catch(() => {});
	}

	if (scans === null) return null;
	const todo = scans.filter((p) => !done.has(p));
	const pageDone = done.has(page);
	const counts = ocrCounts(result.flags);
	const elapsed = job && !job.loading ? performance.now() - job.started : 0;
	const perPage = job && job.done > 0 ? elapsed / job.done : MS_PER_PAGE;

	return (
		<section className={s.panel} aria-label="OCR">
			<div className={s.head}>
				<Icon name="text" size={16} />
				<div className={s.copy}>
					<p className={s.title}>
						{allScans
							? todo.length
								? "Read this scanned book with OCR"
								: "This scanned book was read by OCR"
							: scans.length
								? `${plural(scans.length, "page is a scan", "pages are scans")}`
								: "OCR"}
					</p>
					<p className={s.detail}>
						{allScans
							? todo.length
								? "Its pages are pictures of text. OCR reads the words from them, here on this device."
								: "Its words come from OCR, run on this device. Check lines against the page, especially names and italics."
							: scans.length
								? "OCR reads the printed page again: it fills in lines missing from the text and fixes garbled ones, and flags other differences for review."
								: "If a page's text is missing or garbled, OCR can read the printed page."}
						{!done.size && <> The first use downloads {OCR_DOWNLOAD}, once.</>}
					</p>
				</div>
			</div>

			{job ? (
				<div className={s.running}>
					<Progress
						value={job.done}
						max={job.loading || job.total === 1 ? 0 : job.total}
						label={
							job.loading
								? `Loading OCR (${OCR_DOWNLOAD} the first time)…`
								: job.total === 1
									? `Reading page ${job.page + 1}…`
									: `Reading page ${job.page + 1} · ${job.done} / ${job.total}`
						}
						detail={
							job.loading || job.total === 1 ? undefined : `about ${roughly(perPage * (job.total - job.done))} left`
						}
					/>
					<Button variant="ghost" icon="x" onClick={cancel}>
						Cancel
					</Button>
				</div>
			) : (
				<div className={s.actions}>
					{todo.length > 0 && (
						<Button icon="text" onClick={() => start(todo)}>
							{done.size && todo.length < scans.length
								? `Run OCR on the other ${plural(todo.length, "scanned page")}`
								: `Run OCR on ${plural(todo.length, "scanned page")}`}
						</Button>
					)}
					<Button
						variant="ghost"
						disabled={pageDone}
						onClick={() => start([page])}
						icon={pageDone ? "check" : undefined}
					>
						{pageDone ? `Page ${page + 1} read by OCR` : `OCR page ${page + 1}`}
					</Button>
					{todo.length > 0 && <span className={s.meta}>about {roughly(todo.length * MS_PER_PAGE)}</span>}
				</div>
			)}

			{done.size > 0 && !job && (
				<p className={s.summary} role="status">
					<Icon name="check" size={14} />
					OCR read {plural(done.size, "page")}
					{counts.added + counts.replaced + counts.differs > 0
						? ` · ${[
								counts.added && `${plural(counts.added, "line")} added`,
								counts.replaced && `${counts.replaced} replaced`,
								counts.differs && `${counts.differs} to compare`,
							]
								.filter(Boolean)
								.join(" · ")}, listed under Review`
						: allScans || counts.pages
							? ""
							: " · it matched the text already there"}
				</p>
			)}
			{message && <Note tone={message.tone}>{message.text}</Note>}
		</section>
	);
}

/** What OCR changed, from the review flags of the current conversion. */
function ocrCounts(flags: Flag[]) {
	const c = { added: 0, replaced: 0, differs: 0, pages: 0 };
	for (const f of flags)
		if (f.kind === "ocr-added") c.added++;
		else if (f.kind === "ocr-replaced") c.replaced++;
		else if (f.kind === "ocr-differs") c.differs++;
		else if (f.kind === "ocr-page") c.pages++;
	return c;
}
