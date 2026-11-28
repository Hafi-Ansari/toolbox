import fs from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { nestedNote, note, password, sampleTotal } from "./archives.ts";

const errors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
	const messages: string[] = [];
	errors.set(page, messages);
	page.on("pageerror", (error) => messages.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") messages.push(message.text());
	});
});

test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));

async function open(page: Page, file: string) {
	await page.goto("/unzip");
	await page.locator('input[type="file"]').setInputFiles(`out/unzip/${file}`);
}

async function downloadOnly(page: Page) {
	await page.addInitScript(() => {
		for (const name of ["showDirectoryPicker", "showSaveFilePicker"]) {
			Object.defineProperty(window, name, { configurable: true, value: undefined });
		}
	});
}

async function capture(page: Page, name: string) {
	const directory = process.env.UNZIP_SCREENSHOTS;
	if (!directory) return;
	await fs.mkdir(directory, { recursive: true });
	await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
}

async function mockFolder(page: Page, delay = 0) {
	await page.addInitScript((delay) => {
		const files: Record<string, string> = {};
		const directories = new Set(["sample"]);
		const state = { files, directories, writing: false, cancelled: false };
		Object.assign(window, { unzipFixture: state });
		function directory(fullPath: string) {
			return {
				name: fullPath.split("/").pop(),
				async getDirectoryHandle(name: string, options?: { create?: boolean }) {
					const next = [fullPath, name].filter(Boolean).join("/");
					if (next in files) throw new DOMException("Already a file", "TypeMismatchError");
					if (options?.create) directories.add(next);
					if (!directories.has(next)) throw new DOMException("Unknown directory", "NotFoundError");
					return directory(next);
				},
				async getFileHandle(name: string) {
					return {
						async createWritable() {
							const full = `${fullPath}/${name}`;
							files[full] = "";
							return {
								async write(chunk: Uint8Array) {
									state.writing = true;
									if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
									files[full] += new TextDecoder().decode(chunk);
								},
								async close() {},
								async abort() {
									state.cancelled = true;
								},
							};
						},
					};
				},
				async removeEntry(name: string) {
					for (const p of directories) if (p === name || p.startsWith(`${name}/`)) directories.delete(p);
					for (const p of Object.keys(files)) if (p.startsWith(`${name}/`)) delete files[p];
				},
			};
		}
		Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => directory("") });
		// The in-page explanation before the browser prompt was already seen (tested on its own).
		if (!(window as unknown as { keepExplanation?: boolean }).keepExplanation)
			localStorage.setItem("toolbox.explained.write-folder", "1");
	}, delay);
}

type FixtureState = { files: Record<string, string>; directories: Set<string>; writing: boolean; cancelled: boolean };
const fixture = (page: Page) =>
	page.evaluate(() => {
		const state = (window as unknown as { unzipFixture: FixtureState }).unzipFixture;
		return { ...state, directories: [...state.directories] };
	});

for (const [file, format] of [
	["sample.zip", "ZIP"],
	["sample.7z", "7Z"],
	["sample.tar.gz", "TAR.GZ"],
]) {
	test(`lists ${format} sizes and folders`, async ({ page }) => {
		await open(page, file);
		await expect(page.getByText(format, { exact: true })).toBeVisible();
		await expect(page.getByText(`4 files · ${sampleTotal} B uncompressed`, { exact: false })).toBeVisible();
		await expect(page.getByRole("button", { name: "notice.txt", exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "empty-dir", exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "nested", exact: true })).toHaveAttribute("aria-expanded", "false");
		await page.getByRole("button", { name: "nested", exact: true }).click();
		await expect(page.getByRole("button", { name: "cabin.txt", exact: true })).toBeVisible();
		await expect(page.getByText(`${nestedNote.length} B`, { exact: true })).toBeVisible();
	});
}

test("previews text and images and downloads a single file", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await downloadOnly(page);
	await open(page, "sample.zip");
	await page.getByRole("button", { name: "notice.txt", exact: true }).click();
	await expect(page.getByText(note.trim(), { exact: true })).toBeVisible();
	await capture(page, "desktop");
	const notice = page.waitForEvent("download");
	await page.getByRole("button", { name: "Save file", exact: true }).click();
	const downloaded = await notice;
	expect(downloaded.suggestedFilename()).toBe("notice.txt");
	expect(await fs.readFile((await downloaded.path()) ?? "", "utf8")).toBe(note);
	await page.getByRole("button", { name: "nested", exact: true }).click();
	await page.getByRole("button", { name: "pixel.png", exact: true }).click();
	await expect(page.getByRole("img", { name: "File preview" })).toBeVisible();
	await expect
		.poll(() =>
			page.getByRole("img", { name: "File preview" }).evaluate((image: HTMLImageElement) => image.naturalWidth),
		)
		.toBe(1);
});

test("downloads all files or a checked subset as a regular ZIP", async ({ page }) => {
	await downloadOnly(page);
	await open(page, "sample.tar.gz");
	const allPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download all as .zip" }).click();
	const all = await allPromise;
	expect(all.suggestedFilename()).toBe("sample.zip");
	const files = unzipSync(await fs.readFile((await all.path()) ?? ""));
	expect(Object.keys(files).sort()).toEqual(
		["empty-dir/", "nested/", "nested/cabin.txt", "nested/pixel.png", "notice.txt", "zero.txt"].sort(),
	);
	expect(strFromU8(files["notice.txt"])).toBe(note);
	expect(strFromU8(files["nested/cabin.txt"])).toBe(nestedNote);
	await page.getByRole("checkbox", { name: "Select notice.txt" }).check();
	const selectionPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download selected as .zip (1)" }).click();
	const selection = unzipSync(await fs.readFile((await (await selectionPromise).path()) ?? ""));
	expect(Object.keys(selection)).toEqual(["notice.txt"]);
});

test("streams to folders and sanitizes each saved path", async ({ page }) => {
	await mockFolder(page);
	await open(page, "sample.7z");
	await page.getByRole("button", { name: "Extract all", exact: true }).click();
	await expect(page.getByText("Extracted 4 files into the selected folder.")).toBeVisible();
	let state = await fixture(page);
	expect(state.files["sample (2)/nested/cabin.txt"]).toBe(nestedNote);
	expect(state.files["sample (2)/zero.txt"]).toBe("");
	expect(state.directories).toContain("sample (2)/empty-dir");
	await page.getByRole("button", { name: "Open another archive" }).click();
	await page.locator('input[type="file"]').setInputFiles("out/unzip/unsafe-names.zip");
	await page.getByRole("button", { name: "Extract all", exact: true }).click();
	await expect(page.getByText("Extracted 7 files into the selected folder.")).toBeVisible();
	state = await fixture(page);
	const saved = Object.fromEntries(Object.entries(state.files).filter(([name]) => name.startsWith("unsafe-names/")));
	expect(saved).toEqual({
		"unsafe-names/escape.txt": "Synthetic file 1\n",
		"unsafe-names/abs.txt": "Synthetic file 2\n",
		"unsafe-names/rightto-left.txt": "Synthetic file 3\n",
		"unsafe-names/control_.txt": "Synthetic file 4\n",
		"unsafe-names/_CON .txt": "Synthetic file 5\n",
		"unsafe-names/nested/ok.txt": "Synthetic file 6\n",
		"unsafe-names/Nested (2)/OK.TXT": "Synthetic file 7\n",
	});
});

test("explains the browser's folder prompt once, in the page, before it appears", async ({ page }) => {
	await page.addInitScript(() => Object.assign(window, { keepExplanation: true }));
	await mockFolder(page);
	await open(page, "sample.zip");
	const explanation = page.getByRole("dialog", { name: "Choose where to extract" });

	// Cancelling the explanation never reaches the browser's prompt.
	await page.getByRole("button", { name: "Extract all", exact: true }).click();
	await explanation.getByRole("button", { name: "Cancel" }).click();
	await expect(explanation).toBeHidden();
	expect(Object.keys((await fixture(page)).files)).toEqual([]);

	await page.getByRole("button", { name: "Extract all", exact: true }).click();
	await explanation.getByRole("button", { name: "Choose folder" }).click();
	await expect(page.getByText("Extracted 4 files into the selected folder.")).toBeVisible();

	// Once seen, it isn't shown again on this device.
	await page.getByRole("button", { name: "Extract all", exact: true }).click();
	await expect(page.getByText("Extracted 4 files into the selected folder.")).toBeVisible();
	await expect(explanation).toHaveCount(0);
	expect(Object.keys((await fixture(page)).files).filter((name) => name.endsWith("notice.txt"))).toHaveLength(2);
});

test("small results download directly, without the save dialog", async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(window, "showSaveFilePicker", {
			configurable: true,
			value: async () => {
				Object.assign(window, { pickerOpened: true });
				throw new DOMException("not expected", "AbortError");
			},
		});
	});
	await open(page, "sample.zip");
	await page.getByRole("button", { name: "notice.txt", exact: true }).click();
	const notice = page.waitForEvent("download");
	await page.getByRole("button", { name: "Save file", exact: true }).click();
	expect((await notice).suggestedFilename()).toBe("notice.txt");
	expect(await page.evaluate(() => (window as unknown as { pickerOpened?: boolean }).pickerOpened)).toBeUndefined();
});

for (const file of ["secret.zip", "secret-names.7z"]) {
	test(`rejects the wrong password and unlocks ${file}`, async ({ page }) => {
		await downloadOnly(page);
		await open(page, file);
		await expect(page.getByText("This archive requires a password.")).toBeVisible();
		await page.getByLabel("Password", { exact: true }).fill("wrong");
		await page.getByRole("button", { name: "Unlock archive" }).click();
		await expect(page.getByText("Wrong password, try again.")).toBeVisible();
		await page.getByLabel("Password", { exact: true }).fill(password);
		await page.getByRole("button", { name: "Unlock archive" }).click();
		await page.getByRole("button", { name: "notice.txt", exact: true }).click();
		await expect(page.getByText(note.trim(), { exact: true })).toBeVisible();
	});
}

test("cancels extraction, removes partial output, and can retry", async ({ page }) => {
	await mockFolder(page, 900);
	await open(page, "sample.zip");
	await page.getByRole("button", { name: "Extract all", exact: true }).click();
	await expect.poll(async () => (await fixture(page)).writing).toBe(true);
	await page.getByRole("button", { name: "Cancel extraction" }).click();
	await expect(page.getByText("Extraction canceled.")).toBeVisible();
	const { cancelled, files, directories } = await fixture(page);
	expect(cancelled).toBe(true);
	expect(files).toEqual({});
	expect([...directories]).toEqual(["sample"]);
	await page.getByRole("checkbox", { name: "Select notice.txt" }).check();
	await page.getByRole("button", { name: "Extract selected (1)" }).click();
	await expect(page.getByText("Extracted 1 file into the selected folder.")).toBeVisible();
	expect((await fixture(page)).files["sample (2)/notice.txt"]).toBe(note);
});

test.describe("touch", () => {
	test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
	test("opens a nested preview and downloads ZIP without horizontal overflow", async ({ page }) => {
		await downloadOnly(page);
		await open(page, "sample.tar.gz");
		await page.getByRole("button", { name: "nested", exact: true }).tap();
		await page.getByRole("button", { name: "cabin.txt", exact: true }).tap();
		await expect(page.getByText(nestedNote.trim(), { exact: true })).toBeVisible();
		await expect(page.getByText("Modified", { exact: true })).toBeHidden();
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
		const save = page.waitForEvent("download", { timeout: 20_000 });
		await page.getByRole("button", { name: "Download all as .zip" }).tap();
		expect((await save).suggestedFilename()).toBe("sample.zip");
		await capture(page, "mobile");
	});
});
