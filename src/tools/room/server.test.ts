import { describe, expect, it } from "vitest";
import {
	handle,
	type Kv,
	LEAVE_TTL_S,
	MAX_AGE_MS,
	MAX_ROOMS,
	MAX_TEXT_BYTES,
	memoryKv,
	ROOM_TTL_S,
	Rooms,
} from "../../../api/rooms.ts";

/** A store and an HTTP client on a clock the test moves by hand. */
function setup() {
	let t = 1_000_000;
	const clock = () => t;
	const keys = new Set<string>();
	const base = memoryKv(clock);
	// Record every key touched, to prove they all live under the toolbox: prefix.
	const kv = new Proxy(base, {
		get(target, prop: keyof Kv) {
			const fn = target[prop] as (...a: unknown[]) => unknown;
			return (...args: unknown[]) => {
				if (prop === "del") for (const k of args) keys.add(String(k));
				else keys.add(String(args[0]));
				return fn(...args);
			};
		},
	});
	const rooms = new Rooms(kv, clock);
	const call = async (method: string, query = "", body?: unknown, ip = "1.2.3.4") => {
		const res = await handle(
			new Request(`http://x/api/rooms${query}`, {
				method,
				headers: { "x-real-ip": ip, "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			rooms,
		);
		return { status: res.status, json: await res.json() };
	};
	return { call, rooms, keys, advance: (ms: number) => (t += ms) };
}

async function create(call: ReturnType<typeof setup>["call"]) {
	const r = await call("POST", "", { action: "create" });
	expect(r.status).toBe(201);
	return r.json as { room: { id: string; name: string }; token: string };
}

describe("shared rooms", () => {
	it("creates a room that shows in the list and syncs text between clients", async () => {
		const { call } = setup();
		const { room } = await create(call);
		expect(room.id).toMatch(/^[0-9a-f]{10}$/);
		expect(room.name).toMatch(/^\w+ \w+$/);

		const list = await call("GET");
		expect(list.json.rooms.map((r: { id: string }) => r.id)).toEqual([room.id]);

		const first = await call("GET", `?id=${room.id}&client=phone-123`);
		expect(first.json).toMatchObject({ ver: 0, text: "" });
		const w = await call("PUT", `?id=${room.id}`, { text: "https://example.com/a" });
		expect(w.json.ver).toBe(1);

		const again = await call("GET", `?id=${room.id}&since=0&client=laptop-456`);
		expect(again.json).toMatchObject({ ver: 1, text: "https://example.com/a" });
		// Polling with the current version sends no text.
		const same = await call("GET", `?id=${room.id}&since=1&client=laptop-456`);
		expect(same.json.ver).toBe(1);
		expect(same.json.text).toBeUndefined();

		const listed = await call("GET");
		expect(listed.json.rooms[0].here).toBe(2);
	});

	it("keeps text a string even when it looks like a number", async () => {
		const { call } = setup();
		const { room } = await create(call);
		await call("PUT", `?id=${room.id}`, { text: "123" });
		expect((await call("GET", `?id=${room.id}`)).json.text).toBe("123");
	});

	it("lets only the owner keep the room alive or end it", async () => {
		const { call } = setup();
		const { room, token } = await create(call);
		expect((await call("POST", `?id=${room.id}`, { action: "end", token: "nope" })).status).toBe(403);
		expect((await call("POST", `?id=${room.id}`, { action: "beat" })).status).toBe(403);
		expect((await call("POST", `?id=${room.id}`, { action: "beat", token })).status).toBe(200);
		expect((await call("POST", `?id=${room.id}`, { action: "end", token })).status).toBe(200);
		expect((await call("GET", `?id=${room.id}`)).json.gone).toBe(true);
		expect((await call("GET")).json.rooms).toEqual([]);
	});

	it("ends a room whose owner stops sending heartbeats", async () => {
		const { call, advance } = setup();
		const { room, token } = await create(call);
		advance((ROOM_TTL_S - 10) * 1000);
		await call("POST", `?id=${room.id}`, { action: "beat", token });
		advance((ROOM_TTL_S - 10) * 1000);
		expect((await call("GET", `?id=${room.id}`)).json.ver).toBe(0);
		advance(20_000);
		expect((await call("GET", `?id=${room.id}`)).json.gone).toBe(true);
		expect((await call("GET")).json.rooms).toEqual([]);
	});

	it("ends a room soon after its owner leaves the page, unless the owner comes back", async () => {
		const { call, advance } = setup();
		const a = await create(call);
		await call("POST", `?id=${a.room.id}`, { action: "leave", token: a.token });
		advance((LEAVE_TTL_S - 5) * 1000);
		// A reload: the owner's page beats again and the room lives on.
		await call("POST", `?id=${a.room.id}`, { action: "beat", token: a.token });
		advance(30_000);
		expect((await call("GET", `?id=${a.room.id}`)).json.ver).toBe(0);

		await call("POST", `?id=${a.room.id}`, { action: "leave", token: a.token });
		advance((LEAVE_TTL_S + 1) * 1000);
		expect((await call("GET", `?id=${a.room.id}`)).json.gone).toBe(true);
		expect((await call("GET")).json.rooms).toEqual([]);
	});

	it("ends every room after the maximum age, heartbeats or not", async () => {
		const { call, advance } = setup();
		const { room, token } = await create(call);
		for (let t = 0; t < MAX_AGE_MS; t += 60_000) {
			advance(60_000);
			await call("POST", `?id=${room.id}`, { action: "beat", token }, `10.0.0.${t % 200}`);
		}
		advance(1000);
		expect((await call("GET", `?id=${room.id}`)).json.gone).toBe(true);
		expect((await call("PUT", `?id=${room.id}`, { text: "late" })).status).toBe(404);
		expect((await call("GET")).json.rooms).toEqual([]);
	});

	it("rejects oversize text, bad ids, unknown actions, and too many rooms", async () => {
		const { call } = setup();
		const { room } = await create(call);
		expect((await call("PUT", `?id=${room.id}`, { text: "x".repeat(MAX_TEXT_BYTES + 1) })).status).toBe(413);
		expect((await call("GET", "?id=../../etc")).status).toBe(400);
		expect((await call("POST", `?id=${room.id}`, { action: "explode" })).status).toBe(400);
		for (let i = 1; i < MAX_ROOMS; i++) await call("POST", "", { action: "create" }, `10.1.${i}.1`);
		expect((await call("POST", "", { action: "create" }, "10.9.9.9")).status).toBe(429);
	});

	it("rate-limits writes per IP", async () => {
		const { call } = setup();
		const { room } = await create(call);
		let last = 0;
		for (let i = 0; i < 130; i++) last = (await call("PUT", `?id=${room.id}`, { text: String(i) })).status;
		expect(last).toBe(429);
		expect((await call("PUT", `?id=${room.id}`, { text: "other ip" }, "5.6.7.8")).status).toBe(200);
	});

	it("keeps every key under the toolbox: prefix", async () => {
		const { call, keys } = setup();
		const { room, token } = await create(call);
		await call("GET", `?id=${room.id}&client=abcdef1`);
		await call("PUT", `?id=${room.id}`, { text: "hi" });
		await call("POST", `?id=${room.id}`, { action: "end", token });
		expect([...keys].every((k) => k.startsWith("toolbox:"))).toBe(true);
	});
});
