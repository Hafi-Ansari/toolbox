import { expect, it } from "vitest";
import { fromEntries, fromInput } from "./collect.ts";

type Node = { [name: string]: Node | string };

/** A dropped `FileSystemEntry` tree; directories list in pages of 2, as readEntries pages its results. */
function entry(name: string, node: Node | string, parent = ""): FileSystemEntry {
	const fullPath = `${parent}/${name}`;
	if (typeof node === "string") {
		return {
			name,
			fullPath,
			isFile: true,
			isDirectory: false,
			file: (ok: (f: File) => void, fail: (e: Error) => void) =>
				node === "!" ? fail(new Error("gone")) : ok(new File([node], name)),
		} as unknown as FileSystemEntry;
	}
	const children = Object.entries(node).map(([n, v]) => entry(n, v, fullPath));
	return {
		name,
		fullPath,
		isFile: false,
		isDirectory: true,
		createReader: () => {
			let at = 0;
			return {
				readEntries: (ok: (e: FileSystemEntry[]) => void) => {
					at += 2;
					ok(children.slice(at - 2, at));
				},
			};
		},
	} as unknown as FileSystemEntry;
}

it("walks dropped folders with relative paths, in a stable order", async () => {
	const trip = entry("Trip", { "a.jpg": "a", "Day 1": { "b.jpg": "bb", "c.jpg": "ccc", "d.jpg": "!" }, "e.txt": "" });
	const loose = entry("loose.txt", "x");
	const { files, skipped } = await fromEntries([trip, loose]);
	expect(files.map((f) => [f.path, f.file.size])).toEqual([
		["Trip/a.jpg", 1],
		["Trip/Day 1/b.jpg", 2],
		["Trip/Day 1/c.jpg", 3],
		["Trip/e.txt", 0],
		["loose.txt", 1],
	]);
	expect(skipped).toEqual(["Trip/Day 1/d.jpg"]);
});

it("takes plain file input names", () => {
	const { files } = fromInput([new File(["1"], "one.jpg"), new File(["22"], "two.mov")]);
	expect(files.map((f) => f.path)).toEqual(["one.jpg", "two.mov"]);
});
