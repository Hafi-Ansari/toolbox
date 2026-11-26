import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const errors: string[] = [];

test.beforeEach(({ page }) => {
	errors.length = 0;
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
});

test.afterEach(() => {
	expect(errors, "no console errors").toEqual([]);
});

/** Replace the save dialog with an in-memory writable, to exercise the stream-to-disk path. */
async function mockSavePicker(page: Page) {
	await page.addInitScript(() => {
		const w = window as unknown as { __saved?: number[]; __chunks?: number; showSaveFilePicker: unknown };
		w.showSaveFilePicker = async () => ({
			createWritable: async () => {
				const parts: Uint8Array[] = [];
				return {
					write: async (c: Uint8Array) => {
						parts.push(new Uint8Array(c));
					},
					close: async () => {
						const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
						let at = 0;
						for (const p of parts) {
							all.set(p, at);
							at += p.length;
						}
						w.__chunks = parts.length;
						w.__saved = Array.from(all.subarray(0, 64));
					},
					abort: async () => {},
				};
			},
		});
	});
}

async function disablePicker(page: Page) {
	await page.addInitScript(() => {
		delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
	});
}

async function openTool(page: Page) {
	await page.goto("/");
	await expect(page.getByRole("heading", { level: 1 })).toContainText("run entirely in your browser");
	await page.getByRole("link", { name: /EPUB ⇄ PDF/ }).click();
	await expect(page).toHaveURL(/\/epub-pdf$/);
	await expect(page.getByText("loading engine")).toBeHidden({ timeout: 30_000 });
}

test("EPUB → PDF downloads a valid PDF", async ({ page }) => {
	await disablePicker(page);
	await openTool(page);
	await page.locator('input[type="file"]').setInputFiles("out/sample.epub");
	await expect(page.getByText("sample.epub")).toBeVisible();
	await page.getByRole("radio", { name: "6×9 in" }).check();
	const download = page.waitForEvent("download");
	const t0 = Date.now();
	await page.getByRole("button", { name: "Convert to PDF" }).click();
	const file = await download;
	expect(file.suggestedFilename()).toBe("sample.pdf");
	const bytes = fs.readFileSync(await file.path());
	expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
	await expect(page.getByText(/Downloaded sample\.pdf/)).toBeVisible();
	console.log(`EPUB → PDF: ${bytes.length} bytes in ${Date.now() - t0} ms`);
});

test("PDF → EPUB (reflowable) streams to the chosen file", async ({ page }) => {
	await mockSavePicker(page);
	await openTool(page);
	await page.locator('input[type="file"]').setInputFiles("out/sample.pdf");
	await expect(page.getByText(/18 pages/)).toBeVisible();
	await page.keyboard.press("Enter");
	await expect(page.getByText(/Saved sample\.epub/)).toBeVisible();
	const head = await page.evaluate(() => (window as unknown as { __saved: number[] }).__saved);
	const bytes = Buffer.from(head);
	expect(bytes.subarray(0, 2).toString()).toBe("PK");
	expect(bytes.subarray(30, 58).toString()).toBe("mimetypeapplication/epub+zip");
});

test("PDF → EPUB (fixed layout) downloads, and cancel recovers", async ({ page }) => {
	await disablePicker(page);
	await openTool(page);
	await page.locator('input[type="file"]').setInputFiles("out/sample.pdf");
	await page.getByRole("radio", { name: "Fixed pages" }).check();
	await page.getByRole("radio", { name: "High" }).check();
	// Start and cancel once, then convert for real.
	await page.getByRole("button", { name: "Convert to EPUB" }).click();
	await page.getByRole("button", { name: "Cancel" }).click();
	await expect(page.getByRole("button", { name: "Convert to EPUB" })).toBeEnabled({ timeout: 30_000 });
	const download = page.waitForEvent("download");
	await page.getByRole("button", { name: "Convert to EPUB" }).click();
	const file = await download;
	const bytes = fs.readFileSync(await file.path());
	expect(bytes.subarray(30, 58).toString()).toBe("mimetypeapplication/epub+zip");
	expect(bytes.length).toBeGreaterThan(500_000);
});

test("rejects files that are not PDF or EPUB", async ({ page }) => {
	await openTool(page);
	await page
		.locator('input[type="file"]')
		.setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("just text") });
	await expect(page.getByRole("alert")).toContainText("doesn't look like a PDF or EPUB");
});

test("unknown routes show a not-found page", async ({ page }) => {
	await page.goto("/nope");
	await expect(page.getByRole("heading", { name: "Nothing here." })).toBeVisible();
});
