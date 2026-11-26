import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { detectBytes } from "../../../lib/detect.ts";
import { EpubBuilder } from "./epub.ts";
import { crc32, ZipWriter } from "./zip.ts";

function collect(): { sink: (c: Uint8Array) => void; bytes: () => Uint8Array } {
	const parts: Uint8Array[] = [];
	return {
		sink: (c) => parts.push(c.slice()),
		bytes: () => {
			const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
			let at = 0;
			for (const p of parts) {
				out.set(p, at);
				at += p.length;
			}
			return out;
		},
	};
}

describe("crc32", () => {
	it("matches the standard check value", () => {
		expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
	});
});

describe("ZipWriter", () => {
	it("produces an archive standard unzippers read, with sizes in local headers", () => {
		const out = collect();
		const zip = new ZipWriter(out.sink);
		const text = new TextEncoder().encode("hello ".repeat(200));
		zip.add("a.txt", text, true);
		zip.add("dir/b.bin", new Uint8Array([1, 2, 3]), false);
		zip.add("ünïcode.txt", new TextEncoder().encode("x"), false);
		zip.finish();
		const bytes = out.bytes();
		const files = unzipSync(bytes);
		expect(strFromU8(files["a.txt"])).toBe("hello ".repeat(200));
		expect([...files["dir/b.bin"]]).toEqual([1, 2, 3]);
		expect(files["ünïcode.txt"]).toBeDefined();
		// No data descriptor flag (bit 3) on the first entry.
		const flags = bytes[6] | (bytes[7] << 8);
		expect(flags & 0x8).toBe(0);
	});

	it("rejects duplicate names", () => {
		const zip = new ZipWriter(() => {});
		zip.add("x", new Uint8Array(1), false);
		expect(() => zip.add("x", new Uint8Array(1), false)).toThrow(/Duplicate/);
	});
});

describe("EpubBuilder", () => {
	function build(fixed = false) {
		const out = collect();
		const book = new EpubBuilder({ title: "T & T", author: "A", fixed }, out.sink);
		book.addImage("images/a.png", "image/png", new Uint8Array([137, 80, 78, 71]));
		book.addPage("c1.xhtml", "One", "<p>one</p>", fixed ? { width: 100, height: 200 } : undefined);
		book.addPage("c2.xhtml", "Two", "<p>two</p>", fixed ? { width: 100, height: 200 } : undefined);
		book.finish([
			{ title: "Part", href: "c1.xhtml", level: 1 },
			{ title: "One", href: "c1.xhtml", level: 2 },
			{ title: "Two", href: "c2.xhtml", level: 1 },
		]);
		return out.bytes();
	}

	it("starts with an uncompressed mimetype entry readers can sniff", () => {
		const bytes = build();
		expect(new TextDecoder().decode(bytes.subarray(30, 38))).toBe("mimetype");
		expect(new TextDecoder().decode(bytes.subarray(38, 58))).toBe("application/epub+zip");
		expect(bytes[8] | (bytes[9] << 8)).toBe(0); // method: stored
		expect(detectBytes(bytes.subarray(0, 4096))).toBe("epub");
	});

	it("lists every zip entry in the OPF manifest and marks the cover", () => {
		const files = unzipSync(build());
		const opf = strFromU8(files["OEBPS/content.opf"]);
		const hrefs = [...opf.matchAll(/href="([^"]+)"/g)].map((m) => `OEBPS/${m[1]}`).sort();
		const entries = Object.keys(files)
			.filter((n) => n.startsWith("OEBPS/") && n !== "OEBPS/content.opf")
			.sort();
		expect(hrefs).toEqual(entries);
		expect(opf).toContain('properties="cover-image"');
		expect(opf).toContain('properties="nav"');
		expect(opf).toContain("<dc:title>T &amp; T</dc:title>");
		expect(opf.match(/<itemref /g)).toHaveLength(2);
	});

	it("nests the table of contents", () => {
		const nav = strFromU8(unzipSync(build())["OEBPS/nav.xhtml"]);
		expect(nav).toContain(
			'<ol><li><a href="c1.xhtml">Part</a><ol><li><a href="c1.xhtml">One</a></li></ol></li><li><a href="c2.xhtml">Two</a></li></ol>',
		);
	});

	it("declares fixed layout with a per-page viewport", () => {
		const files = unzipSync(build(true));
		expect(strFromU8(files["OEBPS/content.opf"])).toContain('<meta property="rendition:layout">pre-paginated</meta>');
		expect(strFromU8(files["OEBPS/c1.xhtml"])).toContain('<meta name="viewport" content="width=100, height=200"/>');
	});
});

describe("detectBytes", () => {
	it("recognizes PDFs and rejects other files", () => {
		expect(detectBytes(new TextEncoder().encode("%PDF-1.7\n"))).toBe("pdf");
		expect(detectBytes(new TextEncoder().encode("GIF89a"))).toBe("unknown");
	});
});
