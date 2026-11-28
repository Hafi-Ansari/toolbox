// Dev and test only: stand-ins for presence (WP1), signaling (WP1), lanes (WP4), the engine (WP2), the
// sinks and collect.ts (WP3), built only from the contracts in types.ts. Loaded by deps.ts when the real
// modules aren't wired yet, or with `?mock` / `window.__ftUseMock`. Nothing here talks to a server or
// opens a connection: transfers are simulated from the declared file sizes.
//
// Tests and screenshots steer it through `window.__ftMock` (see `MockControl`). `?mock=empty` starts with
// nobody else on the page.
import { detectCaps, type FtDeps } from "./deps.ts";
import { randomProfile } from "./profile.ts";
import { PROGRESS_MIN_MS, REQUEST_TIMEOUT_MS, tuning, zipName } from "./tuning.ts";
import {
	type BatchProgress,
	type BatchSide,
	type ConnectOptions,
	type CtrlOf,
	type DataChannelLike,
	type DeclineReason,
	type Dir,
	type EngineEvent,
	FtError,
	type FtErrorCode,
	type Handshake,
	type IncomingOffer,
	type Lane,
	type ManifestFile,
	type PathType,
	type PeerId,
	type PeerInfo,
	type PeerRef,
	type PeerSession,
	type Presence,
	type PresenceSnapshot,
	type Profile,
	type ReceiveMode,
	type ReceiveSink,
	type SendFile,
	type SessionEvent,
	type Signaling,
	type SinkContext,
	type TransferEngine,
} from "./types.ts";

export interface MockOptions {
	/** Delay before the first poll "answers". */
	firstPollMs: number;
	/** Delay before a peer answers my request. */
	answerMs: number;
	/** Delay from accept to lane 0 open. */
	connectMs: number;
	connectResult: "ok" | "failed-direct" | "signal-error";
	path: PathType;
	lanes: number;
	/** Simulated bytes per second. */
	rate: number;
	/** Time stands still while true: no progress events at all (for screenshots). */
	frozen: boolean;
	/** New batches start this fraction of the way through (for screenshots). */
	head: number;
	/** Delay before the other side answers my offer. */
	remoteAcceptMs: number;
	remoteAnswer: "accept" | DeclineReason;
	remoteMode: ReceiveMode;
	/** Folder mode: files the folder "already has". */
	folderSkips: number;
	/** Override the detected caps (folder mode is detected as false in some headless runs). */
	caps: Partial<ReturnType<typeof detectCaps>>;
}

type Answer = "accept" | "decline" | "ignore" | "busy" | "gone";
export type MockPeer = PeerInfo & { answer?: Answer };

const hex = (n: number) =>
	Array.from(crypto.getRandomValues(new Uint8Array(n / 2)), (b) => b.toString(16).padStart(2, "0")).join("");
const PROFILE_KEY = "toolbox.send.mock";

const demoPeers = (): MockPeer[] => {
	const now = Date.now();
	return [
		{ id: "a1b2c3d4e5f60718", name: "Calm Otter", emoji: "🦦", busy: false, near: true, seen: now },
		{ id: "b2c3d4e5f6071829", name: "Witty Owl", emoji: "🦉", busy: false, near: true, seen: now - 70_000 },
		{ id: "c3d4e5f60718293a", name: "Sunny Panda", emoji: "🐼", busy: true, near: false, seen: now },
		{
			id: "d4e5f60718293a4b",
			name: "Rapid Koala",
			emoji: "🐨",
			busy: false,
			near: false,
			seen: now - 4000,
			answer: "decline",
		},
	];
};

/** Made-up photo names for simulated batches. */
function fakeManifest(count: number, total: number): ManifestFile[] {
	const each = count > 0 ? Math.floor(total / count) : 0;
	return Array.from({ length: count }, (_, i) => ({
		i,
		path: `Trip/Day ${1 + Math.floor(i / 60)}/${i % 9 === 8 ? `VID_${2000 + i}.MP4` : `IMG_${String(1000 + i)}.CR3`}`,
		size: i === count - 1 ? total - each * (count - 1) : each,
		mtime: Date.now() - (count - i) * 60_000,
	}));
}

class Emitter<T> {
	private listeners = new Set<(v: T) => void>();
	on(l: (v: T) => void) {
		this.listeners.add(l);
		return () => void this.listeners.delete(l);
	}
	emit(v: T) {
		for (const l of [...this.listeners]) l(v);
	}
}

/* ---------- Presence (WP1 stand-in) */

class MockPresence implements Presence {
	private s: PresenceSnapshot = {
		state: "active",
		me: null,
		peers: [],
		incoming: null,
		outgoing: null,
		handshake: null,
		outcome: null,
		error: null,
	};
	private changes = new Emitter<PresenceSnapshot>();
	private timers = new Set<number>();
	private requestTimer = 0;
	private incomingTimer = 0;
	peers: MockPeer[];

	private world: MockWorld;

	constructor(world: MockWorld) {
		this.world = world;
		this.peers = new URLSearchParams(location.search).get("mock") === "empty" ? [] : demoPeers();
		this.later(() => {
			let saved: Partial<Profile> = {};
			try {
				saved = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? "{}");
			} catch {}
			const fresh = randomProfile();
			const me = {
				id: (saved as { id?: string }).id ?? hex(16),
				name: saved.name ?? fresh.name,
				emoji: saved.emoji ?? fresh.emoji,
				hidden: saved.hidden ?? false,
			};
			this.save(me);
			this.set({ me, peers: this.listed(), state: me.hidden ? "off" : "active" });
		}, world.options.firstPollMs);
	}

	private later(fn: () => void, ms: number) {
		const t = window.setTimeout(() => {
			this.timers.delete(t);
			fn();
		}, ms);
		this.timers.add(t);
		return t;
	}

	private save(me: PeerRef & { hidden: boolean }) {
		try {
			localStorage.setItem(PROFILE_KEY, JSON.stringify(me));
		} catch {}
	}

	private listed() {
		return this.peers.map(({ answer: _, ...p }) => p);
	}

	set(patch: Partial<PresenceSnapshot>) {
		this.s = { ...this.s, ...patch };
		this.changes.emit(this.s);
	}

	setPeers(peers: MockPeer[]) {
		this.peers = peers;
		if (this.s.me) this.set({ peers: this.listed() });
	}

	snapshot() {
		return this.s;
	}
	subscribe(l: (s: PresenceSnapshot) => void) {
		return this.changes.on(l);
	}

	setProfile(p: Partial<Profile>) {
		if (!this.s.me) return;
		const me = { ...this.s.me, ...p };
		this.save(me);
		const idle = this.s.state === "active" || this.s.state === "off";
		this.set({ me, state: idle ? (me.hidden ? "off" : "active") : this.s.state });
	}

	async request(to: PeerId): Promise<string> {
		this.set({ outcome: null });
		const peer = this.peers.find((p) => p.id === to);
		if (!peer || peer.answer === "gone") throw new FtError("gone");
		if (peer.busy || peer.answer === "busy") throw new FtError("busy");
		const pair = hex(16);
		this.set({ outgoing: { pair, to, state: "pending" }, state: "pending" });
		const answer = peer.answer ?? "accept";
		const ms = answer === "ignore" ? REQUEST_TIMEOUT_MS : this.world.options.answerMs;
		this.requestTimer = this.later(() => {
			if (this.s.outgoing?.pair !== pair) return;
			if (answer === "accept")
				this.set({
					outgoing: { pair, to, state: "accepted" },
					handshake: { pair, remote: { id: peer.id, name: peer.name, emoji: peer.emoji }, offerer: true },
					state: "handshake",
				});
			else
				this.set({
					outgoing: null,
					outcome: { to, code: answer === "ignore" ? "expired" : "declined" },
					state: this.idleState(),
				});
		}, ms);
		return pair;
	}

	async cancelRequest() {
		clearTimeout(this.requestTimer);
		this.set({ outgoing: null, state: this.idleState() });
	}

	/** Someone asks me to connect. */
	incoming(from: PeerRef) {
		const pair = hex(16);
		this.set({ incoming: { pair, from, state: "pending", at: Date.now() }, state: "pending" });
		clearTimeout(this.incomingTimer);
		this.incomingTimer = this.later(() => {
			if (this.s.incoming?.pair === pair) this.set({ incoming: null, state: this.idleState() });
		}, REQUEST_TIMEOUT_MS);
	}

	async respond(accept: boolean) {
		const inc = this.s.incoming;
		if (!inc) return;
		clearTimeout(this.incomingTimer);
		if (accept)
			this.set({ incoming: null, handshake: { pair: inc.pair, remote: inc.from, offerer: false }, state: "handshake" });
		else this.set({ incoming: null, state: this.idleState() });
	}

	async markConnected() {
		this.set({ state: "connected" });
	}

	async endSession() {
		this.set({ handshake: null, outgoing: null, state: this.idleState() });
	}

	private idleState() {
		return this.s.me?.hidden ? "off" : "active";
	}

	wake() {
		this.set({ state: this.idleState() });
	}

	stop() {
		for (const t of this.timers) clearTimeout(t);
		this.timers.clear();
	}
}

/* ---------- Signaling and lanes (WP1 / WP4 stand-ins) */

class MockSignaling implements Signaling {
	readonly pair: string;
	readonly remote: PeerId;
	readonly offerer: boolean;
	readonly handshake: Handshake;
	readonly self: PeerId;

	constructor(handshake: Handshake, self: PeerId) {
		this.handshake = handshake;
		this.self = self;
		this.pair = handshake.pair;
		this.remote = handshake.remote.id;
		this.offerer = handshake.offerer;
	}
	async send() {}
	next(signal?: AbortSignal) {
		return new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
	}
}

/** A data channel that goes nowhere; the mock engine never sends on it. */
const deadChannel = (label: string): DataChannelLike =>
	({
		label,
		readyState: "open",
		bufferedAmount: 0,
		bufferedAmountLowThreshold: 0,
		binaryType: "arraybuffer",
		send() {},
		close() {},
		addEventListener() {},
		removeEventListener() {},
	}) as DataChannelLike;

class MockSession implements PeerSession {
	readonly dir: Dir;
	readonly remote: CtrlOf<"hello">;
	private open: Lane[] = [];
	readonly events = new Emitter<SessionEvent>();
	private timers: number[] = [];
	closed = false;

	readonly offerer: boolean;

	constructor(offerer: boolean, remote: PeerRef, world: MockWorld) {
		this.offerer = offerer;
		this.dir = offerer ? 1 : 0;
		this.remote = {
			t: "hello" as const,
			v: 1 as const,
			name: remote.name,
			emoji: remote.emoji,
			caps: { folder: true, zip: true, memoryMax: tuning.memoryMax, lanes: world.options.lanes },
		};
		this.open.push({ index: 0, data: deadChannel("data-0") });
		this.timers.push(window.setTimeout(() => this.emit({ type: "path", path: world.options.path }), 300));
		for (let i = 1; i < world.options.lanes; i++)
			this.timers.push(
				window.setTimeout(
					() => {
						const lane = { index: i, data: deadChannel(`data-${i}`) };
						this.open.push(lane);
						this.emit({ type: "lane-open", lane });
					},
					200 + i * 120,
				),
			);
	}

	emit(e: SessionEvent) {
		if (!this.closed) this.events.emit(e);
		if (e.type === "closed") {
			this.closed = true;
			for (const t of this.timers) clearTimeout(t);
		}
	}

	lanes() {
		return this.open;
	}
	sendCtrl() {}
	on(l: (e: SessionEvent) => void) {
		return this.events.on(l);
	}
	close() {
		this.emit({ type: "closed", reason: "local" });
	}
	loseLane() {
		const lane = this.open.pop();
		if (lane && lane.index > 0) this.emit({ type: "lane-lost", index: lane.index });
	}
}

/* ---------- Engine (WP2 stand-in) */

interface SimBatch {
	p: BatchProgress;
	files: ManifestFile[];
	sink: ReceiveSink | null;
	skip: Set<number>;
	timer: number;
}

class MockEngine implements TransferEngine {
	private batches = new Map<string, SimBatch>();
	private events = new Emitter<EngineEvent>();
	private nextSend = 1;
	private nextReceive = 1;
	private paused = false;
	private off: () => void;

	readonly session: MockSession;
	private world: MockWorld;

	constructor(session: MockSession, world: MockWorld) {
		this.session = session;
		this.world = world;
		this.off = session.on((e) => {
			if (e.type === "reconnecting" || e.type === "reconnected") {
				this.paused = e.type === "reconnecting";
				for (const b of this.batches.values())
					if (b.p.phase === "running" || b.p.phase === "reconnecting")
						this.update(b, { phase: this.paused ? "reconnecting" : "running" });
			}
		});
	}

	private key = (side: BatchSide, batch: number) => `${side}:${batch}`;

	private update(b: SimBatch, patch: Partial<BatchProgress>) {
		b.p = { ...b.p, ...patch };
		this.events.emit({ type: "progress", progress: b.p });
	}

	private create(side: BatchSide, batch: number, files: ManifestFile[]): SimBatch {
		const b: SimBatch = {
			files,
			sink: null,
			skip: new Set(),
			timer: 0,
			p: {
				batch,
				side,
				phase: "offered",
				mode: null,
				files: files.length,
				bytes: files.reduce((n, f) => n + f.size, 0),
				filesDone: 0,
				bytesDone: 0,
				skipped: 0,
				rate: 0,
				etaMs: null,
				current: [],
				lanes: 0,
				startedAt: Date.now(),
				endedAt: null,
				location: null,
				declineReason: null,
				cancelledBy: null,
				error: null,
			},
		};
		this.batches.set(this.key(side, batch), b);
		return b;
	}

	private active(side: BatchSide) {
		for (const b of this.batches.values())
			if (b.p.side === side && ["offered", "running", "reconnecting"].includes(b.p.phase)) return b;
		return null;
	}

	/** Moves bytes along at `options.rate` until the batch is complete. */
	private run(b: SimBatch, mode: ReceiveMode) {
		const skippedBytes = b.files.filter((f) => b.skip.has(f.i)).reduce((n, f) => n + f.size, 0);
		this.update(b, {
			phase: this.paused ? "reconnecting" : "running",
			mode,
			skipped: b.skip.size,
			filesDone: b.skip.size,
			bytesDone: Math.max(skippedBytes, Math.floor(b.p.bytes * this.world.options.head)),
			startedAt: Date.now() - (b.p.bytes * this.world.options.head * 1000) / this.world.options.rate,
		});
		let last = performance.now();
		const tick = async () => {
			const now = performance.now();
			const dt = (now - last) / 1000;
			last = now;
			const o = this.world.options;
			if (o.frozen) {
				b.timer = window.setTimeout(tick, PROGRESS_MIN_MS);
				return;
			}
			const moving = !this.paused;
			const bytesDone = Math.min(b.p.bytes, b.p.bytesDone + (moving ? o.rate * dt : 0));
			let sum = 0;
			let filesDone = 0;
			const current: string[] = [];
			for (const f of b.files) {
				sum += f.size;
				if (sum <= bytesDone || b.skip.has(f.i)) filesDone++;
				else if (current.length < 3) current.push(f.path.split("/").pop() ?? f.path);
			}
			const left = b.p.bytes - bytesDone;
			const rate = moving ? o.rate : 0;
			if (left <= 0) {
				let location: string | null = null;
				if (b.sink) {
					for (const f of b.files) if (!b.skip.has(f.i)) await b.sink.finishFile(f.i);
					location = (await b.sink.finish()).location;
				}
				if (b.p.phase !== "running" && b.p.phase !== "reconnecting") return;
				this.update(b, {
					phase: "done",
					bytesDone: b.p.bytes,
					filesDone: b.p.files,
					current: [],
					etaMs: 0,
					rate: o.rate,
					endedAt: Date.now(),
					location,
				});
				return;
			}
			this.update(b, {
				bytesDone,
				filesDone,
				current,
				rate,
				etaMs: rate > 0 ? (left / rate) * 1000 : null,
				lanes: this.session.lanes().length,
				phase: this.paused ? "reconnecting" : "running",
			});
			b.timer = window.setTimeout(tick, PROGRESS_MIN_MS);
		};
		b.timer = window.setTimeout(tick, PROGRESS_MIN_MS);
	}

	private end(b: SimBatch, patch: Partial<BatchProgress>) {
		clearTimeout(b.timer);
		if (!["offered", "running", "reconnecting"].includes(b.p.phase)) return;
		void b.sink?.abort(patch.phase ?? "ended");
		this.update(b, { endedAt: Date.now(), current: [], rate: 0, etaMs: null, ...patch });
	}

	send(files: SendFile[]): number {
		if (this.active("send")) throw new Error("an outgoing batch is still active");
		return this.sendManifest(files.map((f, i) => ({ i, path: f.path, size: f.file.size, mtime: f.file.lastModified })));
	}

	/** Also used by `MockControl.simulateSend` for big made-up batches. */
	sendManifest(files: ManifestFile[]): number {
		const b = this.create("send", this.nextSend++, files);
		this.events.emit({ type: "progress", progress: b.p });
		const o = this.world.options;
		window.setTimeout(() => {
			if (b.p.phase !== "offered") return;
			if (o.remoteAnswer === "accept") {
				if (o.remoteMode === "folder") for (let i = 0; i < Math.min(o.folderSkips, files.length); i++) b.skip.add(i);
				this.run(b, o.remoteMode);
			} else this.end(b, { phase: "declined", declineReason: o.remoteAnswer });
		}, o.remoteAcceptMs);
		return b.p.batch;
	}

	/** The other side offers files. */
	offer(files: ManifestFile[]): IncomingOffer {
		const b = this.create("receive", this.nextReceive++, files);
		const offer = { batch: b.p.batch, files, count: files.length, total: b.p.bytes };
		this.events.emit({ type: "offer", offer });
		this.events.emit({ type: "progress", progress: b.p });
		return offer;
	}

	async accept(batch: number, sink: ReceiveSink) {
		const b = this.batches.get(this.key("receive", batch));
		if (b?.p.phase !== "offered") return;
		b.sink = sink;
		const { skip } = await sink.begin(b.files);
		b.skip = new Set(skip);
		this.run(b, sink.mode === "test" ? (sink.ordered ? "zip" : "folder") : sink.mode);
	}

	decline(batch: number, reason: DeclineReason) {
		const b = this.batches.get(this.key("receive", batch));
		if (b) this.end(b, { phase: "declined", declineReason: reason });
	}

	cancel(side: BatchSide, batch: number) {
		const b = this.batches.get(this.key(side, batch));
		if (b) this.end(b, { phase: "cancelled", cancelledBy: side === "send" ? "sender" : "receiver" });
	}

	/** The other side cancels, or something fails. */
	remoteEnd(side: BatchSide, patch: Partial<BatchProgress>) {
		const b = this.active(side);
		if (b) this.end(b, patch);
	}

	on(l: (e: EngineEvent) => void) {
		return this.events.on(l);
	}

	dispose() {
		this.off();
		for (const b of this.batches.values()) this.end(b, { phase: "interrupted", error: "lost" });
	}
}

/* ---------- Sinks and collect (WP3 stand-ins) */

function mockSink(mode: ReceiveMode, location: string, skips = 0): ReceiveSink {
	return {
		mode,
		ordered: mode !== "folder",
		async begin(files) {
			return { skip: files.slice(0, Math.min(skips, files.length)).map((f) => f.i) };
		},
		async write() {},
		async finishFile() {},
		async finish() {
			return { location };
		},
		async abort() {},
	};
}

/* ---------- The world, and the controller tests use */

class MockWorld {
	options: MockOptions = {
		firstPollMs: 250,
		answerMs: 1500,
		connectMs: 1200,
		connectResult: "ok",
		path: "same-network",
		lanes: tuning.lanes,
		rate: 71.2 * 1024 * 1024,
		frozen: false,
		head: 0,
		remoteAcceptMs: 1500,
		remoteAnswer: "accept",
		remoteMode: "zip",
		folderSkips: 3,
		caps: {},
	};
	presence: MockPresence | null = null;
	session: MockSession | null = null;
	engine: MockEngine | null = null;
}

export interface MockControl {
	options: MockOptions;
	setPeers(peers: MockPeer[]): void;
	/** A page-level error (`disabled`, `full`, `too-many-here`, `signal-error`), or null. */
	setError(code: FtErrorCode | null): void;
	/** The presence state machine went `away` (2 h without interaction). */
	away(): void;
	/** Someone asks to connect; defaults to the first listed peer. */
	incoming(from?: PeerRef): void;
	/** The connected peer offers files (made-up names when only count and total are given). */
	offer(spec: { count: number; total: number } | { files: ManifestFile[] }): void;
	/** A made-up outgoing batch, as if those files had been dropped. */
	simulateSend(spec: { count: number; total: number }): void;
	/** The other side cancels the active batch of `side`, or it fails with `error`. */
	remoteEnd(side: BatchSide, how: { cancelled: true } | { error: FtErrorCode }): void;
	reconnecting(): void;
	reconnected(): void;
	loseLane(): void;
	/** Lane 0 is gone: the session ends. */
	lose(): void;
}

declare global {
	interface Window {
		__ftMock?: MockControl;
	}
}

export function mockDeps(): FtDeps {
	const world = new MockWorld();
	const control: MockControl = {
		options: world.options,
		setPeers: (peers) => world.presence?.setPeers(peers),
		setError: (code) => world.presence?.set({ error: code }),
		away: () => world.presence?.set({ state: "away" }),
		incoming(from) {
			const p = world.presence;
			const first = p?.peers[0];
			const who = from ?? (first ? { id: first.id, name: first.name, emoji: first.emoji } : null);
			if (p && who) p.incoming(who);
		},
		offer(spec) {
			world.engine?.offer("files" in spec ? spec.files : fakeManifest(spec.count, spec.total));
		},
		simulateSend(spec) {
			world.engine?.sendManifest(fakeManifest(spec.count, spec.total));
		},
		remoteEnd(side, how) {
			world.engine?.remoteEnd(
				side,
				"error" in how
					? { phase: "failed", error: how.error }
					: { phase: "cancelled", cancelledBy: side === "send" ? "receiver" : "sender" },
			);
		},
		reconnecting: () => world.session?.emit({ type: "reconnecting" }),
		reconnected: () => world.session?.emit({ type: "reconnected" }),
		loseLane: () => world.session?.loseLane(),
		lose: () => world.session?.emit({ type: "closed", reason: "lost" }),
	};
	window.__ftMock = control;

	const sleep = (ms: number, signal?: AbortSignal) =>
		new Promise<void>((resolve, reject) => {
			const t = setTimeout(resolve, ms);
			signal?.addEventListener("abort", () => {
				clearTimeout(t);
				reject(signal.reason);
			});
		});

	return {
		demo: true,
		createPresence() {
			world.presence?.stop();
			world.presence = new MockPresence(world);
			return world.presence;
		},
		signaling: (handshake, self) => new MockSignaling(handshake, self),
		async connect(opts: ConnectOptions) {
			const sig = opts.signaling as MockSignaling;
			await sleep(world.options.connectMs, opts.signal);
			if (world.options.connectResult !== "ok") throw new FtError(world.options.connectResult);
			world.session = new MockSession(sig.offerer, sig.handshake.remote, world);
			return world.session;
		},
		createEngine(session) {
			world.engine = new MockEngine(session as MockSession, world);
			return world.engine;
		},
		sinks: {
			zip: async (ctx: SinkContext, offer) => {
				if (offer.total > tuning.memoryMax && world.options.caps.zip === false) throw new FtError("too-big");
				return mockSink("zip", zipName(ctx.peerName));
			},
			folder: async () => {
				await sleep(300);
				return mockSink("folder", "Pictures/Trip", world.options.folderSkips);
			},
			memory: async (ctx) => mockSink("memory", zipName(ctx.peerName)),
			test: () => null,
		},
		collect: {
			fromDrop: (data) =>
				Promise.resolve([...data.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }))),
			fromInput: (list) => [...list].map((file) => ({ file, path: file.webkitRelativePath || file.name })),
		},
		caps: () => ({ ...detectCaps(), ...world.options.caps }),
	};
}
