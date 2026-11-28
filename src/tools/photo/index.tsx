// Photo Converter: HEIC → JPEG or PNG, and JPEG ⇄ PNG, in a worker. One photo downloads as itself;
// several download as one zip. README: "How the photo converter works".
import { useEffect, useRef, useState } from "react";
import {
	type Collected,
	canPickDirectory,
	canPickFolders,
	fromDrop,
	fromInput,
	pickDirectory,
} from "../../lib/collect.ts";
import { explainOnce } from "../../lib/confirm.tsx";
import { detectFile } from "../../lib/detect.ts";
import { formatBytes, formatDuration } from "../../lib/format.ts";
import { Icon } from "../../lib/Icon.tsx";
import { openSaveTarget, type SaveTarget } from "../../lib/saveFile.ts";
import { Button, Card, Note, Pills, Progress } from "../../lib/ui.tsx";
import { startWorker, type WorkerHandle } from "../../lib/worker.ts";
import { ZipWriter } from "../../lib/zipWriter.ts";
import type { ConvertOptions, InputKind } from "./convert.ts";
import { type OutputFormat, outputName, uniqueNames, zipName } from "./names.ts";
import s from "./Photo.module.css";
import type { PhotoWorker } from "./photo.worker.ts";

type Status = "waiting" | "converting" | "done" | "error";

interface Item {
	id: number;
	path: string;
	file: File;
	kind: InputKind;
	status: Status;
	out?: { name: string; size: number; color: string };
	notes: string[];
	error?: string;
}

interface Options {
	format: OutputFormat;
	quality: number;
	stripGps: boolean;
	srgb: boolean;
}

const DEFAULTS: Options = { format: "jpeg", quality: 92, stripGps: false, srgb: false };
const STORAGE_KEY = "toolbox.photo.options";

function loadOptions(): Options {
	try {
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Options> | null;
		if (!saved) return DEFAULTS;
		return {
			format: saved.format === "png" ? "png" : "jpeg",
			quality: Number.isFinite(saved.quality) ? Math.min(100, Math.max(50, Number(saved.quality))) : DEFAULTS.quality,
			stripGps: saved.stripGps === true,
			srgb: saved.srgb === true,
		};
	} catch {
		return DEFAULTS;
	}
}

type Run =
	| { kind: "running"; done: number; total: number; current: string; started: number }
	| { kind: "finished"; tone: "success" | "danger" | "info"; message: string };

const KIND_LABEL: Record<InputKind, string> = { heic: "HEIC", jpeg: "JPEG", png: "PNG" };

let nextId = 1;

export default function PhotoConverter() {
	const [items, setItems] = useState<Item[]>([]);
	const [skipped, setSkipped] = useState<string[]>([]);
	const [folder, setFolder] = useState<string | null>(null);
	const [options, setOptions] = useState<Options>(loadOptions);
	const [run, setRun] = useState<Run>();
	const [dragging, setDragging] = useState(false);
	const depth = useRef(0);
	const folderInput = useRef<HTMLInputElement>(null);
	const worker = useRef<WorkerHandle<PhotoWorker> | null>(null);
	const active = useRef<{ target?: SaveTarget; canceled?: boolean } | null>(null);
	const busy = run?.kind === "running";
	const folderSupport = canPickFolders();

	useEffect(() => {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
		} catch {
			// Private windows may refuse storage; the defaults return next time.
		}
	}, [options]);

	useEffect(
		() => () => {
			worker.current?.terminate();
			worker.current = null;
		},
		[],
	);

	const set = (patch: Partial<Options>) => setOptions((o) => ({ ...o, ...patch }));
	const update = (id: number, patch: Partial<Item>) =>
		setItems((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)));

	async function add(collected: Collected) {
		const photos: Item[] = [];
		const rejected = [...collected.skipped];
		for (const { path, file } of collected.files) {
			if (/(^|\/)\.[^/]*$/.test(path) || /(^|\/)__MACOSX\//.test(path)) continue; // hidden and macOS metadata files
			const format = await detectFile(file);
			if (format === "heic" || format === "jpeg" || format === "png")
				photos.push({ id: nextId++, path, file, kind: format, status: "waiting", notes: [] });
			else rejected.push(format === "avif" ? `${path} (AVIF isn't supported yet)` : path);
		}
		// A single dropped or picked folder names the zip.
		const tops = new Set(collected.files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
		const top = tops.size === 1 ? [...tops][0] : "";
		setFolder((before) => (items.length === 0 ? top || null : before === top ? before : null));
		setItems((list) => [...list, ...photos]);
		setSkipped((list) => [...list, ...rejected]);
		setRun(undefined);
	}

	function clear() {
		setItems([]);
		setSkipped([]);
		setFolder(null);
		setRun(undefined);
	}

	async function addFolder() {
		if (!canPickDirectory()) {
			folderInput.current?.click();
			return;
		}
		const ok = await explainOnce("read-folder", {
			title: "Add a folder",
			message:
				"Next, your browser asks you to pick a folder and to let this site view its files. Nothing is uploaded; the photos stay on this device. Tip: dragging a folder onto the box adds it without that question.",
			confirmLabel: "Choose folder",
		});
		if (!ok) return;
		try {
			const picked = await pickDirectory();
			if (picked) await add(picked);
		} catch (error) {
			setRun({ kind: "finished", tone: "danger", message: error instanceof Error ? error.message : String(error) });
		}
	}

	function connect() {
		worker.current ??= startWorker<PhotoWorker>(
			() => new Worker(new URL("./photo.worker.ts", import.meta.url), { type: "module" }),
		);
		return worker.current.api;
	}

	async function convertAll() {
		if (busy || !items.length) return;
		const operation: { target?: SaveTarget; canceled?: boolean } = {};
		active.current = operation;
		const list = items.map((item) => ({
			...item,
			status: "waiting" as Status,
			notes: [],
			error: undefined,
			out: undefined,
		}));
		setItems(list);
		const started = performance.now();
		setRun({ kind: "running", done: 0, total: list.length, current: list[0].path, started });
		const convertOptions: ConvertOptions = { ...options };
		const single = list.length === 1;
		const mime = options.format === "jpeg" ? "image/jpeg" : "image/png";
		const names = uniqueNames();
		let zip: ZipWriter | null = null;
		let ok = 0;
		let inBytes = 0;
		let outBytes = 0;
		try {
			if (!single) {
				// Open the zip in the click, before any work: very large batches may ask where to save it.
				const estimate = list.reduce((n, i) => n + i.file.size, 0) * (options.format === "png" ? 12 : 1.6);
				const target = await openSaveTarget(zipName(folder), "application/zip", "Zip archive", estimate);
				if (!target) {
					setRun(undefined);
					active.current = null;
					return;
				}
				operation.target = target;
				zip = new ZipWriter((chunk) => target.write(chunk));
			}
			const api = await connect();
			for (const [index, item] of list.entries()) {
				if (operation.canceled) return;
				update(item.id, { status: "converting" });
				setRun({ kind: "running", done: index, total: list.length, current: item.path, started });
				try {
					const result = await api.convert(item.file, item.kind, convertOptions);
					if (operation.canceled) return;
					const name = names(outputName(item.path, options.format));
					if (zip) {
						const entry = zip.addStream(name, result.bytes.length, result.taken?.getTime() ?? item.file.lastModified);
						entry.write(result.bytes);
						entry.close();
					} else {
						const target = await openSaveTarget(name.split("/").pop() ?? name, mime, "Photo", result.bytes.length);
						if (!target) {
							update(item.id, { status: "waiting" });
							setRun(undefined);
							return;
						}
						operation.target = target;
						target.write(result.bytes);
						await target.close();
					}
					ok++;
					inBytes += item.file.size;
					outBytes += result.bytes.length;
					update(item.id, {
						status: "done",
						out: { name, size: result.bytes.length, color: result.color },
						notes: result.notes,
					});
				} catch (error) {
					if (operation.canceled) return;
					const message = error instanceof Error ? error.message : String(error);
					update(item.id, { status: "error", error: friendly(message) });
				}
			}
			if (zip && operation.target) {
				if (ok === 0) {
					await operation.target.abort();
				} else {
					zip.finish();
					await operation.target.close();
				}
			}
			const failed = list.length - ok;
			const took = formatDuration(performance.now() - started);
			setRun({
				kind: "finished",
				tone: failed === 0 ? "success" : ok === 0 ? "danger" : "info",
				message:
					ok === 0
						? "None of the photos could be converted."
						: `${single ? `Saved ${outputName(list[0].path, options.format).split("/").pop()}` : `Saved ${ok} ${ok === 1 ? "photo" : "photos"} in ${zipName(folder)}`} · ${formatBytes(inBytes)} → ${formatBytes(outBytes)} in ${took}.${failed ? ` ${failed} couldn't be converted; see the list.` : ""}`,
			});
		} catch (error) {
			if (operation.canceled) return;
			await operation.target?.abort();
			setRun({
				kind: "finished",
				tone: "danger",
				message: friendly(error instanceof Error ? error.message : String(error)),
			});
		} finally {
			if (active.current === operation) active.current = null;
		}
	}

	async function cancel() {
		const operation = active.current;
		if (!operation) return;
		operation.canceled = true;
		active.current = null;
		// Stopping the worker is the only way to interrupt a photo mid-conversion; a new one starts next time.
		worker.current?.terminate();
		worker.current = null;
		await operation.target?.abort();
		setItems((list) =>
			list.map((item) =>
				item.status === "converting" || item.status === "waiting" ? { ...item, status: "waiting" } : item,
			),
		);
		setRun({ kind: "finished", tone: "info", message: "Canceled. Nothing was saved." });
	}

	const total = items.reduce((n, i) => n + i.file.size, 0);
	const kinds = new Set(items.map((i) => i.kind));
	const pct = run?.kind === "running" ? run.done : 0;

	return (
		<div className={s.tool}>
			<header className={s.heading}>
				<h1>Photo Converter</h1>
				<p className={s.intro}>
					Convert iPhone HEIC photos to JPEG or PNG, and JPEG ⇄ PNG. Colors, orientation and details stay as they were.
					Nothing is uploaded.
				</p>
			</header>

			<section
				className={s.tool}
				aria-label="Photos to convert"
				onDragEnter={(event) => {
					event.preventDefault();
					depth.current++;
					setDragging(true);
				}}
				onDragOver={(event) => event.preventDefault()}
				onDragLeave={() => {
					depth.current = Math.max(0, depth.current - 1);
					if (depth.current === 0) setDragging(false);
				}}
				onDrop={(event) => {
					event.preventDefault();
					depth.current = 0;
					setDragging(false);
					if (busy) return;
					void fromDrop(event.dataTransfer).then(add);
				}}
			>
				<div className={`${s.adder} ${dragging ? s.dragging : ""}`}>
					<span className={s.adderIcon}>
						<Icon name="image" size={22} />
					</span>
					<div className={s.adderText}>
						<strong>{dragging ? "Release to add" : "Add photos"}</strong>
						<span className={s.hint}>
							HEIC, JPEG or PNG.{" "}
							{folderSupport ? "Drag photos or folders here, or use the buttons." : "Choose photos with the button."}{" "}
							Photos stay on this device.
						</span>
					</div>
					<div className={s.buttons}>
						<label className={s.fileButton}>
							<input
								type="file"
								multiple
								accept="image/heic,image/heif,.heic,.heif,image/jpeg,.jpg,.jpeg,image/png,.png"
								disabled={busy}
								aria-label="Choose photos"
								onChange={(event) => {
									if (event.currentTarget.files) void add(fromInput(event.currentTarget.files));
									event.currentTarget.value = "";
								}}
							/>
							<Icon name="image" size={16} />
							Choose photos
						</label>
						{folderSupport && (
							<>
								<Button variant="ghost" icon="folder" disabled={busy} onClick={() => void addFolder()}>
									Choose folder
								</Button>
								<input
									ref={folderInput}
									type="file"
									hidden
									{...{ webkitdirectory: "" }}
									onChange={(event) => {
										if (event.currentTarget.files) void add(fromInput(event.currentTarget.files));
										event.currentTarget.value = "";
									}}
								/>
							</>
						)}
					</div>
				</div>

				{skipped.length > 0 && (
					<Note tone="info">
						Skipped {skipped.length} {skipped.length === 1 ? "file" : "files"} that{" "}
						{skipped.length === 1 ? "isn't" : "aren't"} HEIC, JPEG or PNG: {skipped.slice(0, 3).join(", ")}
						{skipped.length > 3 ? "…" : ""}
					</Note>
				)}

				{items.length > 0 && (
					<>
						<Card className={s.options}>
							<Pills
								label="Convert to"
								value={options.format}
								disabled={busy}
								options={[
									{ value: "jpeg", label: "JPEG" },
									{ value: "png", label: "PNG" },
								]}
								onChange={(format) => set({ format })}
							/>
							<div className={s.optionRow}>
								{options.format === "jpeg" && (
									<label className={s.quality}>
										<span>
											Quality <output>{options.quality}</output>
										</span>
										<input
											type="range"
											min={50}
											max={100}
											value={options.quality}
											disabled={busy}
											onChange={(event) => set({ quality: Number(event.currentTarget.value) })}
										/>
									</label>
								)}
								<Toggle
									label="Remove location"
									detail="Strips GPS coordinates from the copies"
									checked={options.stripGps}
									disabled={busy}
									onChange={(stripGps) => set({ stripGps })}
								/>
								<Toggle
									label="sRGB for maximum compatibility"
									detail="For sites that ignore color profiles. Vivid iPhone colors are slightly muted."
									checked={options.srgb}
									disabled={busy}
									onChange={(srgb) => set({ srgb })}
								/>
							</div>
							{options.format === "png" && kinds.has("heic") && (
								<p className={s.muted}>
									PNG keeps every pixel exactly, but files are about ten times larger than JPEG.
								</p>
							)}
						</Card>

						<div className={s.summary}>
							<p className={s.totals}>
								{items.length} {items.length === 1 ? "photo" : "photos"} · {formatBytes(total)}
							</p>
							<Button variant="ghost" disabled={busy} onClick={clear}>
								Clear list
							</Button>
						</div>
						<ul className={s.list} aria-label="Photos">
							{items.map((item) => (
								<Row key={item.id} item={item} format={options.format} />
							))}
						</ul>

						{run?.kind === "running" ? (
							<>
								<Progress
									value={pct}
									max={run.total}
									label={`Converting ${Math.min(run.done + 1, run.total)} of ${run.total}`}
									detail={run.current}
								/>
								<div className={s.actions}>
									<Button variant="ghost" icon="x" onClick={() => void cancel()}>
										Cancel
									</Button>
								</div>
							</>
						) : (
							<div className={s.actions}>
								<Button icon="download" onClick={() => void convertAll()}>
									{items.length === 1
										? `Convert to ${options.format === "jpeg" ? "JPEG" : "PNG"}`
										: `Convert ${items.length} photos`}
								</Button>
								<span className={s.muted}>
									{items.length === 1 ? "Downloads the converted photo." : `Downloads one zip: ${zipName(folder)}.`}
								</span>
							</div>
						)}
						{run?.kind === "finished" && <Note tone={run.tone}>{run.message}</Note>}
					</>
				)}
			</section>
		</div>
	);
}

function Row({ item, format }: { item: Item; format: OutputFormat }) {
	const label =
		item.status === "done"
			? "Done"
			: item.status === "error"
				? "Couldn't convert"
				: item.status === "converting"
					? "Converting…"
					: `${KIND_LABEL[item.kind]} → ${format === "jpeg" ? "JPEG" : "PNG"}`;
	return (
		<li className={s.row}>
			<span className={s.name}>
				<strong title={item.path}>{item.path}</strong>
				{item.out && (
					<small>
						{item.out.name} · {item.out.color}
					</small>
				)}
			</span>
			<span className={s.size}>
				{formatBytes(item.file.size)}
				{item.out ? ` → ${formatBytes(item.out.size)}` : ""}
			</span>
			<span className={s.status} data-state={item.status}>
				{label}
			</span>
			{item.error && (
				<p className={s.rowNote} data-tone="error">
					{item.error}
				</p>
			)}
			{item.notes.map((note) => (
				<p key={note} className={s.rowNote}>
					{note}
				</p>
			))}
		</li>
	);
}

function Toggle({
	label,
	detail,
	checked,
	disabled,
	onChange,
}: {
	label: string;
	detail: string;
	checked: boolean;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			className={s.switch}
			disabled={disabled}
			onClick={() => onChange(!checked)}
		>
			<span className={s.switchTrack} aria-hidden="true">
				<span className={s.switchThumb} />
			</span>
			<span className={s.switchText}>
				{label}
				<small>{detail}</small>
			</span>
		</button>
	);
}

/** Turns codec and memory failures into something a person can act on. */
function friendly(message: string): string {
	if (/memory|allocation|RangeError|Out of bounds/i.test(message))
		return "The browser ran out of memory for this photo. Close other tabs and try again, or use a computer for very large photos.";
	if (/Not a readable HEIF|No primary image|Unsupported/i.test(message))
		return "This HEIC file couldn't be read. It may use a format variant this tool doesn't support.";
	return message;
}
