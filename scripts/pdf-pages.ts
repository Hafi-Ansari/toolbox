// Prints what the shared PDF engine reads from each page: positioned lines
// with font size and style, grouped into blocks, plus the page kind.
//   node scripts/pdf-pages.ts <file.pdf> [pages] [--json]
// pages is 1-based, e.g. "22" or "20-24". --json prints PageModels instead.
import fs from "node:fs";
import { openDocument } from "../src/lib/pdf/document.ts";
import { extractPage } from "../src/lib/pdf/extract.ts";
import { blockCachedHandle } from "../src/lib/pdf/fileStream.ts";
import type { PageModel } from "../src/lib/pdf/heuristics.ts";

const args = process.argv.slice(2);
const json = args.includes("--json");
const [file, range] = args.filter((a) => a !== "--json");
if (!file) {
	console.error("usage: node scripts/pdf-pages.ts <file.pdf> [pages] [--json]");
	process.exit(1);
}

const fd = fs.openSync(file, "r");
const handle = blockCachedHandle(
	fs.fstatSync(fd).size,
	(pos, len) => {
		const buf = new Uint8Array(len);
		fs.readSync(fd, buf, 0, len, pos);
		return buf;
	},
	() => fs.closeSync(fd),
);
const doc = openDocument(handle, "pdf");
const total = doc.countPages();
const [from, to] = range ? range.split("-").map(Number) : [1, total];
const last = Math.min(to ?? from, total);

const kind = (p: PageModel) => (p.imageOnly ? "image only" : p.ocr ? "OCR layer" : "text");
const r = (n: number) => Math.round(n);
const models: PageModel[] = [];
for (let i = from - 1; i < last; i++) {
	const page = doc.loadPage(i);
	const model = extractPage(page, i);
	page.destroy();
	if (json) {
		models.push(model);
		continue;
	}
	console.log(`\n=== page ${i + 1} (${r(model.width)}×${r(model.height)}, ${kind(model)})`);
	model.blocks.forEach((b, n) => {
		if (b.kind !== "text") return;
		console.log(`-- block ${n}`);
		for (const l of b.lines) {
			const style = `${l.size}pt${l.bold ? " bold" : ""}${l.italic ? " italic" : ""}`;
			console.log(`  [${r(l.x0)},${r(l.y0)} → ${r(l.x1)},${r(l.y1)} ${style}] ${l.text.trimEnd()}`);
		}
	});
}
if (json) console.log(JSON.stringify(models, null, 1));
doc.destroy();
