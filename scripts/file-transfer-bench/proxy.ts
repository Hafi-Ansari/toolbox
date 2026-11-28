// UDP impairment proxy for the File Transfer benchmark (SPEC §16.3), ported from the November 2026 spike.
//
// One UDP socket per lane stands in for the offerer's host candidate. The answerer is told only the
// proxy's address; the offerer learns the answerer as a peer-reflexive candidate (the proxy) from the
// incoming connectivity checks. Every packet gets one-way delay (rtt/2 each way), random loss, a shared
// per-direction token-bucket rate cap and a tail-drop buffer.
//
// Node's dgram plus a setImmediate pump tops out at roughly 30 MB/s on a fast desktop, so figures near
// that are the proxy's ceiling, not the transfer's.
import dgram from "node:dgram";

export interface LinkOptions {
	/** Round-trip time added, ms (half each way). */
	rttMs?: number;
	/** Packet loss probability, 0..1, each direction. */
	loss?: number;
	/** Rate cap per direction, bytes per second; 0 = none. */
	rateBps?: number;
	/** Tail-drop queue per direction, bytes. */
	bufBytes?: number;
}

type Dir = "up" | "down";
interface Packet {
	due: number;
	sock: dgram.Socket;
	msg: Buffer;
	address: string;
	port: number;
}

/** The impaired link all lanes of one session share. "up" is offerer → answerer. */
export class Link {
	readonly oneWay: number;
	readonly loss: number;
	readonly rate: number;
	readonly buf: number;
	drops = 0;
	losses = 0;
	pkts = 0;
	/** Payload bytes forwarded, per direction. */
	bytes = { up: 0, down: 0 };
	private q: Record<Dir, Packet[]> = { up: [], down: [] };
	private qBytes = { up: 0, down: 0 };
	private tokens = { up: 0, down: 0 };
	private last = performance.now();
	private running = true;

	constructor({ rttMs = 0, loss = 0, rateBps = 0, bufBytes = 4 << 20 }: LinkOptions) {
		this.oneWay = rttMs / 2;
		this.loss = loss;
		this.rate = rateBps;
		this.buf = bufBytes;
		const loop = () => {
			if (!this.running) return;
			this.tick();
			setImmediate(loop);
		};
		setImmediate(loop);
	}

	enqueue(dir: Dir, sock: dgram.Socket, msg: Buffer, address: string, port: number): void {
		this.pkts++;
		if (this.loss && Math.random() < this.loss) {
			this.losses++;
			return;
		}
		if (this.qBytes[dir] + msg.length > this.buf) {
			this.drops++;
			return;
		}
		this.q[dir].push({ due: performance.now() + this.oneWay, sock, msg, address, port });
		this.qBytes[dir] += msg.length;
	}

	private tick(): void {
		const now = performance.now();
		const dt = (now - this.last) / 1000;
		this.last = now;
		for (const dir of ["up", "down"] as const) {
			const q = this.q[dir];
			if (this.rate) this.tokens[dir] = Math.min(this.tokens[dir] + dt * this.rate, 256 * 1024);
			let i = 0;
			while (i < q.length) {
				const p = q[i] as Packet;
				if (p.due > now) break;
				if (this.rate) {
					if (this.tokens[dir] < p.msg.length) break;
					this.tokens[dir] -= p.msg.length;
				}
				p.sock.send(p.msg, p.port, p.address);
				this.qBytes[dir] -= p.msg.length;
				this.bytes[dir] += p.msg.length;
				i++;
			}
			if (i) q.splice(0, i);
		}
	}

	stop(): void {
		this.running = false;
	}
}

/** A proxy socket for one lane, forwarding to the offerer's real host candidate. */
export async function laneProxy(
	link: Link,
	senderAddr: string,
	senderPort: number,
): Promise<{ port: number; close(): void }> {
	const sock = dgram.createSocket({ type: "udp4", recvBufferSize: 16 << 20, sendBufferSize: 16 << 20 });
	await new Promise<void>((resolve) => sock.bind(0, "0.0.0.0", resolve));
	let peer: { address: string; port: number } | null = null;
	sock.on("message", (msg, r) => {
		const fromSender = r.address === senderAddr && r.port === senderPort;
		if (fromSender) {
			if (peer) link.enqueue("up", sock, msg, peer.address, peer.port);
		} else {
			peer = { address: r.address, port: r.port };
			link.enqueue("down", sock, msg, senderAddr, senderPort);
		}
	});
	sock.on("error", () => {});
	return { port: sock.address().port, close: () => sock.close() };
}

const stripCandidates = (sdp: string) =>
	sdp
		.split("\r\n")
		.filter((l) => !l.startsWith("a=candidate:") && l !== "a=end-of-candidates")
		.join("\r\n");

/** The offer's first IPv4 UDP host candidate (needs `--disable-features=WebRtcHideLocalIpsWithMdns`). */
export function hostCandidate(sdp: string): { ip: string; port: number } {
	for (const l of sdp.split("\r\n")) {
		if (!l.startsWith("a=candidate:")) continue;
		const f = l.slice(12).split(" ");
		const [proto, ip, port, typ] = [f[2], f[4], f[5], f[7]];
		if (
			proto?.toLowerCase() === "udp" &&
			typ === "host" &&
			/^\d+\.\d+\.\d+\.\d+$/.test(ip ?? "") &&
			!ip?.startsWith("169.254")
		)
			return { ip: ip as string, port: Number(port) };
	}
	throw new Error("no IPv4 host candidate in the offer");
}

/** Rewrites an offer so its only candidate is the proxy. */
export function viaProxy(sdp: string, ip: string, port: number): string {
	return `${stripCandidates(sdp).replace(/\r\n$/, "")}\r\na=candidate:1 1 udp 2122260223 ${ip} ${port} typ host\r\n`;
}

export { stripCandidates };
