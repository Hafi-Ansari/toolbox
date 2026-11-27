const text = new TextEncoder();
const reserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i;

function fitSegment(name: string, limit = 255): string {
	let bytes = 0;
	let result = "";
	for (const char of name) {
		bytes += text.encode(char).length;
		if (bytes > limit) break;
		result += char;
	}
	return result.replace(/[. ]+$/, "");
}

function safeSegment(name: string): string {
	const clean = name.replace(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "").replace(/[<>:"|?*]/g, "_");
	return fitSegment(reserved.test(clean.trimEnd()) ? `_${clean}` : clean) || "unnamed";
}

function pathParts(path: string): string[] {
	return path
		.replace(/^[a-z]:/i, "")
		.split(/[/\\]/)
		.filter((part) => part && part !== "." && part !== "..");
}

export function sanitizePath(path: string): string {
	return pathParts(path).map(safeSegment).join("/") || "unnamed";
}

function nameKey(name: string): string {
	return name.normalize("NFC").toLowerCase();
}

export function uniqueName(name: string, used: Set<string>): string {
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 ? fitSegment(name.slice(dot), 120) : "";
	const base = dot > 0 ? name.slice(0, dot) : name;
	let candidate = name;
	for (let i = 2; used.has(nameKey(candidate)); i++) {
		const suffix = ` (${i})${ext}`;
		candidate = `${fitSegment(base, 255 - text.encode(suffix).length)}${suffix}`;
	}
	used.add(nameKey(candidate));
	return candidate;
}

interface NameDirectory {
	names: Set<string>;
	directories: Map<string, { name: string; node: NameDirectory }>;
}

const newDirectory = (): NameDirectory => ({ names: new Set(), directories: new Map() });

/** Assign output paths once, so preview, folder saving and ZIP use the same names. */
export function outputPaths(entries: { path: string; folder: boolean }[]): string[] {
	const root = newDirectory();
	return entries.map(({ path, folder }) => {
		const raw = pathParts(path);
		if (!raw.length) raw.push("unnamed");
		let dir = root;
		return raw
			.map((part, i) => {
				if (!folder && i === raw.length - 1) return uniqueName(safeSegment(part), dir.names);
				let child = dir.directories.get(part);
				if (!child) {
					child = { name: uniqueName(safeSegment(part), dir.names), node: newDirectory() };
					dir.directories.set(part, child);
				}
				dir = child.node;
				return child.name;
			})
			.join("/");
	});
}
