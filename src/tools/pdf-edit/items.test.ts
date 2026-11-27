import { expect, it } from "vitest";
import { EMPTY_HISTORY, editHistory } from "./history.ts";
import { hitStroke, type Item, moveBy, normalizeStrokes, resizeTo, wrapLines } from "./items.ts";

const page = { w: 300, h: 500, rotate: 0 };
const mark: Item = { kind: "mark", shape: "check", id: "a", page: 0, x: 12, y: 8, w: 40, h: 20, color: "#000000" };

it("wraps measured words, preserves explicit newlines, and breaks long words", () => {
	expect(wrapLines("one three\n\nbeginning", 5, (text) => text.length)).toEqual(["one", "three", "", "begin", "ning"]);
	expect(wrapLines("two 🍉🍊🍋", 2, (text) => [...text].length)).toEqual(["tw", "o", "🍉🍊", "🍋"]);
});

it("moves and resizes items inside the page, preserving the aspect of non-text items", () => {
	expect(moveBy(mark, -40, 1000, page)).toMatchObject({ x: 0, y: 480 });
	expect(resizeTo(mark, 64, page)).toMatchObject({ w: 64, h: 32 });
	const text: Item = { ...mark, kind: "text", text: "Hi", lines: ["Hi"], size: 12 };
	expect(resizeTo(text, 64, page)).toMatchObject({ w: 64, h: 20 });
});

it("uses distance to a stroke segment for erasing, including single-point strokes", () => {
	const item: Item = {
		id: "ink",
		page: 0,
		color: "#000000",
		kind: "ink",
		...normalizeStrokes(
			[
				[
					[10, 10],
					[20, 10],
				],
				[[30, 20]],
			],
			1,
		),
		width: 2,
	};
	expect(hitStroke(item, [15, 12], 2)).toBe(true);
	expect(hitStroke(item, [31, 20], 1)).toBe(true);
	expect(hitStroke(item, [20, 15], 2)).toBe(false);
});

it("undoes and redoes edits, resetting redo when a new edit is applied", () => {
	const added = editHistory(EMPTY_HISTORY, { type: "change", update: () => [mark] });
	const undone = editHistory(added, { type: "undo" });
	expect(undone.items).toEqual([]);
	expect(editHistory(undone, { type: "redo" }).items).toEqual([mark]);
	expect(editHistory(undone, { type: "change", update: () => [moveBy(mark, 20, 0, page)] }).future).toEqual([]);
});
