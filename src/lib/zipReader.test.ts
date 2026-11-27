import { describe, expect, it } from "vitest";
import { ZipReader } from "./zipReader.ts";
import { ZipWriter } from "./zipWriter.ts";

function build(add: (z: ZipWriter) => void): Blob {
	const parts: Uint8Array<ArrayBuffer>[] = [];
	const z = new ZipWriter((c) => parts.push(c.slice() as Uint8Array<ArrayBuffer>));
	add(z);
	z.finish();
	return new Blob(parts);
}

const enc = new TextEncoder();

describe("ZipReader", () => {
	it("reads stored and deflated entries written by ZipWriter", async () => {
		const blob = build((z) => {
			z.add("mimetype", enc.encode("application/epub+zip"), false);
			z.add("OEBPS/ch1.xhtml", enc.encode("<p>hello</p>".repeat(500)), true);
			z.add("OEBPS/ünï.txt", enc.encode("unicode"), true);
		});
		const zip = await ZipReader.open(blob);
		expect([...zip.entries.keys()]).toEqual(["mimetype", "OEBPS/ch1.xhtml", "OEBPS/ünï.txt"]);
		expect(await zip.text("mimetype")).toBe("application/epub+zip");
		expect(await zip.text("OEBPS/ch1.xhtml")).toBe("<p>hello</p>".repeat(500));
		expect(zip.entries.get("OEBPS/ch1.xhtml")?.method).toBe(8);
		expect(await zip.text("OEBPS/ünï.txt")).toBe("unicode");
	});

	it("reads ZIP64 archives (more than 65 535 entries)", async () => {
		const blob = build((z) => {
			for (let i = 0; i < 65_600; i++) z.add(`f${i}`, enc.encode(String(i)), false);
		});
		const zip = await ZipReader.open(blob);
		expect(zip.entries.size).toBe(65_600);
		expect(await zip.text("f65599")).toBe("65599");
	});

	it("rejects files that are not zips", async () => {
		await expect(ZipReader.open(new Blob(["not a zip at all"]))).rejects.toThrow(/Not a zip/);
	});

	it("reports missing entries", async () => {
		const zip = await ZipReader.open(build((z) => z.add("a", enc.encode("x"), false)));
		await expect(zip.bytes("b")).rejects.toThrow(/Missing/);
	});
});
