import { expect, type Page, test } from "@playwright/test";

const errors: string[] = [];
const remote: string[] = [];

test.beforeEach(({ page, baseURL }) => {
	errors.length = 0;
	remote.length = 0;
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
	// OCR's files are served by the site itself: nothing may come from elsewhere.
	page.on("request", (r) => {
		const url = r.url();
		if (!url.startsWith(baseURL ?? "") && !/^(blob|data):/.test(url)) remote.push(url);
	});
});

test.afterEach(() => {
	expect(errors, "no console errors").toEqual([]);
	expect(remote, "no requests to other sites").toEqual([]);
});

async function open(page: Page, file: string) {
	await page.goto("/");
	await page.getByRole("link", { name: /PDF → TXT/ }).click();
	await expect(page.getByText("loading engine")).toBeHidden({ timeout: 30_000 });
	await page.locator('input[type="file"]').setInputFiles(file);
}

const text = (page: Page) => page.getByRole("textbox", { name: "Extracted text" });

test.describe("PDF → TXT OCR", () => {
	test("reads a scan without a text layer", async ({ page }) => {
		await open(page, "out/scan.pdf");
		await expect(page.getByText("Every page of this PDF is a scan without a text layer")).toBeVisible();
		await expect(text(page)).toHaveValue("");
		await page.getByRole("button", { name: "Run OCR on 1 scanned page" }).click();
		await expect(text(page)).toHaveValue(
			/^Inventory\n\nOne kettle, dented on the left,\ntwo letters I will never send,\na key to a house that sold in spring,\n\nthree stones from three different rivers,\neach one insisting it is the river\.\n$/,
			{ timeout: 60_000 },
		);
		await expect(page.getByText("OCR read 1 page")).toBeVisible();
		await expect(page.getByRole("button", { name: "Page 1 read by OCR" })).toBeDisabled();
		// The scan is now listed as read, not as missing.
		await page.getByText("Review", { exact: false }).first().click();
		await expect(page.getByRole("button", { name: /Read by OCR.*p\. 1/ })).toBeVisible();
		await expect(page.getByRole("button", { name: /Needs OCR/ })).toHaveCount(0);
		// Switching modes keeps the OCR text.
		await page.getByRole("radio", { name: "Prose" }).click({ force: true });
		await expect(text(page)).toHaveValue(/One kettle, dented on the left, two letters I will never send,/);
	});

	test("on a phone, OCR buttons wrap instead of widening the page", async ({ browser }) => {
		// WebKit (every iPhone browser) widened the whole page to fit a long unwrapped label
		// such as "Run OCR on the other 75 scanned pages".
		const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
		await open(page, "out/scan.pdf");
		const button = page.getByRole("button", { name: "Run OCR on 1 scanned page" });
		await expect(button).toBeVisible();
		expect(await button.evaluate((b) => getComputedStyle(b).whiteSpace)).toBe("normal");
		expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
		await page.context().close();
	});

	test("OCRs one page of a born-digital book and leaves its text alone", async ({ page }) => {
		await open(page, "out/poems.pdf");
		await expect(text(page)).toHaveValue(/^Lantern Weather\n/);
		const before = await text(page).inputValue();
		await expect(page.getByRole("button", { name: /Run OCR on/ })).toHaveCount(0);
		await page.getByRole("button", { name: "OCR page 1" }).click();
		await expect(page.getByRole("button", { name: "Page 1 read by OCR" })).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText("OCR read 1 page · it matched the text already there")).toBeVisible();
		await expect(text(page)).toHaveValue(before);
	});
});
