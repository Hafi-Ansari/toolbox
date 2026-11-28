import { describe, expect, it } from "vitest";
import { checkTuning, chunkSize, DEFAULT_TUNING, HIGH_WATER_MAX, maxUnpersisted, tuning } from "./tuning.ts";

describe("tuning", () => {
	it("ships the spec's defaults, within the hard limits", () => {
		expect(tuning.lanes).toBe(6);
		expect(tuning.highWater).toBeLessThanOrEqual(HIGH_WATER_MAX);
		expect(tuning.memoryMax).toBe(2 ** 30);
		expect(() => checkTuning()).not.toThrow();
	});

	it("rejects values the spec forbids", () => {
		const bad = [
			{ highWater: 13 * 2 ** 20 },
			{ lanes: 9 },
			{ lanes: 0 },
			{ lowWater: DEFAULT_TUNING.highWater },
			{ chunk: 300_000 },
			{ zipRange: 128 * 2 ** 20 },
		];
		for (const b of bad) expect(() => checkTuning({ ...DEFAULT_TUNING, ...b }), JSON.stringify(b)).toThrow(RangeError);
	});

	it("caps the chunk at the remote max message size", () => {
		expect(chunkSize()).toBe(262144);
		expect(chunkSize(65536)).toBe(65536);
		expect(chunkSize(Number.POSITIVE_INFINITY)).toBe(262144);
		expect(chunkSize(0)).toBe(262144);
	});

	it("bounds unpersisted bytes by lanes × (laneWindow + chunk)", () => {
		expect(maxUnpersisted(6)).toBe(6 * (16 * 2 ** 20 + 256 * 1024));
	});
});
