import { expect, it } from "vitest";
import type { Entry } from "./listing.ts";
import { splitOutput } from "./split.ts";

const items = [2, 0, 3, 0].map(
	(size, index): Entry => ({ path: `Entry ${index}`, size, folder: false, encrypted: false }),
);

it("streams across file boundaries and emits leading, middle, or trailing empty files", () => {
	const files: { index: number; data: string }[] = [];
	const split = splitOutput(items, [0, 1, 2, 3], {
		start: (index) => files.push({ index, data: "" }),
		write: (chunk) => {
			files[files.length - 1].data += Buffer.from(chunk).toString();
		},
		end() {},
	});
	split.write(Buffer.from("A"));
	split.write(Buffer.from("BCDE"));
	split.finish();
	expect(files).toEqual([
		{ index: 0, data: "AB" },
		{ index: 1, data: "" },
		{ index: 2, data: "CDE" },
		{ index: 3, data: "" },
	]);
});

it("rejects incomplete or oversized output", () => {
	const sink = { start() {}, write() {}, end() {} };
	expect(() => splitOutput(items, [0], sink).finish()).toThrow("headers don't match");
	expect(() => splitOutput(items, [0], sink).write(Buffer.from("ABC"))).toThrow("headers don't match");
});
