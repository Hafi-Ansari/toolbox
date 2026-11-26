// Page math and reading-position anchors for a rendered chapter document.
// Paged mode lays the body out in CSS columns, one column per page, and turns
// pages by scrolling the root horizontally by one page width. Positions are
// stored as a text anchor (node path + offset), so resizing or changing the
// font size returns to the same passage rather than the same page number.
import type { Geometry } from "./readerCss.ts";
import type { Mode } from "./settings.ts";

export interface Anchor {
	/** childNodes indices from <body> down to the node. */
	path: number[];
	offset: number;
}

const root = (doc: Document) => (doc.scrollingElement ?? doc.documentElement) as HTMLElement;

export function pageCount(doc: Document, g: Geometry): number {
	return Math.max(1, Math.round(root(doc).scrollWidth / g.width));
}

export function showPage(doc: Document, page: number, g: Geometry) {
	root(doc).scrollLeft = page * g.width;
}

export function currentPage(doc: Document, g: Geometry): number {
	return Math.round(root(doc).scrollLeft / g.width);
}

/** 0–1 position through the chapter. */
export function chapterFraction(doc: Document, mode: Mode, g: Geometry): number {
	const r = root(doc);
	if (mode === "paged") {
		const pages = pageCount(doc, g);
		return pages <= 1 ? 0 : currentPage(doc, g) / (pages - 1);
	}
	const max = r.scrollHeight - r.clientHeight;
	return max <= 0 ? 0 : r.scrollTop / max;
}

function nodePath(body: Node, node: Node): number[] | null {
	const path: number[] = [];
	let n: Node | null = node;
	while (n && n !== body) {
		const parent: Node | null = n.parentNode;
		if (!parent) return null;
		path.unshift(Array.prototype.indexOf.call(parent.childNodes, n));
		n = parent;
	}
	return n === body ? path : null;
}

function nodeAt(body: Node, path: number[]): Node | null {
	let n: Node | null = body;
	for (const i of path) {
		n = n?.childNodes[i] ?? null;
		if (!n) return null;
	}
	return n;
}

type CaretDoc = Document & {
	caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
	caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function caretAt(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
	const d = doc as CaretDoc;
	if (d.caretPositionFromPoint) {
		const p = d.caretPositionFromPoint(x, y);
		if (p) return { node: p.offsetNode, offset: p.offset };
	}
	if (d.caretRangeFromPoint) {
		const r = d.caretRangeFromPoint(x, y);
		if (r) return { node: r.startContainer, offset: r.startOffset };
	}
	return null;
}

/** The text position at the top-left of what is currently on screen. */
export function captureAnchor(doc: Document, g: Geometry): Anchor | null {
	const body = doc.body;
	if (!body) return null;
	// Probe a few points down the page: the first may land in a margin or between blocks.
	for (const fy of [0, 0.08, 0.2, 0.35, 0.5]) {
		const y = g.padY + 2 + fy * (g.height - 2 * g.padY);
		const hit = caretAt(doc, g.padX + 2, y);
		if (!hit || !body.contains(hit.node)) continue;
		const path = nodePath(body, hit.node);
		if (path) return { path, offset: hit.offset };
	}
	return null;
}

function rectOf(doc: Document, target: Anchor | string): DOMRect | null {
	if (typeof target === "string") {
		const el = doc.getElementById(target) ?? doc.getElementsByName(target)[0];
		return el ? (el.getClientRects()[0] ?? el.getBoundingClientRect()) : null;
	}
	const node = nodeAt(doc.body, target.path);
	if (!node) return null;
	const range = doc.createRange();
	try {
		const isText = node.nodeType === Node.TEXT_NODE;
		const max = isText ? (node.textContent?.length ?? 0) : node.childNodes.length;
		const at = Math.min(target.offset, max);
		range.setStart(node, at);
		// Measure the character itself, not a collapsed caret: at a soft line wrap a caret
		// can report the end of the previous line, which may be on the previous page.
		if (isText && at < max) range.setEnd(node, at + 1);
		else range.collapse(true);
	} catch {
		range.selectNode(node);
	}
	const rects = range.getClientRects();
	if (rects.length) return rects[0];
	const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	return el?.getBoundingClientRect() ?? null;
}

/**
 * Moves the view to an anchor or element id. Returns false if it can't be found
 * (the caller then falls back to the stored fraction).
 */
export function goTo(doc: Document, target: Anchor | string, mode: Mode, g: Geometry): boolean {
	const rect = rectOf(doc, target);
	if (!rect) return false;
	const r = root(doc);
	if (mode === "paged") {
		const x = rect.left + r.scrollLeft;
		const page = Math.max(0, Math.min(pageCount(doc, g) - 1, Math.floor((x + 1) / g.width)));
		showPage(doc, page, g);
	} else {
		r.scrollTop = Math.max(0, rect.top + r.scrollTop - g.padY);
	}
	return true;
}

export function goToFraction(doc: Document, fraction: number, mode: Mode, g: Geometry) {
	const r = root(doc);
	if (mode === "paged") showPage(doc, Math.round(fraction * (pageCount(doc, g) - 1)), g);
	else r.scrollTop = fraction * (r.scrollHeight - r.clientHeight);
}

export function atEnd(doc: Document, mode: Mode, g: Geometry): boolean {
	if (mode === "paged") return currentPage(doc, g) >= pageCount(doc, g) - 1;
	const r = root(doc);
	return r.scrollTop + r.clientHeight >= r.scrollHeight - 2;
}

export function atStart(doc: Document, mode: Mode, g: Geometry): boolean {
	return mode === "paged" ? currentPage(doc, g) <= 0 : root(doc).scrollTop <= 2;
}

export function scrollByScreen(doc: Document, dir: 1 | -1) {
	const r = root(doc);
	r.scrollBy({ top: dir * r.clientHeight * 0.88, behavior: "smooth" });
}
