import { expect, it } from "vitest";
import type { Item } from "./items.ts";
import {
	centerInside,
	deletePages,
	duplicatePages,
	everyPages,
	initialPages,
	insertPages,
	movePages,
	nudgePages,
	type PageRef,
	parseRanges,
	planPages,
	primaryPage,
	rotatePages,
	samePages,
	shownSize,
	sourceLetter,
	turn,
	unrotateFraction,
} from "./pages.ts";

const pages = initialPages(0, 5);
const ids = (list: PageRef[]) => list.map(({ id }) => id);
const mark = (id: string, page: string): Item => ({
	kind: "mark",
	shape: "check",
	id,
	page,
	x: 10,
	y: 20,
	w: 20,
	h: 20,
	color: "#000000",
});

it("moves single pages and blocks of selected pages to a slot", () => {
	expect(ids(movePages(pages, new Set(["0:0"]), 3))).toEqual(["0:1", "0:2", "0:0", "0:3", "0:4"]);
	expect(ids(movePages(pages, new Set(["0:4"]), 0))).toEqual(["0:4", "0:0", "0:1", "0:2", "0:3"]);
	expect(ids(movePages(pages, new Set(["0:1", "0:3"]), 5))).toEqual(["0:0", "0:2", "0:4", "0:1", "0:3"]);
	expect(movePages(pages, new Set(["0:2"]), 2)).toBe(pages);
	expect(movePages(pages, new Set(["missing"]), 0)).toBe(pages);
});

it("nudges pages left and right with the keyboard buttons and stops at the ends", () => {
	expect(ids(nudgePages(pages, new Set(["0:2"]), -1))).toEqual(["0:0", "0:2", "0:1", "0:3", "0:4"]);
	expect(ids(nudgePages(pages, new Set(["0:2", "0:3"]), 1))).toEqual(["0:0", "0:1", "0:4", "0:2", "0:3"]);
	expect(nudgePages(pages, new Set(["0:0"]), -1)).toBe(pages);
	expect(nudgePages(pages, new Set(["0:4"]), 1)).toBe(pages);
});

it("rotates in quarter turns and maps shown fractions back to the unrotated page", () => {
	expect(turn(270, 90)).toBe(0);
	expect(turn(0, -90)).toBe(270);
	expect(turn(-450, 0)).toBe(270);
	expect(rotatePages(pages, new Set(["0:1"]), 90)[1].rotate).toBe(90);
	expect(shownSize({ w: 100, h: 200, rotate: 0 }, 90)).toEqual({ w: 200, h: 100 });
	// A point near the shown top-right corner of a page turned clockwise is near the unrotated top-left.
	expect(unrotateFraction([0.75, 0.25], 90)).toEqual([0.25, 0.25]);
	expect(unrotateFraction([0.25, 0.75], 180)).toEqual([0.75, 0.25]);
	expect(unrotateFraction([0.25, 0.75], 270)).toEqual([0.25, 0.25]);
	expect(unrotateFraction([0.3, 0.4], 0)).toEqual([0.3, 0.4]);
});

it("deletes pages with their items but never the last page", () => {
	const state = { pages, items: [mark("a", "0:1"), mark("b", "0:2")] };
	const next = deletePages(state, new Set(["0:1"]));
	expect(ids(next.pages)).toEqual(["0:0", "0:2", "0:3", "0:4"]);
	expect(next.items.map(({ id }) => id)).toEqual(["b"]);
	expect(deletePages(state, new Set(ids(pages)))).toBe(state);
});

it("duplicates pages right after themselves, copying their items onto the copy", () => {
	let n = 0;
	const state = { pages: pages.slice(0, 2), items: [mark("a", "0:1")] };
	const next = duplicatePages(state, new Set(["0:1"]), () => `new${n++}`);
	expect(ids(next.pages)).toEqual(["0:0", "0:1", "new0"]);
	expect(next.pages[2]).toMatchObject({ source: 0, index: 1 });
	expect(next.items).toHaveLength(2);
	expect(next.items[1]).toMatchObject({ id: "new1", page: "new0", x: 10 });
});

it("inserts merged pages at the start, after a page, or at the end", () => {
	const added = initialPages(1, 2);
	expect(ids(insertPages(pages.slice(0, 2), added, -1))).toEqual(["1:0", "1:1", "0:0", "0:1"]);
	expect(ids(insertPages(pages.slice(0, 2), added, 0))).toEqual(["0:0", "1:0", "1:1", "0:1"]);
	expect(ids(insertPages(pages.slice(0, 2), added, 99))).toEqual(["0:0", "0:1", "1:0", "1:1"]);
});

it("parses page ranges and fixed-size splits, rejecting bad input with a message", () => {
	expect(parseRanges("1-3, 4-5", 5)).toEqual([
		[0, 1, 2],
		[3, 4],
	]);
	expect(parseRanges(" 2 ; 4- ", 6)).toEqual([[1], [3, 4, 5]]);
	expect(() => parseRanges("", 5)).toThrow(/Enter page ranges/);
	expect(() => parseRanges("3-1", 5)).toThrow(/backwards/);
	expect(() => parseRanges("2-9", 5)).toThrow(/outside the document/);
	expect(() => parseRanges("a-b", 5)).toThrow(/not a page range/);
	expect(everyPages(5, 2)).toEqual([[0, 1], [2, 3], [4]]);
	expect(() => everyPages(5, 0)).toThrow(/whole number/);
});

it("plans output pages in order with their items, and finds the primary copy of a page", () => {
	const moved = rotatePages(movePages(pages, new Set(["0:3"]), 0), new Set(["0:3"]), 90);
	const state = { pages: moved, items: [mark("a", "0:3")] };
	expect(planPages(state, [0, 2])).toEqual([
		{ source: 0, index: 3, rotate: 90, items: [state.items[0]] },
		{ source: 0, index: 1, rotate: 0, items: [] },
	]);
	expect(samePages(state.pages, pages)).toBe(false);
	expect(samePages(pages, initialPages(0, 5))).toBe(true);
	expect(primaryPage([{ id: "x", source: 0, index: 2, rotate: 0 }, pages[2]], 0, 2)?.id).toBe("x");
	expect(centerInside({ x: 10, y: 10, w: 20, h: 20 }, [0, 0, 25, 25])).toBe(true);
	expect(centerInside({ x: 10, y: 10, w: 40, h: 40 }, [0, 0, 25, 25])).toBe(false);
});

it("labels sources with letters", () => {
	expect([0, 1, 25, 26, 27].map(sourceLetter)).toEqual(["A", "B", "Z", "AA", "AB"]);
});
