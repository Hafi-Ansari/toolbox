import { describe, expect, it } from "vitest";
import { classify, type Gesture, SWIPE_MIN, TAP_MAX_MS, TAP_SLOP } from "./gestures.ts";

const touch = (g: Partial<Gesture> = {}): Gesture => ({
	x0: 200,
	y0: 400,
	x1: 200,
	y1: 400,
	ms: 120,
	maxDist: 0,
	fingers: 1,
	scrolled: false,
	selecting: false,
	onControl: false,
	...g,
});

describe("touch gestures", () => {
	it("a short, still, single-finger touch is a tap", () => {
		expect(classify(touch())).toEqual({ kind: "tap" });
		expect(classify(touch({ x1: 206, y1: 404, maxDist: 7 }))).toEqual({ kind: "tap" });
	});

	it("drifting, holding, scrolling, pinching or selecting is not a tap", () => {
		expect(classify(touch({ maxDist: TAP_SLOP + 1, y1: 411 })).kind).toBe("none");
		expect(classify(touch({ ms: TAP_MAX_MS + 1 })).kind).toBe("none"); // long press
		expect(classify(touch({ scrolled: true })).kind).toBe("none"); // stopping a fling
		expect(classify(touch({ fingers: 2 })).kind).toBe("none"); // pinch
		expect(classify(touch({ selecting: true })).kind).toBe("none");
		expect(classify(touch({ onControl: true })).kind).toBe("none"); // links handle their own taps
		// A finger that wanders off and comes back is still not a tap.
		expect(classify(touch({ maxDist: 40 })).kind).toBe("none");
	});

	it("a sideways flick is a swipe; a vertical drag is nothing", () => {
		const far = SWIPE_MIN + 20;
		expect(classify(touch({ x1: 200 - far, maxDist: far }))).toEqual({ kind: "swipe", dir: 1 });
		expect(classify(touch({ x1: 200 + far, maxDist: far }))).toEqual({ kind: "swipe", dir: -1 });
		expect(classify(touch({ x1: 200 - far, y1: 400 + far, maxDist: far * 1.5 })).kind).toBe("none");
		expect(classify(touch({ y1: 200, maxDist: 200 })).kind).toBe("none");
		expect(classify(touch({ x1: 200 - far, maxDist: far, fingers: 2 })).kind).toBe("none");
	});
});
