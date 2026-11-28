// Blazing Fast File Transfer (docs/file-transfer/SPEC.md): the page shell. It owns presence, the
// connection and the engine, and routes between the lobby (Peers.tsx), connecting, and the connected
// panel (Connected.tsx). Everything it talks to comes in through `FtDeps` (deps.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import { confirm } from "../../lib/confirm.tsx";
import { Button, Card, Note } from "../../lib/ui.tsx";
import { Connected } from "./Connected.tsx";
import { type Batches, errorText, isActive, percent, SHORT_NAME } from "./copy.ts";
import { type FtDeps, loadDeps } from "./deps.ts";
import { useHidden, useTabTitle, useWakeLock } from "./hooks.ts";
import { IncomingPanel, Lobby } from "./Peers.tsx";
import s from "./Send.module.css";
import { tuning } from "./tuning.ts";
import {
	type FtErrorCode,
	isFtError,
	type PeerRef,
	type PeerSession,
	type Presence,
	type PresenceSnapshot,
	type SendFile,
	type TransferEngine,
} from "./types.ts";

let depsPromise: Promise<FtDeps> | null = null;

export default function FileTransfer() {
	const [deps, setDeps] = useState<FtDeps | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		depsPromise ??= loadDeps();
		depsPromise.then(setDeps, () => {
			depsPromise = null;
			setFailed(true);
		});
	}, []);
	return (
		<div className={s.page}>
			<header className={s.intro}>
				<h1>Blazing Fast File Transfer</h1>
				<p className={s.lead}>
					Send photos, videos or whole folders straight to another device. Nothing is uploaded: files go directly
					between your browsers.
				</p>
			</header>
			{deps ? (
				<FileTransferApp deps={deps} />
			) : failed ? (
				<Note tone="danger">Couldn't load {SHORT_NAME}. Check your connection and reload the page.</Note>
			) : (
				<Card className={s.panel}>
					<p className={s.muted}>Loading…</p>
				</Card>
			)}
		</div>
	);
}

/* ---------- State */

type Conn =
	| { phase: "none" }
	| { phase: "connecting"; remote: PeerRef; abort: AbortController }
	| { phase: "connected"; remote: PeerRef; session: PeerSession; engine: TransferEngine }
	| { phase: "failed"; remote: PeerRef; code: FtErrorCode };

const EMPTY: PresenceSnapshot = {
	state: "active",
	me: null,
	peers: [],
	incoming: null,
	outgoing: null,
	handshake: null,
	outcome: null,
	error: null,
};

function usePresence(deps: FtDeps): [Presence | null, PresenceSnapshot] {
	const [presence, setPresence] = useState<Presence | null>(null);
	const [snap, setSnap] = useState<PresenceSnapshot>(EMPTY);
	useEffect(() => {
		const p = deps.createPresence();
		setPresence(p);
		setSnap(p.snapshot());
		const off = p.subscribe(setSnap);
		return () => {
			off();
			p.stop();
		};
	}, [deps]);
	return [presence, snap];
}

/* ---------- The app */

export function FileTransferApp({ deps }: { deps: FtDeps }) {
	const [presence, snap] = usePresence(deps);
	const [conn, setConn] = useState<Conn>({ phase: "none" });
	const [batches, setBatches] = useState<Batches>({ offer: null, send: null, receive: null });
	/** Files of the last send, for "Send again" after a lost connection (§10). */
	const lastSend = useRef<{ remote: string; files: SendFile[] } | null>(null);
	const pairStarted = useRef<string | null>(null);
	const hidden = useHidden();

	// An accept was seen (either way): open lane 0 (§4.2 step 3).
	useEffect(() => {
		const h = snap.handshake;
		const me = snap.me;
		if (!h || !me || !presence || pairStarted.current === h.pair) return;
		pairStarted.current = h.pair;
		const abort = new AbortController();
		setConn({ phase: "connecting", remote: h.remote, abort });
		const caps = deps.caps();
		deps
			.connect({
				signaling: deps.signaling(h, me.id),
				hello: {
					name: me.name,
					emoji: me.emoji,
					caps: { folder: caps.folder, zip: caps.zip, memoryMax: tuning.memoryMax, lanes: tuning.lanes },
				},
				signal: abort.signal,
			})
			.then(
				(session) => {
					if (abort.signal.aborted) return session.close();
					void presence.markConnected().catch(() => {});
					const engine = deps.createEngine(session);
					const remote = { id: h.remote.id, name: session.remote.name, emoji: session.remote.emoji };
					setBatches((b) => ({
						offer: null,
						receive: null,
						// Keep an interrupted send to this person, so "Send again" is one click.
						send: b.send?.phase === "interrupted" && lastSend.current?.remote === remote.id ? b.send : null,
					}));
					setConn({ phase: "connected", remote, session, engine });
				},
				(e: unknown) => {
					if (abort.signal.aborted) return;
					void presence.endSession().catch(() => {});
					setConn({ phase: "failed", remote: h.remote, code: isFtError(e) ? e.code : "failed-direct" });
				},
			);
	}, [snap.handshake, snap.me, presence, deps]);

	// Engine events → batch state; session closed → back to the lobby or "Connection lost".
	useEffect(() => {
		if (conn.phase !== "connected") return;
		const { engine, session, remote } = conn;
		const offEngine = engine.on((e) => {
			if (e.type === "offer") setBatches((b) => ({ ...b, offer: e.offer }));
			else
				setBatches((b) => {
					const p = e.progress;
					const next = { ...b, [p.side]: p };
					if (p.side === "receive" && b.offer?.batch === p.batch && p.phase !== "offered") next.offer = null;
					return next;
				});
		});
		const offSession = session.on((e) => {
			if (e.type !== "closed") return;
			engine.dispose();
			// Not closed by us: the other side may have left without telling the server (iOS tab close).
			void presence?.endSession(e.reason !== "local").catch(() => {});
			pairStarted.current = null;
			setBatches((b) => ({ ...b, offer: null }));
			if (e.reason === "local") setConn({ phase: "none" });
			else setConn({ phase: "failed", remote, code: e.reason === "protocol" ? "protocol" : "lost" });
		});
		// Tell the other side when this tab goes away (no "Leave site?" prompt, §4.5).
		const onHide = () => session.close();
		addEventListener("pagehide", onHide);
		return () => {
			offEngine();
			offSession();
			removeEventListener("pagehide", onHide);
		};
	}, [conn, presence]);

	// Leaving the page (another tool) ends the session quietly.
	const connRef = useRef(conn);
	connRef.current = conn;
	useEffect(
		() => () => {
			const c = connRef.current;
			if (c.phase === "connected") c.session.close();
			if (c.phase === "connecting") c.abort.abort();
		},
		[],
	);

	const running = [batches.send, batches.receive].some(
		(b) => b && (b.phase === "running" || b.phase === "reconnecting"),
	);
	useWakeLock(conn.phase === "connected" && running);
	useTabTitle(hidden ? tabTitle(snap, conn, batches) : null);

	const backToLobby = useCallback(() => {
		pairStarted.current = null;
		setConn({ phase: "none" });
	}, []);

	const cancelConnecting = useCallback(() => {
		if (conn.phase !== "connecting") return;
		conn.abort.abort();
		pairStarted.current = null;
		void presence?.endSession().catch(() => {});
		setConn({ phase: "none" });
	}, [conn, presence]);

	const disconnect = useCallback(async () => {
		if (conn.phase !== "connected") return;
		const active = [batches.send, batches.receive].some((b) => b && isActive(b.phase));
		if (
			active &&
			!(await confirm({
				title: `Disconnect from ${conn.remote.name}?`,
				message: "The transfer stops. Files that haven't finished are not saved.",
				confirmLabel: "Disconnect",
				tone: "danger",
			}))
		)
			return;
		conn.session.close();
	}, [conn, batches]);

	if (!presence) return null;

	if (conn.phase === "connected")
		return (
			<Connected
				deps={deps}
				remote={conn.remote}
				session={conn.session}
				engine={conn.engine}
				batches={batches}
				lastSend={lastSend}
				onDisconnect={disconnect}
			/>
		);

	return (
		<>
			{snap.incoming && conn.phase === "none" && <IncomingPanel request={snap.incoming} presence={presence} />}
			{conn.phase === "connecting" && (
				<Card className={s.panel}>
					<div className={s.connecting} role="status">
						<span className={s.bigEmoji} aria-hidden="true">
							{conn.remote.emoji}
						</span>
						<span className={s.connectingText}>
							<strong>Connecting to {conn.remote.name}…</strong>
							<span className={s.muted}>This usually takes a few seconds.</span>
						</span>
						<Button variant="ghost" onClick={cancelConnecting}>
							Cancel
						</Button>
					</div>
				</Card>
			)}
			{conn.phase === "failed" && <FailedCard conn={conn} batches={batches} presence={presence} onBack={backToLobby} />}
			{conn.phase === "none" && <Lobby presence={presence} snap={snap} />}
			<p className={s.smallPrint}>
				Connecting shares your network address with that person. Files travel encrypted, straight between the two
				browsers; nothing is stored on a server. Fastest when both devices are on Wi-Fi or a wired connection. On mobile
				data, speed is limited by the cellular network, and the transfer counts against your data plan.
				{deps.demo && " Demo mode: the people and transfers on this page are simulated."}
			</p>
		</>
	);
}

function FailedCard({
	conn,
	batches,
	presence,
	onBack,
}: {
	conn: Extract<Conn, { phase: "failed" }>;
	batches: Batches;
	presence: Presence;
	onBack: () => void;
}) {
	const [error, setError] = useState<string | null>(null);
	const lost = conn.code === "lost";
	const interrupted = [batches.send, batches.receive].filter((b) => b?.phase === "interrupted");
	const retry = async () => {
		setError(null);
		try {
			await presence.request(conn.remote.id);
			onBack();
		} catch (e) {
			setError(errorText(isFtError(e) ? e.code : "signal-error", conn.remote.name));
		}
	};
	const ref = useRef<HTMLHeadingElement>(null);
	useEffect(() => ref.current?.focus(), []);
	return (
		<Card className={s.panel}>
			<h2 className={s.panelTitle} ref={ref} tabIndex={-1}>
				{lost ? `Connection to ${conn.remote.name} lost` : `Couldn't connect to ${conn.remote.name}`}
			</h2>
			<Note tone="danger">
				{lost
					? interrupted.length
						? interrupted.some((b) => b?.mode !== "folder")
							? "The transfer stopped partway. A download that had started is incomplete. Connect again and send again to start a new one."
							: "The transfer stopped partway. Connect again and send again: files already saved are skipped."
						: "Connection lost."
					: errorText(conn.code, conn.remote.name)}
			</Note>
			{error && <Note tone="danger">{error}</Note>}
			<div className={s.actions}>
				<Button onClick={retry}>Connect again</Button>
				<Button variant="ghost" onClick={onBack}>
					Back to everyone
				</Button>
			</div>
		</Card>
	);
}

/** The tab title while the tab is hidden: the stand-in for notifications (§4.2, §9). */
function tabTitle(snap: PresenceSnapshot, conn: Conn, b: Batches): string | null {
	if (snap.incoming && conn.phase === "none") return `(1) Request from ${snap.incoming.from.name} · ${SHORT_NAME}`;
	if (conn.phase !== "connected") return null;
	if (b.offer) return `(1) ${conn.remote.name} is sending files · ${SHORT_NAME}`;
	const p = [b.receive, b.send].find((x) => x && (x.phase === "running" || x.phase === "reconnecting"));
	if (p) return `${percent(p.bytesDone, p.bytes)}% · ${SHORT_NAME}`;
	const done = [b.receive, b.send].find(
		(x) => x?.phase === "done" && x.endedAt && Date.now() - x.endedAt < 60 * 60_000,
	);
	if (done) return `Done · ${SHORT_NAME}`;
	return null;
}
