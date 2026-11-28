// Lanes: the WebRTC side of File Transfer (SPEC §7.1, §7.2 lane messages, §10, §11). WP4.
//
// A session is N peer connections ("lanes") between the same two browsers. Lane 0 carries two negotiated
// channels, `ctrl` (id 0, JSON) and `data` (id 1, binary frames); lanes 1..N-1 carry only `data` (id 1).
// Lane 0's offer and answer go through `Signaling` (the server mailbox); everything after that rides on
// `ctrl`: the `hello` exchange, extra lanes (`lane-offer`/`lane-answer`), ICE restarts
// (`restart-offer`/`restart-answer`), `lane-close` and `bye`.
//
// Only the offerer ever creates offers (initial, extra lanes, ICE restarts), as WebDrop's PeerSession does,
// so there is no glare. ICE is non-trickle: each SDP is sent once gathering completes or after 3 s.
//
// Adapted from WebDrop's web/src/lib/session.ts (MIT, same author), without its SecureLink.

import {
	CTRL_CHANNEL_ID,
	DATA_CHANNEL_ID,
	ICE_GATHER_TIMEOUT_MS,
	ICE_RESTART_AFTER_MS,
	ICE_SERVERS,
	LANE_LOST_AFTER_MS,
	LANE_OPEN_TIMEOUT_MS,
	MAX_LANES,
	PROTOCOL_VERSION,
	tuning,
} from "../tuning.ts";
import {
	type Connect,
	type ConnectOptions,
	type CtrlOf,
	type Dir,
	encodeCtrl,
	FtError,
	isLaneCtrl,
	type Lane,
	type LaneCtrl,
	type PathType,
	type PeerSession,
	parseCtrl,
	type SessionEndReason,
	type SessionEvent,
	type TransferCtrl,
} from "../types.ts";

/** Injection points for tests and the benchmark. Production uses the defaults. */
export interface LaneOptions {
	/** Defaults to `new RTCPeerConnection(config)`. */
	createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
	/** Defaults to `ICE_SERVERS` (STUN only, §7.1). Tests pass `[]` to stay off the internet. */
	iceServers?: RTCIceServer[];
	gatherTimeoutMs?: number;
	openTimeoutMs?: number;
	restartAfterMs?: number;
	lostAfterMs?: number;
	/** How long `close()` waits for `bye` to leave before closing lane 0. */
	byeFlushMs?: number;
}

type Timer = ReturnType<typeof setTimeout>;

interface LaneConn {
	readonly index: number;
	readonly pc: RTCPeerConnection;
	readonly data: RTCDataChannel;
	/** Lane 0 only. */
	readonly ctrl: RTCDataChannel | null;
	/** `data` opened and the lane was announced (or, for lane 0, the session became ready). */
	open: boolean;
	closed: boolean;
	/** Offerer: a restart offer is out, waiting for its answer. */
	restarting: boolean;
	/** Negotiation steps of this lane run one after another. */
	chain: Promise<void>;
	openTimer?: Timer;
	restartTimer?: Timer;
	lostTimer?: Timer;
	/** The `Lane` handed to the engine. */
	readonly lane: Lane;
}

const isConnected = (pc: RTCPeerConnection) =>
	pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed";

/**
 * Non-trickle ICE (§7.1): set the local description, wait for gathering to complete (or `timeoutMs`),
 * then return the whole SDP with its candidates.
 */
async function localSdp(
	pc: RTCPeerConnection,
	kind: "offer" | "answer",
	timeoutMs: number,
	iceRestart = false,
): Promise<string> {
	const desc =
		kind === "offer" ? await pc.createOffer(iceRestart ? { iceRestart: true } : undefined) : await pc.createAnswer();
	await pc.setLocalDescription(desc);
	await new Promise<void>((resolve) => {
		// After an ICE restart the state can still read "complete" from the previous generation for a moment;
		// a description that already lists candidates is the real thing.
		const done = () => pc.iceGatheringState === "complete" && (pc.localDescription?.sdp ?? "").includes("a=candidate");
		if (done()) return resolve();
		const finish = () => {
			clearTimeout(timer);
			pc.removeEventListener("icegatheringstatechange", onChange);
			resolve();
		};
		const onChange = () => {
			if (pc.iceGatheringState === "complete") finish();
		};
		const timer = setTimeout(finish, timeoutMs);
		pc.addEventListener("icegatheringstatechange", onChange);
	});
	const sdp = pc.localDescription?.sdp;
	if (!sdp) throw new Error("no local description");
	return sdp;
}

/** §7.1 path type from the selected candidate pair: `host` on both ends → same network. null when unknown. */
export async function readPathType(pc: RTCPeerConnection): Promise<PathType | null> {
	const stats = await pc.getStats();
	let pairId: string | undefined;
	stats.forEach((r: { type?: string; selectedCandidatePairId?: string }) => {
		if (r.type === "transport" && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
	});
	type Pair = {
		type?: string;
		selected?: boolean;
		nominated?: boolean;
		state?: string;
		localCandidateId?: string;
		remoteCandidateId?: string;
	};
	let pair: Pair | undefined = pairId ? stats.get(pairId) : undefined;
	if (!pair) {
		// Firefox has no transport stats; it marks the pair `selected`.
		stats.forEach((r: Pair) => {
			if (!pair && r.type === "candidate-pair" && (r.selected || (r.nominated && r.state === "succeeded"))) pair = r;
		});
	}
	if (!pair?.localCandidateId || !pair.remoteCandidateId) return null;
	const local = stats.get(pair.localCandidateId) as { candidateType?: string } | undefined;
	const remote = stats.get(pair.remoteCandidateId) as { candidateType?: string } | undefined;
	if (!local?.candidateType || !remote?.candidateType) return null;
	return local.candidateType === "host" && remote.candidateType === "host" ? "same-network" : "direct";
}

/** The lane count both sides agree on: the smaller of the two hellos, within 1..MAX_LANES. */
export function laneCount(local: number, remote: number): number {
	const clamp = (n: number) => (Number.isSafeInteger(n) && n >= 1 ? Math.min(n, MAX_LANES) : 1);
	return Math.min(clamp(local), clamp(remote));
}

function validLocalLanes(n: number): number {
	return Number.isSafeInteger(n) && n >= 1 ? Math.min(n, MAX_LANES) : Math.min(tuning.lanes, MAX_LANES);
}

class Session implements PeerSession {
	readonly offerer: boolean;
	readonly dir: Dir;
	remote!: CtrlOf<"hello">;

	private readonly opts: Required<LaneOptions>;
	private readonly hello: CtrlOf<"hello">;
	private readonly conns = new Map<number, LaneConn>();
	private readonly listeners = new Set<(e: SessionEvent) => void>();
	/** Events before the first listener (a manifest can arrive before the engine subscribes). */
	private readonly early: SessionEvent[] = [];
	private target = 1;
	private ready = false;
	private ended = false;
	private reconnecting = false;
	private pathTimer?: Timer;
	/** Connect phase: settles `connect()`. */
	private settle: { resolve: () => void; reject: (e: unknown) => void } | null = null;

	constructor(offerer: boolean, hello: CtrlOf<"hello">, opts: Required<LaneOptions>) {
		this.offerer = offerer;
		this.dir = offerer ? 1 : 0;
		this.hello = hello;
		this.opts = opts;
	}

	/* ---------- PeerSession */

	lanes(): readonly Lane[] {
		return [...this.conns.values()]
			.filter((c) => c.open && !c.closed)
			.sort((a, b) => a.index - b.index)
			.map((c) => c.lane);
	}

	sendCtrl(msg: TransferCtrl): void {
		this.sendRaw(msg);
	}

	on(listener: (e: SessionEvent) => void): () => void {
		this.listeners.add(listener);
		if (this.early.length) for (const e of this.early.splice(0)) listener(e);
		return () => this.listeners.delete(listener);
	}

	close(): void {
		this.end("local");
	}

	/* ---------- connect phase */

	/** Lane 0 handshake through the server mailbox, then wait for ctrl+data open and the remote hello. */
	async start(signaling: ConnectOptions["signaling"], abort: AbortSignal): Promise<void> {
		const lane0 = this.makeLane(0);
		const readyPromise = new Promise<void>((resolve, reject) => {
			this.settle = { resolve, reject };
		});
		// Rejections before we await it must not surface as unhandled.
		readyPromise.catch(() => {});
		const fail = (e: unknown) => this.settle?.reject(e);
		abort.addEventListener("abort", () => fail(abort.reason), { once: true });

		const signal = async <T>(step: () => Promise<T>): Promise<T> => {
			try {
				return await step();
			} catch (e) {
				if (abort.aborted) throw abort.reason;
				throw e instanceof FtError ? e : new FtError("signal-error", String(e));
			}
		};
		const rtc = async <T>(step: () => Promise<T>): Promise<T> => {
			try {
				return await step();
			} catch (e) {
				if (abort.aborted) throw abort.reason;
				throw e instanceof FtError ? e : new FtError("failed-direct", String(e));
			}
		};
		const gather = this.opts.gatherTimeoutMs;
		const race = <T>(p: Promise<T>) => Promise.race([p, readyPromise.then(() => p)]);

		if (this.offerer) {
			const sdp = await race(rtc(() => localSdp(lane0.pc, "offer", gather)));
			await race(signal(() => signaling.send({ type: "offer", sdp })));
			const answer = await race(signal(() => signaling.next(abort)));
			if (answer.type !== "answer") throw new FtError("signal-error", "expected an answer");
			await race(rtc(() => lane0.pc.setRemoteDescription({ type: "answer", sdp: answer.sdp })));
		} else {
			const offer = await race(signal(() => signaling.next(abort)));
			if (offer.type !== "offer") throw new FtError("signal-error", "expected an offer");
			await race(rtc(() => lane0.pc.setRemoteDescription({ type: "offer", sdp: offer.sdp })));
			const sdp = await race(rtc(() => localSdp(lane0.pc, "answer", gather)));
			await race(signal(() => signaling.send({ type: "answer", sdp })));
		}

		// §7.1: lane 0 not open (channels plus hello) within 15 s of the handshake → failed-direct.
		this.checkReady();
		if (!this.ready)
			lane0.openTimer = setTimeout(
				() => fail(new FtError("failed-direct", "lane 0 did not open")),
				this.opts.openTimeoutMs,
			);
		await readyPromise;
	}

	/** Lane 0 is ready once both channels are open and the remote hello arrived. */
	private checkReady(): void {
		const c = this.conns.get(0);
		if (this.ready || !c || !this.settle) return;
		if (c.ctrl?.readyState !== "open" || c.data.readyState !== "open" || !this.remote) return;
		this.ready = true;
		c.open = true;
		clearTimeout(c.openTimer);
		this.target = laneCount(this.hello.caps.lanes, this.remote.caps.lanes);
		const { resolve } = this.settle;
		this.settle = null;
		resolve();
		void this.refreshPath();
		if (this.offerer) for (let i = 1; i < this.target; i++) this.openLane(i);
	}

	/** Tear everything down after a failed connect (no events, no bye). */
	destroy(): void {
		this.ended = true;
		this.settle = null;
		for (const c of this.conns.values()) this.shut(c);
		this.conns.clear();
		clearTimeout(this.pathTimer);
	}

	/* ---------- lanes */

	private makeLane(index: number): LaneConn {
		const pc = this.opts.createPeerConnection({ iceServers: this.opts.iceServers });
		const ctrl =
			index === 0 ? pc.createDataChannel("ctrl", { negotiated: true, id: CTRL_CHANNEL_ID, ordered: true }) : null;
		const data = pc.createDataChannel("data", { negotiated: true, id: DATA_CHANNEL_ID, ordered: true });
		data.binaryType = "arraybuffer";
		const conn: LaneConn = {
			index,
			pc,
			data,
			ctrl,
			open: false,
			closed: false,
			restarting: false,
			chain: Promise.resolve(),
			lane: { index, data },
		};
		this.conns.set(index, conn);
		pc.addEventListener("iceconnectionstatechange", () => this.onIce(conn));
		data.addEventListener("open", () => this.onDataOpen(conn));
		data.addEventListener("close", () => this.onChannelClose(conn));
		if (ctrl) {
			ctrl.addEventListener("open", () => {
				this.sendRaw(this.hello);
				this.checkReady();
			});
			ctrl.addEventListener("message", (ev) => this.onCtrl(ev.data));
			ctrl.addEventListener("close", () => this.onChannelClose(conn));
		}
		return conn;
	}

	/** Offerer: open lane `index` and offer it over ctrl. */
	private openLane(index: number): void {
		const conn = this.makeLane(index);
		this.armOpenTimer(conn);
		this.enqueue(conn, async () => {
			const sdp = await localSdp(conn.pc, "offer", this.opts.gatherTimeoutMs);
			this.sendRaw({ t: "lane-offer", lane: index, sdp });
		});
	}

	/** §7.1: an extra lane not open in 15 s is dropped quietly. */
	private armOpenTimer(conn: LaneConn): void {
		conn.openTimer = setTimeout(() => this.dropLane(conn, true), this.opts.openTimeoutMs);
	}

	private onDataOpen(conn: LaneConn): void {
		if (conn.closed || this.ended) return;
		if (conn.index === 0) {
			this.checkReady();
			return;
		}
		clearTimeout(conn.openTimer);
		conn.open = true;
		this.emit({ type: "lane-open", lane: conn.lane });
	}

	private onChannelClose(conn: LaneConn): void {
		if (conn.closed || this.ended) return;
		if (conn.index === 0) {
			if (this.settle) this.settle.reject(new FtError("failed-direct", "lane 0 closed"));
			else this.end("lost");
			return;
		}
		this.dropLane(conn, true);
	}

	/** Close a lane; announce it as lost if it was open. Lane 0 ends the session. */
	private dropLane(conn: LaneConn, tell: boolean): void {
		if (conn.closed || this.ended) return;
		if (conn.index === 0) {
			if (this.settle) this.settle.reject(new FtError("failed-direct", "lane 0 lost"));
			else this.end("lost");
			return;
		}
		const wasOpen = conn.open;
		this.shut(conn);
		this.conns.delete(conn.index);
		if (tell) this.sendRaw({ t: "lane-close", lane: conn.index });
		if (wasOpen) this.emit({ type: "lane-lost", index: conn.index });
	}

	private shut(conn: LaneConn): void {
		if (conn.closed) return;
		conn.closed = true;
		conn.open = false;
		clearTimeout(conn.openTimer);
		clearTimeout(conn.restartTimer);
		clearTimeout(conn.lostTimer);
		try {
			conn.data.close();
			conn.ctrl?.close();
			conn.pc.close();
		} catch {
			// Already closed.
		}
	}

	private enqueue(conn: LaneConn, task: () => Promise<void>): void {
		conn.chain = conn.chain.then(async () => {
			if (conn.closed || this.ended) return;
			try {
				await task();
			} catch {
				// A lane whose negotiation fails is dropped; lane 0 failing this way ends the session.
				this.dropLane(conn, true);
			}
		});
	}

	/* ---------- ICE: restart after 3 s disconnected, lost after 20 s (§7.1, §10) */

	private onIce(conn: LaneConn): void {
		if (conn.closed || this.ended) return;
		const state = conn.pc.iceConnectionState;
		if (state === "connected" || state === "completed") {
			clearTimeout(conn.restartTimer);
			clearTimeout(conn.lostTimer);
			conn.restartTimer = conn.lostTimer = undefined;
			if (conn.index === 0 && this.reconnecting) {
				this.reconnecting = false;
				this.emit({ type: "reconnected" });
				void this.refreshPath();
			}
			return;
		}
		if (state === "closed") {
			this.dropLane(conn, false);
			return;
		}
		if (state !== "disconnected" && state !== "failed") return;
		if (conn.index === 0 && this.settle) {
			// Still connecting: a failed lane 0 is a failed connect; disconnected may still recover.
			if (state === "failed") this.settle.reject(new FtError("failed-direct", "ICE failed"));
			return;
		}
		// Extra lanes that never opened are covered by their open timer.
		if (!conn.open) return;
		if (conn.index === 0 && !this.reconnecting) {
			this.reconnecting = true;
			this.emit({ type: "reconnecting" });
		}
		if (this.offerer && !conn.restarting) {
			clearTimeout(conn.restartTimer);
			conn.restartTimer = setTimeout(() => this.restart(conn), state === "failed" ? 0 : this.opts.restartAfterMs);
		}
		conn.lostTimer ??= setTimeout(() => this.dropLane(conn, true), this.opts.lostAfterMs);
	}

	/** Offerer: ICE restart, negotiated over ctrl. */
	private restart(conn: LaneConn): void {
		if (conn.closed || this.ended || conn.restarting || isConnected(conn.pc)) return;
		conn.restarting = true;
		this.enqueue(conn, async () => {
			const sdp = await localSdp(conn.pc, "offer", this.opts.gatherTimeoutMs, true);
			this.sendRaw({ t: "restart-offer", lane: conn.index, sdp });
		});
	}

	/* ---------- ctrl */

	private onCtrl(raw: unknown): void {
		if (this.ended) return;
		const msg = typeof raw === "string" ? parseCtrl(raw) : null;
		if (!msg) {
			this.violation("bad ctrl message");
			return;
		}
		if (!this.remote && msg.t !== "hello") {
			this.violation("ctrl before hello");
			return;
		}
		if (!isLaneCtrl(msg)) {
			this.emit({ type: "ctrl", msg });
			return;
		}
		this.onLaneCtrl(msg);
	}

	private onLaneCtrl(msg: LaneCtrl): void {
		switch (msg.t) {
			case "hello":
				// A second hello is ignored.
				if (!this.remote) {
					this.remote = msg;
					this.checkReady();
				}
				return;
			case "bye": {
				this.end("bye");
				return;
			}
			case "lane-offer": {
				if (this.offerer) {
					this.violation("lane-offer to the offerer");
					return;
				}
				if (msg.lane < 1 || msg.lane >= laneCount(this.hello.caps.lanes, this.remote.caps.lanes)) {
					this.violation("lane out of range");
					return;
				}
				// Offers for lanes we already have are ignored (indices are never reused).
				if (this.conns.has(msg.lane)) return;
				const conn = this.makeLane(msg.lane);
				this.armOpenTimer(conn);
				this.enqueue(conn, async () => {
					await conn.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
					const sdp = await localSdp(conn.pc, "answer", this.opts.gatherTimeoutMs);
					this.sendRaw({ t: "lane-answer", lane: msg.lane, sdp });
				});
				return;
			}
			case "lane-answer":
			case "restart-answer": {
				if (!this.offerer) {
					this.violation(`${msg.t} to the answerer`);
					return;
				}
				const conn = this.conns.get(msg.lane);
				// The lane may have been dropped meanwhile.
				if (!conn) return;
				this.enqueue(conn, async () => {
					if (conn.pc.signalingState !== "have-local-offer") return;
					await conn.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
					if (msg.t === "restart-answer") {
						conn.restarting = false;
						// Still down: try again after the usual pause; the lost timer bounds the attempts.
						clearTimeout(conn.restartTimer);
						conn.restartTimer = setTimeout(() => this.restart(conn), this.opts.restartAfterMs);
					}
				});
				return;
			}
			case "restart-offer": {
				if (this.offerer) {
					this.violation("restart-offer to the offerer");
					return;
				}
				const conn = this.conns.get(msg.lane);
				if (!conn) return;
				this.enqueue(conn, async () => {
					await conn.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
					const sdp = await localSdp(conn.pc, "answer", this.opts.gatherTimeoutMs);
					this.sendRaw({ t: "restart-answer", lane: msg.lane, sdp });
				});
				return;
			}
			case "lane-close": {
				if (msg.lane === 0) {
					this.violation("lane-close for lane 0");
					return;
				}
				const conn = this.conns.get(msg.lane);
				if (conn) this.dropLane(conn, false);
				return;
			}
		}
	}

	/** A bad message from the other browser: during connect a failed connect, after it `bye` and close (§10). */
	private violation(why: string): void {
		if (this.settle) this.settle.reject(new FtError("protocol", why));
		else this.end("protocol");
	}

	private sendRaw(msg: LaneCtrl | TransferCtrl): void {
		const ctrl = this.conns.get(0)?.ctrl;
		if (this.ended || ctrl?.readyState !== "open") return;
		const text = encodeCtrl(msg);
		try {
			ctrl.send(text);
		} catch {
			// The channel is closing; its close event ends the session.
		}
	}

	/* ---------- events, path, end */

	private emit(e: SessionEvent): void {
		if (this.listeners.size === 0) {
			// lanes() already reports lanes that opened before anyone listened.
			if (e.type !== "lane-open") this.early.push(e);
			return;
		}
		for (const l of [...this.listeners]) l(e);
	}

	private async refreshPath(retry = true): Promise<void> {
		const conn = this.conns.get(0);
		if (!conn || this.ended) return;
		let path: PathType | null = null;
		try {
			path = await readPathType(conn.pc);
		} catch {
			// getStats can fail while closing.
		}
		if (this.ended) return;
		if (path) this.emit({ type: "path", path });
		else if (retry) this.pathTimer = setTimeout(() => void this.refreshPath(false), 1000);
	}

	private end(reason: SessionEndReason): void {
		if (this.ended) return;
		if (reason === "local" || reason === "protocol") this.sendRaw({ t: "bye" });
		this.ended = true;
		clearTimeout(this.pathTimer);
		const lane0 = this.conns.get(0);
		for (const c of this.conns.values()) if (c !== lane0) this.shut(c);
		if (lane0) this.shutAfterFlush(lane0);
		this.conns.clear();
		this.emit({ type: "closed", reason });
	}

	/** Let `bye` leave before lane 0 closes: wait for `ctrl` to drain (at most `byeFlushMs`). */
	private shutAfterFlush(conn: LaneConn): void {
		const ctrl = conn.ctrl;
		if (ctrl?.readyState !== "open" || ctrl.bufferedAmount === 0) {
			// Nothing queued; a short pause still lets a just-sent message reach the transport.
			setTimeout(() => this.shut(conn), Math.min(50, this.opts.byeFlushMs));
			return;
		}
		const timer = setTimeout(() => this.shut(conn), this.opts.byeFlushMs);
		ctrl.addEventListener("bufferedamountlow", () => {
			clearTimeout(timer);
			this.shut(conn);
		});
		ctrl.bufferedAmountLowThreshold = 0;
	}
}

/** Build a `Connect` with injected dependencies (tests, benchmark). */
export function createConnect(options: LaneOptions = {}): Connect {
	const opts: Required<LaneOptions> = {
		createPeerConnection: options.createPeerConnection ?? ((config) => new RTCPeerConnection(config)),
		iceServers: options.iceServers ?? ICE_SERVERS,
		gatherTimeoutMs: options.gatherTimeoutMs ?? ICE_GATHER_TIMEOUT_MS,
		openTimeoutMs: options.openTimeoutMs ?? LANE_OPEN_TIMEOUT_MS,
		restartAfterMs: options.restartAfterMs ?? ICE_RESTART_AFTER_MS,
		lostAfterMs: options.lostAfterMs ?? LANE_LOST_AFTER_MS,
		byeFlushMs: options.byeFlushMs ?? 1000,
	};
	return async ({ signaling, hello, signal }) => {
		signal?.throwIfAborted();
		const own: CtrlOf<"hello"> = {
			t: "hello",
			v: PROTOCOL_VERSION,
			name: hello.name,
			emoji: hello.emoji,
			caps: { ...hello.caps, lanes: validLocalLanes(hello.caps.lanes) },
		};
		const session = new Session(signaling.offerer, own, opts);
		// One controller for the whole connect: the caller's abort, or our own failure, stops `signaling.next`.
		const ctl = new AbortController();
		const onAbort = () => ctl.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await session.start(signaling, ctl.signal);
			return session;
		} catch (e) {
			session.destroy();
			if (!ctl.signal.aborted) ctl.abort(e);
			throw e;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	};
}

/**
 * Connect to the other side (§7.1). Resolves once lane 0 is open and both hellos are exchanged; extra lanes
 * follow as `lane-open` events. Rejects with `FtError` `failed-direct` (no direct path in 15 s, ICE failed),
 * `signal-error` (mailbox trouble; a server `FtError` code passes through as is), `protocol` (bad hello),
 * or the abort reason.
 */
export const connect: Connect = createConnect();
