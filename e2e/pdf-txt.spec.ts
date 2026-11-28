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

async function open(page: Page, file = "out/poems.pdf") {
	await page.addInitScript(() => {
		delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
	});
	await page.goto("/");
	await page.getByRole("link", { name: /PDF → TXT/ }).click();
	await expect(page.getByText("loading engine")).toBeHidden({ timeout: 30_000 });
	await page.locator('input[type="file"]').setInputFiles(file);
}

const text = (page: Page) => page.getByRole("textbox", { name: "Extracted text" });

test.describe("PDF → TXT", () => {
	test("converts a poetry book and downloads the text", async ({ page }) => {
		await open(page);
		await expect(text(page)).toHaveValue(/^Lantern Weather\n\nThe ferry keeps its own small light,\n/);
		await expect(page.getByRole("radio", { name: "Poetry" })).toBeChecked();
		const value = await text(page).inputValue();
		expect(value).toContain("a coin of yellow on the tide,\nand nobody aboard is sure\n\nwhich shore");
		expect(value).toContain("The water does not.\n\n\n\nInventory\n\n");
		expect(value).toMatch(/\n {2,}The gulls have opinions\.\n/);
		expect(value).not.toMatch(/^\s*[789]\s*$/m); // page numbers removed

		const download = page.waitForEvent("download");
		await page.getByRole("button", { name: "Download TXT" }).click();
		const file = await download;
		expect(file.suggestedFilename()).toBe("poems.txt");
		expect(fs.readFileSync(await file.path(), "utf8")).toBe(value);
		await expect(page.getByText("Downloaded poems.txt")).toBeVisible();
	});

	test("links the text to the printed page", async ({ page }) => {
		await open(page);
		await expect(page.getByRole("img", { name: "Page 1" })).toBeVisible();
		// Putting the caret in a line from the third page shows that page.
		const value = await text(page).inputValue();
		const at = value.indexOf("which is this list.");
		await text(page).evaluate((el: HTMLTextAreaElement, pos) => {
			el.focus();
			el.setSelectionRange(pos, pos);
		}, at);
		await text(page).press("ArrowRight");
		await expect(page.getByRole("img", { name: "Page 3" })).toBeVisible();
		// The works menu jumps to a poem's page and selects its title.
		await page.getByRole("combobox", { name: "Go to work" }).selectOption({ label: "Inventory · p. 2" });
		await expect(page.getByRole("img", { name: "Page 2" })).toBeVisible();
		const selected = await text(page).evaluate((el: HTMLTextAreaElement) =>
			el.value.slice(el.selectionStart, el.selectionEnd),
		);
		expect(selected).toBe("Inventory");
		await page.getByRole("button", { name: "Previous page" }).click();
		await expect(page.getByRole("img", { name: "Page 1" })).toBeVisible();
	});

	test("switches to prose, and keeps edits only after asking", async ({ page }) => {
		await open(page);
		await text(page).fill("my own edit\n");
		await expect(page.getByText("· edited")).toBeVisible();
		await page.getByRole("radio", { name: "Prose" }).click({ force: true });
		await page.getByRole("dialog", { name: "Discard your edits?" }).getByRole("button", { name: "Cancel" }).click();
		await expect(page.getByRole("radio", { name: "Poetry" })).toBeChecked();
		await expect(text(page)).toHaveValue("my own edit\n");
		await page.getByRole("radio", { name: "Prose" }).click({ force: true });
		await page
			.getByRole("dialog", { name: "Discard your edits?" })
			.getByRole("button", { name: "Discard edits" })
			.click();
		await expect(page.getByRole("radio", { name: "Prose" })).toBeChecked();
		// Prose joins printed lines into sentences, one per line.
		await expect(text(page)).toHaveValue(
			/The ferry keeps its own small light, a coin of yellow on the tide, and nobody aboard is sure which shore they meant to leave behind\.\n/,
		);
	});

	test("on a wide screen, header, title and workspace share one wide column", async ({ browser }) => {
		const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
		await page.goto("/pdf-txt");
		const idle = await page.locator("main").boundingBox();
		expect(idle?.width).toBe(960);
		await open(page);
		await expect(text(page)).toHaveValue(/^Lantern Weather/);
		const left = async (loc: ReturnType<Page["locator"]>) => Math.round((await loc.first().boundingBox())?.x ?? -1);
		const card = page.locator("main [class*=_wide_]");
		const edge = await left(card);
		expect(await left(page.locator("header a").first())).toBe(edge);
		expect(await left(page.getByRole("heading", { level: 1 }))).toBe(edge);
		expect((await card.boundingBox())?.width).toBeGreaterThan(1400);
		expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
		await page.context().close();
	});

	test("rejects files that aren't PDFs", async ({ page }) => {
		await open(page, { name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("just text") } as never);
		await expect(page.getByText("This doesn't look like a PDF file.")).toBeVisible();
	});
});
