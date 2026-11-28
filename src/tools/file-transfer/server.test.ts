// api/file-transfer.ts against the in-memory store (SPEC §16.1), plus the check that the API shapes and
// constants it copies stay in sync with types.ts and tuning.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as S from "../../../api/file-transfer.ts";
import { FileTransfer, handle, type Kv, memoryKv, networkOf, serve } from "../../../api/file-transfer.ts";
import { POLL, SERVER } from "./tuning.ts";
import type * as T from "./types.ts";
import { API_ERROR_STATUS, type ApiAction, type PollResult } from "./types.ts";

/* ---------- compile-time: the server's copies of the wire shapes equal types.ts */

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
const same = <_ extends true>() => true;
same<Equal<S.ApiAction, T.ApiAction>>();
same<Equal<S.ApiErrorCode, T.ApiErrorCode>>();
same<Equal<S.ClaimState, T.ClaimState>>();
same<Equal<S.GoneReason, T.GoneReason>>();
same<Equal<S.PeerEntry, T.PeerEntry>>();
same<Equal<S.Claim, T.Claim>>();
same<Equal<S.SignalMessage, T.SignalMessage>>();
same<Equal<S.PeerInfo, T.PeerInfo>>();
same<Equal<S.IncomingRequest, T.IncomingRequest>>();
same<Equal<S.OutgoingRequest, T.OutgoingRequest>>();
same<Equal<S.PollResult, T.PollResult>>();
same<Equal<S.ApiResponses, T.ApiResponses>>();

/* ---------- harness */

const MIN = 60_000;
const id = (n: number) => n.toString(16).padStart(16, "0");
const secretOf = (peer: string) => peer.padStart(32, "f");

/** A store whose commands are counted, a service on a clock the test moves, and an HTTP caller. */
function setup() {
	let t = 1_700_000_000_000;
	const clock = () => t;
	const base = memoryKv(clock);
	const log: { cmd: string; key: string }[] = [];
	const kv = new Proxy(base, {
		get(target, prop: keyof Kv) {
			const fn = target[prop] as (...a: unknown[]) => unknown;
			return (...args: unknown[]) => {
				log.push({ cmd: String(prop), key: String(args[0]) });
				return fn(...args);
			};
		},
	});
	const ft = new FileTransfer(kv, { salt: "test-salt", now: clock });
	const call = async (action: ApiAction | string, peer: string, body: object = {}, ip = "203.0.113.7") => {
		const res = await handle(
			new Request("http://x/api/file-transfer", {
				method: "POST",
				headers: { "x-real-ip": ip, "content-type": "application/json" },
				body: JSON.stringify({ action, peer, secret: secretOf(peer), ...body }),
			}),
			ft,
		);
		return { status: res.status, json: await res.json(), headers: res.headers };
	};
	const poll = async (peer: string, o: { hidden?: boolean; busy?: boolean; name?: string; ip?: string } = {}) => {
		const r = await call("poll", peer, { name: o.name ?? "", emoji: "", hidden: !!o.hidden, busy: !!o.busy }, o.ip);
		expect(r.status, JSON.stringify(r.json)).toBe(200);
		return r.json as PollResult;
	};
	/** Commands run by `fn`. */
	const count = async (fn: () => Promise<unknown>) => {
		const start = log.length;
		await fn();
		return log.slice(start).map((l) => l.cmd);
	};
	const hash = () => base.hgetall("toolbox:ft:peers");
	return { call, poll, count, hash, log, kv: base, advance: (ms: number) => (t += ms), now: clock };
}

const A = id(0xa);
const B = id(0xb);
const C = id(0xc);
const D = id(0xd);

async function connect(h: ReturnType<typeof setup>, from = A, to = B) {
	await h.poll(from);
	await h.poll(to);
	const r = await h.call("request", from, { to });
	expect(r.status).toBe(200);
	const pair = r.json.pair as string;
	expect((await h.call("respond", to, { pair, accept: true })).status).toBe(200);
	return pair;
}

afterEach(() => {
	vi.unstubAllEnvs();
	delete (globalThis as { __toolboxFt?: unknown }).__toolboxFt;
});

describe("file transfer server: constants and shapes", () => {
	it("copies tuning.ts SERVER, POLL and the error statuses exactly", () => {
		expect(S.SERVER).toEqual(SERVER);
		expect(S.POLL_MS).toEqual({ active: POLL.activeMs, idle: POLL.idleMs, hidden: POLL.hiddenMs });
		expect(S.API_ERROR_STATUS).toEqual(API_ERROR_STATUS);
	});

	it("answers poll with exactly the PollResult fields, and never leaks hashes", async () => {
		const h = setup();
		await h.poll(B);
		const r = await h.call("poll", A, { name: "", emoji: "", hidden: false, busy: false });
		expect(r.headers.get("cache-control")).toBe("no-store");
		expect(Object.keys(r.json).sort()).toEqual(["incoming", "limits", "outgoing", "peers", "you"]);
		expect(Object.keys(r.json.you).sort()).toEqual(["emoji", "hidden", "id", "name"]);
		expect(Object.keys(r.json.peers[0]).sort()).toEqual(["busy", "emoji", "id", "name", "near", "seen"]);
		const text = JSON.stringify(r.json);
		for (const secretish of ["auth", "net", "ip", "203.0.113"]) expect(text).not.toContain(`"${secretish}`);
		expect(r.json.limits.pollMs).toEqual({ active: 3000, idle: 10_000, hidden: 60_000 });
	});

	it("keeps every key under toolbox:ft:", async () => {
		const h = setup();
		const pair = await connect(h);
		await h.call("signal", A, { pair, to: B, payload: { type: "offer", sdp: "v=0" } });
		await h.call("read", B, { pair });
		await h.call("leave", A);
		expect(h.log.length).toBeGreaterThan(5);
		for (const { key } of h.log) expect(key).toMatch(/^toolbox:ft:/);
	});
});

describe("file transfer server: presence", () => {
	it("registers on the first poll with a stable default name, and proves ownership after", async () => {
		const h = setup();
		const first = await h.poll(A);
		expect(first.you).toEqual({
			id: A,
			name: expect.stringMatching(/^\w+ \w+$/),
			emoji: expect.any(String),
			hidden: false,
		});
		const again = await h.poll(A);
		expect(again.you.name).toBe(first.you.name);
		expect(S.defaultProfile(A)).toEqual({ name: first.you.name, emoji: first.you.emoji });

		const forged = await handle(
			new Request("http://x/", {
				method: "POST",
				body: JSON.stringify({
					action: "poll",
					peer: A,
					secret: "0".repeat(32),
					name: "",
					emoji: "",
					hidden: false,
					busy: false,
				}),
			}),
			new FileTransfer(h.kv, { salt: "test-salt", now: h.now }),
		);
		expect(forged.status).toBe(403);
		expect(await forged.json()).toEqual({ error: "auth" });
	});

	it("rejects malformed requests", async () => {
		const h = setup();
		expect((await h.call("poll", "nothex")).json).toEqual({ error: "bad-request" });
		expect((await h.call("dance", A)).json).toEqual({ error: "action" });
		expect((await h.call("poll", A, { name: "x", emoji: "", hidden: "no", busy: false })).status).toBe(400);
		expect((await h.call("request", A, { to: "B" })).status).toBe(400);
		const get = await handle(new Request("http://x/"), new FileTransfer(h.kv, { salt: "s" }));
		expect(get.status).toBe(405);
		const junk = await handle(
			new Request("http://x/", { method: "POST", body: "{" }),
			new FileTransfer(h.kv, { salt: "s" }),
		);
		expect(await junk.json()).toEqual({ error: "bad-request" });
	});

	it("cleans names and only takes animal emojis", async () => {
		const h = setup();
		const r = await h.call("poll", A, {
			name: "  Evil‮txt.exe\u0007 with a very long name indeed  ",
			emoji: "💣",
			hidden: false,
			busy: false,
		});
		expect(r.json.you.name).toBe("Eviltxt.exe with a very");
		expect(Array.from(r.json.you.name as string).length).toBeLessThanOrEqual(24);
		expect(r.json.you.emoji).toBe(S.defaultProfile(A).emoji);
		const ok = await h.call("poll", A, { name: "Calm Otter", emoji: "🦦", hidden: false, busy: false });
		expect(ok.json.you).toMatchObject({ name: "Calm Otter", emoji: "🦦" });
	});

	it("lists others: not me, not hidden, near first, then newest, at most 50", async () => {
		const h = setup();
		const home = "198.51.100.20";
		await h.poll(B, { ip: "192.0.2.1" });
		h.advance(1000);
		await h.poll(C, { ip: home });
		h.advance(1000);
		await h.poll(id(0xd), { ip: "192.0.2.2" });
		await h.poll(id(0xe), { ip: "192.0.2.3", hidden: true });
		const r = await h.poll(A, { ip: home });
		expect(r.peers.map((p) => p.id)).toEqual([C, id(0xd), B]);
		expect(r.peers.map((p) => p.near)).toEqual([true, false, false]);

		for (let i = 0; i < 60; i++) await h.poll(id(0x100 + i), { ip: `10.0.${i}.1` });
		expect((await h.poll(A, { ip: home })).peers).toHaveLength(50);
	});

	it("treats an IPv6 /64 as one network", async () => {
		expect(networkOf("2001:db8:1:2:aaaa::1")).toBe(networkOf("2001:db8:1:2:bbbb:cccc:dddd:eeee"));
		expect(networkOf("2001:db8:1:3::1")).not.toBe(networkOf("2001:db8:1:2::1"));
		expect(networkOf("::ffff:192.0.2.1")).toBe("192.0.2.1");
		const h = setup();
		await h.poll(B, { ip: "2001:db8:1:2::5" });
		expect((await h.poll(A, { ip: "2001:db8:1:2:9::9" })).peers[0].near).toBe(true);
	});

	it("marks busy peers: their own flag, or a live claim", async () => {
		const h = setup();
		await h.poll(C, { busy: true });
		await connect(h, A, B);
		const r = await h.poll(id(0xd));
		expect(Object.fromEntries(r.peers.map((p) => [p.id, p.busy]))).toEqual({ [A]: true, [B]: true, [C]: true });
	});

	it("drops peers 150 s after their last poll, and deletes their fields", async () => {
		const h = setup();
		await h.poll(B);
		h.advance(149_000);
		expect((await h.poll(A)).peers).toHaveLength(1);
		h.advance(2000);
		const cmds = await h.count(() => h.poll(A));
		expect(cmds).toEqual(["hgetall", "hset", "expire", "hdel"]);
		expect(Object.keys((await h.hash()) ?? {})).toEqual([A]);
	});

	it("caps peers in total (full) and per IP (too-many-here)", async () => {
		const h = setup();
		for (let i = 0; i < 6; i++) await h.poll(id(0x200 + i), { ip: "192.0.2.9" });
		const seventh = await h.call("poll", A, { name: "", emoji: "", hidden: false, busy: false }, "192.0.2.9");
		expect(seventh).toMatchObject({ status: 429, json: { error: "too-many-here" } });
		for (let i = 6; i < 100; i++) await h.poll(id(0x200 + i), { ip: `10.1.${i}.1` });
		const full = await h.call("poll", A, { name: "", emoji: "", hidden: false, busy: false }, "10.9.9.9");
		expect(full).toMatchObject({ status: 503, json: { error: "full" } });
		// Peers already in keep polling.
		await h.poll(id(0x200), { ip: "192.0.2.9" });
	});

	it("leave removes my field and my claims", async () => {
		const h = setup();
		await connect(h, A, B);
		expect((await h.call("leave", B)).json).toEqual({ ok: true });
		expect(Object.keys((await h.hash()) ?? {})).toEqual([A]);
		const r = await h.poll(A);
		expect(r.peers).toEqual([]);
		expect(r.outgoing).toBeNull();
	});
});

describe("file transfer server: requests", () => {
	it("refuses myself, unknown peers and busy peers", async () => {
		const h = setup();
		await h.poll(A);
		expect(await h.call("request", A, { to: A })).toMatchObject({ status: 400, json: { error: "self" } });
		expect(await h.call("request", A, { to: B })).toMatchObject({ status: 404, json: { error: "gone" } });
		await h.poll(B, { busy: true });
		expect(await h.call("request", A, { to: B })).toMatchObject({ status: 409, json: { error: "busy" } });
		// Not registered yet: no claim without proving ownership.
		expect((await h.call("request", C, { to: A })).json).toEqual({ error: "auth" });
	});

	it("lets exactly one of several racing requesters win", async () => {
		const h = setup();
		const ids = [A, B, C, id(0xd)];
		for (const p of ids) await h.poll(p);
		const results = await Promise.all(ids.slice(1).map((p) => h.call("request", p, { to: A })));
		expect(results.filter((r) => r.status === 200)).toHaveLength(1);
		expect(results.filter((r) => r.json.error === "busy")).toHaveLength(2);
		const winner = ids[1 + results.findIndex((r) => r.status === 200)];
		expect((await h.poll(A)).incoming?.from.id).toBe(winner);
	});

	it("is idempotent for the same requester", async () => {
		const h = setup();
		await h.poll(A);
		await h.poll(B);
		const one = await h.call("request", A, { to: B });
		const two = await h.call("request", A, { to: B });
		expect(two.json.pair).toBe(one.json.pair);
	});

	it("shows the claim to both ends; accept moves both to accepted", async () => {
		const h = setup();
		await h.poll(A);
		await h.poll(B);
		const { pair } = (await h.call("request", A, { to: B })).json;
		expect(pair).toMatch(/^[0-9a-f]{16}$/);
		const b = await h.poll(B);
		expect(b.incoming).toEqual({
			pair,
			from: { id: A, name: b.peers[0].name, emoji: b.peers[0].emoji },
			state: "pending",
			at: h.now(),
		});
		expect((await h.poll(A)).outgoing).toEqual({ pair, to: B, state: "pending" });
		expect((await h.call("respond", B, { pair: id(1), accept: true })).json).toEqual({ error: "gone" });
		expect((await h.call("respond", B, { pair, accept: true })).json).toEqual({ ok: true });
		expect((await h.poll(A)).outgoing).toEqual({ pair, to: B, state: "accepted" });
		expect((await h.poll(B)).incoming?.state).toBe("accepted");
	});

	it("tells a decline from an expiry, for 30 s", async () => {
		const h = setup();
		await h.poll(A);
		await h.poll(B);
		const { pair } = (await h.call("request", A, { to: B })).json;
		await h.call("respond", B, { pair, accept: false });
		expect((await h.poll(B)).incoming).toBeNull();
		expect((await h.poll(A)).outgoing).toEqual({ pair, to: B, state: "declined" });
		// B is free again at once.
		expect((await h.poll(C)).peers.find((p) => p.id === B)?.busy).toBe(false);
		h.advance(31_000);
		await h.poll(B);
		expect((await h.poll(A)).outgoing).toBeNull();

		const second = (await h.call("request", A, { to: B })).json.pair;
		h.advance(29_000);
		expect((await h.poll(A)).outgoing?.state).toBe("pending");
		h.advance(2000);
		await h.poll(B);
		expect((await h.poll(A)).outgoing).toEqual({ pair: second, to: B, state: "expired" });
		expect((await h.poll(B)).incoming).toBeNull();
	});

	it("lets a new requester take over a stale claim", async () => {
		const h = setup();
		await h.poll(A);
		await h.poll(B);
		await h.poll(C);
		await h.call("request", A, { to: B });
		h.advance(31_000);
		await h.poll(B);
		await h.poll(C);
		const cmds = await h.count(async () => expect((await h.call("request", C, { to: B })).status).toBe(200));
		expect(cmds).toEqual(["incr", "hgetall", "hdel", "hsetnx"]);
		expect((await h.poll(B)).incoming?.from.id).toBe(C);
	});

	it("accepts a mutual request at once; the lower peerId offers", async () => {
		for (const [first, second] of [
			[A, B],
			[B, A],
		]) {
			const h = setup();
			await h.poll(A);
			await h.poll(B);
			const p1 = (await h.call("request", first, { to: second })).json.pair;
			const p2 = (await h.call("request", second, { to: first })).json.pair;
			expect(p2).toBe(p1);
			const a = await h.poll(A);
			const b = await h.poll(B);
			// A < B: A is the requester of the surviving claim (its outgoing), B sees it as incoming.
			expect(a.outgoing).toEqual({ pair: p1, to: B, state: "accepted" });
			expect(a.incoming).toBeNull();
			expect(b.incoming).toMatchObject({ pair: p1, state: "accepted", from: { id: A } });
			expect(b.outgoing).toBeNull();
		}
	});

	it("resolves two requests that crossed in flight", async () => {
		const h = setup();
		await h.poll(A);
		await h.poll(B);
		const [ra, rb] = await Promise.all([h.call("request", A, { to: B }), h.call("request", B, { to: A })]);
		expect(ra.status).toBe(200);
		expect(rb.status).toBe(200);
		const b = await h.poll(B);
		const a = await h.poll(A);
		expect(a.outgoing).toEqual({ pair: ra.json.pair, to: B, state: "accepted" });
		expect(b.incoming).toMatchObject({ pair: ra.json.pair, state: "accepted" });
		expect(b.outgoing).toBeNull();
	});

	it("a new request replaces my earlier pending one", async () => {
		const h = setup();
		await h.poll(A);
		await h.poll(B);
		await h.poll(C);
		await h.call("request", A, { to: B });
		await h.call("request", A, { to: C });
		expect((await h.poll(B)).incoming).toBeNull();
		expect((await h.poll(C)).incoming?.from.id).toBe(A);
	});

	it("keeps a connected claim while the target polls, and drops it 90 s after", async () => {
		const h = setup();
		const pair = await connect(h);
		expect((await h.call("connected", C, { pair })).json).toEqual({ error: "auth" });
		expect((await h.call("connected", A, { pair })).json).toEqual({ ok: true });
		for (let i = 0; i < 10; i++) {
			h.advance(60_000);
			await h.poll(A);
			await h.poll(B);
		}
		expect((await h.poll(A)).outgoing).toEqual({ pair, to: B, state: "connected" });
		// B's tab freezes (its entry lives 150 s); the claim goes after 90 s.
		h.advance(91_000);
		await h.poll(A);
		expect((await h.poll(A)).outgoing).toBeNull();
	});

	it("release by either side frees both", async () => {
		const h = setup();
		const pair = await connect(h);
		await h.call("connected", B, { pair });
		expect((await h.call("release", B, { pair })).json).toEqual({ ok: true });
		const a = await h.poll(A);
		expect(a.outgoing).toBeNull();
		expect(a.peers[0].busy).toBe(false);
		expect((await h.call("release", A, { pair })).json).toEqual({ ok: true });
	});

	it("release with gone: the other end shows free, and goes 20 s later unless it polls", async () => {
		const h = setup();
		const pair = await connect(h);
		await h.call("connected", A, { pair });
		await h.poll(B, { busy: true });
		await h.poll(A, { busy: true });
		// B's tab was closed without leave (iOS); A's session ends by loss.
		expect((await h.call("release", A, { pair, gone: true })).json).toEqual({ ok: true });
		const seen = (await h.poll(A)).peers.find((p) => p.id === B);
		expect(seen?.busy).toBe(false);
		h.advance(SERVER.peerGoneGraceMs + 1000);
		expect((await h.poll(A)).peers.some((p) => p.id === B)).toBe(false);

		// A live page polls within the grace and stays listed.
		const pair2 = await connect(h, A, C);
		await h.call("release", A, { pair: pair2, gone: true });
		h.advance(SERVER.peerGoneGraceMs - 5000);
		await h.poll(C);
		h.advance(10_000);
		expect((await h.poll(A)).peers.some((p) => p.id === C)).toBe(true);

		// Only the ends of the pair can do this to each other.
		const pair3 = await connect(h, A, C);
		await h.poll(D);
		await h.call("release", D, { pair: pair3, gone: true });
		h.advance(SERVER.peerGoneGraceMs + 1000);
		await h.poll(C);
		await h.poll(A);
		expect((await h.poll(D)).peers.map((p) => p.id).sort()).toEqual([A, C].sort());
	});

	it("rate-limits request, respond and signal per IP: 60 a minute", async () => {
		const h = setup();
		await h.poll(A);
		for (let i = 0; i < 60; i++) await h.call("request", A, { to: id(0x999) });
		expect(await h.call("request", A, { to: B })).toMatchObject({ status: 429, json: { error: "slow-down" } });
		// Polls are never limited; another IP isn't affected; the next minute starts afresh.
		await h.poll(A);
		expect((await h.call("request", A, { to: B }, "192.0.2.200")).json).toEqual({ error: "gone" });
		h.advance(MIN);
		expect((await h.call("request", A, { to: B })).json).toEqual({ error: "gone" });
	});
});

describe("file transfer server: signaling", () => {
	it("delivers offer and answer once each, between the pair's two ends", async () => {
		const h = setup();
		const pair = await connect(h);
		await h.poll(C);
		const offer = { type: "offer", sdp: "v=0 offer" };
		expect((await h.call("signal", A, { pair, to: B, payload: offer })).json).toEqual({ ok: true });
		expect((await h.call("read", A, { pair })).json).toEqual({ payload: null });
		expect((await h.call("read", B, { pair })).json).toEqual({ payload: offer });
		expect((await h.call("read", B, { pair })).json).toEqual({ payload: null });
		const answer = { type: "answer", sdp: "v=0 answer" };
		await h.call("signal", B, { pair, to: A, payload: answer });
		expect((await h.call("read", A, { pair })).json).toEqual({ payload: answer });
		expect((await h.call("read", C, { pair: id(5) })).json).toEqual({ payload: null });
	});

	it("checks the pair, the ends and the payload", async () => {
		const h = setup();
		await h.poll(A);
		await h.poll(B);
		await h.poll(C);
		const pending = (await h.call("request", A, { to: B })).json.pair;
		const offer = { type: "offer", sdp: "v=0" };
		expect((await h.call("signal", A, { pair: pending, to: B, payload: offer })).json).toEqual({ error: "gone" });
		await h.call("respond", B, { pair: pending, accept: true });
		const pair = pending;
		expect((await h.call("signal", C, { pair, to: B, payload: offer })).json).toEqual({ error: "gone" });
		expect((await h.call("signal", A, { pair, to: C, payload: offer })).json).toEqual({ error: "gone" });
		expect((await h.call("signal", A, { pair, to: A, payload: offer })).json).toEqual({ error: "gone" });
		expect((await h.call("signal", A, { pair: id(7), to: B, payload: offer })).json).toEqual({ error: "gone" });
		expect((await h.call("signal", A, { pair, to: B, payload: { type: "x", sdp: "" } })).status).toBe(400);
		const big = await h.call("signal", A, { pair, to: B, payload: { type: "offer", sdp: "x".repeat(16 * 1024) } });
		expect(big).toMatchObject({ status: 413, json: { error: "too-big" } });
		const fits = await h.call("signal", A, {
			pair,
			to: B,
			payload: { type: "offer", sdp: "x".repeat(16 * 1024 - 40) },
		});
		expect(fits.json).toEqual({ ok: true });
		// A forged read is refused.
		const forged = await handle(
			new Request("http://x/", {
				method: "POST",
				body: JSON.stringify({ action: "read", peer: B, secret: "1".repeat(32), pair }),
			}),
			new FileTransfer(h.kv, { salt: "test-salt", now: h.now }),
		);
		expect(forged.status).toBe(403);
	});

	it("allows at most 8 signal writes per pair", async () => {
		const h = setup();
		const pair = await connect(h);
		const offer = { type: "offer", sdp: "v=0" };
		for (let i = 0; i < 8; i++) expect((await h.call("signal", A, { pair, to: B, payload: offer })).status).toBe(200);
		expect(await h.call("signal", B, { pair, to: A, payload: offer })).toMatchObject({
			status: 429,
			json: { error: "too-many" },
		});
		// The counter field goes with the claim.
		await h.call("release", A, { pair });
		expect(Object.keys((await h.hash()) ?? {}).sort()).toEqual([A, B]);
	});

	it("expires mailbox messages after 60 s", async () => {
		const h = setup();
		const pair = await connect(h);
		await h.call("signal", A, { pair, to: B, payload: { type: "offer", sdp: "v=0" } });
		h.advance(61_000);
		expect((await h.call("read", B, { pair })).json).toEqual({ payload: null });
	});
});

describe("file transfer server: Redis commands per action (§6.3)", () => {
	it("stays within the spec's budget", async () => {
		const h = setup();
		const counts: Record<string, string[]> = {};
		await h.poll(B);
		counts.poll = await h.count(() => h.poll(A));
		counts["request (first write this minute)"] = await h.count(() => h.call("request", A, { to: B }));
		const { pair } = (await h.call("request", A, { to: B })).json;
		counts.respond = await h.count(() => h.call("respond", B, { pair, accept: true }));
		counts.signal = await h.count(() => h.call("signal", A, { pair, to: B, payload: { type: "offer", sdp: "v=0" } }));
		counts.read = await h.count(() => h.call("read", B, { pair }));
		counts.connected = await h.count(() => h.call("connected", A, { pair }));
		counts.release = await h.count(() => h.call("release", A, { pair }));
		counts.leave = await h.count(() => h.call("leave", A));

		expect(counts).toEqual({
			poll: ["hgetall", "hset", "expire"],
			"request (first write this minute)": ["incr", "expire", "hgetall", "hsetnx"],
			respond: ["incr", "hgetall", "hset"],
			signal: ["incr", "hgetall", "hincrby", "set"],
			read: ["hget", "getdel"],
			connected: ["hgetall", "hset"],
			release: ["hgetall", "hdel"],
			leave: ["hgetall", "hdel"],
		});
	});
});

describe("file transfer server: deployment switches", () => {
	const req = () =>
		new Request("http://x/api/file-transfer", {
			method: "POST",
			body: JSON.stringify({
				action: "poll",
				peer: A,
				secret: secretOf(A),
				name: "",
				emoji: "",
				hidden: false,
				busy: false,
			}),
		});

	it("FILE_TRANSFER_DISABLED=1 answers 503 disabled without a store", async () => {
		vi.stubEnv("FILE_TRANSFER_DISABLED", "1");
		const res = await serve(req());
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "disabled" });
		expect((globalThis as { __toolboxFt?: unknown }).__toolboxFt).toBeUndefined();
	});

	it("refuses to run in production without FILE_TRANSFER_IP_SALT, or without a store", async () => {
		vi.stubEnv("FILE_TRANSFER_DISABLED", "");
		vi.stubEnv("VERCEL", "1");
		vi.stubEnv("FILE_TRANSFER_IP_SALT", "");
		for (const n of ["ROOM_KV_REST_API_URL", "KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"]) vi.stubEnv(n, "");
		for (const n of ["ROOM_KV_REST_API_TOKEN", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"]) vi.stubEnv(n, "");
		expect(await (await serve(req())).json()).toEqual({ error: "no-store" });
		vi.stubEnv("ROOM_KV_REST_API_URL", "https://example.invalid");
		vi.stubEnv("ROOM_KV_REST_API_TOKEN", "token");
		const res = await serve(req());
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "no-salt" });
	});

	it("runs on a per-process salt and the memory store in dev", async () => {
		vi.stubEnv("FILE_TRANSFER_DISABLED", "");
		vi.stubEnv("VERCEL", "");
		vi.stubEnv("FILE_TRANSFER_IP_SALT", "");
		for (const n of ["ROOM_KV_REST_API_URL", "KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"]) vi.stubEnv(n, "");
		const res = await serve(req());
		expect(res.status).toBe(200);
		expect((await res.json()).you.id).toBe(A);
	});
});
