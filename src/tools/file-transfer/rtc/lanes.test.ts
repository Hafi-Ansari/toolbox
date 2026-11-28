// Lanes over in-memory fake peer connections (rtc/fakeRtc.ts): handshake, hello, extra lanes, ICE restart,
// lane loss, bye, protocol violations, path type and the connect failures of §11.
import { afterEach, describe, expect, it } from "vitest";
import {
	type CtrlOf,
	FtError,
	type PeerSession,
	type SessionEvent,
	type Signaling,
	type SignalMessage,
} from "../types.ts";
import { type FakeChannel, FakeNet, type FakePc } from "./fakeRtc.ts";
import { createConnect, type LaneOptions, laneCount } from "./lanes.ts";

const timing: LaneOptions = {
	gatherTimeoutMs: 50,
	openTimeoutMs: 300,
	restartAfterMs: 20,
	lostAfterMs: 250,
	byeFlushMs: 50,
	iceServers: [],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 2000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await sleep(5);
	}
}

/** Two mailboxes, like the server's `signal`/`read`. */
function signalPair(opts: { failSend?: unknown } = {}): [Signaling, Signaling] {
	const boxes: SignalMessage[][] = [[], []];
	const make = (me: 0 | 1): Signaling => ({
		pair: "0123456789abcdef",
		self: me ? "bbbbbbbbbbbbbbbb" : "aaaaaaaaaaaaaaaa",
		remote: me ? "aaaaaaaaaaaaaaaa" : "bbbbbbbbbbbbbbbb",
		offerer: me === 0,
		async send(msg) {
			if (opts.failSend) throw opts.failSend;
			boxes[1 - me].push(msg);
		},
		async next(signal) {
			while (!boxes[me].length) {
				signal?.throwIfAborted();
				await sleep(5);
			}
			return boxes[me].shift() as SignalMessage;
		},
	});
	return [make(0), make(1)];
}

const hello = (name: string, lanes = 6): Omit<CtrlOf<"hello">, "t" | "v"> => ({
	name,
	emoji: "🦊",
	caps: { folder: false, zip: true, memoryMax: 2 ** 30, lanes },
});

function record(s: PeerSession): SessionEvent[] {
	const events: SessionEvent[] = [];
	s.on((e) => events.push(e));
	return events;
}

const open: PeerSession[] = [];
afterEach(() => {
	for (const s of open.splice(0)) s.close();
});

async function pair(net: FakeNet, lanesA = 6, lanesB = 6, extra: LaneOptions = {}) {
	const connect = createConnect({ ...timing, ...extra, createPeerConnection: net.create });
	const [sa, sb] = signalPair();
	const [a, b] = await Promise.all([
		connect({ signaling: sa, hello: hello("Brisk Fox", lanesA) }),
		connect({ signaling: sb, hello: hello("Calm Otter", lanesB) }),
	]);
	open.push(a, b);
	return { a, b };
}

const pcs = (net: FakeNet) => [...net.pcs.values()];
const ctrlOf = (pc: FakePc) => pc.channels.find((c) => c.label === "ctrl") as FakeChannel;

describe("laneCount", () => {
	it("takes the smaller side, within 1..8", () => {
		expect(laneCount(6, 4)).toBe(4);
		expect(laneCount(8, 12)).toBe(8);
		expect(laneCount(0, 6)).toBe(1);
		expect(laneCount(3, Number.NaN)).toBe(1);
	});
});

describe("connect", () => {
	it("opens lane 0, exchanges hello and opens the agreed number of lanes", async () => {
		const net = new FakeNet();
		const { a, b } = await pair(net, 6, 4);
		expect(a.offerer).toBe(true);
		expect(a.dir).toBe(1);
		expect(b.offerer).toBe(false);
		expect(b.dir).toBe(0);
		expect(a.remote.name).toBe("Calm Otter");
		expect(b.remote.name).toBe("Brisk Fox");
		expect(a.remote.v).toBe(1);
		expect(a.lanes()[0].index).toBe(0);
		const eventsA = record(a);
		await until(() => a.lanes().length === 4 && b.lanes().length === 4);
		expect(a.lanes().map((l) => l.index)).toEqual([0, 1, 2, 3]);
		expect(b.lanes().map((l) => l.index)).toEqual([0, 1, 2, 3]);
		// Lanes that opened after on() were announced; lane 0 never is.
		const announced = eventsA.flatMap((e) => (e.type === "lane-open" ? [e.lane.index] : []));
		expect(announced.every((i) => i >= 1)).toBe(true);
		// 4 lanes × 2 sides, nothing more.
		expect(net.pcs.size).toBe(8);
		// Channel ids and options per §7.1.
		const lane0 = pcs(net)[0];
		expect(lane0.channels.map((c) => [c.label, c.id])).toEqual([
			["ctrl", 0],
			["data", 1],
		]);
		expect(pcs(net)[2].channels.map((c) => [c.label, c.id])).toEqual([["data", 1]]);
		expect(a.lanes().every((l) => l.data.binaryType === "arraybuffer")).toBe(true);
	});

	it("carries data on every lane, both ways", async () => {
		const net = new FakeNet();
		const { a, b } = await pair(net, 3, 3);
		await until(() => a.lanes().length === 3 && b.lanes().length === 3);
		const got: string[] = [];
		for (const lane of b.lanes()) lane.data.addEventListener("message", (ev) => got.push(`${lane.index}:${ev.data}`));
		for (const lane of a.lanes()) lane.data.send(`hi ${lane.index}`);
		await until(() => got.length === 3);
		expect(got.sort()).toEqual(["0:hi 0", "1:hi 1", "2:hi 2"]);
	});

	it("passes transfer ctrl through, buffering what arrives before anyone listens", async () => {
		const net = new FakeNet();
		const { a, b } = await pair(net, 1, 1);
		a.sendCtrl({ t: "done", batch: 3 });
		a.sendCtrl({ t: "cancel", batch: 3, by: "sender", reason: "cancelled" });
		await sleep(20);
		const events = record(b);
		expect(events).toEqual([
			{ type: "path", path: "same-network" },
			{ type: "ctrl", msg: { t: "done", batch: 3 } },
			{ type: "ctrl", msg: { t: "cancel", batch: 3, by: "sender", reason: "cancelled" } },
		]);
	});

	it("reports the path as direct unless both candidates are host", async () => {
		const net = new FakeNet();
		net.stats = { local: "host", remote: "srflx" };
		const { a } = await pair(net, 1, 1);
		const events = record(a);
		await until(() => events.some((e) => e.type === "path"));
		expect(events).toContainEqual({ type: "path", path: "direct" });
	});

	it("close() sends bye: local ends with local, remote with bye", async () => {
		const net = new FakeNet();
		const { a, b } = await pair(net, 2, 2);
		await until(() => b.lanes().length === 2);
		const ea = record(a);
		const eb = record(b);
		a.close();
		await until(() => eb.some((e) => e.type === "closed"));
		expect(ea.filter((e) => e.type === "closed")).toEqual([{ type: "closed", reason: "local" }]);
		expect(eb.filter((e) => e.type === "closed")).toEqual([{ type: "closed", reason: "bye" }]);
		expect(b.lanes()).toEqual([]);
		await sleep(80);
		expect(pcs(net).every((pc) => pc.iceConnectionState === "closed")).toBe(true);
		// Closing twice is harmless and emits nothing more.
		a.close();
		expect(ea.filter((e) => e.type === "closed").length).toBe(1);
	});

	it("ends with lost when the other side vanishes without bye", async () => {
		const net = new FakeNet();
		const { a, b } = await pair(net, 2, 2);
		const ea = record(a);
		// Simulate the tab closing: lane 0's connection goes away.
		pcs(net)[1].close();
		await until(() => ea.some((e) => e.type === "closed"));
		expect(ea).toContainEqual({ type: "closed", reason: "lost" });
		b.close();
	});
});

describe("lanes", () => {
	it("drops an extra lane that does not open in time, quietly", async () => {
		const net = new FakeNet();
		net.allowed = 2; // lane 0 and one extra lane
		const { a, b } = await pair(net, 3, 3);
		const ea = record(a);
		await sleep(450);
		expect(a.lanes().length).toBe(2);
		expect(b.lanes().length).toBe(2);
		expect(ea.some((e) => e.type === "lane-lost")).toBe(false);
	});

	it("announces lane-lost on both sides when a lane closes, and keeps the session", async () => {
		const net = new FakeNet();
		const { a, b } = await pair(net, 3, 3);
		await until(() => a.lanes().length === 3 && b.lanes().length === 3);
		const ea = record(a);
		const eb = record(b);
		// Close lane 2 on the answerer side (its data channel closes on both ends).
		const lane2 = b.lanes()[2];
		lane2.data.close();
		await until(() => ea.some((e) => e.type === "lane-lost") && eb.some((e) => e.type === "lane-lost"));
		expect(ea).toContainEqual({ type: "lane-lost", index: 2 });
		expect(eb).toContainEqual({ type: "lane-lost", index: 2 });
		expect(a.lanes().map((l) => l.index)).toEqual([0, 1]);
		expect(ea.some((e) => e.type === "closed")).toBe(false);
	});

	it("restarts ICE over ctrl after a disconnect, then recovers", async () => {
		const net = new FakeNet();
		const { a, b } = await pair(net, 2, 2);
		await until(() => a.lanes().length === 2);
		const ea = record(a);
		const eb = record(b);
		// Lane 1's two connections: the offerer's is created before the answerer's.
		const [offPc, ansPc] = pcs(net).slice(2);
		offPc.setIce("disconnected");
		ansPc.setIce("disconnected");
		await until(() => offPc.iceConnectionState === "connected" && ansPc.iceConnectionState === "connected");
		expect(offPc.restarts).toBe(1);
		await sleep(300); // past lostAfterMs: nothing is dropped
		expect(a.lanes().length).toBe(2);
		expect([...ea, ...eb].some((e) => e.type === "lane-lost" || e.type === "closed")).toBe(false);
		const sent = ctrlOf(pcs(net)[0]).sent.map((s) => JSON.parse(String(s)).t);
		expect(sent).toContain("restart-offer");
	});

	it("lane 0: reconnecting, then reconnected after an ICE restart", async () => {
		const net = new FakeNet();
		const { a, b } = await pair(net, 1, 1);
		const ea = record(a);
		const eb = record(b);
		const [pa, pb] = pcs(net);
		pa.setIce("disconnected");
		pb.setIce("disconnected");
		await until(() => ea.some((e) => e.type === "reconnected") && eb.some((e) => e.type === "reconnected"));
		const kinds = ea.map((e) => e.type).filter((t) => t !== "path");
		expect(kinds).toEqual(["reconnecting", "reconnected"]);
		expect(pa.restarts).toBe(1);
	});

	it("a lane that stays down is lost after the timeout; lane 0 ends the session", async () => {
		const net = new FakeNet();
		const { a, b } = await pair(net, 2, 2);
		await until(() => a.lanes().length === 2);
		const ea = record(a);
		const eb = record(b);
		net.block = true;
		const [p0a, p0b, p1a, p1b] = pcs(net);
		p1a.setIce("failed");
		p1b.setIce("failed");
		await until(() => ea.some((e) => e.type === "lane-lost"));
		expect(ea).toContainEqual({ type: "lane-lost", index: 1 });
		expect(p1a.restarts).toBeGreaterThanOrEqual(1);
		p0a.setIce("disconnected");
		p0b.setIce("disconnected");
		await until(() => ea.some((e) => e.type === "closed") && eb.some((e) => e.type === "closed"));
		expect(ea).toContainEqual({ type: "closed", reason: "lost" });
		expect(eb).toContainEqual({ type: "closed", reason: "lost" });
	});
});

describe("protocol", () => {
	it("a malformed ctrl message ends the session with protocol; the other side gets bye", async () => {
		const net = new FakeNet();
		const { a, b } = await pair(net, 1, 1);
		const ea = record(a);
		const eb = record(b);
		// The answerer's ctrl channel sends garbage to the offerer.
		ctrlOf(pcs(net)[1]).send("{not json");
		await until(() => ea.some((e) => e.type === "closed") && eb.some((e) => e.type === "closed"));
		expect(ea).toContainEqual({ type: "closed", reason: "protocol" });
		expect(eb).toContainEqual({ type: "closed", reason: "bye" });
	});

	it("a lane-offer sent to the offerer is a violation", async () => {
		const net = new FakeNet();
		const { a } = await pair(net, 1, 1);
		const ea = record(a);
		ctrlOf(pcs(net)[1]).send(JSON.stringify({ t: "lane-offer", lane: 1, sdp: "x" }));
		await until(() => ea.some((e) => e.type === "closed"));
		expect(ea).toContainEqual({ type: "closed", reason: "protocol" });
	});
});

describe("connect failures (§11)", () => {
	it("failed-direct when lane 0 never opens", async () => {
		const net = new FakeNet();
		net.block = true;
		const connect = createConnect({ ...timing, createPeerConnection: net.create });
		const [sa, sb] = signalPair();
		const results = await Promise.allSettled([
			connect({ signaling: sa, hello: hello("A") }),
			connect({ signaling: sb, hello: hello("B") }),
		]);
		for (const r of results) {
			expect(r.status).toBe("rejected");
			expect((r as PromiseRejectedResult).reason).toBeInstanceOf(FtError);
			expect((r as PromiseRejectedResult).reason.code).toBe("failed-direct");
		}
		expect(pcs(net).every((pc) => pc.iceConnectionState === "closed")).toBe(true);
	});

	it("signal-error when the mailbox throws a plain error; server codes pass through", async () => {
		const net = new FakeNet();
		const connect = createConnect({ ...timing, createPeerConnection: net.create });
		const [plain] = signalPair({ failSend: new TypeError("fetch failed") });
		await expect(connect({ signaling: plain, hello: hello("A") })).rejects.toMatchObject({ code: "signal-error" });
		const [coded] = signalPair({ failSend: new FtError("disabled") });
		await expect(connect({ signaling: coded, hello: hello("A") })).rejects.toMatchObject({ code: "disabled" });
		expect(pcs(net).every((pc) => pc.iceConnectionState === "closed")).toBe(true);
	});

	it("rejects with the abort reason and cleans up", async () => {
		const net = new FakeNet();
		const connect = createConnect({ ...timing, createPeerConnection: net.create });
		const [, sb] = signalPair();
		const ctl = new AbortController();
		const p = connect({ signaling: sb, hello: hello("B"), signal: ctl.signal });
		await sleep(20);
		ctl.abort(new Error("user cancelled"));
		await expect(p).rejects.toThrow("user cancelled");
		expect(pcs(net).every((pc) => pc.iceConnectionState === "closed")).toBe(true);
		const pre = new AbortController();
		pre.abort(new Error("already"));
		await expect(connect({ signaling: sb, hello: hello("B"), signal: pre.signal })).rejects.toThrow("already");
	});

	it("an unexpected handshake message is a signal-error", async () => {
		const net = new FakeNet();
		const connect = createConnect({ ...timing, createPeerConnection: net.create });
		const [sa] = signalPair();
		const wrong: Signaling = { ...sa, next: async () => ({ type: "offer", sdp: "fake 1 0" }) };
		await expect(connect({ signaling: wrong, hello: hello("A") })).rejects.toMatchObject({ code: "signal-error" });
	});
});
