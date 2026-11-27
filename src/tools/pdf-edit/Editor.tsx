import type { Remote } from "comlink";
import { type KeyboardEvent, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { formatBytes } from "../../lib/format.ts";
import { openSaveTarget, type SaveTarget } from "../../lib/saveFile.ts";
import { Button, Chip, Note, Pills, Progress } from "../../lib/ui.tsx";
import { ZipWriter } from "../../lib/zipWriter.ts";
import type { FormPlan } from "./assemble.ts";
import type { EditApi, OpenDocument } from "./edit.worker.ts";
import { FieldOverlay, FormPanel } from "./FormPanel.tsx";
import { layoutText, loadPreviewFonts, measureText } from "./fonts.ts";
import { type FormField, type FormValues, formChanges, initialValues, missingRequired } from "./forms.ts";
import type { Point } from "./geometry.ts";
import { editHistory, startHistory } from "./history.ts";
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
import { PageSorter, type SplitOutput } from "./PageSorter.tsx";
import s from "./PdfEdit.module.css";
import {
	centerInside,
	initialPages,
	insertPages,
	planPages,
	primaryPage,
	rangeLabel,
	type Snapshot,
	type Source,
	samePages,
} from "./pages.ts";
import { createRenderCache, pageKey } from "./render.ts";
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
const FORM_MODES = [
	{ value: "keep", label: "Keep fields fillable" },
	{ value: "flatten", label: "Flatten form" },
] as const;

type View = "edit" | "pages" | "form";

function imagesFor(items: Item[], assets: Record<string, Asset>): ImageDataMap {
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
	return images;
}

/** Downloads without a save dialog, for the second and later files of a split. */
function downloadBytes(name: string, bytes: Uint8Array<ArrayBuffer>) {
	const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function uniqueNames(names: string[]): string[] {
	const seen = new Map<string, number>();
	return names.map((name) => {
		const count = (seen.get(name) ?? 0) + 1;
		seen.set(name, count);
		return count === 1 ? name : name.replace(/\.pdf$/i, ` (${count}).pdf`);
	});
}

function describeError(error: unknown, what: string) {
	const detail = error instanceof Error ? error.message : String(error);
	return /memory|allocation/i.test(detail)
		? `The ${what} exceeded available memory. Try with a smaller PDF.`
		: `Could not save the ${what}. ${detail}`;
}

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
	const initial = useMemo(() => initialPages(0, doc.pages.length), [doc]);
	const [history, dispatch] = useReducer(editHistory, { pages: initial, items: [] }, startHistory);
	const [sources, setSources] = useState<Source[]>(() => [{ id: 0, name: file.name, pages: doc.pages }]);
	const fields = doc.form.fields;
	const fillable = fields.length > 0 && doc.form.xfa !== "only" && (doc.canFlatten || doc.canAnnotate);
	const [view, setView] = useState<View>(fillable ? "form" : "edit");
	const [current, setCurrent] = useState(initial[0].id);
	const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
	const [values, setValues] = useState<FormValues>(() => initialValues(fields));
	const [formMode, setFormMode] = useState<"keep" | "flatten">("keep");
	const [activeField, setActiveField] = useState<string>();
	const [showMissing, setShowMissing] = useState(false);
	const [missingPrompt, setMissingPrompt] = useState<FormField[] | null>(null);
	const [signingField, setSigningField] = useState<FormField | null>(null);
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
	const renderCard = useMemo(() => createRenderCache(api, 60), [api]);
	const { pages, items: allItems } = history.present;
	const currentRef = pages.find(({ id }) => id === current) ?? pages[0];
	const pageNumber = pages.indexOf(currentRef) + 1;
	const page = sources[currentRef.source].pages[currentRef.index];
	const items = allItems.filter((item) => item.page === currentRef.id);
	const selected = items.find((item) => item.id === selection);
	const restricted = !doc.canFlatten && !doc.canAnnotate;
	const canPages = doc.canFlatten;
	const modes = MODES.filter(({ value }) => (value === "flatten" ? doc.canFlatten : doc.canAnnotate)).map((entry) => ({
		...entry,
	}));
	const baseName = file.name.replace(/\.pdf$/i, "");

	// Form fields whose page is still in the document, in document order.
	const fieldPage = (field: FormField) => {
		const ref = primaryPage(pages, 0, field.widgets[0]?.page ?? -1);
		return ref ? pages.indexOf(ref) + 1 : undefined;
	};
	const shownFields = fillable
		? fields.filter((field) => fieldPage(field) !== undefined).sort((a, b) => (fieldPage(a) ?? 0) - (fieldPage(b) ?? 0))
		: [];
	const signatureOn = (field: FormField, list: Item[]) => {
		const widget = field.widgets[0];
		const ref = widget && primaryPage(pages, 0, widget.page);
		return ref
			? list.filter((item) => item.kind === "signature" && item.page === ref.id && centerInside(item, widget.rect))
			: [];
	};
	const signedFields = new Set(
		shownFields.filter((field) => field.kind === "signature" && signatureOn(field, allItems).length).map((f) => f.name),
	);
	const missing = missingRequired(shownFields, values, signedFields);
	const missingNames = new Set(showMissing ? missing.map(({ name }) => name) : []);
	const formChanged = fillable && Object.keys(formChanges(fields, values)).length > 0;
	const dirty =
		allItems.length > 0 || !samePages(pages, initial) || formChanged || (fillable && formMode === "flatten");

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

	function change(update: (state: Snapshot) => Snapshot) {
		dispatch({ type: "change", update });
	}

	function update(updateItems: (items: Item[]) => Item[]) {
		change((state) => {
			const next = updateItems(state.items);
			return next === state.items ? state : { ...state, items: next };
		});
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
		if (!newItem && original?.kind === "text" && original.text === item.text) return allItems;
		update(edit);
		return edit(allItems);
	}

	function changeItem(item: Item) {
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
		const item: Item = { ...box, kind: "ink", id: crypto.randomUUID(), page: currentRef.id, color, width: pen };
		update((list) => [...list, item]);
	}

	function signatureRatio(source: Signature) {
		return source.kind === "typed" ? (measureText(source.text, 24, true) + 3) / (24 / 0.71) : source.ratio;
	}

	function place([x, y]: Point) {
		const base = { id: crypto.randomUUID(), page: currentRef.id, x, y, w: 28, h: 28, color };
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
				const ratio = signatureRatio(signature);
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

	function openPage(next: string) {
		if (next === currentRef.id) return;
		finishText(true);
		setSelection(null);
		setCurrent(next);
	}

	function switchView(next: View) {
		finishText(true);
		setSelection(null);
		setTool("select");
		setMessage(undefined);
		setView(next);
	}

	function activate(next: Tool) {
		finishText(true);
		if (next === "signature") {
			setSigningField(null);
			setSignatureDialog(true);
		} else if (next === "image") upload.current?.click();
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

	/** Fits a signature into a signature field's rectangle, replacing one placed there before. */
	function signField(field: FormField, source: Signature) {
		const widget = field.widgets[0];
		const ref = widget && primaryPage(pages, 0, widget.page);
		if (!ref) return;
		const [x0, y0, x1, y1] = widget.rect;
		const ratio = signatureRatio(source);
		const h = Math.min((y1 - y0) * 0.9, ((x1 - x0) * 0.92) / ratio);
		const w = h * ratio;
		const item: Item = {
			id: crypto.randomUUID(),
			page: ref.id,
			kind: "signature",
			source,
			color: COLORS[0][0],
			w,
			h,
			x: x0 + (x1 - x0 - w) / 2,
			y: y0 + (y1 - y0 - h) / 2,
		};
		const old = new Set(signatureOn(field, allItems).map(({ id }) => id));
		update((list) => [...list.filter(({ id }) => !old.has(id)), item]);
		setCurrent(ref.id);
	}

	function chooseSignature(source: Signature, asset?: Asset) {
		if (source.kind === "image" && asset) setAssets((list) => ({ ...list, [source.key]: asset }));
		setSignatureDialog(false);
		setSelection(null);
		if (signingField) {
			signField(signingField, source);
			setSigningField(null);
			return;
		}
		setSignature(source);
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

	function formPlan(): FormPlan | undefined {
		if (!fillable) return;
		const changes = formChanges(fields, values);
		const flatten = formMode === "flatten";
		return Object.keys(changes).length || flatten ? { values: changes, flatten } : undefined;
	}

	async function build(state: Snapshot, indices?: number[]) {
		return api.export(planPages(state, indices), imagesFor(state.items, assets), mode, formPlan());
	}

	function savedMessage(text: string, unsupported: string[]) {
		if (unsupported.length)
			setMessage({
				tone: "info",
				text: `${text} Some characters were missing from the editor fonts and appear as boxes: ${unsupported.slice(0, 10).join(" ")}.`,
			});
		else setMessage({ tone: "success", text });
	}

	async function download(confirmed = false) {
		if (downloading.current) return;
		const state = { pages, items: finishText(true) ?? allItems };
		if (!confirmed && fillable) {
			const empty = missingRequired(shownFields, values, signedFields);
			if (empty.length) {
				setShowMissing(true);
				setMissingPrompt(empty);
				return;
			}
		}
		setMissingPrompt(null);
		const name = `${baseName} (edited).pdf`;
		let target: SaveTarget | null = null;
		downloading.current = true;
		setBusy(true);
		setMessage(undefined);
		try {
			target = await openSaveTarget(name, "application/pdf", "Edited PDF");
			if (!target) return;
			const result = await build(state);
			target.write(result.bytes);
			await target.close();
			savedMessage(`Saved ${name}.`, result.unsupported);
		} catch (error) {
			await target?.abort();
			setMessage({ tone: "danger", text: describeError(error, "edited PDF") });
		} finally {
			downloading.current = false;
			setBusy(false);
		}
	}

	async function exportPages(groups: number[][], output: SplitOutput) {
		if (downloading.current || !groups.length) return;
		const state = { pages, items: finishText(true) ?? allItems };
		const names = uniqueNames(groups.map((group) => `${baseName} (${rangeLabel(group)}).pdf`));
		const zip = groups.length > 1 && output === "zip";
		let target: SaveTarget | null = null;
		downloading.current = true;
		setBusy(true);
		setMessage(undefined);
		try {
			if (zip || groups.length === 1) {
				const name = zip ? `${baseName} (split).zip` : names[0];
				target = await openSaveTarget(name, zip ? "application/zip" : "application/pdf", zip ? "ZIP archive" : "PDF");
				if (!target) return;
			}
			const unsupported = new Set<string>();
			const writer = zip && target ? new ZipWriter(target.write.bind(target)) : null;
			for (const [i, group] of groups.entries()) {
				const result = await build(state, group);
				for (const char of result.unsupported) unsupported.add(char);
				if (writer) writer.add(names[i], result.bytes, false);
				else if (target) target.write(result.bytes);
				else downloadBytes(names[i], result.bytes);
			}
			writer?.finish();
			await target?.close();
			savedMessage(
				zip
					? `Saved ${baseName} (split).zip with ${groups.length} PDFs.`
					: groups.length === 1
						? `Saved ${names[0]}.`
						: `Saved ${groups.length} PDFs.`,
				[...unsupported],
			);
		} catch (error) {
			await target?.abort();
			setMessage({ tone: "danger", text: describeError(error, "PDF") });
		} finally {
			downloading.current = false;
			setBusy(false);
		}
	}

	function addSource(source: Source, after: number) {
		setSources((list) => {
			const next = [...list];
			next[source.id] = source;
			return next;
		});
		const added = initialPages(source.id, source.pages.length, () => crypto.randomUUID());
		change((state) => ({ ...state, pages: insertPages(state.pages, added, after) }));
		setSelectedPages(new Set(added.map(({ id }) => id)));
		setMessage({
			tone: "success",
			text: `Added ${source.pages.length} ${source.pages.length === 1 ? "page" : "pages"} from ${source.name}.`,
		});
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

	const historyButtons = (
		<div className={s.history}>
			<button type="button" disabled={!history.past.length && !draft} onClick={() => jumpHistory("undo")}>
				Undo
			</button>
			<button type="button" disabled={!history.future.length} onClick={() => jumpHistory("redo")}>
				Redo
			</button>
		</div>
	);

	const exportPanel = !restricted && (
		<section className={s.export} aria-label="Download edited PDF">
			<Pills label="Save edits as" value={mode} options={modes} onChange={setMode} disabled={busy} />
			{fillable && (
				<Pills
					label="Form fields"
					value={formMode}
					options={FORM_MODES.map((entry) => ({ ...entry }))}
					onChange={setFormMode}
					disabled={busy}
				/>
			)}
			{fillable && missing.length > 0 && !missingPrompt && (
				<small className={s.fieldHint}>
					{missing.length} required {missing.length === 1 ? "field is" : "fields are"} empty.
				</small>
			)}
			<Button icon="download" disabled={busy || (!dirty && !draft && !fillable)} onClick={() => void download()}>
				Download PDF
			</Button>
			{missingPrompt && (
				<div className={s.missing} role="alert">
					<p>
						{missingPrompt.length === 1 ? "A required field is" : `${missingPrompt.length} required fields are`} empty:{" "}
						{missingPrompt.map((field) => field.label).join(", ")}.
					</p>
					<div className={s.missingActions}>
						<button
							type="button"
							onClick={() => {
								setMissingPrompt(null);
								switchView("form");
							}}
						>
							Fill them in
						</button>
						<button type="button" onClick={() => void download(true)}>
							Download anyway
						</button>
					</div>
				</div>
			)}
			{busy && <Progress value={0} max={0} label="Preparing PDF…" />}
			{message && <Note tone={message.tone}>{message.text}</Note>}
		</section>
	);

	const overlay =
		view === "form" && currentRef.source === 0 && primaryPage(pages, 0, currentRef.index) === currentRef ? (
			<FieldOverlay
				fields={shownFields}
				page={currentRef.index}
				size={page}
				values={values}
				missing={missingNames}
				active={activeField}
			/>
		) : null;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Shortcuts bubble from focused editor controls.
		<div className={s.workspace} onKeyDown={keyboard} data-view={view}>
			<div className={s.fileRow}>
				<Chip
					badge="PDF"
					name={file.name}
					meta={`${pages.length} ${pages.length === 1 ? "page" : "pages"} · ${formatBytes(file.size)}${sources.length > 1 ? ` · ${sources.length} files` : ""}`}
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
			{doc.form.xfa === "only" && (
				<Note tone="danger">
					This PDF is a dynamic XFA form. XFA forms can’t be filled here; open it in Adobe Acrobat or Reader to fill it.
					You can still edit, sign and rearrange its pages.
				</Note>
			)}
			{file.size > 128 * 1024 * 1024 && (
				<Note tone="info">The download is built in memory. Large PDFs may exceed the browser’s available memory.</Note>
			)}
			<div className={s.viewBar}>
				<div className={s.views} role="tablist" aria-label="Editor view">
					<button type="button" role="tab" aria-selected={view === "edit"} onClick={() => switchView("edit")}>
						Edit
					</button>
					{canPages && (
						<button type="button" role="tab" aria-selected={view === "pages"} onClick={() => switchView("pages")}>
							Pages
						</button>
					)}
					{fillable && (
						<button type="button" role="tab" aria-selected={view === "form"} onClick={() => switchView("form")}>
							Fill form
						</button>
					)}
				</div>
				{view !== "edit" && !restricted && historyButtons}
			</div>
			{view === "pages" ? (
				<PageSorter
					api={api}
					state={history.present}
					sources={sources}
					selected={selectedPages}
					setSelected={setSelectedPages}
					change={change}
					addSource={addSource}
					open={(id) => {
						setCurrent(id);
						switchView("edit");
					}}
					render={renderCard}
					assets={assets}
					busy={busy}
					exportPages={(groups, output) => void exportPages(groups, output)}
					canMerge={canPages}
				>
					{exportPanel}
				</PageSorter>
			) : (
				<div className={s.editorGrid}>
					<Thumbs
						pages={pages}
						sources={sources}
						current={currentRef.id}
						items={allItems}
						assets={assets}
						render={renderThumb}
						open={openPage}
					/>
					<section className={s.canvasRegion} aria-label="PDF page editor">
						<div className={s.canvasHeader}>
							<div className={s.pageNumber}>
								Page {pageNumber} of {pages.length}
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
													if (selected) changeItem({ ...selected, color: value });
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
												if (selected?.kind === "text") changeItem({ ...selected, size });
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
												if (selected?.kind === "ink") changeItem({ ...selected, width });
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
							key={currentRef.id}
							page={page}
							rotate={currentRef.rotate}
							pageKey={pageKey(currentRef)}
							number={pageNumber}
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
							change={changeItem}
							remove={(id) => erase(new Set([id]))}
							edit={beginText}
							typeText={typeText}
							finishText={finishText}
						>
							{overlay}
						</PageCanvas>
					</section>
					<div className={s.side}>
						{view === "form" && (
							<FormPanel
								form={doc.form}
								fields={shownFields}
								values={values}
								missing={missingNames}
								signedFields={signedFields}
								setValue={(name, value) => {
									setValues((list) => ({ ...list, [name]: value }));
									if (missingPrompt) setMissingPrompt(null);
								}}
								focus={(field) => {
									setActiveField(field.name);
									const ref = primaryPage(pages, 0, field.widgets[0]?.page ?? -1);
									if (ref) openPage(ref.id);
								}}
								sign={(field) => {
									setSigningField(field);
									setSignatureDialog(true);
								}}
								unsign={(field) => {
									const placed = new Set(signatureOn(field, allItems).map(({ id }) => id));
									update((list) => list.filter(({ id }) => !placed.has(id)));
								}}
								pageNumber={fieldPage}
							/>
						)}
						{exportPanel}
					</div>
					{view === "edit" && (
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
									{historyButtons}
								</>
							)}
						</fieldset>
					)}
				</div>
			)}
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
			{signatureDialog && (
				<SignatureDialog
					onClose={() => {
						setSignatureDialog(false);
						setSigningField(null);
					}}
					onChoose={chooseSignature}
				/>
			)}
		</div>
	);
}
