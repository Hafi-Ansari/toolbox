// Output names: IMG_0001.HEIC → IMG_0001.jpg, unique within a batch, and the zip's name.

export type OutputFormat = "jpeg" | "png";

export const extension = (format: OutputFormat) => (format === "jpeg" ? "jpg" : "png");

/** Replaces the extension, keeping any folder path ("Trip/IMG_1.HEIC" → "Trip/IMG_1.jpg"). */
export function outputName(path: string, format: OutputFormat): string {
	const slash = path.lastIndexOf("/");
	const dir = path.slice(0, slash + 1);
	const base = path.slice(slash + 1);
	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base || "photo";
	return `${dir}${stem}.${extension(format)}`;
}

/** Hands out names, adding " (2)", " (3)"… when one is taken (case-insensitively, as on Windows). */
export function uniqueNames() {
	const taken = new Set<string>();
	return (name: string) => {
		let candidate = name;
		const dot = name.lastIndexOf(".");
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : "";
		for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
		taken.add(candidate.toLowerCase());
		return candidate;
	};
}

/** "Trip.zip" for a dropped folder, else "Photos 2026-11-28.zip". */
export function zipName(folder: string | null, now = new Date()): string {
	if (folder) return `${folder}.zip`;
	const two = (n: number) => String(n).padStart(2, "0");
	return `Photos ${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}.zip`;
}
