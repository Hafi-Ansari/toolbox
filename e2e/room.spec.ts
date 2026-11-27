// Two browser contexts stand in for two devices. The preview server answers /api/rooms with the
// in-memory store (scripts/api-dev.ts), so this never touches the real database.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { type Browser, expect, type Page, test } from "@playwright/test";

const errors: string[] = [];
/** Console errors a test expects (the browser logs every 4xx it receives). */
let expectedErrors: RegExp | null = null;

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
	expectedErrors = null;
});

test.afterEach(() => {
	expect(
		errors.filter((e) => !expectedErrors?.test(e)),
		"no console errors",
	).toEqual([]);
});

/** Bytes that differ everywhere, so a misplaced chunk can't go unnoticed. */
function generated(size: number, seed: number): Buffer {
	const out = Buffer.alloc(size);
	let x = seed;
	for (let i = 0; i < size; i++) {
		x = (x * 1103515245 + 12345) >>> 0;
		out[i] = x >>> 24;
	}
	return out;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const files = (page: Page) => page.getByRole("list", { name: "Files in this room" });
const addFiles = (page: Page, ...list: { name: string; buffer: Buffer }[]) =>
	page
		.getByLabel("Add files")
		.setInputFiles(list.map((f) => ({ name: f.name, mimeType: "application/octet-stream", buffer: f.buffer })));

async function joinRoom(page: Page, name: string) {
	const tile = page.getByRole("button", { name: new RegExp(name) });
	await expect(tile).toBeVisible({ timeout: 10_000 });
	await tile.click();
	await expect(text(page)).toBeEnabled();
}

async function downloaded(page: Page, fileName: string): Promise<{ name: string; bytes: Buffer }> {
	const [download] = await Promise.all([
		page.waitForEvent("download"),
		page.getByRole("button", { name: `Download ${fileName}` }).click(),
	]);
	const path = await download.path();
	return { name: download.suggestedFilename(), bytes: fs.readFileSync(path) };
}

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

test.describe("Shared room files", () => {
	test("a file from the laptop downloads byte-for-byte on the phone, and a delete reaches both", async ({
		browser,
	}) => {
		const laptop = await device(browser);
		const name = await makeRoom(laptop);
		const phone = await device(browser, true);
		await joinRoom(phone, name);
		await expect(phone.getByText("anyone on the site can open this room and download them")).toBeVisible();

		// Three chunks, the last one short.
		const data = generated(2 * 2 * 1024 * 1024 + 12_345, 7);
		await addFiles(laptop, { name: "Résumé ‮gpj.exe", buffer: data });
		await expect(files(laptop).getByText("Résumé gpj.exe")).toBeVisible({ timeout: 15_000 });
		await expect(laptop.getByText(/^4 MB of 40 MB used$/)).toBeVisible();

		// The phone learns about it from its room poll.
		const row = files(phone).getByRole("listitem").filter({ hasText: "Résumé gpj.exe" });
		await expect(row.getByRole("button", { name: /^Download/ })).toBeVisible({ timeout: 8000 });
		await expect(row).toContainText("4 MB");
		const got = await downloaded(phone, "Résumé gpj.exe");
		expect(got.name).toBe("Résumé gpj.exe");
		expect(got.bytes.length).toBe(data.length);
		expect(sha(got.bytes)).toBe(sha(data));

		// And back: the phone uploads, the laptop downloads.
		const small = generated(5000, 9);
		await addFiles(phone, { name: "from-phone.bin", buffer: small });
		await expect(files(laptop).getByRole("button", { name: "Download from-phone.bin" })).toBeVisible({ timeout: 8000 });
		expect(sha((await downloaded(laptop, "from-phone.bin")).bytes)).toBe(sha(small));

		await phone.getByRole("button", { name: "Delete Résumé gpj.exe" }).click();
		await expect(files(laptop).getByText("Résumé gpj.exe")).toHaveCount(0, { timeout: 8000 });
		await expect(files(phone).getByText("Résumé gpj.exe")).toHaveCount(0);
		await expect(laptop.getByText(/^4\.9 KB of 40 MB used$/)).toBeVisible();
	});

	test("files dropped or pasted on the room are shared", async ({ browser }) => {
		const laptop = await device(browser);
		await makeRoom(laptop);
		const send = (type: "drop" | "paste", name: string) =>
			laptop.evaluate(
				([type, name]) => {
					const dt = new DataTransfer();
					dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], name));
					const target = document.querySelector("section[aria-label=Files]") as HTMLElement;
					if (type === "paste") target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
					else
						for (const t of ["dragenter", "dragover", "drop"])
							target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
				},
				[type, name] as const,
			);
		await send("drop", "dropped.txt");
		await expect(files(laptop).getByRole("button", { name: "Download dropped.txt" })).toBeVisible({ timeout: 8000 });
		await send("paste", "pasted.txt");
		await expect(files(laptop).getByRole("button", { name: "Download pasted.txt" })).toBeVisible({ timeout: 8000 });
	});

	test("ending the room deletes its files", async ({ browser, request }) => {
		const owner = await device(browser);
		const name = await makeRoom(owner);
		const guest = await device(browser, true);
		await joinRoom(guest, name);
		await addFiles(owner, { name: "doomed.bin", buffer: generated(3000, 3) });
		await expect(files(guest).getByRole("button", { name: "Download doomed.bin" })).toBeVisible({ timeout: 8000 });
		const id = new URL(owner.url()).searchParams.get("r");

		owner.once("dialog", (d) => d.accept());
		await owner.getByRole("button", { name: "End room" }).click();
		await expect(guest.getByText("This room has ended")).toBeVisible({ timeout: 8000 });
		await expect(guest.getByText("The text and files are gone.")).toBeVisible();
		expect(await (await request.get(`/api/rooms?id=${id}&files=1`)).json()).toEqual({ gone: true });
	});

	test("limits are explained: per file, and per room", async ({ browser }) => {
		test.setTimeout(120_000);
		expectedErrors = /status of 413/;
		const page = await device(browser);
		await makeRoom(page);
		await addFiles(page, { name: "huge.bin", buffer: Buffer.alloc(20 * 1024 * 1024 + 1) });
		await expect(page.getByRole("alert")).toContainText("“huge.bin” is over the 20 MB limit per file.");

		const max = generated(20 * 1024 * 1024, 5);
		await addFiles(
			page,
			{ name: "a.bin", buffer: max },
			{ name: "b.bin", buffer: max },
			{ name: "c.txt", buffer: Buffer.from("one more") },
		);
		await expect(page.getByRole("alert")).toContainText("“c.txt” doesn't fit: this room's files are limited to 40 MB", {
			timeout: 60_000,
		});
		await expect(files(page).getByRole("button", { name: /^Download/ })).toHaveCount(2);
		await expect(page.getByText(/^40 MB of 40 MB used$/)).toBeVisible();
	});
});
