import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { Artwork, boxStyle } from "./Artwork.tsx";
import type { Asset } from "./images.ts";
import type { Item, PageSize } from "./items.ts";
import s from "./PdfEdit.module.css";
import { type PageRef, SOURCE_COLORS, type Source, shownSize, sourceLetter } from "./pages.ts";
import { pageKey, type RenderPage, usePageImage } from "./render.ts";

export function sourceColor(id: number): string {
	return SOURCE_COLORS[id % SOURCE_COLORS.length];
}

export function SourceBadge({ source }: { source: Source }) {
	return (
		<span
			className={s.sourceBadge}
			style={{ background: sourceColor(source.id) }}
			title={source.name}
			aria-label={`From ${source.name}`}
			role="img"
		>
			{sourceLetter(source.id)}
		</span>
	);
}

/** True once the element has scrolled near the viewport; thumbnails render only then. */
export function useNearViewport<T extends Element>() {
	const target = useRef<T>(null);
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		if (!target.current) return;
		const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
			rootMargin: "200px 0px",
		});
		observer.observe(target.current);
		return () => observer.disconnect();
	}, []);
	return [target, visible] as const;
}

/** A page miniature, turned by the editor's added rotation, with its placed items. */
export function PageFace({ size, rotate, children }: { size: PageSize; rotate: number; children?: ReactNode }) {
	const shown = shownSize(size, rotate);
	return (
		<span
			className={s.miniature}
			style={{ aspectRatio: `${shown.w} / ${shown.h}`, "--page-ratio": shown.w / shown.h } as CSSProperties}
		>
			<span
				className={s.face}
				style={
					rotate
						? {
								left: "50%",
								top: "50%",
								width: `${(size.w / shown.w) * 100}%`,
								height: `${(size.h / shown.h) * 100}%`,
								transform: `translate(-50%, -50%) rotate(${rotate}deg)`,
							}
						: undefined
				}
			>
				{children}
			</span>
		</span>
	);
}

export function PageArt({
	image,
	items,
	size,
	assets,
}: {
	image?: { url?: string };
	items: Item[];
	size: PageSize;
	assets: Record<string, Asset>;
}) {
	if (!image?.url) return null;
	return (
		<>
			<img className={s.paper} src={image.url} alt="" draggable={false} />
			{items.map((item) => (
				<span key={item.id} className={s.item} style={boxStyle(item, size)}>
					<Artwork item={item} assets={assets} />
				</span>
			))}
		</>
	);
}

function Thumb({
	page,
	number,
	size,
	source,
	items,
	active,
	render,
	assets,
	open,
}: {
	page: PageRef;
	number: number;
	size: PageSize;
	source?: Source;
	items: Item[];
	active: boolean;
	render: RenderPage;
	assets: Record<string, Asset>;
	open: (id: string) => void;
}) {
	const [target, visible] = useNearViewport<HTMLButtonElement>();
	const image = usePageImage(render, pageKey(page), visible || active ? 80 : 0, 1);
	return (
		<button
			ref={target}
			className={s.thumb}
			type="button"
			aria-label={`Go to page ${number}`}
			aria-current={active ? "page" : undefined}
			onClick={() => open(page.id)}
		>
			<PageFace size={size} rotate={page.rotate}>
				<PageArt image={image} items={items} size={size} assets={assets} />
			</PageFace>
			<span className={s.thumbLabel}>
				<span>
					{source && <SourceBadge source={source} />} Page {number}
				</span>
				{items.length > 0 && (
					<small>
						{items.length} {items.length === 1 ? "edit" : "edits"}
					</small>
				)}
			</span>
		</button>
	);
}

export function groupItems(items: Item[]): Map<string, Item[]> {
	const byPage = new Map<string, Item[]>();
	for (const item of items) {
		const group = byPage.get(item.page);
		if (group) group.push(item);
		else byPage.set(item.page, [item]);
	}
	return byPage;
}

export function Thumbs({
	pages,
	sources,
	current,
	items,
	assets,
	render,
	open,
}: {
	pages: PageRef[];
	sources: Source[];
	current: string;
	items: Item[];
	assets: Record<string, Asset>;
	render: RenderPage;
	open: (id: string) => void;
}) {
	const byPage = groupItems(items);
	return (
		<nav className={s.thumbs} aria-label="PDF pages">
			{pages.map((page, i) => (
				<Thumb
					key={page.id}
					page={page}
					number={i + 1}
					size={sources[page.source].pages[page.index]}
					source={sources.length > 1 ? sources[page.source] : undefined}
					items={byPage.get(page.id) ?? []}
					active={current === page.id}
					assets={assets}
					render={render}
					open={open}
				/>
			))}
		</nav>
	);
}
