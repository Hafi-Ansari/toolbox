// Shared rooms: a tiny shared textarea that devices poll. One Vercel Function, self-contained
// (only npm imports) so Vercel bundles it on its own. State lives in Upstash Redis in
// production; in local dev and tests an in-memory store with the same semantics stands in.
//
// The Redis database is shared with other projects, so every key starts with `toolbox:`,
// rooms are listed from one index key (never SCAN/KEYS), and nothing ever flushes it.
//
//   GET  /api/rooms                          live rooms, newest first
//   POST /api/rooms {action:"create"}        new room → { room, token } (token proves ownership)
//   GET  /api/rooms?id=…&since=v&client=c    { ver, updated, text? } (text only when ver != since),
//                                            or { gone: true } once the room has ended
//   PUT  /api/rooms?id=…  {text, client}     write the text → { ver }
//   POST /api/rooms?id=…  {action, token}    "beat" (owner is here), "leave" (owner left the
//                                            page: expire soon unless it comes back), "end"
import { Redis } from "@upstash/redis";

/* ---------- Limits */

/** A room lives this long after its owner's last heartbeat. */
export const ROOM_TTL_S = 120;
/** After the owner leaves the page, the room ends this soon unless the owner comes back (a reload). */
export const LEAVE_TTL_S = 15;
/** No room outlives this, heartbeat or not. */
export const MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const MAX_TEXT_BYTES = 100_000;
export const MAX_ROOMS = 50;
/** A viewer counts as "here" if it polled this recently. */
const HERE_MS = 15_000;
/** Writes (create, text, beat, end) per IP per minute. */
const WRITES_PER_MIN = 120;

const P = "toolbox:";
const K = {
	index: `${P}rooms`, // sorted set: room id → owner's last heartbeat (ms)
	room: (id: string) => `${P}room:${id}`, // hash: name, emoji, created, owner, text, ver, updated
	seen: (id: string) => `${P}room:${id}:seen`, // sorted set: client id → last poll (ms)
	rate: (ip: string, minute: number) => `${P}rl:${ip}:${minute}`,
};

/* ---------- Storage: the handful of Redis commands used, so a fake can stand in */

export interface Kv {
	hset(key: string, fields: Record<string, string>): Promise<unknown>;
	hgetall(key: string): Promise<Record<string, string> | null>;
	hmget(key: string, ...fields: string[]): Promise<Record<string, string | null> | null>;
	hincrby(key: string, field: string, by: number): Promise<number>;
	expire(key: string, seconds: number): Promise<unknown>;
	del(...keys: string[]): Promise<unknown>;
	zadd(key: string, score: number, member: string): Promise<unknown>;
	zrem(key: string, member: string): Promise<unknown>;
	zrangeAll(key: string): Promise<string[]>;
	zremrangebyscore(key: string, min: number, max: number): Promise<unknown>;
	/** `max` may be "+inf" (Infinity can't be sent: JSON turns it into null). */
	zcount(key: string, min: number, max: number | "+inf"): Promise<number>;
	incr(key: string): Promise<number>;
}

/** HMGET's raw reply (values in field order) as an object; null when the hash doesn't exist. */
export function hashFromValues(
	fields: string[],
	values: (string | null)[] | null,
): Record<string, string | null> | null {
	if (!values || values.every((v) => v === null)) return null;
	return Object.fromEntries(fields.map((f, i) => [f, values[i] ?? null]));
}

/** HGETALL's raw reply ([field, value, field, value, …]) as an object; null when the hash doesn't exist. */
export function hashFromFlat(flat: (string | null)[] | null): Record<string, string> | null {
	if (!flat?.length) return null;
	const out: Record<string, string> = {};
	for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = String(flat[i + 1] ?? "");
	return out;
}

/** Upstash Redis through its REST API. Concurrent calls are auto-pipelined into one request. */
export function redisKv(url: string, token: string): Kv {
	// Values stay strings: automatic deserialization would turn a text of "123" into a number.
	const r = new Redis({ url, token, automaticDeserialization: false });
	return {
		hset: (key, fields) => r.hset(key, fields),
		// Without automatic deserialization the SDK returns these two as raw Redis arrays.
		hgetall: async (key) => hashFromFlat((await r.hgetall(key)) as unknown as (string | null)[] | null),
		hmget: async (key, ...fields) =>
			hashFromValues(fields, (await r.hmget(key, ...fields)) as unknown as (string | null)[] | null),
		hincrby: (key, field, by) => r.hincrby(key, field, by),
		expire: (key, s) => r.expire(key, s),
		del: (...keys) => r.del(...keys),
		zadd: (key, score, member) => r.zadd(key, { score, member }),
		zrem: (key, member) => r.zrem(key, member),
		zrangeAll: (key) => r.zrange<string[]>(key, 0, -1),
		zremrangebyscore: (key, min, max) => r.zremrangebyscore(key, min, max),
		zcount: (key, min, max) => r.zcount(key, min, max),
		incr: (key) => r.incr(key),
	};
}

/** In-memory stand-in with Redis semantics (expiry included), for local dev and tests. */
export function memoryKv(now: () => number = Date.now): Kv {
	const hashes = new Map<string, Map<string, string>>();
	const zsets = new Map<string, Map<string, number>>();
	const counters = new Map<string, number>();
	const expiry = new Map<string, number>();
	const alive = (key: string) => {
		const at = expiry.get(key);
		if (at !== undefined && at <= now()) {
			hashes.delete(key);
			zsets.delete(key);
			counters.delete(key);
			expiry.delete(key);
		}
		return hashes.has(key) || zsets.has(key) || counters.has(key);
	};
	const hash = (key: string) => {
		alive(key);
		const h = hashes.get(key) ?? new Map<string, string>();
		hashes.set(key, h);
		return h;
	};
	const zset = (key: string) => {
		alive(key);
		const z = zsets.get(key) ?? new Map<string, number>();
		zsets.set(key, z);
		return z;
	};
	const dropIfEmpty = (key: string) => {
		if (zsets.get(key)?.size === 0) zsets.delete(key);
	};
	return {
		async hset(key, fields) {
			const h = hash(key);
			for (const [f, v] of Object.entries(fields)) h.set(f, v);
			return Object.keys(fields).length;
		},
		async hgetall(key) {
			if (!alive(key) || !hashes.has(key)) return null;
			return Object.fromEntries(hashes.get(key) ?? []);
		},
		async hmget(key, ...fields) {
			if (!alive(key) || !hashes.has(key)) return null;
			const h = hashes.get(key);
			return Object.fromEntries(fields.map((f) => [f, h?.get(f) ?? null]));
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
		async del(...keys) {
			for (const k of keys) {
				hashes.delete(k);
				zsets.delete(k);
				counters.delete(k);
				expiry.delete(k);
			}
			return keys.length;
		},
		async zadd(key, score, member) {
			zset(key).set(member, score);
			return 1;
		},
		async zrem(key, member) {
			if (!alive(key)) return 0;
			zsets.get(key)?.delete(member);
			dropIfEmpty(key);
			return 1;
		},
		async zrangeAll(key) {
			if (!alive(key)) return [];
			return [...(zsets.get(key) ?? [])].sort((a, b) => a[1] - b[1]).map(([m]) => m);
		},
		async zremrangebyscore(key, min, max) {
			if (!alive(key)) return 0;
			const z = zsets.get(key);
			let n = 0;
			for (const [m, s] of z ?? [])
				if (s >= min && s <= max) {
					z?.delete(m);
					n++;
				}
			dropIfEmpty(key);
			return n;
		},
		async zcount(key, min, max) {
			if (!alive(key)) return 0;
			let n = 0;
			const hi = max === "+inf" ? Number.POSITIVE_INFINITY : max;
			for (const s of zsets.get(key)?.values() ?? []) if (s >= min && s <= hi) n++;
			return n;
		},
		async incr(key) {
			alive(key);
			const v = (counters.get(key) ?? 0) + 1;
			counters.set(key, v);
			return v;
		},
	};
}

/* ---------- Rooms */

export interface RoomInfo {
	id: string;
	name: string;
	emoji: string;
	created: number;
	/** Devices that polled the room in the last few seconds. */
	here: number;
}

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
const ANIMALS: [string, string][] = [
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

const pick = <T>(list: T[]) => list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];
const randomId = (bytes: number) =>
	Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

async function sha256(text: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Room ids are 10 hex characters; anything else is rejected before touching storage. */
const validId = (id: string | null): id is string => !!id && /^[0-9a-f]{10}$/.test(id);
/** Client ids are short opaque strings chosen by the browser tab. */
const validClient = (c: unknown): c is string => typeof c === "string" && /^[0-9a-zA-Z_-]{6,40}$/.test(c);

export class Rooms {
	private kv: Kv;
	private now: () => number;

	constructor(kv: Kv, now: () => number = Date.now) {
		this.kv = kv;
		this.now = now;
	}

	/** Live rooms, newest first. Drops index entries whose room is gone or too old. */
	async list(): Promise<RoomInfo[]> {
		const now = this.now();
		await this.kv.zremrangebyscore(K.index, 0, now - ROOM_TTL_S * 1000);
		const ids = await this.kv.zrangeAll(K.index);
		const rooms = await Promise.all(
			ids.map(async (id) => {
				const [h, here] = await Promise.all([
					this.kv.hmget(K.room(id), "name", "emoji", "created"),
					this.kv.zcount(K.seen(id), now - HERE_MS, "+inf"),
				]);
				const created = Number(h?.created);
				if (!h?.name || !created || now - created > MAX_AGE_MS) {
					await this.end(id);
					return null;
				}
				return { id, name: h.name, emoji: h.emoji ?? "💬", created, here } satisfies RoomInfo;
			}),
		);
		return rooms.filter((r): r is RoomInfo => !!r).sort((a, b) => b.created - a.created);
	}

	async create(): Promise<{ room: RoomInfo; token: string } | { error: "full" }> {
		if ((await this.list()).length >= MAX_ROOMS) return { error: "full" };
		const now = this.now();
		const id = randomId(5);
		const token = randomId(24);
		const [animal, emoji] = pick(ANIMALS);
		const name = `${pick(ADJECTIVES)} ${animal}`;
		const key = K.room(id);
		await this.kv.hset(key, {
			name,
			emoji,
			created: String(now),
			owner: await sha256(token),
			text: "",
			ver: "0",
			updated: String(now),
		});
		await Promise.all([this.kv.expire(key, ROOM_TTL_S), this.kv.zadd(K.index, now, id)]);
		return { room: { id, name, emoji, created: now, here: 0 }, token };
	}

	/** The room's version, and its text when it changed since `since`. Records the poller as here. */
	async read(id: string, since: number | null, client: string | null) {
		const now = this.now();
		const key = K.room(id);
		const [h] = await Promise.all([
			this.kv.hmget(key, "ver", "updated", "created", "name", "emoji"),
			client ? this.kv.zadd(K.seen(id), now, client) : null,
		]);
		const created = Number(h?.created);
		if (!h?.created || now - created > MAX_AGE_MS) return null;
		if (client) await this.kv.expire(K.seen(id), ROOM_TTL_S);
		const ver = Number(h.ver);
		const base = { ver, updated: Number(h.updated), created, name: h.name ?? "", emoji: h.emoji ?? "💬" };
		if (since === ver) return base;
		const full = await this.kv.hmget(key, "text");
		return { ...base, text: full?.text ?? "" };
	}

	async write(id: string, text: string): Promise<{ ver: number } | null> {
		const key = K.room(id);
		const h = await this.kv.hmget(key, "created");
		if (!h?.created || this.now() - Number(h.created) > MAX_AGE_MS) return null;
		const [ver] = await Promise.all([
			this.kv.hincrby(key, "ver", 1),
			this.kv.hset(key, { text, updated: String(this.now()) }),
		]);
		return { ver };
	}

	private async owns(id: string, token: unknown): Promise<"yes" | "no" | "gone"> {
		const h = await this.kv.hmget(K.room(id), "owner", "created");
		if (!h?.owner || this.now() - Number(h.created) > MAX_AGE_MS) return "gone";
		return typeof token === "string" && (await sha256(token)) === h.owner ? "yes" : "no";
	}

	/** The owner is here: keep the room alive (`leave`: the owner left the page; end soon unless it returns). */
	async beat(id: string, token: unknown, leaving = false): Promise<"ok" | "forbidden" | "gone"> {
		const owns = await this.owns(id, token);
		if (owns !== "yes") return owns === "no" ? "forbidden" : "gone";
		const ttl = leaving ? LEAVE_TTL_S : ROOM_TTL_S;
		// The index score is "last heartbeat"; a leaving owner's room drops off the list in LEAVE_TTL_S.
		const score = this.now() - (ROOM_TTL_S - ttl) * 1000;
		await Promise.all([this.kv.expire(K.room(id), ttl), this.kv.zadd(K.index, score, id)]);
		return "ok";
	}

	async endByOwner(id: string, token: unknown): Promise<"ok" | "forbidden" | "gone"> {
		const owns = await this.owns(id, token);
		if (owns !== "yes") return owns === "no" ? "forbidden" : "gone";
		await this.end(id);
		return "ok";
	}

	private async end(id: string) {
		await Promise.all([this.kv.del(K.room(id), K.seen(id)), this.kv.zrem(K.index, id)]);
	}

	/** Counts a write from `ip`; false once it is over the per-minute limit. */
	async allowWrite(ip: string): Promise<boolean> {
		const minute = Math.floor(this.now() / 60_000);
		const key = K.rate(ip, minute);
		const n = await this.kv.incr(key);
		if (n === 1) await this.kv.expire(key, 90);
		return n <= WRITES_PER_MIN;
	}
}

/* ---------- HTTP */

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	});

async function body(request: Request): Promise<Record<string, unknown>> {
	try {
		const v = await request.json();
		return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

const clientIp = (request: Request) =>
	request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

export async function handle(request: Request, rooms: Rooms): Promise<Response> {
	const url = new URL(request.url);
	const id = url.searchParams.get("id");
	const method = request.method;
	if (id !== null && !validId(id)) return json({ error: "bad-id" }, 400);

	if (method === "GET") {
		if (!id) return json({ rooms: await rooms.list() });
		const sinceParam = url.searchParams.get("since");
		const since = sinceParam === null ? null : Number(sinceParam);
		const client = url.searchParams.get("client");
		const room = await rooms.read(id, Number.isFinite(since) ? since : null, validClient(client) ? client : null);
		// An ended room is an ordinary answer to a poll, not an error: 200 keeps browser consoles quiet.
		return json(room ?? { gone: true });
	}

	if (method !== "POST" && method !== "PUT") return json({ error: "method" }, 405);
	if (!(await rooms.allowWrite(clientIp(request)))) return json({ error: "slow-down" }, 429);
	const b = await body(request);

	if (method === "PUT") {
		if (!id) return json({ error: "no-id" }, 400);
		if (typeof b.text !== "string") return json({ error: "no-text" }, 400);
		if (new TextEncoder().encode(b.text).length > MAX_TEXT_BYTES) return json({ error: "too-long" }, 413);
		const r = await rooms.write(id, b.text);
		return r ? json(r) : json({ error: "gone" }, 404);
	}

	if (!id) {
		if (b.action !== "create") return json({ error: "action" }, 400);
		const r = await rooms.create();
		return "error" in r ? json(r, 429) : json(r, 201);
	}
	const result =
		b.action === "beat" || b.action === "leave"
			? await rooms.beat(id, b.token, b.action === "leave")
			: b.action === "end"
				? await rooms.endByOwner(id, b.token)
				: null;
	if (!result) return json({ error: "action" }, 400);
	return result === "ok" ? json({ ok: true }) : json({ error: result }, result === "gone" ? 404 : 403);
}

/* ---------- Store selection */

function env(...names: string[]) {
	for (const n of names) if (process.env[n]) return process.env[n];
	return undefined;
}

const g = globalThis as { __toolboxRooms?: Rooms };

/** Upstash in production; an in-memory store for local dev and tests (one per process). */
export function rooms(): Rooms | null {
	if (g.__toolboxRooms) return g.__toolboxRooms;
	const url = env("ROOM_KV_REST_API_URL", "KV_REST_API_URL", "UPSTASH_REDIS_REST_URL");
	const token = env("ROOM_KV_REST_API_TOKEN", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN");
	if (url && token) g.__toolboxRooms = new Rooms(redisKv(url, token));
	else if (!process.env.VERCEL) g.__toolboxRooms = new Rooms(memoryKv());
	else return null; // deployed without a store: say so instead of keeping rooms per instance
	return g.__toolboxRooms;
}

async function serve(request: Request): Promise<Response> {
	const r = rooms();
	if (!r) return json({ error: "no-store" }, 503);
	try {
		return await handle(request, r);
	} catch (e) {
		console.error("[rooms]", e);
		return json({ error: "server" }, 500);
	}
}

export const GET = serve;
export const POST = serve;
export const PUT = serve;
