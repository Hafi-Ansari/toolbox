// The memory fallback's finished zip, kept on the page so the done note can offer "Save .zip" and
// "Share…" (SPEC §8.4). On iOS the save prompt that follows the automatic download isn't always
// enough: a tap is a fresh user interaction, and the share sheet's "Save to Files" works where a
// download doesn't. Kept dependency-free so the page shell can import it without the sink code.

let last: { blob: Blob; name: string } | null = null;

/** Holds the newest zip; the previous one is released. */
export function keepZip(blob: Blob, name: string): void {
	last = { blob, name };
}

/** Releases the held zip (a new memory batch is starting and needs the memory). */
export function releaseZip(): void {
	last = null;
}

/** The held zip, when it is the one called `name`. */
export function heldZip(name: string | null): Blob | null {
	return last && last.name === name ? last.blob : null;
}

/** Saves a Blob as one download through an object URL. */
export function saveBlob(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.hidden = true;
	document.body.append(a);
	a.click();
	a.remove();
	// Revoking at once can cancel the download in some browsers.
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const asFile = (blob: Blob, name: string) => new File([blob], name, { type: "application/zip" });

/** True when this browser can hand the zip to the system share sheet (iOS, Android). */
export function canShareZip(blob: Blob, name: string): boolean {
	try {
		return typeof navigator.canShare === "function" && navigator.canShare({ files: [asFile(blob, name)] });
	} catch {
		return false;
	}
}

/** Opens the share sheet with the zip. Resolves false when the person closed it. */
export async function shareZip(blob: Blob, name: string): Promise<boolean> {
	try {
		await navigator.share({ files: [asFile(blob, name)] });
		return true;
	} catch {
		return false;
	}
}
