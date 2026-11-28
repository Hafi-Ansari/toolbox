// Blazing Fast File Transfer: the shared contracts every work package builds on (SPEC §17, WP0).
// Section numbers (§) refer to docs/file-transfer/SPEC.md.
//
// Who implements what:
//   WP1 api/file-transfer.ts, client.ts (ApiClient, Signaling), presence.ts (Presence)
//   WP2 engine/* (TransferEngine; uses DataChannelLike, Ack, FrameHeader, ByteRange)
//   WP3 sinks/*, public/ft-sw.js (ReceiveSink, SwToPage/PageToSw)
//   WP4 rtc/lanes.ts (connect → PeerSession; uses Signaling, LaneCtrl)
//   WP5 UI (consumes Presence, PeerSession, TransferEngine; all mockable from these types)
//
// `api/file-transfer.ts` stays self-contained (§6): it does not import from here and copies the API shapes.
// Keep the two in sync; the server tests in WP1 check the wire shapes against these types.

import { CTRL_MAX_BYTES, MAX_BATCH_ID, MAX_LANES, PROTOCOL_VERSION } from "./tuning.ts";

/* ====================================================================================================
 * Identity (§6.1)
 * ================================================================================================== */

/** 16 lowercase hex, random, public. Kept in `localStorage` (`STORAGE_KEY`). */
export type PeerId = string;
/** 32 lowercase hex, random, private. The server stores only `sha256(secret)` (first 32 hex). */
export type Secret = string;
/** 16 lowercase hex: one request/accept handshake (§6.2 `Claim.pair`). */
export type PairId = string;

export const isPeerId = (v: unknown): v is PeerId => typeof v === "string" && /^[0-9a-f]{16}$/.test(v);
export const isSecret = (v: unknown): v is Secret => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
export const isPairId = (v: unknown): v is PairId => typeof v === "string" && /^[0-9a-f]{16}$/.test(v);

/** What `localStorage[STORAGE_KEY]` holds. */
export interface Identity {
	peer: PeerId;
	secret: Secret;
}

/** What I show others. `name` ≤ 24 chars after NFC, control and bidi stripped; `emoji` is one of rooms' `ANIMALS` emojis. */
export interface Profile {
	name: string;
	emoji: string;
	/** Not listed to others; claims and invite links still work (§6.2, §12). */
	hidden: boolean;
}

/** Another peer, as far as the UI needs it. */
export interface PeerRef {
	id: PeerId;
	name: string;
	emoji: string;
}

/* ====================================================================================================
 * Server state (§6.2). Server-internal; here so tests and docs share one definition.
 * ================================================================================================== */

/** Field `<peerId>` of hash `toolbox:ft:peers`. `net`, `ip`, `auth` never reach clients. */
export interface PeerEntry {
	name: string;
	emoji: string;
	/** ms, last poll. Stale 150 s after. */
	seen: number;
	hidden: boolean;
	/** In a connection (set by the client in its poll). */
	busy: boolean;
	/** 12-hex HMAC of the network (IPv4 address or IPv6 /64). */
	net: string;
	/** 12-hex HMAC of the full IP, for the per-IP cap. */
	ip: string;
	/** sha256(secret), first 32 hex. */
	auth: string;
}

export type ClaimState = "pending" | "accepted" | "connected";

/** Field `claim:<targetId>` of `toolbox:ft:peers`. Created atomically with `HSETNX`. */
export interface Claim {
	/** 16 hex, the handshake id. */
	pair: PairId;
	/** Requester peerId. */
	from: PeerId;
	/** ms; refreshed by the target's polls while `connected`. */
	at: number;
	state: ClaimState;
}

/** Field `gone:<pair>`, kept 30 s so the requester can tell a decline from an expiry. */
export type GoneReason = "declined" | "expired";

/* ====================================================================================================
 * HTTP API (§6.3). Every call is POST /api/file-transfer with a JSON body.
 * ================================================================================================== */

export type ApiAction = "poll" | "request" | "respond" | "connected" | "release" | "signal" | "read" | "leave";

/** Proof of ownership sent with every action. */
export interface ApiAuth {
	peer: PeerId;
	secret: Secret;
}

/** The lane 0 handshake message carried by `signal`/`read` (≤ 16 KiB as JSON). Non-trickle: the SDP is complete. */
export interface SignalMessage {
	type: "offer" | "answer";
	sdp: string;
}

/** Action-specific body fields, besides `action`, `peer` and `secret`. */
export interface ApiBodies {
	poll: Profile & { busy: boolean };
	request: { to: PeerId };
	respond: { pair: PairId; accept: boolean };
	/** Sets the claim state to `connected` (after lane 0 opens). */
	connected: { pair: PairId };
	/** Either side; deletes the claim. Also cancels my own pending request. */
	release: { pair: PairId };
	signal: { pair: PairId; to: PeerId; payload: SignalMessage };
	/** `GETDEL` of my mailbox for this pair. */
	read: { pair: PairId };
	/** Removes my field and my claims. Sent with `keepalive`/`sendBeacon` on `pagehide`. */
	leave: Record<string, never>;
}

export type ApiRequest<A extends ApiAction = ApiAction> = A extends ApiAction
	? { action: A } & ApiAuth & ApiBodies[A]
	: never;

/** One listed peer in `PollResult.peers`. */
export interface PeerInfo extends PeerRef {
	/** Reports busy, or has a live claim. Tiles are greyed: "In a transfer". */
	busy: boolean;
	/** Same network hash as me: "Same network" badge, sorted first. */
	near: boolean;
	/** ms, last poll ("here now" / "seen 1 min ago"). */
	seen: number;
}

/** A claim on me: someone asked to connect. */
export interface IncomingRequest {
	pair: PairId;
	from: PeerRef;
	state: ClaimState;
	/** ms; the 30 s countdown runs from here. */
	at: number;
}

/** My own request, so the requester learns accept/decline from its poll. */
export interface OutgoingRequest {
	pair: PairId;
	to: PeerId;
	state: ClaimState | GoneReason;
}

export interface PollResult {
	you: PeerRef & { hidden: boolean };
	/** Excludes me and hidden peers; `near` first, then `seen` newest first; at most 50. */
	peers: PeerInfo[];
	incoming: IncomingRequest | null;
	outgoing: OutgoingRequest | null;
	/** Poll intervals the server wants for the active/idle/hidden tiers (§6.5). */
	limits: { pollMs: { active: number; idle: number; hidden: number } };
}

export interface ApiOk {
	ok: true;
}

export interface ApiResponses {
	poll: PollResult;
	request: { pair: PairId };
	respond: ApiOk;
	connected: ApiOk;
	release: ApiOk;
	signal: ApiOk;
	read: { payload: SignalMessage | null };
	leave: ApiOk;
}

export type ApiResponse<A extends ApiAction> = ApiResponses[A];

/**
 * Error codes in `{ error: <code> }` responses. Spec-named: busy, gone, self, slow-down, full, too-many-here,
 * disabled, no-salt, no-store. The rest are WP0's choice where §6 gives only a status or no name.
 */
export type ApiErrorCode =
	| "method" // not POST
	| "action" // unknown action
	| "bad-request" // malformed body or field (ids, name, emoji, payload shape)
	| "auth" // secret doesn't match the stored hash (403)
	| "busy" // target is busy or already claimed
	| "gone" // target, claim or pair not found / no longer live
	| "self" // request to myself
	| "slow-down" // per-IP write limit
	| "too-big" // signal payload over 16 KiB
	| "too-many" // more than 8 signal writes for one pair
	| "full" // 100 peer fields
	| "too-many-here" // 6 peers for this IP hash
	| "disabled" // FILE_TRANSFER_DISABLED=1
	| "no-salt" // production without SEND_IP_SALT
	| "no-store" // deployed without a Redis store
	| "server"; // anything unexpected

export interface ApiError {
	error: ApiErrorCode;
}

/** HTTP status for each error code. */
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

/**
 * `client.ts` (WP1). Throws `FtError` with the server's `ApiErrorCode`, or `signal-error` when the
 * network or the server fails without one.
 */
export interface ApiClient {
	call<A extends ApiAction>(action: A, body: ApiBodies[A]): Promise<ApiResponse<A>>;
	/** `leave` with `keepalive`/`sendBeacon`; safe in `pagehide`. */
	leaveBeacon(): void;
}

/* ====================================================================================================
 * Errors shown to people (§11, §8, §10)
 * ================================================================================================== */

/** Connection failures with fixed copy (§11). */
export type ConnectErrorCode =
	| "declined"
	| "expired"
	| "busy"
	| "gone" // invite link: "Calm Otter isn't here right now." (§4.2)
	| "failed-direct"
	| "signal-error"
	| "disabled"
	| "full"
	| "too-many-here";

/** Transfer and session failures (§7.3, §8, §10). */
export type TransferErrorCode =
	| "lost" // lane 0 lost for 20 s, or `bye`: "Connection lost"
	| "protocol" // protocol violation: "Something went wrong with the connection."
	| "flow-control" // sender ignored flow control (§7.3); sent as cancel reason "protocol"
	| "zip-unsupported" // zip stream never started after data was written (§8.2)
	| "too-big" // over memoryMax in the memory fallback (§8.4)
	| "sink-error" // disk full, permission revoked… (cancel reason "error")
	| "read-error"; // WP2: the sender couldn't read a file (moved, deleted or changed while sending); cancel reason "error" by the sender

export type FtErrorCode = ConnectErrorCode | TransferErrorCode | ApiErrorCode;

/** The one error class the tool throws across package boundaries. */
export class FtError extends Error {
	readonly code: FtErrorCode;
	constructor(code: FtErrorCode, message?: string) {
		super(message ?? code);
		this.name = "FtError";
		this.code = code;
	}
}

export const isFtError = (e: unknown): e is FtError => e instanceof FtError;

/* ====================================================================================================
 * Presence (§6.5, client-side; WP1 presence.ts → WP5 UI)
 * ================================================================================================== */

export type PresenceState = "active" | "idle" | "hidden" | "pending" | "handshake" | "connected" | "away" | "off";

/** The handshake both sides move into after an accept (incoming or outgoing). */
export interface Handshake {
	pair: PairId;
	remote: PeerRef;
	/** The requester offers; on a mutual request the lower peerId does (§6.3). */
	offerer: boolean;
}

export interface PresenceSnapshot {
	state: PresenceState;
	/** null until the first poll answers. */
	me: (PeerRef & { hidden: boolean }) | null;
	peers: PeerInfo[];
	incoming: IncomingRequest | null;
	outgoing: OutgoingRequest | null;
	/** Set once an accept is seen (either direction) until `endSession()`. */
	handshake: Handshake | null;
	/** How my last request ended, for §11 copy ("Calm Otter declined."). Cleared by the next request. */
	outcome: { to: PeerId; code: "declined" | "expired" | "busy" | "gone" } | null;
	/** Page-level failure: `disabled`, `full`, `too-many-here`, `signal-error`… null when fine. */
	error: FtErrorCode | null;
}

/** `presence.ts` (WP1). One per page. */
export interface Presence {
	snapshot(): PresenceSnapshot;
	/** Called on every change; returns an unsubscribe. */
	subscribe(listener: (s: PresenceSnapshot) => void): () => void;
	/** Name, emoji or the Visible/Hidden switch. Persisted and sent with the next poll. */
	setProfile(p: Partial<Profile>): void;
	/** Ask a peer to connect. Rejects with `FtError` (`busy`, `gone`, `self`, `slow-down`…). */
	request(to: PeerId): Promise<PairId>;
	/** Cancel my pending request (`release`). */
	cancelRequest(): Promise<void>;
	/** Answer the incoming request. */
	respond(accept: boolean): Promise<void>;
	/** Lane 0 open: claim → `connected`, state → `connected`, polls keep `busy`. */
	markConnected(): Promise<void>;
	/** Session over (or handshake failed): `release` the claim, back to normal polling. */
	endSession(): Promise<void>;
	/** Leave `away` ("Be visible again"). */
	wake(): void;
	/** Stop polling and send `leave`. */
	stop(): void;
}

/* ====================================================================================================
 * Signaling (§7.1: lane 0's offer and answer only; WP1 implements, WP4 consumes)
 * ================================================================================================== */

export interface Signaling {
	readonly pair: PairId;
	readonly self: PeerId;
	readonly remote: PeerId;
	/** True when this side creates the offers (§7.1). */
	readonly offerer: boolean;
	/** `signal` to the other side. Rejects with `FtError("signal-error")` (or a server code) on failure. */
	send(msg: SignalMessage): Promise<void>;
	/**
	 * The next message from the other side: `read` every 700 ms until one arrives. Rejects with
	 * `FtError("failed-direct")` after 30 s (`POLL.handshakeMaxMs`), `FtError("signal-error")` on API errors,
	 * or the abort reason when `signal` aborts.
	 */
	next(signal?: AbortSignal): Promise<SignalMessage>;
}

/* ====================================================================================================
 * Control messages (§7.2): lane 0's `ctrl` channel, JSON text, one object per message, ≤ 64 KiB
 * ================================================================================================== */

/** §7.3 direction bit: 1 when the batch's sender is the session's offerer. */
export type Dir = 0 | 1;

/** One file in a batch. `path` uses "/" ("Trip/Day 1/IMG_0001.CR3"); the receiver sanitizes it (§8.1). */
export interface ManifestFile {
	/** Index in the batch, 0-based and dense: file `i` is `files[i]` of the whole manifest. */
	i: number;
	path: string;
	/** Bytes. */
	size: number;
	/** ms since epoch (`File.lastModified`). */
	mtime: number;
}

export type ReceiveMode = "zip" | "folder" | "memory";
export type DeclineReason = "declined" | "unsupported" | "too-big";
export type CancelBy = "sender" | "receiver";
export type CancelReason = "cancelled" | "error" | "protocol";

export interface HelloCaps {
	/** This side can receive into a folder (§14 feature detection). */
	folder: boolean;
	/** This side can stream a zip download. */
	zip: boolean;
	/** Largest batch the memory fallback takes (`tuning.memoryMax`). */
	memoryMax: number;
	/** Lanes this side will open or accept (≤ 8). */
	lanes: number;
}

export type Ctrl =
	| { t: "hello"; v: 1; name: string; emoji: string; caps: HelloCaps }
	| { t: "lane-offer"; lane: number; sdp: string }
	| { t: "lane-answer"; lane: number; sdp: string }
	| { t: "restart-offer"; lane: number; sdp: string }
	| { t: "restart-answer"; lane: number; sdp: string }
	| { t: "lane-close"; lane: number }
	/** A batch is one "send" of many files. `dir` is implicit: the sender owns the batch id it made. */
	| { t: "manifest"; batch: number; part: number; last: boolean; files: ManifestFile[]; count: number; total: number }
	| { t: "accept"; batch: number; mode: ReceiveMode; skip: number[] }
	| { t: "decline"; batch: number; reason: DeclineReason }
	/** Receiver: file fully persisted. */
	| { t: "file-done"; batch: number; file: number }
	/** Receiver: everything persisted. */
	| { t: "done"; batch: number }
	| { t: "cancel"; batch: number; by: CancelBy; reason: CancelReason }
	| { t: "bye" };

export type CtrlType = Ctrl["t"];
export type CtrlOf<T extends CtrlType> = Extract<Ctrl, { t: T }>;

/** Handled by rtc/lanes.ts (WP4). */
export type LaneCtrl = CtrlOf<
	"hello" | "lane-offer" | "lane-answer" | "restart-offer" | "restart-answer" | "lane-close" | "bye"
>;
/** Handled by the engine (WP2); `PeerSession` passes these through. */
export type TransferCtrl = CtrlOf<"manifest" | "accept" | "decline" | "file-done" | "done" | "cancel">;

const LANE_TYPES: ReadonlySet<string> = new Set([
	"hello",
	"lane-offer",
	"lane-answer",
	"restart-offer",
	"restart-answer",
	"lane-close",
	"bye",
]);
export const isLaneCtrl = (c: Ctrl): c is LaneCtrl => LANE_TYPES.has(c.t);
export const isTransferCtrl = (c: Ctrl): c is TransferCtrl => !LANE_TYPES.has(c.t);

/**
 * Accept modes whose sender must use the ordered (zip stream) scheduler: zip and memory both build a
 * zip in stream order (§7.4, §8.4). Folder is unordered.
 */
export const isOrderedMode = (mode: ReceiveMode): boolean => mode !== "folder";

/* ---------- ctrl validation: the other browser is untrusted (§13) */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isUint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isStr = (v: unknown, max = Number.POSITIVE_INFINITY): v is string => typeof v === "string" && v.length <= max;
const isBatch = (v: unknown): v is number => isUint(v) && v >= 1 && v <= MAX_BATCH_ID;
const isLane = (v: unknown): v is number => isUint(v) && v < MAX_LANES;
const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T => values.includes(v as T);

function isManifestFile(v: unknown): v is ManifestFile {
	return isObj(v) && isUint(v.i) && isStr(v.path) && v.path.length > 0 && isUint(v.size) && isUint(v.mtime);
}

/** Shape check of a decoded ctrl object. Unknown fields are ignored; semantics (batch state etc.) are the caller's. */
export function isCtrl(v: unknown): v is Ctrl {
	if (!isObj(v) || typeof v.t !== "string") return false;
	switch (v.t) {
		case "hello": {
			const c = v.caps;
			return (
				v.v === PROTOCOL_VERSION &&
				isStr(v.name, 64) &&
				isStr(v.emoji, 16) &&
				isObj(c) &&
				typeof c.folder === "boolean" &&
				typeof c.zip === "boolean" &&
				isUint(c.memoryMax) &&
				isUint(c.lanes) &&
				c.lanes >= 1 &&
				c.lanes <= MAX_LANES
			);
		}
		case "lane-offer":
		case "lane-answer":
		case "restart-offer":
		case "restart-answer":
			return isLane(v.lane) && isStr(v.sdp) && v.sdp.length > 0;
		case "lane-close":
			return isLane(v.lane);
		case "manifest":
			return (
				isBatch(v.batch) &&
				isUint(v.part) &&
				typeof v.last === "boolean" &&
				Array.isArray(v.files) &&
				v.files.every(isManifestFile) &&
				isUint(v.count) &&
				isUint(v.total)
			);
		case "accept":
			return (
				isBatch(v.batch) &&
				oneOf(v.mode, ["zip", "folder", "memory"] as const) &&
				Array.isArray(v.skip) &&
				v.skip.every(isUint)
			);
		case "decline":
			return isBatch(v.batch) && oneOf(v.reason, ["declined", "unsupported", "too-big"] as const);
		case "file-done":
			return isBatch(v.batch) && isUint(v.file);
		case "done":
			return isBatch(v.batch);
		case "cancel":
			return (
				isBatch(v.batch) &&
				oneOf(v.by, ["sender", "receiver"] as const) &&
				oneOf(v.reason, ["cancelled", "error", "protocol"] as const)
			);
		case "bye":
			return true;
		default:
			return false;
	}
}

/** Decode one ctrl message. Returns null for oversized, non-JSON or malformed input (→ cancel "protocol"). */
export function parseCtrl(text: string): Ctrl | null {
	if (text.length > CTRL_MAX_BYTES) return null;
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		return null;
	}
	return isCtrl(v) ? v : null;
}

/** Encode one ctrl message. Throws if it would exceed 64 KiB as UTF-8 (split manifests first, §7.2). */
export function encodeCtrl(msg: Ctrl): string {
	const text = JSON.stringify(msg);
	if (text.length > CTRL_MAX_BYTES || new TextEncoder().encode(text).length > CTRL_MAX_BYTES)
		throw new RangeError(`ctrl message over ${CTRL_MAX_BYTES} bytes`);
	return text;
}

/* ====================================================================================================
 * Binary frames and acks on `data` channels (§7.3). The codec itself is engine/frame.ts (WP2).
 * ================================================================================================== */

/**
 * Decoded 16-byte frame header, big-endian:
 *   0 u8 version (1) · 1 u8 flags (bit 0 `FLAG_OFFERER` = dir, bit 1 `FLAG_LAST`) · 2 u16 batch ·
 *   4 u32 file index · 8 u64 byte offset (≤ 2^53). Payload: 1 .. chunk − 16 bytes.
 */
export interface FrameHeader {
	version: 1;
	dir: Dir;
	/** Last frame of its range. */
	last: boolean;
	batch: number;
	file: number;
	offset: number;
}

/** Byte offsets of the header fields. */
export const FRAME_OFFSETS = { version: 0, flags: 1, batch: 2, file: 4, offset: 8 } as const;

/**
 * Receiver → sender on the same lane's `data` channel, as JSON text. Sent every `tuning.ackEvery` bytes
 * persisted and at the end of each range.
 */
export interface Ack {
	/** Batch id. */
	a: number;
	/** Direction bit of the batch. */
	d: Dir;
	/** Bytes from this lane persisted, cumulative. */
	w: number;
	/** Zip (ordered) mode: contiguous stream bytes persisted, batch-wide. */
	c?: number;
}

export function isAck(v: unknown): v is Ack {
	return isObj(v) && isBatch(v.a) && (v.d === 0 || v.d === 1) && isUint(v.w) && (v.c === undefined || isUint(v.c));
}

/** Decode an ack text message; null if malformed. Acks are tiny; anything over 256 chars is rejected. */
export function parseAck(text: string): Ack | null {
	if (text.length > 256) return null;
	try {
		const v: unknown = JSON.parse(text);
		return isAck(v) ? v : null;
	} catch {
		return null;
	}
}

/* ====================================================================================================
 * Data channels and lanes (§7.1; WP4 provides real ones, WP2 tests use fakes)
 * ================================================================================================== */

/**
 * The part of `RTCDataChannel` the engine uses. A real `RTCDataChannel` is assignable to it
 * (checked in types.test.ts). Fakes implement only these members.
 */
export interface DataChannelLike {
	readonly label: string;
	readonly readyState: RTCDataChannelState;
	readonly bufferedAmount: number;
	bufferedAmountLowThreshold: number;
	binaryType: BinaryType;
	/** Ack text. */
	send(data: string): void;
	/** A frame. */
	send(data: ArrayBuffer): void;
	send(data: ArrayBufferView<ArrayBuffer>): void;
	close(): void;
	addEventListener(type: "message", listener: (ev: MessageEvent<string | ArrayBuffer>) => void): void;
	addEventListener(type: "open" | "close" | "error" | "bufferedamountlow", listener: (ev: Event) => void): void;
	removeEventListener(type: "message", listener: (ev: MessageEvent<string | ArrayBuffer>) => void): void;
	removeEventListener(type: "open" | "close" | "error" | "bufferedamountlow", listener: (ev: Event) => void): void;
}

/** An open lane's data channel. Lane 0 also has `ctrl` (inside `PeerSession`). */
export interface Lane {
	/** 0..MAX_LANES-1. */
	readonly index: number;
	readonly data: DataChannelLike;
}

/** UI label: "Direct · same network" when both selected candidates are `host`, else "Direct" (§7.1). */
export type PathType = "direct" | "same-network";

export type SessionEndReason =
	| "bye" // the other side said bye
	| "lost" // lane 0 lost for 20 s, or its channel closed
	| "local" // close() called here
	| "protocol"; // bad ctrl message

export type SessionEvent =
	| { type: "lane-open"; lane: Lane }
	/** Requeue the lane's unacked ranges (§7.5). */
	| { type: "lane-lost"; index: number }
	/** Lane 0 ICE restarting: transfers pause, UI shows "Reconnecting…". */
	| { type: "reconnecting" }
	| { type: "reconnected" }
	| { type: "path"; path: PathType }
	| { type: "ctrl"; msg: TransferCtrl }
	| { type: "closed"; reason: SessionEndReason };

/**
 * `rtc/lanes.ts` (WP4): a connected session, returned once lane 0 is open and `hello` has been exchanged.
 * Extra lanes open in the background and are announced with `lane-open`.
 */
export interface PeerSession {
	readonly offerer: boolean;
	/** Direction bit of batches this side sends (`offerer ? 1 : 0`). */
	readonly dir: Dir;
	/** The other side's hello. */
	readonly remote: CtrlOf<"hello">;
	/** Lanes open now, lane 0 first. */
	lanes(): readonly Lane[];
	/** Send a transfer ctrl message on lane 0. */
	sendCtrl(msg: TransferCtrl): void;
	on(listener: (e: SessionEvent) => void): () => void;
	/** Sends `bye`, closes every lane. Emits `closed` with reason `local`. */
	close(): void;
}

export interface ConnectOptions {
	signaling: Signaling;
	/** My hello fields; `caps.lanes` defaults to `tuning.lanes`. */
	hello: Omit<CtrlOf<"hello">, "t" | "v">;
	signal?: AbortSignal;
}

/** Resolves when lane 0 is open; rejects with `FtError("failed-direct" | "signal-error")`. */
export type Connect = (opts: ConnectOptions) => Promise<PeerSession>;

/* ====================================================================================================
 * Scheduling (§7.4)
 * ================================================================================================== */

/**
 * A unit of work: bytes [start, end) of one file. In ordered mode the scheduler works in global stream
 * offsets internally but still hands out per-file ranges (a 1 MiB zip range may span files → several).
 */
export interface ByteRange {
	file: number;
	start: number;
	end: number;
}

/* ====================================================================================================
 * Receive sinks (§8; WP3 implements)
 * ================================================================================================== */

export type SinkMode = ReceiveMode | "test";

export interface ReceiveSink {
	readonly mode: SinkMode;
	/** Zip and memory: true. Test: true when `__sendTestSinkOrdered`. Folder: false. */
	readonly ordered: boolean;
	/** Called after accept; folder mode returns files it already has (same relative path and size). */
	begin(files: ManifestFile[]): Promise<{ skip: number[] }>;
	/** Unordered sinks: any offset. Ordered sinks: called strictly in stream order by the reorder buffer. */
	write(file: number, offset: number, data: Uint8Array): Promise<void>;
	finishFile(file: number): Promise<void>;
	/** `location` is the zip file name or the folder name, for the done message. */
	finish(): Promise<{ location: string }>;
	abort(reason: string): Promise<void>;
}

/** What a sink factory gets (zip name "Photos from <peer>.zip", §8.2). */
export interface SinkContext {
	peerName: string;
	batch: number;
}

/** `accept.mode` for a sink: the test sink reports as `zip` when ordered, `folder` when not. */
export const acceptMode = (sink: Pick<ReceiveSink, "mode" | "ordered">): ReceiveMode =>
	sink.mode === "test" ? (sink.ordered ? "zip" : "folder") : sink.mode;

/** `window.__sendReceived` entries from the test sink (§8.5). */
export interface ReceivedFile {
	path: string;
	size: number;
	sha256: string;
}

declare global {
	interface Window {
		/** Set by Playwright's `addInitScript` to select the test sink (§8.5). */
		__sendTestSink?: boolean;
		/** Test sink is ordered, to exercise the zip scheduler. */
		__sendTestSinkOrdered?: boolean;
		/** Filled by the test sink as files finish. */
		__sendReceived?: ReceivedFile[];
	}
}

/* ---------- page ↔ service worker (§8.2, `public/ft-sw.js`; plain JS copies these shapes) */

/** Page → service worker on `navigator.serviceWorker.controller`; `port` is transferred. */
export interface SwOpen {
	type: "open";
	id: string;
	/** File name of the download, `Content-Disposition: attachment; filename*=UTF-8''…`. */
	name: string;
	/** Exact `Content-Length`, or null to omit it (if `zipSize` can't be trusted). */
	length: number | null;
	port: MessagePort;
}
/** Page → service worker keepalive, every 10 s. */
export interface SwPing {
	type: "ping";
}
export type PageToSw = SwOpen | SwPing;

/** Service worker → page (on the client or the port). */
export type SwToPage =
	| { type: "started"; id: string } // its fetch handler ran: the download began
	| { want: number } // credit: the page may send at most this many more bytes
	| { type: "cancelled"; id: string }; // the download was cancelled in the browser

/** Page → service worker on the port: a chunk (ownership transferred), or the end of the stream. */
export type PortToSw = ArrayBuffer | { type: "end" } | { type: "abort"; reason: string };

/* ====================================================================================================
 * Transfer engine (§7.4–§7.5, §10; WP2 implements, WP5 renders, WP6 wires)
 * ================================================================================================== */

/** A file picked or dropped for sending (collect.ts). `path` is relative, "/"-separated, folders included. */
export interface SendFile {
	file: File;
	path: string;
}

/** A complete incoming manifest (all parts received), waiting for Accept/Decline. */
export interface IncomingOffer {
	batch: number;
	files: ManifestFile[];
	count: number;
	/** Bytes. */
	total: number;
}

export type BatchSide = "send" | "receive";

export type BatchPhase =
	| "offered" // sender: waiting for accept; receiver: offer card shown
	| "running"
	| "reconnecting" // lane 0 ICE restart
	| "done"
	| "declined"
	| "cancelled"
	| "interrupted" // session ended mid-batch (§10)
	| "failed"; // sink error, protocol, zip-unsupported

/** Progress snapshot, emitted at most every `PROGRESS_MIN_MS` per batch and on every phase change. */
export interface BatchProgress {
	batch: number;
	side: BatchSide;
	phase: BatchPhase;
	/** Set once accepted. */
	mode: ReceiveMode | null;
	files: number;
	bytes: number;
	/** Persisted (acked on the sender, written on the receiver); skipped files count as done. */
	filesDone: number;
	bytesDone: number;
	skipped: number;
	/** Bytes per second from the RateMeter. */
	rate: number;
	/** null while unknown. */
	etaMs: number | null;
	/** Names in flight, at most 3. */
	current: string[];
	/** Lanes carrying this batch now. */
	lanes: number;
	startedAt: number;
	endedAt: number | null;
	/** Done: zip file name or folder name. */
	location: string | null;
	declineReason: DeclineReason | null;
	cancelledBy: CancelBy | null;
	error: FtErrorCode | null;
}

export type EngineEvent = { type: "offer"; offer: IncomingOffer } | { type: "progress"; progress: BatchProgress };

/** One per `PeerSession`. At most one active batch per direction (§7.2). */
export interface TransferEngine {
	/** Sends the manifest and returns the new batch id. Throws if an outgoing batch is still active. */
	send(files: SendFile[]): number;
	/** Accepts an offer into this sink (`accept.mode` from `acceptMode(sink)`, `skip` from `sink.begin`). */
	accept(batch: number, sink: ReceiveSink): Promise<void>;
	decline(batch: number, reason: DeclineReason): void;
	cancel(side: BatchSide, batch: number): void;
	on(listener: (e: EngineEvent) => void): () => void;
	/** Ends every batch as interrupted. Does not close the session. */
	dispose(): void;
}

export type CreateEngine = (session: PeerSession) => TransferEngine;
