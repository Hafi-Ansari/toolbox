// presence.ts: the poll state machine (§6.5) against the real handler, on a clock the test drives.
import { describe, expect, it, vi } from "vitest";
import { FileTransfer, handle, memoryKv } from "../../../api/file-transfer.ts";
import { createApiClient } from "./client.ts";
import { createPresence, type PresenceEnv } from "./presence.ts";
import { AWAY_AFTER_MS, IDLE_AFTER_MS } from "./tuning.ts";
import { type ApiAction, type ApiClient, FtError, type Identity, type Profile } from "./types.ts";

/** A manual clock and timer queue shared by the server and every page. */
class Clock {
	t = 1_700_000_000_000;
	private timers = new Map<number, { at: number; fn: () => void }>();
	private seq = 0;
	inflight = 0;
	now = () => this.t;
	setTimeout = (fn: () => void, ms: number) => {
		const id = ++this.seq;
		this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
		return id;
	};
	clearTimeout = (id: unknown) => void this.timers.delete(id as number);
	/** Lets real async work (crypto, the handler) finish. */
	async settle() {
		for (let i = 0; i < 2000; i++) {
			await new Promise((r) => setImmediate(r));
			if (this.inflight === 0 && i > 3) return;
		}
	}
	async advance(ms: number) {
		const end = this.t + ms;
		await this.settle();
		for (;;) {
			let next: [number, { at: number; fn: () => void }] | null = null;
			for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
			if (!next) break;
			this.timers.delete(next[0]);
			this.t = Math.max(this.t, next[1].at);
			next[1].fn();
			await this.settle();
		}
		this.t = end;
		await this.settle();
	}
}

interface Call {
	action: ApiAction | "leave-beacon";
	at: number;
	body: Record<string, unknown>;
}

function world() {
	const clock = new Clock();
	const ft = new FileTransfer(memoryKv(clock.now), { salt: "s", now: clock.now });

	function page(n: number, profile: Partial<Profile> = {}) {
		const identity: Identity = { peer: n.toString(16).padStart(16, "0"), secret: n.toString(16).padStart(32, "0") };
		const calls: Call[] = [];
		const real = createApiClient(identity, {
			fetch: (async (url: RequestInfo | URL, init?: RequestInit) =>
				handle(new Request(new URL(String(url), "http://x"), init), ft)) as typeof fetch,
		});
		const api: ApiClient = {
			call: (async (action: ApiAction, body: Record<string, unknown>) => {
				calls.push({ action, at: clock.t, body });
				clock.inflight++;
				try {
					return await real.call(action, body as never);
				} finally {
					clock.inflight--;
				}
			}) as ApiClient["call"],
			leaveBeacon() {
				calls.push({ action: "leave-beacon", at: clock.t, body: {} });
				// Same request as the real beacon, but tracked so the clock waits for it.
				clock.inflight++;
				void real
					.call("leave", {})
					.catch(() => {})
					.finally(() => clock.inflight--);
			},
		};
		let hidden = false;
		const handlers = new Map<string, Set<() => void>>();
		const env: PresenceEnv = {
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			hidden: () => hidden,
			listen(event, fn) {
				const set = handlers.get(event) ?? new Set();
				handlers.set(event, set);
				set.add(fn);
				return () => set.delete(fn);
			},
		};
		const fire = (event: "interaction" | "visibility" | "pagehide") => {
			for (const fn of handlers.get(event) ?? []) fn();
		};
		const store = vi.fn();
		const presence = createPresence({
			api,
			identity,
			profile: { name: "", emoji: "", hidden: false, ...profile },
			env,
			store,
		});
		return {
			id: identity.peer,
			presence,
			calls,
			store,
			fire,
			setHidden(h: boolean) {
				hidden = h;
				fire("visibility");
			},
			polls: (from = 0, to = Number.POSITIVE_INFINITY) =>
				calls.filter((c) => c.action === "poll" && c.at >= from && c.at <= to).map((c) => c.at),
			snap: () => presence.snapshot(),
		};
	}
	return { clock, page };
}

const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i]);

describe("presence: poll tiers", () => {
	it("polls at once, every 3 s while active, every 10 s once idle, and 3 s again on interaction", async () => {
		const { clock, page } = world();
		const t0 = clock.t;
		const a = page(0xa);
		await clock.advance(0);
		expect(a.polls()).toEqual([t0]);
		expect(a.snap().me).toMatchObject({ id: a.id, name: expect.stringMatching(/^\w+ \w+$/) });
		// The server's default name is kept for next time.
		expect(a.store).toHaveBeenCalledWith(expect.objectContaining({ name: a.snap().me?.name }));
		expect(a.snap().state).toBe("active");

		await clock.advance(9000);
		expect(gaps(a.polls())).toEqual([3000, 3000, 3000]);

		await clock.advance(IDLE_AFTER_MS);
		expect(a.snap().state).toBe("idle");
		const idle = a.polls(t0 + IDLE_AFTER_MS + 3000);
		expect(gaps(idle).every((g) => g === 10_000)).toBe(true);

		a.fire("interaction");
		expect(a.snap().state).toBe("active");
		const before = clock.t;
		await clock.advance(6000);
		expect(gaps(a.polls(before - 10_000))).toContain(3000);
	});

	it("slows to 60 s in a hidden tab, and to 10 s when switched to Hidden (60 s once the tab hides too)", async () => {
		const { clock, page } = world();
		const a = page(0xa);
		await clock.advance(0);
		a.setHidden(true);
		expect(a.snap().state).toBe("hidden");
		let start = clock.t;
		await clock.advance(180_000);
		expect(gaps(a.polls(start - 3000))).toEqual([60_000, 60_000, 60_000]);

		a.setHidden(false);
		a.presence.setProfile({ hidden: true });
		expect(a.snap().state).toBe("off");
		await clock.advance(0);
		const last = a.calls.at(-1);
		expect(last?.action).toBe("poll");
		expect(last?.body.hidden).toBe(true);
		start = clock.t;
		await clock.advance(60_000);
		expect(new Set(gaps(a.polls(start + 1)))).toEqual(new Set([10_000]));
		a.setHidden(true);
		await clock.advance(10_000);
		start = clock.t;
		await clock.advance(180_000);
		expect(new Set(gaps(a.polls(start + 1)))).toEqual(new Set([60_000]));
		expect(a.store).toHaveBeenLastCalledWith(expect.objectContaining({ hidden: true }));
	});

	it("goes away after 2 h without interaction: leave, no polling, until wake()", async () => {
		const { clock, page } = world();
		const a = page(0xa);
		const b = page(0xb);
		await clock.advance(AWAY_AFTER_MS - 60_000);
		b.fire("interaction");
		await clock.advance(120_000);
		expect(a.snap().state).toBe("away");
		expect(b.snap().state).not.toBe("away");
		expect(a.calls.filter((c) => c.action === "leave")).toHaveLength(1);
		const awayAt = a.calls.find((c) => c.action === "leave")?.at ?? 0;
		b.fire("interaction");
		await clock.advance(10 * 60_000);
		expect(a.polls(awayAt + 1)).toEqual([]);
		expect(b.snap().peers).toEqual([]);

		a.presence.wake();
		await clock.advance(3000);
		expect(a.snap().state).toBe("active");
		expect(a.polls(awayAt + 1).length).toBeGreaterThan(0);
		b.fire("interaction");
		await clock.advance(3000);
		expect(b.snap().peers.map((p) => p.id)).toEqual([a.id]);
	});

	it("sends leave on pagehide and on stop()", async () => {
		const { clock, page } = world();
		const a = page(0xa);
		await clock.advance(0);
		a.fire("pagehide");
		expect(a.calls.at(-1)?.action).toBe("leave-beacon");
		a.presence.stop();
		expect(a.calls.filter((c) => c.action === "leave-beacon")).toHaveLength(2);
		const n = a.calls.length;
		await clock.advance(60_000);
		expect(a.calls).toHaveLength(n);
	});

	it("reports page-level errors and retries slowly", async () => {
		const { clock } = world();
		const calls: number[] = [];
		const api: ApiClient = {
			call: (async () => {
				calls.push(clock.t);
				throw new FtError("disabled");
			}) as ApiClient["call"],
			leaveBeacon() {},
		};
		const env: PresenceEnv = {
			now: clock.now,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
			hidden: () => false,
			listen: () => () => {},
		};
		const p = createPresence({
			api,
			identity: { peer: "1".repeat(16), secret: "1".repeat(32) },
			profile: { name: "", emoji: "", hidden: false },
			env,
			store: () => {},
		});
		await clock.advance(120_000);
		expect(p.snapshot().error).toBe("disabled");
		expect(gaps(calls)).toEqual([60_000, 60_000]);
		p.stop();
	});
});

describe("presence: requests and the handshake", () => {
	async function two() {
		const w = world();
		const a = w.page(0xa);
		const b = w.page(0xb);
		await w.clock.advance(3000);
		return { ...w, a, b };
	}

	it("request → accept → handshake → connected → end", async () => {
		const { clock, a, b } = await two();
		expect(a.snap().peers.map((p) => p.id)).toEqual([b.id]);
		const pair = await a.presence.request(b.id);
		expect(a.snap()).toMatchObject({ state: "pending", outgoing: { pair, to: b.id, state: "pending" } });
		const asked = clock.t;
		await clock.advance(3000);
		expect(gaps(a.polls(asked + 1))).toEqual([1000, 1000]);
		expect(b.snap()).toMatchObject({ state: "pending", incoming: { pair, from: { id: a.id }, state: "pending" } });

		await b.presence.respond(true);
		expect(b.snap()).toMatchObject({
			state: "handshake",
			incoming: null,
			handshake: { pair, offerer: false, remote: { id: a.id } },
		});
		await clock.advance(1000);
		expect(a.snap()).toMatchObject({
			state: "handshake",
			outgoing: null,
			handshake: { pair, offerer: true, remote: { id: b.id, name: b.snap().me?.name } },
		});
		// Handshake polls every 3 s and reports busy.
		const hs = clock.t;
		await clock.advance(6000);
		expect(gaps(a.polls(hs + 1))).toEqual([3000]);
		expect(a.calls.filter((c) => c.action === "poll").at(-1)?.body.busy).toBe(true);

		await a.presence.markConnected();
		await b.presence.markConnected();
		expect(a.snap().state).toBe("connected");
		const conn = clock.t;
		await clock.advance(30_000);
		expect(gaps(a.polls(conn + 1))).toEqual([10_000, 10_000]);
		// Long transfers don't count as away, and the claim stays up.
		await clock.advance(AWAY_AFTER_MS + 60_000);
		expect(a.snap().state).toBe("connected");
		expect(a.snap().handshake?.pair).toBe(pair);

		await a.presence.endSession();
		expect(a.snap()).toMatchObject({ state: "active", handshake: null });
		expect(a.calls.at(-1)).toMatchObject({ action: "release", body: { pair } });
	});

	it("reports a decline, an expiry and a peer that left", async () => {
		const { clock, a, b } = await two();
		await a.presence.request(b.id);
		await clock.advance(3000);
		await b.presence.respond(false);
		expect(b.snap().incoming).toBeNull();
		await clock.advance(1000);
		expect(a.snap()).toMatchObject({ outgoing: null, outcome: { to: b.id, code: "declined" } });

		await a.presence.request(b.id);
		expect(a.snap().outcome).toBeNull();
		await clock.advance(31_000);
		expect(a.snap()).toMatchObject({ outgoing: null, outcome: { to: b.id, code: "expired" } });
		expect(b.snap().incoming).toBeNull();
		expect(b.snap().state).not.toBe("pending");

		await a.presence.request(b.id);
		b.presence.stop();
		await clock.advance(1000);
		expect(a.snap().outcome).toEqual({ to: b.id, code: "gone" });
		await expect(a.presence.request(b.id)).rejects.toMatchObject({ code: "gone" });
		expect(a.snap().outcome).toEqual({ to: b.id, code: "gone" });
	});

	it("cancelRequest releases the claim", async () => {
		const { clock, a, b } = await two();
		await a.presence.request(b.id);
		await a.presence.cancelRequest();
		expect(a.snap().outgoing).toBeNull();
		await clock.advance(3000);
		expect(b.snap().incoming).toBeNull();
		expect(a.snap().outcome).toBeNull();
	});

	it("turns a mutual request into one handshake where the lower peerId offers", async () => {
		const { clock, a, b } = await two();
		await Promise.all([a.presence.request(b.id), b.presence.request(a.id)]);
		await clock.advance(2000);
		const ha = a.snap().handshake;
		const hb = b.snap().handshake;
		expect(ha?.pair).toBeDefined();
		expect(hb?.pair).toBe(ha?.pair);
		expect(ha?.offerer).toBe(true);
		expect(hb?.offerer).toBe(false);
		expect(a.snap().outcome).toBeNull();
		expect(b.snap().outcome).toBeNull();
	});

	it("gives up a handshake that never connects after 30 s", async () => {
		const { clock, a, b } = await two();
		const pair = await a.presence.request(b.id);
		await clock.advance(3000);
		expect(b.snap().incoming?.pair).toBe(pair);
		await b.presence.respond(true);
		await clock.advance(31_000);
		expect(b.snap().handshake).toBeNull();
		expect(b.calls.some((c) => c.action === "release" && c.body.pair === pair)).toBe(true);
		// The other side sees the claim go and drops its handshake too.
		await clock.advance(3000);
		expect(a.snap().handshake).toBeNull();
	});
});
