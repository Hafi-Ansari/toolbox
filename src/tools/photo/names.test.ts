import { describe, expect, it } from "vitest";
import { outputName, uniqueNames, zipName } from "./names.ts";

describe("names", () => {
	it("swaps the extension and keeps folders", () => {
		expect(outputName("IMG_0001.HEIC", "jpeg")).toBe("IMG_0001.jpg");
		expect(outputName("Trip/Day 1/IMG_0002.heic", "png")).toBe("Trip/Day 1/IMG_0002.png");
		expect(outputName("photo.final.JPEG", "png")).toBe("photo.final.png");
		expect(outputName("noext", "jpeg")).toBe("noext.jpg");
	});

	it("keeps names unique, ignoring case", () => {
		const next = uniqueNames();
		expect(next("IMG_1.jpg")).toBe("IMG_1.jpg");
		expect(next("img_1.JPG")).toBe("img_1 (2).JPG");
		expect(next("IMG_1.jpg")).toBe("IMG_1 (3).jpg");
		expect(next("Trip/IMG_1.jpg")).toBe("Trip/IMG_1.jpg");
	});

	it("names the zip after a folder or the date", () => {
		expect(zipName("Trip")).toBe("Trip.zip");
		expect(zipName(null, new Date(2026, 10, 28))).toBe("Photos 2026-11-28.zip");
	});
});
