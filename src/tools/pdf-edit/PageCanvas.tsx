import {
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Artwork, boxStyle, describeItem, StrokeArt } from "./Artwork.tsx";
import { SANS } from "./fonts.ts";
import type { Point } from "./geometry.ts";
import type { Asset } from "./images.ts";
import {
	clamp,
	hitStroke,
	type Item,
	moveBy,
	type PageSize,
	resizeTo,
	TEXT_LEADING,
	TEXT_PADDING,
	type TextItem,
	type Tool,
} from "./items.ts";
import s from "./PdfEdit.module.css";
import { shownSize, unrotateFraction } from "./pages.ts";
import { type PageKey, type RenderPage, usePageImage } from "./render.ts";

type Drag =
	| { id: number; kind: "place"; point: Point }
	| { id: number; kind: "draw"; points: Point[] }
	| { id: number; kind: "erase"; erased: Set<string> }
	| { id: number; kind: "move" | "resize"; origin: Point; item: Item };

export interface TextDraft {
	item: TextItem;
	newItem: boolean;
}

interface Props {
	page: PageSize;
	/** Rotation added in the editor; the sheet is turned and pointer input is mapped back. */
	rotate: number;
	pageKey: PageKey;
	/** 1-based position in the document, for labels. */
	number: number;
	/** Drawn above the page image and below the items (form field highlights). */
	children?: ReactNode;
	zoom: number;
	items: Item[];
	assets: Record<string, Asset>;
	render: RenderPage;
	tool: Tool;
	color: string;
	strokeWidth: number;
	selected: string | null;
	draft: TextDraft | null;
	select: (id: string | null) => void;
	place: (point: Point) => void;
	draw: (points: Point[]) => void;
	erase: (set: Set<string>) => void;
	change: (item: Item) => void;
	remove: (id: string) => void;
	edit: (item: TextItem) => void;
	typeText: (value: string) => void;
	finishText: (save: boolean) => void;
}

function DraftText({
	draft,
	page,
	scale,
	typeText,
	finishText,
}: Pick<Props, "page" | "typeText" | "finishText"> & { draft: TextDraft; scale: number }) {
	const field = useRef<HTMLTextAreaElement>(null);
	const { item } = draft;
	const cssSize = item.size * scale;
	// Keep the computed font at 16px so iOS does not zoom the viewport on focus.
	const fontSize = Math.max(16, cssSize);
	const factor = cssSize / fontSize || 1;
	useLayoutEffect(() => {
		const area = field.current;
		if (!area) return;
		area.focus({ preventScroll: true });
		area.setSelectionRange(area.value.length, area.value.length);
	}, []);
	return (
		<div className={s.draft} style={boxStyle(item, page)}>
			<textarea
				aria-label="Edit text"
				ref={field}
				value={item.text}
				onChange={(e) => typeText(e.target.value)}
				onBlur={() => finishText(true)}
				onKeyDown={(e) => {
					if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
						e.preventDefault();
						e.stopPropagation();
						finishText(e.key !== "Escape");
					}
				}}
				style={{
					width: `${100 / factor}%`,
					height: `${100 / factor}%`,
					transform: `scale(${factor})`,
					fontFamily: SANS,
					fontSize,
					lineHeight: TEXT_LEADING,
					padding: (TEXT_PADDING * scale) / factor,
					color: item.color,
				}}
			/>
		</div>
	);
}

export function PageCanvas(p: Props) {
	const { page, rotate, number, items, assets, tool, selected, draft } = p;
	const frame = useRef<HTMLDivElement>(null);
	const drag = useRef<Drag | null>(null);
	const [fit, setFit] = useState({ width: 0, dpr: 1 });
	const [ghost, setGhost] = useState<Item | null>(null);
	const [ink, setInk] = useState<Point[]>([]);
	const [erased, setErased] = useState<Set<string>>(new Set());
	const shown = shownSize(page, rotate);
	const width = Math.floor(fit.width * p.zoom);
	const scale = width / shown.w;
	const image = usePageImage(p.render, p.pageKey, Math.round(page.w * scale), fit.dpr);

	useLayoutEffect(() => {
		const element = frame.current;
		if (!element) return;
		const update = () => {
			const style = getComputedStyle(element);
			const width = element.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
			setFit({ width: clamp(width, 0, 830), dpr: window.devicePixelRatio || 1 });
		};
		const observer = new ResizeObserver(update);
		observer.observe(element);
		window.addEventListener("resize", update);
		update();
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", update);
		};
	}, []);

	useEffect(() => {
		const holder = frame.current;
		holder?.scrollTo(0, 0);
	}, []);

	function point(e: PointerEvent<HTMLDivElement>): Point {
		// The bounding box of a turned sheet is its shown box; map the fraction back onto the page.
		const box = e.currentTarget.getBoundingClientRect();
		const [u, v] = unrotateFraction([(e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height], rotate);
		return [clamp(u * page.w, 0, page.w), clamp(v * page.h, 0, page.h)];
	}

	function erasures(previous: Set<string>, at: Point) {
		const next = new Set(previous);
		for (const item of items) if (hitStroke(item, at, Math.max(4, 12 / scale))) next.add(item.id);
		return next;
	}

	function start(e: PointerEvent<HTMLDivElement>) {
		if (
			!e.isPrimary ||
			e.button !== 0 ||
			!scale ||
			drag.current ||
			!(e.target instanceof Element) ||
			e.target.closest("textarea")
		)
			return;
		const at = point(e);
		if (tool === "draw") {
			drag.current = { id: e.pointerId, kind: "draw", points: [at] };
			setInk([at]);
		} else if (tool === "erase") {
			const remove = erasures(new Set(), at);
			drag.current = { id: e.pointerId, kind: "erase", erased: remove };
			setErased(remove);
		} else if (tool === "select") {
			const button = e.target.closest<HTMLButtonElement>("[data-edit-item]");
			const item = items.find(({ id }) => id === button?.dataset.editItem);
			if (!item) {
				p.select(null);
				return;
			}
			p.select(item.id);
			if (button?.dataset.resize !== "true") button?.focus({ preventScroll: true });
			drag.current = { id: e.pointerId, kind: button?.dataset.resize === "true" ? "resize" : "move", item, origin: at };
		} else {
			drag.current = { id: e.pointerId, kind: "place", point: at };
			e.currentTarget.setPointerCapture(e.pointerId);
			return;
		}
		if (e.pointerType === "mouse") e.preventDefault();
		// The surface owns the gesture, including a finger or pointer leaving the item.
		e.currentTarget.setPointerCapture(e.pointerId);
	}

	function moved(active: Extract<Drag, { kind: "move" | "resize" }>, at: Point) {
		const { item, origin } = active;
		const dx = at[0] - origin[0];
		const dy = at[1] - origin[1];
		if (active.kind === "move") return moveBy(item, dx, dy, page);
		return resizeTo(
			item,
			item.w + (item.kind !== "text" && Math.abs(dy) > Math.abs(dx) ? (dy * item.w) / item.h : dx),
			page,
		);
	}

	function move(e: PointerEvent<HTMLDivElement>) {
		const active = drag.current;
		if (!active || active.id !== e.pointerId) return;
		const at = point(e);
		if (active.kind === "draw") {
			active.points.push(at);
			setInk([...active.points]);
		} else if (active.kind === "erase") {
			active.erased = erasures(active.erased, at);
			setErased(active.erased);
		} else if (active.kind !== "place") setGhost(moved(active, at));
	}

	function finish(e: PointerEvent<HTMLDivElement>, cancelled = false) {
		const active = drag.current;
		if (!active || active.id !== e.pointerId) return;
		drag.current = null;
		setGhost(null);
		setInk([]);
		setErased(new Set());
		if (cancelled) return;
		const at = point(e);
		if (active.kind === "draw") {
			const previous = active.points.at(-1);
			if (previous && Math.hypot(previous[0] - at[0], previous[1] - at[1]) > 0.1) active.points.push(at);
			p.draw(active.points);
		} else if (active.kind === "erase") {
			p.erase(erasures(active.erased, at));
		} else if (active.kind === "place") {
			if (Math.hypot(at[0] - active.point[0], at[1] - active.point[1]) * scale < 9) p.place(at);
		} else {
			const next = moved(active, at);
			if (next.x !== active.item.x || next.y !== active.item.y || next.w !== active.item.w || next.h !== active.item.h)
				p.change(next);
		}
	}

	function keyItem(e: KeyboardEvent<HTMLButtonElement>, item: Item) {
		const amount = e.shiftKey ? 10 : 1;
		const arrows: Record<string, Point> = {
			ArrowLeft: [-amount, 0],
			ArrowRight: [amount, 0],
			ArrowUp: [0, -amount],
			ArrowDown: [0, amount],
		};
		if (arrows[e.key]) p.change(moveBy(item, ...arrows[e.key], page));
		else if (e.key === "Delete" || e.key === "Backspace") p.remove(item.id);
		else if (e.key === "+" || e.key === "=" || e.key === "-")
			p.change(resizeTo(item, item.w + (e.key === "-" ? -5 : 5), page));
		else if (e.key === "Enter" && item.kind === "text") p.edit(item);
		else return;
		e.preventDefault();
	}

	return (
		<div className={s.frame} ref={frame}>
			<div className={s.turn} style={{ width: width || undefined, aspectRatio: `${shown.w} / ${shown.h}` }}>
				<div
					className={s.sheet}
					data-tool={tool}
					data-testid="pdf-edit-page"
					aria-busy={!image}
					style={
						rotate
							? {
									width: page.w * scale,
									height: page.h * scale,
									left: "50%",
									top: "50%",
									transform: `translate(-50%, -50%) rotate(${rotate}deg)`,
								}
							: undefined
					}
					onPointerDown={start}
					onPointerMove={move}
					onPointerUp={finish}
					onPointerCancel={(e) => finish(e, true)}
					onLostPointerCapture={(e) => finish(e, true)}
				>
					{image?.url && <img className={s.paper} src={image.url} alt={`Page ${number}`} draggable={false} />}
					{image?.failed && <p className={s.renderError}>This page could not be drawn.</p>}
					{p.children}
					{items.map((saved) => {
						if (erased.has(saved.id) || saved.id === draft?.item.id) return null;
						const item = ghost?.id === saved.id ? ghost : saved;
						const focus = selected === item.id && tool === "select";
						return (
							<div key={item.id} className={s.item} style={boxStyle(item, page)} data-selected={focus || undefined}>
								<button
									type="button"
									className={s.cover}
									data-edit-item={item.id}
									aria-label={describeItem(item, number)}
									tabIndex={tool === "select" ? 0 : -1}
									onClick={(e) => {
										if (e.detail === 0) p.select(item.id);
									}}
									onFocus={() => {
										if (tool === "select") p.select(item.id);
									}}
									onDoubleClick={() => {
										if (tool === "select" && item.kind === "text") p.edit(item);
									}}
									onKeyDown={(e) => keyItem(e, item)}
								>
									<Artwork item={item} assets={assets} />
								</button>
								{focus && (
									<button
										type="button"
										data-edit-item={item.id}
										data-resize="true"
										className={s.resize}
										aria-label={`Resize ${describeItem(item, number)}`}
										tabIndex={-1}
									/>
								)}
							</div>
						);
					})}
					{ink.length > 0 && (
						<svg aria-hidden="true" className={s.drawing} viewBox={`0 0 ${page.w} ${page.h}`}>
							<StrokeArt
								strokes={[ink.map(([x, y]) => [x / page.w, y / page.h])]}
								w={page.w}
								h={page.h}
								color={p.color}
								width={p.strokeWidth}
							/>
						</svg>
					)}
					{draft && (
						<DraftText draft={draft} page={page} scale={scale} typeText={p.typeText} finishText={p.finishText} />
					)}
				</div>
			</div>
		</div>
	);
}
