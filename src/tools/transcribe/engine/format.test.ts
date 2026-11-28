import { describe, expect, it } from "vitest";
import { type Segment, timestamp, toSrt, toTxt } from "./format.ts";

describe("timestamp", () => {
	it("truncates like the Python script", () => {
		expect(timestamp(0)).toBe("00:00:00");
		expect(timestamp(27.8)).toBe("00:00:27");
		expect(timestamp(27.8, true)).toBe("00:00:27,800");
		expect(timestamp(44.56, true)).toBe("00:00:44,560");
		expect(timestamp(59.9999)).toBe("00:00:59");
		expect(timestamp(7561.25, true)).toBe("02:06:01,250");
	});

	it("never goes negative", () => {
		expect(timestamp(-0.2, true)).toBe("00:00:00,000");
	});
});

describe("output files", () => {
	const segments: Segment[] = [
		{ start: 0, end: 27.8, text: "Yes. Yeah, okay, so our recording is now on." },
		{ start: 27.8, end: 44.56, text: "We're going to talk more about parameter count." },
	];

	it("writes one [HH:MM:SS] line per segment", () => {
		expect(toTxt(segments)).toBe(
			"[00:00:00] Yes. Yeah, okay, so our recording is now on.\n[00:00:27] We're going to talk more about parameter count.\n",
		);
	});

	it("writes numbered SRT cues", () => {
		expect(toSrt(segments)).toBe(
			"1\n00:00:00,000 --> 00:00:27,800\nYes. Yeah, okay, so our recording is now on.\n\n" +
				"2\n00:00:27,800 --> 00:00:44,560\nWe're going to talk more about parameter count.\n\n",
		);
	});
});
