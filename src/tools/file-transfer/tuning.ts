// Blazing Fast File Transfer: every number the spec fixes (docs/file-transfer/SPEC.md).
//
// `tuning` holds the transfer knobs of §7.5. It is a plain mutable object on purpose, so the benchmark
// (§16.3) can change values between runs; call `checkTuning()` after changing it. Everything else is a
// fixed protocol, server or UI constant.
//
// `api/file-transfer.ts` is self-contained (§6) and must not import this file: it copies the server
// constants it needs, and `SERVER` here documents the same numbers for the client and the tests.

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

/* ---------- §7.5 transfer tuning (mutable, for the benchmark) */

export interface Tuning {
	/** Lanes (peer connections) per session. Default 6 (§18.3), at most `MAX_LANES`. */
	lanes: number;
	/** Bytes per data-channel message, header included. Capped by the remote `sctp.maxMessageSize` (§7.3). */
	chunk: number;
	/** Wait while `bufferedAmount` is above this. Never above `HIGH_WATER_MAX` (§3). */
	highWater: number;
	/** `bufferedAmountLowThreshold`: resume sending below this. */
	lowWater: number;
	/** Unacked bytes allowed per lane (sent minus persisted). */
	laneWindow: number;
	/** The receiver acks every this many bytes persisted per lane, and at the end of each range. */
	ackEvery: number;
	/** Read-ahead per lane with `File.slice().arrayBuffer()`. */
	readBlock: number;
	/** Unordered sinks: files up to this size are one range; bigger files are cut into ranges of this size. */
	rangeMax: number;
	/** Unordered sinks: at most this many lanes hold ranges of one file at once (§7.4). */
	maxWritersPerFile: number;
	/** Ordered sink (zip): the batch stream is cut into ranges of this size. */
	zipRange: number;
	/** Ordered sink: no range may end beyond `ackedContiguous + reorderWindow`; also the receiver's reorder buffer cap. */
	reorderWindow: number;
	/** Folder sink: join contiguous chunks up to this size before `write()`. */
	coalesce: number;
	/** Folder sink: open writables at once. */
	maxOpenFiles: number;
	/** Memory fallback (§8.4): largest batch it accepts; bigger ones are declined with `too-big`. */
	memoryMax: number;
}

export const tuning: Tuning = {
	lanes: 6,
	chunk: 256 * KiB,
	highWater: 8 * MiB,
	lowWater: 2 * MiB,
	laneWindow: 16 * MiB,
	ackEvery: 1 * MiB,
	readBlock: 4 * MiB,
	rangeMax: 32 * MiB,
	maxWritersPerFile: 2,
	zipRange: 1 * MiB,
	reorderWindow: 64 * MiB,
	coalesce: 4 * MiB,
	maxOpenFiles: 16,
	memoryMax: 1 * GiB,
};

/** The spec's defaults, so a benchmark run can restore them. */
export const DEFAULT_TUNING: Readonly<Tuning> = Object.freeze({ ...tuning });

/** §7.1: lanes never exceed this. */
export const MAX_LANES = 8;
/** §3: Chrome throws "send queue is full" above 16 MiB buffered, so `highWater` stays at or below 12 MiB. */
export const HIGH_WATER_MAX = 12 * MiB;
/** §3: Chrome's `sctp.maxMessageSize`. */
export const SCTP_MAX_MESSAGE = 262144;

/** Throws when a benchmark sets a value the spec forbids (§3, §7.5). */
export function checkTuning(t: Tuning = tuning): void {
	const bad = (why: string) => {
		throw new RangeError(`tuning: ${why}`);
	};
	for (const [k, v] of Object.entries(t))
		if (!Number.isSafeInteger(v) || v <= 0) bad(`${k} must be a positive integer`);
	if (t.lanes > MAX_LANES) bad(`lanes > ${MAX_LANES}`);
	if (t.highWater > HIGH_WATER_MAX) bad("highWater > 12 MiB");
	if (t.lowWater >= t.highWater) bad("lowWater must be below highWater");
	if (t.chunk <= FRAME_HEADER_BYTES || t.chunk > SCTP_MAX_MESSAGE) bad("chunk out of range");
	if (t.zipRange > t.reorderWindow) bad("zipRange > reorderWindow");
}

/** §7.3: `chunk = min(tuning.chunk, sctp.maxMessageSize)`; pass the remote `RTCSctpTransport.maxMessageSize` when known. */
export function chunkSize(maxMessageSize: number = SCTP_MAX_MESSAGE, t: Tuning = tuning): number {
	const max = maxMessageSize > 0 && Number.isFinite(maxMessageSize) ? maxMessageSize : SCTP_MAX_MESSAGE;
	return Math.min(t.chunk, max);
}

/**
 * §7.3: receiver bound on bytes queued but not yet persisted, `lanes × (laneWindow + chunk)`.
 * Exceeding it cancels the batch ("sender ignored flow control").
 */
export function maxUnpersisted(lanes: number, t: Tuning = tuning): number {
	return lanes * (t.laneWindow + t.chunk);
}

/* ---------- §7.2–§7.3 wire protocol */

/** `hello.v` and the frame header's version byte. */
export const PROTOCOL_VERSION = 1;
/** Binary frame header length (§7.3). */
export const FRAME_HEADER_BYTES = 16;
/** Frame flag bit 0: the sender of this frame is the session's offerer (the batch's direction bit). */
export const FLAG_OFFERER = 0b01;
/** Frame flag bit 1: last frame of its range. */
export const FLAG_LAST = 0b10;
/** Largest batch id a frame can carry (u16). Batch ids count from 1 per side. */
export const MAX_BATCH_ID = 0xffff;
/** Largest file offset a frame may carry (`getBigUint64` → `Number`, §7.3). */
export const MAX_OFFSET = Number.MAX_SAFE_INTEGER;
/** One ctrl message, JSON (§7.2). */
export const CTRL_MAX_BYTES = 64 * KiB;
/** A manifest bigger than `CTRL_MAX_BYTES` is split into parts of about this many files (§7.2). */
export const MANIFEST_PART_FILES = 500;
/** Negotiated data-channel ids (§7.1). `ctrl` exists on lane 0 only. */
export const CTRL_CHANNEL_ID = 0;
export const DATA_CHANNEL_ID = 1;

/* ---------- §7.1, §10 connections */

/** §7.1: STUN only, no TURN (§18.4). */
export const ICE_SERVERS: RTCIceServer[] = [
	{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];
/** Non-trickle ICE: wait for gathering to complete, or this long, before sending the SDP. */
export const ICE_GATHER_TIMEOUT_MS = 3000;
/** Lane 0 not open after this → `failed-direct`. An extra lane not open after this is dropped quietly. */
export const LANE_OPEN_TIMEOUT_MS = 15_000;
/** ICE `disconnected` this long → ICE restart over ctrl. */
export const ICE_RESTART_AFTER_MS = 3000;
/** ICE `failed` this long → close the lane (requeue its work); for lane 0 the session ends (§10). */
export const LANE_LOST_AFTER_MS = 20_000;

/* ---------- §6.5 presence polling (client) */

export const POLL = {
	/** Visible, interacted within `IDLE_AFTER_MS`. The server also sends active/idle/hidden in `PollResult.limits`. */
	activeMs: 3000,
	/** Visible, no interaction for `IDLE_AFTER_MS`. */
	idleMs: 10_000,
	/** `document.hidden`, and the `off` (Hidden switch) state. */
	hiddenMs: 60_000,
	/** An outgoing request is pending or an incoming one is shown. */
	pendingMs: 1000,
	/** At most this long in `pending`. */
	pendingMaxMs: 60_000,
	/** `handshake`: `poll` every 3 s… */
	handshakePollMs: 3000,
	/** …plus `read` every 700 ms… */
	handshakeReadMs: 700,
	/** …for at most 30 s. */
	handshakeMaxMs: 30_000,
	/** `connected`: keeps `busy` and refreshes the claim. */
	connectedMs: 10_000,
	/** `connected` while the tab is hidden. */
	connectedHiddenMs: 60_000,
} as const;

/** No interaction for this long → `idle`. */
export const IDLE_AFTER_MS = 2 * 60_000;
/** No interaction for this long → `away`: send `leave`, stop polling. */
export const AWAY_AFTER_MS = 2 * 60 * 60_000;
/** A request is answered within this, or it expires (§6.2); also the incoming panel's countdown (§12). */
export const REQUEST_TIMEOUT_MS = 30_000;

/* ---------- §6 server (copied, not imported, by api/file-transfer.ts) */

export const SERVER = {
	/** Every Redis key starts with this. */
	keyPrefix: "toolbox:ft:",
	/** `EXPIRE` on the peers hash at every write, seconds. */
	peersTtlS: 180,
	/** Handshake mailbox `toolbox:ft:sig:<pair>:<to>`, seconds. */
	signalTtlS: 60,
	/** Rate counter `toolbox:ft:rl:<ipHash>:<minute>`, seconds. */
	rateTtlS: 90,
	/** A peer field is stale this long after `seen`. */
	peerStaleMs: 150_000,
	/** `pending` and `accepted` claims expire this long after `at`. */
	claimMs: 30_000,
	/** A `connected` claim expires this long after the target's last poll. */
	connectedClaimMs: 90_000,
	/** `gone:<pair>` → "declined" | "expired" marker lifetime. */
	goneMs: 30_000,
	/** `PollResult.peers` length cap. */
	listMax: 50,
	/** Peer fields in total; a new peer beyond this gets 503 `full`. */
	peersMax: 100,
	/** Peers per IP hash; beyond this 429 `too-many-here`. */
	peersPerIp: 6,
	/** `request`, `respond` and `signal` per IP per minute. */
	writesPerMinute: 60,
	/** `signal` payload, JSON bytes. */
	signalMaxBytes: 16 * KiB,
	/** `signal` writes per pair. */
	signalsPerPair: 8,
	/** Display name, characters after NFC normalization. */
	nameMax: 24,
	/** Hex lengths of ids and hashes (§6.1, §6.2). */
	peerIdHex: 16,
	secretHex: 32,
	pairHex: 16,
	authHex: 32,
	ipHashHex: 12,
} as const;

/* ---------- §8 sinks */

export const ZIP_STREAM = {
	/** Service worker script, plain JS in `public/`. */
	swUrl: "/ft-sw.js",
	/** Service worker scope; downloads are `/file-transfer/dl/<id>/<name>.zip`. */
	scope: "/file-transfer/dl/",
	/** No `{ type: "started" }` from the service worker within this → treat zip streaming as unsupported. */
	startedTimeoutMs: 5000,
	/** Page pings the service worker this often (Firefox stops idle workers). */
	pingMs: 10_000,
} as const;

/** `Photos from Calm Otter.zip` (§4.4, §8.2). The name is still sanitized like any path segment. */
export const zipName = (peerName: string) => `Photos from ${peerName}.zip`;

/** §8.1 path limits, applied on the receiver. */
export const PATH_SEGMENT_MAX = 120;
export const PATH_MAX = 400;

/* ---------- §4, §6.1, §12 client and UI */

/** `localStorage` key holding `{ peer, secret }` (and the profile), so invite links survive reloads. */
export const STORAGE_KEY = "toolbox.send.peer";
/** Invite link query parameter: `/file-transfer?to=<peerId>`. */
export const INVITE_PARAM = "to";
/** Page path. */
export const TOOL_PATH = "/file-transfer";
/** React progress state updates at most 4 times a second (§7.5). */
export const PROGRESS_MIN_MS = 250;
/** `aria-live` progress announcements at most this often (§12). */
export const ARIA_LIVE_MIN_MS = 5000;
/** "Copied" shows this long after *Copy invite link*. */
export const COPIED_MS = 2000;
/** Current file names shown in the progress view. */
export const CURRENT_FILES_SHOWN = 3;
