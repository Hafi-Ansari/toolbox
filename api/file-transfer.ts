// Blazing Fast File Transfer: presence, request/accept claims and the lane 0 handshake mailbox
// (docs/file-transfer/SPEC.md §6). One Vercel Function, self-contained (only npm imports) like
// api/rooms.ts. No file bytes ever come here: browsers connect directly over WebRTC.
//
//   POST /api/file-transfer { action, peer, secret, ... }
//     poll       list who is here, register or refresh me, see claims on me and my own request
//     request    ask a peer to connect (atomic claim)          respond    accept or decline a claim on me
//     connected  lane 0 is open                                release    either side ends the claim
//     signal     lane 0 offer/answer to the other side         read       take my mailbox message (GETDEL)
//     leave      remove me and my claims (pagehide)
//
// State lives in the Upstash Redis database the Room tool uses, shared with other projects:
// every key starts with `toolbox:ft:`, every key has a TTL, and nothing scans or flushes.
//   toolbox:ft:peers                hash  <peerId> → PeerEntry, claim:<target> → Claim,
//                                         sig:<pair> → signal writes so far   (EXPIRE 180 on writes)
//   toolbox:ft:sig:<pair>:<to>      string, one handshake message           (EX 60)
//   toolbox:ft:rl:<ipHash>:<minute> counter, writes per IP per minute       (EX 90)
//
// The API shapes and SERVER constants below are copies of src/tools/file-transfer/types.ts and
// tuning.ts (this file must not import from src/). src/tools/file-transfer/server.test.ts checks
// that the copies stay in sync.
import { Redis } from "@upstash/redis";

/* ---------- Constants (copied from tuning.ts SERVER and POLL) */

const KiB = 1024;

export const SERVER = {
	keyPrefix: "toolbox:ft:",
	peersTtlS: 180,
	signalTtlS: 60,
	rateTtlS: 90,
	peerStaleMs: 150_000,
	claimMs: 30_000,
	connectedClaimMs: 90_000,
	goneMs: 30_000,
	listMax: 50,
	peersMax: 100,
	peersPerIp: 6,
	writesPerMinute: 60,
	signalMaxBytes: 16 * KiB,
	signalsPerPair: 8,
	nameMax: 24,
	peerIdHex: 16,
	secretHex: 32,
	pairHex: 16,
	authHex: 32,
	ipHashHex: 12,
} as const;

/** `PollResult.limits.pollMs`: tuning.ts `POLL.activeMs`, `idleMs`, `hiddenMs`. */
export const POLL_MS = { active: 3000, idle: 10_000, hidden: 60_000 } as const;

/** Largest request body accepted (a signal payload plus the envelope). */
const BODY_MAX = 32 * KiB;

/* ---------- API shapes (copied from types.ts) */

export type ApiAction = "poll" | "request" | "respond" | "connected" | "release" | "signal" | "read" | "leave";

export type ApiErrorCode =
	| "method"
	| "action"
	| "bad-request"
	| "auth"
	| "busy"
	| "gone"
	| "self"
	| "slow-down"
	| "too-big"
	| "too-many"
	| "full"
	| "too-many-here"
	| "disabled"
	| "no-salt"
	| "no-store"
	| "server";

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
	method: 405,
	action: 400,
	"bad-request": 400,
	auth: 403,
	busy: 409,
	gone: 404,
	self: 400,
	"slow-down": 429,
	"too-big": 413,
	"too-many": 429,
	full: 503,
	"too-many-here": 429,
	disabled: 503,
	"no-salt": 503,
	"no-store": 503,
	server: 500,
};

export type ClaimState = "pending" | "accepted" | "connected";
export type GoneReason = "declined" | "expired";

export interface PeerEntry {
	name: string;
	emoji: string;
	seen: number;
	hidden: boolean;
	busy: boolean;
	net: string;
	ip: string;
	auth: string;
}

export interface Claim {
	pair: string;
	from: string;
	at: number;
	state: ClaimState;
}

/**
 * What a `claim:<target>` field holds. A declined or expired claim stays in its field for
 * `SERVER.goneMs` as a tombstone (`gone` set), so the requester's poll can tell the two apart
 * (the spec's `gone:<pair>` marker, kept in the claim's own field: one HSET instead of HSET + HDEL).
 */
export type StoredClaim = Claim & { gone?: GoneReason };

export interface SignalMessage {
	type: "offer" | "answer";
	sdp: string;
}

export interface PeerRef {
	id: string;
	name: string;
	emoji: string;
}

export interface PeerInfo extends PeerRef {
	busy: boolean;
	near: boolean;
	seen: number;
}

export interface IncomingRequest {
	pair: string;
	from: PeerRef;
	state: ClaimState;
	at: number;
}

export interface OutgoingRequest {
	pair: string;
	to: string;
	state: ClaimState | GoneReason;
}

export interface PollResult {
	you: PeerRef & { hidden: boolean };
	peers: PeerInfo[];
	incoming: IncomingRequest | null;
	outgoing: OutgoingRequest | null;
	limits: { pollMs: { active: number; idle: number; hidden: number } };
}

export interface ApiOk {
	ok: true;
}

export interface ApiResponses {
	poll: PollResult;
	request: { pair: string };
	respond: ApiOk;
	connected: ApiOk;
	release: ApiOk;
	signal: ApiOk;
	read: { payload: SignalMessage | null };
	leave: ApiOk;
}

/* ---------- Names (the Room tool's lists) */

const ADJECTIVES = [
	"Amber",
	"Brisk",
	"Calm",
	"Daring",
	"Eager",
	"Fuzzy",
	"Gentle",
	"Hazy",
	"Jolly",
	"Keen",
	"Lucky",
	"Mellow",
	"Nimble",
	"Quiet",
	"Rapid",
	"Sunny",
	"Tidy",
	"Velvet",
	"Witty",
	"Zesty",
];
export const ANIMALS: [string, string][] = [
	["Otter", "🦦"],
	["Fox", "🦊"],
	["Owl", "🦉"],
	["Panda", "🐼"],
	["Koala", "🐨"],
	["Tiger", "🐯"],
	["Frog", "🐸"],
	["Penguin", "🐧"],
	["Octopus", "🐙"],
	["Turtle", "🐢"],
	["Hedgehog", "🦔"],
	["Whale", "🐳"],
	["Bee", "🐝"],
	["Crab", "🦀"],
	["Sloth", "🦥"],
	["Llama", "🦙"],
	["Parrot", "🦜"],
	["Rabbit", "🐰"],
	["Lion", "🦁"],
	["Seal", "🦭"],
];
const EMOJIS = new Set(ANIMALS.map(([, e]) => e));

/** The default profile of a peer: stable for its id, so a reload without storage keeps its name. */
export function defaultProfile(peer: string): { name: string; emoji: string } {
	const [animal, emoji] = ANIMALS[Number.parseInt(peer.slice(4, 8), 16) % ANIMALS.length];
	return { name: `${ADJECTIVES[Number.parseInt(peer.slice(0, 4), 16) % ADJECTIVES.length]} ${animal}`, emoji };
}

/** A display name: NFC, no control or direction-changing characters (as rooms' `cleanFileName`), ≤ 24 characters. */
export function cleanName(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const clean = raw
		.normalize("NFC")
		.replace(/[\p{Cc}؜‎‏‪-‮⁦-⁩﻿]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
	return Array.from(clean).slice(0, SERVER.nameMax).join("").trim();
}

/* ---------- Validation */

const hex = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
const PEER_RE = hex(SERVER.peerIdHex);
const SECRET_RE = hex(SERVER.secretHex);
const PAIR_RE = hex(SERVER.pairHex);
const isPeerId = (v: unknown): v is string => typeof v === "string" && PEER_RE.test(v);
const isSecret = (v: unknown): v is string => typeof v === "string" && SECRET_RE.test(v);
const isPairId = (v: unknown): v is string => typeof v === "string" && PAIR_RE.test(v);

function isSignalMessage(v: unknown): v is SignalMessage {
	if (!v || typeof v !== "object") return false;
	const m = v as Record<string, unknown>;
	return (m.type === "offer" || m.type === "answer") && typeof m.sdp === "string" && m.sdp.length > 0;
}

/* ---------- Storage: the handful of Redis commands used, so a fake can stand in */

export interface Kv {
	hset(key: string, fields: Record<string, string>): Promise<unknown>;
	/** Only when the field doesn't exist yet: true when it was set. */
	hsetnx(key: string, field: string, value: string): Promise<boolean>;
	hget(key: string, field: string): Promise<string | null>;
	hgetall(key: string): Promise<Record<string, string> | null>;
	/** Number of fields removed. */
	hdel(key: string, ...fields: string[]): Promise<number>;
	hincrby(key: string, field: string, by: number): Promise<number>;
	expire(key: string, seconds: number): Promise<number>;
	incr(key: string): Promise<number>;
	get(key: string): Promise<string | null>;
	/** SET key value EX seconds. */
	set(key: string, value: string, seconds: number): Promise<void>;
	getdel(key: string): Promise<string | null>;
}

/** HGETALL's raw reply ([field, value, field, value, …]) as an object; null when the hash doesn't exist. */
function hashFromFlat(flat: (string | null)[] | null): Record<string, string> | null {
	if (!flat?.length) return null;
	const out: Record<string, string> = {};
	for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = String(flat[i + 1] ?? "");
	return out;
}

/** Upstash Redis through its REST API. Concurrent calls are auto-pipelined into one request. */
export function redisKv(url: string, token: string): Kv {
	// Values stay strings, as in rooms: automatic deserialization would parse them.
	const r = new Redis({ url, token, automaticDeserialization: false });
	return {
		hset: (key, fields) => r.hset(key, fields),
		hsetnx: async (key, field, value) => (await r.hsetnx(key, field, value)) === 1,
		hget: (key, field) => r.hget<string>(key, field),
		hgetall: async (key) => hashFromFlat((await r.hgetall(key)) as unknown as (string | null)[] | null),
		hdel: (key, ...fields) => r.hdel(key, ...fields),
		hincrby: (key, field, by) => r.hincrby(key, field, by),
		expire: (key, s) => r.expire(key, s),
		incr: (key) => r.incr(key),
		get: (key) => r.get<string>(key),
		set: async (key, value, s) => void (await r.set(key, value, { ex: s })),
		getdel: (key) => r.getdel<string>(key),
	};
}

/** In-memory stand-in with Redis semantics (expiry included), for local dev and tests. */
export function memoryKv(now: () => number = Date.now): Kv {
	const hashes = new Map<string, Map<string, string>>();
	const strings = new Map<string, string>();
	const expiry = new Map<string, number>();
	const drop = (key: string) => {
		hashes.delete(key);
		strings.delete(key);
		expiry.delete(key);
	};
	const alive = (key: string) => {
		const at = expiry.get(key);
		if (at !== undefined && at <= now()) drop(key);
		return hashes.has(key) || strings.has(key);
	};
	const hash = (key: string) => {
		alive(key);
		const h = hashes.get(key) ?? new Map<string, string>();
		hashes.set(key, h);
		return h;
	};
	return {
		async hset(key, fields) {
			const h = hash(key);
			for (const [f, v] of Object.entries(fields)) h.set(f, v);
			return Object.keys(fields).length;
		},
		async hsetnx(key, field, value) {
			const h = hash(key);
			if (h.has(field)) return false;
			h.set(field, value);
			return true;
		},
		async hget(key, field) {
			return alive(key) ? (hashes.get(key)?.get(field) ?? null) : null;
		},
		async hgetall(key) {
			if (!alive(key) || !hashes.has(key)) return null;
			return Object.fromEntries(hashes.get(key) ?? []);
		},
		async hdel(key, ...fields) {
			if (!alive(key)) return 0;
			const h = hashes.get(key);
			let n = 0;
			for (const f of fields) if (h?.delete(f)) n++;
			if (h?.size === 0) drop(key);
			return n;
		},
		async hincrby(key, field, by) {
			const h = hash(key);
			const v = Number(h.get(field) ?? 0) + by;
			h.set(field, String(v));
			return v;
		},
		async expire(key, s) {
			if (!alive(key)) return 0;
			expiry.set(key, now() + s * 1000);
			return 1;
		},
		async incr(key) {
			alive(key);
			const v = Number(strings.get(key) ?? 0) + 1;
			strings.set(key, String(v));
			return v;
		},
		async get(key) {
			return alive(key) ? (strings.get(key) ?? null) : null;
		},
		async set(key, value, s) {
			hashes.delete(key);
			strings.set(key, value);
			expiry.set(key, now() + s * 1000);
		},
		async getdel(key) {
			if (!alive(key)) return null;
			const v = strings.get(key) ?? null;
			drop(key);
			return v;
		},
	};
}

/* ---------- Keys */

const P = SERVER.keyPrefix;
const K = {
	peers: `${P}peers`,
	mailbox: (pair: string, to: string) => `${P}sig:${pair}:${to}`,
	rate: (ipHash: string, minute: number) => `${P}rl:${ipHash}:${minute}`,
};
const CLAIM = "claim:";
const SIG = "sig:";
const claimField = (target: string) => `${CLAIM}${target}`;
const sigField = (pair: string) => `${SIG}${pair}`;

/* ---------- Hashing */

const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(text: string): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** The network an address belongs to: an IPv4 address as is, an IPv6 address's /64. */
export function networkOf(ip: string): string {
	const v = (
		ip
			.trim()
			.replace(/^\[|\]$/g, "")
			.split("%")[0] ?? ""
	).toLowerCase();
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
	if (mapped) return mapped[1];
	if (!v.includes(":")) return v;
	const [head, tail] = v.split("::");
	const h = head ? head.split(":") : [];
	const t = tail ? tail.split(":") : [];
	const groups = v.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
	return `${groups
		.slice(0, 4)
		.map((g) => (Number.parseInt(g, 16) || 0).toString(16))
		.join(":")}::/64`;
}

/** Read the client IP as api/rooms.ts does. */
export const clientIp = (request: Request) =>
	request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

/* ---------- Errors and responses */

class Fail extends Error {
	readonly code: ApiErrorCode;
	constructor(code: ApiErrorCode) {
		super(code);
		this.code = code;
	}
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	});

const fail = (code: ApiErrorCode) => json({ error: code }, API_ERROR_STATUS[code]);

/* ---------- The hash, read once per request */

type ClaimStatus = "live" | "tomb" | "drop";

/** The peers hash as one request sees it, with liveness applied (hash fields have no TTL, §6.2). */
class View {
	readonly peers = new Map<string, PeerEntry>();
	/** target → claim, after expiry is applied (an expired pending/accepted claim reads as a tombstone). */
	readonly claims = new Map<string, StoredClaim>();
	/** Cleanup a poll writes back: tombstones to set, dead fields to delete. */
	readonly set: Record<string, string> = {};
	readonly del: string[] = [];
	/** Peers in a live claim (either end): listed as busy. */
	readonly involved = new Set<string>();

	readonly fields: Record<string, string>;
	readonly now: number;

	constructor(fields: Record<string, string>, now: number) {
		this.fields = fields;
		this.now = now;
		const rawClaims: [string, StoredClaim][] = [];
		const sigs: string[] = [];
		for (const [field, value] of Object.entries(fields)) {
			if (field.startsWith(SIG)) {
				sigs.push(field);
				continue;
			}
			const parsed = parse(value);
			if (field.startsWith(CLAIM)) {
				const target = field.slice(CLAIM.length);
				if (isPeerId(target) && isClaim(parsed)) rawClaims.push([target, parsed]);
				else this.del.push(field);
			} else if (isPeerId(field) && isEntry(parsed)) {
				if (now - parsed.seen > SERVER.peerStaleMs) this.del.push(field);
				else this.peers.set(field, parsed);
			} else this.del.push(field);
		}
		for (const [target, c] of rawClaims) {
			const status = this.status(target, c);
			const field = claimField(target);
			if (status === "drop") this.del.push(field);
			else if (status === "tomb" && !c.gone) {
				// A pending or accepted claim nobody answered in time.
				const tomb: StoredClaim = { ...c, gone: "expired", at: now };
				this.claims.set(target, tomb);
				this.set[field] = JSON.stringify(tomb);
			} else {
				this.claims.set(target, c);
				if (status === "live") this.involved.add(target).add(c.from);
			}
		}
		// A signal counter outlives nothing: drop it once its pair has no live claim.
		const livePairs = new Set([...this.claims.values()].filter((c) => !c.gone).map((c) => c.pair));
		for (const f of sigs) if (!livePairs.has(f.slice(SIG.length))) this.del.push(f);
	}

	private status(target: string, c: StoredClaim): ClaimStatus {
		const now = this.now;
		if (c.gone) return now - c.at > SERVER.goneMs ? "drop" : "tomb";
		const to = this.peers.get(target);
		if (!to || !this.peers.has(c.from) || c.from === target) return "drop";
		if (c.state === "connected")
			// Kept alive by the target's polls (its `seen`), so no poll rewrites the claim (§6.2).
			return now - Math.max(c.at, to.seen) > SERVER.connectedClaimMs ? "drop" : "live";
		return now - c.at > SERVER.claimMs ? "tomb" : "live";
	}

	/** A live (not tombstoned) claim with this pair id, and its target. */
	byPair(pair: string): [string, StoredClaim] | null {
		for (const [target, c] of this.claims) if (c.pair === pair && !c.gone) return [target, c];
		return null;
	}

	liveClaimOn(target: string): StoredClaim | null {
		const c = this.claims.get(target);
		return c && !c.gone ? c : null;
	}
}

function parse(v: string | undefined): unknown {
	if (!v) return null;
	try {
		return JSON.parse(v);
	} catch {
		return null;
	}
}

function isEntry(v: unknown): v is PeerEntry {
	const e = v as PeerEntry | null;
	return !!e && typeof e === "object" && typeof e.seen === "number" && typeof e.auth === "string";
}

function isClaim(v: unknown): v is StoredClaim {
	const c = v as StoredClaim | null;
	return (
		!!c &&
		typeof c === "object" &&
		isPairId(c.pair) &&
		isPeerId(c.from) &&
		typeof c.at === "number" &&
		(c.state === "pending" || c.state === "accepted" || c.state === "connected")
	);
}

/* ---------- The service */

export interface FileTransferOptions {
	/** HMAC key for IP hashes (`SEND_IP_SALT`). */
	salt: string;
	now?: () => number;
}

type Body = Record<string, unknown>;

export class FileTransfer {
	private readonly kv: Kv;
	private readonly now: () => number;
	private readonly hmacKey: Promise<CryptoKey>;

	constructor(kv: Kv, opts: FileTransferOptions) {
		this.kv = kv;
		this.now = opts.now ?? Date.now;
		this.hmacKey = crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(opts.salt),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
	}

	/** 12-hex HMAC of a value; IPs and networks are never stored or sent in the clear. */
	async ipHash(value: string): Promise<string> {
		const sig = await crypto.subtle.sign("HMAC", await this.hmacKey, new TextEncoder().encode(value));
		return toHex(sig).slice(0, SERVER.ipHashHex);
	}

	/** Runs one action for an authenticated-looking body. Throws `Fail` with the error code. */
	async run(action: ApiAction, peer: string, secret: string, b: Body, ip: string): Promise<unknown> {
		switch (action) {
			case "poll":
				return this.poll(peer, secret, b, ip);
			case "request":
				return this.request(peer, secret, b, ip);
			case "respond":
				return this.respond(peer, secret, b, ip);
			case "connected":
				return this.connected(peer, secret, b);
			case "release":
				return this.release(peer, secret, b);
			case "signal":
				return this.signal(peer, secret, b, ip);
			case "read":
				return this.read(peer, secret, b);
			case "leave":
				return this.leave(peer, secret);
		}
	}

	private async view(): Promise<View> {
		return new View((await this.kv.hgetall(K.peers)) ?? {}, this.now());
	}

	private async auth(secret: string): Promise<string> {
		return (await sha256Hex(secret)).slice(0, SERVER.authHex);
	}

	/** My live entry, after proving ownership. `missing` when I'm not registered (or my entry went stale). */
	private async me(v: View, peer: string, secret: string): Promise<PeerEntry | null> {
		const e = v.peers.get(peer);
		if (!e) return null;
		if (e.auth !== (await this.auth(secret))) throw new Fail("auth");
		return e;
	}

	private async mustBeMe(v: View, peer: string, secret: string): Promise<PeerEntry> {
		const e = await this.me(v, peer, secret);
		if (!e) throw new Fail("auth");
		return e;
	}

	/** Counts a write from this IP; throws `slow-down` past the per-minute limit. 1–2 commands. */
	private async rateLimit(ip: string) {
		const key = K.rate(await this.ipHash(ip), Math.floor(this.now() / 60_000));
		const n = await this.kv.incr(key);
		if (n === 1) await this.kv.expire(key, SERVER.rateTtlS);
		if (n > SERVER.writesPerMinute) throw new Fail("slow-down");
	}

	private async poll(peer: string, secret: string, b: Body, ip: string): Promise<PollResult> {
		if (typeof b.hidden !== "boolean" || typeof b.busy !== "boolean") throw new Fail("bad-request");
		if (typeof b.name !== "string" || typeof b.emoji !== "string") throw new Fail("bad-request");
		const fallback = defaultProfile(peer);
		const name = cleanName(b.name) || fallback.name;
		const emoji = EMOJIS.has(b.emoji) ? b.emoji : fallback.emoji;
		const [v, ipHash, netHash, auth] = await Promise.all([
			this.view(),
			this.ipHash(ip),
			this.ipHash(networkOf(ip)),
			this.auth(secret),
		]);
		const old = v.peers.get(peer);
		if (old && old.auth !== auth) throw new Fail("auth");
		if (!old) {
			const others = [...v.peers.values()];
			if (others.length >= SERVER.peersMax) throw new Fail("full");
			if (others.filter((e) => e.ip === ipHash).length >= SERVER.peersPerIp) throw new Fail("too-many-here");
		}
		const now = v.now;
		const entry: PeerEntry = { name, emoji, seen: now, hidden: b.hidden, busy: b.busy, net: netHash, ip: ipHash, auth };
		v.peers.set(peer, entry);

		// Two peers asked each other at the same moment: both claims won their HSETNX. Keep the one
		// made by the lower peerId (it offers, §6.3) as accepted, and drop the other.
		const onMe = v.liveClaimOn(peer);
		if (onMe?.state === "pending") {
			const back = v.liveClaimOn(onMe.from);
			if (back?.state === "pending" && back.from === peer) {
				const [keepTarget, keep, dropTarget] = peer < onMe.from ? [onMe.from, back, peer] : [peer, onMe, onMe.from];
				const accepted: StoredClaim = { ...keep, state: "accepted", at: now };
				v.claims.set(keepTarget, accepted);
				v.claims.delete(dropTarget);
				v.set[claimField(keepTarget)] = JSON.stringify(accepted);
				v.del.push(claimField(dropTarget));
			}
		}

		const del = v.del.filter((f) => f !== peer && !(f in v.set));
		await Promise.all([
			this.kv.hset(K.peers, { [peer]: JSON.stringify(entry), ...v.set }),
			this.kv.expire(K.peers, SERVER.peersTtlS),
			del.length ? this.kv.hdel(K.peers, ...del) : null,
		]);

		const peers: PeerInfo[] = [];
		for (const [id, e] of v.peers) {
			if (id === peer || e.hidden) continue;
			peers.push({
				id,
				name: e.name,
				emoji: e.emoji,
				busy: e.busy || v.involved.has(id),
				near: e.net === netHash,
				seen: e.seen,
			});
		}
		peers.sort((a, c) => Number(c.near) - Number(a.near) || c.seen - a.seen);

		let incoming: IncomingRequest | null = null;
		const claim = v.liveClaimOn(peer);
		const from = claim && v.peers.get(claim.from);
		if (claim && from)
			incoming = {
				pair: claim.pair,
				from: { id: claim.from, name: from.name, emoji: from.emoji },
				state: claim.state,
				at: claim.at,
			};

		let outgoing: OutgoingRequest | null = null;
		for (const [target, c] of v.claims) {
			if (c.from !== peer) continue;
			const o: OutgoingRequest = { pair: c.pair, to: target, state: c.gone ?? c.state };
			// A live request wins over the tombstone of an earlier one.
			if (!outgoing || outgoing.state === "declined" || outgoing.state === "expired" || !c.gone) outgoing = o;
		}

		return {
			you: { id: peer, name, emoji, hidden: b.hidden },
			peers: peers.slice(0, SERVER.listMax),
			incoming,
			outgoing,
			limits: { pollMs: { ...POLL_MS } },
		};
	}

	/** Takes the claim slot of `target` atomically (HSETNX), clearing a dead or tombstoned one first. */
	private async takeSlot(v: View, target: string, claim: StoredClaim): Promise<boolean> {
		const field = claimField(target);
		const value = JSON.stringify(claim);
		if (field in v.fields) {
			// Whatever sits there is stale or a tombstone (callers checked it isn't live): HDEL, then retry once.
			await this.kv.hdel(K.peers, field);
		}
		return this.kv.hsetnx(K.peers, field, value);
	}

	private async request(peer: string, secret: string, b: Body, ip: string): Promise<{ pair: string }> {
		const to = b.to;
		if (!isPeerId(to)) throw new Fail("bad-request");
		if (to === peer) throw new Fail("self");
		await this.rateLimit(ip);
		const v = await this.view();
		await this.mustBeMe(v, peer, secret);
		const target = v.peers.get(to);
		if (!target) throw new Fail("gone");
		const now = v.now;

		// Mutual request: `to` already asked me. Accept at once; the lower peerId's claim survives (it offers).
		const onMe = v.liveClaimOn(peer);
		if (onMe && onMe.from === to && onMe.state === "pending") {
			const acceptInPlace = async () => {
				await this.kv.hset(K.peers, { [claimField(peer)]: JSON.stringify({ ...onMe, state: "accepted", at: now }) });
			};
			const onTo = v.liveClaimOn(to);
			if (onTo?.from === peer) {
				// Both requests already won their HSETNX (a race): keep the lower peerId's claim, drop the other.
				const [keepTarget, keep, dropTarget] = peer < to ? [to, onTo, peer] : [peer, onMe, to];
				await Promise.all([
					this.kv.hset(K.peers, { [claimField(keepTarget)]: JSON.stringify({ ...keep, state: "accepted", at: now }) }),
					this.kv.hdel(K.peers, claimField(dropTarget)),
				]);
				return { pair: keep.pair };
			}
			if (to < peer || onTo) await acceptInPlace();
			else if (await this.takeSlot(v, to, { pair: onMe.pair, from: peer, at: now, state: "accepted" }))
				await this.kv.hdel(K.peers, claimField(peer));
			else await acceptInPlace();
			return { pair: onMe.pair };
		}

		const existing = v.liveClaimOn(to);
		if (existing?.from === peer) return { pair: existing.pair };
		if (existing || target.busy || v.involved.has(to)) throw new Fail("busy");

		// One outgoing request at a time: a new one replaces my earlier pending one.
		const mine = [...v.claims].filter(([, c]) => c.from === peer && !c.gone && c.state === "pending");
		if (mine.length) await this.kv.hdel(K.peers, ...mine.map(([t]) => claimField(t)));

		const pair = randomHex(SERVER.pairHex / 2);
		if (!(await this.takeSlot(v, to, { pair, from: peer, at: now, state: "pending" }))) throw new Fail("busy");
		return { pair };
	}

	private async respond(peer: string, secret: string, b: Body, ip: string): Promise<ApiOk> {
		if (!isPairId(b.pair) || typeof b.accept !== "boolean") throw new Fail("bad-request");
		await this.rateLimit(ip);
		const v = await this.view();
		await this.mustBeMe(v, peer, secret);
		const c = v.liveClaimOn(peer);
		if (!c || c.pair !== b.pair) throw new Fail("gone");
		if (b.accept && c.state !== "pending") return { ok: true };
		const next: StoredClaim = b.accept ? { ...c, state: "accepted", at: v.now } : { ...c, gone: "declined", at: v.now };
		await this.kv.hset(K.peers, { [claimField(peer)]: JSON.stringify(next) });
		return { ok: true };
	}

	private async connected(peer: string, secret: string, b: Body): Promise<ApiOk> {
		if (!isPairId(b.pair)) throw new Fail("bad-request");
		const v = await this.view();
		await this.mustBeMe(v, peer, secret);
		const found = v.byPair(b.pair);
		if (!found || (found[0] !== peer && found[1].from !== peer) || found[1].state === "pending") throw new Fail("gone");
		const [target, c] = found;
		await this.kv.hset(K.peers, { [claimField(target)]: JSON.stringify({ ...c, state: "connected", at: v.now }) });
		return { ok: true };
	}

	private async release(peer: string, secret: string, b: Body): Promise<ApiOk> {
		if (!isPairId(b.pair)) throw new Fail("bad-request");
		const v = await this.view();
		if (!(await this.me(v, peer, secret))) return { ok: true };
		const fields = [...v.claims]
			.filter(([target, c]) => c.pair === b.pair && (target === peer || c.from === peer))
			.map(([target]) => claimField(target));
		const sig = sigField(b.pair);
		if (fields.length) await this.kv.hdel(K.peers, ...fields, ...(sig in v.fields ? [sig] : []));
		return { ok: true };
	}

	private async signal(peer: string, secret: string, b: Body, ip: string): Promise<ApiOk> {
		if (!isPairId(b.pair) || !isPeerId(b.to) || !isSignalMessage(b.payload)) throw new Fail("bad-request");
		const payload = JSON.stringify({ type: b.payload.type, sdp: b.payload.sdp });
		if (new TextEncoder().encode(payload).length > SERVER.signalMaxBytes) throw new Fail("too-big");
		await this.rateLimit(ip);
		const v = await this.view();
		await this.mustBeMe(v, peer, secret);
		const found = v.byPair(b.pair);
		if (!found || found[1].state === "pending") throw new Fail("gone");
		const ends = [found[0], found[1].from];
		if (b.to === peer || !ends.includes(peer) || !ends.includes(b.to)) throw new Fail("gone");
		if ((await this.kv.hincrby(K.peers, sigField(b.pair), 1)) > SERVER.signalsPerPair) throw new Fail("too-many");
		await this.kv.set(K.mailbox(b.pair, b.to), payload, SERVER.signalTtlS);
		return { ok: true };
	}

	private async read(peer: string, secret: string, b: Body): Promise<{ payload: SignalMessage | null }> {
		if (!isPairId(b.pair)) throw new Fail("bad-request");
		const e = parse((await this.kv.hget(K.peers, peer)) ?? undefined);
		if (!isEntry(e) || e.auth !== (await this.auth(secret))) throw new Fail("auth");
		const raw = parse((await this.kv.getdel(K.mailbox(b.pair, peer))) ?? undefined);
		return { payload: isSignalMessage(raw) ? { type: raw.type, sdp: raw.sdp } : null };
	}

	private async leave(peer: string, secret: string): Promise<ApiOk> {
		const v = await this.view();
		if (!(await this.me(v, peer, secret))) return { ok: true };
		const fields = [peer];
		for (const [target, c] of v.claims)
			if (target === peer || c.from === peer) {
				fields.push(claimField(target));
				if (sigField(c.pair) in v.fields) fields.push(sigField(c.pair));
			}
		await this.kv.hdel(K.peers, ...fields);
		return { ok: true };
	}
}

const randomHex = (bytes: number) => toHex(crypto.getRandomValues(new Uint8Array(bytes)).buffer as ArrayBuffer);

/* ---------- HTTP */

const ACTIONS = new Set<string>(["poll", "request", "respond", "connected", "release", "signal", "read", "leave"]);

export async function handle(request: Request, ft: FileTransfer): Promise<Response> {
	if (request.method !== "POST") return fail("method");
	const text = await request.text().catch(() => "");
	if (text.length > BODY_MAX) return fail("too-big");
	const b = parse(text);
	if (!b || typeof b !== "object" || Array.isArray(b)) return fail("bad-request");
	const body = b as Body;
	if (typeof body.action !== "string" || !ACTIONS.has(body.action)) return fail("action");
	if (!isPeerId(body.peer) || !isSecret(body.secret)) return fail("bad-request");
	try {
		return json(await ft.run(body.action as ApiAction, body.peer, body.secret, body, clientIp(request)));
	} catch (e) {
		if (e instanceof Fail) return fail(e.code);
		throw e;
	}
}

/* ---------- Store selection */

function env(...names: string[]) {
	for (const n of names) if (process.env[n]) return process.env[n];
	return undefined;
}

const g = globalThis as { __toolboxFt?: FileTransfer; __toolboxFtSalt?: string };

/**
 * Upstash in production; an in-memory store in local dev and tests (one per process). The IP salt
 * comes from `SEND_IP_SALT`; without it, dev uses a random per-process salt and production refuses.
 */
export function fileTransfer(): FileTransfer | "no-store" | "no-salt" {
	if (g.__toolboxFt) return g.__toolboxFt;
	const url = env("ROOM_KV_REST_API_URL", "KV_REST_API_URL", "UPSTASH_REDIS_REST_URL");
	const token = env("ROOM_KV_REST_API_TOKEN", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN");
	const deployed = !!process.env.VERCEL;
	const kv = url && token ? redisKv(url, token) : deployed ? null : memoryKv();
	if (!kv) return "no-store";
	let salt = process.env.SEND_IP_SALT;
	if (!salt) {
		if (deployed) return "no-salt";
		g.__toolboxFtSalt ??= randomHex(16);
		salt = g.__toolboxFtSalt;
	}
	g.__toolboxFt = new FileTransfer(kv, { salt });
	return g.__toolboxFt;
}

export async function serve(request: Request): Promise<Response> {
	// Kill switch: answers before touching Redis.
	if (process.env.FILE_TRANSFER_DISABLED === "1") return fail("disabled");
	const ft = fileTransfer();
	if (typeof ft === "string") return fail(ft);
	try {
		return await handle(request, ft);
	} catch (e) {
		console.error("[file-transfer]", e);
		return fail("server");
	}
}

export const GET = serve;
export const POST = serve;
