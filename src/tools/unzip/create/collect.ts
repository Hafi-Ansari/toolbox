// Gathers files (with their relative paths) from the file picker, the folder
// picker, or a drop of files and folders.
import type { Picked } from "./paths.ts";

export interface Collected {
	files: Picked[];
	/** Every folder seen, so empty ones can be kept. */
	directories: string[];
	/** Entries that couldn't be read (permission, vanished file). */
	skipped: string[];
}

type PickerWindow = Window & {
	showDirectoryPicker?: (options?: { mode?: "read" }) => Promise<FileSystemDirectoryHandle>;
};

const isIOS = () =>
	/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export const canPickDirectory = () => typeof (window as PickerWindow).showDirectoryPicker === "function";

/** iPhone and iPad Safari offer no way to choose a folder. */
export const canPickFolders = () => canPickDirectory() || ("webkitdirectory" in HTMLInputElement.prototype && !isIOS());

/** From an <input type=file multiple> or <input webkitdirectory>. */
export function fromInput(list: FileList): Collected {
	const files = [...list].map((file) => ({ path: file.webkitRelativePath || file.name, file }));
	const directories = new Set<string>();
	for (const { path } of files) {
		const parts = path.split("/").slice(0, -1);
		for (let i = 1; i <= parts.length; i++) directories.add(parts.slice(0, i).join("/"));
	}
	return { files, directories: [...directories], skipped: [] };
}

type DirectoryHandle = FileSystemDirectoryHandle & {
	values(): AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle>;
};

/** Opens the folder picker. Resolves to null when canceled. */
export async function pickDirectory(): Promise<Collected | null> {
	let root: FileSystemDirectoryHandle | undefined;
	try {
		root = await (window as PickerWindow).showDirectoryPicker?.({ mode: "read" });
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") return null;
		throw error;
	}
	if (!root) return null;
	const result: Collected = { files: [], directories: [], skipped: [] };
	async function walk(directory: DirectoryHandle, path: string) {
		result.directories.push(path);
		for await (const handle of directory.values()) {
			const child = `${path}/${handle.name}`;
			try {
				if (handle.kind === "directory") await walk(handle as DirectoryHandle, child);
				else result.files.push({ path: child, file: await (handle as FileSystemFileHandle).getFile() });
			} catch {
				result.skipped.push(child);
			}
		}
	}
	await walk(root as DirectoryHandle, root.name);
	return result;
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
	const result: Collected = { files: [], directories: [], skipped: [] };
	async function visit(entry: FileSystemEntry) {
		const path = entry.fullPath.replace(/^\/+/, "") || entry.name;
		try {
			if (entry.isDirectory) {
				result.directories.push(path);
				for (const child of await readAll((entry as FileSystemDirectoryEntry).createReader())) await visit(child);
			} else result.files.push({ path, file: await fileOf(entry as FileSystemFileEntry) });
		} catch {
			result.skipped.push(path);
		}
	}
	return Promise.all(entries.map(visit)).then(() => result);
}
