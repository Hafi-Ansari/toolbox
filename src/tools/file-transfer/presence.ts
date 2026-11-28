// Presence: the poll state machine of SPEC §6.5. One per page. It polls api/file-transfer.ts at the
// rate the page's state allows, tracks requests both ways, and reports the handshake once either
// side accepts. Lane 0's `read` polling during the handshake belongs to Signaling (client.ts).
//
//   active    visible, interaction within 2 min        3 s (server's limits.pollMs.active)
//   idle      visible, no interaction for 2 min        10 s
//   hidden    document.hidden                          60 s
//   off       the Hidden switch is on                  60 s, with hidden: true
//   pending   a request either way is waiting          1 s, for at most 60 s
//   handshake accepted, lane 0 not open yet            3 s, ended after 30 s
//   connected lanes open                               10 s (60 s while the tab is hidden)
//   away      2 h without interaction                  no polling; `leave` sent; wake() resumes
import { saveProfile } from "./client.ts";
import { AWAY_AFTER_MS, IDLE_AFTER_MS, POLL } from "./tuning.ts";
import {
	type ApiClient,
	FtError,
	type FtErrorCode,
	type Handshake,
	type Identity,
	type IncomingRequest,
	type OutgoingRequest,
	type PairId,
	type PeerId,
	type PeerRef,
	type PollResult,
	type Presence,
	type PresenceSnapshot,
	type PresenceState,
	type Profile,
} from "./types.ts";

/** The browser bits presence depends on, so tests can drive it. */
export interface PresenceEnv {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	hidden(): boolean;
	/**
	 * `interaction`: pointerdown or keydown. `visibility`: visibilitychange (either way).
	 * `pagehide`: the page is going away. Returns an unsubscribe.
	 */
	listen(event: "interaction" | "visibility" | "pagehide", fn: () => void): () => void;
}

export function browserEnv(): PresenceEnv {
	return {
		now: () => Date.now(),
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
		hidden: () => document.hidden,
		listen(event, fn) {
			const targets: [EventTarget, string][] =
				event === "interaction"
					? [
							[window, "pointerdown"],
							[window, "keydown"],
						]
					: event === "visibility"
						? [[document, "visibilitychange"]]
						: [[window, "pagehide"]];
			for (const [t, e] of targets) t.addEventListener(e, fn, { passive: true, capture: true });
			return () => {
				for (const [t, e] of targets) t.removeEventListener(e, fn, { capture: true });
			};
		},
	};
}

export interface PresenceOptions {
	api: ApiClient;
	identity: Identity;
	/** From `loadIdentity()`. An empty name or emoji takes the server's default on the first poll. */
	profile: Profile;
	env?: PresenceEnv;
	/** Persists profile changes (default: `saveProfile` into localStorage). */
	store?: (profile: Profile) => void;
}

/** Poll failures that won't fix themselves soon: retry at the slowest rate. */
const SLOW_ERRORS: ReadonlySet<FtErrorCode> = new Set([
	"disabled",
	"full",
	"too-many-here",
	"auth",
	"no-salt",
	"no-store",
]);

const codeOf = (e: unknown): FtErrorCode => (e instanceof FtError ? e.code : "signal-error");

export function createPresence(opts: PresenceOptions): Presence {
	const { api, identity } = opts;
	const env = opts.env ?? browserEnv();
	const store = opts.store ?? ((p: Profile) => saveProfile(identity, p));
	let profile: Profile = { ...opts.profile };

	let snap: PresenceSnapshot = {
		state: "active",
		me: null,
		peers: [],
		incoming: null,
		outgoing: null,
		handshake: null,
		outcome: null,
		error: null,
	};
	const listeners = new Set<(s: PresenceSnapshot) => void>();

	let pollMs: PollResult["limits"]["pollMs"] = { active: POLL.activeMs, idle: POLL.idleMs, hidden: POLL.hiddenMs };
	let lastInteraction = env.now();
	let lastPollAt = Number.NEGATIVE_INFINITY;
	let timer: unknown = null;
	let polling = false;
	/** Poll again as soon as the current one returns (the profile changed mid-poll). */
	let again = false;
	let stopped = false;
	let away = false;
	let connected = false;
	let handshakeAt = 0;
	let pendingSince: number | null = null;
	/** When my current request was made: a poll started before it can't speak for it. */
	let requestedAt = 0;
	/** Pairs this side ended (cancelled, declined, released): stale poll answers about them are ignored. */
	const ended = new Set<PairId>();
	/** Names of peers seen, so a handshake can name its remote after it leaves the list. */
	const known = new Map<PeerId, PeerRef>();

	const emit = (patch: Partial<PresenceSnapshot>) => {
		snap = { ...snap, ...patch };
		snap.state = stateNow();
		for (const l of listeners) l(snap);
	};

	function pending(): boolean {
		const waiting = snap.outgoing?.state === "pending" || snap.incoming?.state === "pending";
		return waiting && pendingSince !== null && env.now() - pendingSince < POLL.pendingMaxMs;
	}

	function stateNow(): PresenceState {
		if (away) return "away";
		if (snap.handshake) return connected ? "connected" : "handshake";
		if (pending()) return "pending";
		if (profile.hidden) return "off";
		if (env.hidden()) return "hidden";
		return env.now() - lastInteraction >= IDLE_AFTER_MS ? "idle" : "active";
	}

	function interval(state: PresenceState): number {
		switch (state) {
			case "active":
				return pollMs.active;
			case "idle":
				return pollMs.idle;
			case "hidden":
			case "off":
			case "away":
				return pollMs.hidden;
			case "pending":
				return POLL.pendingMs;
			case "handshake":
				return POLL.handshakePollMs;
			case "connected":
				return env.hidden() ? POLL.connectedHiddenMs : POLL.connectedMs;
		}
	}

	/** (Re)arms the poll timer for the current state. */
	function schedule() {
		if (stopped) return;
		if (timer !== null) env.clearTimeout(timer);
		timer = null;
		const now = env.now();
		if (!away && !snap.handshake && now - lastInteraction >= AWAY_AFTER_MS) return goAway();
		const state = stateNow();
		if (state !== snap.state) emit({});
		if (away || polling) return;
		let ms = interval(state);
		if (snap.error) ms = Math.max(ms, SLOW_ERRORS.has(snap.error) ? POLL.hiddenMs : POLL.idleMs);
		timer = env.setTimeout(tick, Math.max(0, lastPollAt + ms - now));
	}

	function tick() {
		timer = null;
		if (stopped || away) return;
		if (!snap.handshake && env.now() - lastInteraction >= AWAY_AFTER_MS) return goAway();
		if (snap.handshake && !connected && env.now() - handshakeAt >= POLL.handshakeMaxMs) {
			// Lane 0 never opened: give the claim back. The connector reports failed-direct itself.
			void presence.endSession();
			return;
		}
		void poll();
	}

	async function poll() {
		if (polling) {
			again = true;
			return;
		}
		polling = true;
		const startedAt = env.now();
		lastPollAt = startedAt;
		try {
			const r = await api.call("poll", { ...profile, busy: snap.handshake !== null });
			if (!stopped && !away) apply(r, startedAt);
		} catch (e) {
			if (!stopped) emit({ error: codeOf(e) });
		} finally {
			polling = false;
			if (again) {
				again = false;
				lastPollAt = Number.NEGATIVE_INFINITY;
			}
			schedule();
		}
	}

	function apply(r: PollResult, startedAt: number) {
		const p = r.limits?.pollMs;
		if (p && p.active > 0 && p.idle > 0 && p.hidden > 0) pollMs = { ...p };
		if (!profile.name || !profile.emoji) {
			profile = { ...profile, name: profile.name || r.you.name, emoji: profile.emoji || r.you.emoji };
			store(profile);
		}
		for (const peer of r.peers) known.set(peer.id, { id: peer.id, name: peer.name, emoji: peer.emoji });
		if (r.incoming) known.set(r.incoming.from.id, r.incoming.from);

		const patch: Partial<PresenceSnapshot> = { me: r.you, peers: r.peers, error: null };
		let incoming: IncomingRequest | null = r.incoming && !ended.has(r.incoming.pair) ? r.incoming : null;
		let outgoing: OutgoingRequest | null = r.outgoing && !ended.has(r.outgoing.pair) ? r.outgoing : null;
		const fresh = startedAt >= requestedAt;

		// How my request ended (§11): declined, expired, or the peer left (its claim vanished).
		if (outgoing && (outgoing.state === "declined" || outgoing.state === "expired")) {
			ended.add(outgoing.pair);
			// An accepted claim that timed out mid-handshake is the connector's failure to report, not a "no answer".
			if (outgoing.pair !== snap.handshake?.pair) patch.outcome = { to: outgoing.to, code: outgoing.state };
			outgoing = null;
		}
		let handshake = snap.handshake;
		if (handshake && !connected && startedAt > handshakeAt) {
			// The other side released the claim before lane 0 opened.
			if (outgoing?.pair !== handshake.pair && incoming?.pair !== handshake.pair) {
				ended.add(handshake.pair);
				handshake = null;
			}
		}
		if (!handshake) {
			// Accepted either way. The claim's requester offers (on a mutual request the server keeps
			// the lower peerId's claim, so that one offers, §6.3).
			if (outgoing && (outgoing.state === "accepted" || outgoing.state === "connected"))
				handshake = {
					pair: outgoing.pair,
					remote: known.get(outgoing.to) ?? { id: outgoing.to, name: "", emoji: "" },
					offerer: true,
				};
			else if (incoming && (incoming.state === "accepted" || incoming.state === "connected"))
				handshake = { pair: incoming.pair, remote: incoming.from, offerer: false };
			if (handshake) {
				handshakeAt = env.now();
				connected = false;
			}
		}
		const asked = snap.outgoing;
		if (
			asked?.state === "pending" &&
			fresh &&
			!patch.outcome &&
			outgoing?.pair !== asked.pair &&
			incoming?.pair !== asked.pair &&
			!ended.has(asked.pair) &&
			// Crossed requests: the server kept the other claim, and we're connecting anyway.
			handshake?.remote.id !== asked.to &&
			incoming?.from.id !== asked.to
		) {
			ended.add(asked.pair);
			patch.outcome = { to: asked.to, code: "gone" };
		}

		if (handshake) {
			// Once connecting, the request panels are done.
			if (incoming?.pair === handshake.pair) incoming = null;
			if (outgoing?.pair === handshake.pair) outgoing = null;
		}

		const waiting = outgoing?.state === "pending" || incoming?.state === "pending";
		if (!waiting) pendingSince = null;
		else if (pendingSince === null || (incoming && incoming.pair !== snap.incoming?.pair)) pendingSince = env.now();

		emit({ ...patch, incoming, outgoing, handshake });
	}

	function goAway() {
		away = true;
		if (timer !== null) env.clearTimeout(timer);
		timer = null;
		for (const r of [snap.incoming, snap.outgoing]) if (r) ended.add(r.pair);
		pendingSince = null;
		emit({ incoming: null, outgoing: null, peers: [] });
		// `leave` removes my entry and claims; nobody sees me until wake().
		api.call("leave", {}).catch(() => {});
	}

	function onInteraction() {
		const before = stateNow();
		lastInteraction = env.now();
		if (stateNow() !== before) schedule();
	}

	const unlisten = [
		env.listen("interaction", onInteraction),
		env.listen("visibility", () => {
			if (!env.hidden()) onInteraction();
			schedule();
		}),
		env.listen("pagehide", () => {
			if (!away) api.leaveBeacon();
		}),
	];

	const presence: Presence = {
		snapshot: () => snap,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		setProfile(p) {
			profile = { ...profile, ...p };
			store(profile);
			if (snap.me) emit({ me: { ...snap.me, ...p } });
			// Tell the others now rather than at the next tier tick.
			lastPollAt = Number.NEGATIVE_INFINITY;
			if (polling) again = true;
			schedule();
		},
		async request(to) {
			if (snap.outgoing) ended.add(snap.outgoing.pair);
			emit({ outcome: null, outgoing: null });
			try {
				const { pair } = await api.call("request", { to });
				requestedAt = env.now();
				pendingSince = env.now();
				ended.delete(pair);
				emit({ outgoing: { pair, to, state: "pending" } });
				schedule();
				return pair;
			} catch (e) {
				const code = codeOf(e);
				if (code === "busy" || code === "gone") emit({ outcome: { to, code } });
				throw e;
			}
		},
		async cancelRequest() {
			const o = snap.outgoing;
			if (!o) return;
			ended.add(o.pair);
			pendingSince = null;
			emit({ outgoing: null });
			schedule();
			await api.call("release", { pair: o.pair }).catch(() => {});
		},
		async respond(accept) {
			const r = snap.incoming;
			if (!r) return;
			try {
				await api.call("respond", { pair: r.pair, accept });
			} catch (e) {
				ended.add(r.pair);
				emit({ incoming: null });
				schedule();
				throw e;
			}
			pendingSince = null;
			if (accept) {
				handshakeAt = env.now();
				connected = false;
				const handshake: Handshake = { pair: r.pair, remote: r.from, offerer: false };
				emit({ incoming: null, handshake });
			} else {
				ended.add(r.pair);
				emit({ incoming: null });
			}
			lastPollAt = Number.NEGATIVE_INFINITY;
			schedule();
		},
		async markConnected() {
			const h = snap.handshake;
			if (!h) return;
			connected = true;
			emit({});
			schedule();
			await api.call("connected", { pair: h.pair }).catch(() => {});
		},
		async endSession() {
			const h = snap.handshake;
			if (!h) return;
			ended.add(h.pair);
			connected = false;
			// A session is use of the page: the away clock restarts when it ends.
			lastInteraction = env.now();
			emit({ handshake: null });
			schedule();
			await api.call("release", { pair: h.pair }).catch(() => {});
		},
		wake() {
			if (!away) return;
			away = false;
			lastInteraction = env.now();
			lastPollAt = Number.NEGATIVE_INFINITY;
			emit({});
			schedule();
		},
		stop() {
			if (stopped) return;
			stopped = true;
			if (timer !== null) env.clearTimeout(timer);
			timer = null;
			for (const u of unlisten) u();
			if (!away) api.leaveBeacon();
		},
	};

	schedule();
	return presence;
}
