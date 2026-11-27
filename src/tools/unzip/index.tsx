import * as Comlink from "comlink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "../../lib/format.ts";
import { Icon } from "../../lib/Icon.tsx";
import { Button, Card, Chip, FileDrop, Note, Progress } from "../../lib/ui.tsx";
import { startWorker, type WorkerHandle } from "../../lib/worker.ts";
import { ArchiveTree, makeTree } from "./ArchiveTree.tsx";
import Create from "./Create.tsx";
import type { Archive } from "./engine/listing.ts";
import { outputPaths } from "./names.ts";
import { imageType, MAX_PREVIEW, Preview, type PreviewState, previewContent, TEXT_PREVIEW } from "./Preview.tsx";
import { archiveBase, canSaveFolder, type Destination, openDownload, openFolder } from "./save.ts";
import s from "./Unzip.module.css";
import type { UnzipWorker } from "./unzip.worker.ts";

const ACCEPT =
	".zip,.7z,.rar,.tar,.gz,.gzip,.tgz,.bz2,.bzip2,.tbz,.tbz2,.xz,.txz,.zst,.zstd,.tzst,.iso,.cab,.cpio,.ar,.deb,.rpm,.epub";

function message(error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	switch (reason) {
		case "NEEDS_PASSWORD":
			return "This archive requires a password.";
		case "WRONG_PASSWORD":
			return "Wrong password, try again.";
		case "OOM":
			return "7-Zip ran out of memory. Try a smaller archive or close other tabs.";
		case "UNSUPPORTED":
			return "7-Zip could not open this archive or its compression method.";
		case "MISSING_VOLUME":
			return "A volume is missing. Open a single-volume archive to continue.";
		case "CORRUPT":
			return "7-Zip could not read this archive. It may be damaged or incomplete.";
		default:
			return reason;
	}
}

type Connection = () => Promise<Comlink.Remote<UnzipWorker>>;
type OpenArchive = { file: File; archive: Archive; password: string };
type OpenState =
	| { kind: "idle" }
	| { kind: "opening"; file: File; password: string }
	| { kind: "password"; file: File; wrong: boolean }
	| { kind: "error"; message: string }
	| ({ kind: "ready" } & OpenArchive);

type SaveState =
	| { kind: "saving"; total: number; bytes: number; index?: number; started: number; finishing?: boolean }
	| { kind: "done" | "error" | "canceled"; message: string };

function Workspace({
	file,
	archive,
	password,
	connect,
	restart,
	dismiss,
}: OpenArchive & {
	connect: Connection;
	restart(): void;
	dismiss(): void;
}) {
	const paths = useMemo(() => outputPaths(archive.entries), [archive]);
	const tree = useMemo(() => makeTree(archive.entries, paths), [archive, paths]);
	const files = useMemo(
		() => archive.entries.flatMap((entry, index) => (entry.folder || entry.special ? [] : [index])),
		[archive],
	);
	const directories = useMemo(
		() => [
			...new Set(archive.entries.flatMap((entry, index) => (entry.folder && !entry.special ? [paths[index]] : []))),
		],
		[archive, paths],
	);
	const [selected, setSelected] = useState(new Set<number>());
	const [preview, setPreview] = useState<PreviewState>();
	const [save, setSave] = useState<SaveState>();
	const previewId = useRef(0);
	const active = useRef<{ target?: Destination } | null>(null);
	const folder = canSaveFolder();
	const busy = save?.kind === "saving";

	useEffect(
		() => () => {
			previewId.current++;
			void active.current?.target?.abort().catch(() => {});
			active.current = null;
		},
		[],
	);

	function select(indexes: number[], checked: boolean) {
		setSelected((before) => {
			const next = new Set(before);
			for (const index of indexes) {
				if (checked) next.add(index);
				else next.delete(index);
			}
			return next;
		});
	}

	function closePreview() {
		previewId.current++;
		setPreview(undefined);
	}

	async function openPreview(index: number) {
		const id = ++previewId.current;
		const { size } = archive.entries[index];
		if (size > MAX_PREVIEW) {
			setPreview({ kind: "large", index });
			return;
		}
		setPreview({ kind: "loading", index });
		try {
			const limit = imageType(paths[index]) ? MAX_PREVIEW : TEXT_PREVIEW;
			const data = await (await connect()).preview(file, archive, password, index, limit);
			if (previewId.current === id) setPreview(previewContent(data, size, paths[index], index));
		} catch (error) {
			if (previewId.current === id) setPreview({ kind: "error", index, message: message(error) });
		}
	}

	async function extract(mode: "all" | "selected" | number) {
		if (active.current) return;
		const indexes = mode === "all" ? files : mode === "selected" ? [...selected] : [mode];
		const outputDirs = mode === "all" ? directories : [];
		const toFolder = typeof mode !== "number" && folder;
		const asZip = typeof mode !== "number" && !folder;
		const base = archiveBase(file.name);
		const name = typeof mode === "number" ? (paths[mode].split("/").pop() ?? "File") : `${base}.zip`;
		const total = indexes.reduce((sum, i) => sum + archive.entries[i].size, 0);
		const operation: { target?: Destination } = {};
		active.current = operation;
		const started = performance.now();
		setSave({ kind: "saving", bytes: 0, total, started });
		try {
			const target = await (toFolder ? openFolder(base, paths, outputDirs) : openDownload(name, asZip));
			if (active.current !== operation) {
				await target?.abort();
				return;
			}
			if (!target) {
				setSave(undefined);
				return;
			}
			operation.target = target;
			await (await connect()).extract(
				file,
				archive,
				password,
				indexes,
				asZip ? { files: paths, directories: outputDirs } : undefined,
				Comlink.proxy((event) => {
					if (active.current !== operation) return;
					if (event.type === "progress")
						setSave({ kind: "saving", bytes: event.bytes, total, index: event.index, started });
					else target.receive(event);
				}),
			);
			if (active.current !== operation) return;
			setSave({ kind: "saving", bytes: total, total, started, finishing: true });
			await target.close();
			if (active.current === operation) {
				setSave({
					kind: "done",
					message: toFolder
						? `Extracted ${indexes.length} ${indexes.length === 1 ? "file" : "files"} into the selected folder.`
						: `Saved ${name}.`,
				});
			}
		} catch (error) {
			if (active.current !== operation) return;
			try {
				await operation.target?.abort();
				setSave({ kind: "error", message: message(error) });
			} catch (cleanupError) {
				setSave({
					kind: "error",
					message: `${message(error)} Partial files could not be removed. ${message(cleanupError)}`,
				});
			}
		} finally {
			if (active.current === operation) active.current = null;
		}
	}

	async function cancel() {
		const operation = active.current;
		active.current = null;
		if (preview?.kind === "loading") closePreview();
		restart();
		try {
			await operation?.target?.abort();
			setSave({ kind: "canceled", message: "Extraction canceled." });
		} catch (error) {
			setSave({ kind: "error", message: `Extraction canceled. Partial files could not be removed. ${message(error)}` });
		}
	}

	return (
		<>
			<div className={s.summary}>
				<Chip
					badge={archive.format.toUpperCase()}
					name={file.name}
					meta={`${formatBytes(file.size)} archive · ${files.length} ${files.length === 1 ? "file" : "files"} · ${formatBytes(archive.total)} uncompressed`}
				/>
				<Button variant="ghost" onClick={dismiss} disabled={busy}>
					Open another archive
				</Button>
			</div>
			{archive.total > 1e9 && archive.total > file.size * 100 && (
				<Note tone="danger">
					This archive expands to {formatBytes(archive.total)}, over 100 times its compressed size.
				</Note>
			)}
			{archive.entries.some((entry) => entry.special) && <Note tone="info">Links and device entries are skipped.</Note>}
			<Card className={s.actions}>
				<div className={s.buttons}>
					<Button
						icon="download"
						disabled={busy || (files.length === 0 && directories.length === 0)}
						onClick={() => void extract("all")}
					>
						{folder ? "Extract all" : "Download all as .zip"}
					</Button>
					<Button variant="ghost" disabled={busy || selected.size === 0} onClick={() => void extract("selected")}>
						{folder ? "Extract selected" : "Download selected as .zip"} ({selected.size})
					</Button>
				</div>
				<p className={s.hint}>
					{folder
						? "Extraction reads the archive in chunks and writes to the folder you choose."
						: "Downloads are held in memory before saving. Large results depend on your device’s available memory."}
				</p>
				{save?.kind === "saving" && (
					<div className={s.saving}>
						<Progress
							value={save.bytes}
							max={save.total}
							label={save.finishing ? "Finishing save" : "Extracting files"}
							detail={`${formatBytes(save.bytes)} / ${formatBytes(save.total)} · ${formatBytes(save.bytes / Math.max(0.1, (performance.now() - save.started) / 1000))}/s`}
						/>
						{save.index !== undefined && <p className={s.hint}>{paths[save.index]}</p>}
						<Button variant="ghost" onClick={() => void cancel()} disabled={!active.current}>
							Cancel extraction
						</Button>
					</div>
				)}
				{save && save.kind !== "saving" && (
					<Note tone={save.kind === "done" ? "success" : save.kind === "error" ? "danger" : "info"}>
						{save.message}
					</Note>
				)}
			</Card>
			<div className={`${s.workspace} ${preview ? s.withPreview : ""}`}>
				<ArchiveTree
					nodes={tree}
					controls={{
						selected,
						previewed: preview?.index,
						busy,
						select,
						preview: (index) => void openPreview(index),
						save: (index) => void extract(index),
					}}
				/>
				{preview && (
					<Preview
						state={preview}
						path={paths[preview.index]}
						busy={busy}
						close={closePreview}
						save={() => void extract(preview.index)}
					/>
				)}
			</div>
		</>
	);
}

export default function ZipUnzip() {
	const [mode, setMode] = useState<"extract" | "create">(() =>
		new URLSearchParams(window.location.search).get("mode") === "create" ? "create" : "extract",
	);
	// Create mounts on first use, so Extract alone never loads a second 7-Zip worker.
	const [created, setCreated] = useState(mode === "create");
	return (
		<div className={s.tool}>
			<header className={s.heading}>
				<h1>Zip / Unzip</h1>
				<p className={s.intro}>
					Open and extract archives, or pack files and folders into a new one. All in your browser.
				</p>
			</header>
			<div className={s.modes} role="tablist" aria-label="Mode">
				{(["extract", "create"] as const).map((value) => (
					<button
						key={value}
						type="button"
						role="tab"
						id={`mode-${value}`}
						aria-controls={`panel-${value}`}
						aria-selected={mode === value}
						className={s.mode}
						onClick={() => {
							setMode(value);
							if (value === "create") setCreated(true);
						}}
					>
						<Icon name={value === "extract" ? "download" : "archive"} size={16} />
						{value === "extract" ? "Extract" : "Create"}
					</button>
				))}
			</div>
			<section
				id="panel-extract"
				role="tabpanel"
				aria-labelledby="mode-extract"
				hidden={mode !== "extract"}
				className={s.tool}
			>
				<Extract />
			</section>
			<section
				id="panel-create"
				role="tabpanel"
				aria-labelledby="mode-create"
				hidden={mode !== "create"}
				className={s.tool}
			>
				{created && <Create />}
			</section>
		</div>
	);
}

function Extract() {
	const [state, setState] = useState<OpenState>({ kind: "idle" });
	const [input, setInput] = useState("");
	const worker = useRef<WorkerHandle<UnzipWorker> | null>(null);
	const run = useRef(0);

	const spawn = useCallback(() => {
		worker.current?.terminate();
		const next = startWorker<UnzipWorker>(
			() => new Worker(new URL("./unzip.worker.ts", import.meta.url), { type: "module" }),
		);
		worker.current = next;
		void next.api.catch(() => {});
		return next;
	}, []);

	useEffect(() => {
		spawn();
		return () => worker.current?.terminate();
	}, [spawn]);

	const connect = useCallback(() => (worker.current ?? spawn()).api, [spawn]);

	async function open(file: File, password = "") {
		const id = ++run.current;
		setState({ kind: "opening", file, password });
		try {
			const api = await connect();
			const archive = await api.list(file, password);
			if (id !== run.current) return;
			let smallest = -1;
			for (const [index, entry] of archive.entries.entries()) {
				if (
					entry.encrypted &&
					!entry.folder &&
					!entry.special &&
					(smallest < 0 || entry.size < archive.entries[smallest].size)
				)
					smallest = index;
			}
			if (smallest >= 0) {
				if (!password) throw new Error("NEEDS_PASSWORD");
				await api.testPassword(file, archive, password, smallest);
			}
			if (id === run.current) {
				setInput("");
				setState({ kind: "ready", file, archive, password });
			}
		} catch (error) {
			if (id !== run.current) return;
			const reason = error instanceof Error ? error.message : "";
			if (reason === "NEEDS_PASSWORD" || reason === "WRONG_PASSWORD") {
				setState({ kind: "password", file, wrong: reason === "WRONG_PASSWORD" });
			} else setState({ kind: "error", message: message(error) });
		}
	}

	function reset() {
		run.current++;
		setInput("");
		if (state.kind === "opening" || state.kind === "error") spawn();
		setState({ kind: "idle" });
	}

	return (
		<>
			{(state.kind === "idle" || state.kind === "error") && (
				<FileDrop
					accept={ACCEPT}
					title="Open an archive"
					hint="ZIP, 7z, RAR, TAR, GZIP and more · Files stay on this device"
					onFile={(file) => {
						if (state.kind === "error") spawn();
						void open(file);
					}}
				/>
			)}
			{state.kind === "error" && <Note tone="danger">{state.message}</Note>}
			{state.kind === "opening" && (
				<Card className={s.actions}>
					<Progress
						value={0}
						max={0}
						label={state.password ? "Checking archive password" : "Reading archive"}
						detail={state.file.name}
					/>
					<Button variant="ghost" onClick={reset}>
						Cancel opening
					</Button>
				</Card>
			)}
			{state.kind === "password" && (
				<Card className={s.actions}>
					<Chip badge="LOCKED" name={state.file.name} />
					<Note tone={state.wrong ? "danger" : "info"}>
						{message(new Error(state.wrong ? "WRONG_PASSWORD" : "NEEDS_PASSWORD"))}
					</Note>
					<form
						className={s.password}
						onSubmit={(event) => {
							event.preventDefault();
							void open(state.file, input);
						}}
					>
						<label htmlFor="archive-password">Password</label>
						<input
							id="archive-password"
							type="password"
							value={input}
							onChange={(event) => setInput(event.currentTarget.value)}
						/>
						<div className={s.buttons}>
							<Button type="submit" icon="lock" disabled={!input}>
								Unlock archive
							</Button>
							<Button variant="ghost" onClick={reset}>
								Open another archive
							</Button>
						</div>
					</form>
				</Card>
			)}
			{state.kind === "ready" && <Workspace {...state} connect={connect} restart={spawn} dismiss={reset} />}
		</>
	);
}
