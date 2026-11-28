// File Transfer UI (WP5) against the mocks in src/tools/file-transfer/mock.ts: no server, no WebRTC.
// The real two-browser flows are e2e/file-transfer.spec.ts (WP6).
import { expect, type Page, test } from "@playwright/test";

const errors: string[] = [];

async function open(page: Page, query = "") {
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
	await page.addInitScript(() => {
		window.__ftUseMock = true;
		if (!localStorage.getItem("toolbox.send.mock"))
			localStorage.setItem(
				"toolbox.send.mock",
				JSON.stringify({ id: "f00dfeedf00dfeed", name: "Brisk Fox", emoji: "🦊", hidden: false }),
			);
	});
	await page.goto(`/file-transfer${query}`);
	await expect(page.getByRole("heading", { name: "Blazing Fast File Transfer" })).toBeVisible();
	await expect(page.getByText("You're Brisk Fox")).toBeVisible();
}

async function connect(page: Page) {
	await page.evaluate(() => {
		const m = window.__ftMock;
		if (!m) throw new Error("no mock");
		m.options.connectMs = 200;
		m.incoming();
	});
	const dialog = page.getByRole("alertdialog");
	await expect(dialog).toContainText("Calm Otter wants to connect");
	await expect(dialog.getByRole("button", { name: "Accept" })).toBeFocused();
	await dialog.getByRole("button", { name: "Accept" }).click();
	await expect(page.getByText("Connected to Calm Otter")).toBeVisible();
	await expect(page.getByText("Direct · same network · 6 lanes")).toBeVisible();
}

test.beforeEach(() => {
	errors.length = 0;
});
test.afterEach(() => expect(errors, "no console errors").toEqual([]));

test("lobby: peers, busy tiles, name editing, hidden switch", async ({ page }) => {
	await open(page);
	const grid = page.getByRole("list", { name: "People on this page" });
	await expect(grid.getByRole("button", { name: /^Calm Otter, same network/ })).toBeVisible();
	await expect(grid.getByRole("button", { name: /Sunny Panda.*in a transfer/ })).toHaveAttribute(
		"aria-disabled",
		"true",
	);

	await page.getByRole("button", { name: "Edit name" }).click();
	await page.getByRole("textbox", { name: "Your name" }).fill("Quiet Owl");
	await page.getByRole("radio", { name: "🦉" }).check({ force: true });
	await page.getByRole("textbox", { name: "Your name" }).press("Enter");
	await expect(page.getByText("You're Quiet Owl")).toBeVisible();
	await page.reload();
	await expect(page.getByText("You're Quiet Owl")).toBeVisible();

	const sw = page.getByRole("switch");
	await expect(sw).toHaveAttribute("aria-checked", "true");
	await sw.click();
	await expect(sw).toHaveAttribute("aria-checked", "false");
	await expect(page.getByText("Others can't see you.")).toBeVisible();
});

test("requests: asking, cancel, decline, empty grid and invite links", async ({ page }) => {
	await open(page);
	await page.evaluate(() => {
		if (window.__ftMock) window.__ftMock.options.answerMs = 60_000;
	});
	await page.getByRole("button", { name: /^Calm Otter/ }).click();
	await expect(page.getByText("Asking Calm Otter…")).toBeVisible();
	await page.getByRole("button", { name: "Cancel" }).click();
	await expect(page.getByText("Asking Calm Otter…")).toHaveCount(0);

	await page.evaluate(() => {
		if (window.__ftMock) window.__ftMock.options.answerMs = 100;
	});
	await page.getByRole("button", { name: /^Rapid Koala/ }).click();
	await expect(page.getByText("Rapid Koala declined.")).toBeVisible();

	await page.goto("/file-transfer?mock=empty");
	await expect(page.getByText("No one else is here yet")).toBeVisible();

	await page.goto("/file-transfer?to=a1b2c3d4e5f60718");
	await expect(page.getByRole("button", { name: "Connect to Calm Otter" })).toBeVisible();
	await page.goto("/file-transfer?to=0123456789abcdef");
	await expect(page.getByText("The person who shared this link isn't here right now.")).toBeVisible();
});

test("send: files in, waiting, progress, done", async ({ page }) => {
	await open(page);
	await connect(page);
	await page.evaluate(() => {
		if (window.__ftMock) window.__ftMock.options.remoteAcceptMs = 500;
	});
	await page
		.locator('input[type="file"]')
		.first()
		.setInputFiles([
			{ name: "a.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(1000) },
			{ name: "b.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(2000) },
		]);
	await expect(page.getByText("Waiting for Calm Otter to accept 2 files (2.9 KB)…")).toBeVisible();
	await expect(page.getByText(/^Sent 2 files \(2\.9 KB\) in/)).toBeVisible();
});

test("receive: offer card, accept as zip, cancel asks first, connection lost", async ({ page }) => {
	await open(page);
	await connect(page);
	await page.evaluate(() => window.__ftMock?.offer({ count: 214, total: 38.4 * 1024 ** 3 }));
	await expect(page.getByText("Calm Otter is sending 214 files")).toBeVisible();
	await expect(page.getByText("Saves as one .zip in your downloads: Photos from Calm Otter.zip")).toBeVisible();
	await page.getByRole("button", { name: "Accept" }).click();
	await expect(page.getByText("Receiving from Calm Otter", { exact: true })).toBeVisible();
	await expect(page.getByRole("progressbar")).toBeVisible();
	await expect(page.getByText("Keep this tab open until the transfer finishes.")).toBeVisible();

	await page.getByRole("button", { name: "Cancel" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toContainText("Stop receiving from Calm Otter?");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(page.getByText("Receiving from Calm Otter", { exact: true })).toBeVisible();

	await page.evaluate(() => window.__ftMock?.lose());
	await expect(page.getByRole("heading", { name: "Connection to Calm Otter lost" })).toBeVisible();
	await page.getByRole("button", { name: "Back to everyone" }).click();
	await expect(page.getByText("You're Brisk Fox")).toBeVisible();
});

test("failures: couldn't connect directly, paused", async ({ page }) => {
	await open(page);
	await page.evaluate(() => {
		const m = window.__ftMock;
		if (!m) return;
		m.options.connectMs = 100;
		m.options.connectResult = "failed-direct";
		m.incoming();
	});
	await page.getByRole("button", { name: "Accept" }).click();
	await expect(page.getByText(/^Couldn't connect directly\./)).toBeVisible();
	await page.getByRole("button", { name: "Back to everyone" }).click();
	await page.evaluate(() => window.__ftMock?.setError("disabled"));
	await expect(page.getByText("File Transfer is paused right now.")).toBeVisible();
});

test("phone: drop zone becomes Choose files", async ({ browser }) => {
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
	const page = await ctx.newPage();
	await open(page);
	await connect(page);
	await expect(page.getByRole("button", { name: "Choose files" })).toBeVisible();
	await expect(page.getByText("Drop photos, videos or folders here")).toBeHidden();
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	await ctx.close();
});
