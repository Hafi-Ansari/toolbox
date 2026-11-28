import { expect, type Page, test } from "@playwright/test";
import { novelPdf } from "./novel.ts";

const FILE = "out/novel.pdf";
const errors: string[] = [];

test.beforeAll(() => novelPdf(FILE));

test.beforeEach(({ page }) => {
	errors.length = 0;
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
});

test.afterEach(() => {
	expect(errors, "no console errors").toEqual([]);
});

async function open(page: Page, mode: "Prose" | "Poetry") {
	await page.goto("/");
	await page.getByRole("link", { name: /PDF → TXT/ }).click();
	await expect(page.getByText("loading engine")).toBeHidden({ timeout: 30_000 });
	await page.locator('input[type="file"]').setInputFiles(FILE);
	await expect(text(page)).toHaveValue(/^One\n/);
	const radio = page.getByRole("radio", { name: mode });
	if (!(await radio.isChecked())) await radio.click({ force: true });
	await expect(radio).toBeChecked();
}

const text = (page: Page) => page.getByRole("textbox", { name: "Extracted text" });

/** Puts the caret inside the first line containing `needle`, as a click would. */
async function caretAt(page: Page, needle: string) {
	const at = (await text(page).inputValue()).indexOf(needle);
	expect(at).toBeGreaterThanOrEqual(0);
	await text(page).evaluate((el: HTMLTextAreaElement, pos) => {
		el.focus();
		el.setSelectionRange(pos, pos);
	}, at + 2);
	await text(page).press("ArrowRight");
}

const SONG =
	"Down where the water keeps its name,\nthe lanterns lean and the reeds lean too;\nnobody sleeps tonight,\n\ncarry me over, carry me through,\ncarry me home by the river light.\n";

test.describe("PDF → TXT overrides", () => {
	test("keeps a song quoted in prose line by line, across a reload, until undone", async ({ page }) => {
		await open(page, "Prose");
		await expect(text(page)).toHaveValue(/the reeds lean too; nobody sleeps tonight, carry me over/);
		const keep = page.getByRole("button", { name: "Keep printed lines" });

		// With the text edited, it asks first; declining keeps the edit.
		await caretAt(page, "Down where the water");
		await text(page).pressSequentially("!");
		await keep.click();
		await page.getByRole("dialog", { name: "Discard your edits?" }).getByRole("button", { name: "Cancel" }).click();
		await expect(text(page)).toHaveValue(/Dow!n where/);

		await keep.click();
		await page
			.getByRole("dialog", { name: "Discard your edits?" })
			.getByRole("button", { name: "Discard edits" })
			.click();
		await expect(text(page)).toHaveValue(
			new RegExp(`sing, and the cook put down his knife\\.\\n\\n${SONG}\\nWhen the song`),
		);
		await expect(page.getByText("Printed lines kept")).toBeVisible();

		// Saved for this file: a reload brings it back.
		await page.reload();
		await open(page, "Prose");
		await expect(text(page)).toHaveValue(new RegExp(SONG));

		// The caret in a kept line offers to undo it; so does the list.
		await caretAt(page, "carry me over");
		await expect(page.getByRole("button", { name: "Undo kept lines" })).toBeEnabled();
		await page.getByRole("button", { name: /^Undo: Printed lines kept/ }).click();
		await expect(text(page)).toHaveValue(/the reeds lean too; nobody sleeps tonight, carry me over/);
		await expect(page.getByText("Printed lines kept")).toBeHidden();
	});

	test("joins a possibly wrapped line from the review list, and undoes it", async ({ page }) => {
		await open(page, "Poetry");
		await expect(text(page)).toHaveValue(/against the glass as\nif it had heard\.\n/);
		const row = page.getByRole("listitem").filter({ hasText: '"if it had heard." may be its runover' });
		await row.getByRole("button", { name: "Join" }).click();
		await expect(text(page)).toHaveValue(/against the glass as if it had heard\.\n/);
		await expect(page.getByText("Lines joined")).toBeVisible();
		await page.getByRole("button", { name: /^Undo: Lines joined/ }).click();
		await expect(text(page)).toHaveValue(/against the glass as\nif it had heard\.\n/);
	});
});
