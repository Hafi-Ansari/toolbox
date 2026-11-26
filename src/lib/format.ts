export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)} ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)} s`;
	return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

/** "My Book.pdf" → "My Book.epub" */
export function swapExtension(name: string, ext: string): string {
	const base = name.replace(/\.[^./\\]+$/, "");
	return `${base || "converted"}.${ext}`;
}
