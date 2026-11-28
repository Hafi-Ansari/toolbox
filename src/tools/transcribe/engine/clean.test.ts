import { describe, expect, it } from "vitest";
import { cleanSegments, collapseLoops } from "./clean.ts";

const never = () => false;
const always = () => true;

describe("collapseLoops", () => {
	it("collapses a word or phrase repeated four or more times", () => {
		expect(collapseLoops("and the the the the the end")).toBe("and the end");
		expect(collapseLoops("I mean, you know, you know, you know, you know, right")).toBe("I mean, you know, right");
	});

	it("leaves ordinary repetition alone", () => {
		expect(collapseLoops("no, no, no. That's wrong")).toBe("no, no, no. That's wrong");
		expect(collapseLoops("one dollar and eighty-seven cents")).toBe("one dollar and eighty-seven cents");
	});
});

describe("cleanSegments", () => {
	it("drops silence phrases only over quiet audio", () => {
		const segs = [{ start: 10, end: 12, text: " Thank you." }];
		expect(cleanSegments(segs, always)).toEqual([]);
		expect(cleanSegments(segs, never)).toEqual([{ start: 10, end: 12, text: "Thank you." }]);
	});

	it("drops empty and punctuation-only segments", () => {
		expect(cleanSegments([{ start: 0, end: 1, text: " ... " }], never)).toEqual([]);
	});

	it("drops a long sentence repeated straight after itself, even across windows", () => {
		const previous = { start: 0, end: 5, text: "We are going to talk about parameter count." };
		const segs = [
			{ start: 5, end: 10, text: "We are going to talk about parameter count." },
			{ start: 10, end: 11, text: "Yeah." },
			{ start: 11, end: 12, text: "Yeah." },
		];
		expect(cleanSegments(segs, never, previous).map((s) => s.text)).toEqual(["Yeah.", "Yeah."]);
	});

	it("keeps lines in time order", () => {
		const out = cleanSegments(
			[
				{ start: 30, end: 31, text: "later" },
				{ start: 29.5, end: 32, text: "overlapping" },
			],
			never,
		);
		expect(out.map((s) => s.start)).toEqual([30, 30]);
	});
});
