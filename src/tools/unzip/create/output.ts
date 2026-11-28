// Where a new archive goes. 7-Zip writes mostly in order but patches headers it
// wrote earlier, so the target takes positioned writes. Ordinary archives collect in
// memory, then download directly (no dialog). Very large ones, where a save-file picker
// exists (Chromium), stream to the file the user picks instead.
import { willAskWhereToSave } from "../../../lib/saveFile.ts";

export interface ArchiveTarget {
	kind: "disk" | "download";
	write(position: number, data: Uint8Array): void;
	truncate(size: number): void;
	close(): Promise<void>;
	abort(): Promise<void>;
}

type PickerWindow = Window & {
	showSaveFilePicker?: (options: {
		suggestedName: string;
		types: { description: string; accept: Record<string, string[]> }[];
	}) => Promise<FileSystemFileHandle>;
};

export const canStreamArchive = () => typeof (window as PickerWindow).showSaveFilePicker === "function";

/**
 * Must be called from a click. `expectedBytes`: about how big the archive will be (the inputs'
 * total); small archives skip the save dialog. Resolves to null when the save dialog is canceled.
 */
export async function openArchiveTarget(
	name: string,
	mime: string,
	ext: string,
	expectedBytes: number,
): Promise<ArchiveTarget | null> {
	const picker = (window as PickerWindow).showSaveFilePicker;
	if (picker && willAskWhereToSave(expectedBytes)) {
		let handle: FileSystemFileHandle;
		try {
			handle = await picker({ suggestedName: name, types: [{ description: "Archive", accept: { [mime]: [ext] } }] });
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") return null;
			throw error;
		}
		const writable = await handle.createWritable();
		let chain = Promise.resolve();
		let failed: unknown;
		return {
			kind: "disk",
			write(position, data) {
				chain = chain
					.then(() => writable.write({ type: "write", position, data: data as Uint8Array<ArrayBuffer> }))
					.catch((error) => {
						failed ??= error;
					});
			},
			truncate(size) {
				chain = chain
					.then(() => writable.truncate(size))
					.catch((error) => {
						failed ??= error;
					});
			},
			async close() {
				await chain;
				if (failed) {
					await writable.abort().catch(() => {});
					throw failed;
				}
				await writable.close();
			},
			async abort() {
				await chain.catch(() => {});
				await writable.abort().catch(() => {});
			},
		};
	}
	const memory = pagedBuffer();
	return {
		kind: "download",
		write: memory.write,
		truncate: memory.truncate,
		async close() {
			const url = URL.createObjectURL(new Blob(memory.parts(), { type: mime }));
			memory.clear();
			const a = document.createElement("a");
			a.href = url;
			a.download = name;
			document.body.append(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
		},
		async abort() {
			memory.clear();
		},
	};
}

/** Growable byte store for positioned writes, kept as fixed pages to avoid copying on growth. */
export function pagedBuffer(page = 4 << 20) {
	let pages: Uint8Array<ArrayBuffer>[] = [];
	let size = 0;
	return {
		write(position: number, data: Uint8Array) {
			let offset = 0;
			while (offset < data.length) {
				const at = position + offset;
				const index = Math.floor(at / page);
				while (pages.length <= index) pages.push(new Uint8Array(page));
				const start = at - index * page;
				const count = Math.min(page - start, data.length - offset);
				pages[index].set(data.subarray(offset, offset + count), start);
				offset += count;
			}
			size = Math.max(size, position + data.length);
		},
		truncate(length: number) {
			size = length;
			pages.length = Math.min(pages.length, Math.ceil(length / page));
			// Bytes past the new end must read as zeros if the file grows again.
			pages[Math.floor(length / page)]?.fill(0, length % page);
		},
		parts(): Uint8Array<ArrayBuffer>[] {
			return pages.slice(0, Math.ceil(size / page)).map((p, i) => p.subarray(0, Math.min(page, size - i * page)));
		},
		get size() {
			return size;
		},
		clear() {
			pages = [];
			size = 0;
		},
	};
}
