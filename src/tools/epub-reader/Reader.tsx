import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../lib/Icon.tsx";
import { Pills } from "../../lib/ui.tsx";
import { type Book, chapterTitle, flattenToc } from "./book.ts";
import { type Position, savePosition } from "./library.ts";
import * as P from "./paginate.ts";
import s from "./Reader.module.css";
import { type Geometry, readerCss } from "./readerCss.ts";
import { type Chapter, Resources, renderChapter } from "./render.ts";
import {
	type FontChoice,
	loadSettings,
	MEASURE_EM,
	type ReaderSettings,
	SIZE_MAX,
	SIZE_MIN,
	saveSettings,
	THEMES,
	type Theme,
	type Width,
} from "./settings.ts";

const PLACEHOLDER = "/*READER_CSS*/";

interface Target {
	anchor?: P.Anchor | null;
	fraction?: number;
	fragment?: string;
	end?: boolean;
}

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/** Waits for web fonts so page counts are final, but never longer than `ms`. */
async function settle(doc: Document, ms = 800) {
	await Promise.race([doc.fonts?.ready, new Promise((r) => setTimeout(r, ms))]);
	await nextFrame();
}

export function Reader({
	book,
	entryId,
	initial,
	onClose,
}: {
	book: Book;
	/** Library id to save the position under, or null when the library is unavailable. */
	entryId: string | null;
	initial?: Position;
	onClose: () => void;
}) {
	const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
	// Right-to-left books read best in scroll mode (columns would flow the other way).
	const effective = useMemo<ReaderSettings>(
		() => (book.rtl ? { ...settings, mode: "scroll" } : settings),
		[book, settings],
	);

	const [spine, setSpine] = useState(initial?.spine ?? 0);
	const [view, setView] = useState({ page: 0, pages: 1, fraction: 0 });
	const [bars, setBars] = useState(true);
	const [panel, setPanel] = useState<null | "toc" | "settings">(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const stageRef = useRef<HTMLDivElement>(null);
	const frameRef = useRef<HTMLIFrameElement>(null);
	const geom = useRef<Geometry>({ width: 0, height: 0, padX: 0, padY: 0 });
	const applied = useRef<ReaderSettings>(effective);
	const settingsRef = useRef(effective);
	settingsRef.current = effective;
	const spineRef = useRef(spine);
	const panelRef = useRef(panel);
	panelRef.current = panel;
	const token = useRef(0);
	const busy = useRef(false);
	const queued = useRef<0 | 1 | -1>(0);
	const chapters = useRef(new Map<number, Promise<Chapter>>());
	const resources = useMemo(() => new Resources(book), [book]);

	const toc = useMemo(() => flattenToc(book.toc), [book]);
	const before = useMemo(() => {
		const sums = [0];
		for (const item of book.spine) sums.push(sums[sums.length - 1] + item.size);
		return sums;
	}, [book]);
	const percentAt = useCallback(
		(i: number, fraction: number) =>
			book.totalSize > 0 ? (before[i] + fraction * book.spine[i].size) / book.totalSize : i / book.spine.length,
		[book, before],
	);

	/* ---------- Position saving (debounced) */

	const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const pending = useRef<Position | null>(null);
	const flush = useCallback(() => {
		clearTimeout(saveTimer.current);
		if (entryId && pending.current) void savePosition(entryId, pending.current);
		pending.current = null;
	}, [entryId]);
	const scheduleSave = useCallback(
		(pos: Position) => {
			pending.current = pos;
			clearTimeout(saveTimer.current);
			saveTimer.current = setTimeout(flush, 700);
		},
		[flush],
	);

	/* ---------- Chapters */

	const getChapter = useCallback(
		(i: number) => {
			let p = chapters.current.get(i);
			if (!p) {
				p = renderChapter(book, i, resources, PLACEHOLDER);
				chapters.current.set(i, p);
				p.catch(() => chapters.current.delete(i));
			}
			return p;
		},
		[book, resources],
	);

	const evict = useCallback((keep: number) => {
		for (const [i, p] of chapters.current) {
			if (Math.abs(i - keep) <= 1) continue;
			chapters.current.delete(i);
			void p.then((c) => {
				for (const u of c.urls) URL.revokeObjectURL(u);
			});
		}
	}, []);

	const frameDoc = useCallback(() => frameRef.current?.contentDocument ?? null, []);

	/** Page geometry for a chapter, and the iframe's box within the stage. */
	const layoutFrame = useCallback(
		(i: number, chapter: Chapter): Geometry => {
			const stage = stageRef.current;
			const frame = frameRef.current;
			if (!stage || !frame) return geom.current;
			const sw = stage.clientWidth;
			const sh = stage.clientHeight;
			const st = settingsRef.current;
			let g: Geometry;
			let scale = 1;
			if (book.spine[i].fixed) {
				// Scale the page to fit between the top bar and the progress readout.
				const top = 52;
				const bottom = 40;
				const vp = chapter.viewport ?? { width: sw, height: sh - top - bottom };
				g = { width: vp.width, height: vp.height, padX: 0, padY: 0 };
				scale = Math.min((sw - 16) / vp.width, (sh - top - bottom) / vp.height);
				frame.style.width = `${g.width}px`;
				frame.style.height = `${g.height}px`;
				frame.style.left = `${Math.round((sw - g.width * scale) / 2)}px`;
				frame.style.top = `${Math.round(top + (sh - top - bottom - g.height * scale) / 2)}px`;
				frame.style.transform = `scale(${scale})`;
				return g;
			} else {
				const padY = sh < 640 ? 40 : 56;
				const padX = sw < 640 ? 22 : 40;
				const measure = MEASURE_EM[st.width] * st.size;
				g = { width: Math.floor(Math.min(sw, measure + 2 * padX)), height: sh, padX, padY };
			}
			frame.style.width = `${g.width}px`;
			frame.style.height = `${g.height}px`;
			frame.style.left = `${Math.round((sw - g.width * scale) / 2)}px`;
			frame.style.top = `${Math.round((sh - g.height * scale) / 2)}px`;
			frame.style.transform = scale === 1 ? "" : `scale(${scale})`;
			return g;
		},
		[book],
	);

	/* ---------- View state */

	const update = useCallback(() => {
		const doc = frameDoc();
		const i = spineRef.current;
		if (!doc) return;
		const g = geom.current;
		const st = applied.current;
		if (book.spine[i].fixed) {
			setView({ page: 0, pages: 1, fraction: 0 });
			scheduleSave({ spine: i, anchor: null, fraction: 0, percent: percentAt(i, 0) });
			return;
		}
		const paged = st.mode === "paged";
		const fraction = P.chapterFraction(doc, st.mode, g);
		setView({ page: paged ? P.currentPage(doc, g) : 0, pages: paged ? P.pageCount(doc, g) : 1, fraction });
		scheduleSave({ spine: i, anchor: P.captureAnchor(doc, g), fraction, percent: percentAt(i, fraction) });
	}, [book, percentAt, scheduleSave, frameDoc]);

	// Refs it touches (sticky, moves) are declared further down; they're only read when it runs.
	const moved = useCallback(() => {
		sticky.current = null;
		moves.current++;
	}, []);

	const place = useCallback((doc: Document, t: Target) => {
		if (!t.anchor) sticky.current = null;
		const g = geom.current;
		const mode = applied.current.mode;
		if (t.fragment && P.goTo(doc, t.fragment, mode, g)) return;
		if (t.anchor && P.goTo(doc, t.anchor, mode, g)) return;
		if (t.end) P.goToFraction(doc, 1, mode, g);
		else P.goToFraction(doc, t.fraction ?? 0, mode, g);
	}, []);

	/* ---------- Input inside the book (wired on every chapter load) */

	const handlers = useRef({
		next: () => {},
		prev: () => {},
		key: (_e: KeyboardEvent) => {},
		poke: () => {},
		toggleBars: () => {},
		follow: (_a: Element) => {},
		scrolled: () => {},
		relayout: async () => {},
	});

	const attach = useCallback((doc: Document) => {
		const h = handlers.current;
		let swiped = false;
		let touch: { x: number; y: number } | null = null;
		let lastWheel = 0;
		doc.addEventListener("keydown", (e) => h.key(e));
		doc.addEventListener("mousemove", () => h.poke(), { passive: true });
		doc.addEventListener(
			"scroll",
			() => {
				if (applied.current.mode === "scroll") h.scrolled();
			},
			{ passive: true },
		);
		doc.addEventListener(
			"wheel",
			(e) => {
				if (applied.current.mode !== "paged" || e.ctrlKey) return;
				e.preventDefault();
				const now = performance.now();
				if (now - lastWheel < 350 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 4) return;
				lastWheel = now;
				(e.deltaY || e.deltaX) > 0 ? h.next() : h.prev();
			},
			{ passive: false },
		);
		doc.addEventListener(
			"touchstart",
			(e) => {
				touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
			},
			{ passive: true },
		);
		doc.addEventListener(
			"touchend",
			(e) => {
				if (!touch) return;
				const dx = e.changedTouches[0].clientX - touch.x;
				const dy = e.changedTouches[0].clientY - touch.y;
				touch = null;
				if (applied.current.mode === "paged" && Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
					swiped = true;
					dx < 0 ? h.next() : h.prev();
				}
			},
			{ passive: true },
		);
		doc.addEventListener("click", (e) => {
			const link = (e.target as Element | null)?.closest?.("a");
			if (link) {
				e.preventDefault(); // the sandboxed frame must never navigate itself
				h.follow(link);
				return;
			}
			if (swiped) {
				swiped = false;
				return;
			}
			if (!doc.getSelection()?.isCollapsed) return; // selecting text, not tapping
			const w = doc.documentElement.clientWidth;
			const x = e.clientX / w;
			if (applied.current.mode === "paged" && x < 0.3) h.prev();
			else if (applied.current.mode === "paged" && x > 0.7) h.next();
			else h.toggleBars();
		});
	}, []);

	/* ---------- Loading a chapter */

	const display = useCallback(
		async (i: number, target: Target = {}) => {
			if (i < 0 || i >= book.spine.length) return;
			const my = ++token.current;
			busy.current = true;
			moved();
			const slow = setTimeout(() => my === token.current && setLoading(true), 120);
			try {
				const chapter = await getChapter(i);
				const frame = frameRef.current;
				if (my !== token.current || !frame) return;
				applied.current = settingsRef.current;
				const g = layoutFrame(i, chapter);
				geom.current = g;
				const css = readerCss(applied.current, g, book.spine[i].fixed);
				await new Promise<void>((resolve) => {
					frame.onload = () => resolve();
					frame.srcdoc = chapter.html.replace(PLACEHOLDER, () => css);
				});
				const doc = frame.contentDocument;
				if (my !== token.current || !doc) return;
				await nextFrame(); // first layout; web fonts may still be loading (refined below)
				if (my !== token.current) return;
				attach(doc);
				spineRef.current = i;
				setSpine(i);
				place(doc, target);
				update();
				setError(null);
				evict(i);
				void getChapter(i + 1).catch(() => {});
				if (i > 0) void getChapter(i - 1).catch(() => {});
			} catch (e) {
				if (my === token.current) setError(e instanceof Error ? e.message : String(e));
			} finally {
				clearTimeout(slow);
				if (my === token.current) {
					busy.current = false;
					setLoading(false);
				}
			}
			if (my !== token.current) return;
			// A page turn requested while loading runs now instead of being dropped.
			const turn = queued.current;
			queued.current = 0;
			if (turn) (turn > 0 ? handlers.current.next : handlers.current.prev)();
			// Once web fonts finish loading, re-paginate in place (keeps the reading position).
			const doc = frameRef.current?.contentDocument;
			if (doc && !book.spine[i].fixed) {
				await settle(doc);
				if (my === token.current) await handlers.current.relayout();
			}
		},
		[book, getChapter, layoutFrame, attach, place, update, evict, moved],
	);

	/**
	 * Re-applies geometry and styles in place (resize, settings), keeping the reading position.
	 * Runs one at a time: a request that arrives mid-run triggers one more pass afterwards, so
	 * rapid changes (A+ A+ A+) never capture an anchor from a half-finished layout.
	 */
	const relayoutState = useRef({ running: false, again: false });
	const sticky = useRef<P.Anchor | null>(null);
	/** Bumped whenever the reader moves, so a re-layout never pulls them back to an older spot. */
	const moves = useRef(0);
	const relayout = useCallback(async () => {
		const state = relayoutState.current;
		if (state.running) {
			state.again = true;
			return;
		}
		state.running = true;
		try {
			do {
				state.again = false;
				const doc = frameDoc();
				const i = spineRef.current;
				if (!doc || busy.current) return;
				const chapter = await chapters.current.get(i);
				if (!chapter || frameDoc() !== doc) return;
				const fixed = book.spine[i].fixed;
				// Reuse the anchor from the previous re-layout until the reader moves: otherwise each
				// change (A+ A+ A+) would re-anchor to whatever is now at the top and drift backwards.
				const seq = moves.current;
				const anchor = fixed ? null : (sticky.current ?? P.captureAnchor(doc, geom.current));
				sticky.current = anchor;
				const fraction = fixed ? 0 : P.chapterFraction(doc, applied.current.mode, geom.current);
				applied.current = settingsRef.current;
				const g = layoutFrame(i, chapter);
				geom.current = g;
				const style = doc.getElementById("reader-style");
				if (style) style.textContent = readerCss(applied.current, g, fixed);
				await nextFrame();
				if (!fixed && moves.current === seq) place(doc, { anchor, fraction });
				update();
				// Fonts at the new size may still be loading; re-place once they're ready.
				await settle(doc, 400);
				if (!fixed && !state.again && moves.current === seq && frameDoc() === doc) {
					place(doc, { anchor, fraction });
					update();
				}
			} while (state.again);
		} finally {
			state.running = false;
		}
	}, [book, layoutFrame, place, update, frameDoc]);

	/* ---------- Navigation */

	const next = useCallback(() => {
		const doc = frameDoc();
		const i = spineRef.current;
		if (busy.current) {
			queued.current = 1;
			return;
		}
		if (!doc) return;
		const g = geom.current;
		const mode = applied.current.mode;
		if (!book.spine[i].fixed && !P.atEnd(doc, mode, g)) {
			if (mode === "paged") P.showPage(doc, P.currentPage(doc, g) + 1, g);
			else P.scrollByScreen(doc, 1);
			moved();
			update();
		} else if (i < book.spine.length - 1) void display(i + 1, { fraction: 0 });
	}, [book, display, update, moved, frameDoc]);

	const prev = useCallback(() => {
		const doc = frameDoc();
		const i = spineRef.current;
		if (busy.current) {
			queued.current = -1;
			return;
		}
		if (!doc) return;
		const g = geom.current;
		const mode = applied.current.mode;
		if (!book.spine[i].fixed && !P.atStart(doc, mode, g)) {
			if (mode === "paged") P.showPage(doc, P.currentPage(doc, g) - 1, g);
			else P.scrollByScreen(doc, -1);
			moved();
			update();
		} else if (i > 0) void display(i - 1, { end: true });
	}, [book, display, update, frameDoc, moved]);

	const jump = useCallback(
		(i: number, fragment = "") => {
			setPanel(null);
			moved();
			const doc = frameDoc();
			if (i === spineRef.current && doc && fragment) {
				if (P.goTo(doc, fragment, applied.current.mode, geom.current)) return update();
			}
			void display(i, { fragment, fraction: 0 });
		},
		[display, update, moved, frameDoc],
	);

	/* ---------- Bars */

	const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const overBars = useRef(false);
	const poke = useCallback(() => {
		setBars(true);
		clearTimeout(hideTimer.current);
		hideTimer.current = setTimeout(() => {
			if (!panelRef.current && !overBars.current) setBars(false);
		}, 2600);
	}, []);

	const onKey = useCallback(
		(e: KeyboardEvent) => {
			if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
			const inPanel = (e.target as Element | null)?.closest?.("[data-panel]");
			if (e.key === "Escape") {
				if (panelRef.current) setPanel(null);
				else onClose();
				return;
			}
			if (inPanel) return; // arrow keys move between options there
			const scroll = applied.current.mode === "scroll";
			const rtl = book.rtl;
			let handled = true;
			switch (e.key) {
				case "ArrowRight":
					rtl ? prev() : next();
					break;
				case "ArrowLeft":
					rtl ? next() : prev();
					break;
				case "PageDown":
					next();
					break;
				case "PageUp":
					prev();
					break;
				case " ":
					e.shiftKey ? prev() : next();
					break;
				case "ArrowDown":
				case "ArrowUp": {
					const doc = frameDoc();
					if (scroll && doc)
						(doc.scrollingElement ?? doc.documentElement).scrollBy({ top: e.key === "ArrowDown" ? 60 : -60 });
					else handled = false;
					break;
				}
				case "Home":
				case "End": {
					const doc = frameDoc();
					if (doc) P.goToFraction(doc, e.key === "Home" ? 0 : 1, applied.current.mode, geom.current);
					moved();
					update();
					break;
				}
				case "t":
				case "T":
					setPanel((p) => (p === "toc" ? null : "toc"));
					break;
				case ",":
					setPanel((p) => (p === "settings" ? null : "settings"));
					break;
				default:
					handled = false;
			}
			if (handled) e.preventDefault();
		},
		[book, next, prev, update, onClose, moved, frameDoc],
	);

	const scrollTick = useRef(0);
	handlers.current = {
		next,
		prev,
		relayout,
		key: onKey,
		poke,
		toggleBars: () => setBars((b) => !b),
		follow: (a: Element) => {
			const external = a.getAttribute("data-external");
			if (external) {
				window.open(external, "_blank", "noopener,noreferrer");
				return;
			}
			const target = a.getAttribute("data-target");
			if (target) {
				const [i, fragment] = target.split("#");
				jump(Number(i), fragment);
			}
		},
		scrolled: () => {
			if (!relayoutState.current.running) moved();
			cancelAnimationFrame(scrollTick.current);
			scrollTick.current = requestAnimationFrame(update);
		},
	};

	/* ---------- Effects */

	// First chapter, from the saved position.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once per book
	useEffect(() => {
		void display(initial?.spine ?? 0, { anchor: initial?.anchor, fraction: initial?.fraction ?? 0 });
		poke();
		const chapterMap = chapters.current;
		return () => {
			token.current++;
			for (const p of chapterMap.values())
				void p.then((c) => {
					for (const u of c.urls) URL.revokeObjectURL(u);
				});
			chapterMap.clear();
			resources.dispose();
		};
	}, [book]);

	// Settings: persist and re-layout in place.
	const firstSettings = useRef(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: relayout whenever the effective settings change
	useEffect(() => {
		saveSettings(settings);
		if (firstSettings.current) {
			firstSettings.current = false;
			return;
		}
		void relayout();
	}, [effective]);

	// Resize: re-paginate.
	useEffect(() => {
		const stage = stageRef.current;
		if (!stage) return;
		let raf = 0;
		const ro = new ResizeObserver(() => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => void relayout());
		});
		ro.observe(stage);
		return () => {
			ro.disconnect();
			cancelAnimationFrame(raf);
		};
	}, [relayout]);

	// Keys when focus is outside the book frame; save on hide/close; lock page scroll.
	useEffect(() => {
		const key = (e: KeyboardEvent) => handlers.current.key(e);
		const hide = () => document.visibilityState === "hidden" && flush();
		window.addEventListener("keydown", key);
		document.addEventListener("visibilitychange", hide);
		const overflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			window.removeEventListener("keydown", key);
			document.removeEventListener("visibilitychange", hide);
			document.body.style.overflow = overflow;
			flush();
		};
	}, [flush]);

	/* ---------- Render */

	const fixed = book.spine[spine]?.fixed ?? false;
	const theme = THEMES[effective.theme];
	const fraction = fixed ? 0 : view.fraction;
	const percent = Math.round(percentAt(spine, fraction) * 100);
	const chapter = chapterTitle(book, spine);
	const currentToc = useMemo(() => {
		let best = -1;
		toc.forEach((t, idx) => {
			if (t.spine <= spine && (best < 0 || t.spine >= toc[best].spine)) best = idx;
		});
		return best;
	}, [toc, spine]);

	const readout = fixed
		? `Page ${spine + 1} of ${book.spine.length}`
		: effective.mode === "paged"
			? `${view.page + 1} / ${view.pages} · ${percent}%`
			: `${percent}%`;

	const update$ = (patch: Partial<ReaderSettings>) => setSettings((st) => ({ ...st, ...patch }));

	const style = { "--r-bg": theme.bg, "--r-text": theme.text, "--r-muted": theme.muted } as CSSProperties;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: mouse movement only reveals the bars; keys work without it
		<div className={s.reader} style={style} onMouseMove={poke}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: hover only keeps the bar from fading */}
			<header
				className={cx(s.top, !bars && !panel && s.hidden)}
				onMouseEnter={() => {
					overBars.current = true;
				}}
				onMouseLeave={() => {
					overBars.current = false;
				}}
			>
				<button type="button" className={s.iconBtn} onClick={onClose} aria-label="Close book" title="Close (Esc)">
					<Icon name="back" size={18} />
				</button>
				<div className={s.titles}>
					<span className={s.bookTitle}>{book.title}</span>
					{chapter && chapter !== book.title && <span className={s.chapterTitle}>{chapter}</span>}
				</div>
				<button
					type="button"
					className={cx(s.iconBtn, panel === "toc" && s.active)}
					onClick={() => setPanel((p) => (p === "toc" ? null : "toc"))}
					aria-label="Contents"
					aria-expanded={panel === "toc"}
					title="Contents (T)"
				>
					<Icon name="menu" size={18} />
				</button>
				<button
					type="button"
					className={cx(s.iconBtn, s.aa, panel === "settings" && s.active)}
					onClick={() => setPanel((p) => (p === "settings" ? null : "settings"))}
					aria-label="Reading settings"
					aria-expanded={panel === "settings"}
					title="Reading settings (,)"
				>
					Aa
				</button>
			</header>

			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: margin clicks mirror the arrow keys */}
			<div
				ref={stageRef}
				className={s.stage}
				onClick={(e) => {
					// Clicks in the margins beside the page (wide screens) turn pages too.
					if (e.target !== stageRef.current) return;
					const half = (stageRef.current?.clientWidth ?? 0) / 2;
					e.clientX < half ? prev() : next();
				}}
			>
				<iframe ref={frameRef} className={s.frame} title={book.title} sandbox="allow-same-origin" />
				{loading && <div className={s.loading} role="status" aria-label="Loading" />}
				{error && (
					<div className={s.error} role="alert">
						Couldn't display this section: {error}
					</div>
				)}
			</div>

			<footer className={s.bottom}>
				<div
					className={s.track}
					role="progressbar"
					aria-label="Progress through the book"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={percent}
				>
					<div className={s.fill} style={{ width: `${percent}%` }} />
				</div>
				<span className={s.readout} data-readout>
					{readout}
				</span>
			</footer>

			{panel && <div className={s.scrim} onClick={() => setPanel(null)} aria-hidden="true" />}

			{panel === "toc" && (
				<nav className={s.drawer} aria-label="Contents" data-panel>
					<div className={s.panelHead}>
						<span className={s.panelTitle}>Contents</span>
						<button type="button" className={s.iconBtn} onClick={() => setPanel(null)} aria-label="Close contents">
							<Icon name="x" size={16} />
						</button>
					</div>
					<ol className={s.toc}>
						{toc.map((t, idx) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: TOC entries can repeat; the list never reorders
							<li key={`${idx}-${t.spine}-${t.fragment}`}>
								<button
									type="button"
									className={cx(s.tocItem, idx === currentToc && s.current)}
									style={{ paddingLeft: `${12 + t.depth * 16}px` }}
									onClick={() => jump(t.spine, t.fragment)}
									aria-current={idx === currentToc ? "location" : undefined}
								>
									{t.title}
								</button>
							</li>
						))}
					</ol>
				</nav>
			)}

			{panel === "settings" && (
				<div className={s.settings} role="dialog" aria-label="Reading settings" data-panel>
					<div className={s.panelHead}>
						<span className={s.panelTitle}>Reading settings</span>
						<button type="button" className={s.iconBtn} onClick={() => setPanel(null)} aria-label="Close settings">
							<Icon name="x" size={16} />
						</button>
					</div>
					<div className={s.settingsBody}>
						<Pills<Theme>
							label="Theme"
							value={settings.theme}
							options={[
								{ value: "dark", label: "Dark" },
								{ value: "black", label: "Black" },
							]}
							onChange={(theme) => update$({ theme })}
						/>
						{!fixed && (
							<>
								<div className={s.sizeRow}>
									<span className={s.label}>Text size</span>
									<div className={s.stepper}>
										<button
											type="button"
											onClick={() => update$({ size: Math.max(SIZE_MIN, settings.size - 1) })}
											disabled={settings.size <= SIZE_MIN}
											aria-label="Smaller text"
										>
											A−
										</button>
										<span className={s.sizeValue}>{settings.size}px</span>
										<button
											type="button"
											onClick={() => update$({ size: Math.min(SIZE_MAX, settings.size + 1) })}
											disabled={settings.size >= SIZE_MAX}
											aria-label="Larger text"
										>
											A+
										</button>
									</div>
								</div>
								<Pills<FontChoice>
									label="Font"
									value={settings.font}
									options={[
										{ value: "serif", label: "Serif" },
										{ value: "sans", label: "Sans" },
										{ value: "original", label: "Book" },
									]}
									onChange={(font) => update$({ font })}
								/>
								<Pills<ReaderSettings["lineHeight"]>
									label="Line spacing"
									value={settings.lineHeight}
									options={[
										{ value: "1.4", label: "Tight" },
										{ value: "1.6", label: "Normal" },
										{ value: "1.8", label: "Loose" },
									]}
									onChange={(lineHeight) => update$({ lineHeight })}
								/>
								<Pills<Width>
									label="Line width"
									value={settings.width}
									options={[
										{ value: "narrow", label: "Narrow" },
										{ value: "medium", label: "Medium" },
										{ value: "wide", label: "Wide" },
									]}
									onChange={(width) => update$({ width })}
								/>
								{!book.rtl && (
									<Pills<ReaderSettings["mode"]>
										label="Layout"
										value={settings.mode}
										options={[
											{ value: "paged", label: "Pages" },
											{ value: "scroll", label: "Scroll" },
										]}
										onChange={(mode) => update$({ mode })}
									/>
								)}
								<Pills<ReaderSettings["colors"]>
									label="Book colors"
									value={settings.colors}
									options={[
										{ value: "override", label: "Readable" },
										{ value: "original", label: "Original" },
									]}
									onChange={(colors) => update$({ colors })}
								/>
							</>
						)}
						<Pills<"on" | "off">
							label="Dim images"
							value={settings.dimImages ? "on" : "off"}
							options={[
								{ value: "on", label: "On" },
								{ value: "off", label: "Off" },
							]}
							onChange={(v) => update$({ dimImages: v === "on" })}
						/>
					</div>
				</div>
			)}
		</div>
	);
}
