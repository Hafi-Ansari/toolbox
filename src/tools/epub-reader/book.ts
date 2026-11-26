// Opens an EPUB: container → package (OPF) → manifest, spine, metadata and
// table of contents. Nothing but the small XML files is read up front.
import { ZipReader } from "../../lib/zipReader.ts";

export interface ManifestItem {
	id: string;
	path: string;
	mediaType: string;
	properties: string[];
}

export interface SpineItem {
	path: string;
	mediaType: string;
	/** Uncompressed size, used to estimate progress through the whole book. */
	size: number;
	linear: boolean;
	/** True when this item is a fixed-layout page. */
	fixed: boolean;
}

export interface TocItem {
	title: string;
	spine: number;
	fragment: string;
	children: TocItem[];
}

export interface Book {
	zip: ZipReader;
	/** Stable id: package identifier + file size, hashed. */
	id: string;
	title: string;
	author: string;
	language: string;
	rtl: boolean;
	fixed: boolean;
	spine: SpineItem[];
	toc: TocItem[];
	manifest: Map<string, ManifestItem>;
	coverPath?: string;
	/** Sum of spine sizes. */
	totalSize: number;
	spineIndex(path: string): number;
}

const NS_OPS = "http://www.idpf.org/2007/ops";

/** Resolves `href` relative to the zip path `base`, without the fragment. Returns [path, fragment]. */
export function resolvePath(base: string, href: string): [string, string] {
	const url = new URL(href, `https://book.invalid/${base}`);
	if (url.host !== "book.invalid") return ["", ""];
	let path = url.pathname.slice(1);
	try {
		path = decodeURIComponent(path);
	} catch {
		// keep the raw path if it isn't valid percent-encoding
	}
	return [path, url.hash.slice(1)];
}

export function parseXml(text: string): Document {
	const doc = new DOMParser().parseFromString(text, "application/xml");
	if (doc.getElementsByTagName("parsererror").length === 0) return doc;
	// Many real-world books ship invalid XHTML; the HTML parser is forgiving.
	return new DOMParser().parseFromString(text, "text/html");
}

/**
 * Elements by local name, ignoring namespaces and prefixes. Works the same for
 * XML-parsed documents and HTML-parsed fallbacks (where "dc:title" is a literal name).
 */
const byTag = (root: Document | Element, name: string) =>
	Array.from(root.getElementsByTagName("*")).filter((el) => {
		const local = el.localName.toLowerCase();
		const want = name.toLowerCase();
		return local === want || local.endsWith(`:${want}`);
	});
const first = (root: Document | Element, name: string) => byTag(root, name)[0];
const text = (el: Element | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

/** FNV-1a, 64-bit, as hex: short, stable ids for storage keys. */
export function hashId(input: string): string {
	let h = 0xcbf29ce484222325n;
	for (let i = 0; i < input.length; i++) {
		h ^= BigInt(input.charCodeAt(i));
		h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return h.toString(16).padStart(16, "0");
}

async function checkDrm(zip: ZipReader) {
	if (!zip.has("META-INF/encryption.xml")) return;
	const doc = parseXml(await zip.text("META-INF/encryption.xml"));
	for (const method of byTag(doc, "EncryptionMethod")) {
		const alg = method.getAttribute("Algorithm") ?? "";
		// Font obfuscation (IDPF/Adobe) is not DRM; anything else is.
		if (!/idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/.test(alg)) {
			throw new Error("This book is DRM-protected and can't be opened here.");
		}
	}
}

function parseNav(doc: Document, navPath: string, spineIndex: (p: string) => number): TocItem[] {
	const navs = byTag(doc, "nav");
	const toc =
		navs.find((n) =>
			(n.getAttributeNS(NS_OPS, "type") ?? n.getAttribute("epub:type") ?? "").split(/\s+/).includes("toc"),
		) ?? navs[0];
	if (!toc) return [];
	const walk = (ol: Element): TocItem[] =>
		Array.from(ol.children)
			.filter((li) => li.localName === "li")
			.map((li) => {
				const label = Array.from(li.children).find((c) => c.localName === "a" || c.localName === "span");
				const href = label?.getAttribute("href") ?? "";
				const [path, fragment] = href ? resolvePath(navPath, href) : ["", ""];
				const sub = Array.from(li.children).find((c) => c.localName === "ol");
				return { title: text(label), spine: path ? spineIndex(path) : -1, fragment, children: sub ? walk(sub) : [] };
			});
	const ol = Array.from(toc.children).find((c) => c.localName === "ol") ?? first(toc, "ol");
	return ol ? walk(ol) : [];
}

function parseNcx(doc: Document, ncxPath: string, spineIndex: (p: string) => number): TocItem[] {
	const walk = (parent: Element): TocItem[] =>
		Array.from(parent.children)
			.filter((c) => c.localName === "navPoint")
			.map((np) => {
				const label = Array.from(np.children).find((c) => c.localName === "navLabel");
				const content = Array.from(np.children).find((c) => c.localName === "content");
				const [path, fragment] = resolvePath(ncxPath, content?.getAttribute("src") ?? "");
				return { title: text(label), spine: path ? spineIndex(path) : -1, fragment, children: walk(np) };
			});
	const map = first(doc, "navMap");
	return map ? walk(map) : [];
}

/** Drops entries that point outside the spine, promoting their children. */
function cleanToc(items: TocItem[]): TocItem[] {
	return items.flatMap((i) => {
		const children = cleanToc(i.children);
		if (i.spine < 0) return children;
		return [{ ...i, title: i.title || "Untitled", children }];
	});
}

export async function openBook(file: Blob): Promise<Book> {
	let zip: ZipReader;
	try {
		zip = await ZipReader.open(file);
	} catch {
		throw new Error("This file isn't a valid EPUB (it can't be read as a zip archive).");
	}
	if (!zip.has("META-INF/container.xml")) throw new Error("This file isn't a valid EPUB (container.xml is missing).");
	await checkDrm(zip);

	const container = parseXml(await zip.text("META-INF/container.xml"));
	const opfPath = first(container, "rootfile")?.getAttribute("full-path");
	if (!opfPath || !zip.has(opfPath)) throw new Error("This EPUB has no package document.");
	const opf = parseXml(await zip.text(opfPath));

	const manifest = new Map<string, ManifestItem>();
	const byId = new Map<string, ManifestItem>();
	for (const el of byTag(opf, "item")) {
		const href = el.getAttribute("href");
		if (!href) continue;
		const [path] = resolvePath(opfPath, href);
		const item: ManifestItem = {
			id: el.getAttribute("id") ?? "",
			path,
			mediaType: el.getAttribute("media-type") ?? "",
			properties: (el.getAttribute("properties") ?? "").split(/\s+/).filter(Boolean),
		};
		manifest.set(path, item);
		if (item.id) byId.set(item.id, item);
	}

	const metas = byTag(opf, "meta");
	const metaProp = (prop: string) => text(metas.find((m) => m.getAttribute("property") === prop));
	const bookFixed = metaProp("rendition:layout") === "pre-paginated";

	const spineEl = first(opf, "spine");
	const spine: SpineItem[] = [];
	for (const ref of byTag(opf, "itemref")) {
		const item = byId.get(ref.getAttribute("idref") ?? "");
		if (!item || !zip.has(item.path)) continue;
		const props = (ref.getAttribute("properties") ?? "").split(/\s+/);
		const fixed =
			props.includes("rendition:layout-pre-paginated") || (bookFixed && !props.includes("rendition:layout-reflowable"));
		spine.push({
			path: item.path,
			mediaType: item.mediaType,
			size: zip.entries.get(item.path)?.size ?? 0,
			linear: ref.getAttribute("linear") !== "no",
			fixed,
		});
	}
	if (spine.length === 0) throw new Error("This EPUB has no readable content.");
	const indexByPath = new Map(spine.map((s, i) => [s.path, i]));
	const spineIndex = (p: string) => indexByPath.get(p) ?? -1;

	// Table of contents: EPUB 3 nav document, else EPUB 2 NCX, else one entry per chapter.
	let toc: TocItem[] = [];
	const navItem = [...manifest.values()].find((i) => i.properties.includes("nav"));
	if (navItem && zip.has(navItem.path))
		toc = parseNav(parseXml(await zip.text(navItem.path)), navItem.path, spineIndex);
	if (toc.length === 0) {
		const ncxItem =
			byId.get(spineEl?.getAttribute("toc") ?? "") ??
			[...manifest.values()].find((i) => i.mediaType === "application/x-dtbncx+xml");
		if (ncxItem && zip.has(ncxItem.path))
			toc = parseNcx(parseXml(await zip.text(ncxItem.path)), ncxItem.path, spineIndex);
	}
	toc = cleanToc(toc);
	if (toc.length === 0)
		toc = spine.map((_, i) => ({ title: `Section ${i + 1}`, spine: i, fragment: "", children: [] }));

	// Cover: EPUB 3 property, EPUB 2 <meta name="cover">, or an image named like a cover.
	const images = [...manifest.values()].filter((i) => i.mediaType.startsWith("image/"));
	const coverId = metas.find((m) => m.getAttribute("name") === "cover")?.getAttribute("content");
	const cover =
		images.find((i) => i.properties.includes("cover-image")) ??
		(coverId ? byId.get(coverId) : undefined) ??
		images.find((i) => /cover/i.test(i.id) || /cover/i.test(i.path));

	const identifier = text(first(opf, "identifier"));
	const metadata = first(opf, "metadata") ?? opf;
	const title = text(first(metadata, "title")) || "Untitled";
	const author = text(first(metadata, "creator"));
	const language = text(first(metadata, "language")) || "en";

	return {
		zip,
		id: hashId(`${identifier || title}|${file.size}`),
		title,
		author,
		language,
		rtl: spineEl?.getAttribute("page-progression-direction") === "rtl",
		fixed: spine.every((s) => s.fixed),
		spine,
		toc,
		manifest,
		coverPath: cover && zip.has(cover.path) ? cover.path : undefined,
		totalSize: spine.reduce((n, s) => n + s.size, 0),
		spineIndex,
	};
}

/** Flattens the TOC in reading order, with depth, for lookups and rendering. */
export function flattenToc(items: TocItem[], depth = 0, out: (TocItem & { depth: number })[] = []) {
	for (const item of items) {
		out.push({ ...item, depth });
		flattenToc(item.children, depth + 1, out);
	}
	return out;
}

/** Title of the TOC entry covering a spine position (the last entry at or before it). */
export function chapterTitle(book: Book, spine: number): string {
	let best = "";
	for (const item of flattenToc(book.toc)) if (item.spine <= spine) best = item.title;
	return best;
}
