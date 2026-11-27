import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as mupdf from "mupdf";
import { afterAll, expect, it } from "vitest";
import { editDocument, formDocument, mergeDocument } from "../../../e2e/edit-fixture.ts";
import { assemble } from "./assemble.ts";
import { readForm } from "./formFill.ts";
import { formChanges, initialValues } from "./forms.ts";
import type { Item } from "./items.ts";
import type { PlanPage } from "./pages.ts";

const require = createRequire(import.meta.url);
const fonts = {
	sans: new mupdf.Font(
		"Noto Sans",
		readFileSync(require.resolve("@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf")),
	),
	script: new mupdf.Font(
		"Dancing Script",
		readFileSync(require.resolve("@expo-google-fonts/dancing-script/400Regular/DancingScript_400Regular.ttf")),
	),
};
afterAll(() => {
	fonts.sans.destroy();
	fonts.script.destroy();
});

const one: PlanPage[] = [{ source: 0, index: 0, rotate: 0, items: [] }];

function note(id: string, text: string): Item {
	return { id, page: id, kind: "text", text, lines: [text], size: 14, x: 30, y: 40, w: 120, h: 24, color: "#000000" };
}

function reopen(doc: mupdf.PDFDocument) {
	const buffer = doc.saveToBuffer("compress,garbage");
	try {
		return new mupdf.PDFDocument(buffer.asUint8Array().slice());
	} finally {
		buffer.destroy();
	}
}

function pageText(doc: mupdf.PDFDocument, index: number) {
	const page = doc.loadPage(index);
	const text = page.toStructuredText("");
	try {
		return text.asText();
	} finally {
		text.destroy();
		page.destroy();
	}
}

/** Where a piece of text appears, as a fraction of the shown page. */
function shownFraction(doc: mupdf.PDFDocument, index: number, needle: string) {
	const page = doc.loadPage(index);
	try {
		const quad = page.search(needle, undefined)[0]?.[0];
		if (!quad) throw new Error(`${needle} not found`);
		const [x0, y0, x1, y1] = page.getBounds();
		const xs = [quad[0], quad[2], quad[4], quad[6]];
		const ys = [quad[1], quad[3], quad[5], quad[7]];
		const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
		const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
		return [(cx - x0) / (x1 - x0), (cy - y0) / (y1 - y0)];
	} finally {
		page.destroy();
	}
}

it.each(["flatten", "annotations"] as const)(
	"merges, reorders, duplicates, deletes and rotates pages; items follow their pages (%s)",
	(mode) => {
		const base = editDocument();
		const plan: PlanPage[] = [
			{ source: 1, index: 1, rotate: 0, items: [] },
			{ source: 0, index: 2, rotate: 90, items: [note("p1", "Turned note")] },
			{ source: 0, index: 0, rotate: 0, items: [note("p2", "First copy")] },
			{ source: 1, index: 0, rotate: 180, items: [] },
			{ source: 0, index: 0, rotate: 0, items: [note("p4", "Second copy")] },
		];
		expect(assemble(base, () => mergeDocument(), plan, fonts, {}, mode)).toEqual([]);
		const out = reopen(base);
		base.destroy();
		try {
			expect(out.countPages()).toBe(5);
			expect(pageText(out, 0)).toContain("Appendix 2");
			expect(pageText(out, 1)).toContain("Checklist");
			expect(pageText(out, 2)).toContain("Field Notes");
			expect(pageText(out, 3)).toContain("Appendix 1");
			expect(pageText(out, 4)).toContain("Field Notes");
			const rotations = Array.from({ length: 5 }, (_, i) => out.findPage(i).getInheritable("Rotate").asNumber());
			expect(rotations).toEqual([270, 90, 0, 180, 0]);
			// The duplicated page is a separate page object with its own edits.
			expect(out.findPage(2).asIndirect()).not.toBe(out.findPage(4).asIndirect());
			if (mode === "flatten") {
				expect(pageText(out, 2)).toContain("First copy");
				expect(pageText(out, 2)).not.toContain("Second copy");
				expect(pageText(out, 4)).toContain("Second copy");
				// Drawn at the top-left of the upright page, the note turns with the page to its top-right.
				const [u, v] = shownFraction(out, 1, "Turned note");
				expect(u).toBeGreaterThan(0.8);
				expect(v).toBeLessThan(0.5);
			} else {
				expect(out.findPage(2).get("Annots").length).toBe(1);
				expect(out.findPage(2).get("Annots", 0, "Contents").asString()).toBe("First copy");
				expect(out.findPage(4).get("Annots", 0, "Contents").asString()).toBe("Second copy");
				expect(out.findPage(1).get("Annots", 0, "Contents").asString()).toBe("Turned note");
			}
		} finally {
			out.destroy();
		}
	},
);

it("extracts a subset of pages without carrying the rest", () => {
	const base = editDocument();
	assemble(base, () => mergeDocument(), [{ source: 0, index: 1, rotate: 0, items: [] }], fonts, {}, "flatten");
	const out = reopen(base);
	base.destroy();
	expect(out.countPages()).toBe(1);
	expect(pageText(out, 0)).toContain("Route Sketch");
	expect(out.findPage(0).getInheritable("Rotate").asNumber()).toBe(90);
	out.destroy();
});

it.each([false, true])("fills every field type and keeps it fillable or flattens it (flatten: %s)", (flatten) => {
	const base = formDocument();
	const info = readForm(base);
	const values = {
		...initialValues(info.fields),
		name: "Ada Lovelace",
		notes: "Two lines\nof notes",
		agree: "Yes",
		size: "large",
		colour: "Blue",
		fruit: "p",
		ref: "IGNORED",
	};
	const changes = formChanges(info.fields, values);
	expect(Object.keys(changes)).toEqual(["name", "notes", "agree", "size", "colour", "fruit"]);
	assemble(base, () => mergeDocument(), one, fonts, {}, "flatten", { values: changes, flatten });
	const out = reopen(base);
	base.destroy();
	try {
		const after = readForm(out);
		const text = pageText(out, 0);
		if (flatten) {
			expect(after.fields).toEqual([]);
			const page = out.loadPage(0);
			expect(page.getWidgets()).toHaveLength(0);
			page.destroy();
			for (const value of ["Ada Lovelace", "Two lines", "of notes", "Blue", "FIXED-7"]) expect(text).toContain(value);
			expect(text).not.toContain("SIGN");
		} else {
			const read = Object.fromEntries(after.fields.map((field) => [field.name, field.value]));
			expect(read).toEqual({
				name: "Ada Lovelace",
				notes: "Two lines\nof notes",
				agree: "Yes",
				size: "large",
				colour: "Blue",
				fruit: "p",
				ref: "FIXED-7",
				signature: "",
			});
			const page = out.loadPage(0);
			const widgets = page.getWidgets();
			const states = widgets
				.filter((widget) => widget.getName() === "size")
				.map((widget) => widget.getObject().get("AS").asName());
			expect(states).toEqual(["Off", "large"]);
			const changed = widgets.filter((widget) => widget.getName() in changes);
			expect(changed).toHaveLength(7);
			expect(changed.every((widget) => !widget.getObject().get("AP").isNull())).toBe(true);
			page.destroy();
		}
	} finally {
		out.destroy();
	}
});

it("turns a check box back off; a NoToggleToOff radio group keeps its choice", () => {
	const base = formDocument();
	assemble(base, () => mergeDocument(), one, fonts, {}, "flatten", {
		values: { agree: "Yes", size: "small" },
		flatten: false,
	});
	const middle = reopen(base);
	base.destroy();
	assemble(middle, () => mergeDocument(), one, fonts, {}, "flatten", {
		values: { agree: "Off", size: "Off" },
		flatten: false,
	});
	const out = reopen(middle);
	middle.destroy();
	const read = Object.fromEntries(readForm(out).fields.map((field) => [field.name, field.value]));
	expect(read.agree).toBe("Off");
	expect(read.size).toBe("small");
	out.destroy();
});
