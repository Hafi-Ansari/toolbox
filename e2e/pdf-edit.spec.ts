import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import * as mupdf from "mupdf";
import { password, testImage } from "./edit-fixture.ts";

function watch(page: Page) {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	return errors;
}

async function open(page: Page, file = "out/edit.pdf") {
	await page.addInitScript(() => {
		Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
	});
	await page.goto("/pdf-edit");
	await page.locator('input[type="file"]').setInputFiles(file);
}

function surface(page: Page): Locator {
	return page.getByTestId("pdf-edit-page");
}

async function rendered(page: Page, index: number) {
	const image = page.getByRole("region", { name: "PDF page editor" }).getByRole("img", { name: `Page ${index}` });
	await expect(image).toBeVisible();
	await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
}

async function spot(element: Locator, x: number, y: number) {
	const rect = await element.boundingBox();
	if (!rect) throw new Error("The page is hidden.");
	return { x: rect.x + x * rect.width, y: rect.y + y * rect.height };
}

async function click(page: Page, x: number, y: number) {
	const rect = await surface(page).boundingBox();
	if (!rect) throw new Error("The page is hidden.");
	await surface(page).click({ position: { x: x * rect.width, y: y * rect.height } });
}

const tools = (page: Page) => page.getByRole("group", { name: "Editing tools" });
const tool = (page: Page, name: string) => tools(page).getByRole("button", { name, exact: true });

async function draw(page: Page, element: Locator, x: number, y: number, endX: number, endY: number) {
	const start = await spot(element, x, y);
	const end = await spot(element, endX, endY);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(end.x, end.y, { steps: 8 });
	await page.mouse.up();
}

async function addText(page: Page, text: string, x: number, y: number) {
	await tool(page, "Text").click();
	await click(page, x, y);
	const textbox = page.getByRole("textbox", { name: "Edit text" });
	await expect(textbox).toBeFocused();
	await textbox.fill(text);
	await page.getByRole("button", { name: "Done editing" }).click();
	await expect(
		surface(page)
			.getByRole("button", { name: `Text box: ${text}, page`, exact: false })
			.first(),
	).toBeVisible();
}

async function download(page: Page, expected = "edit (edited).pdf") {
	const pending = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download PDF" }).click();
	const artifact = await pending;
	expect(artifact.suggestedFilename()).toBe(expected);
	const file = await artifact.path();
	if (!file) throw new Error("No file was downloaded.");
	return new mupdf.PDFDocument(readFileSync(file));
}

function text(pdf: mupdf.PDFDocument, index: number) {
	const page = pdf.loadPage(index);
	const structured = page.toStructuredText("");
	try {
		return structured.asText();
	} finally {
		structured.destroy();
		page.destroy();
	}
}

async function screenshot(page: Page, name: string, browser: string) {
	const dest = process.env.PDF_EDIT_SCREENSHOTS;
	if (!dest) return;
	mkdirSync(dest, { recursive: true });
	await page.screenshot({ path: path.join(dest, `${browser}-${name}.png`) });
}

test.use({ viewport: { width: 1440, height: 1000 } });

test("places edits across pages and downloads flattened and editable PDF copies", async ({ page, browserName }) => {
	const errors = watch(page);
	await open(page);
	await rendered(page, 1);
	await addText(page, "Notes by Mira", 0.38, 0.23);
	await tool(page, "Draw").click();
	await page.getByLabel("Stroke width").selectOption("4");
	await page.getByRole("button", { name: "Blue", exact: true }).click();
	await draw(page, surface(page), 0.19, 0.34, 0.47, 0.38);
	await tool(page, "Check").click();
	await click(page, 0.72, 0.4);
	const check = surface(page).getByRole("button", { name: "Check mark, page 1", exact: true });
	await expect(check).toBeVisible();
	await tool(page, "Undo").click();
	await expect(check).toHaveCount(0);
	await tool(page, "Redo").click();
	await expect(check).toBeVisible();
	await page.getByRole("button", { name: "Go to page 2" }).click();
	await rendered(page, 2);
	await addText(page, "Čaj Ω", 0.4, 0.36);

	await tool(page, "Signature").click();
	const dialog = page.getByRole("dialog", { name: "Add signature" });
	await dialog.getByRole("button", { name: "Type", exact: true }).click();
	await dialog.getByLabel("Signature text").fill("Mira Vale");
	await dialog.getByLabel("Remember on this device").check();
	await dialog.getByRole("button", { name: "Use signature", exact: true }).click();
	await click(page, 0.68, 0.62);
	const signature = surface(page).getByRole("button", { name: "Signature, page 2", exact: true });
	await expect(signature).toBeVisible();
	await screenshot(page, "desktop", browserName === "chromium" ? "edge" : browserName);

	const flat = await download(page);
	try {
		expect(flat.countPages()).toBe(3);
		expect(text(flat, 0)).toContain("Field Notes");
		expect(text(flat, 0)).toContain("Notes by Mira");
		expect(text(flat, 1)).toContain("Route Sketch");
		expect(text(flat, 1)).toContain("Čaj Ω");
		expect(text(flat, 1)).toContain("Mira Vale");
		expect(flat.findPage(0).get("Annots").isNull()).toBe(true);
	} finally {
		flat.destroy();
	}

	await page.getByRole("radio", { name: "Keep as editable annotations" }).check();
	const editable = await download(page);
	try {
		const first = editable.findPage(0).get("Annots");
		const second = editable.loadPage(1);
		const secondAnnots = second.getObject().get("Annots");
		expect(first.length).toBe(3);
		expect(first.get(0, "Subtype").asName()).toBe("FreeText");
		expect(first.get(1, "InkList", 0).length).toBeGreaterThan(4);
		expect(first.get(2, "Subtype").asName()).toBe("Ink");
		expect(secondAnnots.length).toBe(2);
		expect(secondAnnots.get(0, "Contents").asString()).toBe("Čaj Ω");
		expect(secondAnnots.get(1, "Subtype").asName()).toBe("Stamp");
		const rect = secondAnnots.get(1, "Rect");
		const x = (rect.get(0).asNumber() + rect.get(2).asNumber()) / 2;
		const y = (rect.get(1).asNumber() + rect.get(3).asNumber()) / 2;
		const [a, b, c, d, e, f] = second.getTransform();
		const [, , w, h] = second.getBounds();
		expect(a * x + c * y + e).toBeCloseTo(w * 0.68, 0);
		expect(b * x + d * y + f).toBeCloseTo(h * 0.62, 0);
		second.destroy();
	} finally {
		editable.destroy();
	}
	expect(errors).toEqual([]);
});

test("moves and deletes with the keyboard, erases ink, and supports all signature methods and images", async ({
	page,
}) => {
	const errors = watch(page);
	await open(page);
	await rendered(page, 1);
	await addText(page, "Will be removed", 0.35, 0.24);
	const item = surface(page).getByRole("button", { name: "Text box: Will be removed, page 1", exact: true });
	const before = await item.boundingBox();
	await item.focus();
	await item.press("Shift+ArrowRight");
	expect((await item.boundingBox())?.x).toBeGreaterThan(before?.x ?? 0);
	await item.press("Enter");
	await expect(page.getByRole("textbox", { name: "Edit text" })).toBeFocused();
	await page.getByRole("textbox", { name: "Edit text" }).fill("Discard this");
	await page.keyboard.press("Escape");
	await expect(item).toBeVisible();
	await item.press("Backspace");
	await expect(item).toHaveCount(0);

	await tool(page, "Draw").click();
	await draw(page, surface(page), 0.2, 0.22, 0.44, 0.25);
	await expect(
		surface(page).getByRole("button", { name: "Ink, page 1", exact: true, includeHidden: true }),
	).toHaveCount(1);
	await tool(page, "Erase").click();
	await draw(page, surface(page), 0.34, 0.18, 0.34, 0.3);
	await expect(
		surface(page).getByRole("button", { name: "Ink, page 1", exact: true, includeHidden: true }),
	).toHaveCount(0);

	await tool(page, "Signature").click();
	const dialog = page.getByRole("dialog", { name: "Add signature" });
	const pad = dialog.getByRole("img", { name: "Signature drawing pad" });
	await draw(page, pad, 0.2, 0.48, 0.8, 0.65);
	await dialog.getByLabel("Remember on this device").check();
	await dialog.getByRole("button", { name: "Use signature", exact: true }).click();
	await click(page, 0.33, 0.3);
	await tool(page, "Signature").click();
	await expect(dialog.getByRole("button", { name: "Use saved drawn signature" })).toBeVisible();
	await dialog.getByRole("button", { name: "Remove saved signature" }).click();
	await expect(dialog.getByRole("button", { name: "Use saved drawn signature" })).toHaveCount(0);
	await dialog.getByRole("button", { name: "Upload", exact: true }).click();
	const png = { name: "made-up.png", mimeType: "image/png", buffer: Buffer.from(testImage()) };
	await dialog.getByLabel("Signature image").setInputFiles(png);
	await dialog.getByLabel("Make white transparent").check();
	await dialog.getByRole("button", { name: "Use signature", exact: true }).click();
	await click(page, 0.63, 0.3);
	await page.getByLabel("Image to place", { exact: true }).setInputFiles(png);
	await expect(tool(page, "Image")).toHaveAttribute("aria-pressed", "true");
	await click(page, 0.52, 0.49);
	await expect(surface(page).getByRole("button", { name: "Signature, page 1", exact: true })).toHaveCount(2);
	await expect(surface(page).getByRole("button", { name: "Image, page 1", exact: true })).toBeVisible();
	expect(errors).toEqual([]);
});

test("unlocks a password-protected input and keeps the password on the edited copy", async ({ page }) => {
	const errors = watch(page);
	await open(page, "out/edit-locked.pdf");
	await page.getByLabel("PDF password").fill("wrong");
	await page.getByRole("button", { name: "Unlock PDF" }).click();
	await expect(page.getByRole("alert")).toContainText("Incorrect PDF password");
	await page.getByLabel("PDF password").fill(password);
	await page.getByRole("button", { name: "Unlock PDF" }).click();
	await rendered(page, 1);
	await addText(page, "Locked lantern", 0.5, 0.32);
	const pdf = await download(page, "edit-locked (edited).pdf");
	try {
		expect(pdf.needsPassword()).toBe(true);
		expect(pdf.authenticatePassword(password)).toBeGreaterThan(0);
		expect(text(pdf, 0)).toContain("Locked lantern");
	} finally {
		pdf.destroy();
	}
	expect(errors).toEqual([]);
});

test.describe("390px mobile with touch", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

	test("draws on the page and keeps Select mode scrollable", async ({ page, context, browserName }) => {
		const errors = watch(page);
		await open(page);
		await rendered(page, 1);
		const canvas = surface(page);
		await tool(page, "Draw").tap();
		await expect(canvas).toHaveCSS("touch-action", "none");
		// Keep the drawn area clear of the fixed toolbar at the bottom of the screen.
		await canvas.evaluate((element) => element.scrollIntoView({ block: "start", behavior: "instant" }));
		const from = await spot(canvas, 0.22, 0.19);
		const to = await spot(canvas, 0.6, 0.26);
		const session = browserName === "chromium" ? await context.newCDPSession(page) : null;
		if (session) {
			await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
			for (let step = 1; step <= 8; step++) {
				const x = from.x + ((to.x - from.x) * step) / 8;
				const y = from.y + ((to.y - from.y) * step) / 8;
				await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
				await new Promise((resolve) => setTimeout(resolve, 16));
			}
			await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		} else {
			// Playwright's WebKit driver exposes trusted taps but no touch-Move API.
			await page.touchscreen.tap(from.x, from.y);
			await draw(page, canvas, 0.3, 0.23, 0.6, 0.28);
		}
		await expect(canvas.getByRole("button", { name: "Ink, page 1", exact: true, includeHidden: true })).toHaveCount(
			browserName === "chromium" ? 1 : 2,
		);
		const select = tool(page, "Select");
		if (session) {
			// Let Chromium finish the emulated gesture before starting another touch sequence.
			await new Promise((resolve) => setTimeout(resolve, 350));
			const target = await spot(select, 0.5, 0.5);
			await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [target] });
			await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		} else await select.tap();
		await expect(canvas).toHaveCSS("touch-action", "auto");
		await expect(tool(page, "Image")).toBeInViewport({ ratio: 1 });
		await screenshot(page, "mobile", browserName === "chromium" ? "edge" : browserName);
		const before = await page.evaluate(() => window.scrollY);
		const start = await spot(canvas, 0.77, 0.24);
		expect(
			await page.evaluate(
				({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[data-testid="pdf-edit-page"]')),
				start,
			),
		).toBe(true);
		if (session) {
			await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
			for (let step = 1; step <= 8; step++) {
				await session.send("Input.dispatchTouchEvent", {
					type: "touchMove",
					touchPoints: [{ x: start.x, y: start.y - step * 18 }],
				});
			}
			await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		} else {
			// The installed mobile WebKit driver has neither touch swipe nor wheel input.
			await page.evaluate(() => window.scrollBy({ top: 180, behavior: "instant" }));
		}
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
		await expect(tool(page, "Draw")).toBeInViewport();
		await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
		expect(errors).toEqual([]);
	});
});

test("on a wide screen, the site column widens to the editor so everything shares one left edge", async ({
	browser,
}) => {
	const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
	await page.goto("/pdf-edit");
	expect((await page.locator("main").boundingBox())?.width).toBe(960);
	await page.locator('input[type="file"]').setInputFiles("out/edit.pdf");
	await expect(page.getByRole("button", { name: /Download PDF/ })).toBeVisible({ timeout: 30_000 });
	const card = await page.locator("main [class*=_panel_]").first().boundingBox();
	const x = async (selector: string) => Math.round((await page.locator(selector).first().boundingBox())?.x ?? -1);
	expect(await x("header a")).toBe(Math.round(card?.x ?? 0));
	expect(await x("h1")).toBe(Math.round(card?.x ?? 0));
	expect(Math.round(card?.width ?? 0)).toBe(1340);
	expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
	await page.context().close();
});
