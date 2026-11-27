import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type BrowserContext, type Download, expect, type Locator, type Page, test } from "@playwright/test";
import { unzipSync } from "fflate";
import * as mupdf from "mupdf";

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
	await page.locator('input[type="file"]').first().setInputFiles(file);
	await expect(page.getByRole("tablist", { name: "Editor view" })).toBeVisible();
}

const surface = (page: Page) => page.getByTestId("pdf-edit-page");
const tools = (page: Page) => page.getByRole("group", { name: "Editing tools" });
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const actions = (page: Page) => page.getByRole("toolbar", { name: "Page actions" });
const action = (page: Page, name: string) => actions(page).getByRole("button", { name, exact: true });
const cards = (page: Page) => page.getByRole("list", { name: "Pages in order" }).getByRole("listitem");
const card = (page: Page, number: number) => cards(page).nth(number - 1);

async function click(page: Page, x: number, y: number) {
	const rect = await surface(page).boundingBox();
	if (!rect) throw new Error("The page is hidden.");
	await surface(page).click({ position: { x: x * rect.width, y: y * rect.height } });
}

async function rendered(page: Page, index: number) {
	const image = page.getByRole("region", { name: "PDF page editor" }).getByRole("img", { name: `Page ${index}` });
	await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
}

async function addText(page: Page, text: string, x: number, y: number) {
	await tools(page).getByRole("button", { name: "Text", exact: true }).click();
	await click(page, x, y);
	await page.getByRole("textbox", { name: "Edit text" }).fill(text);
	await page.getByRole("button", { name: "Done editing" }).click();
}

/** The card labels, which name the page number, source file and added rotation. */
async function order(page: Page) {
	return cards(page)
		.getByRole("button", { name: /^Page \d+/ })
		.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
}

function pdfFrom(bytes: Uint8Array) {
	return new mupdf.PDFDocument(bytes.slice());
}

async function downloaded(download: Download) {
	const file = await download.path();
	if (!file) throw new Error("No file was downloaded.");
	return new Uint8Array(readFileSync(file));
}

function pageText(pdf: mupdf.PDFDocument, index: number) {
	const page = pdf.loadPage(index);
	const structured = page.toStructuredText("");
	try {
		return structured.asText();
	} finally {
		structured.destroy();
		page.destroy();
	}
}

function summary(pdf: mupdf.PDFDocument) {
	return Array.from({ length: pdf.countPages() }, (_, i) => {
		const text = pageText(pdf, i);
		const title = ["Field Notes", "Route Sketch", "Checklist", "Appendix 1", "Appendix 2"].find((t) =>
			text.includes(t),
		);
		return `${title}@${pdf.findPage(i).getInheritable("Rotate").asNumber()}`;
	});
}

async function screenshot(page: Page, name: string, browser: string) {
	const dest = process.env.PDF_EDIT_SCREENSHOTS;
	if (!dest) return;
	mkdirSync(dest, { recursive: true });
	await page.screenshot({ path: path.join(dest, `${browser}-${name}.png`), fullPage: true });
}

async function mouseDrag(page: Page, from: Locator, to: Locator, toX: number) {
	const a = await from.boundingBox();
	const b = await to.boundingBox();
	if (!a || !b) throw new Error("The pages are hidden.");
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
	await page.mouse.down();
	await page.mouse.move(b.x + b.width * toX, b.y + b.height / 2, { steps: 12 });
	await page.mouse.up();
}

test.use({ viewport: { width: 1440, height: 1000 } });

test("merges, reorders, rotates, deletes and duplicates pages; items follow their pages", async ({
	page,
	browserName,
}) => {
	const errors = watch(page);
	await open(page);
	await rendered(page, 1);
	await addText(page, "Mira margin", 0.3, 0.2);
	await page.getByRole("button", { name: "Go to page 3" }).click();
	await rendered(page, 3);
	await tools(page).getByRole("button", { name: "Check", exact: true }).click();
	await click(page, 0.5, 0.5);

	await tab(page, "Pages").click();
	await page.getByLabel("PDFs to merge").setInputFiles("out/merge.pdf");
	await expect(page.getByText("Added 2 pages from merge.pdf.")).toBeVisible();
	expect(await order(page)).toEqual([
		"Page 1, from edit.pdf",
		"Page 2, from edit.pdf",
		"Page 3, from edit.pdf",
		"Page 4, from merge.pdf",
		"Page 5, from merge.pdf",
	]);
	await expect(page.getByRole("list", { name: "Files" })).toContainText("merge.pdf");

	// The merged pages arrive selected; clear that so only the dragged page moves.
	await action(page, "Clear").click();
	// Drag "Appendix 1" in front of the first page.
	await mouseDrag(page, card(page, 4).getByRole("button", { name: /^Page 4/ }), card(page, 1), 0.2);
	expect(await order(page)).toEqual([
		"Page 1, from merge.pdf",
		"Page 2, from edit.pdf",
		"Page 3, from edit.pdf",
		"Page 4, from edit.pdf",
		"Page 5, from merge.pdf",
	]);
	await expect(card(page, 2)).toContainText("✎1");

	await card(page, 2)
		.getByRole("button", { name: /^Page 2/ })
		.click();
	await action(page, "Rotate right").click();
	await expect(card(page, 2).getByRole("button", { name: /^Page 2/ })).toHaveAccessibleName(
		"Page 2, from edit.pdf, turned 90°",
	);
	await card(page, 3)
		.getByRole("button", { name: /^Page 3/ })
		.click();
	await action(page, "Delete").click();
	await expect(cards(page)).toHaveCount(4);
	await page.getByRole("button", { name: "Undo", exact: true }).click();
	await expect(cards(page)).toHaveCount(5);
	await page.getByRole("button", { name: "Redo", exact: true }).click();
	await expect(cards(page)).toHaveCount(4);

	// Keyboard path: select with the checkbox, then Move left / Move right.
	await card(page, 4).getByRole("checkbox").check();
	await action(page, "Move left").click();
	await action(page, "Move right").click();
	await action(page, "Duplicate").click();
	await expect(cards(page)).toHaveCount(5);
	await screenshot(page, "pages-desktop", browserName === "chromium" ? "edge" : browserName);

	const flatPending = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download PDF" }).click();
	const flat = pdfFrom(await downloaded(await flatPending));
	try {
		expect(summary(flat)).toEqual([
			"Appendix 1@0",
			"Field Notes@90",
			"Checklist@0",
			"Appendix 2@270",
			"Appendix 2@270",
		]);
		expect(pageText(flat, 1)).toContain("Mira margin");
		expect(pageText(flat, 0)).not.toContain("Mira margin");
	} finally {
		flat.destroy();
	}

	await page.getByRole("radio", { name: "Keep as editable annotations" }).check();
	const editPending = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download PDF" }).click();
	const editable = pdfFrom(await downloaded(await editPending));
	try {
		const kinds = Array.from({ length: 5 }, (_, i) => {
			const list: string[] = [];
			editable
				.findPage(i)
				.get("Annots")
				.forEach((annot) => {
					list.push(annot.get("Subtype").asName());
				});
			return list;
		});
		expect(kinds).toEqual([[], ["FreeText"], ["Ink"], [], []]);
		expect(editable.findPage(1).get("Annots", 0, "Contents").asString()).toBe("Mira margin");
	} finally {
		editable.destroy();
	}

	// Split into ranges, as one .zip.
	await page.getByRole("textbox", { name: "Ranges" }).fill("1-2, 3-5");
	const zipPending = page.waitForEvent("download");
	await page.getByRole("button", { name: "Split PDF" }).click();
	const zip = await zipPending;
	expect(zip.suggestedFilename()).toBe("edit (split).zip");
	const entries = unzipSync(await downloaded(zip));
	expect(Object.keys(entries)).toEqual(["edit (pages 1-2).pdf", "edit (pages 3-5).pdf"]);
	const first = pdfFrom(entries["edit (pages 1-2).pdf"]);
	const second = pdfFrom(entries["edit (pages 3-5).pdf"]);
	expect(summary(first)).toEqual(["Appendix 1@0", "Field Notes@90"]);
	expect(first.findPage(1).get("Annots", 0, "Contents").asString()).toBe("Mira margin");
	expect(summary(second)).toEqual(["Checklist@0", "Appendix 2@270", "Appendix 2@270"]);
	first.destroy();
	second.destroy();

	// Every 2 pages, as separate PDFs.
	await page.getByRole("radio", { name: "Every N pages" }).check();
	await page.getByLabel("Pages per file").fill("2");
	await page.getByRole("radio", { name: "Separate PDFs" }).check();
	const files: Download[] = [];
	const collect = (download: Download) => files.push(download);
	page.on("download", collect);
	await page.getByRole("button", { name: "Split PDF" }).click();
	await expect.poll(() => files.length).toBe(3);
	page.off("download", collect);
	expect(files.map((file) => file.suggestedFilename())).toEqual([
		"edit (pages 1-2).pdf",
		"edit (pages 3-4).pdf",
		"edit (page 5).pdf",
	]);
	const last = pdfFrom(await downloaded(files[2]));
	expect(summary(last)).toEqual(["Appendix 2@270"]);
	last.destroy();

	// Extract the selection.
	await page.getByRole("button", { name: "Clear", exact: true }).click();
	await card(page, 3).getByRole("checkbox").check();
	const extractPending = page.waitForEvent("download");
	await page.getByRole("button", { name: "Extract 1 selected page" }).click();
	const extracted = await extractPending;
	expect(extracted.suggestedFilename()).toBe("edit (page 3).pdf");
	const single = pdfFrom(await downloaded(extracted));
	expect(summary(single)).toEqual(["Checklist@0"]);
	expect(single.findPage(0).get("Annots", 0, "Subtype").asName()).toBe("Ink");
	single.destroy();

	// The edit view shows the turned page with its note, and source badges on thumbnails.
	await card(page, 2)
		.getByRole("button", { name: /^Page 2/ })
		.dblclick();
	await expect(page.getByText("Page 2 of 5")).toBeVisible();
	await rendered(page, 2);
	await expect(surface(page).getByRole("button", { name: "Text box: Mira margin, page 2" })).toBeVisible();
	const sheet = await surface(page).boundingBox();
	if (!sheet) throw new Error("The page is hidden.");
	expect(sheet.width).toBeGreaterThan(sheet.height);
	await expect(
		page.getByRole("navigation", { name: "PDF pages" }).getByRole("img", { name: "From merge.pdf" }),
	).toHaveCount(3);
	expect(errors).toEqual([]);
});

test("asks for the password of a protected PDF being merged", async ({ page }) => {
	const errors = watch(page);
	await open(page);
	await tab(page, "Pages").click();
	await page.getByLabel("Insert pages").selectOption({ label: "After page 1" });
	await page.getByLabel("PDFs to merge").setInputFiles("out/edit-locked.pdf");
	await page.getByLabel("Password for edit-locked.pdf").fill("wrong");
	await page.getByRole("button", { name: "Unlock PDF" }).click();
	await expect(page.getByText("Incorrect PDF password")).toBeVisible();
	await page.getByLabel("Password for edit-locked.pdf").fill("paper-fox");
	await page.getByRole("button", { name: "Unlock PDF" }).click();
	await expect(page.getByText("Added 3 pages from edit-locked.pdf.")).toBeVisible();
	expect((await order(page)).map((label) => label?.replace(/^Page \d+, /, ""))).toEqual([
		"from edit.pdf",
		"from edit-locked.pdf",
		"from edit-locked.pdf",
		"from edit-locked.pdf",
		"from edit.pdf",
		"from edit.pdf",
	]);
	const pending = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download PDF" }).click();
	const pdf = pdfFrom(await downloaded(await pending));
	expect(summary(pdf)).toEqual([
		"Field Notes@0",
		"Field Notes@0",
		"Route Sketch@90",
		"Checklist@0",
		"Route Sketch@90",
		"Checklist@0",
	]);
	pdf.destroy();
	expect(errors).toEqual([]);
});

/** Drags a page card by its grip with a finger: CDP touch in Chromium, pointer events elsewhere. */
async function touchDrag(page: Page, context: BrowserContext, browserName: string, from: Locator, to: Locator) {
	const a = await from.boundingBox();
	const b = await to.boundingBox();
	if (!a || !b) throw new Error("The pages are hidden.");
	const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
	const end = { x: b.x + b.width * 0.15, y: b.y + b.height / 2 };
	if (browserName === "chromium") {
		const session = await context.newCDPSession(page);
		await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
		for (let step = 1; step <= 10; step++) {
			const x = start.x + ((end.x - start.x) * step) / 10;
			const y = start.y + ((end.y - start.y) * step) / 10;
			await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
			await new Promise((resolve) => setTimeout(resolve, 16));
		}
		await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		return;
	}
	// Playwright's WebKit driver has trusted taps but no touch-move API, so send the pointer events a finger
	// produces (pointerType "touch"), delivered to the grip as pointer capture would.
	await from.evaluate(
		async (grip, { start, end }) => {
			const send = (type: string, x: number, y: number) =>
				grip.dispatchEvent(
					new PointerEvent(type, {
						pointerId: 41,
						pointerType: "touch",
						isPrimary: true,
						button: type === "pointermove" ? -1 : 0,
						buttons: type === "pointerup" ? 0 : 1,
						clientX: x,
						clientY: y,
						bubbles: true,
						cancelable: true,
					}),
				);
			send("pointerdown", start.x, start.y);
			for (let step = 1; step <= 10; step++) {
				send("pointermove", start.x + ((end.x - start.x) * step) / 10, start.y + ((end.y - start.y) * step) / 10);
				await new Promise((resolve) => setTimeout(resolve, 16));
			}
			send("pointerup", end.x, end.y);
		},
		{ start, end },
	);
}

test.describe("390px mobile with touch", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

	test("reorders pages by dragging the grip and fits the phone width", async ({ page, context, browserName }) => {
		const errors = watch(page);
		await open(page);
		await tab(page, "Pages").tap();
		await expect(cards(page)).toHaveCount(3);
		const grip = card(page, 3).locator("[data-grip]");
		await expect(grip).toHaveCSS("touch-action", "none");
		await expect(card(page, 1).getByRole("button", { name: /^Page 1/ })).toHaveCSS("touch-action", "manipulation");
		await touchDrag(page, context, browserName, grip, card(page, 1));
		await expect
			.poll(() => cards(page).evaluateAll((list) => list.map((item) => item.getAttribute("data-page-card"))))
			.toEqual(["0:2", "0:0", "0:1"]);
		await expect(action(page, "Move left")).toBeInViewport();
		await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
		await screenshot(page, "pages-mobile", browserName === "chromium" ? "edge" : browserName);
		// Let Chromium finish the emulated touch gesture before the next tap.
		await new Promise((resolve) => setTimeout(resolve, 400));
		await page.getByRole("button", { name: "Undo", exact: true }).tap();
		await expect
			.poll(() => cards(page).evaluateAll((list) => list.map((item) => item.getAttribute("data-page-card"))))
			.toEqual(["0:0", "0:1", "0:2"]);
		expect(errors).toEqual([]);
	});
});
