import dancingUrl from "@expo-google-fonts/dancing-script/400Regular/DancingScript_400Regular.ttf?url";
import notoUrl from "@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf?url";
import * as Comlink from "comlink";
import * as mupdf from "mupdf";
import { blockCachedHandle } from "../../lib/pdf/fileStream.ts";
import { applyItems, type Fonts } from "./build.ts";
import type { ImageDataMap, Item, Mode, PageSize } from "./items.ts";

declare class FileReaderSync {
	readAsArrayBuffer(blob: Blob): ArrayBuffer;
}

export interface OpenDocument {
	pages: PageSize[];
	signed: boolean;
	canFlatten: boolean;
	canAnnotate: boolean;
	title: string;
}

let current: { doc: mupdf.PDFDocument; file: File; password?: string } | null = null;
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

const api = {
	open(file: File, password?: string): OpenDocument | null {
		current?.doc.destroy();
		current = null;
		const doc = openFile(file, password);
		if (!doc) return null;
		try {
			const count = doc.countPages();
			if (!count) throw new Error("The PDF has no pages.");
			const pages = Array.from({ length: count }, (_, index): PageSize => {
				const page = doc.loadPage(index);
				try {
					const [x0, y0, x1, y1] = page.getBounds();
					return { w: x1 - x0, h: y1 - y0, rotate: page.getObject().getInheritable("Rotate").asNumber() };
				} finally {
					page.destroy();
				}
			});
			const info = {
				pages,
				signed: signed(doc),
				canFlatten: doc.hasPermission("edit"),
				canAnnotate: doc.hasPermission("annotate"),
				title: doc.getMetaData("info:Title")?.trim() ?? "",
			};
			current = { doc, file, password };
			return info;
		} catch (error) {
			doc.destroy();
			throw error;
		}
	},

	render(index: number, cssWidth: number, dpr: number): Uint8Array<ArrayBuffer> {
		if (!current) throw new Error("Open a PDF first.");
		const page = current.doc.loadPage(index);
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

	async export(items: Item[], images: ImageDataMap, mode: Mode) {
		if (!current) throw new Error("Open a PDF first.");
		const input = current;
		const useFonts = await getFonts();
		const doc = openFile(input.file, input.password);
		if (!doc) throw new Error("The PDF password is no longer available.");
		try {
			if (!doc.hasPermission(mode === "flatten" ? "edit" : "annotate"))
				throw new Error("This export mode is restricted by the PDF.");
			const unsupported = applyItems(doc, items, useFonts, images, mode);
			const result = doc.saveToBuffer("compress");
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
