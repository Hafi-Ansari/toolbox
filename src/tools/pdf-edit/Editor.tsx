import type { Remote } from "comlink";
import { type KeyboardEvent, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { formatBytes } from "../../lib/format.ts";
import { openSaveTarget, type SaveTarget } from "../../lib/saveFile.ts";
import { Button, Chip, Note, Pills, Progress } from "../../lib/ui.tsx";
import type { EditApi, OpenDocument } from "./edit.worker.ts";
import { layoutText, loadPreviewFonts, measureText } from "./fonts.ts";
import type { Point } from "./geometry.ts";
import { EMPTY_HISTORY, editHistory } from "./history.ts";
import { type Asset, IMAGE_ACCEPT, readImage } from "./images.ts";
import {
	clamp,
	type ImageDataMap,
	type Item,
	normalizeStrokes,
	type Signature,
	type TextItem,
	type Tool,
} from "./items.ts";
import { PageCanvas, type TextDraft } from "./PageCanvas.tsx";
import s from "./PdfEdit.module.css";
import { createRenderCache } from "./render.ts";
import { SignatureDialog } from "./SignatureDialog.tsx";
import { Thumbs } from "./Thumbs.tsx";

const TOOLS = [
	["select", "Select"],
	["text", "Text"],
	["draw", "Draw"],
	["erase", "Erase"],
	["check", "Check"],
	["cross", "Cross"],
	["dot", "Dot"],
	["signature", "Signature"],
	["image", "Image"],
] as const;
const COLORS = [
	["#19242e", "Black"],
	["#1356c9", "Blue"],
	["#bb2222", "Red"],
	["#14764a", "Green"],
] as const;
const MODES = [
	{ value: "flatten", label: "Flatten into page (recommended)" },
	{ value: "annotations", label: "Keep as editable annotations" },
] as const;

export function Editor({
	api,
	doc,
	file,
	reset,
}: {
	api: Remote<EditApi>;
	doc: OpenDocument;
	file: File;
	reset: () => void;
}) {
	const [history, dispatch] = useReducer(editHistory, EMPTY_HISTORY);
	const [index, setIndex] = useState(0);
	const [zoom, setZoom] = useState(1);
	const [tool, setTool] = useState<Tool>("select");
	const [selection, setSelection] = useState<string | null>(null);
	const [draft, setDraft] = useState<TextDraft | null>(null);
	const draftRef = useRef<TextDraft | null>(null);
	const [color, setColor] = useState<string>(COLORS[0][0]);
	const [pen, setPen] = useState(2);
	const [size, setSize] = useState(16);
	const [signatureDialog, setSignatureDialog] = useState(false);
	const [signature, setSignature] = useState<Signature | null>(null);
	const [image, setImage] = useState<{ key: string; asset: Asset }>();
	const [assets, setAssets] = useState<Record<string, Asset>>({});
	const upload = useRef<HTMLInputElement>(null);
	const uploadRun = useRef(0);
	const [fontReady, setFontReady] = useState(false);
	const [mode, setMode] = useState<"flatten" | "annotations">(doc.canFlatten ? "flatten" : "annotations");
	const [busy, setBusy] = useState(false);
	const downloading = useRef(false);
	const [message, setMessage] = useState<{ tone: "info" | "success" | "danger"; text: string }>();
	const render = useMemo(() => createRenderCache(api, 8), [api]);
	const renderThumb = useMemo(() => createRenderCache(api, 20), [api]);
	const page = doc.pages[index];
	const items = history.items.filter((item) => item.page === index);
	const selected = items.find((item) => item.id === selection);
	const restricted = !doc.canFlatten && !doc.canAnnotate;
	const modes = MODES.filter(({ value }) => (value === "flatten" ? doc.canFlatten : doc.canAnnotate)).map((entry) => ({
		...entry,
	}));

	useEffect(() => {
		let active = true;
		loadPreviewFonts().then(
			() => {
				if (active) setFontReady(true);
			},
			() => {
				if (active)
					setMessage({
						tone: "danger",
						text: "The PDF editor fonts could not be loaded. Reopen the PDF to try again.",
					});
			},
		);
		return () => {
			active = false;
		};
	}, []);

	function update(updateItems: (items: Item[]) => Item[]) {
		dispatch({ type: "change", update: updateItems });
	}

	function beginText(item: TextItem, newItem = false) {
		const next = { item, newItem };
		draftRef.current = next;
		// Mount and focus the textarea in the trusted input event so iOS opens its keyboard.
		flushSync(() => {
			setSelection(item.id);
			setTool("select");
			setDraft(next);
		});
	}

	function typeText(text: string) {
		const current = draftRef.current;
		if (!current) return;
		const next = { ...current, item: layoutText({ ...current.item, text }, page) };
		draftRef.current = next;
		setDraft(next);
	}

	function finishText(save: boolean): Item[] | undefined {
		const current = draftRef.current;
		if (!current) return;
		draftRef.current = null;
		setDraft(null);
		const { item, newItem } = current;
		if (!save) {
			if (newItem) setSelection(null);
			return;
		}
		const edit = (list: Item[]) => {
			if (!item.text.trim()) return newItem ? list : list.filter(({ id }) => id !== item.id);
			if (newItem) return [...list, item];
			return list.map((entry) => (entry.id === item.id ? item : entry));
		};
		if (!item.text.trim()) setSelection(null);
		const original = items.find(({ id }) => id === item.id);
		if (!newItem && original?.kind === "text" && original.text === item.text) return history.items;
		update(edit);
		return edit(history.items);
	}

	function change(item: Item) {
		const next = item.kind === "text" ? layoutText(item, page) : item;
		update((list) => list.map((entry) => (entry.id === item.id ? next : entry)));
	}

	function erase(erased: Set<string>) {
		if (!erased.size) return;
		if (selection && erased.has(selection)) setSelection(null);
		update((list) => list.filter((item) => !erased.has(item.id)));
	}

	function draw(points: Point[]) {
		if (!points.length) return;
		const box = normalizeStrokes([points], pen / 2 + 1);
		const item: Item = { ...box, kind: "ink", id: crypto.randomUUID(), page: index, color, width: pen };
		update((list) => [...list, item]);
	}

	function place([x, y]: Point) {
		const base = { id: crypto.randomUUID(), page: index, x, y, w: 28, h: 28, color };
		let item: Item;
		switch (tool) {
			case "text":
				item = layoutText({ ...base, kind: "text", text: "", size, lines: [], w: Math.min(170, page.w) }, page);
				break;
			case "check":
			case "cross":
			case "dot":
				item = { ...base, kind: "mark", shape: tool };
				break;
			case "signature": {
				if (!signature) return;
				const ratio =
					signature.kind === "typed" ? (measureText(signature.text, 24, true) + 3) / (24 / 0.71) : signature.ratio;
				item = { ...base, kind: "signature", source: signature, w: 36 * ratio, h: 36 };
				break;
			}
			case "image": {
				if (!image) return;
				const { asset, key } = image;
				const scale = 140 / Math.max(asset.w, asset.h);
				item = { ...base, kind: "image", key, natW: asset.w, natH: asset.h, w: asset.w * scale, h: asset.h * scale };
				break;
			}
			default:
				return;
		}
		const factor = Math.min(1, page.w / item.w, page.h / item.h);
		item.w *= factor;
		item.h *= factor;
		item.x = clamp(x - item.w / 2, 0, page.w - item.w);
		item.y = clamp(y - item.h / 2, 0, page.h - item.h);
		if (item.kind === "text") beginText(item, true);
		else {
			update((list) => [...list, item]);
			setSelection(item.id);
			setTool("select");
		}
	}

	function openPage(next: number) {
		if (next === index) return;
		finishText(true);
		setSelection(null);
		setIndex(next);
	}

	function activate(next: Tool) {
		finishText(true);
		if (next === "signature") setSignatureDialog(true);
		else if (next === "image") upload.current?.click();
		else {
			setTool(next);
			if (next !== "select") setSelection(null);
		}
	}

	async function chooseImage(file: File) {
		const id = ++uploadRun.current;
		setMessage(undefined);
		try {
			const asset = await readImage(file);
			if (id !== uploadRun.current) return;
			const key = crypto.randomUUID();
			setImage({ key, asset });
			setAssets((list) => ({ ...list, [key]: asset }));
			setTool("image");
			setSelection(null);
		} catch (error) {
			if (id === uploadRun.current)
				setMessage({
					tone: "danger",
					text: error instanceof Error ? error.message : "This image could not be opened.",
				});
		}
	}

	function chooseSignature(source: Signature, asset?: Asset) {
		if (source.kind === "image" && asset) setAssets((list) => ({ ...list, [source.key]: asset }));
		setSignature(source);
		setSignatureDialog(false);
		setSelection(null);
		setTool("signature");
	}

	function jumpHistory(type: "undo" | "redo") {
		finishText(true);
		dispatch({ type });
		setSelection(null);
	}

	function keyboard(e: KeyboardEvent<HTMLDivElement>) {
		if (signatureDialog || !(e.target instanceof Element) || e.target.closest("input, textarea, select")) return;
		if (e.key === "Escape") {
			if (selection) setSelection(null);
			else setTool("select");
			return;
		}
		if (!(e.ctrlKey || e.metaKey)) return;
		const key = e.key.toLowerCase();
		if (key === "z" || key === "y") {
			e.preventDefault();
			jumpHistory(key === "y" || e.shiftKey ? "redo" : "undo");
		}
	}

	async function download() {
		if (downloading.current) return;
		const items = finishText(true) ?? history.items;
		const name = `${file.name.replace(/\.pdf$/i, "")} (edited).pdf`;
		let target: SaveTarget | null = null;
		downloading.current = true;
		setBusy(true);
		setMessage(undefined);
		try {
			target = await openSaveTarget(name, "application/pdf", "Edited PDF");
			if (!target) return;
			const images: ImageDataMap = {};
			for (const item of items) {
				const key =
					item.kind === "image"
						? item.key
						: item.kind === "signature" && item.source.kind === "image"
							? item.source.key
							: null;
				if (key) images[key] = assets[key].data;
			}
			const result = await api.export(items, images, mode);
			target.write(result.bytes);
			await target.close();
			if (result.unsupported.length)
				setMessage({
					tone: "info",
					text: `Saved ${name}. Some characters were missing from the editor fonts and appear as boxes: ${result.unsupported.slice(0, 10).join(" ")}.`,
				});
			else setMessage({ tone: "success", text: `Saved ${name}.` });
		} catch (error) {
			await target?.abort();
			const detail = error instanceof Error ? error.message : String(error);
			setMessage({
				tone: "danger",
				text: /memory|allocation/i.test(detail)
					? "The edited PDF exceeded available memory. Try with a smaller PDF."
					: `Could not save the edited PDF. ${detail}`,
			});
		} finally {
			downloading.current = false;
			setBusy(false);
		}
	}

	const showColor =
		tool === "text" ||
		tool === "draw" ||
		tool === "check" ||
		tool === "cross" ||
		tool === "dot" ||
		(selected && selected.kind !== "image" && (selected.kind !== "signature" || selected.source.kind !== "image"));
	const textSettings = selected?.kind === "text" || tool === "text";
	const penSettings = selected?.kind === "ink" || tool === "draw";
	const instruction =
		tool === "text"
			? "Tap the page to add a text box."
			: tool === "signature"
				? "Tap the page to place the signature."
				: tool === "image"
					? "Tap the page to place the image."
					: tool === "erase"
						? "Drag across an ink stroke to erase it."
						: tool === "check" || tool === "cross" || tool === "dot"
							? `Tap the page to place a ${tool} mark.`
							: "";

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Shortcuts bubble from focused editor controls.
		<div className={s.workspace} onKeyDown={keyboard}>
			<div className={s.fileRow}>
				<Chip
					badge="PDF"
					name={file.name}
					meta={`${doc.pages.length} ${doc.pages.length === 1 ? "page" : "pages"} · ${formatBytes(file.size)}`}
				/>
				<Button variant="ghost" icon="x" onClick={reset} disabled={busy}>
					Change file
				</Button>
			</div>
			{doc.signed && (
				<Note tone="info">
					This PDF has a digital signature. Editing a signed PDF invalidates its original signature.
				</Note>
			)}
			{(!doc.canFlatten || !doc.canAnnotate) && (
				<Note tone="info">
					{restricted
						? "This PDF restricts editing and annotations. You can preview its pages."
						: "This PDF restricts one of the export modes. You can use the mode shown below."}
				</Note>
			)}
			{file.size > 128 * 1024 * 1024 && (
				<Note tone="info">The download is built in memory. Large PDFs may exceed the browser’s available memory.</Note>
			)}
			<div className={s.editorGrid}>
				<Thumbs
					pages={doc.pages}
					index={index}
					items={history.items}
					assets={assets}
					render={renderThumb}
					open={openPage}
				/>
				<section className={s.canvasRegion} aria-label="PDF page editor">
					<div className={s.canvasHeader}>
						<div className={s.pageNumber}>
							Page {index + 1} of {doc.pages.length}
						</div>
						<fieldset className={s.zoom} aria-label="Page zoom">
							<button
								type="button"
								aria-label="Zoom out"
								disabled={zoom <= 0.5}
								onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
							>
								−
							</button>
							<button type="button" aria-label="Fit page width" onClick={() => setZoom(1)}>
								{zoom === 1 ? "Fit" : `${zoom * 100}%`}
							</button>
							<button
								type="button"
								aria-label="Zoom in"
								disabled={zoom >= 3}
								onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
							>
								+
							</button>
						</fieldset>
					</div>
					{(showColor || textSettings || penSettings || selected || instruction || draft) && (
						<div className={s.properties}>
							{showColor && (
								<fieldset className={s.swatches} aria-label="Ink color">
									{COLORS.map(([value, label]) => (
										<button
											type="button"
											key={value}
											aria-label={label}
											aria-pressed={(selected?.color ?? color) === value}
											style={{ background: value }}
											onClick={() => {
												if (selected) change({ ...selected, color: value });
												setColor(value);
											}}
										/>
									))}
								</fieldset>
							)}
							{textSettings && (
								<label>
									Size{" "}
									<select
										aria-label="Text size"
										value={selected?.kind === "text" ? selected.size : size}
										onChange={(e) => {
											const size = Number(e.target.value);
											setSize(size);
											if (selected?.kind === "text") change({ ...selected, size });
										}}
									>
										{[10, 12, 14, 16, 18, 22, 28, 36, 48].map((point) => (
											<option key={point} value={point}>
												{point} pt
											</option>
										))}
									</select>
								</label>
							)}
							{penSettings && (
								<label>
									Width{" "}
									<select
										aria-label="Stroke width"
										value={selected?.kind === "ink" ? selected.width : pen}
										onChange={(e) => {
											const width = Number(e.target.value);
											setPen(width);
											if (selected?.kind === "ink") change({ ...selected, width });
										}}
									>
										{[...new Set([1, 2, 4, 6, 10, ...(selected?.kind === "ink" ? [selected.width] : [])])].map(
											(point) => (
												<option key={point} value={point}>
													{+point.toFixed(1)} pt
												</option>
											),
										)}
									</select>
								</label>
							)}
							{selected?.kind === "text" && !draft && (
								<button type="button" onClick={() => beginText(selected)}>
									Edit text
								</button>
							)}
							{selected && !draft && (
								<button type="button" onClick={() => erase(new Set([selected.id]))}>
									Delete item
								</button>
							)}
							{draft && (
								<button type="button" onPointerDown={(e) => e.preventDefault()} onClick={() => finishText(true)}>
									Done editing
								</button>
							)}
							{instruction && <small role="status">{instruction}</small>}
						</div>
					)}
					<PageCanvas
						key={index}
						page={page}
						index={index}
						zoom={zoom}
						items={items}
						assets={assets}
						render={render}
						tool={tool}
						color={color}
						strokeWidth={pen}
						selected={selection}
						draft={draft}
						select={setSelection}
						place={place}
						draw={draw}
						erase={erase}
						change={change}
						remove={(id) => erase(new Set([id]))}
						edit={beginText}
						typeText={typeText}
						finishText={finishText}
					/>
				</section>
				{!restricted && (
					<section className={s.export} aria-label="Download edited PDF">
						<Pills label="Save as" value={mode} options={modes} onChange={setMode} disabled={busy} />
						<Button
							icon="download"
							disabled={busy || (!history.items.length && !draft)}
							onClick={() => void download()}
						>
							Download PDF
						</Button>
						{busy && <Progress value={0} max={0} label="Preparing PDF…" />}
						{message && <Note tone={message.tone}>{message.text}</Note>}
					</section>
				)}
				<fieldset className={s.toolbar} aria-label="Editing tools">
					{!restricted && (
						<>
							<div className={s.tools}>
								{TOOLS.map(([value, label]) => (
									<button
										type="button"
										key={value}
										aria-pressed={tool === value}
										disabled={(value === "signature" || value === "text") && !fontReady}
										onClick={() => activate(value)}
									>
										{label}
									</button>
								))}
							</div>
							<div className={s.history}>
								<button type="button" disabled={!history.past.length && !draft} onClick={() => jumpHistory("undo")}>
									Undo
								</button>
								<button type="button" disabled={!history.future.length} onClick={() => jumpHistory("redo")}>
									Redo
								</button>
							</div>
						</>
					)}
				</fieldset>
			</div>
			<input
				ref={upload}
				type="file"
				accept={IMAGE_ACCEPT}
				aria-label="Image to place"
				hidden
				onChange={(e) => {
					const file = e.target.files?.[0];
					e.target.value = "";
					if (file) void chooseImage(file);
				}}
			/>
			{signatureDialog && <SignatureDialog onClose={() => setSignatureDialog(false)} onChoose={chooseSignature} />}
		</div>
	);
}
