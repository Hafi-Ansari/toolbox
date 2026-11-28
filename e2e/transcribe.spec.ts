// Video → Transcript, end to end with the real engine: Mediabunny decodes out/speech.wav (see
// speech.ts) and Whisper tiny.en transcribes it on the processor (WASM), so the run doesn't depend
// on a graphics card. The model's files are fetched from Hugging Face once and kept in
// out/models/; later runs serve them from there, offline.
import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { SPEECH_FILE } from "./speech.ts";

const MODELS_DIR = "out/models";
const errors: string[] = [];

test.beforeEach(async ({ page }) => {
	errors.length = 0;
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
	await page.addInitScript(() => {
		delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
		localStorage.setItem(
			"toolbox.transcribe.options",
			JSON.stringify({ model: "tiny-en", device: "wasm", language: "en" }),
		);
	});
	// Model files: from out/models/ when there, else from Hugging Face (then saved for next time).
	// transformers.js probes file sizes with 1-byte range requests, so ranges are answered from the
	// whole file, and only whole (200) responses are saved.
	await page.route("https://huggingface.co/**", async (route) => {
		const url = new URL(route.request().url());
		const local = path.join(MODELS_DIR, url.pathname.replace(/[^\w./-]/g, "_"));
		if (!fs.existsSync(local)) {
			const { range: _, ...headers } = route.request().headers();
			const response = await route.fetch({ headers });
			if (response.status() !== 200) return route.fulfill({ response });
			fs.mkdirSync(path.dirname(local), { recursive: true });
			fs.writeFileSync(local, await response.body());
		}
		const body = fs.readFileSync(local);
		const headers: Record<string, string> = {
			"access-control-allow-origin": "*",
			"access-control-expose-headers": "content-length, content-range",
			"content-type": "application/octet-stream",
		};
		const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
		if (!range) return route.fulfill({ status: 200, headers, body });
		const from = Number(range[1]);
		const to = Math.min(body.length - 1, range[2] ? Number(range[2]) : body.length - 1);
		headers["content-range"] = `bytes ${from}-${to}/${body.length}`;
		return route.fulfill({ status: 206, headers, body: body.subarray(from, to + 1) });
	});
});

test.afterEach(() => {
	expect(errors, "no console errors").toEqual([]);
});

const isolated = (page: Page) => page.evaluate(() => crossOriginIsolated);

async function open(page: Page) {
	await page.goto("/");
	expect(await isolated(page)).toBe(false);
	await page.getByRole("link", { name: /Video → Transcript/ }).click();
	await expect(page).toHaveURL(/\/transcribe$/);
	await expect(page.getByText("loading engine")).toBeHidden({ timeout: 30_000 });
}

test.describe("Video → Transcript", () => {
	test("opens isolated, and other pages stay unisolated", async ({ page }) => {
		await open(page);
		expect(await isolated(page)).toBe(true); // full page load with COOP/COEP: threads for WASM
		await page.getByRole("link", { name: "All tools" }).click();
		await expect(page.getByRole("link", { name: /Video → Transcript/ })).toBeVisible();
		expect(await isolated(page)).toBe(false);
		await page.getByRole("link", { name: /PDF → TXT/ }).click();
		await expect(page.getByText("Drop a PDF")).toBeVisible();
		expect(await isolated(page)).toBe(false);
	});

	test("says so when a file has no audio", async ({ page }) => {
		await open(page);
		await page.locator('input[type="file"]').setInputFiles("out/poems.pdf");
		await expect(page.getByRole("alert")).toHaveText("This file couldn't be read as video or audio.");
	});

	test("transcribes speech into timestamped lines", async ({ page }) => {
		test.skip(!fs.existsSync(SPEECH_FILE), "needs Windows' speech synthesizer for the fixture");
		test.setTimeout(600_000); // the first run downloads the model (about 41 MB)
		await open(page);
		await page.locator('input[type="file"]').setInputFiles(SPEECH_FILE);
		await expect(page.getByRole("radio", { name: "Tiny (English)" })).toBeChecked();
		await page.getByRole("button", { name: "Transcribe" }).click();
		const download = page.getByRole("button", { name: "Download TXT" });
		await expect(download.or(page.getByRole("alert"))).toBeVisible({ timeout: 540_000 });
		await expect(page.getByRole("alert")).toHaveCount(0); // shows the tool's error, if any
		await expect(download).toBeVisible();

		const lines = page.getByRole("list", { name: "Transcript" }).getByRole("button");
		await expect(lines.first()).toContainText("[00:00:00]");
		const all = (await lines.allTextContents()).join("\n");
		expect(all).toMatch(/quick brown fox/i);
		expect(all).toMatch(/password/i);
		// The 20 s pause is removed before Whisper sees it, but times stay on the file's clock.
		const after = (await lines.allTextContents()).find((l) => /long pause/i.test(l));
		const [, mm, ss] = after?.match(/\[00:(\d\d):(\d\d)\]/) ?? [];
		expect(Number(mm) * 60 + Number(ss)).toBeGreaterThanOrEqual(25);

		// Find keeps matching lines and their neighbours, and highlights the match.
		await page.getByRole("searchbox", { name: "Find in transcript" }).fill("password");
		await expect(page.getByText("1 match")).toBeVisible();
		await expect(page.locator("mark")).toHaveText(/password/i);
		await page.getByRole("searchbox", { name: "Find in transcript" }).fill("");

		const saved = page.waitForEvent("download");
		await download.click();
		const file = await saved;
		expect(file.suggestedFilename()).toBe("speech.txt");
		const txt = fs.readFileSync(await file.path(), "utf8");
		expect(txt).toMatch(/^\[00:00:00\] /);
		for (const line of txt.trimEnd().split("\n")) expect(line).toMatch(/^\[\d\d:\d\d:\d\d\] \S/);

		const srt = page.waitForEvent("download");
		await page.getByRole("button", { name: "Download SRT" }).click();
		const srtText = fs.readFileSync(await (await srt).path(), "utf8");
		expect(srtText).toMatch(/^1\n00:00:00,\d{3} --> 00:00:\d\d,\d{3}\n/);
	});
});
