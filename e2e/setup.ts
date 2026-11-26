// Builds test fixtures with the Node engine:
//   out/sample.epub, out/sample.pdf, out/sample.fixed.epub  (via scripts/spike.ts)
//   out/hostile.epub  (scripts, handlers, remote resources — must all be inert in the reader)
//   out/stubborn.epub (publisher colors pinned with !important, as many web-downloaded books do)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { EpubBuilder } from "../src/tools/epub-pdf/engine/epub.ts";

function hostileEpub(file: string) {
	const parts: Uint8Array[] = [];
	const book = new EpubBuilder({ title: "Hostile Book" }, (c) => parts.push(c.slice()));
	book.addPage(
		"c1.xhtml",
		"Trap",
		`<h1>Trap chapter</h1>
<script>parent.__pwned = "script";</script>
<p>Plain text that should render.</p>
<img src="missing.png" onerror="parent.__pwned = 'onerror'" alt=""/>
<img src="https://tracker.invalid/pixel.png" alt=""/>
<p style="background: url(https://tracker.invalid/bg.png)">Styled paragraph.</p>
<p><a href="https://example.com/">External link</a> and <a href="javascript:parent.__pwned='link'">bad link</a></p>`,
	);
	book.finish([{ title: "Trap", href: "c1.xhtml", level: 1 }]);
	fs.writeFileSync(file, Buffer.concat(parts));
}

function stubbornEpub(file: string) {
	const parts: Uint8Array[] = [];
	const book = new EpubBuilder({ title: "Stubborn Colors" }, (c) => parts.push(c.slice()));
	book.addPage(
		"c1.xhtml",
		"Ink",
		`<style>
html body { color: #000000 !important; background: #ffffff !important; }
body div.calibre p.text, p { color: #000 !important; font-family: "Times New Roman" !important; font-size: 11px !important; }
.fill { -webkit-text-fill-color: #000000; }
</style>
<div class="calibre"><h1>Ink chapter</h1>
<p class="text">Pinned black paragraph.</p>
<p style="color: #000000 !important; background-color: #fff !important">Inline black paragraph.</p>
<p class="fill">Fill-color paragraph.</p>
<p class="text" style="text-align: center">Centered line.</p>
<p class="text" style="text-align: justify">Justified paragraph.</p></div>`,
	);
	book.finish([{ title: "Ink", href: "c1.xhtml", level: 1 }]);
	fs.writeFileSync(file, Buffer.concat(parts));
}

export default function setup() {
	if (!["out/sample.epub", "out/sample.pdf", "out/sample.fixed.epub"].every((f) => fs.existsSync(f))) {
		execFileSync(process.execPath, ["scripts/spike.ts"], { stdio: "ignore" });
	}
	hostileEpub("out/hostile.epub");
	stubbornEpub("out/stubborn.epub");
}
