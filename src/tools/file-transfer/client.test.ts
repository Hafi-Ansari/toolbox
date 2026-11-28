// client.ts: identity storage, the ApiClient's wire format and errors, and Signaling over the real handler.
import { describe, expect, it, vi } from "vitest";
import { FileTransfer, handle, memoryKv } from "../../../api/file-transfer.ts";
import { createApiClient, createSignaling, loadIdentity, saveProfile, signalingFor } from "./client.ts";
import { STORAGE_KEY } from "./tuning.ts";
import { type ApiClient, FtError, type Identity, isPeerId, isSecret } from "./types.ts";

function memoryStorage(): Storage {
	const m = new Map<string, string>();
	return {
		get length() {
			return m.size;
		},
		clear: () => m.clear(),
		getItem: (k) => m.get(k) ?? null,
		setItem: (k, v) => void m.set(k, String(v)),
		removeItem: (k) => void m.delete(k),
		key: (i) => [...m.keys()][i] ?? null,
	};
}

/** ApiClients that talk to one in-memory server through `handle`, as fetch would. */
function server() {
	const ft = new FileTransfer(memoryKv(), { salt: "s" });
	const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
		handle(new Request(new URL(String(url), "http://x"), init), ft),
	);
	const client = (identity: Identity) =>
		createApiClient(identity, { fetch: fetch as unknown as typeof globalThis.fetch });
	return { fetch, client };
}

const A: Identity = { peer: "000000000000000a", secret: "a".repeat(32) };
const B: Identity = { peer: "000000000000000b", secret: "b".repeat(32) };

describe("identity", () => {
	it("creates one on first use and keeps it with the profile", () => {
		const storage = memoryStorage();
		const first = loadIdentity(storage);
		expect(isPeerId(first.identity.peer)).toBe(true);
		expect(isSecret(first.identity.secret)).toBe(true);
		expect(first.profile).toEqual({ name: "", emoji: "", hidden: false });
		saveProfile(first.identity, { name: "Calm Otter", emoji: "🦦", hidden: true }, storage);
		const again = loadIdentity(storage);
		expect(again.identity).toEqual(first.identity);
		expect(again.profile).toEqual({ name: "Calm Otter", emoji: "🦦", hidden: true });
		expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? "")).toMatchObject({ peer: first.identity.peer });
	});

	it("replaces a corrupt entry and survives missing storage", () => {
		const storage = memoryStorage();
		storage.setItem(STORAGE_KEY, "{nope");
		expect(isPeerId(loadIdentity(storage).identity.peer)).toBe(true);
		expect(isPeerId(loadIdentity(null).identity.peer)).toBe(true);
	});
});

describe("ApiClient", () => {
	it("posts JSON with the action, peer and secret, and returns the answer", async () => {
		const { fetch, client } = server();
		const r = await client(A).call("poll", { name: "", emoji: "", hidden: false, busy: false });
		expect(r.you.id).toBe(A.peer);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe("/api/file-transfer");
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toEqual({
			action: "poll",
			peer: A.peer,
			secret: A.secret,
			name: "",
			emoji: "",
			hidden: false,
			busy: false,
		});
	});

	it("throws FtError with the server's code, or signal-error", async () => {
		const { client } = server();
		const api = client(A);
		await api.call("poll", { name: "", emoji: "", hidden: false, busy: false });
		await expect(api.call("request", { to: A.peer })).rejects.toMatchObject({ code: "self" });
		await expect(api.call("request", { to: B.peer })).rejects.toMatchObject({ code: "gone" });

		const down = createApiClient(A, { fetch: async () => Promise.reject(new TypeError("offline")) });
		await expect(down.call("leave", {})).rejects.toEqual(new FtError("signal-error"));
		const html = createApiClient(A, { fetch: async () => new Response("<h1>502</h1>", { status: 502 }) });
		await expect(html.call("leave", {})).rejects.toMatchObject({ code: "signal-error" });
		const odd = createApiClient(A, { fetch: async () => Response.json({ error: "made-up" }, { status: 400 }) });
		await expect(odd.call("leave", {})).rejects.toMatchObject({ code: "signal-error" });
	});

	it("sends leave with keepalive, so it outlives the page", async () => {
		const { fetch, client } = server();
		const api = client(A);
		await api.call("poll", { name: "", emoji: "", hidden: false, busy: false });
		api.leaveBeacon();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
		const init = fetch.mock.calls[1][1];
		expect(init?.keepalive).toBe(true);
		expect(JSON.parse(String(init?.body))).toMatchObject({ action: "leave", peer: A.peer });
	});
});

describe("Signaling", () => {
	async function paired() {
		const { client } = server();
		const a = client(A);
		const b = client(B);
		const profile = { name: "", emoji: "", hidden: false, busy: false };
		await a.call("poll", profile);
		await b.call("poll", profile);
		const { pair } = await a.call("request", { to: B.peer });
		await b.call("respond", { pair, accept: true });
		return { a, b, pair };
	}

	it("carries lane 0's offer and answer through the server", async () => {
		const { a, b, pair } = await paired();
		const sa = signalingFor(
			a,
			A.peer,
			{ pair, remote: { id: B.peer, name: "", emoji: "" }, offerer: true },
			{ readMs: 5 },
		);
		const sb = createSignaling({ api: b, self: B.peer, pair, remote: A.peer, offerer: false, readMs: 5 });
		expect(sa).toMatchObject({ pair, self: A.peer, remote: B.peer, offerer: true });
		const offer = sb.next();
		await sa.send({ type: "offer", sdp: "v=0 offer" });
		expect(await offer).toEqual({ type: "offer", sdp: "v=0 offer" });
		await sb.send({ type: "answer", sdp: "v=0 answer" });
		expect(await sa.next()).toEqual({ type: "answer", sdp: "v=0 answer" });
	});

	it("gives up with failed-direct when nothing arrives in time", async () => {
		const { a, pair } = await paired();
		const s = createSignaling({ api: a, self: A.peer, pair, remote: B.peer, offerer: true, readMs: 5, maxMs: 40 });
		await expect(s.next()).rejects.toMatchObject({ code: "failed-direct" });
	});

	it("stops on abort with the abort reason", async () => {
		const { a, pair } = await paired();
		const s = createSignaling({ api: a, self: A.peer, pair, remote: B.peer, offerer: true, readMs: 5 });
		const ac = new AbortController();
		const p = s.next(ac.signal);
		ac.abort(new Error("closed"));
		await expect(p).rejects.toThrow("closed");
	});

	it("rides out a couple of dropped reads, but not a server error", async () => {
		const flaky = (fails: number, then: () => Promise<unknown>): ApiClient => {
			let n = 0;
			return {
				call: (async () => (n++ < fails ? Promise.reject(new FtError("signal-error")) : then())) as ApiClient["call"],
				leaveBeacon() {},
			};
		};
		const ok = flaky(2, async () => ({ payload: { type: "answer", sdp: "x" } }));
		const opts = { self: A.peer, pair: "1".repeat(16), remote: B.peer, offerer: true, readMs: 1 };
		expect(await createSignaling({ ...opts, api: ok }).next()).toEqual({ type: "answer", sdp: "x" });
		const down = flaky(3, async () => ({ payload: null }));
		await expect(createSignaling({ ...opts, api: down }).next()).rejects.toMatchObject({ code: "signal-error" });
		const refused = flaky(0, () => Promise.reject(new FtError("auth")));
		await expect(createSignaling({ ...opts, api: refused }).next()).rejects.toMatchObject({ code: "auth" });
		await expect(createSignaling({ ...opts, api: refused }).send({ type: "offer", sdp: "x" })).rejects.toMatchObject({
			code: "auth",
		});
	});
});
