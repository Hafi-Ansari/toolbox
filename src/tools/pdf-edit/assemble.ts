import type * as mupdf from "mupdf";
import { applyItems, type Fonts } from "./build.ts";
import { fillForm } from "./formFill.ts";
import type { FormValues } from "./forms.ts";
import type { ImageDataMap, Mode } from "./items.ts";
import { type PlanPage, turn } from "./pages.ts";

export interface FormPlan {
	values: FormValues;
	flatten: boolean;
}

/** A shallow copy of a page so it can carry its own annotations and rotation. Form widgets stay on the original. */
function copyPage(doc: mupdf.PDFDocument, index: number): mupdf.PDFObject {
	const original = doc.findPage(index);
	const copy = doc.newDictionary();
	original.forEach((value, key) => {
		if (key !== "Parent" && key !== "Annots") copy.put(key, value);
	});
	for (const key of ["Resources", "MediaBox", "CropBox", "Rotate"]) {
		const inherited = original.getInheritable(key);
		if (copy.get(key).isNull() && !inherited.isNull()) copy.put(key, inherited);
	}
	const object = doc.addObject(copy);
	const annotations = doc.newArray();
	original.get("Annots").forEach((annotation) => {
		const subtype = annotation.get("Subtype").asName();
		if (subtype === "Widget" || subtype === "Popup") return;
		const clone = doc.newDictionary();
		annotation.forEach((value, key) => {
			if (key !== "Popup" && key !== "P") clone.put(key, value);
		});
		clone.put("P", object);
		annotations.push(doc.addObject(clone));
	});
	if (annotations.length) object.put("Annots", annotations);
	return object;
}

/**
 * Builds one output PDF. `base` is a fresh copy of the first source (it keeps that file's
 * metadata and encryption); `open` returns fresh copies of the other sources.
 * Order: fill the form on the base's own pages, graft pages from other files,
 * rearrange (copying repeated pages), place items, then apply added rotation, so
 * items stay where they were drawn on the page's content.
 */
export function assemble(
	base: mupdf.PDFDocument,
	open: (source: number) => mupdf.PDFDocument,
	plan: PlanPage[],
	fonts: Fonts,
	images: ImageDataMap,
	mode: Mode,
	form?: FormPlan,
): string[] {
	if (form) fillForm(base, form.values, form.flatten);
	const original = base.countPages();
	const grafted = new Map<string, number>();
	const others = new Map<number, { doc: mupdf.PDFDocument; map: mupdf.PDFGraftMap }>();
	try {
		for (const page of plan) {
			const key = `${page.source}:${page.index}`;
			if (page.source === 0 || grafted.has(key)) continue;
			let other = others.get(page.source);
			if (!other) {
				const doc = open(page.source);
				other = { doc, map: base.newGraftMap() };
				others.set(page.source, other);
			}
			other.map.graftPage(-1, other.doc, page.index);
			grafted.set(key, base.countPages() - 1);
		}
	} finally {
		for (const { doc, map } of others.values()) {
			map.destroy();
			doc.destroy();
		}
	}
	const used = new Set<number>();
	const order = plan.map((page) => {
		const at = page.source === 0 ? page.index : (grafted.get(`${page.source}:${page.index}`) ?? -1);
		if (at < 0 || at >= base.countPages()) throw new Error("A page of the merged PDF is missing.");
		if (!used.has(at)) {
			used.add(at);
			return at;
		}
		base.insertPage(-1, copyPage(base, at));
		return base.countPages() - 1;
	});
	const identity = order.length === original && order.every((at, i) => at === i);
	if (!identity) base.rearrangePages(order);
	const unsupported = applyItems(
		base,
		plan.map((page) => page.items),
		fonts,
		images,
		mode,
	);
	for (const [index, page] of plan.entries()) {
		if (!page.rotate) continue;
		const object = base.findPage(index);
		object.put("Rotate", turn(object.getInheritable("Rotate").asNumber(), page.rotate));
	}
	return unsupported;
}
