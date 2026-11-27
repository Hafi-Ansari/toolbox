// The document being edited: an ordered list of page references into one or more source PDFs,
// plus the items placed on them. Pure functions so page operations are easy to test and undo.
import type { Rect } from "./geometry.ts";
import type { Item, PageSize } from "./items.ts";

export type Quarter = 0 | 90 | 180 | 270;

export interface PageRef {
	/** Stable id. Items point at it, so they follow their page through reordering. */
	id: string;
	source: number;
	/** Page index inside the source PDF. */
	index: number;
	/** Rotation added in the editor, clockwise, on top of the source page's own rotation. */
	rotate: Quarter;
}

export interface Snapshot {
	pages: PageRef[];
	items: Item[];
}

export interface Source {
	id: number;
	name: string;
	pages: PageSize[];
}

export function initialPages(source: number, count: number, id = (i: number) => `${source}:${i}`): PageRef[] {
	return Array.from({ length: count }, (_, index) => ({ id: id(index), source, index, rotate: 0 }));
}

export function turn(rotate: number, delta: number): Quarter {
	return ((((Math.round((rotate + delta) / 90) * 90) % 360) + 360) % 360) as Quarter;
}

/** The page's size as shown, after the editor's rotation. */
export function shownSize(size: PageSize, rotate: number): { w: number; h: number } {
	return rotate % 180 ? { w: size.h, h: size.w } : { w: size.w, h: size.h };
}

/** Maps a fraction of the shown (rotated) page box to a fraction of the unrotated page. */
export function unrotateFraction([u, v]: [number, number], rotate: number): [number, number] {
	switch (turn(rotate, 0)) {
		case 90:
			return [v, 1 - u];
		case 180:
			return [1 - u, 1 - v];
		case 270:
			return [1 - v, u];
		default:
			return [u, v];
	}
}

/** Moves the chosen pages, kept in their current relative order, to sit before `slot` (an index in `pages`). */
export function movePages(pages: PageRef[], ids: ReadonlySet<string>, slot: number): PageRef[] {
	const moving = pages.filter(({ id }) => ids.has(id));
	if (!moving.length) return pages;
	const before = pages.slice(0, slot).filter(({ id }) => !ids.has(id)).length;
	const rest = pages.filter(({ id }) => !ids.has(id));
	const next = [...rest.slice(0, before), ...moving, ...rest.slice(before)];
	return next.every((page, i) => page === pages[i]) ? pages : next;
}

/** Moves each chosen page one step left (-1) or right (+1), as a block. */
export function nudgePages(pages: PageRef[], ids: ReadonlySet<string>, step: -1 | 1): PageRef[] {
	const positions = pages.flatMap(({ id }, i) => (ids.has(id) ? [i] : []));
	if (!positions.length) return pages;
	if (step < 0) {
		const first = positions[0];
		return first === 0 ? pages : movePages(pages, ids, first - 1);
	}
	const last = positions[positions.length - 1];
	return last === pages.length - 1 ? pages : movePages(pages, ids, last + 2);
}

export function rotatePages(pages: PageRef[], ids: ReadonlySet<string>, delta: number): PageRef[] {
	return pages.map((page) => (ids.has(page.id) ? { ...page, rotate: turn(page.rotate, delta) } : page));
}

/** Removes pages and every item placed on them. Refuses to remove the last page. */
export function deletePages(state: Snapshot, ids: ReadonlySet<string>): Snapshot {
	const pages = state.pages.filter(({ id }) => !ids.has(id));
	if (!pages.length || pages.length === state.pages.length) return state;
	return { pages, items: state.items.filter((item) => !ids.has(item.page)) };
}

/** Inserts a copy of each chosen page right after it, with copies of its items. */
export function duplicatePages(state: Snapshot, ids: ReadonlySet<string>, newId: () => string): Snapshot {
	const pages: PageRef[] = [];
	const items = [...state.items];
	for (const page of state.pages) {
		pages.push(page);
		if (!ids.has(page.id)) continue;
		const copy = { ...page, id: newId() };
		pages.push(copy);
		for (const item of state.items) if (item.page === page.id) items.push({ ...item, id: newId(), page: copy.id });
	}
	return pages.length === state.pages.length ? state : { pages, items };
}

/** Inserts pages after the page at `after` (-1 inserts at the start, `pages.length - 1` or more at the end). */
export function insertPages(pages: PageRef[], added: PageRef[], after: number): PageRef[] {
	const at = Math.max(0, Math.min(pages.length, after + 1));
	return [...pages.slice(0, at), ...added, ...pages.slice(at)];
}

export function samePages(a: PageRef[], b: PageRef[]): boolean {
	return a.length === b.length && a.every((page, i) => page.id === b[i].id && page.rotate === b[i].rotate);
}

/**
 * Parses page ranges such as "1-3, 4-10, 12" (1-based, inclusive) into groups of 0-based indices.
 * "8-" runs to the last page. Throws a user-facing message on bad input.
 */
export function parseRanges(text: string, count: number): number[][] {
	const parts = text
		.split(/[,;]/)
		.map((part) => part.trim())
		.filter(Boolean);
	if (!parts.length) throw new Error("Enter page ranges such as 1-3, 4-10.");
	return parts.map((part) => {
		const match = /^(\d+)\s*(?:[-–]\s*(\d*))?$/.exec(part);
		if (!match) throw new Error(`“${part}” is not a page range. Use numbers such as 1-3 or 7.`);
		const start = Number(match[1]);
		const end = match[2] === undefined ? start : match[2] === "" ? count : Number(match[2]);
		if (start < 1 || end < 1 || start > count || end > count)
			throw new Error(`“${part}” is outside the document, which has ${count} ${count === 1 ? "page" : "pages"}.`);
		if (end < start) throw new Error(`“${part}” runs backwards. Write the lower page first.`);
		return Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i);
	});
}

export function everyPages(count: number, size: number): number[][] {
	if (!Number.isInteger(size) || size < 1) throw new Error("Enter a whole number of pages per file.");
	return Array.from({ length: Math.ceil(count / size) }, (_, part) =>
		Array.from({ length: Math.min(size, count - part * size) }, (_, i) => part * size + i),
	);
}

export function rangeLabel(group: number[]): string {
	const first = group[0] + 1;
	const last = group[group.length - 1] + 1;
	const contiguous = group.every((page, i) => page === group[0] + i);
	if (contiguous) return first === last ? `page ${first}` : `pages ${first}-${last}`;
	return `${group.length} pages`;
}

export interface PlanPage {
	source: number;
	index: number;
	rotate: Quarter;
	items: Item[];
}

/** What the worker needs to build one output PDF from a subset of pages, in order. */
export function planPages(state: Snapshot, indices?: number[]): PlanPage[] {
	const byPage = new Map<string, Item[]>();
	for (const item of state.items) {
		const list = byPage.get(item.page);
		if (list) list.push(item);
		else byPage.set(item.page, [item]);
	}
	const chosen = indices ? indices.map((i) => state.pages[i]) : state.pages;
	return chosen.map(({ id, source, index, rotate }) => ({ source, index, rotate, items: byPage.get(id) ?? [] }));
}

/** The first page reference (in document order) showing a source page; form fields live on it. */
export function primaryPage(pages: PageRef[], source: number, index: number): PageRef | undefined {
	return pages.find((page) => page.source === source && page.index === index);
}

export function centerInside(item: { x: number; y: number; w: number; h: number }, [x0, y0, x1, y1]: Rect): boolean {
	const cx = item.x + item.w / 2;
	const cy = item.y + item.h / 2;
	return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
}

export const SOURCE_COLORS = ["#2f7de1", "#d9822b", "#2e9e6a", "#b05cc8", "#c24d4d", "#1f9fb0"] as const;

export function sourceLetter(id: number): string {
	let n = id;
	let label = "";
	do {
		label = String.fromCharCode(65 + (n % 26)) + label;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return label;
}
