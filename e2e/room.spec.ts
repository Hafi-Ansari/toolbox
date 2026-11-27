// Two browser contexts stand in for two devices. The preview server answers /api/rooms with the
// in-memory store (scripts/api-dev.ts), so this never touches the real database.
import { type Browser, expect, type Page, test } from "@playwright/test";

const errors: string[] = [];

async function device(browser: Browser, phone = false): Promise<Page> {
	const ctx = await browser.newContext(
		phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : {},
	);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
	await page.goto("/room");
	await expect(page.getByRole("heading", { name: "Shared room" })).toBeVisible();
	return page;
}

const text = (page: Page) => page.getByRole("textbox", { name: "Shared text" });

async function makeRoom(page: Page): Promise<string> {
	await page.getByRole("button", { name: "New room" }).click();
	await expect(text(page)).toBeEnabled();
	const name = (await page.locator("[class*=roomName]").innerText())
		.replace(/Yours$/, "")
		.replace(/^\S+\s/, "")
		.trim();
	expect(name).toMatch(/^\w+ \w+$/);
	return name;
}

test.beforeEach(() => {
	errors.length = 0;
});

test.afterEach(() => {
	expect(errors, "no console errors").toEqual([]);
});

test.describe("Shared room", () => {
	test("text typed on one device shows up on the other, both ways", async ({ browser }) => {
		const laptop = await device(browser);
		const name = await makeRoom(laptop);
		await text(laptop).fill("https://example.com/from-laptop and some notes");

		const phone = await device(browser, true);
		const tile = phone.getByRole("button", { name: new RegExp(name) });
		await expect(tile).toBeVisible({ timeout: 10_000 });
		await tile.click();
		await expect(text(phone)).toHaveValue("https://example.com/from-laptop and some notes", { timeout: 5000 });
		await expect(phone.getByRole("link", { name: "https://example.com/from-laptop" })).toBeVisible();
		await expect(phone.getByText("Yours")).toHaveCount(0);

		await text(phone).fill("reply from the phone");
		await expect(text(laptop)).toHaveValue("reply from the phone", { timeout: 6000 });
		await expect(laptop.getByRole("status")).toHaveText("Synced");

		// The room survives the owner reloading the page.
		await laptop.reload();
		await expect(text(laptop)).toHaveValue("reply from the phone", { timeout: 6000 });
		await expect(laptop.getByText("Yours")).toBeVisible();
	});

	test("ending the room takes it away from everyone", async ({ browser }) => {
		const owner = await device(browser);
		const name = await makeRoom(owner);
		const guest = await device(browser);
		await guest.getByRole("button", { name: new RegExp(name) }).click();
		await expect(text(guest)).toBeEnabled();

		owner.once("dialog", (d) => d.accept());
		await owner.getByRole("button", { name: "End room" }).click();
		await expect(owner.getByRole("button", { name: "New room" })).toBeVisible();
		await expect(guest.getByText("This room has ended")).toBeVisible({ timeout: 8000 });
		await guest.getByRole("button", { name: "All rooms" }).click();
		await expect(guest.getByRole("button", { name: new RegExp(name) })).toHaveCount(0);
	});

	test("the room ends soon after its owner closes the page", async ({ browser }) => {
		test.setTimeout(60_000);
		const owner = await device(browser);
		const name = await makeRoom(owner);
		const guest = await device(browser);
		await guest.getByRole("button", { name: new RegExp(name) }).click();
		await expect(text(guest)).toBeEnabled();

		await owner.close({ runBeforeUnload: true });
		// The owner's page sent "leave" as it closed; the room ends about 15 s later.
		await expect(guest.getByText("This room has ended")).toBeVisible({ timeout: 30_000 });
	});
});
