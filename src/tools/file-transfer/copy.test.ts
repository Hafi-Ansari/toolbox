import { describe, expect, it } from "vitest";
import { bytes, doneText, duration, endedText, errorText, eta, pathText, percent, rate, seen } from "./copy.ts";
import { cleanName, EMOJIS } from "./profile.ts";
import type { BatchProgress } from "./types.ts";

const GiB = 1024 ** 3;

const batch = (patch: Partial<BatchProgress>): BatchProgress => ({
	batch: 1,
	side: "send",
	phase: "done",
	mode: "zip",
	files: 214,
	bytes: 38.4 * GiB,
	filesDone: 214,
	bytesDone: 38.4 * GiB,
	skipped: 0,
	rate: 0,
	etaMs: 0,
	current: [],
	lanes: 6,
	startedAt: 0,
	endedAt: 552_000,
	location: "Photos from Calm Otter.zip",
	declineReason: null,
	cancelledBy: null,
	error: null,
	...patch,
});

describe("file transfer copy", () => {
	it("formats sizes, speeds and times as the spec shows them", () => {
		expect(bytes(38.4 * GiB)).toBe("38.4 GB");
		expect(bytes(512)).toBe("512 B");
		expect(rate(71.2 * 1024 ** 2)).toBe("71.2 MB/s");
		expect(duration(552_000)).toBe("9 min 12 s");
		expect(eta(120_000)).toBe("2 min left");
		expect(eta(null)).toBeNull();
		expect(seen(5000)).toBe("here now");
		expect(seen(70_000)).toBe("seen 1 min ago");
		expect(pathText("direct", 8)).toBe("Direct · 8 lanes");
		expect(pathText("same-network", 6)).toBe("Direct · same network · 6 lanes");
	});

	it("only reads 100% when everything is persisted", () => {
		expect(percent(999, 1000)).toBe(99);
		expect(percent(1000, 1000)).toBe(100);
		expect(percent(0, 0)).toBe(100);
	});

	it("has the §11 messages", () => {
		expect(errorText("declined", "Calm Otter")).toBe("Calm Otter declined.");
		expect(errorText("expired", "Calm Otter")).toBe("Calm Otter didn't answer.");
		expect(errorText("busy", "Calm Otter")).toBe("Calm Otter is in another transfer.");
		expect(errorText("disabled")).toBe("File Transfer is paused right now.");
		expect(errorText("failed-direct")).toMatch(/^Couldn't connect directly\./);
		expect(errorText("signal-error")).toBe("Couldn't reach the server. Check your connection and try again.");
		expect(errorText("too-big", "Calm Otter")).toBe(
			"Calm Otter's browser can't receive this much. Ask them to use Chrome, Edge or Firefox on a computer.",
		);
	});

	it("says how a batch ended, on each side", () => {
		expect(doneText(batch({}), "Calm Otter")).toBe("Sent 214 files (38.4 GB) in 9 min 12 s · avg 71.2 MB/s");
		expect(doneText(batch({ side: "receive" }), "Calm Otter")).toBe(
			"Saved 214 files to your downloads as Photos from Calm Otter.zip",
		);
		expect(doneText(batch({ side: "receive", mode: "folder", location: "Pictures/Trip", skipped: 3 }), "x")).toBe(
			"Saved 211 files to Pictures/Trip · 3 already there were skipped",
		);
		expect(endedText(batch({ phase: "cancelled", cancelledBy: "receiver" }), "Calm Otter")).toBe(
			"Calm Otter stopped receiving.",
		);
		expect(endedText(batch({ phase: "interrupted", side: "receive" }), "Calm Otter")).toMatch(/stopped partway/);
		expect(endedText(batch({ phase: "failed", error: "read-error" }), "Calm Otter")).toMatch(
			/^Couldn't read one of the files\. It may have been moved/,
		);
		expect(endedText(batch({ phase: "failed", side: "receive", error: "read-error" }), "Calm Otter")).toMatch(
			/^Calm Otter couldn't read one of the files/,
		);
		expect(endedText(batch({ phase: "failed", error: "sink-error" }), "Calm Otter")).toMatch(
			/^Calm Otter couldn't save the files\./,
		);
	});

	it("cleans names like the server", () => {
		expect(cleanName("  Brisk‮  Fox\u0007 ")).toBe("Brisk Fox");
		expect(cleanName("x".repeat(40))).toHaveLength(24);
		expect(EMOJIS).toContain("🦊");
	});
});
