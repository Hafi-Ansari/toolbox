// Shape guards for the untrusted ctrl and ack messages, and compile-time checks of the shared contracts.
import { describe, expect, it } from "vitest";
import { CTRL_MAX_BYTES } from "./tuning.ts";
import {
	type Ack,
	acceptMode,
	type Ctrl,
	type DataChannelLike,
	encodeCtrl,
	FtError,
	isAck,
	isCtrl,
	isLaneCtrl,
	isOrderedMode,
	isPairId,
	isPeerId,
	isSecret,
	isTransferCtrl,
	parseAck,
	parseCtrl,
} from "./types.ts";

const hello: Ctrl = {
	t: "hello",
	v: 1,
	name: "Brisk Fox",
	emoji: "🦊",
	caps: { folder: true, zip: true, memoryMax: 2 ** 30, lanes: 6 },
};
const manifest: Ctrl = {
	t: "manifest",
	batch: 1,
	part: 0,
	last: true,
	files: [
		{ i: 0, path: "Trip/Day 1/IMG_0001.CR3", size: 25_000_000, mtime: 1_700_000_000_000 },
		{ i: 1, path: "empty.txt", size: 0, mtime: 0 },
	],
	count: 2,
	total: 25_000_000,
};
const valid: Ctrl[] = [
	hello,
	{ t: "lane-offer", lane: 1, sdp: "v=0" },
	{ t: "lane-answer", lane: 7, sdp: "v=0" },
	{ t: "restart-offer", lane: 0, sdp: "v=0" },
	{ t: "restart-answer", lane: 0, sdp: "v=0" },
	{ t: "lane-close", lane: 3 },
	manifest,
	{ t: "accept", batch: 1, mode: "zip", skip: [] },
	{ t: "accept", batch: 65535, mode: "folder", skip: [0, 4] },
	{ t: "decline", batch: 2, reason: "too-big" },
	{ t: "file-done", batch: 1, file: 0 },
	{ t: "done", batch: 1 },
	{ t: "cancel", batch: 1, by: "receiver", reason: "protocol" },
	{ t: "bye" },
];

describe("ctrl guards", () => {
	it("accepts every message kind and round-trips it", () => {
		for (const c of valid) {
			expect(isCtrl(c)).toBe(true);
			expect(parseCtrl(encodeCtrl(c))).toEqual(c);
		}
	});

	it("rejects malformed messages", () => {
		const bad: unknown[] = [
			null,
			[],
			"bye",
			{},
			{ t: "nope" },
			{ ...hello, v: 2 },
			{ ...hello, caps: { folder: true, zip: true, memoryMax: 1, lanes: 9 } },
			{ ...hello, caps: { folder: true, zip: true, memoryMax: 1, lanes: 0 } },
			{ t: "lane-offer", lane: 8, sdp: "v=0" },
			{ t: "lane-offer", lane: 1, sdp: "" },
			{ t: "lane-close", lane: -1 },
			{ ...manifest, batch: 0 },
			{ ...manifest, batch: 65536 },
			{ ...manifest, files: [{ i: 0, path: "", size: 1, mtime: 0 }] },
			{ ...manifest, files: [{ i: 0, path: "a", size: -1, mtime: 0 }] },
			{ ...manifest, files: [{ i: 0, path: "a", size: 2 ** 53, mtime: 0 }] },
			{ ...manifest, last: "yes" },
			{ t: "accept", batch: 1, mode: "test", skip: [] },
			{ t: "accept", batch: 1, mode: "zip", skip: [1.5] },
			{ t: "decline", batch: 1, reason: "nah" },
			{ t: "file-done", batch: 1, file: "0" },
			{ t: "cancel", batch: 1, by: "someone", reason: "cancelled" },
		];
		for (const v of bad) expect(isCtrl(v), JSON.stringify(v)).toBe(false);
		expect(parseCtrl("{not json")).toBeNull();
		expect(parseCtrl(" ".repeat(CTRL_MAX_BYTES + 1))).toBeNull();
	});

	it("refuses to encode a message over 64 KiB", () => {
		const files = Array.from({ length: 2000 }, (_, i) => ({
			i,
			path: `folder/${"x".repeat(40)}${i}`,
			size: 1,
			mtime: 0,
		}));
		expect(() => encodeCtrl({ ...manifest, files } as Ctrl)).toThrow(RangeError);
	});

	it("splits lane and transfer messages", () => {
		const lane = valid.filter(isLaneCtrl).map((c) => c.t);
		const transfer = valid.filter(isTransferCtrl).map((c) => c.t);
		expect(new Set(lane)).toEqual(
			new Set(["hello", "lane-offer", "lane-answer", "restart-offer", "restart-answer", "lane-close", "bye"]),
		);
		expect(new Set(transfer)).toEqual(new Set(["manifest", "accept", "decline", "file-done", "done", "cancel"]));
	});
});

describe("ack guards", () => {
	it("accepts acks with and without the contiguous mark", () => {
		const acks: Ack[] = [
			{ a: 1, d: 0, w: 0 },
			{ a: 3, d: 1, w: 5 * 2 ** 30, c: 2 ** 40 },
		];
		for (const a of acks) expect(parseAck(JSON.stringify(a))).toEqual(a);
	});

	it("rejects malformed acks", () => {
		for (const v of [
			{ a: 0, d: 0, w: 0 },
			{ a: 1, d: 2, w: 0 },
			{ a: 1, d: 0, w: -1 },
			{ a: 1, d: 0, w: 0, c: "1" },
		])
			expect(isAck(v)).toBe(false);
		expect(parseAck("nope")).toBeNull();
		expect(parseAck(`{"a":1,"d":0,"w":0,"pad":"${"x".repeat(300)}"}`)).toBeNull();
	});
});

describe("ids and modes", () => {
	it("checks id formats", () => {
		expect(isPeerId("0123456789abcdef")).toBe(true);
		expect(isPeerId("0123456789ABCDEF")).toBe(false);
		expect(isPeerId("0123456789abcde")).toBe(false);
		expect(isPairId("fedcba9876543210")).toBe(true);
		expect(isSecret("0123456789abcdef0123456789abcdef")).toBe(true);
		expect(isSecret("0123456789abcdef")).toBe(false);
	});

	it("maps sinks to accept modes and scheduler order", () => {
		expect(acceptMode({ mode: "zip", ordered: true })).toBe("zip");
		expect(acceptMode({ mode: "memory", ordered: true })).toBe("memory");
		expect(acceptMode({ mode: "folder", ordered: false })).toBe("folder");
		expect(acceptMode({ mode: "test", ordered: true })).toBe("zip");
		expect(acceptMode({ mode: "test", ordered: false })).toBe("folder");
		expect(isOrderedMode("zip")).toBe(true);
		expect(isOrderedMode("memory")).toBe(true);
		expect(isOrderedMode("folder")).toBe(false);
	});

	it("carries an error code", () => {
		const e = new FtError("failed-direct");
		expect(e).toBeInstanceOf(Error);
		expect(e.code).toBe("failed-direct");
	});

	it("accepts a real RTCDataChannel as DataChannelLike (compile-time)", () => {
		const asLike = (dc: RTCDataChannel): DataChannelLike => dc;
		expect(typeof asLike).toBe("function");
	});
});
