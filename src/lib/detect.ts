// Identify a file by its first bytes, never by its extension.
export type DetectedFormat =
	| "pdf"
	| "epub"
	| "zip"
	| "7z"
	| "rar"
	| "gzip"
	| "bzip2"
	| "xz"
	| "zstd"
	| "cab"
	| "tar"
	| "unknown";

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

export function detectBytes(head: Uint8Array): DetectedFormat {
	// PDF headers may be preceded by junk; the spec allows "%PDF-" within the first 1 KB.
	const text = ascii(head, 0, Math.min(head.length, 1024));
	if (text.includes("%PDF-")) return "pdf";
	if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
		// EPUB: first entry is "mimetype" holding "application/epub+zip" (stored, at offset 30).
		const nameLen = head[26] | (head[27] << 8);
		const extraLen = head[28] | (head[29] << 8);
		const name = ascii(head, 30, 30 + nameLen);
		const body = ascii(head, 30 + nameLen + extraLen, 30 + nameLen + extraLen + 20);
		if (name === "mimetype" && body.startsWith("application/epub+zip")) return "epub";
		// Some tools write EPUBs without the mimetype-first rule; fall back to scanning.
		if (ascii(head, 0, head.length).includes("application/epub+zip")) return "epub";
		return "zip";
	}
	const starts = (...magic: number[]) => magic.every((byte, i) => head[i] === byte);
	if (starts(0x50, 0x4b, 0x05, 0x06)) return "zip";
	if (starts(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return "7z";
	if (starts(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0) || starts(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 1, 0)) return "rar";
	if (starts(0x1f, 0x8b, 0x08)) return "gzip";
	if (text.startsWith("BZh")) return "bzip2";
	if (starts(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0)) return "xz";
	if (starts(0x28, 0xb5, 0x2f, 0xfd)) return "zstd";
	if (text.startsWith("MSCF")) return "cab";
	if (text.slice(257, 262) === "ustar") return "tar";
	return "unknown";
}

export async function detectFile(file: Blob): Promise<DetectedFormat> {
	const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
	return detectBytes(head);
}
