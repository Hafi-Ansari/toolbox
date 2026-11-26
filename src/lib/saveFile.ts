// Saving output. Where the File System Access API exists (Chromium), output is
// streamed straight to disk as it is produced, so huge files never sit in
// memory. Elsewhere chunks are collected into a Blob and downloaded.

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
 * Must be called from a user gesture (a click), because it may open the save dialog.
 * Resolves to null if the user cancels the dialog.
 */
export async function openSaveTarget(name: string, mime: string, description: string): Promise<SaveTarget | null> {
	const picker = (window as PickerWindow).showSaveFilePicker;
	if (picker) {
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
