import dancingUrl from "@expo-google-fonts/dancing-script/400Regular/DancingScript_400Regular.ttf?url";
import notoUrl from "@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf?url";
import * as Comlink from "comlink";
import * as mupdf from "mupdf";
import { blockCachedHandle } from "../../lib/pdf/fileStream.ts";
import { assemble, type FormPlan } from "./assemble.ts";
import type { Fonts } from "./build.ts";
import { readForm } from "./formFill.ts";
import type { FormInfo } from "./forms.ts";
import type { ImageDataMap, Mode, PageSize } from "./items.ts";
import type { PlanPage } from "./pages.ts";

declare class FileReaderSync {
	readAsArrayBuffer(blob: Blob): ArrayBuffer;
}

export interface OpenDocument {
	pages: PageSize[];
	signed: boolean;
	canFlatten: boolean;
	canAnnotate: boolean;
	title: string;
	form: FormInfo;
}

interface Opened {
	doc: mupdf.PDFDocument;
	file: File;
	password?: string;
}

/** Source 0 is the PDF opened first; merged PDFs get the following ids. */
const sources = new Map<number, Opened>();
let nextSource = 1;
let fonts: Promise<Fonts> | undefined;

function openFile(file: File, password?: string): mupdf.PDFDocument | null {
	const reader = new FileReaderSync();
	const stream = new mupdf.Stream(
		blockCachedHandle(
			file.size,
			(pos, len) => new Uint8Array(reader.readAsArrayBuffer(file.slice(pos, pos + len))),
			undefined,
			1 << 20,
			12,
		),
	);
	try {
		const doc = mupdf.Document.openDocument(stream, "application/pdf");
		if (doc.needsPassword() && (password === undefined || !doc.authenticatePassword(password))) {
			doc.destroy();
			return null;
		}
		const pdf = doc.asPDF();
		if (pdf) return pdf;
		doc.destroy();
		throw new Error("Choose a PDF file to edit.");
	} finally {
		stream.destroy();
	}
}

function signed(doc: mupdf.PDFDocument): boolean {
	const form = doc.getTrailer().get("Root", "AcroForm");
	if (!form.isDictionary()) return false;
	if (form.get("SigFlags").asNumber() & 1) return true;
	const seen = new Set<number>();
	const stack: { field: mupdf.PDFObject; type: string }[] = [];
	form.get("Fields").forEach((field) => {
		stack.push({ field, type: "" });
	});
	while (stack.length) {
		const entry = stack.pop();
		if (!entry) break;
		const { field } = entry;
		const id = field.asIndirect();
		if (id && seen.has(id)) continue;
		if (id) seen.add(id);
		const type = field.get("FT").asName() || entry.type;
		if (type === "Sig" && !field.get("V").isNull()) return true;
		field.get("Kids").forEach((kid) => {
			stack.push({ field: kid, type });
		});
	}
	return false;
}

async function loadFont(name: string, url: string): Promise<mupdf.Font> {
	const response = await fetch(url);
	if (!response.ok) throw new Error("The PDF editor font could not be loaded.");
	return new mupdf.Font(name, await response.arrayBuffer());
}

function getFonts() {
	fonts ??= Promise.all([loadFont("Noto Sans", notoUrl), loadFont("Dancing Script", dancingUrl)])
		.then(([sans, script]) => ({ sans, script }))
		.catch((error) => {
			fonts = undefined;
			throw error;
		});
	return fonts;
}

function pageSizes(doc: mupdf.PDFDocument): PageSize[] {
	const count = doc.countPages();
	if (!count) throw new Error("The PDF has no pages.");
	return Array.from({ length: count }, (_, index): PageSize => {
		const page = doc.loadPage(index);
		try {
			const [x0, y0, x1, y1] = page.getBounds();
			return { w: x1 - x0, h: y1 - y0, rotate: page.getObject().getInheritable("Rotate").asNumber() };
		} finally {
			page.destroy();
		}
	});
}

function reopen(source: number): mupdf.PDFDocument {
	const input = sources.get(source);
	if (!input) throw new Error("Open a PDF first.");
	const doc = openFile(input.file, input.password);
	if (!doc) throw new Error("The PDF password is no longer available.");
	return doc;
}

function closeAll() {
	for (const { doc } of sources.values()) doc.destroy();
	sources.clear();
	nextSource = 1;
}

const api = {
	open(file: File, password?: string): OpenDocument | null {
		closeAll();
		const doc = openFile(file, password);
		if (!doc) return null;
		try {
			const info = {
				pages: pageSizes(doc),
				signed: signed(doc),
				canFlatten: doc.hasPermission("edit"),
				canAnnotate: doc.hasPermission("annotate"),
				title: doc.getMetaData("info:Title")?.trim() ?? "",
				form: readForm(doc),
			};
			sources.set(0, { doc, file, password });
			return info;
		} catch (error) {
			doc.destroy();
			throw error;
		}
	},

	/** Opens another PDF to merge. Returns null while it needs a (correct) password. */
	addSource(file: File, password?: string): { id: number; pages: PageSize[] } | null {
		if (!sources.has(0)) throw new Error("Open a PDF first.");
		const doc = openFile(file, password);
		if (!doc) return null;
		try {
			if (!doc.hasPermission("edit") || !doc.hasPermission("assemble"))
				throw new Error(`${file.name} does not allow its pages to be copied.`);
			const pages = pageSizes(doc);
			const id = nextSource++;
			sources.set(id, { doc, file, password });
			return { id, pages };
		} catch (error) {
			doc.destroy();
			throw error;
		}
	},

	render(source: number, index: number, cssWidth: number, dpr: number): Uint8Array<ArrayBuffer> {
		const input = sources.get(source);
		if (!input) throw new Error("Open a PDF first.");
		const page = input.doc.loadPage(index);
		try {
			const [x0, y0, x1, y1] = page.getBounds();
			const scale = Math.min(4, (cssWidth * dpr) / (x1 - x0), 4096 / Math.max(x1 - x0, y1 - y0));
			const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
			try {
				const png = pix.asPNG().slice();
				return Comlink.transfer(png, [png.buffer]);
			} finally {
				pix.destroy();
			}
		} finally {
			page.destroy();
		}
	},

	/** Builds one PDF from the planned pages. The opened files are never modified. */
	async export(plan: PlanPage[], images: ImageDataMap, mode: Mode, form?: FormPlan) {
		if (!sources.has(0)) throw new Error("Open a PDF first.");
		if (!plan.length) throw new Error("Choose at least one page.");
		const useFonts = await getFonts();
		const doc = reopen(0);
		try {
			if (!doc.hasPermission(mode === "flatten" ? "edit" : "annotate"))
				throw new Error("This export mode is restricted by the PDF.");
			const unsupported = assemble(doc, reopen, plan, useFonts, images, mode, form);
			// Garbage collection drops pages left out of a split or extract.
			const result = doc.saveToBuffer("compress,garbage");
			try {
				const bytes = result.asUint8Array().slice();
				return Comlink.transfer({ bytes, unsupported }, [bytes.buffer]);
			} finally {
				result.destroy();
			}
		} finally {
			doc.destroy();
		}
	},
};

export type EditApi = typeof api;

mupdf.setLog({
	error: (message) => console.debug("[mupdf]", message),
	warning: (message) => console.debug("[mupdf]", message),
});
Comlink.expose(api);
self.postMessage({ type: "ready" });
