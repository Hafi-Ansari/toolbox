// File Transfer receive sinks in a real browser (SPEC §8.2, §8.4): the zip stream through the
// service worker public/ft-sw.js must produce exactly one download whose bytes are the planned zip
// (exact length from zipSize, every file intact), and the memory fallback must do the same.
// The sink modules are bundled on the fly and injected into the built /file-transfer page, so this
// runs before the UI (WP5) and integration (WP6) exist. WP6 may fold it into e2e/file-transfer.spec.ts.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { build } from "vite";
import { ZipReader } from "../src/lib/zipReader.ts";
import type { createMemorySink } from "../src/tools/file-transfer/sinks/memory.ts";
import { planZip } from "../src/tools/file-transfer/sinks/zipFeed.ts";
import type { createZipStreamSink } from "../src/tools/file-transfer/sinks/zipStream.ts";
import type { ManifestFile } from "../src/tools/file-transfer/types.ts";

/** What the injected bundle puts on `window.FtSinks`. */
type Sinks = { createZipStreamSink: typeof createZipStreamSink; createMemorySink: typeof createMemorySink };

const when = Date.UTC(2024, 6, 15, 10, 30, 0);
const manifest: ManifestFile[] = [
	{ i: 0, path: "Trip/Day 1/IMG_0001.CR3", size: 20 * 1024 * 1024 + 7, mtime: when },
	{ i: 1, path: "Trip/empty.txt", size: 0, mtime: when },
	{ i: 2, path: "Trip/Day 2/clip.mp4", size: 255 * 1024, mtime: when },
	{ i: 3, path: "Ünïcødé café ☕.txt", size: 1, mtime: when },
	{ i: 4, path: "../evil/../CON.jpg", size: 3 * 1024 * 1024, mtime: 0 },
];
const names = [
	"Trip/Day 1/IMG_0001.CR3",
	"Trip/empty.txt",
	"Trip/Day 2/clip.mp4",
	"Ünïcødé café ☕.txt",
	"evil/_CON.jpg",
];

/** Same generator as in the page. */
function bytesOf(n: number, seed: number): Uint8Array {
	const out = new Uint8Array(n);
	for (let i = 0, x = seed; i < n; i++) {
		x = (x * 1103515245 + 12345) >>> 0;
		out[i] = x >>> 24;
	}
	return out;
}

let bundle = "";
test.beforeAll(async () => {
	const entry = path.resolve("out/ft-sinks-entry.ts");
	await fs.mkdir("out", { recursive: true });
	await fs.writeFile(
		entry,
		`export { createZipStreamSink } from "../src/tools/file-transfer/sinks/zipStream.ts";
export { createMemorySink } from "../src/tools/file-transfer/sinks/memory.ts";
`,
	);
	const result = await build({
		configFile: false,
		logLevel: "silent",
		build: { write: false, minify: false, lib: { entry, formats: ["iife"], name: "FtSinks" } },
	});
	const output = Array.isArray(result) ? result[0] : result;
	if (!("output" in output)) throw new Error("Unexpected vite build result.");
	bundle = output.output.find((o) => o.type === "chunk")?.code ?? "";
	expect(bundle).toContain("FtSinks");
});

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
	const messages: string[] = [];
	errors.set(page, messages);
	page.on("pageerror", (error) => messages.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") messages.push(message.text());
	});
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));

/** Runs a sink over the manifest inside the page; returns its mode and location. */
function receive(page: Page, kind: "zip" | "memory") {
	return page.evaluate(
		async ({ manifest, kind }) => {
			const { createZipStreamSink, createMemorySink } = (window as unknown as { FtSinks: Sinks }).FtSinks;
			const ctx = { peerName: "Calm Otter", batch: 1 };
			const sink = kind === "zip" ? createZipStreamSink(ctx, { fallback: false }) : createMemorySink(ctx);
			await sink.begin(manifest);
			const chunk = 256 * 1024 - 16;
			for (const f of manifest) {
				const data = new Uint8Array(f.size);
				for (let i = 0, x = f.i + 1; i < f.size; i++) {
					x = (x * 1103515245 + 12345) >>> 0;
					data[i] = x >>> 24;
				}
				for (let at = 0; at < f.size; at += chunk) await sink.write(f.i, at, data.subarray(at, at + chunk));
				await sink.finishFile(f.i);
			}
			const { location } = await sink.finish();
			return { mode: sink.mode, location };
		},
		{ manifest, kind },
	);
}

for (const kind of ["zip", "memory"] as const) {
	test(`${kind} sink saves one correct zip download`, async ({ page }) => {
		await page.goto("/file-transfer");
		await page.addScriptTag({ content: bundle });
		const downloads: string[] = [];
		page.on("download", (d) => downloads.push(d.suggestedFilename()));
		const [download, result] = await Promise.all([page.waitForEvent("download"), receive(page, kind)]);
		expect(result).toEqual({ mode: kind, location: "Photos from Calm Otter.zip" });
		expect(download.suggestedFilename()).toBe("Photos from Calm Otter.zip");
		const file = await download.path();
		expect(await download.failure()).toBeNull();
		const bytes = await fs.readFile(file);
		expect(bytes.length).toBe(planZip(manifest).length);
		const reader = await ZipReader.open(new Blob([bytes]));
		expect([...reader.entries.keys()]).toEqual(names);
		for (const f of manifest) {
			const got = await reader.bytes(names[f.i]);
			expect(Buffer.compare(Buffer.from(got), Buffer.from(bytesOf(f.size, f.i + 1)))).toBe(0);
		}
		await page.waitForTimeout(500);
		expect(downloads).toHaveLength(1);
	});
}

test("the service worker refuses unknown download ids", async ({ page }) => {
	await page.goto("/file-transfer");
	await page.evaluate(async () => {
		const reg = await navigator.serviceWorker.register("/ft-sw.js", { scope: "/file-transfer/dl/" });
		const sw = reg.installing ?? reg.waiting ?? reg.active;
		if (sw && sw.state !== "activated")
			await new Promise<void>((r) => sw.addEventListener("statechange", () => sw.state === "activated" && r()));
	});
	const status = await page.evaluate(async () => {
		const frame = document.createElement("iframe");
		frame.src = `/file-transfer/dl/${"0".repeat(32)}/x.zip`;
		document.body.append(frame);
		await new Promise((r) => frame.addEventListener("load", r));
		return frame.contentDocument?.body.textContent;
	});
	expect(status).toBe("This download has ended.");
	// The 404 itself is expected here.
	const messages = errors.get(page) ?? [];
	errors.set(
		page,
		messages.filter((m) => !m.includes("404")),
	);
});
