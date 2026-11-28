// Talking to api/file-transfer.ts (SPEC §6): the identity a device keeps, the ApiClient every action
// goes through, and the Signaling that carries lane 0's offer and answer (§7.1).
import { POLL, STORAGE_KEY } from "./tuning.ts";
import {
	API_ERROR_STATUS,
	type ApiAction,
	type ApiBodies,
	type ApiClient,
	type ApiErrorCode,
	type ApiResponse,
	FtError,
	type Handshake,
	type Identity,
	isPeerId,
	isSecret,
	type PairId,
	type PeerId,
	type Profile,
	type Signaling,
	type SignalMessage,
} from "./types.ts";

export const API_URL = "/api/file-transfer";

/* ---------- Identity (§6.1) */

export const randomHex = (bytes: number) =>
	Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

export const newIdentity = (): Identity => ({ peer: randomHex(8), secret: randomHex(16) });

/** What `localStorage[STORAGE_KEY]` holds: the identity plus the profile the person chose. */
export interface Stored extends Identity {
	name?: string;
	emoji?: string;
	hidden?: boolean;
}

const defaultStorage = (): Storage | null => {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
};

/**
 * The device's identity and profile, created on first use. An empty name or emoji means "not chosen
 * yet": the server then answers with the peer's default (`ADJECTIVE ANIMAL`), which `saveProfile` keeps.
 */
export function loadIdentity(storage: Storage | null = defaultStorage()): { identity: Identity; profile: Profile } {
	let stored: Partial<Stored> = {};
	try {
		stored = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "{}") ?? {};
	} catch {
		stored = {};
	}
	const known = isPeerId(stored.peer) && isSecret(stored.secret);
	const identity: Identity = known ? { peer: stored.peer as PeerId, secret: stored.secret as string } : newIdentity();
	const profile: Profile = {
		name: typeof stored.name === "string" ? stored.name : "",
		emoji: typeof stored.emoji === "string" ? stored.emoji : "",
		hidden: stored.hidden === true,
	};
	if (!known) write(storage, { ...identity, ...profile });
	return { identity, profile };
}

/** Keeps the profile with the identity, so a reload shows the same name and switch. */
export function saveProfile(identity: Identity, profile: Profile, storage: Storage | null = defaultStorage()) {
	write(storage, { ...identity, ...profile });
}

function write(storage: Storage | null, value: Stored) {
	try {
		storage?.setItem(STORAGE_KEY, JSON.stringify(value));
	} catch {
		// Private mode or full storage: the identity just won't survive a reload.
	}
}

/* ---------- ApiClient */

export interface ApiClientOptions {
	url?: string;
	fetch?: typeof fetch;
}

const isApiErrorCode = (v: unknown): v is ApiErrorCode => typeof v === "string" && Object.hasOwn(API_ERROR_STATUS, v);

/** Every action is a POST with a JSON body, so the secret never shows up in a URL or a log (§6). */
export function createApiClient(identity: Identity, opts: ApiClientOptions = {}): ApiClient {
	const url = opts.url ?? API_URL;
	const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
	const body = (action: ApiAction, fields: object) =>
		JSON.stringify({ ...fields, action, peer: identity.peer, secret: identity.secret });

	return {
		async call<A extends ApiAction>(action: A, fields: ApiBodies[A]): Promise<ApiResponse<A>> {
			let res: Response;
			try {
				res = await doFetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: body(action, fields),
					cache: "no-store",
				});
			} catch {
				throw new FtError("signal-error");
			}
			const json: unknown = await res.json().catch(() => null);
			if (!res.ok || !json || typeof json !== "object") {
				const code = (json as { error?: unknown } | null)?.error;
				throw new FtError(isApiErrorCode(code) ? code : "signal-error");
			}
			return json as ApiResponse<A>;
		},
		leaveBeacon() {
			const data = body("leave", {});
			// keepalive lets the request outlive the page; sendBeacon is the fallback where it's missing.
			try {
				void doFetch(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: data,
					keepalive: true,
				}).catch(() => {});
			} catch {
				try {
					navigator.sendBeacon(url, new Blob([data], { type: "application/json" }));
				} catch {
					// Nothing else to try; the entry goes stale on its own.
				}
			}
		},
	};
}

/* ---------- Signaling (lane 0 only, §7.1) */

export interface SignalingOptions {
	api: ApiClient;
	self: PeerId;
	pair: PairId;
	remote: PeerId;
	offerer: boolean;
	/** `read` interval (default `POLL.handshakeReadMs`, 700 ms). */
	readMs?: number;
	/** `next()` gives up after this (default `POLL.handshakeMaxMs`, 30 s). */
	maxMs?: number;
	now?: () => number;
}

/** Consecutive network failures `next()` rides out before it rejects with `signal-error`. */
const READ_RETRIES = 2;

const abortReason = (signal: AbortSignal) => signal.reason ?? new DOMException("Aborted", "AbortError");

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortReason(signal));
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortReason(signal as AbortSignal));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function createSignaling(opts: SignalingOptions): Signaling {
	const { api, pair, remote } = opts;
	const readMs = opts.readMs ?? POLL.handshakeReadMs;
	const maxMs = opts.maxMs ?? POLL.handshakeMaxMs;
	const now = opts.now ?? Date.now;
	const asFtError = (e: unknown) => (e instanceof FtError ? e : new FtError("signal-error"));

	return {
		pair,
		self: opts.self,
		remote,
		offerer: opts.offerer,
		async send(msg: SignalMessage) {
			try {
				await api.call("signal", { pair, to: remote, payload: { type: msg.type, sdp: msg.sdp } });
			} catch (e) {
				throw asFtError(e);
			}
		},
		async next(signal?: AbortSignal) {
			const deadline = now() + maxMs;
			let failures = 0;
			for (;;) {
				if (signal?.aborted) throw abortReason(signal);
				try {
					const { payload } = await api.call("read", { pair });
					failures = 0;
					if (payload) return payload;
				} catch (e) {
					const err = asFtError(e);
					// A dropped request or two is normal on mobile; a server answer is final.
					if (err.code !== "signal-error" || ++failures > READ_RETRIES) throw err;
				}
				if (signal?.aborted) throw abortReason(signal);
				if (now() >= deadline) throw new FtError("failed-direct");
				await sleep(Math.min(readMs, Math.max(0, deadline - now())), signal);
			}
		},
	};
}

/** The Signaling for a handshake that `Presence` reported. */
export const signalingFor = (
	api: ApiClient,
	self: PeerId,
	handshake: Handshake,
	extra: Partial<SignalingOptions> = {},
) =>
	createSignaling({
		...extra,
		api,
		self,
		pair: handshake.pair,
		remote: handshake.remote.id,
		offerer: handshake.offerer,
	});
