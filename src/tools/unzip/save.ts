import { openSaveTarget } from "../../lib/saveFile.ts";
import { sanitizePath } from "./names.ts";
import type { Output } from "./unzip.worker.ts";

type PickerWindow = Window & {
	showDirectoryPicker?: (options: { mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};

export const canSaveFolder = () => typeof (window as PickerWindow).showDirectoryPicker === "function";

export function archiveBase(name: string): string {
	const base = name.replace(/(?:\.tar)?\.[^./\\]+$/, "") || "Archive";
	return sanitizePath(base).split("/").pop() ?? "Archive";
}

export interface Destination {
	receive(event: Exclude<Output, { type: "progress" }>): void;
	close(): Promise<void>;
	abort(): Promise<void>;
}

export async function openDownload(name: string, zip: boolean): Promise<Destination | null> {
	const output = await openSaveTarget(
		name,
		zip ? "application/zip" : "application/octet-stream",
		zip ? "ZIP archive" : "File",
	);
	if (!output) return null;
	return {
		receive(event) {
			if (event.type === "bytes") output.write(event.data);
		},
		close: () => output.close(),
		abort: () => output.abort(),
	};
}

async function uniqueFolder(parent: FileSystemDirectoryHandle, base: string) {
	for (let n = 1; ; n++) {
		const name = n === 1 ? base : `${base.slice(0, 72)} (${n})`;
		try {
			await parent.getDirectoryHandle(name);
		} catch (e) {
			if (e instanceof DOMException && e.name === "TypeMismatchError") continue;
			if (!(e instanceof DOMException) || e.name !== "NotFoundError") throw e;
			return parent.getDirectoryHandle(name, { create: true });
		}
	}
}

async function directoryAt(root: FileSystemDirectoryHandle, segments: string[]) {
	let directory = root;
	for (const segment of segments) directory = await directory.getDirectoryHandle(segment, { create: true });
	return directory;
}

export async function openFolder(base: string, paths: string[], directories: string[]): Promise<Destination | null> {
	let parent: FileSystemDirectoryHandle | undefined;
	try {
		parent = await (window as PickerWindow).showDirectoryPicker?.({ mode: "readwrite" });
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") return null;
		throw error;
	}
	if (!parent) return null;
	const root = await uniqueFolder(parent, base);
	let chain = Promise.resolve();
	let writable: FileSystemWritableFileStream | undefined;
	let stopped = false;
	let failed: unknown;
	return {
		receive(event) {
			chain = chain
				.then(async () => {
					if (stopped || failed) return;
					if (event.type === "file") {
						const parts = paths[event.index].split("/");
						const name = parts.pop();
						if (!name) throw new Error("Archive entry name is empty.");
						const directory = await directoryAt(root, parts);
						const handle = await directory.getFileHandle(name, { create: true });
						writable = await handle.createWritable();
					} else if (event.type === "bytes") {
						if (!writable) throw new Error("Archive bytes arrived before a file name.");
						await writable.write(event.data as Uint8Array<ArrayBuffer>);
					} else {
						await writable?.close();
						writable = undefined;
					}
				})
				.catch((error) => {
					failed = error;
				});
		},
		async close() {
			await chain;
			if (failed) throw failed;
			for (const directory of directories) {
				if (stopped) return;
				chain = directoryAt(root, directory.split("/")).then(() => {});
				await chain;
			}
		},
		async abort() {
			stopped = true;
			await chain.catch(() => {});
			await writable?.abort().catch(() => {});
			await parent.removeEntry(root.name, { recursive: true });
		},
	};
}
