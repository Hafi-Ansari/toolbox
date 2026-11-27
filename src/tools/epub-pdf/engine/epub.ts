// EPUB 3 packager. Content is streamed into the zip as it is added; the
// package document (OPF) and navigation are written last, which is valid
// because only `mimetype` has to come first.
import { cleanText } from "../../../lib/pdf/text.ts";
import { type ChunkSink, ZipWriter } from "../../../lib/zipWriter.ts";

export interface EpubMeta {
	title: string;
	author?: string;
	language?: string;
	/** Fixed-layout books declare their page viewport here. */
	fixed?: boolean;
}

export interface NavEntry {
	title: string;
	href: string;
	level: number;
}

interface ManifestItem {
	id: string;
	href: string;
	mediaType: string;
	properties?: string;
	spine: boolean;
}

const enc = new TextEncoder();

export function escapeXml(s: string): string {
	return s.replace(/[&<>"']/g, (c) =>
		c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&apos;",
	);
}

export const BASE_CSS = `html { -webkit-text-size-adjust: 100%; }
body { margin: 0 5%; line-height: 1.5; font-family: serif; }
p { margin: 0; text-indent: 1.5em; text-align: justify; }
h1 + p, h2 + p, h3 + p, figure + p, .first { text-indent: 0; }
h1, h2, h3 { font-family: sans-serif; line-height: 1.25; text-align: left; margin: 1.5em 0 0.75em; }
h1 { font-size: 1.6em; }
h2 { font-size: 1.3em; }
h3 { font-size: 1.1em; }
figure { margin: 1em 0; text-align: center; }
figure img { max-width: 100%; height: auto; }
`;

export class EpubBuilder {
	private readonly zip: ZipWriter;
	private readonly items: ManifestItem[] = [];
	private nextId = 1;
	private coverAssigned = false;
	private readonly meta: EpubMeta;

	constructor(meta: EpubMeta, sink: ChunkSink) {
		this.meta = meta;
		this.zip = new ZipWriter(sink);
		this.zip.add("mimetype", enc.encode("application/epub+zip"), false);
		this.zip.add(
			"META-INF/container.xml",
			enc.encode(
				`<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>\n`,
			),
			true,
		);
		if (!meta.fixed) this.addFile("style.css", "text/css", enc.encode(BASE_CSS), true, false);
	}

	get bytesWritten(): number {
		return this.zip.bytesWritten;
	}

	get language(): string {
		return this.meta.language || "en";
	}

	/** Adds an XHTML content document built from a body fragment. */
	addPage(href: string, title: string, bodyHtml: string, viewport?: { width: number; height: number }): void {
		const lang = escapeXml(this.language);
		const head = viewport
			? `<meta name="viewport" content="width=${viewport.width}, height=${viewport.height}"/>\n<style>html,body{margin:0;padding:0;}img{display:block;width:${viewport.width}px;height:${viewport.height}px;}</style>`
			: `<link rel="stylesheet" type="text/css" href="style.css"/>`;
		const doc = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head>
<meta charset="UTF-8"/>
<title>${escapeXml(cleanText(title))}</title>
${head}
</head>
<body>
${bodyHtml}
</body>
</html>
`;
		this.addFile(href, "application/xhtml+xml", enc.encode(doc), true, true);
	}

	/** Adds an already-encoded image. JPEG/PNG are stored without recompression. */
	addImage(href: string, mediaType: string, data: Uint8Array): void {
		let properties: string | undefined;
		if (!this.coverAssigned) {
			properties = "cover-image";
			this.coverAssigned = true;
		}
		this.addFile(href, mediaType, data, false, false, properties);
	}

	finish(nav: NavEntry[]): void {
		const navBody =
			nav.length > 0 ? nav : [{ title: this.meta.title || "Start", href: this.firstSpineHref(), level: 1 }];
		this.addFile("nav.xhtml", "application/xhtml+xml", enc.encode(this.renderNav(navBody)), true, false, "nav");
		this.zip.add("OEBPS/content.opf", enc.encode(this.renderOpf()), true);
		this.zip.finish();
	}

	private addFile(
		href: string,
		mediaType: string,
		data: Uint8Array,
		compress: boolean,
		spine: boolean,
		properties?: string,
	): void {
		this.zip.add(`OEBPS/${href}`, data, compress);
		this.items.push({ id: `i${this.nextId++}`, href, mediaType, properties, spine });
	}

	private firstSpineHref(): string {
		const first = this.items.find((i) => i.spine);
		if (!first) throw new Error("EPUB has no content documents");
		return first.href;
	}

	private renderNav(nav: NavEntry[]): string {
		const lang = escapeXml(this.language);
		// Build a properly nested <ol> from flat (title, level) entries.
		let html = "";
		let depth = 0;
		const baseLevel = Math.min(...nav.map((n) => n.level));
		for (const entry of nav) {
			const level = Math.max(1, Math.min(entry.level - baseLevel + 1, depth + 1));
			if (level > depth) {
				// Opens the first list, or a nested list inside the still-open <li>.
				html += "<ol>";
				depth++;
			} else {
				html += "</li>";
				while (depth > level) {
					html += "</ol></li>";
					depth--;
				}
			}
			html += `<li><a href="${escapeXml(entry.href)}">${escapeXml(cleanText(entry.title)) || "Untitled"}</a>`;
		}
		html += "</li>";
		while (depth > 1) {
			html += "</ol></li>";
			depth--;
		}
		html += "</ol>";
		return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head><meta charset="UTF-8"/><title>Contents</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>Contents</h1>
${html}
</nav>
</body>
</html>
`;
	}

	private renderOpf(): string {
		const m = this.meta;
		const id = `urn:uuid:${crypto.randomUUID()}`;
		const modified = `${new Date().toISOString().slice(0, 19)}Z`;
		const fixedMeta = m.fixed
			? `\n    <meta property="rendition:layout">pre-paginated</meta>\n    <meta property="rendition:spread">none</meta>`
			: "";
		const manifest = this.items
			.map(
				(i) =>
					`    <item id="${i.id}" href="${escapeXml(i.href)}" media-type="${i.mediaType}"${i.properties ? ` properties="${i.properties}"` : ""}/>`,
			)
			.join("\n");
		const spine = this.items
			.filter((i) => i.spine)
			.map((i) => `    <itemref idref="${i.id}"/>`)
			.join("\n");
		return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${escapeXml(this.language)}"${m.fixed ? ` prefix="rendition: http://www.idpf.org/vocab/rendition/#"` : ""}>
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${id}</dc:identifier>
    <dc:title>${escapeXml(cleanText(m.title || "Untitled"))}</dc:title>
    <dc:language>${escapeXml(this.language)}</dc:language>${m.author ? `\n    <dc:creator>${escapeXml(cleanText(m.author))}</dc:creator>` : ""}
    <meta property="dcterms:modified">${modified}</meta>${fixedMeta}
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine>
${spine}
  </spine>
</package>
`;
	}
}
