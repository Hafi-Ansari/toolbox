import type { Point } from "./geometry.ts";

export type Shape = "check" | "cross" | "dot";
export type Strokes = Point[][];
export type Signature =
	| { kind: "drawn"; strokes: Strokes; ratio: number }
	| { kind: "typed"; text: string }
	| { kind: "image"; key: string; ratio: number };
export type Tool = "select" | "text" | "draw" | "erase" | Shape | "signature" | "image";
export type Mode = "flatten" | "annotations";
export type ImageDataMap = Record<string, Uint8Array<ArrayBuffer>>;
export type Item = { id: string; page: string; x: number; y: number; w: number; h: number; color: string } & (
	| { kind: "text"; text: string; size: number; lines: string[] }
	| { kind: "ink"; strokes: Strokes; width: number }
	| { kind: "mark"; shape: Shape }
	| { kind: "signature"; source: Signature }
	| { kind: "image"; key: string; natW: number; natH: number }
);
export type TextItem = Extract<Item, { kind: "text" }>;
export interface PageSize {
	w: number;
	h: number;
	rotate: number;
}

export const MARK_PATHS: Record<Exclude<Shape, "dot">, Strokes> = {
	check: [
		[
			[0.16, 0.52],
			[0.42, 0.78],
			[0.86, 0.22],
		],
	],
	cross: [
		[
			[0.23, 0.23],
			[0.77, 0.77],
		],
		[
			[0.77, 0.23],
			[0.23, 0.77],
		],
	],
};
export const DOT_RADIUS = 0.23;
export const TEXT_LEADING = 1.35;
export const TEXT_PADDING = 2;
export const TEXT_BASELINE = 1.06;
export const SIGNATURE_BASELINE = 0.74;

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function moveBy(item: Item, dx: number, dy: number, page: PageSize): Item {
	return { ...item, x: clamp(item.x + dx, 0, page.w - item.w), y: clamp(item.y + dy, 0, page.h - item.h) };
}

export function resizeTo(item: Item, width: number, page: PageSize): Item {
	const maxWidth =
		item.kind === "text" ? page.w - item.x : Math.min(page.w - item.x, ((page.h - item.y) * item.w) / item.h);
	const w = clamp(width, Math.min(12, maxWidth), maxWidth);
	const scale = w / item.w;
	const resized = { ...item, w, h: item.kind === "text" ? item.h : item.h * scale };
	return resized.kind === "ink" ? { ...resized, width: resized.width * scale } : resized;
}

export function wrapLines(text: string, width: number, measure: (text: string) => number): string[] {
	return text
		.replaceAll("\t", "    ")
		.split(/\r?\n/)
		.flatMap((line) => {
			const lines: string[] = [];
			let current = "";
			for (const word of line.match(/\s+|\S+/gu) ?? []) {
				if (measure(current + word) <= width) {
					current += word;
					continue;
				}
				if (current.trim()) lines.push(current.trimEnd());
				current = "";
				if (!word.trim()) continue;
				for (const char of word) {
					if (current && measure(current + char) > width) {
						lines.push(current);
						current = "";
					}
					current += char;
				}
			}
			lines.push(current.trimEnd());
			return lines;
		});
}

function distanceTo(p: Point, a: Point, b: Point): number {
	const x = b[0] - a[0];
	const y = b[1] - a[1];
	const t = x || y ? clamp(((p[0] - a[0]) * x + (p[1] - a[1]) * y) / (x * x + y * y), 0, 1) : 0;
	return Math.hypot(p[0] - a[0] - t * x, p[1] - a[1] - t * y);
}

export function hitStroke(item: Item, point: Point, radius: number): boolean {
	if (item.kind !== "ink") return false;
	return item.strokes.some((stroke) => {
		const points: Point[] = stroke.map(([x, y]) => [item.x + x * item.w, item.y + y * item.h]);
		return points.some((p, i) => distanceTo(point, points[i - 1] ?? p, p) <= radius + item.width / 2);
	});
}

export function normalizeStrokes(strokes: Strokes, padding: number) {
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const stroke of strokes) {
		for (const [x, y] of stroke) {
			left = Math.min(left, x);
			top = Math.min(top, y);
			right = Math.max(right, x);
			bottom = Math.max(bottom, y);
		}
	}
	const x = left - padding;
	const y = top - padding;
	const w = Math.max(1, right - left + padding * 2);
	const h = Math.max(1, bottom - top + padding * 2);
	return {
		x,
		y,
		w,
		h,
		strokes: strokes.map((stroke) => stroke.map(([px, py]): Point => [(px - x) / w, (py - y) / h])),
	};
}

export function inkWidth(item: Item): number {
	if (item.kind === "ink") return item.width;
	return Math.min(item.w, item.h) * (item.kind === "signature" ? 0.055 : 0.115);
}

export function typedSize(item: Item): number {
	return item.h * 0.71;
}
