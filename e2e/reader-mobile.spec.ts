// The reader's bars on a phone: a tap in the middle of the page brings them back for a few
// seconds (and a second tap puts them away), the edges turn pages, and scrolling, swiping,
// pinching or a long press never bring them up. Uses the made-up sample book (e2e/setup.ts).
import { type CDPSession, expect, type Page, test } from "@playwright/test";

const W = 390;
const H = 844;
test.use({ viewport: { width: W, height: H }, hasTouch: true, isMobile: true });

const header = (page: Page) => page.locator("header:has([aria-label='Close book'])");
const readout = (page: Page) => page.locator("[data-readout]");
const hidden = /hidden/;

async function openSample(page: Page, mode: "paged" | "scroll" = "paged") {
	await page.addInitScript((m) => localStorage.setItem("toolbox.reader.settings", JSON.stringify({ mode: m })), mode);
	await page.goto("/read");
	await page.locator('input[type="file"]').setInputFiles("out/sample.epub");
	await expect(
		page.frameLocator('iframe[title="Sample River Book"]').getByText("(1.", { exact: false }).first(),
	).toBeVisible();
	// The bars show when the book opens, then get out of the way.
	await expect(header(page)).not.toHaveClass(hidden);
	await expect(header(page)).toHaveClass(hidden, { timeout: 5000 });
}

/** A one-finger drag through CDP, so the browser sees real touch input (and scrolls natively). */
async function drag(cdp: CDPSession, from: [number, number], to: [number, number], ms = 200) {
	const steps = 10;
	await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from[0], y: from[1] }] });
	for (let i = 1; i <= steps; i++) {
		const x = from[0] + ((to[0] - from[0]) * i) / steps;
		const y = from[1] + ((to[1] - from[1]) * i) / steps;
		await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
		await new Promise((r) => setTimeout(r, ms / steps));
	}
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test.describe("EPUB reader on a phone", () => {
	const errors: string[] = [];
	test.beforeEach(({ page }) => {
		errors.length = 0;
		page.on("pageerror", (e) => errors.push(e.message));
	});
	test.afterEach(() => expect(errors).toEqual([]));

	test("a tap in the middle brings the bars back, then they hide again", async ({ page }) => {
		await openSample(page);
		await page.touchscreen.tap(W / 2, H / 2);
		await expect(header(page)).not.toHaveClass(hidden);
		await expect(page.getByRole("button", { name: "Reading settings" })).toBeVisible();
		// Still there after the desktop delay (2.6 s); gone after a few seconds.
		await page.waitForTimeout(3000);
		await expect(header(page)).not.toHaveClass(hidden);
		await expect(header(page)).toHaveClass(hidden, { timeout: 3000 });

		// A second tap while they show puts them away at once (like Books).
		await page.touchscreen.tap(W / 2, H / 2);
		await expect(header(page)).not.toHaveClass(hidden);
		await page.touchscreen.tap(W / 2, H / 2);
		await expect(header(page)).toHaveClass(hidden);
		await expect(readout(page)).toHaveText(/^1 \/ \d+/); // the middle never turns pages
	});

	test("edge taps and swipes turn pages without bringing the bars up", async ({ page }) => {
		await openSample(page);
		const cdp = await page.context().newCDPSession(page);
		await page.touchscreen.tap(W - 20, H / 2);
		await expect(readout(page)).toHaveText(/^2 \/ \d+/);
		await page.touchscreen.tap(W - 20, H / 2);
		await expect(readout(page)).toHaveText(/^3 \/ \d+/);
		await page.touchscreen.tap(20, H / 2);
		await expect(readout(page)).toHaveText(/^2 \/ \d+/);
		await drag(cdp, [300, 400], [80, 410]);
		await expect(readout(page)).toHaveText(/^3 \/ \d+/);
		await drag(cdp, [80, 400], [300, 395]);
		await expect(readout(page)).toHaveText(/^2 \/ \d+/);
		// A short vertical drag, a long press and a pinch do nothing at all.
		await drag(cdp, [W / 2, 500], [W / 2 + 4, 380]);
		await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: W / 2, y: H / 2 }] });
		await page.waitForTimeout(700);
		await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [
				{ x: 180, y: 420, id: 0 },
				{ x: 210, y: 420, id: 1 },
			],
		});
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchEnd",
			touchPoints: [],
		});
		await page.waitForTimeout(400);
		await expect(header(page)).toHaveClass(hidden);
		await expect(readout(page)).toHaveText(/^2 \/ \d+/);

		// Turning a page by touch puts the bars away.
		await page.touchscreen.tap(W / 2, H / 2);
		await expect(header(page)).not.toHaveClass(hidden);
		await page.touchscreen.tap(W - 20, H / 2);
		await expect(readout(page)).toHaveText(/^3 \/ \d+/);
		await expect(header(page)).toHaveClass(hidden);
	});

	test("scroll mode: scrolling never shows the bars, a tap anywhere does", async ({ page }) => {
		await openSample(page, "scroll");
		const cdp = await page.context().newCDPSession(page);
		await expect(readout(page)).toHaveText("0%");
		await drag(cdp, [W / 2, 700], [W / 2, 200], 250);
		await expect(readout(page)).not.toHaveText("0%");
		await expect(header(page)).toHaveClass(hidden);
		// Let the fling settle: a tap during it only stops the scrolling.
		let at = await readout(page).textContent();
		for (let still = 0; still < 3; ) {
			await page.waitForTimeout(250);
			const now = await readout(page).textContent();
			still = now === at ? still + 1 : 0;
			at = now;
		}
		// In scroll mode the edges don't turn pages: any tap toggles the bars.
		await page.touchscreen.tap(20, H / 2);
		await expect(header(page)).not.toHaveClass(hidden);
		await expect(readout(page)).toHaveText(at ?? "");
		// Scrolling while they show puts them away.
		await drag(cdp, [W / 2, 700], [W / 2, 300], 250);
		await expect(header(page)).toHaveClass(hidden);
	});

	test("the bars stay while settings or contents are open", async ({ page }) => {
		await openSample(page);
		await page.touchscreen.tap(W / 2, H / 2);
		await page.getByRole("button", { name: "Reading settings" }).tap();
		await expect(page.getByRole("button", { name: "Larger text" })).toBeVisible();
		await page.waitForTimeout(5000);
		await expect(header(page)).not.toHaveClass(hidden);
		await page.getByRole("button", { name: "Larger text" }).tap();
		await page.getByRole("button", { name: "Close settings" }).tap();
		// Once the panel closes the countdown starts again.
		await expect(header(page)).toHaveClass(hidden, { timeout: 6000 });

		await page.touchscreen.tap(W / 2, H / 2);
		await page.getByRole("button", { name: "Contents" }).tap();
		const nav = page.getByRole("navigation", { name: "Contents" });
		await expect(nav).toBeVisible();
		await page.waitForTimeout(5000);
		await expect(header(page)).not.toHaveClass(hidden);
		await nav.getByRole("button", { name: "Chapter 2" }).tap();
		await expect(
			page.frameLocator('iframe[title="Sample River Book"]').getByRole("heading", { name: "Chapter 2" }),
		).toBeVisible();
		await expect(header(page)).toHaveClass(hidden, { timeout: 6000 });
	});
});

test.describe("EPUB reader bars on desktop", () => {
	test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });

	test("mouse movement shows the bars, a click in the middle hides them, keyboard focus brings them back", async ({
		page,
	}) => {
		await page.goto("/read");
		await page.locator('input[type="file"]').setInputFiles("out/sample.epub");
		await expect(header(page)).toHaveClass(hidden, { timeout: 5000 });
		await page.mouse.move(640, 400);
		await page.mouse.move(650, 420);
		await expect(header(page)).not.toHaveClass(hidden);
		await expect(header(page)).toHaveClass(hidden, { timeout: 4000 });
		// Hovering the bar keeps it.
		await page.mouse.move(640, 20);
		await page.waitForTimeout(300);
		await page.mouse.move(642, 22); // it takes pointer events again once shown
		await page.waitForTimeout(3500);
		await expect(header(page)).not.toHaveClass(hidden);
		// A click in the middle of the page toggles them off, as before.
		await page.mouse.click(640, 400);
		await expect(header(page)).toHaveClass(hidden);
		await expect(readout(page)).toHaveText(/^1 \/ \d+/);

		// Tabbing into a hidden bar shows it and keeps it while focus stays there.
		const focusedBar = () =>
			page.evaluate(() => {
				const bar = document.activeElement?.closest("header, footer");
				return bar?.querySelector("[aria-label='Close book'], [aria-label='Position in book']") ? bar.tagName : null;
			});
		for (let i = 0; i < 12 && !(await focusedBar()); i++) await page.keyboard.press("Tab");
		const tag = await focusedBar();
		expect(tag).not.toBeNull();
		const bar = page.locator(`${tag?.toLowerCase()}:has([aria-label='Close book'], [aria-label='Position in book'])`);
		await expect(bar).not.toHaveClass(hidden);
		await page.waitForTimeout(3500);
		await expect(bar).not.toHaveClass(hidden);
	});
});
