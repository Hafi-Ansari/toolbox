// File Transfer benchmark (SPEC §16.3): the REAL engine and lanes between two headless Edge processes,
// directly or through a UDP impairment proxy (proxy.ts).
//
//   node scripts/file-transfer-bench/bench.ts            the full matrix (about 12 minutes)
//   node scripts/file-transfer-bench/bench.ts --quick    one short run per link, to check the harness
//
// Matrix: links {direct, 20/50/100 ms RTT at 1 Gbit/s, 50 ms + 0.1% loss} × lanes {1, 4, 6, 8} ×
// {unordered (folder/test scheduling, discarding sink), zip-ordered (zip scheduling + ZipWriter/CRC32)}.
// Each run sends a batch far too big to finish, waits `WARMUP_MS` after the first byte, then measures
// persisted bytes on the receiver for `MEASURE_MS`, then cancels. One connection per link and lane count
// carries both modes. Results go to results/<date>.md.
//
// Two persistent Edge profiles = two browser processes, like two real devices. mDNS host candidates are
// turned off so the proxy can see and stand in for the offerer's real address.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type BrowserContext, chromium, type Page } from "@playwright/test";
import { createServer } from "vite";
import { hostCandidate, Link, type LinkOptions, laneProxy, viaProxy } from "./proxy.ts";

const here = import.meta.dirname;
const root = path.resolve(here, "../..");
const quick = process.argv.includes("--quick");
/** `--link <text>`, `--lanes 1,6`, `--mode ordered`: run part of the matrix. `--trace`: print the receiver every second. */
const arg = (name: string) => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const trace = process.argv.includes("--trace");

const WARMUP_MS = quick ? 1500 : 3000;
const MEASURE_MS = Number(arg("--measure") ?? (quick ? 3000 : 10_000));
const GBIT = 125_000_000;
const LANES = arg("--lanes")?.split(",").map(Number) ?? (quick ? [6] : [1, 4, 6, 8]);
const ALL_MODES = ["unordered", "ordered"] as const;
const MODES = ALL_MODES.filter((m) => !arg("--mode") || m === arg("--mode"));

interface LinkSpec {
	label: string;
	impair: LinkOptions | null;
}
const ALL_LINKS: LinkSpec[] = [
	{ label: "Direct (same machine, no proxy)", impair: null },
	{ label: "20 ms RTT, 1 Gbit/s", impair: { rttMs: 20, rateBps: GBIT } },
	{ label: "50 ms RTT, 1 Gbit/s", impair: { rttMs: 50, rateBps: GBIT } },
	{ label: "100 ms RTT, 1 Gbit/s", impair: { rttMs: 100, rateBps: GBIT } },
	{ label: "50 ms RTT + 0.1% loss, 1 Gbit/s", impair: { rttMs: 50, loss: 0.001, rateBps: GBIT } },
];

const LINKS = ALL_LINKS.filter((l) => !arg("--link") || l.label.includes(arg("--link") as string));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------- the page server and the two browsers */

const vite = await createServer({
	configFile: false,
	root,
	logLevel: "error",
	server: { host: "127.0.0.1", port: 0, strictPort: false },
});
await vite.listen();
const address = vite.httpServer?.address();
if (!address || typeof address === "string") throw new Error("no server address");
const url = `http://127.0.0.1:${address.port}/scripts/file-transfer-bench/bench.html`;

const mailbox: Record<string, string[]> = { a: [], b: [] };
let link: Link | null = null;
let proxies: { close(): void }[] = [];

async function browser(name: "a" | "b"): Promise<{ ctx: BrowserContext; page: Page }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `ft-bench-${name}-`));
	const ctx = await chromium.launchPersistentContext(dir, {
		channel: "msedge",
		headless: true,
		args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
	});
	const page = ctx.pages()[0] ?? (await ctx.newPage());
	page.on(
		"console",
		(m) => m.type() === "error" && !m.text().includes("404") && console.log(`  [${name}] ${m.text()}`),
	);
	page.on("pageerror", (e) => console.log(`  [${name}] ${e.message}`));
	await page.exposeFunction("__benchSignal", (to: string, json: string) => void mailbox[to]?.push(json));
	await page.exposeFunction("__benchRead", (me: string) => mailbox[me]?.shift() ?? null);
	await page.exposeFunction("__benchMunge", async (sdp: string) => {
		if (!link) return sdp;
		const h = hostCandidate(sdp);
		const p = await laneProxy(link, h.ip, h.port);
		proxies.push(p);
		return viaProxy(sdp, h.ip, p.port);
	});
	await page.goto(url);
	await page.waitForFunction(() => typeof window.bench === "object");
	return { ctx, page };
}

const A = await browser("a");
const B = await browser("b");

/* ---------- runs */

interface Result {
	link: string;
	lanes: number;
	opened: number;
	mode: (typeof MODES)[number];
	mbps: number | null;
	note: string;
}
const results: Result[] = [];

async function connect(lanes: number, spec: LinkSpec) {
	await Promise.all([A.page.evaluate(() => window.bench.reset()), B.page.evaluate(() => window.bench.reset())]);
	for (const p of proxies) p.close();
	proxies = [];
	link?.stop();
	link = spec.impair ? new Link(spec.impair) : null;
	mailbox.a = [];
	mailbox.b = [];
	const proxied = spec.impair !== null;
	const [a] = await Promise.all([
		A.page.evaluate(([n, p]) => window.bench.connect("a", n, p), [lanes, proxied] as const),
		B.page.evaluate(([n, p]) => window.bench.connect("b", n, p), [lanes, proxied] as const),
	]);
	return a;
}

async function measure(mode: (typeof MODES)[number]): Promise<{ mbps: number | null; note: string }> {
	await B.page.evaluate((m) => window.bench.arm(m), mode);
	// 4 files of 64 GiB (virtual): never finishes within the window.
	await A.page.evaluate(() => window.bench.send(4, 64 * 1024 ** 3));
	const stats = () => B.page.evaluate(() => window.bench.stats());
	const deadline = Date.now() + 30_000;
	let s = await stats();
	while (s.bytesDone === 0 && Date.now() < deadline && s.phase !== "failed") {
		await sleep(100);
		s = await stats();
	}
	if (s.bytesDone === 0) return { mbps: null, note: `no bytes (${s.phase}${s.error ? ` ${s.error}` : ""})` };
	await sleep(WARMUP_MS);
	const t1 = performance.now();
	const b1 = (await stats()).bytesDone;
	// Sample every second: seconds without progress show lanes stalled in SCTP retransmission back-off.
	let stalled = 0;
	let last = b1;
	for (let k = 0; k < MEASURE_MS / 1000; k++) {
		await sleep(1000);
		const now = (await stats()).bytesDone;
		if (now - last < 100_000) stalled++;
		last = now;
		if (trace) {
			const x = await B.page.evaluate(() => window.bench.stats());
			const y = await A.page.evaluate(() => window.bench.stats());
			console.log(
				`    t+${k + 1}s proxy ${link?.pkts ?? 0} pkts, ${((link?.bytes.up ?? 0) / 1e6).toFixed(1)} MB up; receiver ${(x.bytesDone / 1e6).toFixed(1)} MB ${x.phase}, sender acked ${(y.bytesDone / 1e6).toFixed(1)} MB`,
			);
		}
	}
	if (process.argv.includes("--dump")) {
		console.log("A", await A.page.evaluate(() => window.bench.dump()));
		console.log("B", await B.page.evaluate(() => window.bench.dump()));
	}
	const end = await stats();
	const t2 = performance.now();
	const mbps = (end.bytesDone - b1) / 1e6 / ((t2 - t1) / 1000);
	await A.page.evaluate(() => window.bench.cancel("send"));
	const until = Date.now() + 10_000;
	while (Date.now() < until && (await stats()).phase === "running") await sleep(100);
	await sleep(300);
	const extra = link ? `; proxy dropped ${link.drops}, lost ${link.losses}` : "";
	return { mbps, note: `${stalled} s of ${MEASURE_MS / 1000} without progress${extra}` };
}

const t0 = Date.now();
// Warm-up, not recorded: the first transfer in a fresh browser runs cold (JIT, buffers).
await connect(6, ALL_LINKS[0] as LinkSpec);
await measure("unordered");
for (const spec of LINKS) {
	for (const lanes of LANES) {
		// A fresh connection per mode: a cancelled batch leaves megabytes queued in every lane.
		for (const mode of MODES) {
			let opened = 0;
			try {
				const info = await connect(lanes, spec);
				opened = info.lanes;
				console.log(
					`${spec.label}, ${lanes} lanes, ${mode}: connected (${opened} open, max message ${info.maxMessageSize})`,
				);
			} catch (e) {
				console.log(`${spec.label}, ${lanes} lanes: connect failed: ${e instanceof Error ? e.message : e}`);
				results.push({ link: spec.label, lanes, opened, mode, mbps: null, note: "connect failed" });
				continue;
			}
			let r: { mbps: number | null; note: string };
			try {
				r = await measure(mode);
			} catch (e) {
				r = { mbps: null, note: e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e) };
			}
			console.log(`  ${mode}: ${r.mbps === null ? "—" : `${r.mbps.toFixed(1)} MB/s`} (${r.note})`);
			results.push({ link: spec.label, lanes, opened, mode, ...r });
		}
	}
}
const minutes = (Date.now() - t0) / 60_000;

await Promise.all([A.page.evaluate(() => window.bench.reset()), B.page.evaluate(() => window.bench.reset())]);
(link as Link | null)?.stop();
for (const p of proxies) p.close();
await A.ctx.close();
await B.ctx.close();
await vite.close();

/* ---------- report */

const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(1));
const lines: string[] = [];
const date = new Date().toISOString().slice(0, 10);
lines.push(`# File Transfer benchmark, ${date}${quick ? " (quick)" : ""}`);
lines.push("");
lines.push(
	`Real \`rtc/lanes.ts\` + \`engine/engine.ts\` between two headless Edge processes on one machine (${os.cpus()[0]?.model.trim() ?? "unknown CPU"}, ${os.platform()}).`,
	"Impaired links go through `proxy.ts` (Node UDP proxy: delay, loss, 1 Gbit/s token bucket). The spike measured the",
	"proxy's own ceiling at ~32 MB/s; on this machine it now carries up to ~65 MB/s, and figures near that are its ceiling. Sources are in-memory virtual files",
	`(no disk reads). MB/s = 10^6 bytes/s persisted on the receiver over ${MEASURE_MS / 1000} s after a ${WARMUP_MS / 1000} s warm-up.`,
	"",
	"- **unordered**: folder/test scheduling (32 MiB ranges, ≤ 2 lanes per file) into a discarding sink.",
	"- **zip-ordered**: zip-stream scheduling (1 MiB ranges, 64 MiB reorder window) into `ZipWriter` (CRC32, headers);",
	"  the archive is dropped instead of streamed through the service worker to disk.",
	"",
	`Tuning: defaults from \`tuning.ts\` (chunk ${tuningSummary()}). Run time ${minutes.toFixed(1)} min.`,
	"",
);
for (const mode of MODES) {
	lines.push(`## ${mode === "ordered" ? "zip-ordered" : "unordered"} (MB/s)`, "");
	lines.push(`| Link | ${LANES.map((n) => `${n} lane${n > 1 ? "s" : ""}`).join(" | ")} |`);
	lines.push(`|---|${LANES.map(() => "---:").join("|")}|`);
	for (const spec of LINKS) {
		const cells = LANES.map((n) => {
			const r = results.find((x) => x.link === spec.label && x.lanes === n && x.mode === mode);
			if (!r) return "—";
			const short = r.opened && r.opened < n ? ` (${r.opened} opened)` : "";
			return `${fmt(r.mbps)}${short}`;
		});
		lines.push(`| ${spec.label} | ${cells.join(" | ")} |`);
	}
	lines.push("");
}
lines.push("## Raw", "", "| Link | Lanes | Mode | MB/s | Note |", "|---|---:|---|---:|---|");
for (const r of results) lines.push(`| ${r.link} | ${r.lanes} | ${r.mode} | ${fmt(r.mbps)} | ${r.note} |`);
lines.push("");

function tuningSummary() {
	return "256 KiB, highWater 8 MiB, lowWater 2 MiB, laneWindow 16 MiB, ackEvery 1 MiB, readBlock 4 MiB";
}

const out = path.join(here, "results", `${date}${quick ? "-quick" : ""}.md`);
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, lines.join("\n"));
console.log(`\nWrote ${path.relative(root, out)} (${minutes.toFixed(1)} min)`);
