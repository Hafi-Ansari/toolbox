// Create mode: pack made-up files (a nested folder, an empty folder, a non-ASCII
// name, incompressible bytes), then check the archive byte for byte with 7-Zip in
// Node and by opening it again in the tool's own Extract mode.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { unzipSync } from "fflate";
import { formatBytes } from "../src/lib/format.ts";
import type { Archive } from "../src/tools/unzip/engine/listing.ts";
import { archiveEngine } from "../src/tools/unzip/engine/sevenzip.ts";
import { compileSevenZip, memoryArchive } from "./archives.ts";

const noise = (() => {
	const bytes = new Uint8Array(200_000);
	for (let i = 0, x = 11; i < bytes.length; i++) {
		x = (x * 1103515245 + 12345) >>> 0;
		bytes[i] = x >>> 23;
	}
	return Buffer.from(bytes);
})();

/** What the mocked folder picker returns: folder "Trip". */
const folder: Record<string, string | Buffer> = {
	"Trip/day 1/lighthouse.txt": "The lamp turns every nine seconds.\n",
	"Trip/Ünïcødé café ☕.txt": "Grüße aus Köln\n",
	"Trip/noise.bin": noise,
	"Trip/zero.txt": "",
};
const loose = { name: "readme.txt", mimeType: "text/plain", buffer: Buffer.from("A made-up note.\n".repeat(50)) };
const expected: Record<string, Buffer> = {
	...Object.fromEntries(Object.entries(folder).map(([name, data]) => [name, Buffer.from(data)])),
	"readme.txt": loose.buffer,
};

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

async function capture(page: Page, name: string) {
	const directory = process.env.UNZIP_SCREENSHOTS;
	if (!directory) return;
	await fs.mkdir(directory, { recursive: true });
	await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
}

/** Folder picker returning the made-up "Trip" folder (plus an empty subfolder); no save picker. */
async function mockPickers(page: Page, savePicker = false) {
	await page.addInitScript(
		({ entries, savePicker }) => {
			type Tree = { [name: string]: Tree | File };
			const root: Tree = { Empty: {} };
			for (const [full, data] of entries) {
				const parts = full.split("/").slice(1);
				const name = parts.pop() as string;
				let node = root;
				for (const part of parts) {
					node[part] ??= {};
					node = node[part] as Tree;
				}
				node[name] = new File([new Uint8Array(data)], name, { lastModified: Date.UTC(2024, 4, 1) });
			}
			const handle = (name: string, node: Tree | File): object =>
				node instanceof File
					? { kind: "file", name, getFile: async () => node }
					: {
							kind: "directory",
							name,
							async *values() {
								for (const [child, value] of Object.entries(node)) yield handle(child, value);
							},
						};
			Object.defineProperty(window, "showDirectoryPicker", {
				configurable: true,
				value: async () => handle("Trip", root),
			});
			// The in-page explanation before the browser prompt was already seen (tested in unzip.spec).
			localStorage.setItem("toolbox.explained.read-folder", "1");
			// With the save picker, every archive streams to it (normally only very large ones do).
			if (savePicker) Object.assign(window, { __toolboxDirectDownloadLimit: 0 });
			const saved = { bytes: [] as number[], aborted: false, closed: false, writes: 0 };
			Object.assign(window, { savedArchive: saved });
			Object.defineProperty(window, "showSaveFilePicker", {
				configurable: true,
				value: savePicker
					? async () => ({
							async createWritable() {
								return {
									async write({ position, data }: { position: number; data: Uint8Array }) {
										saved.writes++;
										await new Promise((resolve) => setTimeout(resolve, 20));
										for (let i = 0; i < data.length; i++) saved.bytes[position + i] = data[i];
									},
									async truncate(size: number) {
										saved.bytes.length = size;
									},
									async close() {
										saved.closed = true;
									},
									async abort() {
										saved.aborted = true;
									},
								};
							},
						})
					: undefined,
			});
		},
		{ entries: Object.entries(folder).map(([name, data]) => [name, [...Buffer.from(data)]] as const), savePicker },
	);
}

async function addEverything(page: Page) {
	await page.goto("/unzip");
	await page.getByRole("tab", { name: "Create" }).click();
	await page.getByRole("button", { name: "Add folder" }).click();
	await page.getByLabel("Add files").setInputFiles(loose);
	await expect(page.getByText(`5 files · ${formatBytes(total)}`)).toBeVisible();
}

const total = Object.values(expected).reduce((sum, data) => sum + data.length, 0);

let compiled: WebAssembly.Module;
test.beforeAll(async () => {
	compiled = await compileSevenZip();
});

async function unpack(name: string, bytes: Uint8Array, password: string) {
	const engine = archiveEngine(compiled);
	const source = memoryArchive(name, bytes);
	const archive: Archive = await engine.list(source, name, password);
	const files: Record<string, Buffer> = {};
	let current = "";
	let parts: Buffer[] = [];
	const wanted = new Set(archive.entries.flatMap((entry, i) => (entry.folder ? [] : [i])));
	await engine.extract(source, archive, password, wanted, {
		start(i) {
			current = archive.entries[i].path;
			parts = [];
		},
		write(chunk) {
			parts.push(Buffer.from(new Uint8Array(chunk)));
		},
		end() {
			files[current] = Buffer.concat(parts);
		},
	});
	const folders = archive.entries.filter((entry) => entry.folder).map((entry) => entry.path.replace(/\/$/, ""));
	return { archive, files, folders };
}

function sameFiles(files: Record<string, Buffer | Uint8Array>) {
	expect(Object.keys(files).sort()).toEqual(Object.keys(expected).sort());
	for (const [name, data] of Object.entries(expected))
		expect(Buffer.compare(Buffer.from(files[name]), data), name).toBe(0);
}

for (const [format, label, password] of [
	["zip", "ZIP", ""],
	["zip", "ZIP", "correct horse"],
	["7z", "7z", ""],
	["7z", "7z", "correct horse"],
	["tar.gz", "TAR.GZ", ""],
] as const) {
	test(`creates ${format}${password ? " with a password" : ""} and reads it back byte for byte`, async ({ page }) => {
		await mockPickers(page);
		await addEverything(page);
		await page.getByLabel("Archive name").fill("made-up trip");
		await page.getByRole("radio", { name: label, exact: true }).check();
		if (password) await page.getByLabel("Password (optional)").fill(password);
		const download = page.waitForEvent("download");
		await page.getByRole("button", { name: `Create made-up trip.${format}` }).click();
		const file = await download;
		expect(file.suggestedFilename()).toBe(`made-up trip.${format}`);
		await expect(page.getByText(`Created made-up trip.${format}`)).toBeVisible();
		const bytes = await fs.readFile((await file.path()) ?? "");

		if (password) await expect(unpack(`a.${format}`, bytes, "")).rejects.toThrow("NEEDS_PASSWORD");
		const { archive, files, folders } = await unpack(`a.${format}`, bytes, password);
		sameFiles(files);
		expect(folders).toEqual(expect.arrayContaining(["Trip", "Trip/day 1", "Trip/Empty"]));
		if (password) expect(archive.entries.filter((e) => !e.folder && e.size).every((e) => e.encrypted)).toBe(true);

		// The tool's own Extract mode lists the same files and total.
		await page.getByRole("tab", { name: "Extract" }).click();
		await page.locator('#panel-extract input[type="file"]').setInputFiles({
			name: `made-up trip.${format}`,
			mimeType: "application/octet-stream",
			buffer: bytes,
		});
		if (password) {
			await page.getByLabel("Password", { exact: true }).fill(password);
			await page.getByRole("button", { name: "Unlock archive" }).click();
		}
		await expect(page.getByText(`5 files · ${formatBytes(total)} uncompressed`, { exact: false })).toBeVisible();
	});
}

test("extracts a created archive again in Extract mode", async ({ page }) => {
	await mockPickers(page);
	await addEverything(page);
	await page.getByRole("radio", { name: "7z", exact: true }).check();
	await page.getByLabel("Password (optional)").fill("pw");
	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "Create Archive.7z" }).click();
	const bytes = await fs.readFile((await (await download).path()) ?? "");
	await page.evaluate(() => {
		Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: undefined });
	});
	await page.getByRole("tab", { name: "Extract" }).click();
	await page
		.locator('#panel-extract input[type="file"]')
		.setInputFiles({ name: "Archive.7z", mimeType: "application/x-7z-compressed", buffer: bytes });
	await page.getByLabel("Password", { exact: true }).fill("pw");
	await page.getByRole("button", { name: "Unlock archive" }).click();
	const zip = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download all as .zip" }).click();
	const files = unzipSync(await fs.readFile((await (await zip).path()) ?? ""));
	const contents = Object.fromEntries(Object.entries(files).filter(([name]) => !name.endsWith("/")));
	sameFiles(contents);
	expect(Object.keys(files)).toContain("Trip/Empty/");
});

test("streams positioned writes to a picked file and cancels cleanly", async ({ page }) => {
	await mockPickers(page, true);
	await addEverything(page);
	await page.getByRole("radio", { name: "7z", exact: true }).check();
	await page.getByRole("button", { name: "Create Archive.7z" }).click();
	await expect(page.getByText("Created Archive.7z")).toBeVisible();
	const saved = await page.evaluate(() => {
		const state = (window as unknown as { savedArchive: { bytes: number[]; closed: boolean } }).savedArchive;
		return { bytes: state.bytes, closed: state.closed };
	});
	expect(saved.closed).toBe(true);
	sameFiles((await unpack("a.7z", new Uint8Array(saved.bytes), "")).files);
	await capture(page, "create-desktop");

	// A larger input so the run is still going when Cancel is pressed.
	const big = Buffer.alloc(24 << 20);
	for (let i = 0, x = 3; i < big.length; i += 4) {
		x = (x * 1103515245 + 12345) >>> 0;
		big.writeUInt32LE(x, i);
	}
	await page
		.getByLabel("Add files")
		.setInputFiles({ name: "big.bin", mimeType: "application/octet-stream", buffer: big });
	await page.getByRole("radio", { name: "Max", exact: true }).check();
	await page.getByRole("button", { name: "Create Archive.7z" }).click();
	await expect(page.getByRole("progressbar", { name: "Compressing" })).toBeVisible();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page.getByText("Archive creation canceled. Nothing was saved.")).toBeVisible();
	expect(
		await page.evaluate(() => (window as unknown as { savedArchive: { aborted: boolean } }).savedArchive.aborted),
	).toBe(true);
	// Removing the big file and creating again works with the restarted worker.
	await page.getByRole("button", { name: "Remove big.bin" }).click();
	await page.getByRole("radio", { name: "Fast", exact: true }).check();
	await page.getByRole("button", { name: "Create Archive.7z" }).click();
	await expect(page.getByText("Created Archive.7z")).toBeVisible();
});

test("removes files and folders from the list", async ({ page }) => {
	await mockPickers(page);
	await addEverything(page);
	await page.getByRole("button", { name: "day 1", exact: true }).click();
	await expect(page.getByText("lighthouse.txt")).toBeVisible();
	await page.getByRole("button", { name: "Remove folder day 1" }).click();
	await expect(page.getByText("4 files")).toBeVisible();
	await page.getByRole("button", { name: "Remove readme.txt" }).click();
	await expect(page.getByText("3 files")).toBeVisible();
	await page.getByRole("button", { name: "Remove folder Trip" }).click();
	await expect(page.getByRole("button", { name: /^Create / })).toBeHidden();
	await expect(page.getByLabel("Add files")).toBeVisible();
});

test.describe("touch", () => {
	test.use({
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
	});
	test("creates a ZIP from files on a phone, without folder picking or overflow", async ({ page }) => {
		await page.addInitScript(() => {
			for (const name of ["showDirectoryPicker", "showSaveFilePicker"]) {
				Object.defineProperty(window, name, { configurable: true, value: undefined });
			}
		});
		await page.goto("/unzip?mode=create");
		await expect(page.getByText("This browser can’t choose folders (iPhone and iPad Safari).")).toBeVisible();
		await expect(page.getByRole("button", { name: "Add folder" })).toHaveCount(0);
		await page
			.getByLabel("Add files")
			.setInputFiles([
				loose,
				{ name: "Ünïcødé café ☕.txt", mimeType: "text/plain", buffer: Buffer.from("Grüße aus Köln\n") },
			]);
		await expect(page.getByText("2 files")).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
		await capture(page, "create-mobile");
		const download = page.waitForEvent("download", { timeout: 30_000 });
		await page.getByRole("button", { name: "Create Archive.zip" }).tap();
		const bytes = await fs.readFile((await (await download).path()) ?? "");
		const { files } = await unpack("a.zip", bytes, "");
		expect(files["Ünïcødé café ☕.txt"].toString()).toBe("Grüße aus Köln\n");
		expect(files["readme.txt"].equals(loose.buffer)).toBe(true);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
	});
});
