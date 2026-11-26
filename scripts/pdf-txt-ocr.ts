// Runs on-demand OCR the way the PDF → TXT tool does (tesseract.js, best_int
// model, PSM 4, 300 dpi) and merges it into the conversion.
//   node scripts/pdf-txt-ocr.ts <file.pdf> poetry|prose [pages] [--flags] [--show 22,23]
// pages is 1-based ("22", "4,22", "20-24") or "scans" (pages that are scans:
// an OCR layer or no text at all, as the tool's batch action picks). Default: scans.
// OCR results are cached in out/ocr-cache/, the TXT goes to out/<name>.ocr.txt.
// --flags lists the OCR flags; --show prints the TXT lines from those pages.
import fs from "node:fs";
import path from "node:path";
import * as mupdf from "mupdf";
import { createWorker } from "tesseract.js";
import { openDocument } from "../src/lib/pdf/document.ts";
import { blockCachedHandle } from "../src/lib/pdf/fileStream.ts";
import { summarize, toTxt, txtLines } from "../src/tools/pdf-txt/engine/index.ts";
import { applyOcr, convertWithOcr, fromTesseract, type OcrPage } from "../src/tools/pdf-txt/engine/ocr.ts";
import { readPdf } from "../src/tools/pdf-txt/engine/read.ts";
import { OCR_DPI, OCR_PARAMS, pgm } from "../src/tools/pdf-txt/ocr/params.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const [file, mode, which = "scans"] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--show"));
if (!file || (mode !== "poetry" && mode !== "prose")) {
	console.error("usage: node scripts/pdf-txt-ocr.ts <file.pdf> poetry|prose [pages|scans] [--flags] [--show 22]");
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
const { pages, outline } = readPdf(doc);
const targets =
	which === "scans"
		? pages.filter((p) => p.ocr || p.imageOnly).map((p) => p.index)
		: which.split(",").flatMap((part) => {
				const [a, b] = part.split("-").map(Number);
				return Array.from({ length: (b ?? a) - a + 1 }, (_, k) => a + k - 1);
			});

const name = path.basename(file, path.extname(file));
const cacheDir = path.resolve("out", "ocr-cache");
fs.mkdirSync(cacheDir, { recursive: true });
const ocr = new Map<number, OcrPage>();
let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
let renderMs = 0;
let ocrMs = 0;
let fresh = 0;
for (const i of targets) {
	const cached = path.join(cacheDir, `${name}-p${i + 1}.json`);
	if (fs.existsSync(cached)) {
		ocr.set(i, JSON.parse(fs.readFileSync(cached, "utf8")));
		continue;
	}
	worker ??= await createWorker("eng", 1, {
		langPath: path.resolve("node_modules/@tesseract.js-data/eng/4.0.0_best_int"),
		cacheMethod: "none",
		gzip: true,
	});
	await worker.setParameters(OCR_PARAMS);
	const t0 = performance.now();
	const page = doc.loadPage(i);
	const scale = OCR_DPI / 72;
	const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false, true);
	const image = pgm(pix.getWidth(), pix.getHeight(), pix.getPixels());
	pix.destroy();
	page.destroy();
	const t1 = performance.now();
	const { data } = await worker.recognize(Buffer.from(image), {}, { blocks: true, text: false });
	const t2 = performance.now();
	renderMs += t1 - t0;
	ocrMs += t2 - t1;
	fresh++;
	const result = fromTesseract(data.blocks, i, scale);
	fs.writeFileSync(cached, JSON.stringify(result));
	ocr.set(i, result);
	process.stdout.write(`\r  OCR ${fresh} pages`);
}
await worker?.terminate();
if (fresh)
	console.log(
		`\r  OCR ${fresh} pages: render ${Math.round(renderMs / fresh)} ms/page, recognize ${Math.round(ocrMs / fresh)} ms/page`,
	);

const result = convertWithOcr(pages, outline, { mode }, ocr);
const merged = applyOcr(pages, ocr);
const totals = { added: 0, replaced: 0, differs: 0, dropped: 0 };
for (const s of merged.stats.values())
	for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += s[k];
const scanned = targets.filter((i) => pages[i]?.imageOnly).length;
console.log(`${path.basename(file)}: OCR on ${targets.length} pages (${scanned} without a text layer)`);
console.log(
	`  merge: added ${totals.added}, replaced ${totals.replaced}, differs ${totals.differs}, dropped ${totals.dropped}`,
);
const s = summarize(result);
console.log(
	`  flags: ${Object.entries(s.flags)
		.map(([k, n]) => `${k} ${n}`)
		.join(", ")}`,
);
if (args.includes("--flags"))
	for (const f of result.flags) if (f.kind.startsWith("ocr-")) console.log(`  p${f.page + 1} ${f.kind}: ${f.reason}`);
const show = option("--show");
if (show) {
	const want = new Set(show.split(",").map((n) => Number(n) - 1));
	for (const l of txtLines(result)) if (want.has(l.page)) console.log(`  p${l.page + 1} | ${l.text}`);
}
const dest = path.resolve("out", `${name}.ocr.txt`);
fs.writeFileSync(dest, toTxt(result), "utf8");
console.log(`  → ${dest}`);
doc.destroy();
