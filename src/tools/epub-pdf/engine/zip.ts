// Minimal streaming ZIP writer.
// Every entry is fully in memory when added, so each local header carries its
// real CRC and sizes (no data descriptors). That is the most compatible form
// for EPUB readers, which are strict about the leading `mimetype` entry.
// Offsets past 4 GB and more than 65 535 entries switch on ZIP64 records.
import { deflateSync } from "fflate";

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

export function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

interface Entry {
	name: Uint8Array;
	utf8: boolean;
	method: number;
	crc: number;
	csize: number;
	usize: number;
	offset: number;
}

const enc = new TextEncoder();
const MAX32 = 0xffffffff;

// Fixed DOS timestamp (1980-01-01 00:00): output is deterministic and timezone-free.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export type ChunkSink = (chunk: Uint8Array) => void;

export class ZipWriter {
	private offset = 0;
	private entries: Entry[] = [];
	private names = new Set<string>();
	private readonly out: ChunkSink;

	constructor(out: ChunkSink) {
		this.out = out;
	}

	get bytesWritten(): number {
		return this.offset;
	}

	add(name: string, data: Uint8Array, compress: boolean): void {
		if (this.names.has(name)) throw new Error(`Duplicate zip entry: ${name}`);
		this.names.add(name);
		const nameBytes = enc.encode(name);
		const utf8 = nameBytes.length !== name.length;
		const crc = crc32(data);
		let body = data;
		let method = 0;
		if (compress && data.length > 64) {
			const deflated = deflateSync(data, { level: 6 });
			if (deflated.length < data.length) {
				body = deflated;
				method = 8;
			}
		}
		if (body.length >= MAX32 || data.length >= MAX32) {
			throw new Error(`Zip entry too large (>4 GB): ${name}`);
		}

		const h = new DataView(new ArrayBuffer(30));
		h.setUint32(0, 0x04034b50, true);
		h.setUint16(4, 20, true);
		h.setUint16(6, utf8 ? 0x0800 : 0, true);
		h.setUint16(8, method, true);
		h.setUint16(10, DOS_TIME, true);
		h.setUint16(12, DOS_DATE, true);
		h.setUint32(14, crc, true);
		h.setUint32(18, body.length, true);
		h.setUint32(22, data.length, true);
		h.setUint16(26, nameBytes.length, true);
		h.setUint16(28, 0, true);

		this.entries.push({
			name: nameBytes,
			utf8,
			method,
			crc,
			csize: body.length,
			usize: data.length,
			offset: this.offset,
		});
		this.emit(new Uint8Array(h.buffer));
		this.emit(nameBytes);
		this.emit(body);
	}

	finish(): void {
		const cdStart = this.offset;
		for (const e of this.entries) {
			const z64 = e.offset >= MAX32;
			const extraLen = z64 ? 12 : 0;
			const c = new DataView(new ArrayBuffer(46 + extraLen));
			c.setUint32(0, 0x02014b50, true);
			c.setUint16(4, z64 ? 45 : 20, true);
			c.setUint16(6, z64 ? 45 : 20, true);
			c.setUint16(8, e.utf8 ? 0x0800 : 0, true);
			c.setUint16(10, e.method, true);
			c.setUint16(12, DOS_TIME, true);
			c.setUint16(14, DOS_DATE, true);
			c.setUint32(16, e.crc, true);
			c.setUint32(20, e.csize, true);
			c.setUint32(24, e.usize, true);
			c.setUint16(28, e.name.length, true);
			c.setUint16(30, extraLen, true);
			c.setUint32(42, z64 ? MAX32 : e.offset, true);
			if (z64) {
				c.setUint16(46, 0x0001, true);
				c.setUint16(48, 8, true);
				c.setBigUint64(50, BigInt(e.offset), true);
			}
			this.emit(new Uint8Array(c.buffer, 0, 46));
			this.emit(e.name);
			if (z64) this.emit(new Uint8Array(c.buffer, 46, extraLen));
		}
		const cdSize = this.offset - cdStart;
		const count = this.entries.length;
		const needZ64 = count > 0xffff || cdStart >= MAX32 || cdSize >= MAX32;

		if (needZ64) {
			const z64EocdAt = this.offset;
			const r = new DataView(new ArrayBuffer(56 + 20));
			r.setUint32(0, 0x06064b50, true);
			r.setBigUint64(4, 44n, true);
			r.setUint16(12, 45, true);
			r.setUint16(14, 45, true);
			r.setBigUint64(24, BigInt(count), true);
			r.setBigUint64(32, BigInt(count), true);
			r.setBigUint64(40, BigInt(cdSize), true);
			r.setBigUint64(48, BigInt(cdStart), true);
			r.setUint32(56, 0x07064b50, true);
			r.setBigUint64(64, BigInt(z64EocdAt), true);
			r.setUint32(72, 1, true);
			this.emit(new Uint8Array(r.buffer));
		}

		const e = new DataView(new ArrayBuffer(22));
		e.setUint32(0, 0x06054b50, true);
		e.setUint16(8, needZ64 ? 0xffff : count, true);
		e.setUint16(10, needZ64 ? 0xffff : count, true);
		e.setUint32(12, needZ64 ? MAX32 : cdSize, true);
		e.setUint32(16, needZ64 ? MAX32 : cdStart, true);
		this.emit(new Uint8Array(e.buffer));
	}

	private emit(chunk: Uint8Array): void {
		if (chunk.length === 0) return;
		this.offset += chunk.length;
		this.out(chunk);
	}
}

/** Coalesces many small chunks into ~`size`-byte batches before forwarding. */
export function batchingSink(forward: ChunkSink, size = 4 << 20): { sink: ChunkSink; flush: () => void } {
	let parts: Uint8Array[] = [];
	let len = 0;
	const flush = () => {
		if (len === 0) return;
		const merged = new Uint8Array(len);
		let at = 0;
		for (const p of parts) {
			merged.set(p, at);
			at += p.length;
		}
		parts = [];
		len = 0;
		forward(merged);
	};
	const sink: ChunkSink = (chunk) => {
		if (chunk.length >= size) {
			flush();
			forward(chunk.slice());
			return;
		}
		parts.push(chunk.slice());
		len += chunk.length;
		if (len >= size) flush();
	};
	return { sink, flush };
}
