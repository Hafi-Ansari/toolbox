import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Icon } from "../../lib/Icon.tsx";
import { Note, Progress } from "../../lib/ui.tsx";
import { ago } from "./client.ts";
import {
	deleteFile,
	describeProblem,
	downloadFile,
	type FileList,
	FileProblem,
	formatBytes,
	listFiles,
	MAX_FILE_BYTES,
	type RoomFile,
	saveBlob,
	uploadFile,
} from "./files.ts";
import s from "./Room.module.css";

/** A transfer this device is running: an upload (no id yet) or a download. */
interface Transfer {
	key: string;
	name: string;
	kind: "up" | "down";
	done: number;
	total: number;
}

export interface FilesHandle {
	add(files: File[]): void;
}

/**
 * The room's files. Re-fetches the list only when `fver` (from the room poll) changes, or after
 * this device changes it.
 */
export function FilesPanel({
	room,
	fver,
	disabled,
	onGone,
	dragging,
	ref,
}: {
	room: string;
	fver: number | null;
	disabled: boolean;
	onGone: () => void;
	dragging: boolean;
	ref: Ref<FilesHandle>;
}) {
	const [list, setList] = useState<FileList | null>(null);
	const [transfers, setTransfers] = useState<Transfer[]>([]);
	const [problems, setProblems] = useState<string[]>([]);
	const [now, setNow] = useState(Date.now());
	const aborts = useRef(new Set<AbortController>());
	const queue = useRef(Promise.resolve());

	const refresh = useCallback(async () => {
		try {
			const r = await listFiles(room);
			if (!r) onGone();
			else setList(r);
			setNow(Date.now());
		} catch {
			// The room poll shows connection trouble; keep the last list.
		}
	}, [room, onGone]);

	useEffect(() => {
		if (fver !== null) void refresh();
	}, [fver, refresh]);

	// "3 min ago" stays roughly right without refetching.
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(t);
	}, []);

	useEffect(
		() => () => {
			for (const a of aborts.current) a.abort();
		},
		[],
	);

	const track = useCallback((t: Transfer) => setTransfers((all) => [...all.filter((x) => x.key !== t.key), t]), []);
	const untrack = useCallback((key: string) => setTransfers((all) => all.filter((x) => x.key !== key)), []);
	const problem = useCallback((text: string) => setProblems((p) => [...p.slice(-2), text]), []);

	/** Uploads one after another, so a big batch doesn't trip the per-IP limit. */
	const add = useCallback(
		(files: File[]) => {
			setProblems([]);
			for (const file of files) {
				const key = `up-${crypto.randomUUID()}`;
				if (file.size > MAX_FILE_BYTES) {
					problem(describeProblem(file.name, new FileProblem("too-big")));
					continue;
				}
				track({ key, name: file.name, kind: "up", done: 0, total: file.size });
				queue.current = queue.current.then(async () => {
					const abort = new AbortController();
					aborts.current.add(abort);
					try {
						await uploadFile(
							room,
							file,
							(done) => track({ key, name: file.name, kind: "up", done, total: file.size }),
							abort.signal,
						);
					} catch (e) {
						if (!abort.signal.aborted) problem(describeProblem(file.name, e));
						if (e instanceof FileProblem && e.code === "gone") onGone();
					} finally {
						aborts.current.delete(abort);
						untrack(key);
						await refresh();
					}
				});
			}
		},
		[room, refresh, onGone, track, untrack, problem],
	);

	useImperativeHandle(ref, () => ({ add }), [add]);

	async function download(f: RoomFile) {
		const key = `down-${f.id}`;
		if (transfers.some((t) => t.key === key)) return;
		const abort = new AbortController();
		aborts.current.add(abort);
		track({ key, name: f.name, kind: "down", done: 0, total: f.size });
		try {
			const blob = await downloadFile(
				room,
				f,
				(done) => track({ key, name: f.name, kind: "down", done, total: f.size }),
				abort.signal,
			);
			saveBlob(blob, f.name);
		} catch (e) {
			if (!abort.signal.aborted) problem(describeProblem(f.name, e));
			if (e instanceof FileProblem && e.code === "no-file") await refresh();
		} finally {
			aborts.current.delete(abort);
			untrack(key);
		}
	}

	async function remove(f: RoomFile) {
		try {
			await deleteFile(room, f.id);
		} catch (e) {
			if (!(e instanceof FileProblem && e.code === "no-file")) problem(describeProblem(f.name, e));
		}
		await refresh();
	}

	const uploads = transfers.filter((t) => t.kind === "up");
	const files = list?.files ?? [];
	const used = list?.used ?? 0;
	const limit = list?.limit ?? 0;

	return (
		<section className={dragging ? s.filesDragging : s.files} aria-label="Files">
			<div className={s.filesHead}>
				<h2 className={s.filesTitle}>Files</h2>
				<label className={disabled ? s.pickDisabled : s.pick}>
					<input
						type="file"
						multiple
						disabled={disabled}
						className={s.pickInput}
						aria-label="Add files"
						onChange={(e) => {
							const picked = [...(e.currentTarget.files ?? [])];
							e.currentTarget.value = "";
							if (picked.length) add(picked);
						}}
					/>
					<Icon name="upload" size={16} />
					Add files
				</label>
			</div>

			{dragging && <p className={s.dropHint}>Drop to share with this room</p>}

			{problems.map((p) => (
				<Note key={p} tone="danger">
					{p}
				</Note>
			))}

			{uploads.map((t) => (
				<Progress
					key={t.key}
					value={t.done}
					max={t.total}
					label={`Uploading ${t.name}`}
					detail={`${formatBytes(t.done)} of ${formatBytes(t.total)}`}
				/>
			))}

			{files.length === 0 && uploads.length === 0 ? (
				<p className={s.muted}>No files yet. Add some here, drop them on the room, or paste them.</p>
			) : (
				<ul className={s.fileList} aria-label="Files in this room">
					{files.map((f) => {
						const down = transfers.find((t) => t.key === `down-${f.id}`);
						return (
							<li key={f.id} className={s.fileRow}>
								<span className={s.fileText}>
									<span className={s.fileName} title={f.name}>
										{f.name}
									</span>
									<span className={s.muted}>
										{formatBytes(f.size)} ·{" "}
										{f.done ? ago(now - f.at) : `uploading… ${Math.round((f.got / f.chunks) * 100)}%`}
									</span>
									{down && (
										<Progress
											value={down.done}
											max={down.total}
											label={`Downloading ${f.name}`}
											detail={`${formatBytes(down.done)} of ${formatBytes(down.total)}`}
										/>
									)}
								</span>
								{f.done && (
									<button
										type="button"
										className={s.fileButton}
										onClick={() => download(f)}
										disabled={!!down}
										aria-label={`Download ${f.name}`}
									>
										<Icon name="download" size={16} />
									</button>
								)}
								<button
									type="button"
									className={s.fileButton}
									onClick={() => remove(f)}
									aria-label={`Delete ${f.name}`}
								>
									<Icon name="x" size={16} />
								</button>
							</li>
						);
					})}
				</ul>
			)}

			{list && (
				<Progress
					value={used}
					max={limit}
					label="Room storage"
					detail={`${formatBytes(used)} of ${formatBytes(limit)} used`}
				/>
			)}
			<p className={s.muted}>
				Files go through this site's server and anyone on the site can open this room and download them, like the text.
				They're deleted when the room ends (after 2 hours at most). Up to {formatBytes(MAX_FILE_BYTES)} each.
			</p>
		</section>
	);
}
