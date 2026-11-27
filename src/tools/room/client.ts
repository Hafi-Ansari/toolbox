// Talking to /api/rooms from the browser, plus the bits of state a tab keeps for itself:
// a client id (so a room can count who's here) and the owner tokens of rooms it created.

export interface RoomInfo {
	id: string;
	name: string;
	emoji: string;
	created: number;
	here: number;
}

export interface RoomState {
	ver: number;
	updated: number;
	created: number;
	name: string;
	emoji: string;
	text?: string;
}

export class Gone extends Error {}

const API = "/api/rooms";

function session<T>(key: string, fallback: T): T {
	try {
		const v = sessionStorage.getItem(key);
		return v ? (JSON.parse(v) as T) : fallback;
	} catch {
		return fallback;
	}
}

function keep(key: string, value: unknown) {
	try {
		sessionStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Private mode: ownership just won't survive a reload.
	}
}

/** Per tab, kept across reloads (sessionStorage), so a reload counts as the same device. */
export const clientId: string = (() => {
	const existing = session<string | null>("toolbox.room.client", null);
	if (existing) return existing;
	const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
	keep("toolbox.room.client", id);
	return id;
})();

const TOKENS = "toolbox.room.tokens";
export const ownerToken = (id: string): string | undefined => session<Record<string, string>>(TOKENS, {})[id];
const saveToken = (id: string, token: string | null) => {
	const all = session<Record<string, string>>(TOKENS, {});
	if (token) all[id] = token;
	else delete all[id];
	keep(TOKENS, all);
};

async function call<T>(method: string, query = "", body?: unknown, signal?: AbortSignal): Promise<T> {
	const res = await fetch(`${API}${query}`, {
		method,
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		cache: "no-store",
		signal,
	});
	if (res.status === 404) throw new Gone();
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
	return json as T;
}

export const listRooms = (signal?: AbortSignal) =>
	call<{ rooms: RoomInfo[] }>("GET", "", undefined, signal).then((r) => r.rooms);

export async function createRoom(): Promise<RoomInfo> {
	const r = await call<{ room: RoomInfo; token: string }>("POST", "", { action: "create" });
	saveToken(r.room.id, r.token);
	return r.room;
}

export async function readRoom(id: string, since: number | null, signal?: AbortSignal): Promise<RoomState> {
	const query = `?id=${id}&client=${clientId}${since === null ? "" : `&since=${since}`}`;
	const r = await call<RoomState | { gone: true }>("GET", query, undefined, signal);
	if ("gone" in r) throw new Gone();
	return r;
}

export const writeRoom = (id: string, text: string) => call<{ ver: number }>("PUT", `?id=${id}`, { text });

export const beat = (id: string) => call("POST", `?id=${id}`, { action: "beat", token: ownerToken(id) });

export async function endRoom(id: string) {
	await call("POST", `?id=${id}`, { action: "end", token: ownerToken(id) }).catch((e) => {
		if (!(e instanceof Gone)) throw e;
	});
	saveToken(id, null);
}

/** The owner is leaving the page: the room ends in a few seconds unless the page comes back (a reload). */
export function leave(id: string) {
	const token = ownerToken(id);
	if (!token) return;
	const body = JSON.stringify({ action: "leave", token });
	// keepalive lets the request outlive the page; sendBeacon is the fallback where it's missing.
	try {
		void fetch(`${API}?id=${id}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			keepalive: true,
		}).catch(() => {});
	} catch {
		navigator.sendBeacon(`${API}?id=${id}`, new Blob([body], { type: "application/json" }));
	}
}

/** http(s) links in the text, in order, without duplicates. */
export function linksIn(text: string): string[] {
	const found = text.match(/\bhttps?:\/\/[^\s<>"'`]+/gi) ?? [];
	// Trailing punctuation usually ends the sentence, not the link.
	return [...new Set(found.map((u) => u.replace(/[),.;:!?\]]+$/, "")))].slice(0, 20);
}

export function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return "just now";
	const m = Math.round(s / 60);
	return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
}
