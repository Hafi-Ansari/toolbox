// Photo Converter end to end: the real page and worker in headless Edge, on the synthetic fixtures
// (e2e/fixtures/photo, made by scripts/photo-fixtures.py). Outputs are checked in Node with the
// same container readers and codecs the app uses.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Download, expect, type Page, test } from "@playwright/test";
import { ZipReader } from "../src/lib/zipReader.ts";
import { identifyIcc } from "../src/tools/photo/color.ts";
import { readJpeg, readPng } from "../src/tools/photo/containers.ts";
import { readExif } from "../src/tools/photo/exif.ts";
import { nodeCodecs } from "../src/tools/photo/nodeCodecs.ts";

const fixtures = path.join(import.meta.dirname, "fixtures", "photo");
const fixture = (name: string) => path.join(fixtures, name);

// Generated inputs go to a temp folder: Playwright can't mix paths with buffers, or take buffers over 50 MB.
let temp = "";
test.beforeAll(async () => {
	temp = await fs.mkdtemp(path.join(os.tmpdir(), "photo-e2e-"));
});
test.afterAll(async () => {
	await fs.rm(temp, { recursive: true, force: true });
});
async function file(name: string, data: Uint8Array | string): Promise<string> {
	const at = path.join(temp, name);
	await fs.writeFile(at, data);
	return at;
}

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
	const messages: string[] = [];
	errors.set(page, messages);
	page.on("pageerror", (error) => messages.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") messages.push(message.text());
	});
	await page.goto("/photo");
	await page.evaluate(() => localStorage.removeItem("toolbox.photo.options"));
	await page.reload();
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));

const bytesOf = async (download: Download) => new Uint8Array(await fs.readFile((await download.path()) ?? ""));

async function convert(page: Page, button: RegExp, timeout = 60_000) {
	const [download] = await Promise.all([
		page.waitForEvent("download", { timeout }),
		page.getByRole("button", { name: button }).click(),
	]);
	return download;
}

/** RGBA at (x, y) of a JPEG or PNG, decoded in Node. */
async function pixel(bytes: Uint8Array, x: number, y: number) {
	const codecs = await nodeCodecs();
	const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	const image =
		bytes[0] === 0xff
			? await (await codecs.jpeg()).decode(buffer, { preserveOrientation: false })
			: await (await codecs.png()).decode(buffer, { bitDepth: 8 });
	const i = (y * image.width + x) * 4;
	return Array.from(image.data.subarray(i, i + 4));
}

/** The DOS date and time of a zip entry, from its central directory record. */
function dosStamp(zip: Uint8Array, name: string) {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	for (let at = 0; at + 46 < zip.length; at++) {
		if (view.getUint32(at, true) !== 0x02014b50) continue;
		const length = view.getUint16(at + 28, true);
		if (new TextDecoder().decode(zip.subarray(at + 46, at + 46 + length)) === name)
			return { time: view.getUint16(at + 12, true), date: view.getUint16(at + 14, true) };
	}
	return null;
}

/** A noisy PNG (slow enough to encode that a batch of them can be canceled midway). */
async function noisyPng(width: number, height: number, transparent = false): Promise<Buffer> {
	const codecs = await nodeCodecs();
	const data = new Uint8ClampedArray(width * height * 4);
	let seed = 7;
	for (let i = 0; i < data.length; i++) {
		seed = (seed * 1103515245 + 12345) >>> 0;
		data[i] = i % 4 === 3 ? (transparent && i % 8 === 3 ? 0 : 255) : seed >>> 24;
	}
	return Buffer.from(await (await codecs.png()).encode({ data, width, height }, { bitDepth: 8 }));
}

test("one HEIC → JPEG: upright, Display P3 kept, EXIF and location kept", async ({ page }) => {
	await page.getByLabel("Choose photos").setInputFiles(fixture("main.heic"));
	await expect(page.getByText("HEIC → JPEG")).toBeVisible();
	const download = await convert(page, /^Convert to JPEG/);
	expect(download.suggestedFilename()).toBe("main.jpg");
	const bytes = await bytesOf(download);
	const info = readJpeg(bytes);
	expect([info.width, info.height]).toEqual([48, 64]);
	expect(identifyIcc(info.icc as Uint8Array)).toBe("p3");
	expect(readExif(info.exif as Uint8Array)).toMatchObject({
		orientation: 1,
		hasGps: true,
		dateTaken: "2024:05:06 07:08:09",
	});
	// P3 red, on top after the rotation, keeps its P3 values.
	const [r, g, b] = await pixel(bytes, 24, 4);
	expect(r).toBeGreaterThan(245);
	expect(g + b).toBeLessThan(24);
	await expect(page.getByText(/^Saved main\.jpg/)).toBeVisible();
	await expect(page.getByText("main.jpg · Display P3")).toBeVisible();
});

test("Remove location and sRGB: no GPS left, sRGB profile, and the options are remembered", async ({ page }) => {
	await page.getByLabel("Choose photos").setInputFiles(fixture("main.heic"));
	await page.getByRole("switch", { name: /Remove location/ }).click();
	await page.getByRole("switch", { name: /sRGB for maximum compatibility/ }).click();
	const bytes = await bytesOf(await convert(page, /^Convert to JPEG/));
	const info = readJpeg(bytes);
	expect(readExif(info.exif as Uint8Array).hasGps).toBe(false);
	expect(identifyIcc(info.icc as Uint8Array)).toBe("srgb");
	await expect(page.getByText("main.jpg · sRGB")).toBeVisible();

	await page.reload();
	await page.getByLabel("Choose photos").setInputFiles(fixture("main.heic"));
	await expect(page.getByRole("switch", { name: /Remove location/ })).toHaveAttribute("aria-checked", "true");
	await expect(page.getByRole("switch", { name: /sRGB/ })).toHaveAttribute("aria-checked", "true");
});

test("several photos → one zip; 16-bit PNG output; transparency note for JPEG", async ({ page }) => {
	await page
		.getByLabel("Choose photos")
		.setInputFiles([
			fixture("main.heic"),
			fixture("deep.heic"),
			fixture("alpha.heic"),
			await file("clear.png", await noisyPng(8, 8, true)),
		]);
	await expect(page.getByText(/^4 photos ·/)).toBeVisible();

	// PNG: the 10-bit HEIC becomes a 16-bit PNG; the transparent one keeps its alpha.
	await page.getByRole("radio", { name: "PNG" }).check();
	let zip = await ZipReader.open(new Blob([await bytesOf(await convert(page, /^Convert 4 photos/))]));
	expect([...zip.entries.keys()].sort()).toEqual(["alpha.png", "clear.png", "deep.png", "main.png"]);
	expect(readPng(await zip.bytes("deep.png")).bitDepth).toBe(16);
	expect((await pixel(await zip.bytes("alpha.png"), 60, 10))[3]).toBe(0);
	await expect(page.getByText(/^Saved 4 photos in Photos \d{4}-\d\d-\d\d\.zip/)).toBeVisible();
	await expect(page.getByText("Already a PNG: kept as it was.")).toBeVisible();

	// JPEG: transparent areas are filled, and the list says so.
	await page.getByRole("radio", { name: "JPEG" }).check();
	const zipBytes = await bytesOf(await convert(page, /^Convert 4 photos/));
	zip = await ZipReader.open(new Blob([zipBytes]));
	expect([...zip.entries.keys()].sort()).toEqual(["alpha.jpg", "clear.jpg", "deep.jpg", "main.jpg"]);
	await expect(page.getByText(/Transparent areas were filled with white/).first()).toBeVisible();
	// main.jpg's zip entry carries the date taken (2024-05-06 07:08:09) as its DOS date and time.
	expect(dosStamp(zipBytes, "main.jpg")).toEqual({
		date: ((2024 - 1980) << 9) | (5 << 5) | 6,
		time: (7 << 11) | (8 << 5) | (9 >> 1),
	});
});

test("files that aren't HEIC, JPEG or PNG are skipped, AVIF with a reason", async ({ page }) => {
	const avif = Buffer.alloc(32);
	avif.writeUInt32BE(24, 0);
	avif.write("ftypavif\0\0\0\0mif1avif", 4, "latin1");
	await page
		.getByLabel("Choose photos")
		.setInputFiles([fixture("main.heic"), await file("notes.txt", "hello"), await file("pic.avif", avif)]);
	await expect(
		page.getByText(/Skipped 2 files that aren't HEIC, JPEG or PNG: notes\.txt, pic\.avif \(AVIF isn't supported yet\)/),
	).toBeVisible();
	await expect(page.getByText("1 photo ·")).toBeVisible();
});

test("cancel stops a batch without saving anything, and the tool works again after", async ({ page }) => {
	const big = await noisyPng(3000, 2000);
	const paths: string[] = [];
	for (const n of [1, 2, 3, 4]) paths.push(await file(`noise${n}.png`, big));
	await page.getByLabel("Choose photos").setInputFiles(paths);
	let downloads = 0;
	page.on("download", () => downloads++);
	await page.getByRole("button", { name: /^Convert 4 photos/ }).click();
	await expect(page.getByText(/^Converting [12] of 4/)).toBeVisible();
	await page.getByRole("button", { name: "Cancel" }).click();
	await expect(page.getByText("Canceled. Nothing was saved.")).toBeVisible();
	expect(downloads).toBe(0);

	await page.getByRole("button", { name: "Clear list" }).click();
	await page.getByLabel("Choose photos").setInputFiles(fixture("main.heic"));
	const download = await convert(page, /^Convert to JPEG/);
	expect(download.suggestedFilename()).toBe("main.jpg");
});
