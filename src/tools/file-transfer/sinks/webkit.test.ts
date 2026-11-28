import { describe, expect, it } from "vitest";
import { isWebKitOnly } from "./zipStream.ts";

const nav = (userAgent: string, platform = "", maxTouchPoints = 0) => ({ userAgent, platform, maxTouchPoints });

describe("isWebKitOnly (no service-worker zip downloads)", () => {
	it.each([
		[
			"Chrome on iPhone",
			"Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.7444.0 Mobile/15E148 Safari/604.1",
		],
		[
			"Safari on iPhone",
			"Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1",
		],
		[
			"Safari on the Mac",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Safari/605.1.15",
		],
	])("%s is WebKit", (_, ua) => expect(isWebKitOnly(nav(ua, "iPhone"))).toBe(true));

	it("iPadOS, which reports a Mac, is told apart by its touch screen", () => {
		const ua =
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.0.0 Safari/604.1";
		expect(isWebKitOnly(nav(ua, "MacIntel", 5))).toBe(true);
	});

	it.each([
		[
			"Chrome on Windows",
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
			"Win32",
		],
		[
			"Edge on Windows",
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
			"Win32",
		],
		[
			"Chrome on the Mac",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
			"MacIntel",
		],
		[
			"Firefox on the Mac",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:145.0) Gecko/20100101 Firefox/145.0",
			"MacIntel",
		],
		[
			"Chrome on Android",
			"Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
			"Linux armv8l",
		],
	])("%s is not", (_, ua, platform) => expect(isWebKitOnly(nav(ua, platform, 0))).toBe(false));
});
