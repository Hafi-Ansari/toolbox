import type { Remote } from "comlink";
import { useEffect, useState } from "react";
import type { EditApi } from "./edit.worker.ts";

/** A source page, as "source:index". Renders are cached per source page, not per page reference. */
export type PageKey = string;

export function pageKey({ source, index }: { source: number; index: number }): PageKey {
	return `${source}:${index}`;
}

export function createRenderCache(api: Remote<EditApi>, max: number) {
	const cache = new Map<PageKey, { pixels: number; result: Promise<Blob> }>();
	return (key: PageKey, width: number, dpr: number) => {
		const pixels = Math.ceil((width * dpr) / 128) * 128;
		const hit = cache.get(key);
		cache.delete(key);
		const [source, index] = key.split(":").map(Number);
		const entry =
			hit && hit.pixels >= pixels
				? hit
				: {
						pixels,
						result: api.render(source, index, pixels, 1).then(
							(png) => new Blob([png], { type: "image/png" }),
							(error) => {
								if (cache.get(key)?.pixels === pixels) cache.delete(key);
								throw error;
							},
						),
					};
		cache.set(key, entry);
		if (cache.size > max) {
			const oldest = cache.keys().next();
			if (!oldest.done) cache.delete(oldest.value);
		}
		return entry.result;
	};
}

export type RenderPage = ReturnType<typeof createRenderCache>;

export function usePageImage(render: RenderPage, key: PageKey, width: number, dpr: number) {
	const [state, setState] = useState<{ key: PageKey; url?: string; failed?: boolean }>();
	useEffect(() => {
		if (!width) {
			setState(undefined);
			return;
		}
		let cancelled = false;
		void render(key, width, dpr).then(
			(blob) => {
				if (!cancelled) setState({ key, url: URL.createObjectURL(blob) });
			},
			() => {
				if (!cancelled) setState({ key, failed: true });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [render, key, width, dpr]);
	useEffect(() => {
		const url = state?.url;
		if (url) return () => URL.revokeObjectURL(url);
	}, [state?.url]);
	return width && state?.key === key ? state : undefined;
}
