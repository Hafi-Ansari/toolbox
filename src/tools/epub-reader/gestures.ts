// Touch gestures on the page, told apart the way the iPhone Books app does it: a short,
// still, single-finger touch is a tap (turn the page at the edges, toggle the bars in the
// middle); a horizontal flick is a swipe (turn the page); anything else (scrolling, a tap
// that stops a fling, pinching, long-press or text selection) is left to the browser.
//
// Touch input is read from touch events rather than `click`: a tap also produces a
// compatibility mousemove before its click, and iOS Safari doesn't dispatch `click` to plain
// text whose only listener sits on the document. The reader ignores those mouse events for
// touch (see Reader.tsx), so a tap is handled exactly once, here.

/** Movement (px) a finger may drift and still tap; about the iOS and Android touch slop. */
export const TAP_SLOP = 10;
/** Longer presses are a long-press (text selection, link preview), not a tap. */
export const TAP_MAX_MS = 500;
/** A touch that starts this soon after the page scrolled is stopping a fling, not tapping. */
export const SCROLL_QUIET_MS = 150;
/** A swipe moves at least this far, mostly sideways. */
export const SWIPE_MIN = 48;

export interface Gesture {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	ms: number;
	/** Furthest distance from the start at any point. */
	maxDist: number;
	/** Most fingers down at once. */
	fingers: number;
	/** The page scrolled during the touch or just before it. */
	scrolled: boolean;
	/** Text was selected when the touch began or ended (a tap then only clears it). */
	selecting: boolean;
	/** The touch landed on a link or control, which handles it itself. */
	onControl: boolean;
}

export type Kind = { kind: "tap" } | { kind: "swipe"; dir: 1 | -1 } | { kind: "none" };

export function classify(g: Gesture): Kind {
	if (g.fingers > 1 || g.scrolled) return { kind: "none" };
	const dx = g.x1 - g.x0;
	const dy = g.y1 - g.y0;
	// dir 1 = toward the next page (finger moves left), as in the swipe the reader always had.
	if (Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5 && !g.selecting) {
		return { kind: "swipe", dir: dx < 0 ? 1 : -1 };
	}
	if (g.maxDist > TAP_SLOP || g.ms > TAP_MAX_MS || g.selecting || g.onControl) return { kind: "none" };
	return { kind: "tap" };
}

const CONTROLS = "a, button, input, select, textarea, label, summary, audio, video, [contenteditable]";

export interface TouchHandlers {
	/** A tap at `x`, as a fraction (0–1) of the target's width. */
	tap(x: number): void;
	swipe(dir: 1 | -1): void;
	/** Time (performance.now) the target last scrolled under the reader's finger or a fling. */
	lastScroll(): number;
}

/**
 * Watches touches on a document (the book frame) or an element (the stage around a
 * fixed-layout page). Returns a function that stops watching.
 */
export function watchTouches(target: Document | HTMLElement, h: TouchHandlers): () => void {
	// The book frame is another realm, so `instanceof Document` would be false for it.
	const isDoc = target.nodeType === Node.DOCUMENT_NODE;
	const doc = isDoc ? (target as Document) : (target.ownerDocument as Document);
	const box = () => (isDoc ? (target as Document).documentElement : (target as HTMLElement));
	const selecting = () => {
		const sel = doc.getSelection();
		return !!sel && sel.rangeCount > 0 && !sel.isCollapsed;
	};
	let g: Gesture | null = null;
	let t0 = 0;

	const start = (e: TouchEvent) => {
		const fingers = e.touches.length;
		if (g) {
			g.fingers = Math.max(g.fingers, fingers);
			return;
		}
		const p = e.changedTouches[0];
		if (!p) return;
		t0 = performance.now();
		const node = e.target as Node | null;
		const el = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement;
		g = {
			x0: p.clientX,
			y0: p.clientY,
			x1: p.clientX,
			y1: p.clientY,
			ms: 0,
			maxDist: 0,
			fingers,
			scrolled: h.lastScroll() > t0 - SCROLL_QUIET_MS,
			selecting: selecting(),
			onControl: !!el?.closest?.(CONTROLS),
		};
	};
	const move = (e: TouchEvent) => {
		if (!g) return;
		g.fingers = Math.max(g.fingers, e.touches.length);
		const p = e.touches[0];
		if (p) g.maxDist = Math.max(g.maxDist, Math.hypot(p.clientX - g.x0, p.clientY - g.y0));
	};
	const end = (e: TouchEvent) => {
		if (!g || e.touches.length > 0) return; // wait for the last finger
		const p = e.changedTouches[0];
		const gesture = g;
		g = null;
		if (!p) return;
		gesture.x1 = p.clientX;
		gesture.y1 = p.clientY;
		gesture.ms = performance.now() - t0;
		gesture.maxDist = Math.max(gesture.maxDist, Math.hypot(p.clientX - gesture.x0, p.clientY - gesture.y0));
		gesture.scrolled ||= h.lastScroll() > t0;
		gesture.selecting ||= selecting();
		const result = classify(gesture);
		if (result.kind === "swipe") h.swipe(result.dir);
		else if (result.kind === "tap") {
			// In the book frame, touch coordinates are already relative to the page on screen.
			const left = isDoc ? 0 : box().getBoundingClientRect().left;
			h.tap((gesture.x1 - left) / Math.max(1, box().clientWidth));
		}
	};
	const cancel = () => {
		g = null;
	};

	const opts = { passive: true } as const;
	target.addEventListener("touchstart", start as EventListener, opts);
	target.addEventListener("touchmove", move as EventListener, opts);
	target.addEventListener("touchend", end as EventListener, opts);
	target.addEventListener("touchcancel", cancel, opts);
	return () => {
		target.removeEventListener("touchstart", start as EventListener);
		target.removeEventListener("touchmove", move as EventListener);
		target.removeEventListener("touchend", end as EventListener);
		target.removeEventListener("touchcancel", cancel);
	};
}
