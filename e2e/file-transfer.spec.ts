// Blazing Fast File Transfer end to end (SPEC §16.2): two (or three) headless Edge contexts on the REAL
// /file-transfer page, talking to the REAL /api/file-transfer (the in-memory store that scripts/api-dev.ts
// serves from `vite preview`), connected by real WebRTC lanes, moving real files.
//
// Each test gets its own client IP (x-real-ip), so the per-IP caps and rate limits of one test don't
// leak into the next, and both peers of a test share it ("Same network").
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { ZipReader } from "../src/lib/zipReader.ts";

const MiB = 1024 * 1024;
let ipCounter = 0;

interface Peer {
	ctx: BrowserContext;
	page: Page;
	name: string;
	errors: string[];
	id: string;
}

const peers: Peer[] = [];
let dir = "";

test.beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "ft-e2e-"));
});
test.afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

test.afterEach(async () => {
	for (const p of peers.splice(0)) {
		// Leave cleanly (pagehide → leave beacon), then check the page never logged an error.
		await p.page.goto("about:blank").catch(() => {});
		await p.ctx.close();
		expect(p.errors, `${p.name}: no console errors`).toEqual([]);
	}
});

/** Opens /file-transfer as `name`, from client IP `ip`. `testSink` receives into the hashing test sink. */
async function open(
	browser: Browser,
	ip: string,
	name: string,
	emoji: string,
	opts: { testSink?: boolean; ordered?: boolean; touch?: boolean; userAgent?: string } = {},
): Promise<Peer> {
	const ctx = await browser.newContext({
		extraHTTPHeaders: { "x-real-ip": ip },
		...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
		...(opts.touch ? { hasTouch: true, isMobile: true, viewport: { width: 500, height: 900 } } : {}),
	});
	const page = await ctx.newPage();
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => m.type() === "error" && errors.push(`${m.text()} ${m.location().url}`.trim()));
	page.on(
		"response",
		(r) =>
			r.status() >= 400 &&
			console.log(
				`[${name}] ${r.status()} ${r.request().method()} ${r.url()} ${r.request().postData()?.slice(0, 120) ?? ""}`,
			),
	);
	const id = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
	const secret = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
	await page.addInitScript(
		({ id, secret, name, emoji, testSink, ordered }) => {
			if (location.protocol === "about:") return;
			if (!localStorage.getItem("toolbox.send.peer"))
				localStorage.setItem("toolbox.send.peer", JSON.stringify({ peer: id, secret, name, emoji, hidden: false }));
			if (testSink) window.__sendTestSink = true;
			if (ordered) window.__sendTestSinkOrdered = true;
		},
		{ id, secret, name, emoji, testSink: !!opts.testSink, ordered: !!opts.ordered },
	);
	await page.goto("/file-transfer");
	await expect(page.getByText(`You're ${name}`)).toBeVisible();
	const peer = { ctx, page, name, errors, id };
	peers.push(peer);
	return peer;
}

// Random per worker: a retried or repeated test must not meet the peers an earlier run left behind.
const ipBase = Math.floor(Math.random() * 250);
const nextIp = () => `10.${ipBase}.${++ipCounter}.7`;

/** `from` asks `to`, `to` accepts; both end up connected over 6 lanes. */
async function connect(from: Peer, to: Peer) {
	const tile = from.page.getByRole("button", { name: new RegExp(`^${to.name}`) });
	await expect(tile).toBeVisible({ timeout: 15_000 });
	await tile.click();
	await expect(from.page.getByText(`Asking ${to.name}…`)).toBeVisible();
	const dialog = to.page.getByRole("alertdialog");
	await expect(dialog).toContainText(`${from.name} wants to connect`, { timeout: 10_000 });
	await dialog.getByRole("button", { name: "Accept" }).click();
	for (const [p, other] of [
		[from, to],
		[to, from],
	] as const) {
		await expect(p.page.getByText(`Connected to ${other.name}`)).toBeVisible({ timeout: 20_000 });
		await expect(p.page.getByText(/Direct.* · 6 lanes/)).toBeVisible({ timeout: 20_000 });
	}
}

/** Deterministic bytes, different per seed. */
function bytesOf(n: number, seed: number): Buffer {
	const out = Buffer.alloc(n);
	let x = seed * 2654435761 + 1;
	for (let i = 0; i < n; i++) {
		x = (x * 1103515245 + 12345) >>> 0;
		out[i] = x >>> 24;
	}
	return out;
}

const sha = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Writes `files` (relative paths starting with `name/`) under the temp folder; returns the folder `name`. */
async function folder(name: string, files: Record<string, Buffer>): Promise<string> {
	const root = dir;
	for (const [rel, data] of Object.entries(files)) {
		const file = path.join(root, rel);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, data);
	}
	return path.join(dir, name);
}

/** Reads a downloaded zip and checks it holds exactly `files` (paths relative to the zip root). */
async function expectZip(file: string, files: Record<string, Buffer>) {
	const reader = await ZipReader.open(new Blob([await fs.readFile(file)]));
	expect([...reader.entries.keys()].sort()).toEqual(Object.keys(files).sort());
	for (const [name, want] of Object.entries(files)) {
		const got = Buffer.from(await reader.bytes(name));
		expect(got.length, name).toBe(want.length);
		expect(sha(got), name).toBe(sha(want));
	}
}

/** Accepts the offer on `page` as the default zip and returns the finished download's path. */
async function acceptZip(page: Page, from: string, count: number) {
	await expect(page.getByText(new RegExp(`${from} is sending ${count} files?`))).toBeVisible({ timeout: 15_000 });
	const [download] = await Promise.all([
		page.waitForEvent("download", { timeout: 20_000 }),
		page.getByRole("button", { name: "Accept" }).click(),
	]);
	expect(download.suggestedFilename()).toMatch(
		new RegExp(String.raw`^Transfer from ${from} \d{4}-\d\d-\d\d \d\d\.\d\d\.zip$`),
	);
	const file = await download.path();
	expect(await download.failure()).toBeNull();
	return file;
}

test("presence, request and accept, then a folder batch both ways as streamed zips", async ({ browser }) => {
	const ip = nextIp();
	const a = await open(browser, ip, "Brisk Fox", "🦊", { touch: true });
	const b = await open(browser, ip, "Calm Otter", "🦦");
	// Both see each other, on the same network.
	await expect(a.page.getByRole("button", { name: /^Calm Otter, same network/ })).toBeVisible({ timeout: 15_000 });
	await expect(b.page.getByRole("button", { name: /^Brisk Fox, same network/ })).toBeVisible({ timeout: 15_000 });
	await connect(a, b);

	// A third person sees both as busy.
	const c = await open(browser, ip, "Witty Owl", "🦉");
	await expect(c.page.getByRole("button", { name: /^Brisk Fox.*in a transfer/ })).toHaveAttribute(
		"aria-disabled",
		"true",
		{ timeout: 15_000 },
	);

	// A → B: nested folders, an empty file, unicode names, a file spanning ranges.
	const tree: Record<string, Buffer> = {
		"Trip/empty.txt": Buffer.alloc(0),
		"Trip/one.bin": bytesOf(1, 1),
		"Trip/Day 1/IMG_0001.jpg": bytesOf(255 * 1024, 2),
		"Trip/Day 1/Ünïcødé café ☕.txt": Buffer.from("Grüße aus Köln ☕\n"),
		"Trip/Day 2/clip.mp4": bytesOf(33 * MiB + 5, 3),
		"Trip/Day 2/Nested/deeper/photo.CR3": bytesOf(5 * MiB, 4),
		"Trip/Day 2/Nested/deeper/photo 2.CR3": bytesOf(5 * MiB + 1, 5),
	};
	const root = await folder("Trip", tree);
	// Touch devices pick a folder with webkitdirectory (the "Choose folder" button's input).
	await a.page.locator("input[webkitdirectory]").setInputFiles(root);
	await expect(a.page.getByText(/Waiting for Calm Otter to accept 7 files/)).toBeVisible();
	const zip1 = await acceptZip(b.page, "Brisk Fox", 7);
	await expect(b.page.getByText(/^Saved 7 files to your downloads as Transfer from Brisk Fox .+\.zip$/)).toBeVisible({
		timeout: 30_000,
	});
	await expect(a.page.getByText(/^Sent 7 files/)).toBeVisible();
	await expectZip(zip1, tree);

	// B → A, plain files from the file input.
	const back = { "notes.txt": Buffer.from("hello back"), "pic.jpg": bytesOf(2 * MiB + 3, 6) };
	await b.page
		.locator('input[type="file"]:not([webkitdirectory])')
		.setInputFiles(
			Object.entries(back).map(([name, buffer]) => ({ name, mimeType: "application/octet-stream", buffer })),
		);
	const zip2 = await acceptZip(a.page, "Calm Otter", 2);
	await expect(a.page.getByText(/^Saved 2 files to your downloads as Transfer from Calm Otter .+\.zip$/)).toBeVisible({
		timeout: 30_000,
	});
	await expectZip(zip2, back);

	// A second batch A → B in the same session starts a second download, without a browser prompt.
	const again = { "second.bin": bytesOf(3 * MiB, 7) };
	await a.page
		.locator('input[type="file"]:not([webkitdirectory])')
		.setInputFiles(
			Object.entries(again).map(([name, buffer]) => ({ name, mimeType: "application/octet-stream", buffer })),
		);
	const zip3 = await acceptZip(b.page, "Brisk Fox", 1);
	await expectZip(zip3, again);

	// Disconnect: both go back to the lobby, and C sees them free again.
	await a.page.getByRole("button", { name: "Disconnect" }).click();
	await expect(a.page.getByText("You're Brisk Fox")).toBeVisible();
	await expect(b.page.getByRole("heading", { name: "Connection to Brisk Fox lost" })).toBeVisible({ timeout: 10_000 });
	await expect(c.page.getByRole("button", { name: /^Brisk Fox, same network$/ })).toBeVisible({ timeout: 20_000 });
});

// Chrome on an iPhone is WebKit: a service-worker download stalls at 0 KB there, so it must take the
// memory fallback, say "Received" (not "Saved"), and keep the zip for "Save .zip".
const IPHONE_CHROME =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.7444.0 Mobile/15E148 Safari/604.1";

test("an iPhone receives through the memory fallback and can save the zip again", async ({ browser }) => {
	const ip = nextIp();
	const a = await open(browser, ip, "Brisk Fox", "🦊");
	const b = await open(browser, ip, "Calm Otter", "🦦", { userAgent: IPHONE_CHROME });
	await connect(a, b);
	const files = { "IMG_0001.HEIC": bytesOf(3 * MiB + 11, 8), "notes.txt": Buffer.from("from the phone test") };
	await a.page
		.locator('input[type="file"]:not([webkitdirectory])')
		.setInputFiles(
			Object.entries(files).map(([name, buffer]) => ({ name, mimeType: "application/octet-stream", buffer })),
		);
	await expect(b.page.getByText("Brisk Fox is sending 2 files")).toBeVisible({ timeout: 15_000 });
	await expect(
		b.page.getByText(/^Arrives as one \.zip, Transfer from Brisk Fox .+\.zip\. Your browser asks/),
	).toBeVisible();

	// The automatic download comes when the zip is complete, not in the Accept click.
	const [first] = await Promise.all([
		b.page.waitForEvent("download", { timeout: 30_000 }),
		b.page.getByRole("button", { name: "Accept" }).click(),
	]);
	await expect(b.page.getByText(/^Received 2 files as Transfer from Brisk Fox .+\.zip\. To keep it/)).toBeVisible({
		timeout: 30_000,
	});
	await expectZip(await first.path(), files);

	// The zip stays on the page: "Save .zip" downloads the same archive again.
	const [second] = await Promise.all([
		b.page.waitForEvent("download"),
		b.page.getByRole("button", { name: "Save .zip" }).click(),
	]);
	expect(second.suggestedFilename()).toBe(first.suggestedFilename());
	await expectZip(await second.path(), files);
});

test("decline, then cancel mid-transfer from the sender", async ({ browser }) => {
	const ip = nextIp();
	const a = await open(browser, ip, "Brisk Fox", "🦊");
	const b = await open(browser, ip, "Calm Otter", "🦦", { testSink: true });
	await connect(a, b);
	const input = a.page.locator('input[type="file"]');

	await input.setInputFiles([{ name: "x.bin", mimeType: "application/octet-stream", buffer: bytesOf(1000, 1) }]);
	await expect(b.page.getByText("Brisk Fox is sending 1 file")).toBeVisible({ timeout: 15_000 });
	await b.page.getByRole("button", { name: "Decline" }).click();
	await expect(a.page.getByText("Calm Otter declined.")).toBeVisible();
	await expect(b.page.getByText("You declined.")).toBeVisible();

	// A big file, so there's time to stop it partway.
	const parts: string[] = [];
	for (let i = 0; i < 4; i++) {
		parts.push(path.join(dir, `cancel-${i}.bin`));
		await fs.writeFile(parts[i], bytesOf(64 * MiB, 9 + i));
	}
	await input.setInputFiles(parts);
	await b.page.getByRole("button", { name: "Accept" }).click();
	await expect(a.page.getByRole("progressbar")).toBeVisible({ timeout: 15_000 });
	await a.page.getByRole("button", { name: "Cancel" }).click();
	await a.page.getByRole("dialog").getByRole("button", { name: "Stop" }).click();
	await expect(a.page.getByText("You stopped sending.")).toBeVisible();
	await expect(b.page.getByText("Brisk Fox stopped sending.")).toBeVisible();
	expect(await b.page.evaluate(() => window.__sendReceived?.length ?? 0)).toBeLessThan(4);

	// The connection stays up: a small batch still goes through.
	await input.setInputFiles([{ name: "after.txt", mimeType: "text/plain", buffer: Buffer.from("still here") }]);
	await b.page.getByRole("button", { name: "Accept" }).click();
	await expect(a.page.getByText(/^Sent 1 file/)).toBeVisible({ timeout: 15_000 });
	const got = await b.page.evaluate(() => window.__sendReceived ?? []);
	expect(got.at(-1)).toEqual({ path: "after.txt", size: 10, sha256: sha(Buffer.from("still here")) });
});

for (const ordered of [false, true])
	test(`a 200 MiB batch into the test sink (${ordered ? "zip-ordered" : "unordered"}) arrives intact`, async ({
		browser,
	}) => {
		const ip = nextIp();
		const a = await open(browser, ip, "Brisk Fox", "🦊");
		const b = await open(browser, ip, "Calm Otter", "🦦", { testSink: true, ordered });
		await connect(a, b);
		const sizes = [96 * MiB + 17, 64 * MiB, 33 * MiB, 7 * MiB - 17, 0, 1];
		const files = await Promise.all(
			sizes.map(async (n, i) => {
				const file = path.join(dir, `big-${ordered}-${i}.bin`);
				const data = bytesOf(n, 100 + i);
				await fs.writeFile(file, data);
				return { file, name: `big-${i}.bin`, size: n, sha256: sha(data) };
			}),
		);
		await a.page.locator('input[type="file"]').setInputFiles(files.map((f) => f.file));
		await expect(b.page.getByText("Brisk Fox is sending 6 files")).toBeVisible({ timeout: 15_000 });
		const t0 = Date.now();
		await b.page.getByRole("button", { name: "Accept" }).click();
		await expect(a.page.getByText(/^Sent 6 files/)).toBeVisible({ timeout: 90_000 });
		const ms = Date.now() - t0;
		const got = await b.page.evaluate(() => window.__sendReceived ?? []);
		expect(got.sort((x, y) => x.path.localeCompare(y.path))).toEqual(
			files
				.map((f) => ({ path: path.basename(f.file), size: f.size, sha256: f.sha256 }))
				.sort((x, y) => x.path.localeCompare(y.path)),
		);
		console.log(`file-transfer e2e: 200 MiB ${ordered ? "ordered" : "unordered"} in ${ms} ms`);
	});

test("hidden switch and invite link", async ({ browser }) => {
	const a = await open(browser, nextIp(), "Brisk Fox", "🦊");
	const b = await open(browser, nextIp(), "Calm Otter", "🦦");
	await expect(a.page.getByRole("button", { name: /^Calm Otter$/ })).toBeVisible({ timeout: 15_000 });

	// Hidden: gone from the grid, but the invite link still reaches it.
	await b.page.getByRole("switch").click();
	await expect(b.page.getByText("Others can't see you.")).toBeVisible();
	await expect(a.page.getByRole("button", { name: /^Calm Otter/ })).toHaveCount(0, { timeout: 15_000 });
	await a.page.goto(`/file-transfer?to=${b.id}`);
	await expect(a.page.getByText("The person who shared this link isn't here right now.")).toBeVisible();
	await a.page.getByRole("button", { name: "Try to connect" }).click();
	const dialog = b.page.getByRole("alertdialog");
	await expect(dialog).toContainText("Brisk Fox wants to connect", { timeout: 10_000 });
	await dialog.getByRole("button", { name: "Decline" }).click();
	await expect(a.page.getByText(/declined\.$/)).toBeVisible({ timeout: 10_000 });

	// Visible again: the invite link shows the person and connects in one click.
	await b.page.getByRole("switch").click();
	await a.page.goto(`/file-transfer?to=${b.id}`);
	await a.page.getByRole("button", { name: "Connect to Calm Otter" }).click({ timeout: 15_000 });
	await b.page.getByRole("alertdialog").getByRole("button", { name: "Accept" }).click({ timeout: 10_000 });
	await expect(a.page.getByText("Connected to Calm Otter")).toBeVisible({ timeout: 20_000 });
	await expect(b.page.getByText("Connected to Brisk Fox")).toBeVisible({ timeout: 20_000 });
});
