import { expect, it } from "vitest";
import { pagedBuffer } from "./output.ts";

it("applies positioned writes across pages, including a later header patch", () => {
	const memory = pagedBuffer(4);
	memory.write(0, new Uint8Array([0, 0, 0]));
	memory.write(3, new Uint8Array([4, 5, 6, 7, 8, 9]));
	memory.write(0, new Uint8Array([1, 2, 3]));
	expect(memory.size).toBe(9);
	const parts = memory.parts();
	expect(parts.map((part) => part.length)).toEqual([4, 4, 1]);
	expect([...new Uint8Array(Buffer.concat(parts))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
	memory.truncate(5);
	memory.write(6, new Uint8Array([7]));
	expect([...new Uint8Array(Buffer.concat(memory.parts()))]).toEqual([1, 2, 3, 4, 5, 0, 7]);
	memory.clear();
	expect(memory.parts()).toEqual([]);
});
