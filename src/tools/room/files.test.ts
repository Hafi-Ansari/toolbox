// Files in a room, on the in-memory store and a clock the test moves by hand.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	attachment,
	cleanFileName,
	FILE_CHUNK,
	handle,
	type Kv,
	MAX_AGE_MS,
	MAX_ALL_FILE_BYTES,
	MAX_FILE_BYTES,
	MAX_ROOM_FILE_BYTES,
	MAX_ROOM_FILES,
	memoryKv,
	ROOM_TTL_S,
	Rooms,
	UPLOAD_WINDOW_S,
} from "../../../api/rooms.ts";

const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Deterministic bytes that differ per offset and seed. */
function bytes(size: number, seed = 1): Uint8Array {
	const out = new Uint8Array(size);
	let x = seed * 2654435761;
	for (let i = 0; i < size; i++) {
		x = (x * 1103515245 + 12345) >>> 0;
		out[i] = x >>> 24;
	}
	return out;
}

const chunksOf = (data: Uint8Array) => {
	const out: Uint8Array[] = [];
	for (let i = 0; i < data.length; i += FILE_CHUNK) out.push(data.subarray(i, i + FILE_CHUNK));
	return out;
};

function setup() {
	let t = 1_000_000;
	const clock = () => t;
	const base = memoryKv(clock);
	/** Every key written, to check prefixes and that nothing outlives its room. */
	const written = new Set<string>();
	const kv = new Proxy(base, {
		get(target, prop: keyof Kv) {
			const fn = target[prop] as (...a: unknown[]) => unknown;
			return (...args: unknown[]) => {
				if (["hset", "hincrby", "setNx", "zadd", "incr"].includes(prop)) written.add(String(args[0]));
				return fn(...args);
			};
		},
	});
	const rooms = new Rooms(kv, clock);
	const request = async (method: string, query = "", body?: unknown, ip = "1.2.3.4") =>
		handle(
			new Request(`http://x/api/rooms${query}`, {
				method,
				headers: {
					"x-real-ip": ip,
					"content-type": body instanceof Uint8Array ? "application/octet-stream" : "application/json",
				},
				body: body === undefined ? undefined : body instanceof Uint8Array ? (body as BodyInit) : JSON.stringify(body),
			}),
			rooms,
		);
	const call = async (method: string, query = "", body?: unknown, ip?: string) => {
		const res = await request(method, query, body, ip);
		return { status: res.status, json: await res.json() };
	};
	let ipCounter = 0;
	/** A fresh IP per call where a test sends many requests, so the per-IP limit stays out of the way. */
	const ip = () => `10.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}.1`;

	async function room() {
		const r = await call("POST", "", { action: "create" }, ip());
		expect(r.status).toBe(201);
		return r.json as { room: { id: string }; token: string };
	}
	const start = (id: string, name: string, data: Uint8Array, extra: Record<string, unknown> = {}) =>
		call(
			"POST",
			`?id=${id}`,
			{ action: "file-start", name, size: data.length, hashes: chunksOf(data).map(hex), sha256: hex(data), ...extra },
			ip(),
		);
	const put = (id: string, file: string, n: number, chunk: Uint8Array) =>
		call("PUT", `?id=${id}&file=${file}&chunk=${n}`, chunk, ip());
	async function upload(id: string, name: string, data: Uint8Array): Promise<string> {
		const s = await start(id, name, data);
		expect(s.status).toBe(201);
		const parts = chunksOf(data);
		for (let n = 0; n < parts.length; n++) {
			const r = await put(id, s.json.file, n, parts[n]);
			expect(r.json.done).toBe(n === parts.length - 1);
		}
		return s.json.file;
	}
	async function download(id: string, file: string, chunks: number): Promise<Uint8Array> {
		const parts: Uint8Array[] = [];
		for (let n = 0; n < chunks; n++) {
			const res = await request("GET", `?id=${id}&file=${file}&chunk=${n}`, undefined, ip());
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("application/octet-stream");
			parts.push(new Uint8Array(await res.arrayBuffer()));
		}
		return new Uint8Array(Buffer.concat(parts));
	}
	const files = (id: string) => call("GET", `?id=${id}&files=1`);
	const usage = async () => (await base.hgetall("toolbox:files:bytes")) ?? {};
	return {
		call,
		request,
		rooms,
		kv: base,
		written,
		room,
		start,
		put,
		upload,
		download,
		files,
		usage,
		ip,
		advance: (ms: number) => (t += ms),
	};
}

describe("files in a room", () => {
	it("uploads, lists, downloads byte-for-byte, and deletes, keeping the counters right", async () => {
		const s = setup();
		const { room } = await s.room();
		const data = bytes(FILE_CHUNK * 2 + 12345);
		const before = (await s.call("GET", `?id=${room.id}`)).json.fver;

		const file = await s.upload(room.id, "notes.bin", data);
		const after = (await s.call("GET", `?id=${room.id}&since=0`)).json.fver;
		expect(after).toBeGreaterThan(before);

		const list = await s.files(room.id);
		expect(list.json.files).toEqual([
			expect.objectContaining({
				id: file,
				name: "notes.bin",
				size: data.length,
				chunks: 3,
				done: true,
				got: 3,
				sha256: hex(data),
			}),
		]);
		expect(list.json.used).toBe(data.length);
		expect(list.json.limit).toBe(MAX_ROOM_FILE_BYTES);
		expect(await s.usage()).toEqual({ [room.id]: String(data.length) });

		const got = await s.download(room.id, file, 3);
		expect(got.length).toBe(data.length);
		expect(hex(got)).toBe(hex(data));
		const res = await s.request("GET", `?id=${room.id}&file=${file}&chunk=0`);
		expect(res.headers.get("content-disposition")).toBe(`attachment; filename="notes.bin"; filename*=UTF-8''notes.bin`);

		expect((await s.call("POST", `?id=${room.id}`, { action: "file-delete", file })).status).toBe(200);
		// Deleting twice is harmless and gives nothing back twice.
		await s.call("POST", `?id=${room.id}`, { action: "file-delete", file });
		expect((await s.files(room.id)).json.files).toEqual([]);
		expect(await s.usage()).toEqual({ [room.id]: "0" });
		expect(await s.kv.get(`toolbox:room:${room.id}:file:${file}:0`)).toBeNull();
		expect((await s.request("GET", `?id=${room.id}&file=${file}&chunk=0`)).status).toBe(404);
	});

	it("accepts chunks in any order, counts a retried chunk once, and offers the file only when complete", async () => {
		const s = setup();
		const { room } = await s.room();
		const data = bytes(FILE_CHUNK * 2 + 7, 2);
		const parts = chunksOf(data);
		const { json } = await s.start(room.id, "a.bin", data);
		expect((await s.put(room.id, json.file, 2, parts[2])).json.done).toBe(false);
		expect((await s.put(room.id, json.file, 2, parts[2])).json.done).toBe(false); // retry
		expect((await s.put(room.id, json.file, 0, parts[0])).json.done).toBe(false);
		const pending = (await s.files(room.id)).json.files[0];
		expect(pending).toMatchObject({ done: false, got: 2 });
		expect((await s.request("GET", `?id=${room.id}&file=${json.file}&chunk=0`)).status).toBe(404);
		expect((await s.put(room.id, json.file, 1, parts[1])).json.done).toBe(true);
		expect(hex(await s.download(room.id, json.file, 3))).toBe(hex(data));
	});

	it("rejects chunks of the wrong size, the wrong hash, or out of range", async () => {
		const s = setup();
		const { room } = await s.room();
		const data = bytes(FILE_CHUNK + 10, 3);
		const parts = chunksOf(data);
		const { json } = await s.start(room.id, "b.bin", data);
		expect((await s.put(room.id, json.file, 0, parts[0].subarray(1))).status).toBe(400);
		const tampered = parts[1].slice();
		tampered[0] ^= 1;
		expect((await s.put(room.id, json.file, 1, tampered)).json.error).toBe("bad-hash");
		expect((await s.put(room.id, json.file, 2, parts[1])).status).toBe(400);
		expect((await s.call("PUT", `?id=${room.id}&file=../../x&chunk=0`, parts[1])).status).toBe(400);
		expect((await s.call("PUT", `?id=${room.id}&file=0123456789abcdef&chunk=0`, parts[1])).status).toBe(404);
		expect((await s.files(room.id)).json.files[0]).toMatchObject({ done: false, got: 0 });
	});

	it("checks the declared upload: name, size, chunk hashes", async () => {
		const s = setup();
		const { room } = await s.room();
		const d = bytes(100);
		expect((await s.start(room.id, "../..", d)).json.error).toBe("bad-name");
		expect((await s.start(room.id, "a", d, { size: 0 })).json.error).toBe("bad-size");
		expect((await s.start(room.id, "a", d, { size: 1.5 })).json.error).toBe("bad-size");
		expect((await s.start(room.id, "a", d, { hashes: [] })).json.error).toBe("bad-hash");
		expect((await s.start(room.id, "a", d, { sha256: "x" })).json.error).toBe("bad-hash");
		expect(await s.usage()).toEqual({});
	});

	it("enforces the per-file, per-room and file-count limits", async () => {
		const s = setup();
		const { room } = await s.room();
		const big = await s.start(room.id, "big", new Uint8Array(1), { size: MAX_FILE_BYTES + 1, hashes: [] });
		expect(big.status).toBe(413);
		expect(big.json.error).toBe("too-big");

		// Two maximum-size files fill a room; a third byte doesn't fit.
		const max = bytes(MAX_FILE_BYTES, 4);
		await s.upload(room.id, "one", max);
		await s.upload(room.id, "two", max);
		expect(MAX_ROOM_FILE_BYTES).toBe(2 * MAX_FILE_BYTES);
		const over = await s.start(room.id, "three", bytes(1));
		expect(over.json.error).toBe("room-full");
		expect(await s.usage()).toEqual({ [room.id]: String(MAX_ROOM_FILE_BYTES) });

		const other = (await s.room()).room;
		for (let i = 0; i < MAX_ROOM_FILES; i++) expect((await s.start(other.id, `f${i}`, bytes(10, i))).status).toBe(201);
		expect((await s.start(other.id, "one more", bytes(10))).json.error).toBe("too-many");
	});

	it("enforces the site-wide limit across rooms, and frees it when a room ends", async () => {
		const s = setup();
		const max = bytes(MAX_FILE_BYTES, 5);
		const owners: { room: { id: string }; token: string }[] = [];
		let used = 0;
		for (; used + MAX_FILE_BYTES <= MAX_ALL_FILE_BYTES; used += MAX_FILE_BYTES) {
			if (owners.length === 0 || used % MAX_ROOM_FILE_BYTES === 0) owners.push(await s.room());
			const id = owners[owners.length - 1].room.id;
			await s.upload(id, `f${used}`, max);
		}
		const extra = await s.room();
		const refused = await s.start(extra.room.id, "x", bytes(MAX_ALL_FILE_BYTES - used + 1));
		expect(refused.status).toBe(507);
		expect(refused.json.error).toBe("site-full");

		await s.call("POST", `?id=${owners[0].room.id}`, { action: "end", token: owners[0].token });
		expect((await s.start(extra.room.id, "x", bytes(1000))).status).toBe(201);
		const total = Object.values(await s.usage()).reduce((a, v) => a + Number(v), 0);
		expect(total).toBeLessThanOrEqual(MAX_ALL_FILE_BYTES);
	});

	it("deletes a room's files when its owner ends it", async () => {
		const s = setup();
		const { room, token } = await s.room();
		const file = await s.upload(room.id, "x.bin", bytes(FILE_CHUNK + 1));
		await s.call("POST", `?id=${room.id}`, { action: "end", token });
		expect(await s.kv.get(`toolbox:room:${room.id}:file:${file}:0`)).toBeNull();
		expect(await s.kv.get(`toolbox:room:${room.id}:file:${file}:1`)).toBeNull();
		expect(await s.kv.hgetall(`toolbox:room:${room.id}:files`)).toBeNull();
		expect(await s.usage()).toEqual({});
		expect((await s.files(room.id)).json).toEqual({ gone: true });
	});

	it("deletes the files of a room that timed out, the next time the lobby is listed", async () => {
		const s = setup();
		const { room } = await s.room();
		const file = await s.upload(room.id, "x.bin", bytes(5000));
		s.advance((ROOM_TTL_S + 1) * 1000);
		expect((await s.call("GET", `?id=${room.id}`)).json.gone).toBe(true);
		// Not yet listed: the bytes are still counted; listing the lobby sweeps them.
		expect(Object.keys(await s.usage())).toEqual([room.id]);
		await s.call("GET");
		expect(await s.usage()).toEqual({});
		expect(await s.kv.get(`toolbox:room:${room.id}:file:${file}:0`)).toBeNull();
	});

	it("never lets a file outlive the room's 2-hour cap, even with nobody calling", async () => {
		const s = setup();
		const { room, token } = await s.room();
		for (let t = 0; t < MAX_AGE_MS - 10 * 60_000; t += 60_000) {
			s.advance(60_000);
			await s.call("POST", `?id=${room.id}`, { action: "beat", token }, s.ip());
		}
		const file = await s.upload(room.id, "late.bin", bytes(FILE_CHUNK + 3));
		s.advance(10 * 60_000);
		// The cap has passed: every file key of the room has expired by itself.
		expect(await s.kv.get(`toolbox:room:${room.id}:file:${file}:0`)).toBeNull();
		expect(await s.kv.hgetall(`toolbox:room:${room.id}:files`)).toBeNull();
		s.advance(MAX_AGE_MS + 61_000);
		for (const key of s.written) {
			expect(key.startsWith("toolbox:")).toBe(true);
			// The lobby's index is the one long-lived key: listing trims its entries.
			if (key === "toolbox:rooms") continue;
			expect([await s.kv.get(key), await s.kv.hgetall(key), (await s.kv.zrangeAll(key)).length || null]).toEqual([
				null,
				null,
				null,
			]);
		}
	});

	it("drops an unfinished upload after its window: its chunks expire and its bytes come back", async () => {
		const s = setup();
		const { room, token } = await s.room();
		const data = bytes(FILE_CHUNK * 2);
		const { json } = await s.start(room.id, "half.bin", data);
		await s.put(room.id, json.file, 0, chunksOf(data)[0]);
		for (let t = 0; t <= UPLOAD_WINDOW_S; t += 60) {
			s.advance(60_000);
			await s.call("POST", `?id=${room.id}`, { action: "beat", token }, s.ip());
		}
		expect(await s.kv.get(`toolbox:room:${room.id}:file:${json.file}:0`)).toBeNull();
		expect((await s.put(room.id, json.file, 1, chunksOf(data)[1])).json.error).toBe("expired");
		expect((await s.files(room.id)).json.files).toEqual([]);
		expect(await s.usage()).toEqual({ [room.id]: "0" });
	});

	it("rate-limits file chunks per IP with the other writes", async () => {
		const s = setup();
		const { room } = await s.room();
		const file = await s.upload(room.id, "x", bytes(10));
		let last = 0;
		for (let i = 0; i < 125; i++)
			last = (await s.request("GET", `?id=${room.id}&file=${file}&chunk=0`, undefined, "9.9.9.9")).status;
		expect(last).toBe(429);
	});
});

describe("file names", () => {
	it("keeps only the base name, without control or direction-changing characters", () => {
		expect(cleanFileName("C:\\Users\\me\\photo.jpg")).toBe("photo.jpg");
		expect(cleanFileName("../../etc/passwd")).toBe("passwd");
		expect(cleanFileName("evil\u202Etxt.exe")).toBe("eviltxt.exe");
		expect(cleanFileName("a\u0000b\nc\u2066d.txt")).toBe("abcd.txt");
		expect(cleanFileName('what?"<>|*.txt')).toBe("what______.txt");
		expect(cleanFileName("  ..  ")).toBe("");
		expect(cleanFileName("..")).toBe("");
		expect(cleanFileName("dir/")).toBe("");
		expect(cleanFileName(42)).toBe("");
		expect(Array.from(cleanFileName(`${"😀".repeat(200)}.txt`)).length).toBe(120);
		expect(cleanFileName("Résumé 2026.pdf")).toBe("Résumé 2026.pdf");
	});

	it("builds a Content-Disposition header with an ASCII fallback and the UTF-8 name", () => {
		expect(attachment("Résumé (1).pdf")).toBe(
			`attachment; filename="R_sum_ (1).pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%281%29.pdf`,
		);
		expect(attachment('a"b\\c%.txt')).toBe(`attachment; filename="a_b_c_.txt"; filename*=UTF-8''a%22b%5Cc%25.txt`);
	});
});
