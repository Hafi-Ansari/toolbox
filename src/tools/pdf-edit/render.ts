import type { Remote } from "comlink";
import { useEffect, useState } from "react";
import type { EditApi } from "./edit.worker.ts";

export function createRenderCache(api: Remote<EditApi>, max: number) {
	const cache = new Map<number, { pixels: number; result: Promise<Blob> }>();
	return (page: number, width: number, dpr: number) => {
		const pixels = Math.ceil((width * dpr) / 128) * 128;
		const hit = cache.get(page);
		cache.delete(page);
		const entry =
			hit && hit.pixels >= pixels
				? hit
				: {
						pixels,
						result: api.render(page, pixels, 1).then(
							(png) => new Blob([png], { type: "image/png" }),
							(error) => {
								if (cache.get(page)?.pixels === pixels) cache.delete(page);
								throw error;
							},
						),
					};
		cache.set(page, entry);
		if (cache.size > max) {
			const oldest = cache.keys().next();
			if (!oldest.done) cache.delete(oldest.value);
		}
		return entry.result;
	};
}

export type RenderPage = ReturnType<typeof createRenderCache>;

export function usePageImage(render: RenderPage, page: number, width: number, dpr: number) {
	const [state, setState] = useState<{ page: number; url?: string; failed?: boolean }>();
	useEffect(() => {
		if (!width) {
			setState(undefined);
			return;
		}
		let cancelled = false;
		void render(page, width, dpr).then(
			(blob) => {
				if (!cancelled) setState({ page, url: URL.createObjectURL(blob) });
			},
			() => {
				if (!cancelled) setState({ page, failed: true });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [render, page, width, dpr]);
	useEffect(() => {
		const url = state?.url;
		if (url) return () => URL.revokeObjectURL(url);
	}, [state?.url]);
	return width && state?.page === page ? state : undefined;
}
