// Binary frame and ack codec (SPEC §7.3).
//
// Frame: 16-byte big-endian header, then 1 .. chunk − 16 payload bytes.
//   0 u8 version · 1 u8 flags (bit 0 dir, bit 1 last of range) · 2 u16 batch · 4 u32 file · 8 u64 offset
// The u64 is written as two u32 halves so offsets stay plain numbers (≤ 2^53, no BigInt on the hot path).
import { FLAG_LAST, FLAG_OFFERER, FRAME_HEADER_BYTES, MAX_BATCH_ID, MAX_OFFSET, SCTP_MAX_MESSAGE } from "../tuning.ts";
import { type Ack, FRAME_OFFSETS, type FrameHeader } from "../types.ts";

const TWO_32 = 2 ** 32;
/** Largest payload any peer may send: chunk is capped at Chrome's max message size (§3, §7.3). */
export const MAX_PAYLOAD = SCTP_MAX_MESSAGE - FRAME_HEADER_BYTES;
const KNOWN_FLAGS = FLAG_OFFERER | FLAG_LAST;

export type FrameFields = Omit<FrameHeader, "version">;

/** Writes the 16-byte header at the start of `view`. Throws on out-of-range fields (a bug on our side). */
export function writeHeader(view: DataView, h: FrameFields): void {
	if (!Number.isInteger(h.batch) || h.batch < 1 || h.batch > MAX_BATCH_ID) throw new RangeError("frame batch");
	if (!Number.isInteger(h.file) || h.file < 0 || h.file > 0xffffffff) throw new RangeError("frame file");
	if (!Number.isInteger(h.offset) || h.offset < 0 || h.offset > MAX_OFFSET) throw new RangeError("frame offset");
	view.setUint8(FRAME_OFFSETS.version, 1);
	view.setUint8(FRAME_OFFSETS.flags, (h.dir ? FLAG_OFFERER : 0) | (h.last ? FLAG_LAST : 0));
	view.setUint16(FRAME_OFFSETS.batch, h.batch);
	view.setUint32(FRAME_OFFSETS.file, h.file);
	view.setUint32(FRAME_OFFSETS.offset, Math.floor(h.offset / TWO_32));
	view.setUint32(FRAME_OFFSETS.offset + 4, h.offset % TWO_32);
}

/** A new frame buffer (header + copy of payload). Tests and one-offs; the sender reuses a `FrameWriter`. */
export function encodeFrame(h: FrameFields, payload: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
	writeHeader(new DataView(out.buffer), h);
	out.set(payload, FRAME_HEADER_BYTES);
	return out;
}

/**
 * One reusable frame buffer per lane (§7.4). `RTCDataChannel.send()` copies synchronously, so the
 * returned view is only valid until the next `frame()` call.
 */
export class FrameWriter {
	private readonly buf: ArrayBuffer;
	private readonly view: DataView;
	private readonly bytes: Uint8Array<ArrayBuffer>;

	constructor(chunk: number) {
		this.buf = new ArrayBuffer(chunk);
		this.view = new DataView(this.buf);
		this.bytes = new Uint8Array(this.buf);
	}

	get maxPayload(): number {
		return this.buf.byteLength - FRAME_HEADER_BYTES;
	}

	frame(h: FrameFields, payload: Uint8Array): Uint8Array<ArrayBuffer> {
		if (payload.byteLength === 0 || payload.byteLength > this.maxPayload) throw new RangeError("frame payload");
		writeHeader(this.view, h);
		this.bytes.set(payload, FRAME_HEADER_BYTES);
		return new Uint8Array(this.buf, 0, FRAME_HEADER_BYTES + payload.byteLength);
	}
}

export interface DecodedFrame {
	header: FrameHeader;
	/** View into the received buffer (no copy). */
	payload: Uint8Array<ArrayBuffer>;
}

/**
 * Decodes a received frame. Returns null for anything malformed: too short, wrong version, unknown
 * flags, batch 0, offset beyond 2^53, empty or oversized payload. Semantic checks (batch state,
 * manifest bounds) are the receiver's.
 */
export function decodeFrame(data: ArrayBuffer, maxPayload = MAX_PAYLOAD): DecodedFrame | null {
	const len = data.byteLength - FRAME_HEADER_BYTES;
	if (len < 1 || len > maxPayload) return null;
	const v = new DataView(data);
	if (v.getUint8(FRAME_OFFSETS.version) !== 1) return null;
	const flags = v.getUint8(FRAME_OFFSETS.flags);
	if (flags & ~KNOWN_FLAGS) return null;
	const batch = v.getUint16(FRAME_OFFSETS.batch);
	if (batch < 1) return null;
	const hi = v.getUint32(FRAME_OFFSETS.offset);
	const lo = v.getUint32(FRAME_OFFSETS.offset + 4);
	const offset = hi * TWO_32 + lo;
	if (offset + len > MAX_OFFSET) return null;
	return {
		header: {
			version: 1,
			dir: flags & FLAG_OFFERER ? 1 : 0,
			last: (flags & FLAG_LAST) !== 0,
			batch,
			file: v.getUint32(FRAME_OFFSETS.file),
			offset,
		},
		payload: new Uint8Array(data, FRAME_HEADER_BYTES),
	};
}

/** Ack text (§7.3). Decode with `parseAck` from types.ts. */
export function encodeAck(ack: Ack): string {
	return JSON.stringify(
		ack.c === undefined ? { a: ack.a, d: ack.d, w: ack.w } : { a: ack.a, d: ack.d, w: ack.w, c: ack.c },
	);
}
