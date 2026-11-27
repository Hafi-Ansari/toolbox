import dancingUrl from "@expo-google-fonts/dancing-script/400Regular/DancingScript_400Regular.ttf?url";
import notoUrl from "@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf?url";
import { clamp, type PageSize, TEXT_LEADING, TEXT_PADDING, type TextItem, wrapLines } from "./items.ts";

export const SANS = "Toolbox PDF Noto";
export const SCRIPT = "Toolbox PDF Signature";
let loading: Promise<unknown> | undefined;
let context: CanvasRenderingContext2D | null;
const widths = new Map<string, number>();

export function loadPreviewFonts() {
	loading ??= Promise.all([
		new FontFace(SANS, `url("${notoUrl}")`).load(),
		new FontFace(SCRIPT, `url("${dancingUrl}")`).load(),
	])
		.then((fonts) => {
			for (const font of fonts) document.fonts.add(font);
		})
		.catch((error) => {
			loading = undefined;
			throw error;
		});
	return loading;
}

export function measureText(text: string, size: number, script = false): number {
	context ??= document.createElement("canvas").getContext("2d");
	if (!context) return [...text].length * size * 0.6;
	const family = script ? `"${SCRIPT}", "${SANS}"` : `"${SANS}"`;
	context.font = `100px ${family}`;
	let width = 0;
	for (const char of text) {
		const key = `${script ? "script" : "sans"}:${char}`;
		let advance = widths.get(key);
		if (advance === undefined) {
			advance = context.measureText(char).width / 100;
			widths.set(key, advance);
		}
		width += advance;
	}
	return width * size;
}

export function layoutText(item: TextItem, page: PageSize): TextItem {
	const lines = wrapLines(item.text.normalize("NFC"), Math.max(1, item.w - TEXT_PADDING * 2), (text) =>
		measureText(text, item.size),
	);
	const h = Math.min(page.h, Math.max(16, lines.length * item.size * TEXT_LEADING + TEXT_PADDING * 2));
	return { ...item, lines, h, y: clamp(item.y, 0, page.h - h) };
}
