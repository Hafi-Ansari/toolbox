import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import * as mupdf from "mupdf";
import { readForm } from "../src/tools/pdf-edit/formFill.ts";

function watch(page: Page) {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	return errors;
}

async function open(page: Page, file = "out/form.pdf") {
	await page.addInitScript(() => {
		Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
	});
	await page.goto("/pdf-edit");
	await page.locator('input[type="file"]').first().setInputFiles(file);
	await expect(page.getByRole("tablist", { name: "Editor view" })).toBeVisible();
}

const panel = (page: Page) => page.getByRole("region", { name: "Form fields" });
const surface = (page: Page) => page.getByTestId("pdf-edit-page");

async function download(page: Page) {
	const pending = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download PDF" }).click();
	const artifact = await pending;
	expect(artifact.suggestedFilename()).toBe("form (edited).pdf");
	const file = await artifact.path();
	if (!file) throw new Error("No file was downloaded.");
	return new mupdf.PDFDocument(readFileSync(file));
}

function pageText(pdf: mupdf.PDFDocument) {
	const page = pdf.loadPage(0);
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
	await page.screenshot({ path: path.join(dest, `${browser}-${name}.png`), fullPage: true });
}

test.use({ viewport: { width: 1440, height: 1000 } });

test("fills text, check box, radio, choice and signature fields; keeps them fillable or flattens them", async ({
	page,
	browserName,
}) => {
	const errors = watch(page);
	await open(page);
	await expect(page.getByRole("tab", { name: "Fill form" })).toHaveAttribute("aria-selected", "true");
	const form = panel(page);
	await expect(form.getByRole("textbox", { name: "Full name" })).toBeVisible();
	await expect(form.getByRole("textbox", { name: /^ref/ })).toBeDisabled();

	// Clicking a highlighted field on the page focuses it in the list.
	await surface(page).getByRole("button", { name: "Full name field on the page" }).click();
	await expect(form.getByRole("textbox", { name: "Full name" })).toBeFocused();

	// A required field left empty is flagged before download.
	await page.getByRole("button", { name: "Download PDF" }).click();
	await expect(page.getByRole("alert")).toContainText("A required field is empty: Full name");
	await expect(form.getByRole("textbox", { name: "Full name" })).toHaveAttribute("aria-invalid", "true");
	await expect(surface(page).getByRole("button", { name: "Full name field on the page" })).toHaveAttribute(
		"data-missing",
		"true",
	);

	await form.getByRole("textbox", { name: "Full name" }).fill("Ada Lovelace");
	const notes = form.getByRole("textbox", { name: /^notes/ });
	await notes.fill(`Two lines\nof notes ${"x".repeat(40)}`);
	await expect(notes).toHaveValue(`Two lines\nof notes ${"x".repeat(21)}`);
	await expect(form.getByText("40 / 40 characters")).toBeVisible();
	await notes.fill("Two lines\nof notes");
	await form.getByRole("checkbox", { name: "I agree" }).check();
	await form.getByRole("radio", { name: "large" }).check();
	await form.getByRole("combobox", { name: /^colour/ }).selectOption("Blue");
	await form.getByRole("combobox", { name: /^Fruit/ }).selectOption({ label: "Pear" });
	await expect(surface(page).getByRole("button", { name: "Full name field on the page" })).toHaveText("Ada Lovelace");
	await expect(surface(page).getByRole("button", { name: "I agree field on the page" })).toHaveText("✓");

	await form.getByRole("button", { name: "Sign here" }).click();
	const dialog = page.getByRole("dialog", { name: "Add signature" });
	await dialog.getByRole("button", { name: "Type", exact: true }).click();
	await dialog.getByLabel("Signature text").fill("Ada L");
	await dialog.getByRole("button", { name: "Use signature", exact: true }).click();
	const signature = surface(page).getByRole("button", { name: "Signature, page 1", exact: true });
	await expect(signature).toBeVisible();
	const box = await signature.boundingBox();
	const field = await surface(page).getByRole("button", { name: "Signature field on the page" }).boundingBox();
	if (!box || !field) throw new Error("The signature is hidden.");
	expect(box.x).toBeGreaterThanOrEqual(field.x - 1);
	expect(box.x + box.width).toBeLessThanOrEqual(field.x + field.width + 1);
	expect(box.y).toBeGreaterThanOrEqual(field.y - 1);
	expect(box.y + box.height).toBeLessThanOrEqual(field.y + field.height + 1);
	await expect(form.getByRole("button", { name: "Replace signature" })).toBeVisible();
	await screenshot(page, "form-desktop", browserName === "chromium" ? "edge" : browserName);

	const fillable = await download(page);
	try {
		const values = Object.fromEntries(readForm(fillable).fields.map((entry) => [entry.name, entry.value]));
		expect(values).toEqual({
			name: "Ada Lovelace",
			notes: "Two lines\nof notes",
			agree: "Yes",
			size: "large",
			colour: "Blue",
			fruit: "p",
			ref: "FIXED-7",
			signature: "",
		});
		expect(pageText(fillable)).toContain("Ada L");
	} finally {
		fillable.destroy();
	}

	await page.getByRole("radio", { name: "Flatten form" }).check();
	const flat = await download(page);
	try {
		expect(readForm(flat).fields).toEqual([]);
		const loaded = flat.loadPage(0);
		expect(loaded.getWidgets()).toHaveLength(0);
		loaded.destroy();
		const text = pageText(flat);
		for (const value of ["Ada Lovelace", "Two lines", "of notes", "Blue", "FIXED-7", "Ada L"])
			expect(text).toContain(value);
	} finally {
		flat.destroy();
	}
	expect(errors).toEqual([]);
});

test("says that XFA-only forms can't be filled", async ({ page }) => {
	const errors = watch(page);
	await open(page, "out/xfa.pdf");
	await expect(page.getByText("This PDF is a dynamic XFA form.")).toBeVisible();
	await expect(page.getByRole("tab", { name: "Fill form" })).toHaveCount(0);
	await expect(page.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");
	expect(errors).toEqual([]);
});

test.describe("390px mobile with touch", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

	test("fills the form from the list below the page", async ({ page, browserName }) => {
		const errors = watch(page);
		await open(page);
		const form = panel(page);
		await form.getByRole("textbox", { name: "Full name" }).fill("Ada Lovelace");
		await form.getByRole("checkbox", { name: "I agree" }).tap();
		await expect(form.getByRole("checkbox", { name: "I agree" })).toBeChecked();
		await form.getByRole("radio", { name: "small" }).tap();
		await expect(surface(page).getByRole("button", { name: "Full name field on the page" })).toHaveText("Ada Lovelace");
		await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
		await screenshot(page, "form-mobile", browserName === "chromium" ? "edge" : browserName);
		const fillable = await download(page);
		const values = Object.fromEntries(readForm(fillable).fields.map((entry) => [entry.name, entry.value]));
		expect(values).toMatchObject({ name: "Ada Lovelace", agree: "Yes", size: "small" });
		fillable.destroy();
		expect(errors).toEqual([]);
	});
});
