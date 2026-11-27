// Turns picked or dropped files into archive paths: relative, "/"-separated, NFC,
// no empty, "." or ".." segments, and distinct (a repeated name gets " (2)").
import { uniqueName } from "../names.ts";

export interface Picked {
	/** Path relative to the drop or pick, e.g. "Photos/2024/a.jpg" or just "a.jpg". */
	path: string;
	file: File;
}

export interface Item {
	id: number;
	path: string;
	file: File;
}

export interface Plan {
	items: Item[];
	/** Folders without files, e.g. an empty folder that was dropped. */
	directories: string[];
}

/**
 * Normalises separators and rejects anything that isn't a plain relative path.
 * Returns the segments, or throws with a reason.
 */
export function pathSegments(raw: string): string[] {
	const path = raw.normalize("NFC").replace(/\\/g, "/");
	if (/^\//.test(path) || /^[a-z]:/i.test(path)) throw new Error(`Absolute path not allowed: ${raw}`);
	const parts = path.split("/").filter((part) => part !== "" && part !== ".");
	if (parts.some((part) => part === "..")) throw new Error(`Parent folder reference not allowed: ${raw}`);
	if (!parts.length) throw new Error("Empty file name.");
	// Control characters (a newline in a name, say) can't be stored portably.
	return parts.map((part) => part.replace(/\p{Cc}/gu, "_"));
}

interface Folder {
	names: Set<string>;
	folders: Map<string, { name: string; folder: Folder }>;
}

const newFolder = (): Folder => ({ names: new Set(), folders: new Map() });

/** Builds final archive paths. Items keep their order; ids are stable inputs from the caller. */
export function planArchive(files: { id: number; path: string; file: File }[], directories: string[] = []): Plan {
	const root = newFolder();
	const key = (name: string) => name.toLowerCase();
	function folderAt(parts: string[]) {
		let folder = root;
		const names: string[] = [];
		for (const part of parts) {
			let child = folder.folders.get(key(part));
			if (!child) {
				child = { name: uniqueName(part, folder.names), folder: newFolder() };
				folder.folders.set(key(part), child);
			}
			names.push(child.name);
			folder = child.folder;
		}
		return { folder, names };
	}
	const items = files.map(({ id, path, file }) => {
		const parts = pathSegments(path);
		const name = parts.pop() as string;
		const { folder, names } = folderAt(parts);
		return { id, file, path: [...names, uniqueName(name, folder.names)].join("/") };
	});
	const used = new Set(items.flatMap((item) => parentsOf(item.path)));
	const empty = new Set<string>();
	for (const directory of directories) {
		const path = folderAt(pathSegments(directory)).names.join("/");
		if (!used.has(path)) empty.add(path);
	}
	// Keep only the deepest empty folders; their parents come along.
	const leaves = [...empty].filter((path) => ![...empty].some((other) => other.startsWith(`${path}/`)));
	return { items, directories: leaves.sort() };
}

function parentsOf(path: string): string[] {
	const parts = path.split("/");
	return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** A safe base name for the archive itself (no folders, no extension). */
export function archiveName(raw: string): string {
	const name = raw
		.normalize("NFC")
		.replace(/[\p{Cc}<>:"/\\|?*]/gu, "_")
		.replace(/\.(?:zip|7z|tar\.gz|tgz)$/i, "")
		.trim()
		.replace(/[. ]+$/, "");
	return name.slice(0, 120) || "Archive";
}

/** Suggested name: the only top-level folder, else the single file's base name, else "Archive". */
export function suggestName(paths: string[]): string {
	const tops = new Set(paths.map((path) => path.split("/")[0]));
	if (tops.size !== 1) return "Archive";
	const [top] = tops;
	const isFolder = paths.some((path) => path.includes("/"));
	return archiveName(isFolder ? top : top.replace(/\.[^.]+$/, "") || top);
}
