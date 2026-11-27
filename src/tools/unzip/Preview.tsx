import { useEffect } from "react";
import { Button, Card, Note, Progress } from "../../lib/ui.tsx";
import s from "./Unzip.module.css";

export const MAX_PREVIEW = 64 << 20;
export const TEXT_PREVIEW = 256 << 10;

const imageTypes: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	ico: "image/x-icon",
	svg: "image/svg+xml",
};

export const imageType = (path: string) => imageTypes[path.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() ?? ""];

export type PreviewState = { index: number } & (
	| { kind: "loading" | "large" | "binary" }
	| { kind: "error"; message: string }
	| { kind: "image"; url: string }
	| { kind: "text"; text: string; truncated: boolean }
);

export function previewContent(data: Uint8Array, size: number, path: string, index: number): PreviewState {
	const type = imageType(path);
	if (type)
		return { index, kind: "image", url: URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type })) };
	const text = new TextDecoder().decode(data);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: binary bytes are not text
	if (/[\u0000-\u0008\u000E-\u001F]/.test(text) || (text.match(/\uFFFD/g)?.length ?? 0) > text.length * 0.05)
		return { index, kind: "binary" };
	return { index, kind: "text", text, truncated: size > data.length };
}

export function Preview({
	state,
	path,
	busy,
	close,
	save,
}: {
	state: PreviewState;
	path: string;
	busy: boolean;
	close(): void;
	save(): void;
}) {
	const url = state.kind === "image" ? state.url : undefined;
	useEffect(
		() => () => {
			if (url) URL.revokeObjectURL(url);
		},
		[url],
	);
	return (
		<Card className={s.preview}>
			<div className={s.previewHeader}>
				<h2 title={path}>{path}</h2>
				<Button variant="ghost" className={s.iconButton} icon="x" aria-label="Close preview" onClick={close} />
			</div>
			{state.kind === "loading" && <Progress value={0} max={0} label="Loading preview" />}
			{state.kind === "error" && <Note tone="danger">{state.message}</Note>}
			{state.kind === "large" && <p className={s.empty}>This file is too large to preview (over 64 MB).</p>}
			{state.kind === "binary" && (
				<p className={s.empty}>Preview is available for UTF-8 text and supported image files.</p>
			)}
			{state.kind === "image" && <img src={state.url} alt="File preview" className={s.previewImage} />}
			{state.kind === "text" && (
				<>
					<pre className={s.previewText}>{state.text || "Empty file"}</pre>
					{state.truncated && <p className={s.empty}>Showing the first 256 KB.</p>}
				</>
			)}
			<Button icon="download" variant="ghost" disabled={busy} onClick={save}>
				Save file
			</Button>
		</Card>
	);
}
