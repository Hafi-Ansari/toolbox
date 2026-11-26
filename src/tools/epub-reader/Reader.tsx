import {
	type CSSProperties,
	type FocusEvent,
	type PointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { type Book, chapterTitle, flattenToc } from "./book.ts";
import { watchTouches } from "./gestures.ts";
import { RIcon } from "./icons.tsx";
import { type Position, savePosition } from "./library.ts";
import * as P from "./paginate.ts";
import s from "./Reader.module.css";
import { type Geometry, markAlignment, readerCss } from "./readerCss.ts";
import { type Chapter, Resources, renderChapter } from "./render.ts";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { loadSettings, MEASURE_EM, type ReaderSettings, saveSettings, THEMES } from "./settings.ts";

const PLACEHOLDER = "/*READER_CSS*/";

/** How long the bars stay after the mouse last moved (desktop). */
const HIDE_AFTER_MOUSE = 2600;
/** How long the bars stay after a tap brings them up (touch). */
const HIDE_AFTER_TAP = 4000;
/** Taps within this fraction of the page width from either side turn the page. */
const EDGE = 0.3;
/** A click this soon after a touch came from that touch (already handled as a tap). */
const TOUCH_CLICK_MS = 800;

interface Target {
	anchor?: P.Anchor | null;
	fraction?: number;
	fragment?: string;
	end?: boolean;
}

const focusVisible = (el: EventTarget) => {
	try {
		return (el as Element).matches(":focus-visible");
	} catch {
		return true; // no :focus-visible support: treat every focus as keyboard focus
	}
};

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
	const barsRef = useRef(bars);
	barsRef.current = bars;
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
				stage.style.setProperty("--page-w", `${Math.round(g.width * scale)}px`);
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
			stage.style.setProperty("--page-w", `${Math.round(g.width * scale)}px`);
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
		tap: (_x: number) => {},
		swipe: (_dir: 1 | -1) => {},
		touchScrolled: () => {},
		follow: (_a: Element) => {},
		scrolled: () => {},
		relayout: async () => {},
	});

	const attach = useCallback((doc: Document) => {
		const h = () => handlers.current;
		let lastWheel = 0;
		// Touch is read as gestures (see gestures.ts). A tap also fires compatibility mouse
		// events and a click; those are ignored here so the tap is handled only once.
		let lastTouch = Number.NEGATIVE_INFINITY;
		let lastScroll = Number.NEGATIVE_INFINITY;
		let touching = false;
		let pointer = "";
		const fromTouch = () => pointer === "touch" || pointer === "pen" || performance.now() - lastTouch < TOUCH_CLICK_MS;
		doc.addEventListener("keydown", (e) => h().key(e));
		doc.addEventListener(
			"pointerdown",
			(e) => {
				pointer = e.pointerType;
			},
			{ passive: true, capture: true },
		);
		doc.addEventListener(
			"pointermove",
			(e) => {
				if (e.pointerType === "mouse") h().poke();
			},
			{ passive: true },
		);
		doc.addEventListener(
			"scroll",
			() => {
				if (applied.current.mode !== "scroll") return;
				lastScroll = performance.now();
				if (touching) h().touchScrolled();
				h().scrolled();
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
				(e.deltaY || e.deltaX) > 0 ? h().next() : h().prev();
			},
			{ passive: false },
		);
		const touched = (e: TouchEvent) => {
			lastTouch = performance.now();
			touching = e.touches.length > 0;
		};
		for (const type of ["touchstart", "touchend", "touchcancel"])
			doc.addEventListener(type, touched as EventListener, { passive: true });
		watchTouches(doc, {
			tap: (x) => h().tap(x),
			swipe: (dir) => h().swipe(dir),
			lastScroll: () => lastScroll,
		});
		doc.addEventListener("click", (e) => {
			const link = (e.target as Element | null)?.closest?.("a");
			if (link) {
				e.preventDefault(); // the sandboxed frame must never navigate itself
				h().follow(link);
				return;
			}
			if (fromTouch()) return;
			if (!doc.getSelection()?.isCollapsed) return; // selecting text, not tapping
			const w = doc.documentElement.clientWidth;
			const x = e.clientX / w;
			if (applied.current.mode === "paged" && x < EDGE) h().prev();
			else if (applied.current.mode === "paged" && x > 1 - EDGE) h().next();
			else h().toggleBars();
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
				if (!book.spine[i].fixed) markAlignment(doc);
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

	/** The spine item and the fraction through it at a 0–1 position in the whole book. */
	const locate = useCallback(
		(p: number): { i: number; fraction: number } => {
			const n = book.spine.length;
			if (book.totalSize <= 0) {
				const i = Math.min(n - 1, Math.floor(p * n));
				return { i, fraction: p * n - i };
			}
			const at = p * book.totalSize;
			let i = 0;
			while (i < n - 1 && before[i + 1] <= at) i++;
			const size = book.spine[i].size;
			return { i, fraction: size > 0 ? Math.min(1, Math.max(0, (at - before[i]) / size)) : 0 };
		},
		[book, before],
	);

	const seek = useCallback(
		(p: number) => {
			const { i, fraction } = locate(p);
			moved();
			const doc = frameDoc();
			if (i === spineRef.current && doc && !busy.current) {
				P.goToFraction(doc, fraction, applied.current.mode, geom.current);
				update();
			} else void display(i, { fraction });
		},
		[locate, display, update, moved, frameDoc],
	);

	/* ---------- Bars */

	// The bars hide after a while, but never out from under the reader: not while a panel is
	// open, the mouse is over them, a finger is on them, or the keyboard focus is in them.
	// When the last of those ends, the countdown starts again.
	const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const hideDelay = useRef(HIDE_AFTER_MOUSE);
	const holds = useRef({ hover: false, press: false, focus: false });
	const held = useCallback(() => {
		const h = holds.current;
		return !!panelRef.current || h.hover || h.press || h.focus;
	}, []);
	const arm = useCallback(
		(ms = hideDelay.current) => {
			hideDelay.current = ms;
			clearTimeout(hideTimer.current);
			hideTimer.current = setTimeout(() => {
				if (!held()) setBars(false);
			}, ms);
		},
		[held],
	);
	const poke = useCallback(() => {
		setBars(true);
		arm(HIDE_AFTER_MOUSE);
	}, [arm]);
	/** Hides the bars now (touch page turns and scrolling), unless something holds them. */
	const hideNow = useCallback(() => {
		if (held()) return;
		clearTimeout(hideTimer.current);
		setBars(false);
	}, [held]);
	const hold = useCallback(
		(what: keyof typeof holds.current, on: boolean) => {
			holds.current[what] = on;
			if (on) {
				clearTimeout(hideTimer.current);
				setBars(true);
			} else arm();
		},
		[arm],
	);
	useEffect(() => () => clearTimeout(hideTimer.current), []);

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
		tap: (x) => {
			if (panelRef.current) return;
			const turns = applied.current.mode === "paged" || book.spine[spineRef.current]?.fixed;
			if (turns && (x < EDGE || x > 1 - EDGE)) {
				// Like Books: the edges turn the page (and put the bars away), the middle toggles them.
				x > 1 - EDGE !== book.rtl ? next() : prev();
				hideNow();
			} else if (barsRef.current) hideNow();
			else {
				setBars(true);
				arm(HIDE_AFTER_TAP);
			}
		},
		swipe: (dir) => {
			if (panelRef.current) return;
			if (applied.current.mode !== "paged" && !book.spine[spineRef.current]?.fixed) return;
			dir > 0 !== book.rtl ? next() : prev();
			hideNow();
		},
		touchScrolled: () => {
			if (barsRef.current && !panelRef.current) hideNow();
		},
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

	// Closing a panel starts the bars' countdown again.
	useEffect(() => {
		if (!panel) arm();
	}, [panel, arm]);

	// Taps and swipes on the stage around the page (a fixed-layout page's letterbox, the wide
	// margins on a tablet) count like ones on the page. The book frame is a separate document,
	// so its touches never reach here.
	useEffect(() => {
		const stage = stageRef.current;
		if (!stage) return;
		return watchTouches(stage, {
			tap: (x) => handlers.current.tap(x),
			swipe: (dir) => handlers.current.swipe(dir),
			lastScroll: () => Number.NEGATIVE_INFINITY,
		});
	}, []);

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
	const progress = percentAt(spine, fraction);
	const percent = Math.round(progress * 100);
	const chapter = chapterTitle(book, spine);
	const paged = effective.mode === "paged";
	const currentToc = useMemo(() => {
		let best = -1;
		toc.forEach((t, idx) => {
			if (t.spine <= spine && (best < 0 || t.spine >= toc[best].spine)) best = idx;
		});
		return best;
	}, [toc, spine]);

	const readout = fixed
		? `Page ${spine + 1} of ${book.spine.length}`
		: paged
			? `${view.page + 1} / ${view.pages} · ${percent}%`
			: `${percent}%`;
	const left = paged && !fixed ? view.pages - view.page - 1 : -1;
	const chapterLeft =
		left > 0 ? `${left} ${left === 1 ? "page" : "pages"} left in chapter` : left === 0 ? "Last page of chapter" : "";

	// Scrubbing through the book: preview while dragging, jump on release.
	const [scrub, setScrub] = useState<number | null>(null);
	const scrubTo = scrub == null ? null : locate(scrub);
	const commitScrub = () => {
		if (scrub != null) seek(Math.min(0.9999, scrub));
		setScrub(null);
	};

	const [cover, setCover] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		if (book.coverPath) void resources.url(book.coverPath, null).then((u) => live && setCover(u));
		return () => {
			live = false;
		};
	}, [book, resources]);

	// Bring the current chapter into view when the contents open.
	const tocRef = useRef<HTMLOListElement>(null);
	useEffect(() => {
		if (panel !== "toc") return;
		tocRef.current?.querySelector('[aria-current="location"]')?.scrollIntoView({ block: "center" });
	}, [panel]);

	const update$ = (patch: Partial<ReaderSettings>) => setSettings((st) => ({ ...st, ...patch }));

	const style = {
		"--r-bg": theme.bg,
		"--r-text": theme.text,
		"--r-muted": theme.muted,
		"--r-surface": theme.surface,
		"--r-border": theme.border,
		"--r-accent": theme.accent,
		"--r-on-accent": theme.onAccent,
		colorScheme: theme.dark ? "dark" : "light",
	} as CSSProperties;
	const showBars = bars || !!panel;
	const toggle = (p: "toc" | "settings") => setPanel((cur) => (cur === p ? null : p));
	const keepBars = {
		onPointerEnter: (e: PointerEvent<HTMLElement>) => e.pointerType === "mouse" && hold("hover", true),
		onPointerLeave: (e: PointerEvent<HTMLElement>) => e.pointerType === "mouse" && hold("hover", false),
		// A finger on the bars (dragging the scrubber, say) keeps them until it lifts.
		onPointerDown: (e: PointerEvent<HTMLElement>) => {
			if (e.pointerType === "mouse") return;
			hold("press", true);
			const up = () => {
				window.removeEventListener("pointerup", up);
				window.removeEventListener("pointercancel", up);
				hold("press", false);
			};
			window.addEventListener("pointerup", up);
			window.addEventListener("pointercancel", up);
		},
		// Keyboard focus brings the bars back and keeps them while it stays there. Only visible
		// focus counts: a tapped button keeps focus on Android without the bars needing to stay.
		onFocus: (e: FocusEvent<HTMLElement>) => focusVisible(e.target) && hold("focus", true),
		onBlur: (e: FocusEvent<HTMLElement>) => {
			if (!e.currentTarget.contains(e.relatedTarget as Node | null) && holds.current.focus) hold("focus", false);
		},
	};

	return (
		<div className={s.reader} style={style} onPointerMove={(e) => e.pointerType === "mouse" && poke()}>
			<header className={cx(s.top, !showBars && s.hidden)} {...keepBars}>
				<button
					type="button"
					className={s.iconBtn}
					onClick={onClose}
					aria-label="Close book"
					title="Back to library (Esc)"
				>
					<RIcon name="back" size={20} />
				</button>
				<div className={s.titles}>
					<span className={s.bookTitle}>{book.title}</span>
					{chapter && chapter !== book.title && <span className={s.chapterTitle}>{chapter}</span>}
				</div>
				<div className={s.actions}>
					<button
						type="button"
						className={cx(s.iconBtn, panel === "toc" && s.active)}
						onClick={() => toggle("toc")}
						aria-label="Contents"
						aria-expanded={panel === "toc"}
						title="Contents (T)"
					>
						<RIcon name="toc" size={20} />
					</button>
					<button
						type="button"
						className={cx(s.iconBtn, s.aa, panel === "settings" && s.active)}
						onClick={() => toggle("settings")}
						aria-label="Reading settings"
						aria-expanded={panel === "settings"}
						title="Reading settings (,)"
					>
						<span aria-hidden="true">
							A<small>a</small>
						</span>
					</button>
				</div>
			</header>

			<div ref={stageRef} className={s.stage}>
				<iframe ref={frameRef} className={s.frame} title={book.title} sandbox="allow-same-origin" />
				{(paged || fixed) && (
					<>
						<button
							type="button"
							className={cx(s.edge, s.edgePrev)}
							onClick={book.rtl ? next : prev}
							tabIndex={-1}
							aria-label={book.rtl ? "Next page" : "Previous page"}
						>
							<RIcon name="chevron-left" size={28} />
						</button>
						<button
							type="button"
							className={cx(s.edge, s.edgeNext)}
							onClick={book.rtl ? prev : next}
							tabIndex={-1}
							aria-label={book.rtl ? "Previous page" : "Next page"}
						>
							<RIcon name="chevron-right" size={28} />
						</button>
					</>
				)}
				{loading && <div className={s.loading} role="status" aria-label="Loading" />}
				{error && (
					<div className={s.error} role="alert">
						Couldn't display this section: {error}
					</div>
				)}
			</div>

			<footer className={cx(s.bottom, !showBars && s.hidden)} {...keepBars}>
				<div className={s.scrubInfo}>
					<span className={s.scrubChapter}>
						{scrubTo ? chapterTitle(book, scrubTo.i) || `Section ${scrubTo.i + 1}` : chapter || book.title}
					</span>
					<span className={s.scrubMeta}>{scrub != null ? `${Math.round(scrub * 100)}%` : chapterLeft}</span>
				</div>
				<input
					type="range"
					className={s.scrubber}
					min={0}
					max={1000}
					step={1}
					value={Math.round((scrub ?? progress) * 1000)}
					onChange={(e) => setScrub(Number(e.target.value) / 1000)}
					onPointerUp={commitScrub}
					onKeyUp={commitScrub}
					onBlur={() => scrub != null && commitScrub()}
					aria-label="Position in book"
					aria-valuetext={`${scrub != null ? Math.round(scrub * 100) : percent}%`}
					style={{ "--p": scrub ?? progress } as CSSProperties}
				/>
			</footer>

			<div className={cx(s.readout, showBars && s.readoutUp)} data-readout>
				{readout}
			</div>

			{panel && (
				<div
					className={cx(s.scrim, panel === "settings" && s.scrimClear)}
					onClick={() => setPanel(null)}
					aria-hidden="true"
				/>
			)}

			{panel === "toc" && (
				<nav className={s.drawer} aria-label="Contents" data-panel>
					<div className={s.drawerHead}>
						<div className={s.drawerBook}>
							{cover ? (
								<img className={s.drawerCover} src={cover} alt="" />
							) : (
								<span className={cx(s.drawerCover, s.drawerCoverBlank)} aria-hidden="true">
									{book.title.slice(0, 1).toUpperCase()}
								</span>
							)}
							<div className={s.drawerMeta}>
								<span className={s.drawerTitle}>{book.title}</span>
								{book.author && <span className={s.drawerAuthor}>{book.author}</span>}
								<span className={s.drawerProgress}>
									<span className={s.miniBar}>
										<span style={{ width: `${percent}%` }} />
									</span>
									{percent}% read
								</span>
							</div>
						</div>
						<button type="button" className={s.iconBtn} onClick={() => setPanel(null)} aria-label="Close contents">
							<RIcon name="x" size={18} />
						</button>
					</div>
					<ol className={s.toc} ref={tocRef}>
						{toc.length === 0 && <li className={s.tocEmpty}>This book has no table of contents.</li>}
						{toc.map((t, idx) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: TOC entries can repeat; the list never reorders
							<li key={`${idx}-${t.spine}-${t.fragment}`}>
								<button
									type="button"
									className={cx(s.tocItem, idx === currentToc && s.current, t.depth === 0 && s.tocTop)}
									style={{ paddingLeft: `${14 + t.depth * 16}px` }}
									onClick={() => jump(t.spine, t.fragment)}
									aria-current={idx === currentToc ? "location" : undefined}
								>
									<span className={s.tocText}>{t.title}</span>
									<span className={s.tocPct} aria-hidden="true">
										{Math.round(percentAt(t.spine, 0) * 100)}%
									</span>
								</button>
							</li>
						))}
					</ol>
				</nav>
			)}

			{panel === "settings" && (
				<SettingsPanel
					settings={settings}
					update={update$}
					fixed={fixed}
					rtl={book.rtl}
					onClose={() => setPanel(null)}
				/>
			)}
		</div>
	);
}
