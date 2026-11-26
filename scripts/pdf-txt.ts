// Converts a PDF to TXT with the PDF → TXT engine and prints what it found.
//   node scripts/pdf-txt.ts <file.pdf> poetry|prose [--ref reference.txt] [--works] [--flags] [--no-outline]
// Writes out/<name>.txt. --ref compares titles and body lines against a
// reference TXT in the same export format (titles after three empty lines).
// --works lists every work with its pages; --flags lists every review flag;
// --no-outline ignores the PDF outline, to test layout detection alone.
import fs from "node:fs";
import path from "node:path";
import { openDocument } from "../src/lib/pdf/document.ts";
import { blockCachedHandle } from "../src/lib/pdf/fileStream.ts";
import { convert, summarize, type TxtResult, toTxt } from "../src/tools/pdf-txt/engine/index.ts";
import { compareToReference } from "../src/tools/pdf-txt/engine/measure.ts";
import { readPdf } from "../src/tools/pdf-txt/engine/read.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const [file, mode] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--ref"));
if (!file || (mode !== "poetry" && mode !== "prose")) {
	console.error(
		"usage: node scripts/pdf-txt.ts <file.pdf> poetry|prose [--ref reference.txt] [--works] [--flags] [--no-outline]",
	);
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
const t0 = performance.now();
const { pages, outline } = readPdf(doc);
const t1 = performance.now();
const result: TxtResult = convert(pages, flag("--no-outline") ? [] : outline, { mode });
const txt = toTxt(result);
const t2 = performance.now();
doc.destroy();

const out = path.resolve("out");
fs.mkdirSync(out, { recursive: true });
const dest = path.join(out, `${path.basename(file, path.extname(file))}.txt`);
fs.writeFileSync(dest, txt, "utf8");

const s = summarize(result);
console.log(`${path.basename(file)} → ${dest}`);
console.log(
	`  ${result.pages} pages, read ${Math.round(t1 - t0)} ms, convert ${Math.round(t2 - t1)} ms, detection: ${result.detection}`,
);
console.log(
	`  works ${s.works.work}, sections ${s.works.section}, matter ${s.works.matter} (left out), low-confidence ${s.lowConfidence}`,
);
console.log(
	`  flags: ${
		Object.entries(s.flags)
			.map(([k, n]) => `${k} ${n}`)
			.join(", ") || "none"
	}`,
);
if (s.needsOcr.length) console.log(`  needs OCR: pages ${s.needsOcr.map((p) => p + 1).join(", ")}`);
if (flag("--works"))
	for (const w of result.works)
		console.log(
			`  [${w.kind}] p${w.page + 1}-${w.endPage + 1} ${w.source} ${w.confidence.toFixed(2)} ${w.title || "(untitled)"} — ${w.lines.filter((l) => l.text).length} lines`,
		);
if (flag("--flags")) for (const f of result.flags) console.log(`  p${f.page + 1} ${f.kind}: ${f.reason}`);

const ref = option("--ref");
if (ref) {
	const m = compareToReference(result, fs.readFileSync(ref, "utf8"));
	console.log(`\nAgainst ${path.basename(ref)}:`);
	console.log(
		`  titles: ${m.titlesFound}/${m.refTitles} found, ${m.titlesExact}/${m.refTitles} exact after normalizing; ${m.extraTitles} extra`,
	);
	console.log(
		`  body lines: ${m.bodyMatched}/${m.refBodyLines} reference lines matched in order (${((100 * m.bodyMatched) / m.refBodyLines).toFixed(1)}%), ours ${m.ourBodyLines}`,
	);
	console.log(
		`  works whose body matches in full: ${m.worksFull}/${m.refTitles}; grouping: ${m.groupingOk}/${m.titlesFound} found works hold the same lines`,
	);
	for (const d of m.titleDiffs) console.log(`    ${d}`);
}
