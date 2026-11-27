export interface Entry {
	path: string;
	size: number;
	packed?: number;
	modified?: string;
	folder: boolean;
	encrypted: boolean;
	crc?: string;
	special?: boolean;
}

export interface Archive {
	format: string;
	entries: Entry[];
	total: number;
	compressedTar: boolean;
}

function size(value: string | undefined): number | undefined {
	if (value === undefined || value === "") return undefined;
	const n = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) throw new Error("Invalid size in archive headers.");
	return n;
}

export function parseListing(lines: string[]): { format: string; entries: Entry[] } {
	const start = lines.indexOf("----------");
	if (start < 0) throw new Error("7-Zip did not return an archive directory.");
	const format =
		lines
			.slice(0, start)
			.find((line) => line.startsWith("Type = "))
			?.slice(7) ?? "archive";
	const entries: Entry[] = [];
	let fields = new Map<string, string>();
	const add = () => {
		const path = fields.get("Path");
		// Raw compressed streams such as XZ have size fields without a filename.
		if (path !== undefined || fields.has("Size")) {
			const attributes = fields.get("Attributes") ?? "";
			const mode = fields.get("Mode") ?? "";
			entries.push({
				path: path ?? "",
				folder: fields.get("Folder") === "+" || attributes.startsWith("D") || mode.startsWith("d"),
				special: Boolean(
					fields.get("Hard Link") ||
						fields.get("Symbolic Link") ||
						/(?:^| )[lbcps][rwxstST-]{9}$/.test(`${attributes} ${mode}`.trimEnd()),
				),
				size: size(fields.get("Size")) ?? 0,
				packed: size(fields.get("Packed Size")),
				modified: fields.get("Modified") || undefined,
				encrypted: fields.get("Encrypted") === "+",
				crc: fields.get("CRC") || undefined,
			});
		}
		fields = new Map();
	};
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line === "") {
			add();
			continue;
		}
		const delimiter = line.indexOf(" = ");
		if (delimiter >= 0) fields.set(line.slice(0, delimiter), line.slice(delimiter + 3));
	}
	add();
	return { format, entries };
}

export function totalBytes(entries: Entry[]): number {
	const sum = entries.reduce((total, e) => total + (e.folder || e.special ? 0 : e.size), 0);
	if (!Number.isSafeInteger(sum)) throw new Error("Archive output is too large to report accurately.");
	return sum;
}
