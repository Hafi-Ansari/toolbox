import type { CSSProperties } from "react";
import { SANS, SCRIPT } from "./fonts.ts";
import type { Asset } from "./images.ts";
import {
	DOT_RADIUS,
	type Item,
	inkWidth,
	MARK_PATHS,
	type PageSize,
	SIGNATURE_BASELINE,
	type Strokes,
	TEXT_BASELINE,
	TEXT_LEADING,
	TEXT_PADDING,
	typedSize,
} from "./items.ts";
import s from "./PdfEdit.module.css";

export function describeItem(item: Item): string {
	switch (item.kind) {
		case "text":
			return `Text box: ${item.text.slice(0, 36) || "Empty"}, page ${item.page + 1}`;
		case "ink":
			return `Ink, page ${item.page + 1}`;
		case "mark":
			return `${item.shape[0].toUpperCase() + item.shape.slice(1)} mark, page ${item.page + 1}`;
		case "signature":
			return `Signature, page ${item.page + 1}`;
		case "image":
			return `Image, page ${item.page + 1}`;
	}
}

export function boxStyle(item: Item, page: PageSize): CSSProperties {
	return {
		left: `${(item.x / page.w) * 100}%`,
		top: `${(item.y / page.h) * 100}%`,
		width: `${(item.w / page.w) * 100}%`,
		height: `${(item.h / page.h) * 100}%`,
	};
}

export function StrokeArt({
	strokes,
	color,
	width,
	w,
	h,
}: {
	strokes: Strokes;
	color: string;
	width: number;
	w: number;
	h: number;
}) {
	return (
		<g fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
			{strokes.map((stroke, index) => {
				if (!stroke.length) return null;
				const first = stroke[0];
				const key = `${first.join(",")}:${index}`;
				return stroke.length === 1 ? (
					<circle key={key} cx={first[0] * w} cy={first[1] * h} r={width / 2} fill={color} stroke="none" />
				) : (
					<polyline key={key} points={stroke.map(([x, y]) => `${x * w},${y * h}`).join(" ")} />
				);
			})}
		</g>
	);
}

export function Artwork({ item, assets }: { item: Item; assets: Record<string, Asset> }) {
	const { w, h, color } = item;
	let contents: React.ReactNode;
	const source = item.kind === "signature" ? item.source : undefined;
	const key = item.kind === "image" ? item.key : source?.kind === "image" ? source.key : undefined;
	if (key) {
		const image = assets[key];
		return image ? <img src={image.src} className={s.art} alt="" draggable={false} /> : null;
	}
	if (item.kind === "text") {
		contents = Array.from(item.lines.entries(), ([index, line]) => (
			<text
				key={`${index}:${line}`}
				fill={color}
				fontFamily={SANS}
				fontSize={item.size}
				x={TEXT_PADDING}
				y={TEXT_PADDING + item.size * (TEXT_BASELINE + index * TEXT_LEADING)}
				xmlSpace="preserve"
			>
				{line}
			</text>
		));
	} else if (source?.kind === "typed") {
		contents = (
			<text
				fill={color}
				fontFamily={`"${SCRIPT}", "${SANS}"`}
				fontSize={typedSize(item)}
				x={0}
				y={h * SIGNATURE_BASELINE}
			>
				{source.text}
			</text>
		);
	} else if (item.kind === "mark" && item.shape === "dot") {
		contents = <circle cx={w / 2} cy={h / 2} r={Math.min(w, h) * DOT_RADIUS} fill={color} />;
	} else {
		const strokes =
			item.kind === "ink"
				? item.strokes
				: item.kind === "mark" && item.shape !== "dot"
					? MARK_PATHS[item.shape]
					: source?.kind === "drawn"
						? source.strokes
						: [];
		contents = <StrokeArt strokes={strokes} color={color} width={inkWidth(item)} w={w} h={h} />;
	}
	return (
		<svg aria-hidden="true" className={s.art} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
			{contents}
		</svg>
	);
}
