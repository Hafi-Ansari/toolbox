// In-memory stand-ins for RTCPeerConnection and RTCDataChannel, for the lanes tests (no browser needed).
//
// A FakeNet links peer connections through their SDP: a description is just "fake <pc id> <ice generation>
// a=candidate". Once two connections hold each other's descriptions, ICE "connects" and negotiated channels
// with the same id open in pairs. Tests drive failures through the net (`block`) and the connections
// (`setIce`, `close`).

export class FakeChannel extends EventTarget {
	readonly label: string;
	readonly id: number;
	readyState: RTCDataChannelState = "connecting";
	bufferedAmount = 0;
	bufferedAmountLowThreshold = 0;
	binaryType: BinaryType = "blob";
	peer: FakeChannel | null = null;
	/** Everything sent, for assertions. */
	readonly sent: unknown[] = [];

	constructor(label: string, id: number) {
		super();
		this.label = label;
		this.id = id;
	}

	send(data: unknown): void {
		if (this.readyState !== "open") throw new DOMException("not open", "InvalidStateError");
		this.sent.push(data);
		const peer = this.peer;
		setTimeout(() => {
			if (peer?.readyState === "open") peer.dispatchEvent(new MessageEvent("message", { data }));
		}, 0);
	}

	open(): void {
		if (this.readyState !== "connecting") return;
		this.readyState = "open";
		this.dispatchEvent(new Event("open"));
	}

	close(): void {
		if (this.readyState === "closed") return;
		this.readyState = "closed";
		const peer = this.peer;
		setTimeout(() => {
			this.dispatchEvent(new Event("close"));
			peer?.close();
		}, 0);
	}
}

export interface FakeStats {
	local: string;
	remote: string;
}

export class FakePc extends EventTarget {
	readonly id: number;
	readonly net: FakeNet;
	readonly channels: FakeChannel[] = [];
	localDescription: RTCSessionDescriptionInit | null = null;
	remoteDescription: RTCSessionDescriptionInit | null = null;
	iceConnectionState: RTCIceConnectionState = "new";
	iceGatheringState: RTCIceGatheringState = "new";
	signalingState: RTCSignalingState = "stable";
	connectionState: RTCPeerConnectionState = "new";
	remote: FakePc | null = null;
	generation = 0;
	/** ICE restart offers made by this connection. */
	restarts = 0;

	constructor(net: FakeNet, id: number) {
		super();
		this.net = net;
		this.id = id;
	}

	createDataChannel(label: string, init: RTCDataChannelInit): FakeChannel {
		const ch = new FakeChannel(label, init.id ?? -1);
		this.channels.push(ch);
		return ch;
	}

	async createOffer(opts?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
		if (opts?.iceRestart) {
			this.generation++;
			this.restarts++;
		}
		return { type: "offer", sdp: `fake ${this.id} ${this.generation}` };
	}

	async createAnswer(): Promise<RTCSessionDescriptionInit> {
		return { type: "answer", sdp: `fake ${this.id} ${this.generation}` };
	}

	async setLocalDescription(d: RTCSessionDescriptionInit): Promise<void> {
		this.localDescription = { type: d.type, sdp: `${d.sdp}\r\na=candidate:1 1 udp 1 10.0.0.${this.id} 9 typ host` };
		this.signalingState = d.type === "offer" ? "have-local-offer" : "stable";
		this.iceGatheringState = "gathering";
		setTimeout(() => {
			this.iceGatheringState = "complete";
			this.dispatchEvent(new Event("icegatheringstatechange"));
		}, 0);
		this.maybeConnect();
	}

	async setRemoteDescription(d: RTCSessionDescriptionInit): Promise<void> {
		const m = /^fake (\d+) (\d+)/.exec(d.sdp ?? "");
		if (!m) throw new DOMException("bad sdp", "OperationError");
		const other = this.net.pcs.get(Number(m[1]));
		if (!other) throw new DOMException("unknown pc", "OperationError");
		if (d.type === "offer") this.generation = Number(m[2]);
		this.remote = other;
		this.remoteDescription = d;
		this.signalingState = d.type === "offer" ? "have-remote-offer" : "stable";
		this.maybeConnect();
	}

	/** Both sides hold each other's descriptions at the same generation → connect. */
	private maybeConnect(): void {
		const o = this.remote;
		if (!o || o.remote !== this || !this.localDescription || !o.localDescription) return;
		if (!this.remoteDescription || !o.remoteDescription || this.generation !== o.generation) return;
		if (this.signalingState !== "stable" || o.signalingState !== "stable") return;
		setTimeout(() => {
			if (this.net.block || this.iceConnectionState === "closed" || o.iceConnectionState === "closed") return;
			if (this.net.allowed !== null && this.net.allowed-- <= 0) return;
			for (const pc of [this, o]) pc.setIce("connected");
			for (const ch of this.channels) {
				const twin = o.channels.find((c) => c.id === ch.id && c.readyState === "connecting");
				if (!twin || ch.readyState !== "connecting") continue;
				ch.peer = twin;
				twin.peer = ch;
				ch.open();
				twin.open();
			}
		}, this.net.latencyMs);
	}

	setIce(state: RTCIceConnectionState): void {
		if (this.iceConnectionState === "closed" || this.iceConnectionState === state) return;
		this.iceConnectionState = state;
		this.dispatchEvent(new Event("iceconnectionstatechange"));
	}

	async getStats(): Promise<Map<string, unknown>> {
		const s = this.net.stats;
		return new Map<string, unknown>([
			["T", { type: "transport", selectedCandidatePairId: "P" }],
			["P", { type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R" }],
			["L", { type: "local-candidate", candidateType: s.local }],
			["R", { type: "remote-candidate", candidateType: s.remote }],
		]);
	}

	close(): void {
		if (this.iceConnectionState === "closed") return;
		this.iceConnectionState = "closed";
		this.signalingState = "closed";
		this.connectionState = "closed";
		for (const ch of this.channels) ch.close();
	}
}

export class FakeNet {
	readonly pcs = new Map<number, FakePc>();
	private next = 1;
	/** No connection gets through while set. */
	block = false;
	/** When a number: only that many more connections get through. */
	allowed: number | null = null;
	latencyMs = 1;
	stats: FakeStats = { local: "host", remote: "host" };

	readonly create = (_config: RTCConfiguration): RTCPeerConnection => {
		const pc = new FakePc(this, this.next++);
		this.pcs.set(pc.id, pc);
		return pc as unknown as RTCPeerConnection;
	};
}
