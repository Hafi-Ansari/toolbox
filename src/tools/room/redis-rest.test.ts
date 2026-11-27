// Runs the rooms logic through the real @upstash/redis client, against a stand-in for Upstash's
// REST API that answers in Redis's raw reply shapes (HMGET as an array, HGETALL flat, numbers as
// numbers). The in-memory store used elsewhere hides those shapes; this is what caught HMGET
// coming back as an array, which made every new room read as "ended" in production.

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_CHUNK, handle, Rooms, redisKv } from "../../../api/rooms.ts";

type Reply = string | number | null | Reply[];

/** Just enough Redis for the rooms code, replying like the real server (strings stay strings). */
function fakeRedis(now: () => number) {
	const hashes = new Map<string, Map<string, string>>();
	const zsets = new Map<string, Map<string, number>>();
	const strings = new Map<string, string>();
	/** Keys with an expiry (time isn't simulated here; this is for EXPIRE NX and for checks). */
	const ttl = new Map<string, number>();
	const exists = (k: string) => hashes.has(k) || zsets.has(k) || strings.has(k);
	const num = (v: unknown) => {
		const s = String(v);
		if (s === "+inf") return Number.POSITIVE_INFINITY;
		if (s === "-inf") return Number.NEGATIVE_INFINITY;
		const n = Number(s);
		if (v === null || Number.isNaN(n)) throw new Error("ERR min or max is not a float");
		return n;
	};
	const run = ([name, ...a]: unknown[]): Reply => {
		const key = String(a[0]);
		switch (String(name).toLowerCase()) {
			case "hset": {
				const h = hashes.get(key) ?? new Map();
				hashes.set(key, h);
				for (let i = 1; i < a.length; i += 2) h.set(String(a[i]), String(a[i + 1]));
				return (a.length - 1) / 2;
			}
			case "hmget":
				return a.slice(1).map((f) => hashes.get(key)?.get(String(f)) ?? null);
			case "hgetall":
				return [...(hashes.get(key) ?? [])].flat();
			case "hincrby": {
				const h = hashes.get(key) ?? new Map();
				hashes.set(key, h);
				const v = Number(h.get(String(a[1])) ?? 0) + Number(a[2]);
				h.set(String(a[1]), String(v));
				return v;
			}
			case "expire": {
				const nx = String(a[2] ?? "").toLowerCase() === "nx";
				if (!exists(key) || (nx && ttl.has(key))) return 0;
				ttl.set(key, Number(a[1]));
				return 1;
			}
			case "del": {
				let n = 0;
				for (const k of a.map(String)) {
					if (exists(k)) n++;
					hashes.delete(k);
					zsets.delete(k);
					strings.delete(k);
					ttl.delete(k);
				}
				return n;
			}
			case "hdel": {
				const h = hashes.get(key);
				let n = 0;
				for (const f of a.slice(1)) if (h?.delete(String(f))) n++;
				if (h?.size === 0) hashes.delete(key);
				return n;
			}
			case "set": {
				// SET key value [NX] [EX seconds]: "OK", or a null reply when NX finds the key.
				const opts = a.slice(2).map((o) => String(o).toLowerCase());
				if (opts.includes("nx") && exists(key)) return null;
				if (typeof a[1] !== "string") throw new Error("ERR value is not a string");
				strings.set(key, a[1]);
				const ex = opts.indexOf("ex");
				if (ex >= 0) ttl.set(key, Number(opts[ex + 1]));
				else ttl.delete(key);
				return "OK";
			}
			case "get":
				if (hashes.has(key) || zsets.has(key)) throw new Error("WRONGTYPE");
				return strings.get(key) ?? null;
			case "zadd": {
				const z = zsets.get(key) ?? new Map();
				zsets.set(key, z);
				z.set(String(a[2]), num(a[1]));
				return 1;
			}
			case "zrem":
				return zsets.get(key)?.delete(String(a[1])) ? 1 : 0;
			case "zrange":
				return [...(zsets.get(key) ?? [])].sort((x, y) => x[1] - y[1]).map(([m]) => m);
			case "zremrangebyscore": {
				const [lo, hi] = [num(a[1]), num(a[2])];
				let n = 0;
				for (const [m, sc] of zsets.get(key) ?? []) if (sc >= lo && sc <= hi && zsets.get(key)?.delete(m)) n++;
				return n;
			}
			case "zcount": {
				const [lo, hi] = [num(a[1]), num(a[2])];
				return [...(zsets.get(key)?.values() ?? [])].filter((sc) => sc >= lo && sc <= hi).length;
			}
			case "incr": {
				const v = Number(strings.get(key) ?? 0) + 1;
				strings.set(key, String(v));
				return v;
			}
			default:
				throw new Error(`ERR unknown command '${name}'`);
		}
	};
	const reply = (cmd: unknown[]) => {
		try {
			return { result: run(cmd) };
		} catch (e) {
			return { error: (e as Error).message };
		}
	};
	void now;
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const body = JSON.parse(String(init?.body));
		const json = url.endsWith("/pipeline") ? (body as unknown[][]).map(reply) : reply(body as unknown[]);
		return new Response(JSON.stringify(json), { headers: { "content-type": "application/json" } });
	});
	return Object.assign(fetch, { keys: () => [...hashes.keys(), ...zsets.keys(), ...strings.keys()], ttl });
}

afterEach(() => vi.unstubAllGlobals());

describe("rooms through the real Upstash client", () => {
	it("creates, lists, syncs and ends a room", async () => {
		const t = 1_795_744_514_002;
		vi.stubGlobal(
			"fetch",
			fakeRedis(() => t),
		);
		const rooms = new Rooms(redisKv("https://example.upstash.io", "token"), () => t);
		const call = async (method: string, query = "", body?: unknown) => {
			const res = await handle(
				new Request(`http://x/api/rooms${query}`, {
					method,
					headers: { "x-real-ip": "1.2.3.4", "content-type": "application/json" },
					body: body === undefined ? undefined : JSON.stringify(body),
				}),
				rooms,
			);
			return { status: res.status, json: await res.json() };
		};

		const created = await call("POST", "", { action: "create" });
		expect(created.status).toBe(201);
		const { room, token } = created.json;

		const read = await call("GET", `?id=${room.id}&client=phone-1234`);
		expect(read.json).toMatchObject({ ver: 0, text: "", name: room.name });
		expect(read.json.gone).toBeUndefined();

		expect((await call("POST", `?id=${room.id}`, { action: "beat", token })).status).toBe(200);
		expect((await call("PUT", `?id=${room.id}`, { text: "123" })).json.ver).toBe(1);
		const after = await call("GET", `?id=${room.id}&since=0&client=phone-1234`);
		expect(after.json).toMatchObject({ ver: 1, text: "123" });

		const list = await call("GET");
		expect(list.status).toBe(200);
		expect(list.json.rooms).toEqual([expect.objectContaining({ id: room.id, here: 1 })]);

		expect((await call("POST", `?id=${room.id}`, { action: "end", token })).status).toBe(200);
		expect((await call("GET", `?id=${room.id}`)).json.gone).toBe(true);
		expect((await call("GET")).json.rooms).toEqual([]);
	});

	it("uploads, downloads, deletes and cleans up files", async () => {
		const t = 1_795_744_514_002;
		const redis = fakeRedis(() => t);
		vi.stubGlobal("fetch", redis);
		const rooms = new Rooms(redisKv("https://example.upstash.io", "token"), () => t);
		const request = (method: string, query = "", body?: unknown) =>
			handle(
				new Request(`http://x/api/rooms${query}`, {
					method,
					headers: { "x-real-ip": "1.2.3.4", "content-type": "application/json" },
					body: body === undefined ? undefined : body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
				}),
				rooms,
			);
		const call = async (method: string, query = "", body?: unknown) => {
			const res = await request(method, query, body);
			return { status: res.status, json: await res.json() };
		};
		const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

		const { room, token } = (await call("POST", "", { action: "create" })).json;
		// Every byte value, and a size that leaves a short last chunk.
		const data = new Uint8Array(FILE_CHUNK + 1000).map((_, i) => (i * 31 + (i >> 8)) & 255);
		const parts = [data.subarray(0, FILE_CHUNK), data.subarray(FILE_CHUNK)];
		const started = await call("POST", `?id=${room.id}`, {
			action: "file-start",
			name: "123",
			size: data.length,
			hashes: parts.map(hex),
			sha256: hex(data),
		});
		expect(started.status).toBe(201);
		const file = started.json.file as string;
		expect((await call("PUT", `?id=${room.id}&file=${file}&chunk=1`, parts[1])).json).toEqual({ done: false });
		// A retry finds the chunk already stored (SET NX's null reply) and isn't counted twice.
		expect((await call("PUT", `?id=${room.id}&file=${file}&chunk=1`, parts[1])).json).toEqual({ done: false });
		expect((await call("PUT", `?id=${room.id}&file=${file}&chunk=0`, parts[0])).json).toEqual({ done: true });

		const poll = await call("GET", `?id=${room.id}&client=phone-1234`);
		expect(poll.json.fver).toBe(2);
		const list = await call("GET", `?id=${room.id}&files=1`);
		// The name stays a string even though it looks like a number.
		expect(list.json.files).toEqual([
			expect.objectContaining({ id: file, name: "123", size: data.length, done: true, got: 2 }),
		]);
		expect(list.json.used).toBe(data.length);

		const got: Uint8Array[] = [];
		for (const n of [0, 1]) {
			const res = await request("GET", `?id=${room.id}&file=${file}&chunk=${n}`);
			expect(res.status).toBe(200);
			got.push(new Uint8Array(await res.arrayBuffer()));
		}
		expect(hex(new Uint8Array(Buffer.concat(got)))).toBe(hex(data));

		// Every file key has an expiry: the files hash, both chunks, and the site-wide byte count.
		const fileKeys = redis.keys().filter((k) => k.includes(":file"));
		expect(fileKeys.length).toBe(4);
		for (const k of fileKeys) expect(redis.ttl.get(k)).toBeGreaterThan(0);

		expect((await call("POST", `?id=${room.id}`, { action: "file-delete", file })).status).toBe(200);
		expect((await call("GET", `?id=${room.id}&files=1`)).json.files).toEqual([]);
		expect(redis.keys().filter((k) => k.includes(":file:"))).toEqual([]);

		// A second file, then the owner ends the room: nothing of the room is left.
		const small = new Uint8Array([1, 2, 3]);
		const second = await call("POST", `?id=${room.id}`, {
			action: "file-start",
			name: "s.bin",
			size: 3,
			hashes: [hex(small)],
			sha256: hex(small),
		});
		await call("PUT", `?id=${room.id}&file=${second.json.file}&chunk=0`, small);
		expect((await call("POST", `?id=${room.id}`, { action: "end", token })).status).toBe(200);
		expect(redis.keys().filter((k) => k.includes(room.id) || k === "toolbox:files:bytes")).toEqual([]);
		expect(redis.keys().every((k) => k.startsWith("toolbox:"))).toBe(true);
	});
});
