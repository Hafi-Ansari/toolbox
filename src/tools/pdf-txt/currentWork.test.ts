import { describe, expect, it } from "vitest";
import { currentWork } from "./currentWork.ts";
import type { Work } from "./engine/index.ts";

const work = (title: string, page: number, endPage: number, kind: Work["kind"] = "work"): Work => ({
	kind,
	title,
	page,
	endPage,
	source: "layout",
	confidence: 0.9,
	lines: [],
});

const book = [
	work("Copyright", 0, 1, "matter"),
	work("One", 2, 5),
	work("Two", 5, 5), // starts on the page where One ends, and ends there too
	work("Three", 5, 9),
	work("Notes", 10, 12, "matter"),
];

describe("currentWork", () => {
	it("shows the work that started most recently on a shared page", () => {
		expect(currentWork(book, 5, { matter: false })).toBe(3);
		expect(currentWork(book, 3, { matter: false })).toBe(1);
		expect(currentWork(book, 9, { matter: false })).toBe(3);
	});

	it("prefers the work holding the caret when it is on this page", () => {
		expect(currentWork(book, 5, { matter: false, preferred: 1 })).toBe(1);
		expect(currentWork(book, 5, { matter: false, preferred: 2 })).toBe(2);
		// The caret's work isn't on this page: fall back to the page.
		expect(currentWork(book, 8, { matter: false, preferred: 1 })).toBe(3);
	});

	it("skips front and back matter unless it is listed", () => {
		expect(currentWork(book, 0, { matter: false })).toBe(-1);
		expect(currentWork(book, 11, { matter: false })).toBe(-1);
		expect(currentWork(book, 11, { matter: true })).toBe(4);
		expect(currentWork(book, 0, { matter: false, preferred: 0 })).toBe(-1);
	});
});
