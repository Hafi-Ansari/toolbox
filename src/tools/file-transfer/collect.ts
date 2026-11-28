// Gathers files to send, with their relative paths (SPEC §4.3, §9). Copied from
// src/lib/collect.ts, keeping only the prompt-free parts: drag and drop of files and
// folders (`webkitGetAsEntry`), and a plain `<input type=file multiple>`. No `showDirectoryPicker`
// and no `webkitdirectory` here: both show browser prompts.
import type { SendFile } from "./types.ts";

export interface Collected {
	files: SendFile[];
	/** Entries that couldn't be read (permission, vanished file). */
	skipped: string[];
}

/** From an `<input type=file multiple>` (or a folder input on touch devices, which sets webkitRelativePath). */
export function fromInput(list: FileList | readonly File[]): Collected {
	return { files: [...list].map((file) => ({ path: file.webkitRelativePath || file.name, file })), skipped: [] };
}

function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
	return new Promise((resolve, reject) => {
		const all: FileSystemEntry[] = [];
		// readEntries returns at most ~100 entries per call; repeat until it returns none.
		const next = () =>
			reader.readEntries((entries) => {
				if (!entries.length) resolve(all);
				else {
					all.push(...entries);
					next();
				}
			}, reject);
		next();
	});
}

const fileOf = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject));

/** Must be called synchronously inside the drop handler: the item list expires after it. */
export function fromDrop(data: DataTransfer): Promise<Collected> {
	const entries = [...data.items]
		.filter((item) => item.kind === "file")
		.map((item) => item.webkitGetAsEntry?.())
		.filter((entry): entry is FileSystemEntry => Boolean(entry));
	if (!entries.length) return Promise.resolve(fromInput(data.files));
	return fromEntries(entries);
}

/** Walks dropped entries, folders included, in a stable order (dropped order, then each folder's listing). */
export async function fromEntries(entries: readonly FileSystemEntry[]): Promise<Collected> {
	const groups = await Promise.all(entries.map(visit));
	return { files: groups.flatMap((g) => g.files), skipped: groups.flatMap((g) => g.skipped) };
}

async function visit(entry: FileSystemEntry): Promise<Collected> {
	const result: Collected = { files: [], skipped: [] };
	const walk = async (e: FileSystemEntry) => {
		const path = e.fullPath.replace(/^\/+/, "") || e.name;
		try {
			if (e.isDirectory) {
				for (const child of await readAll((e as FileSystemDirectoryEntry).createReader())) await walk(child);
			} else result.files.push({ path, file: await fileOf(e as FileSystemFileEntry) });
		} catch {
			result.skipped.push(path);
		}
	};
	await walk(entry);
	return result;
}
