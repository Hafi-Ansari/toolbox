// Turns a spine item into a safe, self-contained HTML document for a
// sandboxed iframe. Book content is untrusted, so:
//   - scripts, frames, forms, event handlers and javascript: URLs are removed
//   - every resource (images, fonts, CSS) is rewritten to a blob: URL from the zip
//   - a CSP meta blocks all network access (no tracking pixels, no remote fonts)
// Links are rewritten to data attributes the reader handles itself.
import { type Book, parseXml, resolvePath } from "./book.ts";

export interface Chapter {
	index: number;
	/** Complete HTML document for iframe.srcdoc (reader styles are added separately). */
	html: string;
	/** Fixed-layout page size from the chapter's viewport meta. */
	viewport?: { width: number; height: number };
	/** Image/media blob URLs owned by this chapter; revoked when it is dropped. */
	urls: string[];
}

export const CSP =
	"default-src 'none'; img-src blob: data:; media-src blob: data:; style-src 'unsafe-inline' blob: data:; font-src blob: data:";

const STRIP_ELEMENTS =
	"script, noscript, iframe, frame, frameset, object, embed, applet, form, base, meta[http-equiv], portal";
const URL_ATTRS = ["src", "href", "poster", "data"];
const XLINK = "http://www.w3.org/1999/xlink";
/** url(x), url('x') or url("x"); group 2 is the reference. */
const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;

const MIME_BY_EXT: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	avif: "image/avif",
	ttf: "font/ttf",
	otf: "font/otf",
	woff: "font/woff",
	woff2: "font/woff2",
	css: "text/css",
	mp3: "audio/mpeg",
	mp4: "video/mp4",
	m4a: "audio/mp4",
};

/**
 * Publisher CSS goes into a cascade layer that comes after the reader's. For normal
 * declarations later layers win, so the book's own design still applies; for !important
 * ones earlier layers win, so the reader's overrides (colors, fonts, size) beat the book's
 * even when it uses !important with high specificity. `@namespace` can't live inside a
 * layer block, so it is hoisted; `@charset` is meaningless in a <style> and dropped.
 */
export const LAYER_ORDER = "@layer reader, publisher;";

export function layered(css: string, layer = "publisher"): string {
	const hoisted: string[] = [];
	const body = relativeSizes(css)
		.replace(/@charset\s+[^;]*;/gi, "")
		.replace(/@namespace\s+[^;]*;/gi, (m) => {
			hoisted.push(m);
			return "";
		});
	return `${hoisted.join("\n")}\n@layer ${layer} {\n${body}\n}`;
}

const KEYWORD_REM: Record<string, number> = {
	"xx-small": 0.5625,
	"x-small": 0.625,
	small: 0.8125,
	medium: 1,
	large: 1.125,
	"x-large": 1.5,
	"xx-large": 2,
	"xxx-large": 3,
};

/**
 * Absolute font sizes (px, pt, keywords) would ignore the reader's text size, so they
 * become rem against the usual 16px base: 12px → 0.75rem, 11pt → 0.917rem. The reader
 * sets the root size, so the book's proportions survive and everything scales together.
 */
export function relativeSizes(css: string): string {
	return css.replace(
		/(font-size\s*:\s*)(?:(\d*\.?\d+)(px|pt)\b|(xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large)\b)/gi,
		(_m, prop: string, n: string | undefined, unit: string | undefined, kw: string | undefined) => {
			const rem = kw ? KEYWORD_REM[kw.toLowerCase()] : (Number(n) * (unit?.toLowerCase() === "pt" ? 4 / 3 : 1)) / 16;
			return `${prop}${Number(rem.toFixed(4))}rem`;
		},
	);
}

/** Inline styles outrank every layer, so their !important flags are dropped (the declarations stay). */
export function softenInline(style: string): string {
	return relativeSizes(style.replace(/\s*!\s*important/gi, ""));
}

/** Per-book resource cache. Fonts and stylesheets are shared across chapters; images are per chapter. */
export class Resources {
	private readonly book: Book;
	private shared = new Map<string, Promise<string>>();
	private css = new Map<string, Promise<string>>();

	constructor(book: Book) {
		this.book = book;
	}

	private mime(path: string): string {
		return (
			this.book.manifest.get(path)?.mediaType ||
			MIME_BY_EXT[path.split(".").pop()?.toLowerCase() ?? ""] ||
			"application/octet-stream"
		);
	}

	/**
	 * A blob: URL for a zip entry. With an `owner` list the URL belongs to one chapter and is
	 * revoked with it; without one (fonts, anything referenced from CSS) it lives for the whole book.
	 */
	async url(path: string, owner: string[] | null): Promise<string | null> {
		if (!this.book.zip.has(path)) return null;
		const type = this.mime(path);
		if (type === "text/css") return null; // stylesheets are inlined instead
		if (!owner || /font/.test(type) || /\.(ttf|otf|woff2?)$/i.test(path)) {
			let p = this.shared.get(path);
			if (!p) {
				p = this.book.zip.blobOf(path, type).then((b) => URL.createObjectURL(b));
				this.shared.set(path, p);
			}
			return p;
		}
		const url = URL.createObjectURL(await this.book.zip.blobOf(path, type));
		owner.push(url);
		return url;
	}

	/** Stylesheet text with url() and @import resolved (recursively, inlined). Cached per book. */
	stylesheet(path: string, depth = 0): Promise<string> {
		let p = this.css.get(path);
		if (!p) {
			p = this.book.zip.has(path)
				? this.book.zip.text(path).then((css) => this.rewriteCss(css, path, depth))
				: Promise.resolve("");
			this.css.set(path, p);
		}
		return p;
	}

	async rewriteCss(css: string, base: string, depth = 0): Promise<string> {
		// @import "x.css" / @import url(x.css) → inline the imported sheet.
		const imports = [...css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/gi)];
		for (const m of imports) {
			const [path] = resolvePath(base, m[1]);
			const inner = depth < 4 && path ? await this.stylesheet(path, depth + 1) : "";
			css = css.replace(m[0], inner);
		}
		const refs = [...new Set([...css.matchAll(CSS_URL)].map((m) => m[2].trim()))];
		const map = new Map<string, string>();
		for (const ref of refs) {
			if (/^(data|blob):/i.test(ref) || ref.startsWith("#")) continue;
			const [path] = resolvePath(base, ref);
			const url = path ? await this.url(path, null) : null;
			map.set(ref, url ?? "data:,");
		}
		return css.replace(CSS_URL, (whole, _q, ref: string) =>
			map.has(ref.trim()) ? `url("${map.get(ref.trim())}")` : whole,
		);
	}

	dispose() {
		for (const p of this.shared.values()) void p.then((u) => URL.revokeObjectURL(u));
		this.shared.clear();
		this.css.clear();
	}
}

function parseViewport(doc: Document): { width: number; height: number } | undefined {
	const meta = Array.from(doc.getElementsByTagName("*")).find(
		(m) => m.localName === "meta" && m.getAttribute("name") === "viewport",
	);
	const content = meta?.getAttribute("content") ?? "";
	const w = Number(/width\s*=\s*(\d+(?:\.\d+)?)/i.exec(content)?.[1]);
	const h = Number(/height\s*=\s*(\d+(?:\.\d+)?)/i.exec(content)?.[1]);
	return w > 0 && h > 0 ? { width: w, height: h } : undefined;
}

/** Removes active content. Exported for tests. */
export function sanitize(root: Element) {
	for (const el of Array.from(root.querySelectorAll(STRIP_ELEMENTS))) el.remove();
	for (const el of Array.from(root.querySelectorAll("*"))) {
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase();
			if (name.startsWith("on") || name === "srcdoc" || name === "formaction") el.removeAttribute(attr.name);
			else if (/^\s*(javascript|vbscript):/i.test(attr.value)) el.removeAttribute(attr.name);
		}
	}
}

export async function renderChapter(
	book: Book,
	index: number,
	resources: Resources,
	readerCss: string,
): Promise<Chapter> {
	const item = book.spine[index];
	const source = parseXml(await book.zip.text(item.path));
	const viewport = item.fixed ? parseViewport(source) : undefined;
	const urls: string[] = [];

	// Build a fresh HTML document so the result serializes as HTML (no XML self-closing tags).
	const out = document.implementation.createHTMLDocument("");
	const all = Array.from(source.getElementsByTagName("*"));
	const srcHead = all.find((el) => el.localName === "head");
	const srcBody = all.find((el) => el.localName === "body") ?? source.documentElement;

	// Styles: <link rel=stylesheet> and <style>, in document order, inlined with rewritten URLs.
	const styles: string[] = [];
	for (const el of Array.from(srcHead?.children ?? [])) {
		if (el.localName === "link" && /stylesheet/i.test(el.getAttribute("rel") ?? "")) {
			const [path] = resolvePath(item.path, el.getAttribute("href") ?? "");
			if (path) styles.push(await resources.stylesheet(path));
		} else if (el.localName === "style") {
			styles.push(await resources.rewriteCss(el.textContent ?? "", item.path));
		}
	}

	const body = out.importNode(srcBody, true) as Element;
	sanitize(body);

	// Resources and links inside the body.
	for (const el of Array.from(body.querySelectorAll("*"))) {
		const isAnchor = el.localName === "a";
		for (const attr of [...URL_ATTRS, "xlink:href"]) {
			const value = attr === "xlink:href" ? el.getAttributeNS(XLINK, "href") : el.getAttribute(attr);
			if (value == null) continue;
			if (isAnchor && (attr === "href" || attr === "xlink:href")) {
				// Links are resolved here and followed by the reader (the iframe can't navigate itself).
				if (/^(https?|mailto):/i.test(value)) el.setAttribute("data-external", value);
				else {
					const [path, fragment] = resolvePath(item.path, value);
					const spine = path ? book.spineIndex(path) : -1;
					if (spine >= 0) el.setAttribute("data-target", `${spine}#${fragment}`);
				}
				continue;
			}
			if (/^(data|blob):/i.test(value) || value.startsWith("#")) continue;
			const [path] = resolvePath(item.path, value);
			const url = path ? await resources.url(path, urls) : null;
			if (attr === "xlink:href") {
				el.removeAttributeNS(XLINK, "href");
				if (url) el.setAttribute("href", url);
			} else if (url) el.setAttribute(attr, url);
			else el.removeAttribute(attr);
		}
		const srcset = el.getAttribute("srcset");
		if (srcset) el.removeAttribute("srcset"); // src is enough; avoids resolving every candidate
		let style = el.getAttribute("style");
		if (style && /url\(/i.test(style)) style = await resources.rewriteCss(style, item.path);
		if (style != null) el.setAttribute("style", softenInline(style));
	}

	for (const style of Array.from(body.querySelectorAll("style"))) {
		style.textContent = layered(await resources.rewriteCss(style.textContent ?? "", item.path));
	}

	// Carry body classes/ids/dir/lang (publishers style on them).
	const html = out.documentElement;
	const lang =
		source.documentElement.getAttribute("xml:lang") ?? source.documentElement.getAttribute("lang") ?? book.language;
	html.setAttribute("lang", lang);
	if (book.rtl || source.documentElement.getAttribute("dir") === "rtl") html.setAttribute("dir", "rtl");

	out.head.innerHTML = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">`;
	if (viewport) {
		const meta = out.createElement("meta");
		meta.setAttribute("name", "viewport");
		meta.setAttribute("content", `width=${viewport.width}, height=${viewport.height}`);
		out.head.append(meta);
	}
	const order = out.createElement("style");
	order.textContent = LAYER_ORDER;
	out.head.append(order);
	for (const css of styles) {
		const el = out.createElement("style");
		el.setAttribute("data-publisher", "");
		el.textContent = layered(css);
		out.head.append(el);
	}
	const reader = out.createElement("style");
	reader.id = "reader-style";
	reader.textContent = readerCss; // already wrapped in @layer reader (see readerCss.ts)
	out.head.append(reader);

	if (body.localName === "body") out.body.replaceWith(body);
	else out.body.append(body);

	return { index, html: `<!doctype html>${html.outerHTML}`, viewport, urls };
}
