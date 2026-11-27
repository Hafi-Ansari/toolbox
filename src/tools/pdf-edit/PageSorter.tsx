import type { Remote } from "comlink";
import { type MouseEvent, type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { detectFile } from "../../lib/detect.ts";
import { Button, Note, Pills, Progress } from "../../lib/ui.tsx";
import type { EditApi } from "./edit.worker.ts";
import type { Asset } from "./images.ts";
import type { Item } from "./items.ts";
import { Password } from "./Password.tsx";
import s from "./PdfEdit.module.css";
import {
	deletePages,
	duplicatePages,
	everyPages,
	movePages,
	nudgePages,
	type PageRef,
	parseRanges,
	rotatePages,
	type Snapshot,
	type Source,
} from "./pages.ts";
import { pageKey, type RenderPage, usePageImage } from "./render.ts";
import { groupItems, PageArt, PageFace, SourceBadge, sourceColor, useNearViewport } from "./Thumbs.tsx";

export type SplitOutput = "zip" | "files";

interface Drag {
	pointer: number;
	ids: Set<string>;
	origin: [number, number];
	active: boolean;
	slot: number | null;
	moved: [number, number];
}

function Card({
	page,
	number,
	source,
	showSource,
	items,
	selected,
	dragging,
	drop,
	offset,
	render,
	assets,
	choose,
	toggle,
	open,
	startDrag,
	moveDrag,
	endDrag,
}: {
	page: PageRef;
	number: number;
	source: Source;
	showSource: boolean;
	items: Item[];
	selected: boolean;
	dragging: boolean;
	drop?: "before" | "after";
	offset?: [number, number];
	render: RenderPage;
	assets: Record<string, Asset>;
	choose: (e: MouseEvent) => void;
	toggle: () => void;
	open: () => void;
	startDrag: (e: PointerEvent<HTMLElement>) => void;
	moveDrag: (e: PointerEvent<HTMLElement>) => void;
	endDrag: (e: PointerEvent<HTMLElement>, cancelled?: boolean) => void;
}) {
	const [target, visible] = useNearViewport<HTMLLIElement>();
	const size = source.pages[page.index];
	const image = usePageImage(render, pageKey(page), visible ? 120 : 0, Math.min(2, window.devicePixelRatio || 1));
	const pointer = {
		onPointerDown: startDrag,
		onPointerMove: moveDrag,
		onPointerUp: endDrag,
		onPointerCancel: (e: PointerEvent<HTMLElement>) => endDrag(e, true),
	};
	return (
		<li
			ref={target}
			className={s.card}
			data-page-card={page.id}
			data-selected={selected || undefined}
			data-dragging={dragging || undefined}
			data-drop={drop}
			style={offset ? { transform: `translate(${offset[0]}px, ${offset[1]}px)` } : undefined}
		>
			<button
				type="button"
				className={s.cardFace}
				aria-label={`Page ${number}${showSource ? `, from ${source.name}` : ""}${page.rotate ? `, turned ${page.rotate}°` : ""}`}
				aria-pressed={selected}
				onClick={choose}
				onDoubleClick={open}
				{...pointer}
			>
				<PageFace size={size} rotate={page.rotate}>
					<PageArt image={image} items={items} size={size} assets={assets} />
				</PageFace>
				{showSource && <span className={s.cardStripe} style={{ background: sourceColor(source.id) }} />}
			</button>
			<div className={s.cardFoot}>
				<label className={s.cardCheck}>
					<input type="checkbox" checked={selected} onChange={toggle} aria-label={`Select page ${number}`} />
					{number}
				</label>
				{showSource && <SourceBadge source={source} />}
				{items.length > 0 && (
					<small title={`${items.length} ${items.length === 1 ? "edit" : "edits"}`}>✎{items.length}</small>
				)}
				<span className={s.grip} aria-hidden="true" data-grip title="Drag to move" {...pointer}>
					⠿
				</span>
			</div>
		</li>
	);
}

export function PageSorter({
	api,
	state,
	sources,
	selected,
	setSelected,
	change,
	addSource,
	open,
	render,
	assets,
	busy,
	exportPages,
	canMerge,
	children,
}: {
	api: Remote<EditApi>;
	state: Snapshot;
	sources: Source[];
	selected: ReadonlySet<string>;
	setSelected: (ids: Set<string>) => void;
	change: (update: (state: Snapshot) => Snapshot) => void;
	addSource: (source: Source, after: number) => void;
	open: (id: string) => void;
	render: RenderPage;
	assets: Record<string, Asset>;
	busy: boolean;
	exportPages: (groups: number[][], output: SplitOutput) => void;
	canMerge: boolean;
	/** The download panel, shown last in the side column. */
	children?: ReactNode;
}) {
	const { pages } = state;
	const [drag, setDrag] = useState<Drag | null>(null);
	const dragRef = useRef<Drag | null>(null);
	const clickBlock = useRef(false);
	const anchor = useRef<string | null>(null);
	const scroll = useRef<{ y: number; timer: number } | null>(null);
	const picker = useRef<HTMLInputElement>(null);
	const [insert, setInsert] = useState("end");
	const [adding, setAdding] = useState<{ file: File; rest: File[]; after: number; previous: boolean } | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [split, setSplit] = useState<"ranges" | "every">("ranges");
	const [ranges, setRanges] = useState("");
	const [every, setEvery] = useState("1");
	const [output, setOutput] = useState<SplitOutput>("zip");
	const byPage = groupItems(state.items);
	const chosen = new Set(pages.filter(({ id }) => selected.has(id)).map(({ id }) => id));
	const count = chosen.size;
	const many = sources.length > 1;

	useEffect(
		() => () => {
			if (scroll.current) clearInterval(scroll.current.timer);
		},
		[],
	);

	function apply(update: (state: Snapshot) => Snapshot) {
		setError("");
		change(update);
	}

	/** Page-order changes; a change that leaves the order as it was adds no undo step. */
	function applyPages(update: (pages: PageRef[]) => PageRef[]) {
		apply((state) => {
			const next = update(state.pages);
			return next === state.pages ? state : { ...state, pages: next };
		});
	}

	function choose(e: MouseEvent, id: string) {
		if (clickBlock.current) {
			clickBlock.current = false;
			return;
		}
		const next = new Set(chosen);
		if (e.shiftKey && anchor.current) {
			const from = pages.findIndex((page) => page.id === anchor.current);
			const to = pages.findIndex((page) => page.id === id);
			for (const page of pages.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(page.id);
		} else if (e.ctrlKey || e.metaKey) {
			if (next.has(id)) next.delete(id);
			else next.add(id);
			anchor.current = id;
		} else {
			next.clear();
			next.add(id);
			anchor.current = id;
		}
		setSelected(next);
	}

	function toggle(id: string) {
		const next = new Set(chosen);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		anchor.current = id;
		setSelected(next);
	}

	function slotAt(x: number, y: number, current: number | null): number | null {
		const card = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-page-card]");
		const id = card?.dataset.pageCard;
		const index = id ? pages.findIndex((page) => page.id === id) : -1;
		if (!card || index < 0) return current;
		const box = card.getBoundingClientRect();
		return x < box.left + box.width / 2 ? index : index + 1;
	}

	function stopScroll() {
		if (scroll.current) clearInterval(scroll.current.timer);
		scroll.current = null;
	}

	function autoScroll(y: number) {
		const edge = 56;
		const speed = y < edge ? -14 : y > window.innerHeight - edge ? 14 : 0;
		if (!speed) return stopScroll();
		if (scroll.current) {
			scroll.current.y = speed;
			return;
		}
		scroll.current = { y: speed, timer: window.setInterval(() => window.scrollBy(0, scroll.current?.y ?? 0), 16) };
	}

	function startDrag(e: PointerEvent<HTMLElement>, id: string) {
		if (!e.isPrimary || e.button !== 0 || dragRef.current || busy) return;
		const fromGrip = e.target instanceof Element && Boolean(e.target.closest("[data-grip]"));
		// Fingers drag by the grip only, so the page list still scrolls.
		if (e.pointerType === "touch" && !fromGrip) return;
		const ids = chosen.has(id) ? new Set(chosen) : new Set([id]);
		const next: Drag = {
			pointer: e.pointerId,
			ids,
			origin: [e.clientX, e.clientY],
			active: fromGrip,
			slot: null,
			moved: [0, 0],
		};
		dragRef.current = next;
		if (fromGrip) {
			if (!chosen.has(id)) setSelected(new Set([id]));
			setDrag(next);
			e.preventDefault();
		}
		try {
			e.currentTarget.setPointerCapture(e.pointerId);
		} catch {
			// Synthetic or already released pointers cannot be captured; moves still arrive on the target.
		}
	}

	function moveDrag(e: PointerEvent<HTMLElement>) {
		const current = dragRef.current;
		if (!current || current.pointer !== e.pointerId) return;
		const moved: [number, number] = [e.clientX - current.origin[0], e.clientY - current.origin[1]];
		if (!current.active && Math.hypot(...moved) < 6) return;
		const next = { ...current, active: true, moved, slot: slotAt(e.clientX, e.clientY, current.slot) };
		dragRef.current = next;
		setDrag(next);
		autoScroll(e.clientY);
	}

	function endDrag(e: PointerEvent<HTMLElement>, cancelled = false) {
		const current = dragRef.current;
		if (!current || current.pointer !== e.pointerId) return;
		dragRef.current = null;
		stopScroll();
		setDrag(null);
		if (!current.active) return;
		clickBlock.current = e.pointerType !== "touch";
		setTimeout(() => {
			clickBlock.current = false;
		}, 0);
		const slot = cancelled ? null : slotAt(e.clientX, e.clientY, current.slot);
		if (slot !== null) applyPages((pages) => movePages(pages, current.ids, slot));
	}

	async function addFiles(files: File[], after: number) {
		const [file, ...rest] = files;
		if (!file) {
			setAdding(null);
			return;
		}
		await addFile(file, rest, after);
	}

	async function addFile(file: File, rest: File[], after: number, password?: string) {
		setLoading(true);
		setError("");
		try {
			if (password === undefined && (await detectFile(file)) !== "pdf") throw new Error(`${file.name} is not a PDF.`);
			const result = await api.addSource(file, password);
			if (!result) {
				setAdding({ file, rest, after, previous: password !== undefined });
				return;
			}
			setAdding(null);
			addSource({ id: result.id, name: file.name, pages: result.pages }, after);
			await addFiles(rest, after >= Number.MAX_SAFE_INTEGER ? after : after + result.pages.length);
		} catch (cause) {
			setAdding(null);
			setError(cause instanceof Error ? cause.message : `${file.name} could not be opened.`);
		} finally {
			setLoading(false);
		}
	}

	function startSplit() {
		setError("");
		try {
			const groups = split === "ranges" ? parseRanges(ranges, pages.length) : everyPages(pages.length, Number(every));
			exportPages(groups, groups.length > 1 ? output : "files");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	const dropSlot = drag?.active ? drag.slot : null;
	const afterIndex = insert === "end" ? Number.MAX_SAFE_INTEGER : insert === "start" ? -1 : Number(insert);
	return (
		<div className={s.sorterLayout}>
			<section className={s.sorter} aria-label="Page sorter">
				<div className={s.sorterBar} role="toolbar" aria-label="Page actions">
					<span className={s.sorterCount} role="status">
						{count ? `${count} of ${pages.length} selected` : `${pages.length} pages`}
					</span>
					<button type="button" onClick={() => setSelected(new Set(pages.map(({ id }) => id)))}>
						Select all
					</button>
					<button type="button" disabled={!count} onClick={() => setSelected(new Set())}>
						Clear
					</button>
					<span className={s.sorterGap} />
					<button type="button" disabled={!count} onClick={() => applyPages((pages) => nudgePages(pages, chosen, -1))}>
						Move left
					</button>
					<button type="button" disabled={!count} onClick={() => applyPages((pages) => nudgePages(pages, chosen, 1))}>
						Move right
					</button>
					<button
						type="button"
						disabled={!count}
						onClick={() => applyPages((pages) => rotatePages(pages, chosen, -90))}
					>
						Rotate left
					</button>
					<button type="button" disabled={!count} onClick={() => applyPages((pages) => rotatePages(pages, chosen, 90))}>
						Rotate right
					</button>
					<button
						type="button"
						disabled={!count}
						onClick={() => apply((state) => duplicatePages(state, chosen, () => crypto.randomUUID()))}
					>
						Duplicate
					</button>
					<button
						type="button"
						disabled={!count || count === pages.length}
						title={count === pages.length ? "A PDF needs at least one page." : undefined}
						onClick={() => {
							apply((state) => deletePages(state, chosen));
							setSelected(new Set());
						}}
					>
						Delete
					</button>
				</div>
				<ol className={s.sorterGrid} aria-label="Pages in order">
					{pages.map((page, i) => (
						<Card
							key={page.id}
							page={page}
							number={i + 1}
							source={sources[page.source]}
							showSource={many}
							items={byPage.get(page.id) ?? []}
							selected={chosen.has(page.id)}
							dragging={Boolean(drag?.active && drag.ids.has(page.id))}
							offset={drag?.active && drag.ids.has(page.id) ? drag.moved : undefined}
							drop={dropSlot === i ? "before" : dropSlot === i + 1 && i === pages.length - 1 ? "after" : undefined}
							render={render}
							assets={assets}
							choose={(e) => choose(e, page.id)}
							toggle={() => toggle(page.id)}
							open={() => open(page.id)}
							startDrag={(e) => startDrag(e, page.id)}
							moveDrag={moveDrag}
							endDrag={endDrag}
						/>
					))}
				</ol>
				<p className={s.sorterHint}>
					Drag pages to reorder them (on a touch screen, drag the ⠿ handle), or select pages and use Move left / Move
					right. Double-click a page to edit it.
				</p>
			</section>
			<aside className={s.sorterSide}>
				{canMerge && (
					<section className={s.sidePanel} aria-label="Merge PDFs">
						<h2>Merge</h2>
						<label className={s.sideField}>
							Insert pages
							<select value={insert} onChange={(e) => setInsert(e.target.value)} disabled={loading}>
								<option value="end">At the end</option>
								<option value="start">At the start</option>
								{pages.map((page, i) => (
									<option key={page.id} value={i}>
										After page {i + 1}
									</option>
								))}
							</select>
						</label>
						<Button icon="upload" variant="ghost" disabled={loading || busy} onClick={() => picker.current?.click()}>
							Add PDFs
						</Button>
						<input
							ref={picker}
							type="file"
							accept=".pdf,application/pdf"
							multiple
							hidden
							aria-label="PDFs to merge"
							onChange={(e) => {
								const files = [...(e.target.files ?? [])];
								e.target.value = "";
								void addFiles(files, afterIndex);
							}}
						/>
						{loading && <Progress value={0} max={0} label="Opening PDF…" />}
						{adding && (
							<>
								<Note tone="info">{adding.file.name} is protected with a password.</Note>
								<Password
									file={adding.file}
									previous={adding.previous}
									label={`Password for ${adding.file.name}`}
									open={(file, password) => void addFile(file, adding.rest, adding.after, password)}
								/>
							</>
						)}
						{many && (
							<ul className={s.sourceList} aria-label="Files">
								{sources.map((source) => (
									<li key={source.id}>
										<SourceBadge source={source} /> <span>{source.name}</span>
										<small>
											{source.pages.length} {source.pages.length === 1 ? "page" : "pages"},{" "}
											{pages.filter((page) => page.source === source.id).length} in use
										</small>
									</li>
								))}
							</ul>
						)}
					</section>
				)}
				<section className={s.sidePanel} aria-label="Split or extract">
					<h2>Split or extract</h2>
					<Button
						icon="download"
						variant="ghost"
						disabled={!count || busy}
						onClick={() => exportPages([pages.flatMap((page, i) => (chosen.has(page.id) ? [i] : []))], "files")}
					>
						{count ? `Extract ${count} selected ${count === 1 ? "page" : "pages"}` : "Extract selected pages"}
					</Button>
					<Pills
						label="Split by"
						value={split}
						onChange={setSplit}
						options={[
							{ value: "ranges", label: "Page ranges" },
							{ value: "every", label: "Every N pages" },
						]}
					/>
					{split === "ranges" ? (
						<label className={s.sideField}>
							Ranges
							<input
								type="text"
								inputMode="text"
								placeholder={`1-3, 4-${pages.length}`}
								value={ranges}
								onChange={(e) => setRanges(e.target.value)}
							/>
						</label>
					) : (
						<label className={s.sideField}>
							Pages per file
							<input
								type="number"
								min={1}
								max={pages.length}
								value={every}
								onChange={(e) => setEvery(e.target.value)}
							/>
						</label>
					)}
					<Pills
						label="Save several files as"
						value={output}
						onChange={setOutput}
						options={[
							{ value: "zip", label: "One .zip" },
							{ value: "files", label: "Separate PDFs" },
						]}
					/>
					<Button icon="download" variant="ghost" disabled={busy} onClick={startSplit}>
						Split PDF
					</Button>
					{error && <Note tone="danger">{error}</Note>}
				</section>
				{children}
			</aside>
		</div>
	);
}
