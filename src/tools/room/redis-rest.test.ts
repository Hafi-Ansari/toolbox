// Runs the rooms logic through the real @upstash/redis client, against a stand-in for Upstash's
// REST API that answers in Redis's raw reply shapes (HMGET as an array, HGETALL flat, numbers as
// numbers). The in-memory store used elsewhere hides those shapes; this is what caught HMGET
// coming back as an array, which made every new room read as "ended" in production.
import { afterEach, describe, expect, it, vi } from "vitest";
import { handle, Rooms, redisKv } from "../../../api/rooms.ts";

type Reply = string | number | null | Reply[];

/** Just enough Redis for the rooms code, replying like the real server (strings stay strings). */
function fakeRedis(now: () => number) {
	const hashes = new Map<string, Map<string, string>>();
	const zsets = new Map<string, Map<string, number>>();
	const strings = new Map<string, string>();
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
			case "expire":
				return hashes.has(key) || zsets.has(key) || strings.has(key) ? 1 : 0;
			case "del":
				for (const k of a) {
					hashes.delete(String(k));
					zsets.delete(String(k));
					strings.delete(String(k));
				}
				return a.length;
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
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const body = JSON.parse(String(init?.body));
		const json = url.endsWith("/pipeline") ? (body as unknown[][]).map(reply) : reply(body as unknown[]);
		return new Response(JSON.stringify(json), { headers: { "content-type": "application/json" } });
	});
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
});
