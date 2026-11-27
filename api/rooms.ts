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
//
// Files in a room (anyone in the room may add, fetch and delete, as with the text):
//   POST /api/rooms?id=…  {action:"file-start", name, size, hashes, sha256}  reserve space → { file, chunk }
//   PUT  /api/rooms?id=…&file=f&chunk=n  (raw bytes)  one chunk, checked against its declared SHA-256
//   GET  /api/rooms?id=…&files=1                      { fver, files, used, limit } or { gone: true }
//   GET  /api/rooms?id=…&file=f&chunk=n               one chunk as application/octet-stream
//   POST /api/rooms?id=…  {action:"file-delete", file}
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
/** Writes (create, text, beat, end, file chunks up and down) per IP per minute. */
const WRITES_PER_MIN = 120;

// File limits. The Redis database is Upstash's free tier (250 MB data, 10 MB per request, 10 GB
// bandwidth and 500K commands a month) and shared with other projects; Vercel Hobby functions take
// and return at most 4.5 MB. README "How the shared room works" has the reasoning.
const MiB = 1024 * 1024;
/** Bytes per chunk: one upload request, one download response and one Redis value (base64: 2.7 MB). */
export const FILE_CHUNK = 2 * MiB;
export const MAX_FILE_BYTES = 20 * MiB;
export const MAX_ROOM_FILE_BYTES = 40 * MiB;
export const MAX_ROOM_FILES = 20;
/** All rooms' files together (about 85 MB in Redis once base64-encoded). */
export const MAX_ALL_FILE_BYTES = 64 * MiB;
/** An upload must finish this soon after it starts; its chunks expire then unless it does. */
export const UPLOAD_WINDOW_S = 15 * 60;
/** How often listing rooms also looks for files whose room has vanished. */
const SWEEP_EVERY_MS = 30_000;

const P = "toolbox:";
const K = {
	index: `${P}rooms`, // sorted set: room id → owner's last heartbeat (ms)
	room: (id: string) => `${P}room:${id}`, // hash: name, emoji, created, owner, text, ver, updated
	seen: (id: string) => `${P}room:${id}:seen`, // sorted set: client id → last poll (ms)
	rate: (ip: string, minute: number) => `${P}rl:${ip}:${minute}`,
	files: (id: string) => `${P}room:${id}:files`, // hash: <file> → meta JSON, <file>#n → chunks stored
	chunk: (id: string, file: string, n: number) => `${P}room:${id}:file:${file}:${n}`, // string: base64
	usage: `${P}files:bytes`, // hash: room id → bytes its files hold (reserved at upload start)
};

/* ---------- Storage: the handful of Redis commands used, so a fake can stand in */

export interface Kv {
	hset(key: string, fields: Record<string, string>): Promise<unknown>;
	hgetall(key: string): Promise<Record<string, string> | null>;
	hmget(key: string, ...fields: string[]): Promise<Record<string, string | null> | null>;
	hincrby(key: string, field: string, by: number): Promise<number>;
	/** `nx`: only when the key has no expiry yet. Returns 1 when an expiry was set. */
	expire(key: string, seconds: number, nx?: boolean): Promise<number>;
	del(...keys: string[]): Promise<unknown>;
	/** Number of fields removed. */
	hdel(key: string, ...fields: string[]): Promise<number>;
	/** SET key value NX EX seconds: false when the key already exists. */
	setNx(key: string, value: string, seconds: number): Promise<boolean>;
	get(key: string): Promise<string | null>;
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
		expire: (key, s, nx) => r.expire(key, s, nx ? "NX" : undefined),
		del: (...keys) => r.del(...keys),
		hdel: (key, ...fields) => r.hdel(key, ...fields),
		// Raw reply: "OK" when set, null when NX found the key.
		setNx: async (key, value, s) => (await r.set(key, value, { nx: true, ex: s })) === "OK",
		get: (key) => r.get<string>(key),
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
	const strings = new Map<string, string>();
	const expiry = new Map<string, number>();
	const drop = (key: string) => {
		hashes.delete(key);
		zsets.delete(key);
		counters.delete(key);
		strings.delete(key);
		expiry.delete(key);
	};
	const alive = (key: string) => {
		const at = expiry.get(key);
		if (at !== undefined && at <= now()) drop(key);
		return hashes.has(key) || zsets.has(key) || counters.has(key) || strings.has(key);
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
		async expire(key, s, nx) {
			if (!alive(key) || (nx && expiry.has(key))) return 0;
			expiry.set(key, now() + s * 1000);
			return 1;
		},
		async del(...keys) {
			for (const k of keys) drop(k);
			return keys.length;
		},
		async hdel(key, ...fields) {
			if (!alive(key)) return 0;
			const h = hashes.get(key);
			let n = 0;
			for (const f of fields) if (h?.delete(f)) n++;
			if (h?.size === 0) drop(key);
			return n;
		},
		async setNx(key, value, s) {
			if (alive(key)) return false;
			strings.set(key, value);
			expiry.set(key, now() + s * 1000);
			return true;
		},
		async get(key) {
			return alive(key) ? (strings.get(key) ?? null) : null;
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

async function sha256(data: string | Uint8Array): Promise<string> {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
	const d = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
	return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Room ids are 10 hex characters; anything else is rejected before touching storage. */
const validId = (id: string | null): id is string => !!id && /^[0-9a-f]{10}$/.test(id);
/** Client ids are short opaque strings chosen by the browser tab. */
const validClient = (c: unknown): c is string => typeof c === "string" && /^[0-9a-zA-Z_-]{6,40}$/.test(c);
/** File ids are 16 hex characters. */
const validFile = (f: unknown): f is string => typeof f === "string" && /^[0-9a-f]{16}$/.test(f);
const validHash = (h: unknown): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h);

/**
 * A file name that is safe to show and to offer as a download: no folders, no control or
 * direction-changing characters, at most 120 characters. Empty when nothing usable is left.
 */
export function cleanFileName(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const base = raw.split(/[\\/]/).pop() ?? "";
	const clean = base
		.normalize("NFC")
		// Control characters, and the bidi marks and overrides that can make "exe.txt" read as "txt.exe".
		.replace(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, "")
		.replace(/[<>:"|?*]/g, "_")
		.trim();
	if (/^\.*$/.test(clean)) return "";
	return Array.from(clean).slice(0, 120).join("").trim();
}

/** Content-Disposition for a download: an ASCII fallback plus the UTF-8 name (RFC 6266 / 5987). */
export function attachment(name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%]/g, "_") || "file";
	const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export interface FileMeta {
	name: string;
	size: number;
	chunks: number;
	/** SHA-256 of each chunk, declared by the uploader and checked as each chunk arrives. */
	hashes: string[];
	/** SHA-256 of the whole file, for the downloader to check after reassembly. */
	sha256: string;
	/** Upload start; once done, the time it finished. */
	at: number;
	done: boolean;
	/** An unfinished upload is dropped after this. */
	until: number;
}

export interface FileInfo extends FileMeta {
	id: string;
	/** Chunks stored so far. */
	got: number;
}

export type FileError =
	| "gone"
	| "no-file"
	| "bad-name"
	| "bad-size"
	| "bad-hash"
	| "bad-chunk"
	| "too-big"
	| "too-many"
	| "room-full"
	| "site-full"
	| "expired";

const parseMeta = (v: string | null | undefined): FileMeta | null => {
	if (!v) return null;
	try {
		return JSON.parse(v) as FileMeta;
	} catch {
		return null;
	}
};

/** Bytes chunk `n` must have. */
const chunkBytes = (m: FileMeta, n: number) => (n < m.chunks - 1 ? FILE_CHUNK : m.size - (m.chunks - 1) * FILE_CHUNK);

export class Rooms {
	private kv: Kv;
	private now: () => number;

	constructor(kv: Kv, now: () => number = Date.now) {
		this.kv = kv;
		this.now = now;
	}

	/** Live rooms, newest first. Drops index entries whose room is gone or too old. */
	/** `sweep`: look for files of vanished rooms now, not just every SWEEP_EVERY_MS. */
	async list(sweep = false): Promise<RoomInfo[]> {
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
		const live = rooms.filter((r): r is RoomInfo => !!r);
		await this.sweepFiles(new Set(live.map((r) => r.id)), sweep);
		return live.sort((a, b) => b.created - a.created);
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
		const h = await this.kv.hmget(key, "ver", "updated", "created", "name", "emoji", "fver");
		const created = Number(h?.created);
		if (!h?.created || now - created > MAX_AGE_MS) return null;
		// Only rooms that exist record visitors, and the key always gets an expiry with it:
		// the database is shared, so no toolbox key may outlive its room.
		if (client) await Promise.all([this.kv.zadd(K.seen(id), now, client), this.kv.expire(K.seen(id), ROOM_TTL_S)]);
		const ver = Number(h.ver);
		const base = {
			ver,
			updated: Number(h.updated),
			created,
			name: h.name ?? "",
			emoji: h.emoji ?? "💬",
			// Bumped whenever the room's files change, so pollers fetch the file list only then.
			fver: Number(h.fver ?? 0),
		};
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
		await Promise.all([this.kv.del(K.room(id), K.seen(id)), this.kv.zrem(K.index, id), this.purgeFiles(id)]);
	}

	/* ---------- Files */

	/** Seconds until the room's 2-hour cap (no file key may be set to outlive it); 0 once it's gone. */
	private async capLeft(id: string): Promise<number> {
		const h = await this.kv.hmget(K.room(id), "created");
		const created = Number(h?.created);
		if (!h?.created || !created) return 0;
		return Math.max(0, Math.floor((created + MAX_AGE_MS - this.now()) / 1000));
	}

	/**
	 * Tells pollers the file list changed. If the room ended a moment ago, HINCRBY recreates its
	 * hash; EXPIRE NX gives that one an expiry and leaves a live room's (it always has one) alone.
	 */
	private async bumpFiles(id: string) {
		await this.kv.hincrby(K.room(id), "fver", 1);
		await this.kv.expire(K.room(id), LEAVE_TTL_S, true);
	}

	/** Removes one file's keys and gives its bytes back; false if someone else removed it first. */
	private async dropFile(id: string, file: string, m: FileMeta): Promise<boolean> {
		if ((await this.kv.hdel(K.files(id), file)) !== 1) return false;
		const chunks = Array.from({ length: m.chunks }, (_, n) => K.chunk(id, file, n));
		await Promise.all([
			this.kv.hdel(K.files(id), `${file}#n`),
			chunks.length ? this.kv.del(...chunks) : null,
			this.kv.hincrby(K.usage, id, -m.size),
		]);
		return true;
	}

	/** Deletes every file of a room and its share of the site-wide count (the room ended). */
	private async purgeFiles(id: string) {
		const all = await this.kv.hgetall(K.files(id));
		const keys = [K.files(id)];
		for (const [field, v] of Object.entries(all ?? {})) {
			const m = field.includes("#") ? null : parseMeta(v);
			if (m) for (let n = 0; n < m.chunks; n++) keys.push(K.chunk(id, field, n));
		}
		await Promise.all([this.kv.del(...keys), this.kv.hdel(K.usage, id)]);
	}

	private lastSweep = Number.NEGATIVE_INFINITY;

	/** Files whose room vanished without an `end` (timed out, fell off the index): delete them. */
	private async sweepFiles(live: Set<string>, force = false) {
		const now = this.now();
		if (!force && now - this.lastSweep < SWEEP_EVERY_MS) return;
		this.lastSweep = now;
		const usage = await this.kv.hgetall(K.usage);
		const dead = Object.keys(usage ?? {}).filter((id) => !live.has(id));
		await Promise.all(dead.map((id) => (validId(id) ? this.purgeFiles(id) : this.kv.hdel(K.usage, id))));
	}

	private async totalFileBytes(): Promise<number> {
		const usage = await this.kv.hgetall(K.usage);
		return Object.values(usage ?? {}).reduce((sum, v) => sum + Math.max(0, Number(v) || 0), 0);
	}

	/** The room's files (unfinished uploads past their window are dropped here), or null if it's gone. */
	async listFiles(id: string) {
		const [cap, all] = await Promise.all([this.capLeft(id), this.kv.hgetall(K.files(id))]);
		if (!cap) return null;
		const now = this.now();
		const files: FileInfo[] = [];
		const stale: Promise<boolean>[] = [];
		for (const [field, v] of Object.entries(all ?? {})) {
			const m = field.includes("#") ? null : parseMeta(v);
			if (!m) continue;
			if (!m.done && now > m.until) stale.push(this.dropFile(id, field, m));
			else files.push({ ...m, id: field, got: Number(all?.[`${field}#n`] ?? 0) });
		}
		if (stale.length && (await Promise.all(stale)).some(Boolean)) await this.bumpFiles(id);
		files.sort((a, b) => b.at - a.at);
		const used = files.reduce((sum, f) => sum + f.size, 0);
		return { files, used, limit: MAX_ROOM_FILE_BYTES, maxFile: MAX_FILE_BYTES, maxFiles: MAX_ROOM_FILES };
	}

	/** Reserves room for a file (per-file, per-room and site-wide limits) before any chunk is sent. */
	async startFile(
		id: string,
		b: Record<string, unknown>,
	): Promise<{ file: string; chunk: number } | { error: FileError }> {
		const name = cleanFileName(b.name);
		const size = b.size;
		if (!name) return { error: "bad-name" };
		if (typeof size !== "number" || !Number.isInteger(size) || size < 1) return { error: "bad-size" };
		if (size > MAX_FILE_BYTES) return { error: "too-big" };
		const chunks = Math.ceil(size / FILE_CHUNK);
		const hashes = b.hashes;
		if (!Array.isArray(hashes) || hashes.length !== chunks || !hashes.every(validHash) || !validHash(b.sha256))
			return { error: "bad-hash" };

		const listed = await this.listFiles(id);
		if (!listed) return { error: "gone" };
		if (listed.files.length >= MAX_ROOM_FILES) return { error: "too-many" };
		// Reserve first, then check: two uploads racing can both be refused, never both let through.
		const roomBytes = await this.kv.hincrby(K.usage, id, size);
		await this.kv.expire(K.usage, MAX_AGE_MS / 1000 + 60);
		const giveBack = () => this.kv.hincrby(K.usage, id, -size);
		if (roomBytes > MAX_ROOM_FILE_BYTES) {
			await giveBack();
			return { error: "room-full" };
		}
		if ((await this.totalFileBytes()) > MAX_ALL_FILE_BYTES) {
			// Rooms that vanished may still be counted: clear them out and look again.
			await this.list(true);
			if ((await this.totalFileBytes()) > MAX_ALL_FILE_BYTES) {
				await giveBack();
				return { error: "site-full" };
			}
		}
		const cap = await this.capLeft(id);
		if (!cap) {
			await giveBack();
			return { error: "gone" };
		}
		const now = this.now();
		const file = randomId(8);
		const meta: FileMeta = {
			name,
			size,
			chunks,
			hashes,
			sha256: b.sha256 as string,
			at: now,
			done: false,
			until: now + UPLOAD_WINDOW_S * 1000,
		};
		await this.kv.hset(K.files(id), { [file]: JSON.stringify(meta), [`${file}#n`]: "0" });
		await Promise.all([this.kv.expire(K.files(id), cap), this.bumpFiles(id)]);
		return { file, chunk: FILE_CHUNK };
	}

	/** Stores chunk `n` of an upload once its size and SHA-256 match what was declared. */
	async putChunk(
		id: string,
		file: string,
		n: number,
		bytes: Uint8Array,
	): Promise<{ done: boolean } | { error: FileError }> {
		const [cap, h] = await Promise.all([this.capLeft(id), this.kv.hmget(K.files(id), file)]);
		if (!cap) return { error: "gone" };
		const m = parseMeta(h?.[file]);
		if (!m) return { error: "no-file" };
		if (m.done) return { done: true };
		const now = this.now();
		if (now > m.until) return { error: "expired" };
		if (!Number.isInteger(n) || n < 0 || n >= m.chunks || bytes.length !== chunkBytes(m, n))
			return { error: "bad-chunk" };
		if ((await sha256(bytes)) !== m.hashes[n]) return { error: "bad-hash" };
		// Until the upload completes, its chunks expire with the upload window.
		const ttl = Math.max(1, Math.min(cap, Math.ceil((m.until - now) / 1000)));
		// NX: a retried chunk (its first reply got lost) is stored and counted once.
		if (!(await this.kv.setNx(K.chunk(id, file, n), Buffer.from(bytes).toString("base64"), ttl)))
			return { done: false };
		const got = await this.kv.hincrby(K.files(id), `${file}#n`, 1);
		if (got !== m.chunks) return { done: false };
		// Every chunk is here, each the declared size and hash, so the reassembled file is exactly
		// the one the uploader hashed. Offer it, and keep its chunks until the room's cap.
		const done: FileMeta = { ...m, done: true, at: now };
		await Promise.all([
			this.kv.hset(K.files(id), { [file]: JSON.stringify(done) }),
			...Array.from({ length: m.chunks }, (_, i) => this.kv.expire(K.chunk(id, file, i), cap)),
		]);
		await this.bumpFiles(id);
		return { done: true };
	}

	/** Chunk `n` of a finished file, with the file's name. */
	async getChunk(
		id: string,
		file: string,
		n: number,
	): Promise<{ name: string; bytes: Uint8Array } | { error: FileError }> {
		const [cap, h, data] = await Promise.all([
			this.capLeft(id),
			this.kv.hmget(K.files(id), file),
			Number.isInteger(n) && n >= 0 && n < 1000 ? this.kv.get(K.chunk(id, file, n)) : null,
		]);
		if (!cap) return { error: "gone" };
		const m = parseMeta(h?.[file]);
		if (!m?.done || n >= m.chunks || data === null) return { error: "no-file" };
		const bytes = new Uint8Array(Buffer.from(data, "base64"));
		if (bytes.length !== chunkBytes(m, n)) return { error: "no-file" };
		return { name: m.name, bytes };
	}

	async deleteFile(id: string, file: string): Promise<"ok" | FileError> {
		const [cap, h] = await Promise.all([this.capLeft(id), this.kv.hmget(K.files(id), file)]);
		if (!cap) return "gone";
		const m = parseMeta(h?.[file]);
		if (!m) return "no-file";
		if (await this.dropFile(id, file, m)) await this.bumpFiles(id);
		return "ok";
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

const FILE_STATUS: Record<FileError, number> = {
	gone: 404,
	"no-file": 404,
	"bad-name": 400,
	"bad-size": 400,
	"bad-hash": 400,
	"bad-chunk": 400,
	"too-big": 413,
	"too-many": 413,
	"room-full": 413,
	"site-full": 507,
	expired: 410,
};
const fileError = (error: FileError) => json({ error }, FILE_STATUS[error]);

async function handleFiles(request: Request, rooms: Rooms, id: string, url: URL): Promise<Response> {
	const file = url.searchParams.get("file");
	const chunkParam = url.searchParams.get("chunk") ?? "";
	if (!validFile(file) || !/^\d{1,3}$/.test(chunkParam)) return json({ error: "bad-file" }, 400);
	const n = Number(chunkParam);
	if (!(await rooms.allowWrite(clientIp(request)))) return json({ error: "slow-down" }, 429);

	if (request.method === "GET") {
		const r = await rooms.getChunk(id, file, n);
		if ("error" in r) return fileError(r.error);
		return new Response(r.bytes as Uint8Array<ArrayBuffer>, {
			headers: {
				"content-type": "application/octet-stream",
				"content-disposition": attachment(r.name),
				"content-length": String(r.bytes.length),
				"x-content-type-options": "nosniff",
				"cache-control": "no-store",
			},
		});
	}
	if (request.method !== "PUT") return json({ error: "method" }, 405);
	const length = Number(request.headers.get("content-length") ?? 0);
	if (length > FILE_CHUNK) return json({ error: "bad-chunk" }, 413);
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.length > FILE_CHUNK) return json({ error: "bad-chunk" }, 413);
	const r = await rooms.putChunk(id, file, n, bytes);
	return "error" in r ? fileError(r.error) : json(r);
}

export async function handle(request: Request, rooms: Rooms): Promise<Response> {
	const url = new URL(request.url);
	const id = url.searchParams.get("id");
	const method = request.method;
	if (id !== null && !validId(id)) return json({ error: "bad-id" }, 400);
	if (id && url.searchParams.has("file")) return handleFiles(request, rooms, id, url);

	if (method === "GET") {
		if (!id) return json({ rooms: await rooms.list() });
		if (url.searchParams.has("files")) return json((await rooms.listFiles(id)) ?? { gone: true });
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
	if (b.action === "file-start") {
		const r = await rooms.startFile(id, b);
		return "error" in r ? fileError(r.error) : json(r, 201);
	}
	if (b.action === "file-delete") {
		if (!validFile(b.file)) return json({ error: "bad-file" }, 400);
		const r = await rooms.deleteFile(id, b.file);
		return r === "ok" ? json({ ok: true }) : fileError(r);
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
