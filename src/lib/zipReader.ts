// Random-access ZIP reader for Blobs/Files. Opening reads only the central
// directory at the end of the file; each entry is then read from its own byte
// range and inflated with the browser's native DecompressionStream. A 300 MB
// archive opens by reading a few KB. ZIP64 archives are supported.

export interface ZipEntry {
	name: string;
	method: number;
	compressedSize: number;
	size: number;
	/** Offset of the entry's local file header. */
	offset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_Z64_LOCATOR = 0x07064b50;
const SIG_Z64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

const utf8 = new TextDecoder("utf-8");

async function readRange(blob: Blob, start: number, end: number): Promise<DataView> {
	return new DataView(await blob.slice(start, end).arrayBuffer());
}

const u64 = (v: DataView, at: number) => Number(v.getBigUint64(at, true));

export class ZipReader {
	readonly entries: Map<string, ZipEntry>;
	private readonly blob: Blob;

	private constructor(blob: Blob, entries: Map<string, ZipEntry>) {
		this.blob = blob;
		this.entries = entries;
	}

	static async open(blob: Blob): Promise<ZipReader> {
		// The end-of-central-directory record sits in the last 22 bytes plus an optional ≤64 KB comment.
		const tailStart = Math.max(0, blob.size - (22 + MAX16));
		const tail = await readRange(blob, tailStart, blob.size);
		let eocd = -1;
		for (let i = tail.byteLength - 22; i >= 0; i--) {
			if (tail.getUint32(i, true) === SIG_EOCD) {
				eocd = i;
				break;
			}
		}
		if (eocd < 0) throw new Error("Not a zip archive (no end-of-directory record).");

		let count = tail.getUint16(eocd + 10, true);
		let cdSize = tail.getUint32(eocd + 12, true);
		let cdOffset = tail.getUint32(eocd + 16, true);

		if (count === MAX16 || cdSize === MAX32 || cdOffset === MAX32) {
			const loc = eocd - 20;
			if (loc < 0 || tail.getUint32(loc, true) !== SIG_Z64_LOCATOR) throw new Error("Broken ZIP64 archive.");
			const z64At = u64(tail, loc + 8);
			const z64 = await readRange(blob, z64At, z64At + 56);
			if (z64.getUint32(0, true) !== SIG_Z64_EOCD) throw new Error("Broken ZIP64 archive.");
			count = u64(z64, 32);
			cdSize = u64(z64, 40);
			cdOffset = u64(z64, 48);
		}

		const cd = await readRange(blob, cdOffset, cdOffset + cdSize);
		const entries = new Map<string, ZipEntry>();
		let p = 0;
		for (let i = 0; i < count; i++) {
			if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== SIG_CENTRAL) throw new Error("Corrupt zip directory.");
			const method = cd.getUint16(p + 10, true);
			let compressedSize = cd.getUint32(p + 20, true);
			let size = cd.getUint32(p + 24, true);
			const nameLen = cd.getUint16(p + 28, true);
			const extraLen = cd.getUint16(p + 30, true);
			const commentLen = cd.getUint16(p + 32, true);
			let offset = cd.getUint32(p + 42, true);
			const name = utf8.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));

			// ZIP64 extra field: only the fields that overflowed are present, in this order.
			let e = p + 46 + nameLen;
			const extraEnd = e + extraLen;
			while (e + 4 <= extraEnd) {
				const id = cd.getUint16(e, true);
				const len = cd.getUint16(e + 2, true);
				if (id === 0x0001) {
					let q = e + 4;
					if (size === MAX32) {
						size = u64(cd, q);
						q += 8;
					}
					if (compressedSize === MAX32) {
						compressedSize = u64(cd, q);
						q += 8;
					}
					if (offset === MAX32) offset = u64(cd, q);
				}
				e += 4 + len;
			}

			if (!name.endsWith("/")) entries.set(name, { name, method, compressedSize, size, offset });
			p += 46 + nameLen + extraLen + commentLen;
		}
		return new ZipReader(blob, entries);
	}

	has(name: string): boolean {
		return this.entries.has(name);
	}

	async bytes(name: string): Promise<Uint8Array> {
		const entry = this.entries.get(name);
		if (!entry) throw new Error(`Missing file in archive: ${name}`);
		const head = await readRange(this.blob, entry.offset, entry.offset + 30);
		if (head.getUint32(0, true) !== SIG_LOCAL) throw new Error(`Corrupt zip entry: ${name}`);
		const start = entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
		const raw = this.blob.slice(start, start + entry.compressedSize);
		if (entry.method === 0) return new Uint8Array(await raw.arrayBuffer());
		if (entry.method !== 8) throw new Error(`Unsupported compression method ${entry.method}: ${name}`);
		const stream = raw.stream().pipeThrough(new DecompressionStream("deflate-raw"));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	}

	async text(name: string): Promise<string> {
		return utf8.decode(await this.bytes(name));
	}

	async blobOf(name: string, type: string): Promise<Blob> {
		return new Blob([(await this.bytes(name)) as Uint8Array<ArrayBuffer>], { type });
	}
}
