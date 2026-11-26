// Groups the paragraph stream into EPUB chapter files and renders them as XHTML.
import type { OutlineEntry, Para } from "../../../lib/pdf/heuristics.ts";
import { escapeXml } from "./epub.ts";

export interface Chapter {
	title: string;
	/** Table-of-contents entries that point at this chapter (empty for continuation parts). */
	nav: { title: string; level: number }[];
	paras: Para[];
}

const MAX_CHAPTER_CHARS = 250_000;

/**
 * Groups paragraphs into chapters: by the PDF outline when it has at least two
 * entries, otherwise at h1 headings, otherwise in fixed-size parts. Very long
 * chapters are split further so each XHTML file stays fast to open in readers.
 */
export function splitChapters(paras: Para[], outline: OutlineEntry[], fallbackTitle: string): Chapter[] {
	const chapters: Chapter[] = [];
	const marks = outline.filter((o) => o.page >= 0).sort((a, b) => a.page - b.page || a.level - b.level);

	if (marks.length >= 2) {
		let mi = 0;
		let current: Chapter | null = null;
		const pre: Para[] = [];
		for (const p of paras) {
			while (mi < marks.length && p.page >= marks[mi].page) {
				const entry = { title: marks[mi].title, level: marks[mi].level };
				// Several outline entries on one page (e.g. "Part I" then "Chapter 1") share a file.
				if (current && current.paras.length === 0) current.nav.push(entry);
				else {
					current = { title: entry.title, nav: [entry], paras: [] };
					chapters.push(current);
				}
				mi++;
			}
			(current ? current.paras : pre).push(p);
		}
		if (pre.length) chapters.unshift({ title: "Front matter", nav: [{ title: "Front matter", level: 1 }], paras: pre });
	} else if (paras.filter((p) => p.kind === "h1").length >= 2) {
		let current: Chapter = { title: fallbackTitle, nav: [{ title: fallbackTitle, level: 1 }], paras: [] };
		chapters.push(current);
		for (const p of paras) {
			if (p.kind === "h1") {
				if (current.paras.length > 0) {
					current = { title: p.text, nav: [{ title: p.text, level: 1 }], paras: [] };
					chapters.push(current);
				} else {
					current.title = p.text;
					current.nav = [{ title: p.text, level: 1 }];
				}
			}
			current.paras.push(p);
		}
	} else {
		chapters.push({ title: fallbackTitle, nav: [{ title: fallbackTitle, level: 1 }], paras: [...paras] });
	}

	// Split oversize chapters into continuation parts.
	const result: Chapter[] = [];
	for (const c of chapters) {
		let part: Chapter = { ...c, paras: [] };
		let size = 0;
		let n = 1;
		for (const p of c.paras) {
			const len = p.kind === "img" ? 200 : p.text.length;
			if (size + len > MAX_CHAPTER_CHARS && part.paras.length > 0) {
				result.push(part);
				n++;
				part = { title: `${c.title} (${n})`, nav: [], paras: [] };
				size = 0;
			}
			part.paras.push(p);
			size += len;
		}
		if (part.paras.length || result.length === 0) result.push(part);
	}
	return result.filter((c) => c.paras.length > 0);
}

/** Renders paragraphs as an XHTML body fragment. */
export function renderParas(paras: Para[]): string {
	let html = "";
	let afterBreak = true;
	for (const p of paras) {
		if (p.kind === "img") {
			html += `<figure><img src="${escapeXml(p.href)}" alt="" width="${p.width}" height="${p.height}"/></figure>\n`;
			afterBreak = true;
		} else if (p.kind === "p") {
			html += afterBreak ? `<p class="first">${escapeXml(p.text)}</p>\n` : `<p>${escapeXml(p.text)}</p>\n`;
			afterBreak = false;
		} else {
			html += `<${p.kind}>${escapeXml(p.text)}</${p.kind}>\n`;
			afterBreak = true;
		}
	}
	return html;
}
