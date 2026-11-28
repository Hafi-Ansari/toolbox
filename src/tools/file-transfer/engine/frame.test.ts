import { describe, expect, it } from "vitest";
import { FRAME_HEADER_BYTES, MAX_OFFSET } from "../tuning.ts";
import { parseAck } from "../types.ts";
import { decodeFrame, encodeAck, encodeFrame, FrameWriter, MAX_PAYLOAD } from "./frame.ts";
import { RateMeter } from "./meter.ts";
import { IntervalSet } from "./util.ts";

const payload = (n: number) => Uint8Array.from({ length: n }, (_, i) => i & 0xff);

describe("frame codec", () => {
	it("round-trips the header and payload", () => {
		const h = { dir: 1 as const, last: true, batch: 513, file: 70_000, offset: 123_456_789 };
		const f = encodeFrame(h, payload(1000));
		expect(f.byteLength).toBe(FRAME_HEADER_BYTES + 1000);
		const d = decodeFrame(f.buffer);
		expect(d?.header).toEqual({ version: 1, ...h });
		expect([...(d?.payload ?? [])]).toEqual([...payload(1000)]);
	});

	it("writes the documented big-endian layout", () => {
		const f = encodeFrame({ dir: 0, last: true, batch: 0x0102, file: 0x03040506, offset: 5 * 2 ** 32 + 7 }, payload(1));
		expect([...f.subarray(0, 16)]).toEqual([1, 0b10, 1, 2, 3, 4, 5, 6, 0, 0, 0, 5, 0, 0, 0, 7]);
	});

	it("carries u64 offsets above 4 GiB, up to 2^53", () => {
		for (const offset of [2 ** 32, 2 ** 32 + 1, 5 * 2 ** 40 + 12345, MAX_OFFSET - 10]) {
			const d = decodeFrame(encodeFrame({ dir: 0, last: false, batch: 1, file: 0, offset }, payload(10)).buffer);
			expect(d?.header.offset).toBe(offset);
		}
	});

	it("rejects malformed frames", () => {
		const good = () => encodeFrame({ dir: 1, last: false, batch: 1, file: 0, offset: 0 }, payload(4));
		const mutate = (fn: (b: Uint8Array) => void) => {
			const b = good();
			fn(b);
			return b.buffer;
		};
		expect(decodeFrame(new ArrayBuffer(FRAME_HEADER_BYTES))).toBeNull(); // empty payload
		expect(decodeFrame(new ArrayBuffer(5))).toBeNull(); // short
		expect(decodeFrame(mutate((b) => (b[0] = 2)))).toBeNull(); // version
		expect(decodeFrame(mutate((b) => (b[1] = 0b100)))).toBeNull(); // unknown flag
		expect(decodeFrame(mutate((b) => b.fill(0, 2, 4)))).toBeNull(); // batch 0
		expect(decodeFrame(mutate((b) => (b[8] = 0x00 | 0x20)))).toBeNull(); // offset ≥ 2^53
		expect(decodeFrame(new ArrayBuffer(FRAME_HEADER_BYTES + MAX_PAYLOAD + 1))).toBeNull(); // oversized
		expect(decodeFrame(good().buffer, 3)).toBeNull(); // over the caller's payload cap
		// offset + len beyond 2^53
		expect(
			decodeFrame(
				mutate((b) => {
					new DataView(b.buffer).setUint32(8, 0x1fffff);
					new DataView(b.buffer).setUint32(12, 0xfffffffe);
				}),
			),
		).toBeNull();
	});

	it("refuses to encode out-of-range fields", () => {
		const p = payload(1);
		expect(() => encodeFrame({ dir: 0, last: false, batch: 0, file: 0, offset: 0 }, p)).toThrow(RangeError);
		expect(() => encodeFrame({ dir: 0, last: false, batch: 65536, file: 0, offset: 0 }, p)).toThrow(RangeError);
		expect(() => encodeFrame({ dir: 0, last: false, batch: 1, file: 2 ** 32, offset: 0 }, p)).toThrow(RangeError);
		expect(() => encodeFrame({ dir: 0, last: false, batch: 1, file: 0, offset: 2 ** 53 }, p)).toThrow(RangeError);
	});

	it("reuses one buffer per writer", () => {
		const w = new FrameWriter(64);
		const a = w.frame({ dir: 0, last: false, batch: 1, file: 0, offset: 0 }, payload(48));
		const b = w.frame({ dir: 0, last: true, batch: 1, file: 0, offset: 48 }, payload(5));
		expect(a.buffer).toBe(b.buffer);
		expect(b.byteLength).toBe(21);
		expect(decodeFrame(b.slice().buffer)?.header.offset).toBe(48);
		expect(() => w.frame({ dir: 0, last: false, batch: 1, file: 0, offset: 0 }, payload(49))).toThrow(RangeError);
		expect(() => w.frame({ dir: 0, last: false, batch: 1, file: 0, offset: 0 }, payload(0))).toThrow(RangeError);
	});

	it("encodes acks that parseAck accepts", () => {
		expect(parseAck(encodeAck({ a: 3, d: 1, w: 1 << 20 }))).toEqual({ a: 3, d: 1, w: 1 << 20 });
		expect(parseAck(encodeAck({ a: 3, d: 0, w: 5, c: 2 ** 40 }))).toEqual({ a: 3, d: 0, w: 5, c: 2 ** 40 });
	});
});

describe("RateMeter", () => {
	it("measures bytes per second over its window", () => {
		const m = new RateMeter(3000);
		m.push(0, 0);
		expect(m.rate).toBe(0);
		m.push(1_000_000, 1000);
		expect(m.rate).toBe(1_000_000);
		expect(m.eta(2_000_000)).toBe(2000);
		m.push(1_000_000, 5000); // stall: old samples fall out
		expect(m.rate).toBeLessThan(1_000_000);
		expect(new RateMeter().eta(10)).toBeNull();
		expect(new RateMeter().eta(0)).toBe(0);
	});
});

describe("IntervalSet", () => {
	it("merges, covers and reports gaps", () => {
		const s = new IntervalSet();
		s.add(10, 20);
		s.add(30, 40);
		expect(s.gaps(0, 50)).toEqual([
			[0, 10],
			[20, 30],
			[40, 50],
		]);
		expect(s.covers(12, 18)).toBe(true);
		expect(s.covers(15, 35)).toBe(false);
		s.add(20, 30);
		expect(s.covers(10, 40)).toBe(true);
		expect(s.size).toBe(30);
		s.add(0, 5);
		s.add(5, 10);
		expect(s.gaps(0, 40)).toEqual([]);
		expect(s.size).toBe(40);
	});
});
