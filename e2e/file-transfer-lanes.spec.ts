// Two-page smoke test of rtc/lanes.ts (WP4) with real WebRTC in headless Edge. No API server: the two pages
// signal through this test (page.exposeFunction relays lane 0's offer and answer). The module is bundled
// on the fly with Vite's build API and injected into a blank page, so the app itself isn't involved.
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { build } from "vite";
import type { PeerSession, SessionEvent } from "../src/tools/file-transfer/types.ts";

const LANES = 6;
const PER_LANE = 8 * 1024 * 1024; // each direction, every lane
const CHUNK = 256 * 1024;

declare global {
	interface Window {
		FtLanes: typeof import("../src/tools/file-transfer/rtc/lanes.ts");
		__sigSend(json: string): Promise<void>;
		__sigDeliver(json: string): void;
		__connected: Promise<void>;
		__s: PeerSession;
		__events: SessionEvent[];
		__received: Promise<{ bytes: number; bad: string | null }[]>;
	}
}

let bundle = "";
const errors: string[] = [];

test.beforeAll(async () => {
	const out = await build({
		configFile: false,
		logLevel: "silent",
		build: {
			write: false,
			minify: false,
			lib: { entry: path.resolve("src/tools/file-transfer/rtc/lanes.ts"), name: "FtLanes", formats: ["iife"] },
		},
	});
	const first = (Array.isArray(out) ? out[0] : out) as { output: { code?: string }[] };
	bundle = first.output[0].code ?? "";
	expect(bundle).toContain("createConnect");
});

async function blankPage(browser: Browser): Promise<Page> {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
	await page.route("**/ft-lanes-smoke", (r) =>
		r.fulfill({ contentType: "text/html", body: "<!doctype html><meta charset=utf-8><title>lanes</title>" }),
	);
	await page.goto("/ft-lanes-smoke");
	await page.addScriptTag({ content: bundle });
	return page;
}

/** Wire each page's signaling to the other page, then start connecting. */
async function startConnect(page: Page, other: Page, offerer: boolean): Promise<void> {
	await page.exposeFunction("__sigSend", (json: string) => other.evaluate((j) => window.__sigDeliver(j), json));
	await page.evaluate(
		({ offerer, lanes }) => {
			const inbox: { type: "offer" | "answer"; sdp: string }[] = [];
			const waiters: ((m: { type: "offer" | "answer"; sdp: string }) => void)[] = [];
			window.__sigDeliver = (j) => {
				const m = JSON.parse(j);
				const w = waiters.shift();
				if (w) w(m);
				else inbox.push(m);
			};
			const self = offerer ? "aaaaaaaaaaaaaaaa" : "bbbbbbbbbbbbbbbb";
			const remote = offerer ? "bbbbbbbbbbbbbbbb" : "aaaaaaaaaaaaaaaa";
			const signaling = {
				pair: "0123456789abcdef",
				self,
				remote,
				offerer,
				send: (m: { type: "offer" | "answer"; sdp: string }) => window.__sigSend(JSON.stringify(m)),
				next: () => {
					const m = inbox.shift();
					return m
						? Promise.resolve(m)
						: new Promise<{ type: "offer" | "answer"; sdp: string }>((r) => waiters.push(r));
				},
			};
			// No STUN: both pages are on this machine, and the test stays off the internet.
			const connect = window.FtLanes.createConnect({ iceServers: [] });
			window.__events = [];
			window.__connected = connect({
				signaling,
				hello: {
					name: offerer ? "Brisk Fox" : "Calm Otter",
					emoji: offerer ? "🦊" : "🦦",
					caps: { folder: false, zip: true, memoryMax: 2 ** 30, lanes },
				},
			}).then((s) => {
				window.__s = s;
				s.on((e) =>
					window.__events.push(e.type === "lane-open" ? ({ type: "lane-open", index: e.lane.index } as never) : e),
				);
			});
		},
		{ offerer, lanes: LANES },
	);
}

/** Receivers: check every 32-bit word of every message against the pattern the other side sends. */
function armReceivers(page: Page) {
	return page.evaluate(
		({ perLane }) => {
			const s = window.__s;
			const from = (1 - s.dir) as 0 | 1;
			window.__received = Promise.all(
				s.lanes().map(
					(lane) =>
						new Promise<{ bytes: number; bad: string | null }>((resolve) => {
							let bytes = 0;
							let bad: string | null = null;
							const base = ((lane.index * 2 + from) << 24) >>> 0;
							lane.data.addEventListener("message", (ev) => {
								if (!(ev.data instanceof ArrayBuffer)) return;
								const u = new Uint32Array(ev.data);
								const w0 = bytes / 4;
								for (let i = 0; i < u.length && !bad; i++)
									if (u[i] !== ((w0 + i) & 0xffffff) + base) bad = `lane ${lane.index} word ${w0 + i}: ${u[i]}`;
								bytes += ev.data.byteLength;
								if (bytes >= perLane) resolve({ bytes, bad });
							});
						}),
				),
			);
		},
		{ perLane: PER_LANE },
	);
}

/** Senders: every lane in parallel, with bufferedAmount backpressure (high 8 MiB, low 2 MiB). */
function sendAll(page: Page) {
	return page.evaluate(
		async ({ perLane, chunk }) => {
			const s = window.__s;
			await Promise.all(
				s.lanes().map(async (lane) => {
					const dc = lane.data;
					dc.bufferedAmountLowThreshold = 2 * 1024 * 1024;
					const base = ((lane.index * 2 + s.dir) << 24) >>> 0;
					for (let off = 0; off < perLane; off += chunk) {
						while (dc.bufferedAmount > 8 * 1024 * 1024)
							await new Promise<void>((r) => {
								const low = () => {
									dc.removeEventListener("bufferedamountlow", low);
									r();
								};
								dc.addEventListener("bufferedamountlow", low);
							});
						const u = new Uint32Array(chunk / 4);
						const w0 = off / 4;
						for (let i = 0; i < u.length; i++) u[i] = ((w0 + i) & 0xffffff) + base;
						dc.send(u.buffer);
					}
				}),
			);
		},
		{ perLane: PER_LANE, chunk: CHUNK },
	);
}

test.beforeEach(() => {
	errors.length = 0;
});

test.afterEach(() => {
	expect(errors, "no console errors").toEqual([]);
});

test("two pages open 6 lanes and move data over every lane, both ways", async ({ browser }) => {
	const a = await blankPage(browser);
	const b = await blankPage(browser);
	const t0 = Date.now();
	await startConnect(a, b, true);
	await startConnect(b, a, false);
	await Promise.all([a.evaluate(() => window.__connected), b.evaluate(() => window.__connected)]);
	const connectedMs = Date.now() - t0;

	expect(await a.evaluate(() => [window.__s.offerer, window.__s.dir, window.__s.remote.name])).toEqual([
		true,
		1,
		"Calm Otter",
	]);
	expect(await b.evaluate(() => [window.__s.offerer, window.__s.dir, window.__s.remote.name])).toEqual([
		false,
		0,
		"Brisk Fox",
	]);

	for (const p of [a, b]) await p.waitForFunction((n) => window.__s.lanes().length === n, LANES, { timeout: 20_000 });
	const allLanesMs = Date.now() - t0;
	expect(await a.evaluate(() => window.__s.lanes().map((l) => l.index))).toEqual([0, 1, 2, 3, 4, 5]);

	// Both selected candidates are host candidates on one machine.
	for (const p of [a, b])
		await p.waitForFunction(() => window.__events.some((e) => e.type === "path" && e.path === "same-network"));

	await Promise.all([armReceivers(a), armReceivers(b)]);
	const t1 = Date.now();
	await Promise.all([sendAll(a), sendAll(b)]);
	const [ra, rb] = await Promise.all([a.evaluate(() => window.__received), b.evaluate(() => window.__received)]);
	const ms = Date.now() - t1;
	for (const r of [...ra, ...rb]) {
		expect(r.bad).toBeNull();
		expect(r.bytes).toBe(PER_LANE);
	}
	const total = 2 * LANES * PER_LANE;
	console.log(
		`lanes: connected in ${connectedMs} ms, ${LANES} lanes in ${allLanesMs} ms; ` +
			`${(total / 1e6).toFixed(0)} MB over ${LANES} lanes both ways in ${ms} ms = ${(total / 1e6 / (ms / 1000)).toFixed(1)} MB/s`,
	);

	// Transfer ctrl passes through lane 0.
	await a.evaluate(() => window.__s.sendCtrl({ t: "done", batch: 7 }));
	await b.waitForFunction(() =>
		window.__events.some((e) => e.type === "ctrl" && e.msg.t === "done" && e.msg.batch === 7),
	);

	// A lane closed on one side is lost on both; the session goes on.
	await b.evaluate(() => window.__s.lanes()[3].data.close());
	for (const p of [a, b])
		await p.waitForFunction(() => window.__events.some((e) => e.type === "lane-lost" && e.index === 3));
	expect(await a.evaluate(() => window.__s.lanes().length)).toBe(LANES - 1);

	// Clean close: bye.
	await a.evaluate(() => window.__s.close());
	await b.waitForFunction(() => window.__events.some((e) => e.type === "closed"));
	expect(await b.evaluate(() => window.__events.find((e) => e.type === "closed"))).toEqual({
		type: "closed",
		reason: "bye",
	});
	expect(await a.evaluate(() => window.__events.find((e) => e.type === "closed"))).toEqual({
		type: "closed",
		reason: "local",
	});
});
