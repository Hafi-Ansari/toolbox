// Minimal streaming ZIP writer.
// add() puts real CRCs and sizes in local headers for EPUB compatibility.
// addStream() uses data descriptors so a file can arrive a chunk at a time.
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
	return (updateCrc(0xffffffff, data) ^ 0xffffffff) >>> 0;
}

function updateCrc(c: number, data: Uint8Array): number {
	for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return c;
}

interface Entry {
	name: Uint8Array;
	utf8: boolean;
	method: number;
	crc: number;
	csize: number;
	usize: number;
	offset: number;
	descriptor?: boolean;
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
	private writing = false;
	private readonly out: ChunkSink;

	constructor(out: ChunkSink) {
		this.out = out;
	}

	get bytesWritten(): number {
		return this.offset;
	}

	add(name: string, data: Uint8Array, compress: boolean): void {
		if (this.writing) throw new Error("Close the current ZIP entry before adding another.");
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

	addStream(name: string, size: number): { write: ChunkSink; close: () => void } {
		if (this.writing) throw new Error("Close the current ZIP entry before adding another.");
		if (this.names.has(name)) throw new Error(`Duplicate zip entry: ${name}`);
		const bytes = enc.encode(name);
		if (!Number.isSafeInteger(size) || size < 0 || bytes.length > 0xffff) throw new Error("Invalid ZIP entry size.");
		const entry: Entry = {
			name: bytes,
			utf8: true,
			method: 0,
			crc: 0,
			csize: size,
			usize: size,
			offset: this.offset,
			descriptor: true,
		};
		const z64 = size >= MAX32;
		const extraLen = z64 ? 20 : 0;
		const h = new DataView(new ArrayBuffer(30));
		h.setUint32(0, 0x04034b50, true);
		h.setUint16(4, z64 ? 45 : 20, true);
		h.setUint16(6, 0x0808, true);
		h.setUint16(12, DOS_DATE, true);
		h.setUint32(18, z64 ? MAX32 : 0, true);
		h.setUint32(22, z64 ? MAX32 : 0, true);
		h.setUint16(26, bytes.length, true);
		h.setUint16(28, extraLen, true);
		this.writing = true;
		this.names.add(name);
		this.emit(new Uint8Array(h.buffer));
		this.emit(bytes);
		if (z64) {
			const extra = new DataView(new ArrayBuffer(extraLen));
			extra.setUint16(0, 0x0001, true);
			extra.setUint16(2, 16, true);
			extra.setBigUint64(4, BigInt(size), true);
			extra.setBigUint64(12, BigInt(size), true);
			this.emit(new Uint8Array(extra.buffer));
		}
		let crc = 0xffffffff;
		let remaining = size;
		let closed = false;
		return {
			write: (chunk) => {
				if (closed || chunk.length > remaining) throw new Error("ZIP entry exceeds its declared size.");
				remaining -= chunk.length;
				crc = updateCrc(crc, chunk);
				this.emit(chunk);
			},
			close: () => {
				if (closed || remaining !== 0) throw new Error("Incomplete ZIP entry.");
				closed = true;
				entry.crc = (crc ^ 0xffffffff) >>> 0;
				const d = new DataView(new ArrayBuffer(z64 ? 24 : 16));
				d.setUint32(0, 0x08074b50, true);
				d.setUint32(4, entry.crc, true);
				if (z64) {
					d.setBigUint64(8, BigInt(size), true);
					d.setBigUint64(16, BigInt(size), true);
				} else {
					d.setUint32(8, size, true);
					d.setUint32(12, size, true);
				}
				this.entries.push(entry);
				this.emit(new Uint8Array(d.buffer));
				this.writing = false;
			},
		};
	}

	finish(): void {
		if (this.writing) throw new Error("Close the current ZIP entry before finishing.");
		const cdStart = this.offset;
		for (const e of this.entries) {
			const zOffset = e.offset >= MAX32;
			const zSize = e.usize >= MAX32;
			const z64 = zOffset || zSize;
			const extraLen = z64 ? 4 + (zSize ? 16 : 0) + (zOffset ? 8 : 0) : 0;
			const c = new DataView(new ArrayBuffer(46 + extraLen));
			c.setUint32(0, 0x02014b50, true);
			c.setUint16(4, z64 ? 45 : 20, true);
			c.setUint16(6, z64 ? 45 : 20, true);
			c.setUint16(8, (e.utf8 ? 0x0800 : 0) | (e.descriptor ? 8 : 0), true);
			c.setUint16(10, e.method, true);
			c.setUint16(12, DOS_TIME, true);
			c.setUint16(14, DOS_DATE, true);
			c.setUint32(16, e.crc, true);
			c.setUint32(20, zSize ? MAX32 : e.csize, true);
			c.setUint32(24, zSize ? MAX32 : e.usize, true);
			c.setUint16(28, e.name.length, true);
			c.setUint16(30, extraLen, true);
			c.setUint32(42, zOffset ? MAX32 : e.offset, true);
			if (z64) {
				c.setUint16(46, 0x0001, true);
				c.setUint16(48, extraLen - 4, true);
				if (zSize) {
					c.setBigUint64(50, BigInt(e.usize), true);
					c.setBigUint64(58, BigInt(e.csize), true);
				}
				if (zOffset) c.setBigUint64(zSize ? 66 : 50, BigInt(e.offset), true);
			}
			this.emit(new Uint8Array(c.buffer, 0, 46));
			this.emit(e.name);
			if (z64) this.emit(new Uint8Array(c.buffer, 46, extraLen));
		}
		const cdSize = this.offset - cdStart;
		const count = this.entries.length;
		const needZ64 = count >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32;

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
