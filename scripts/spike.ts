// End-to-end check of the conversion engine in Node (no browser needed).
//   node scripts/spike.ts                 → builds a sample EPUB, converts both directions
//   node scripts/spike.ts <file.pdf|epub>  → converts a real file
// Outputs land in ./out (git-ignored).
import fs from "node:fs";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import * as mupdf from "mupdf";
import { epubToPdf, type Format, inspect, pdfToEpub } from "../src/tools/epub-pdf/engine/convert.ts";
import { EpubBuilder } from "../src/tools/epub-pdf/engine/epub.ts";
import { blockCachedHandle, type StreamHandle } from "../src/tools/epub-pdf/engine/fileStream.ts";

const OUT = path.resolve("out");
fs.mkdirSync(OUT, { recursive: true });

function fileHandle(file: string): StreamHandle {
	const fd = fs.openSync(file, "r");
	const size = fs.fstatSync(fd).size;
	return blockCachedHandle(
		size,
		(pos, len) => {
			const buf = new Uint8Array(len);
			fs.readSync(fd, buf, 0, len, pos);
			return buf;
		},
		() => fs.closeSync(fd),
	);
}

function writeSink(file: string) {
	const fd = fs.openSync(file, "w");
	return {
		sink: (chunk: Uint8Array) => void fs.writeSync(fd, chunk),
		close: () => fs.closeSync(fd),
	};
}

const lorem =
	"The river ran wide and slow past the old mill, carrying leaves and the occasional branch toward the sea. Nobody in the village remembered when the wheel had last turned, but everyone had a story about it.";

function makeSampleEpub(file: string) {
	const out = writeSink(file);
	const book = new EpubBuilder({ title: "Sample River Book", author: "Test Author" }, out.sink);
	const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 320, 180], false);
	pix.clear(180);
	book.addImage("images/plate.png", "image/png", pix.asPNG().slice());
	pix.destroy();
	const nav = [];
	for (let c = 1; c <= 3; c++) {
		let body = `<h1>Chapter ${c}</h1>\n`;
		if (c === 2) body += `<figure><img src="images/plate.png" alt="" width="320" height="180"/></figure>\n`;
		for (let p = 0; p < 40; p++) body += `<p>${p === 0 ? "" : "Then "}${lorem} (${c}.${p + 1})</p>\n`;
		const href = `ch${c}.xhtml`;
		book.addPage(href, `Chapter ${c}`, body);
		nav.push({ title: `Chapter ${c}`, href, level: 1 });
	}
	book.finish(nav);
	out.close();
}

function listEpub(file: string) {
	const entries = unzipSync(fs.readFileSync(file));
	const names = Object.keys(entries);
	const raw = fs.readFileSync(file);
	console.log(
		`   entries: ${names.length}  first: ${names[0]}  mimetype@38: ${JSON.stringify(raw.subarray(38, 58).toString())}`,
	);
	const nav = entries["OEBPS/nav.xhtml"];
	if (nav) {
		const items = [...strFromU8(nav).matchAll(/<a href="([^"]+)">([^<]*)<\/a>/g)].map((m) => `${m[2]} → ${m[1]}`);
		console.log(`   nav: ${items.slice(0, 8).join(" | ")}${items.length > 8 ? ` … (+${items.length - 8})` : ""}`);
	}
	const firstChapter = names.find((n) => /chapter\d+\.xhtml$/.test(n));
	if (firstChapter) {
		const body = strFromU8(entries[firstChapter]).split("<body>")[1] ?? "";
		console.log(`   ${firstChapter}:\n${body.slice(0, 600).replace(/^/gm, "     ")}`);
	}
}

const progress = (() => {
	let last = 0;
	return (done: number, total: number, phase: string) => {
		const now = performance.now();
		if (now - last > 1000 || done === total) {
			last = now;
			process.stdout.write(`\r   ${phase} ${done}/${total}        `);
			if (done === total && total > 0) process.stdout.write("\n");
		}
	};
})();

function convertEpub(file: string) {
	console.log(`\nEPUB → PDF: ${file}`);
	const info = inspect(fileHandle(file), "epub");
	console.log("   info:", info);
	const t = performance.now();
	const pdf = epubToPdf(fileHandle(file), { width: 432, height: 648, fontSize: 11, margin: 54 }, progress);
	const dest = path.join(OUT, `${path.basename(file, ".epub")}.pdf`);
	fs.writeFileSync(dest, pdf);
	console.log(`   wrote ${dest} (${(pdf.length / 1024).toFixed(0)} KB) in ${Math.round(performance.now() - t)} ms`);
	const check = mupdf.Document.openDocument(pdf, "application/pdf");
	const outline = check.loadOutline() ?? [];
	const page = check.loadPage(0);
	console.log(
		`   check: ${check.countPages()} pages, bounds ${JSON.stringify(page.getBounds())}, outline: ${outline.map((o) => `${o.title}@${o.page}`).join(", ")}, title: ${check.getMetaData("info:Title")}`,
	);
	const st = page.toStructuredText("");
	const first = JSON.parse(st.asJSON()).blocks.find((b: { type: string }) => b.type === "text");
	console.log(`   first text block bbox (margin check): ${JSON.stringify(first?.bbox)}`);
	return dest;
}

function convertPdf(file: string) {
	console.log(`\nPDF → EPUB: ${file}`);
	console.log("   info:", inspect(fileHandle(file), "pdf"));
	const only = process.argv[3];
	const modes: ("reflow" | "fixed")[] = only === "reflow" || only === "fixed" ? [only] : ["reflow", "fixed"];
	for (const mode of modes) {
		const dest = path.join(OUT, `${path.basename(file, ".pdf")}.${mode}.epub`);
		const w = writeSink(dest);
		const r = pdfToEpub(fileHandle(file), { mode }, w.sink, progress);
		w.close();
		console.log(`   [${mode}] wrote ${dest} (${(r.bytes / 1024).toFixed(0)} KB, ${r.pages} pages) in ${r.ms} ms`);
		listEpub(dest);
	}
}

const arg = process.argv[2];
if (arg) {
	const head = fs.readFileSync(arg).subarray(0, 5).toString();
	const format: Format = head.startsWith("%PDF") ? "pdf" : "epub";
	format === "pdf" ? convertPdf(arg) : convertEpub(arg);
} else {
	const sample = path.join(OUT, "sample.epub");
	makeSampleEpub(sample);
	console.log(`Built ${sample}`);
	listEpub(sample);
	const pdf = convertEpub(sample);
	convertPdf(pdf);
}
