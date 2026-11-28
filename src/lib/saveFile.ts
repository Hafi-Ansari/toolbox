// Saving output. Ordinary results are collected into a Blob and downloaded: no dialog, they
// land in the browser's downloads like any other file. Only results expected to be very large
// (over DIRECT_DOWNLOAD_LIMIT) use the File System Access save picker where it exists
// (Chromium), so they stream straight to disk and never sit in memory.

export interface SaveTarget {
	/** "disk" streams to a file the user picked; "download" saves via the browser when closed. */
	kind: "disk" | "download";
	write(chunk: Uint8Array): void;
	close(): Promise<void>;
	abort(): Promise<void>;
}

interface PickerWindow {
	showSaveFilePicker?: (options: {
		suggestedName: string;
		types: { description: string; accept: Record<string, string[]> }[];
	}) => Promise<FileSystemFileHandle>;
}

export const canStreamToDisk = () => typeof (window as PickerWindow).showSaveFilePicker === "function";

/**
 * Results up to this size are downloaded directly, without a save dialog. Holding them in memory
 * first is fine at this size, and a dialog for every result feels intrusive. Tests may lower it
 * through `window.__toolboxDirectDownloadLimit` to exercise the stream-to-disk path.
 */
export const DIRECT_DOWNLOAD_LIMIT = 512 * 1024 * 1024;

const directLimit = () =>
	(window as { __toolboxDirectDownloadLimit?: number }).__toolboxDirectDownloadLimit ?? DIRECT_DOWNLOAD_LIMIT;

/**
 * True when a result of about `expectedBytes` will open the save dialog (and stream to disk)
 * instead of downloading directly. Unknown size counts as large.
 */
export const willAskWhereToSave = (expectedBytes?: number) =>
	canStreamToDisk() && (expectedBytes === undefined || expectedBytes > directLimit());

/**
 * Must be called from a user gesture (a click), because it may open the save dialog.
 * `expectedBytes`: about how big the result will be; small results skip the dialog.
 * Resolves to null if the user cancels the dialog.
 */
export async function openSaveTarget(
	name: string,
	mime: string,
	description: string,
	expectedBytes?: number,
): Promise<SaveTarget | null> {
	const picker = (window as PickerWindow).showSaveFilePicker;
	if (picker && willAskWhereToSave(expectedBytes)) {
		let handle: FileSystemFileHandle;
		try {
			const ext = `.${name.split(".").pop()}`;
			handle = await picker({ suggestedName: name, types: [{ description, accept: { [mime]: [ext] } }] });
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") return null;
			throw e;
		}
		const writable = await handle.createWritable();
		let chain: Promise<void> = Promise.resolve();
		let failed: unknown = null;
		return {
			kind: "disk",
			write(chunk) {
				// Writes are queued in order; the stream copies each chunk.
				chain = chain
					.then(() => writable.write(chunk as Uint8Array<ArrayBuffer>))
					.catch((e) => {
						failed ??= e;
					});
			},
			async close() {
				await chain;
				if (failed) throw failed;
				await writable.close();
			},
			async abort() {
				await chain.catch(() => {});
				await writable.abort().catch(() => {});
			},
		};
	}

	const parts: BlobPart[] = [];
	return {
		kind: "download",
		write(chunk) {
			parts.push(chunk as Uint8Array<ArrayBuffer>);
		},
		async close() {
			const url = URL.createObjectURL(new Blob(parts, { type: mime }));
			parts.length = 0;
			const a = document.createElement("a");
			a.href = url;
			a.download = name;
			document.body.append(a);
			a.click();
			a.remove();
			// Give the browser time to start the download before releasing the memory.
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
		},
		async abort() {
			parts.length = 0;
		},
	};
}
