// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ZipWriter } from "../../lib/zipWriter.ts";
import { EpubBuilder } from "../epub-pdf/engine/epub.ts";
import { chapterTitle, flattenToc, openBook, resolvePath } from "./book.ts";
import { sanitize } from "./render.ts";

const enc = new TextEncoder();

function collect() {
	const parts: Uint8Array<ArrayBuffer>[] = [];
	return { sink: (c: Uint8Array) => parts.push(c.slice() as Uint8Array<ArrayBuffer>), blob: () => new Blob(parts) };
}

function epub3(fixed = false): Blob {
	const out = collect();
	const b = new EpubBuilder({ title: "River & Mill", author: "A. Author", fixed }, out.sink);
	b.addImage("images/cover.png", "image/png", new Uint8Array([137, 80, 78, 71]));
	b.addPage("c1.xhtml", "One", '<h1 id="one">One</h1><p>first</p>');
	b.addPage("c2.xhtml", "Two", "<p>second</p>");
	b.addPage("c3.xhtml", "Three", "<p>third</p>");
	b.finish([
		{ title: "Part", href: "c1.xhtml", level: 1 },
		{ title: "One", href: "c1.xhtml#one", level: 2 },
		{ title: "Two", href: "c2.xhtml", level: 2 },
		{ title: "Three", href: "c3.xhtml", level: 1 },
	]);
	return out.blob();
}

/** A minimal EPUB 2 with an NCX table of contents and a <meta name="cover">. */
function epub2(): Blob {
	const out = collect();
	const z = new ZipWriter(out.sink);
	z.add("mimetype", enc.encode("application/epub+zip"), false);
	z.add(
		"META-INF/container.xml",
		enc.encode(
			'<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
		),
		true,
	);
	z.add(
		"content/book.opf",
		enc.encode(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">isbn-1</dc:identifier><dc:title>Old Book</dc:title><dc:language>fr</dc:language><meta name="cover" content="cov"/></metadata>
<manifest>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="cov" href="img/front%20cover.jpg" media-type="image/jpeg"/>
<item id="a" href="text/a.html" media-type="application/xhtml+xml"/>
<item id="b" href="text/b.html" media-type="application/xhtml+xml"/>
</manifest>
<spine toc="ncx"><itemref idref="a"/><itemref idref="b" linear="no"/></spine>
</package>`),
		true,
	);
	z.add(
		"content/toc.ncx",
		enc.encode(`<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
<navPoint id="n1"><navLabel><text>Chapter A</text></navLabel><content src="text/a.html"/>
  <navPoint id="n2"><navLabel><text>Section A.1</text></navLabel><content src="text/a.html#s1"/></navPoint>
</navPoint>
<navPoint id="n3"><navLabel><text>Chapter B</text></navLabel><content src="text/b.html"/></navPoint>
</navMap></ncx>`),
		true,
	);
	z.add("content/img/front cover.jpg", new Uint8Array([255, 216, 255]), false);
	z.add("content/text/a.html", enc.encode("<html><body><p>a</p></body></html>"), true);
	z.add("content/text/b.html", enc.encode("<html><body><p>b</p></body></html>"), true);
	z.finish();
	return out.blob();
}

describe("resolvePath", () => {
	it("resolves relative hrefs and splits fragments", () => {
		expect(resolvePath("OEBPS/text/ch1.xhtml", "../images/a%20b.png")).toEqual(["OEBPS/images/a b.png", ""]);
		expect(resolvePath("OEBPS/ch1.xhtml", "ch2.xhtml#sec")).toEqual(["OEBPS/ch2.xhtml", "sec"]);
		expect(resolvePath("OEBPS/ch1.xhtml", "https://example.com/x")).toEqual(["", ""]);
	});
});

describe("openBook (EPUB 3)", () => {
	it("reads metadata, spine, nested nav TOC and cover", async () => {
		const book = await openBook(epub3());
		expect(book.title).toBe("River & Mill");
		expect(book.author).toBe("A. Author");
		expect(book.spine.map((s) => s.path)).toEqual(["OEBPS/c1.xhtml", "OEBPS/c2.xhtml", "OEBPS/c3.xhtml"]);
		expect(book.fixed).toBe(false);
		expect(book.coverPath).toBe("OEBPS/images/cover.png");
		expect(book.toc.map((t) => t.title)).toEqual(["Part", "Three"]);
		expect(book.toc[0].children.map((t) => [t.title, t.spine, t.fragment])).toEqual([
			["One", 0, "one"],
			["Two", 1, ""],
		]);
		expect(chapterTitle(book, 1)).toBe("Two");
		expect(flattenToc(book.toc).map((t) => t.depth)).toEqual([0, 1, 1, 0]);
		expect(book.totalSize).toBeGreaterThan(0);
	});

	it("detects fixed layout", async () => {
		const book = await openBook(epub3(true));
		expect(book.fixed).toBe(true);
		expect(book.spine.every((s) => s.fixed)).toBe(true);
	});

	it("gives the same id to the same book", async () => {
		expect((await openBook(epub2())).id).toBe((await openBook(epub2())).id);
	});
});

describe("openBook (EPUB 2)", () => {
	it("reads the NCX table of contents, cover meta, encoded paths and linear=no", async () => {
		const book = await openBook(epub2());
		expect(book.title).toBe("Old Book");
		expect(book.language).toBe("fr");
		expect(book.coverPath).toBe("content/img/front cover.jpg");
		expect(book.spine.map((s) => s.linear)).toEqual([true, false]);
		expect(book.toc.map((t) => t.title)).toEqual(["Chapter A", "Chapter B"]);
		expect(book.toc[0].children[0]).toMatchObject({ title: "Section A.1", spine: 0, fragment: "s1" });
	});
});

describe("openBook errors", () => {
	it("rejects non-zip and non-EPUB files", async () => {
		await expect(openBook(new Blob(["hello"]))).rejects.toThrow(/valid EPUB/);
		const out = collect();
		const z = new ZipWriter(out.sink);
		z.add("readme.txt", enc.encode("hi"), false);
		z.finish();
		await expect(openBook(out.blob())).rejects.toThrow(/container\.xml/);
	});
});

describe("sanitize", () => {
	it("removes scripts, frames, forms, handlers and javascript: URLs", () => {
		const doc = new DOMParser().parseFromString(
			`<body><p onclick="x()">t</p><script>alert(1)</script><object data="x.swf"></object><form><input></form>
			<img src="a.png" onerror="steal()"><a href="javascript:alert(1)">l</a><a href="ch2.xhtml">ok</a></body>`,
			"text/html",
		);
		sanitize(doc.body);
		const html = doc.body.innerHTML;
		expect(html).not.toMatch(/script|<object|<form|onclick|onerror|javascript:/i);
		expect(html).toContain('<img src="a.png">');
		expect(html).toContain('href="ch2.xhtml"');
	});
});
