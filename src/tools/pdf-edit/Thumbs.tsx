import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Artwork, boxStyle } from "./Artwork.tsx";
import type { Asset } from "./images.ts";
import type { Item, PageSize } from "./items.ts";
import s from "./PdfEdit.module.css";
import { type RenderPage, usePageImage } from "./render.ts";

function Thumb({
	index,
	size,
	items,
	active,
	render,
	assets,
	open,
}: {
	index: number;
	size: PageSize;
	items: Item[];
	active: boolean;
	render: RenderPage;
	assets: Record<string, Asset>;
	open: (index: number) => void;
}) {
	const target = useRef<HTMLButtonElement>(null);
	const [visible, setVisible] = useState(false);
	const image = usePageImage(render, index, visible || active ? 80 : 0, 1);
	useEffect(() => {
		if (!target.current) return;
		const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
		observer.observe(target.current);
		return () => observer.disconnect();
	}, []);
	return (
		<button
			ref={target}
			className={s.thumb}
			type="button"
			aria-label={`Go to page ${index + 1}`}
			aria-current={active ? "page" : undefined}
			onClick={() => open(index)}
		>
			<span
				className={s.miniature}
				style={{ aspectRatio: `${size.w} / ${size.h}`, "--page-ratio": size.w / size.h } as CSSProperties}
			>
				{image?.url && <img className={s.paper} src={image.url} alt="" draggable={false} />}
				{image?.url &&
					items.map((item) => (
						<span key={item.id} className={s.item} style={boxStyle(item, size)}>
							<Artwork item={item} assets={assets} />
						</span>
					))}
			</span>
			<span className={s.thumbLabel}>
				<span>Page {index + 1}</span>
				{items.length > 0 && (
					<small>
						{items.length} {items.length === 1 ? "edit" : "edits"}
					</small>
				)}
			</span>
		</button>
	);
}

export function Thumbs({
	pages,
	index,
	items,
	assets,
	render,
	open,
}: {
	pages: PageSize[];
	index: number;
	items: Item[];
	assets: Record<string, Asset>;
	render: RenderPage;
	open: (index: number) => void;
}) {
	const byPage = new Map<number, Item[]>();
	for (const item of items) {
		const group = byPage.get(item.page);
		if (group) group.push(item);
		else byPage.set(item.page, [item]);
	}
	return (
		<nav className={s.thumbs} aria-label="PDF pages">
			{Array.from(pages.entries(), ([page, size]) => (
				<Thumb
					key={page}
					index={page}
					size={size}
					items={byPage.get(page) ?? []}
					active={index === page}
					assets={assets}
					render={render}
					open={open}
				/>
			))}
		</nav>
	);
}
