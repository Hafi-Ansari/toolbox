import * as Comlink from "comlink";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
	type Collected,
	canPickDirectory,
	canPickFolders,
	fromDrop,
	fromInput,
	pickDirectory,
} from "../../lib/collect.ts";
import { explainOnce } from "../../lib/confirm.tsx";
import { formatBytes, formatDuration } from "../../lib/format.ts";
import { Icon } from "../../lib/Icon.tsx";
import { willAskWhereToSave } from "../../lib/saveFile.ts";
import { Button, Card, Note, Pills, Progress } from "../../lib/ui.tsx";
import { startWorker, type WorkerHandle } from "../../lib/worker.ts";
import {
	type CreateOptions,
	extension,
	type Format,
	type Level,
	mimeType,
	supportsPassword,
} from "./create/options.ts";
import { type ArchiveTarget, canStreamArchive, openArchiveTarget } from "./create/output.ts";
import { archiveName, type Item, pathSegments, planArchive, suggestName } from "./create/paths.ts";
import s from "./Unzip.module.css";
import type { UnzipWorker } from "./unzip.worker.ts";

/** Without a save-file picker the archive is assembled in memory before the download starts. */
const MEMORY_LIMIT = 2 * 1024 ** 3;

interface Added {
	id: number;
	path: string;
	file: File;
}

type RunState =
	| { kind: "running"; bytes: number; total: number; path: string; started: number; finishing?: boolean }
	| { kind: "done" | "error" | "canceled"; message: string };

function message(error: unknown): string {
	const reason = error instanceof Error ? error.message : String(error);
	if (reason === "OOM")
		return "7-Zip ran out of memory. Choose a lower compression level or fewer files, or close other tabs.";
	if (reason === "MEMORY")
		return "The browser ran out of memory holding the archive before download. Add fewer or smaller files, or use Chrome or Edge on a computer, which save straight to disk.";
	if (reason.startsWith("UNREADABLE:"))
		return `Couldn’t read “${reason.slice(11)}”. It may have been moved, changed or deleted after you added it. Remove it or add it again.`;
	if (error instanceof DOMException && error.name === "NotAllowedError")
		return "The browser didn’t allow saving there. Choose another location.";
	return reason;
}

interface FolderNode {
	name: string;
	path: string;
	folders: FolderNode[];
	files: Item[];
	size: number;
	count: number;
}

function makeTree(items: Item[], directories: string[]): FolderNode[] {
	const root: FolderNode = { name: "", path: "", folders: [], files: [], size: 0, count: 0 };
	const index = new Map<string, FolderNode>([["", root]]);
	const folder = (parts: string[]) => {
		let node = root;
		for (const part of parts) {
			const path = node.path ? `${node.path}/${part}` : part;
			let child = index.get(path);
			if (!child) {
				child = { name: part, path, folders: [], files: [], size: 0, count: 0 };
				index.set(path, child);
				node.folders.push(child);
			}
			node = child;
		}
		return node;
	};
	for (const directory of directories) folder(directory.split("/"));
	for (const item of items) {
		const parts = item.path.split("/");
		parts.pop();
		folder(parts).files.push(item);
		for (let i = 0; i <= parts.length; i++) {
			const node = index.get(parts.slice(0, i).join("/")) as FolderNode;
			node.size += item.file.size;
			node.count++;
		}
	}
	for (const node of index.values()) {
		node.folders.sort((a, b) => a.name.localeCompare(b.name));
		node.files.sort((a, b) => a.path.localeCompare(b.path));
	}
	return [root];
}

const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function FolderRows({
	node,
	depth,
	busy,
	remove,
}: {
	node: FolderNode;
	depth: number;
	busy: boolean;
	remove(path: string, folder: boolean, id?: number): void;
}) {
	const [open, setOpen] = useState(depth < 1);
	const [limit, setLimit] = useState(300);
	const children = (
		<ul className={s.rows}>
			{node.folders.map((child) => (
				<FolderRows key={child.path} node={child} depth={depth + 1} busy={busy} remove={remove} />
			))}
			{node.files.slice(0, limit).map((item) => (
				<li key={item.id} className={s.addedRow} style={{ "--indent": Math.min(depth + 1, 5) } as CSSProperties}>
					<span className={s.addedName}>
						<Icon name="text" size={15} />
						<span title={item.path}>{leaf(item.path)}</span>
					</span>
					<span className={s.details}>{formatBytes(item.file.size)}</span>
					<Button
						icon="x"
						variant="ghost"
						className={s.iconButton}
						disabled={busy}
						aria-label={`Remove ${leaf(item.path)}`}
						onClick={() => remove(item.path, false, item.id)}
					/>
				</li>
			))}
			{limit < node.files.length && (
				<li>
					<Button className={s.more} variant="ghost" onClick={() => setLimit((count) => count + 300)}>
						Show more
					</Button>
				</li>
			)}
		</ul>
	);
	if (!node.path) return children;
	return (
		<li>
			<div className={s.addedRow} style={{ "--indent": Math.min(depth, 5) } as CSSProperties}>
				<button type="button" className={s.name} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
					<span className={open ? s.arrowDown : s.arrow} aria-hidden="true" />
					<Icon name="folder" size={15} />
					<span title={node.path}>{node.name}</span>
				</button>
				<span className={s.details}>{node.count ? formatBytes(node.size) : "empty"}</span>
				<Button
					icon="x"
					variant="ghost"
					className={s.iconButton}
					disabled={busy}
					aria-label={`Remove folder ${node.name}`}
					onClick={() => remove(node.path, true)}
				/>
			</div>
			{open && children}
		</li>
	);
}

export default function Create() {
	const [added, setAdded] = useState<Added[]>([]);
	const [folders, setFolders] = useState<string[]>([]);
	const [skipped, setSkipped] = useState<string[]>([]);
	const [name, setName] = useState("");
	const [named, setNamed] = useState(false);
	const [format, setFormat] = useState<Format>("zip");
	const [level, setLevel] = useState<Level>("normal");
	const [password, setPassword] = useState("");
	const [run, setRun] = useState<RunState>();
	const [dragging, setDragging] = useState(false);
	const nextId = useRef(1);
	const depth = useRef(0);
	const worker = useRef<WorkerHandle<UnzipWorker> | null>(null);
	const active = useRef<{ target?: ArchiveTarget } | null>(null);
	const folderInput = useRef<HTMLInputElement>(null);
	const busy = run?.kind === "running";
	const folderSupport = useMemo(canPickFolders, []);
	const toDisk = useMemo(canStreamArchive, []);

	const plan = useMemo(() => planArchive(added, folders), [added, folders]);
	const tree = useMemo(() => makeTree(plan.items, plan.directories), [plan]);
	const total = useMemo(() => added.reduce((sum, item) => sum + item.file.size, 0), [added]);
	const fileName = `${archiveName(name || suggestName(plan.items.map((item) => item.path)))}${extension(format)}`;
	const tooLarge = !toDisk && total > MEMORY_LIMIT;

	const spawn = () => {
		worker.current?.terminate();
		worker.current = startWorker<UnzipWorker>(
			() => new Worker(new URL("./unzip.worker.ts", import.meta.url), { type: "module" }),
		);
		void worker.current.api.catch(() => {});
		return worker.current;
	};
	const connect = () => (worker.current ?? spawn()).api;

	useEffect(
		() => () => {
			worker.current?.terminate();
			void active.current?.target?.abort();
			active.current = null;
		},
		[],
	);

	function add({ files, directories, skipped: unread }: Collected) {
		const bad: string[] = [...unread];
		const good: Added[] = [];
		for (const { path, file } of files) {
			try {
				pathSegments(path);
				good.push({ id: nextId.current++, path, file });
			} catch {
				bad.push(path);
			}
		}
		const dirs = directories.filter((path) => {
			try {
				return pathSegments(path).length > 0;
			} catch {
				return false;
			}
		});
		setAdded((before) => [...before, ...good]);
		setFolders((before) => [...new Set([...before, ...dirs])]);
		setSkipped(bad);
		if (good.length || dirs.length) setRun(undefined);
		if (!worker.current) spawn();
	}

	function remove(path: string, folder: boolean, id?: number) {
		if (!folder) {
			setAdded((before) => before.filter((item) => item.id !== id));
			return;
		}
		const inside = new Set(plan.items.filter((item) => item.path.startsWith(`${path}/`)).map((item) => item.id));
		setAdded((before) => before.filter((item) => !inside.has(item.id)));
		setFolders((before) =>
			before.filter((dir) => {
				const clean = pathSegments(dir).join("/");
				return clean !== path && !clean.startsWith(`${path}/`) && !path.startsWith(`${clean}/`);
			}),
		);
	}

	function clear() {
		setAdded([]);
		setFolders([]);
		setSkipped([]);
		setRun(undefined);
		if (!named) setName("");
	}

	async function addFolder() {
		if (!canPickDirectory()) {
			folderInput.current?.click();
			return;
		}
		const ok = await explainOnce("read-folder", {
			title: "Add a folder",
			message:
				"Next, your browser asks you to pick a folder and to let this site view its files. Nothing is uploaded; the files stay on this device. Tip: dragging a folder onto the box adds it without that question.",
			confirmLabel: "Choose folder",
		});
		if (!ok) return;
		try {
			const picked = await pickDirectory();
			if (picked) add(picked);
		} catch (error) {
			setRun({ kind: "error", message: message(error) });
		}
	}

	async function create() {
		if (active.current || (!plan.items.length && !plan.directories.length)) return;
		const options: CreateOptions = { format, level, password: supportsPassword(format) ? password : "" };
		const operation: { target?: ArchiveTarget } = {};
		active.current = operation;
		const started = performance.now();
		setRun({ kind: "running", bytes: 0, total, path: "", started });
		try {
			const target = await openArchiveTarget(fileName, mimeType(format), extension(format), total);
			if (active.current !== operation) {
				await target?.abort();
				return;
			}
			if (!target) {
				active.current = null;
				setRun(undefined);
				return;
			}
			operation.target = target;
			let size = 0;
			let held: unknown;
			await (await connect()).create(
				plan.items.map(({ path, file }) => ({ path, file })),
				plan.directories,
				options,
				Comlink.proxy((event) => {
					if (active.current !== operation) return;
					if (event.type === "write") {
						try {
							target.write(event.position, event.data);
						} catch (error) {
							// Allocation fails here when an in-memory archive outgrows the tab.
							held ??= error;
						}
					} else if (event.type === "truncate") target.truncate(event.size);
					else if (event.type === "progress")
						setRun({ kind: "running", bytes: event.bytes, total, path: event.path, started });
					else size = event.size;
				}),
			);
			if (active.current !== operation) return;
			if (held) throw new Error("MEMORY");
			setRun({ kind: "running", bytes: total, total, path: "", started, finishing: true });
			await target.close();
			if (active.current === operation) {
				setRun({
					kind: "done",
					message: `Created ${fileName}: ${formatBytes(size)} from ${formatBytes(total)} in ${formatDuration(performance.now() - started)}.`,
				});
			}
		} catch (error) {
			if (active.current !== operation) return;
			await operation.target?.abort().catch(() => {});
			setRun({ kind: "error", message: message(error) });
			// A failed run may leave 7-Zip's memory in a bad state; start fresh.
			spawn();
		} finally {
			if (active.current === operation) active.current = null;
		}
	}

	async function cancel() {
		const operation = active.current;
		active.current = null;
		spawn();
		await operation?.target?.abort().catch(() => {});
		setRun({ kind: "canceled", message: "Archive creation canceled. Nothing was saved." });
	}

	const empty = !plan.items.length && !plan.directories.length;

	return (
		<section
			className={s.create}
			aria-label="Files to archive"
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
			<div className={`${s.adder} ${dragging ? s.adderDragging : ""}`}>
				<span className={s.adderIcon}>
					<Icon name="upload" size={22} />
				</span>
				<div className={s.adderText}>
					<strong>{dragging ? "Release to add" : folderSupport ? "Add files and folders" : "Add files"}</strong>
					<span className={s.hint}>
						{folderSupport
							? "Drag files and folders here, or use the buttons. Folder structure is kept. Files stay on this device."
							: "This browser can’t choose folders (iPhone and iPad Safari). Add files instead. Files stay on this device."}
					</span>
				</div>
				<div className={s.buttons}>
					<label className={s.fileButton}>
						<input
							type="file"
							multiple
							disabled={busy}
							aria-label="Add files"
							onChange={(event) => {
								if (event.currentTarget.files) add(fromInput(event.currentTarget.files));
								event.currentTarget.value = "";
							}}
						/>
						<Icon name="text" size={16} />
						Add files
					</label>
					{folderSupport && (
						<>
							<Button variant="ghost" icon="folder" disabled={busy} onClick={() => void addFolder()}>
								Add folder
							</Button>
							<input
								ref={folderInput}
								type="file"
								hidden
								{...{ webkitdirectory: "" }}
								onChange={(event) => {
									if (event.currentTarget.files) add(fromInput(event.currentTarget.files));
									event.currentTarget.value = "";
								}}
							/>
						</>
					)}
				</div>
			</div>
			{skipped.length > 0 && (
				<Note tone="danger">
					Skipped {skipped.length} {skipped.length === 1 ? "item" : "items"} that couldn’t be read or named:{" "}
					{skipped.slice(0, 3).join(", ")}
					{skipped.length > 3 ? "…" : ""}
				</Note>
			)}
			{!empty && (
				<>
					<div className={s.summary}>
						<p className={s.totals}>
							{plan.items.length} {plan.items.length === 1 ? "file" : "files"} · {formatBytes(total)}
						</p>
						<Button variant="ghost" disabled={busy} onClick={clear}>
							Clear list
						</Button>
					</div>
					<div className={s.tree}>
						{tree.map((node) => (
							<FolderRows key="root" node={node} depth={-1} busy={busy} remove={remove} />
						))}
					</div>
					<Card className={s.options}>
						<div className={s.nameField}>
							<label htmlFor="archive-name">Archive name</label>
							<div className={s.nameInput}>
								<input
									id="archive-name"
									value={name}
									placeholder={archiveName(suggestName(plan.items.map((item) => item.path)))}
									disabled={busy}
									onChange={(event) => {
										setName(event.currentTarget.value);
										setNamed(Boolean(event.currentTarget.value));
									}}
								/>
								<span>{extension(format)}</span>
							</div>
						</div>
						<Pills
							label="Format"
							value={format}
							disabled={busy}
							onChange={setFormat}
							options={[
								{ value: "zip", label: "ZIP" },
								{ value: "7z", label: "7z" },
								{ value: "tar.gz", label: "TAR.GZ" },
							]}
						/>
						<Pills
							label="Compression"
							value={level}
							disabled={busy}
							onChange={setLevel}
							options={[
								{ value: "store", label: "Store" },
								{ value: "fast", label: "Fast" },
								{ value: "normal", label: "Normal" },
								{ value: "max", label: "Max" },
							]}
						/>
						{supportsPassword(format) ? (
							<div className={s.nameField}>
								<label htmlFor="archive-new-password">Password (optional)</label>
								<input
									id="archive-new-password"
									type="password"
									autoComplete="new-password"
									value={password}
									disabled={busy}
									onChange={(event) => setPassword(event.currentTarget.value)}
								/>
								<p className={s.hint}>
									{format === "zip"
										? "ZIP uses AES-256. Opening it needs a modern unzipper such as 7-Zip, WinRAR, Keka or this tool; some built-in unzippers (Windows File Explorer, for one) can’t open it."
										: "7z uses AES-256 and also encrypts the file names."}
								</p>
							</div>
						) : (
							<p className={s.hint}>TAR.GZ has no password protection. Choose ZIP or 7z to encrypt.</p>
						)}
						<p className={s.hint}>
							{format === "zip"
								? "ZIP opens almost everywhere."
								: format === "7z"
									? "7z is usually smaller, but needs 7-Zip or a similar app to open."
									: "TAR.GZ is common on Linux and macOS."}{" "}
							{level === "max" && format === "7z" ? "Max uses about 700 MB of memory while compressing. " : ""}
							{willAskWhereToSave(total)
								? "This archive is large, so it’s written straight to a file you choose."
								: toDisk
									? "The archive downloads when it’s ready."
									: "The archive is built in memory, then downloaded, so its size depends on your device’s free memory."}
						</p>
						{tooLarge && (
							<Note tone="danger">
								This browser builds archives in memory. {formatBytes(total)} is over the {formatBytes(MEMORY_LIMIT)}{" "}
								limit; remove some files or use a desktop Chromium browser such as Chrome or Edge.
							</Note>
						)}
						<div className={s.buttons}>
							<Button icon="archive" disabled={busy || tooLarge} onClick={() => void create()}>
								Create {fileName}
							</Button>
						</div>
						{run?.kind === "running" && (
							<div className={s.saving}>
								<Progress
									value={Math.min(run.bytes, run.total)}
									max={run.total}
									label={run.finishing ? "Finishing save" : "Compressing"}
									detail={`${formatBytes(Math.min(run.bytes, run.total))} / ${formatBytes(run.total)} · ${formatBytes(Math.min(run.bytes, run.total) / Math.max(0.1, (performance.now() - run.started) / 1000))}/s`}
								/>
								{run.path && <p className={s.hint}>{run.path}</p>}
								<Button variant="ghost" onClick={() => void cancel()}>
									Cancel
								</Button>
							</div>
						)}
						{run && run.kind !== "running" && (
							<Note tone={run.kind === "done" ? "success" : run.kind === "error" ? "danger" : "info"}>
								{run.message}
							</Note>
						)}
					</Card>
				</>
			)}
			{empty && run && run.kind !== "running" && <Note tone="danger">{run.message}</Note>}
		</section>
	);
}
