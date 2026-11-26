import { expect, type FrameLocator, type Page, test } from "@playwright/test";

const book = (page: Page): FrameLocator => page.frameLocator('iframe[title="Sample River Book"]');
const readout = (page: Page) => page.locator("[data-readout]");

async function openSample(page: Page) {
	await page.goto("/read");
	await expect(page.getByRole("heading", { name: "EPUB Reader" })).toBeVisible();
	await page.locator('input[type="file"]').setInputFiles("out/sample.epub");
	await expect(book(page).getByRole("heading", { name: "Chapter 1" })).toBeVisible();
	await expect(page).toHaveURL(/\/read\/[0-9a-f]{16}$/);
}

/** The "(c.p)" marker of the paragraph holding the caret at the top-left of the page. */
function anchorMarker(page: Page) {
	return page.evaluate(() => {
		const doc = (document.querySelector("iframe") as HTMLIFrameElement).contentDocument as Document;
		const cs = getComputedStyle(doc.body);
		const d = doc as Document & { caretPositionFromPoint(x: number, y: number): { offsetNode: Node } | null };
		const hit = d.caretPositionFromPoint(Number.parseFloat(cs.paddingLeft) + 2, Number.parseFloat(cs.paddingTop) + 2);
		return hit?.offsetNode.parentElement?.closest("p")?.textContent?.match(/\((\d+\.\d+)\)/)?.[1] ?? null;
	});
}

/** Markers of every paragraph with at least one line on screen. */
function visibleMarkers(page: Page) {
	return page.evaluate(() => {
		const frame = document.querySelector("iframe") as HTMLIFrameElement;
		const doc = frame.contentDocument as Document;
		const out: string[] = [];
		for (const p of Array.from(doc.querySelectorAll("p"))) {
			const onScreen = Array.from(p.getClientRects()).some(
				(r) => r.right > 0 && r.left < frame.clientWidth && r.bottom > 0 && r.top < frame.clientHeight,
			);
			const m = p.textContent?.match(/\((\d+\.\d+)\)/);
			if (onScreen && m) out.push(m[1]);
		}
		return out;
	});
}

test.describe("EPUB reader", () => {
	const errors: string[] = [];
	test.beforeEach(({ page }) => {
		errors.length = 0;
		page.on("pageerror", (e) => errors.push(e.message));
	});
	test.afterEach(() => expect(errors).toEqual([]));

	test("opens a book in dark mode and turns pages", async ({ page }) => {
		await openSample(page);
		const bg = await page.evaluate(() => {
			const doc = (document.querySelector("iframe") as HTMLIFrameElement).contentDocument as Document;
			return getComputedStyle(doc.documentElement).backgroundColor;
		});
		expect(bg).toBe("rgb(0, 30, 43)");
		await expect(readout(page)).toHaveText(/^1 \/ \d+ · \d+%$/);
		await page.keyboard.press("ArrowRight");
		await expect(readout(page)).toHaveText(/^2 \/ \d+/);
		await page.keyboard.press("ArrowLeft");
		await expect(readout(page)).toHaveText(/^1 \/ \d+/);
	});

	test("contents, font size keeps the passage, scroll mode", async ({ page }) => {
		await openSample(page);
		await page.keyboard.press("t");
		await page.getByRole("navigation", { name: "Contents" }).getByRole("button", { name: "Chapter 3" }).click();
		await expect(book(page).getByRole("heading", { name: "Chapter 3" })).toBeVisible();
		for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
		await expect(readout(page)).toHaveText(/^4 \/ \d+/);
		const before = await anchorMarker(page);
		expect(before).toMatch(/^3\./);

		await page.getByRole("button", { name: "Reading settings" }).click();
		const pagesBefore = (await readout(page).textContent())?.split(" / ")[1];
		for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Larger text" }).click();
		await expect(readout(page)).not.toHaveText(new RegExp(` / ${pagesBefore?.split(" ")[0]} `));
		// The paragraph being read stays on screen through repeated re-pagination (no drift).
		await page.waitForTimeout(600);
		expect(await visibleMarkers(page)).toContain(before);

		await page.getByRole("radio", { name: "Scroll" }).check();
		await expect(readout(page)).toHaveText(/^\d+%$/);
		await page.waitForTimeout(600);
		expect(await visibleMarkers(page)).toContain(before);
		await page.getByRole("radio", { name: "Pages" }).check();
		await page.keyboard.press("Escape");
	});

	test("remembers the book and position across reloads", async ({ page }) => {
		await openSample(page);
		await page.keyboard.press("t");
		await page.getByRole("navigation", { name: "Contents" }).getByRole("button", { name: "Chapter 2" }).click();
		await expect(book(page).getByRole("heading", { name: "Chapter 2" })).toBeVisible();
		await page.keyboard.press("ArrowRight");
		await expect(readout(page)).toHaveText(/^2 \/ /);
		const at = await readout(page).textContent();
		await page.waitForTimeout(1200); // position save is debounced
		await page.reload();
		await expect(book(page).getByText("(2.", { exact: false }).first()).toBeVisible();
		await expect(readout(page)).toHaveText(at ?? "");

		await page.keyboard.press("Escape"); // closes the book
		await expect(page).toHaveURL(/\/read$/);
		const recent = page.getByRole("region", { name: "Recent" });
		await expect(recent.getByText("Sample River Book")).toBeVisible();
		await expect(recent.getByText(/\d+%/)).toBeVisible();
		await recent.getByRole("button", { name: /^Sample River Book/ }).click();
		await expect(book(page).getByText("(2.", { exact: false }).first()).toBeVisible();
	});

	test("fixed-layout books show one page per screen", async ({ page }) => {
		await page.goto("/read");
		await page.locator('input[type="file"]').setInputFiles("out/sample.fixed.epub");
		await expect(readout(page)).toHaveText("Page 1 of 18");
		await page.keyboard.press("ArrowRight");
		await expect(readout(page)).toHaveText("Page 2 of 18");
		const fits = await page.evaluate(() => {
			const r = (document.querySelector("iframe") as HTMLIFrameElement).getBoundingClientRect();
			return r.width <= innerWidth + 1 && r.height <= innerHeight + 1;
		});
		expect(fits).toBe(true);
	});

	test("book content can't run scripts or reach the network", async ({ page }) => {
		const remote: string[] = [];
		page.on("request", (r) => {
			if (!r.url().startsWith("http://localhost") && !r.url().startsWith("blob:") && !r.url().startsWith("data:"))
				remote.push(r.url());
		});
		await page.goto("/read");
		await page.locator('input[type="file"]').setInputFiles("out/hostile.epub");
		const frame = page.frameLocator('iframe[title="Hostile Book"]');
		await expect(frame.getByText("Plain text that should render.")).toBeVisible();
		await frame.getByText("bad link").click();
		await page.waitForTimeout(500);
		expect(await page.evaluate(() => (window as unknown as { __pwned?: string }).__pwned)).toBeUndefined();
		expect(remote).toEqual([]);
		const html = await page.evaluate(
			() => ((document.querySelector("iframe") as HTMLIFrameElement).contentDocument as Document).body.innerHTML,
		);
		expect(html).not.toMatch(/<script|onerror|javascript:|tracker\.invalid/i);
	});

	test("rejects files that aren't EPUBs", async ({ page }) => {
		await page.goto("/read");
		await page.locator('input[type="file"]').setInputFiles("out/sample.pdf");
		await expect(page.getByRole("alert")).toContainText("That's a PDF");
	});
});
