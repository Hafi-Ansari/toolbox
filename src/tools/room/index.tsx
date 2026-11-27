import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../lib/Icon.tsx";
import { Button, Card, Note } from "../../lib/ui.tsx";
import {
	ago,
	beat,
	createRoom,
	endRoom,
	Gone,
	leave,
	linksIn,
	listRooms,
	ownerToken,
	type RoomInfo,
	readRoom,
	writeRoom,
} from "./client.ts";
import { type FilesHandle, FilesPanel } from "./Files.tsx";
import s from "./Room.module.css";

/** Poll fast while text is moving, slower when it's quiet, never while the tab is hidden. */
const FAST_MS = 1000;
const SLOW_MS = 4000;
const QUIET_AFTER_MS = 30_000;
const LIST_MS = 3000;
const BEAT_MS = 20_000;
const SEND_AFTER_MS = 350;

/** The open room lives in the URL (?r=…), so a reload or a shared link lands in it. */
const roomInUrl = () => new URLSearchParams(location.search).get("r");

function useRoomParam(): [string | null, (id: string | null) => void] {
	const [id, setId] = useState(roomInUrl);
	useEffect(() => {
		const onPop = () => setId(roomInUrl());
		addEventListener("popstate", onPop);
		return () => removeEventListener("popstate", onPop);
	}, []);
	const go = useCallback((next: string | null) => {
		const url = new URL(location.href);
		if (next) url.searchParams.set("r", next);
		else url.searchParams.delete("r");
		history.pushState(null, "", url);
		setId(next);
	}, []);
	return [id, go];
}

/** Runs `tick` now and then every `ms` while the tab is visible; again at once when it becomes visible. */
function useVisiblePoll(tick: () => void | Promise<void>, ms: () => number) {
	const latest = useRef({ tick, ms });
	latest.current = { tick, ms };
	useEffect(() => {
		let timer = 0;
		let stopped = false;
		const run = async () => {
			clearTimeout(timer);
			if (stopped || document.hidden) return;
			try {
				await latest.current.tick();
			} finally {
				if (!stopped && !document.hidden) timer = window.setTimeout(run, latest.current.ms());
			}
		};
		const onVisible = () => !document.hidden && void run();
		document.addEventListener("visibilitychange", onVisible);
		addEventListener("focus", onVisible);
		void run();
		return () => {
			stopped = true;
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisible);
			removeEventListener("focus", onVisible);
		};
	}, []);
}

export default function RoomTool() {
	const [roomId, go] = useRoomParam();
	return (
		<div className={s.page}>
			<header className={s.intro}>
				<h1>Shared room</h1>
				<p className={s.lead}>
					A text box and files every device can see. Make a room, open this page on your other device, tap the room, and
					paste or add files.
				</p>
			</header>
			{roomId ? <RoomView key={roomId} id={roomId} onLeave={() => go(null)} /> : <Lobby onOpen={go} />}
		</div>
	);
}

/* ---------- Lobby: the live rooms */

function Lobby({ onOpen }: { onOpen: (id: string) => void }) {
	const [rooms, setRooms] = useState<RoomInfo[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [now, setNow] = useState(Date.now());

	useVisiblePoll(
		async () => {
			try {
				setRooms(await listRooms());
				setNow(Date.now());
				setError(null);
			} catch {
				setError("Can't reach the rooms server right now. Retrying…");
			}
		},
		() => LIST_MS,
	);

	async function create() {
		setCreating(true);
		try {
			const room = await createRoom();
			onOpen(room.id);
		} catch (e) {
			setError(
				e instanceof Error && e.message === "full"
					? "There are too many rooms open right now. Try again in a few minutes."
					: "Couldn't make a room. Try again.",
			);
			setCreating(false);
		}
	}

	return (
		<Card className={s.panel}>
			<div className={s.lobbyBar}>
				<Button icon="chat" onClick={create} disabled={creating}>
					{creating ? "Making a room…" : "New room"}
				</Button>
				<span className={s.muted}>Rooms are public and end when their creator leaves, or after 2 hours.</span>
			</div>
			{error && <Note tone="danger">{error}</Note>}
			{rooms === null ? (
				<p className={s.muted}>Looking for rooms…</p>
			) : rooms.length === 0 ? (
				<div className={s.empty}>
					<p className={s.emptyTitle}>No rooms open</p>
					<p className={s.muted}>Make one here, then open this page on your other device and tap it.</p>
				</div>
			) : (
				<ul className={s.grid} aria-label="Open rooms">
					{rooms.map((r) => (
						<li key={r.id}>
							<button type="button" className={s.tile} onClick={() => onOpen(r.id)}>
								<span className={s.emoji} aria-hidden="true">
									{r.emoji}
								</span>
								<span className={s.tileText}>
									<span className={s.tileName}>
										{r.name}
										{ownerToken(r.id) && <span className={s.badge}>Yours</span>}
									</span>
									<span className={s.muted}>
										{ago(now - r.created)}
										{r.here > 0 && ` · ${r.here} here`}
									</span>
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}

/* ---------- One room: the shared text */

type Status = "loading" | "synced" | "saving" | "offline" | "ended";

function RoomView({ id, onLeave }: { id: string; onLeave: () => void }) {
	const owner = !!ownerToken(id);
	const [text, setText] = useState("");
	const [meta, setMeta] = useState<{ name: string; emoji: string; created: number } | null>(null);
	const [status, setStatus] = useState<Status>("loading");
	const [copied, setCopied] = useState<string | null>(null);
	const [fver, setFver] = useState<number | null>(null);
	const [dragging, setDragging] = useState(false);
	const dragDepth = useRef(0);
	const filesPanel = useRef<FilesHandle>(null);
	const area = useRef<HTMLTextAreaElement>(null);
	// Sync bookkeeping lives in refs: the poll loop reads the latest values without re-rendering.
	const ver = useRef<number | null>(null);
	const dirty = useRef(false);
	const sending = useRef(false);
	const lastActivity = useRef(Date.now());
	const sendTimer = useRef(0);
	const textRef = useRef(text);
	textRef.current = text;

	useVisiblePoll(
		async () => {
			if (status === "ended") return;
			try {
				const r = await readRoom(id, ver.current);
				setMeta({ name: r.name, emoji: r.emoji, created: r.created });
				setFver(r.fver ?? 0);
				// Someone else's text: take it, unless this device has edits on the way.
				if (r.text !== undefined && !dirty.current && !sending.current) {
					if (r.text !== textRef.current) {
						applyRemote(area.current, r.text, setText);
						lastActivity.current = Date.now();
					}
					ver.current = r.ver;
				}
				if (!dirty.current && !sending.current) setStatus("synced");
			} catch (e) {
				if (e instanceof Gone) setStatus("ended");
				else setStatus("offline");
			}
		},
		() => (Date.now() - lastActivity.current < QUIET_AFTER_MS ? FAST_MS : SLOW_MS),
	);

	// The owner's page keeps the room alive, and lets it end soon after the page goes away.
	useEffect(() => {
		if (!owner) return;
		const keepAlive = () => void beat(id).catch((e) => e instanceof Gone && setStatus("ended"));
		keepAlive();
		const timer = setInterval(keepAlive, BEAT_MS);
		const onHide = () => leave(id);
		const onShow = () => !document.hidden && keepAlive();
		addEventListener("pagehide", onHide);
		document.addEventListener("visibilitychange", onShow);
		return () => {
			clearInterval(timer);
			removeEventListener("pagehide", onHide);
			document.removeEventListener("visibilitychange", onShow);
		};
	}, [id, owner]);

	const send = useCallback(async () => {
		if (sending.current) return;
		sending.current = true;
		const sent = textRef.current;
		try {
			const r = await writeRoom(id, sent);
			ver.current = r.ver;
			if (textRef.current === sent) {
				dirty.current = false;
				setStatus("synced");
			}
		} catch (e) {
			if (e instanceof Gone) setStatus("ended");
			else setStatus("offline");
		} finally {
			sending.current = false;
			// Typed more while this was in flight: send that too.
			if (dirty.current && textRef.current !== sent) sendTimer.current = window.setTimeout(send, SEND_AFTER_MS);
		}
	}, [id]);

	const edit = (value: string) => {
		setText(value);
		textRef.current = value;
		dirty.current = true;
		lastActivity.current = Date.now();
		setStatus("saving");
		clearTimeout(sendTimer.current);
		sendTimer.current = window.setTimeout(send, SEND_AFTER_MS);
	};
	useEffect(() => () => clearTimeout(sendTimer.current), []);

	async function copy(value: string, what: string) {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(what);
			setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500);
		} catch {
			area.current?.select();
		}
	}

	const ended = useCallback(() => setStatus("ended"), []);

	/** Files dropped anywhere on the room, or pasted (unless it's text pasted into the text box). */
	const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");
	const drop = {
		onDragEnter(e: React.DragEvent) {
			if (!hasFiles(e)) return;
			e.preventDefault();
			dragDepth.current++;
			setDragging(true);
		},
		onDragOver(e: React.DragEvent) {
			if (hasFiles(e)) e.preventDefault();
		},
		onDragLeave(e: React.DragEvent) {
			if (!hasFiles(e)) return;
			dragDepth.current = Math.max(0, dragDepth.current - 1);
			if (dragDepth.current === 0) setDragging(false);
		},
		onDrop(e: React.DragEvent) {
			if (!hasFiles(e)) return;
			e.preventDefault();
			dragDepth.current = 0;
			setDragging(false);
			const files = [...e.dataTransfer.files];
			if (files.length && status !== "loading") filesPanel.current?.add(files);
		},
		onPaste(e: React.ClipboardEvent) {
			const files = [...e.clipboardData.files];
			if (!files.length || status === "loading") return;
			if (e.target === area.current && e.clipboardData.types.includes("text/plain")) return;
			e.preventDefault();
			filesPanel.current?.add(files);
		},
	};

	async function end() {
		if (!window.confirm("End this room for everyone? Its text and files are deleted.")) return;
		await endRoom(id).catch(() => {});
		onLeave();
	}

	const links = linksIn(text);
	const statusText: Record<Status, string> = {
		loading: "Connecting…",
		synced: "Synced",
		saving: "Saving…",
		offline: "Offline, retrying…",
		ended: "This room has ended",
	};

	if (status === "ended")
		return (
			<Card className={s.panel}>
				<div className={s.empty}>
					<p className={s.emptyTitle}>This room has ended</p>
					<p className={s.muted}>Its creator left, or it reached its 2-hour limit. The text and files are gone.</p>
					<Button icon="back" onClick={onLeave}>
						All rooms
					</Button>
				</div>
			</Card>
		);

	return (
		<Card className={s.panel}>
			<div className={s.roomBody} {...drop}>
				<div className={s.roomBar}>
					<button type="button" className={s.back} onClick={onLeave} aria-label="All rooms">
						<Icon name="back" size={16} />
					</button>
					<span className={s.roomName}>
						<span aria-hidden="true">{meta?.emoji ?? "💬"}</span> {meta?.name ?? "Room"}
						{owner && <span className={s.badge}>Yours</span>}
					</span>
					<span className={status === "offline" ? s.statusBad : s.status} role="status">
						{statusText[status]}
					</span>
				</div>

				<div className={s.columns}>
					<div className={s.textColumn}>
						<textarea
							ref={area}
							className={s.text}
							value={text}
							onChange={(e) => edit(e.target.value)}
							placeholder="Paste or type here. Every device in this room sees it within a second or two."
							aria-label="Shared text"
							spellCheck={false}
							disabled={status === "loading"}
						/>

						{links.length > 0 && (
							<ul className={s.links} aria-label="Links in the text">
								{links.map((url) => (
									<li key={url}>
										<a href={url} target="_blank" rel="noopener noreferrer" className={s.link}>
											{url}
										</a>
										<button
											type="button"
											className={s.linkCopy}
											onClick={() => copy(url, url)}
											aria-label={`Copy ${url}`}
										>
											<Icon name={copied === url ? "check" : "copy"} size={14} />
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
					<FilesPanel
						ref={filesPanel}
						room={id}
						fver={fver}
						disabled={status === "loading"}
						onGone={ended}
						dragging={dragging}
					/>
				</div>

				<div className={s.actions}>
					<Button icon={copied === "all" ? "check" : "copy"} onClick={() => copy(text, "all")} disabled={!text}>
						{copied === "all" ? "Copied" : "Copy text"}
					</Button>
					<Button variant="ghost" icon="x" onClick={() => edit("")} disabled={!text}>
						Clear
					</Button>
					{owner && (
						<Button variant="ghost" onClick={end} className={s.end}>
							End room
						</Button>
					)}
				</div>
				<p className={s.muted}>
					{owner
						? "You made this room. It stays open while this page is open, and ends a few seconds after you close it (or after 2 hours)."
						: `Anyone on this site can see and edit this room.${meta ? ` Opened ${ago(Date.now() - meta.created)}.` : ""}`}
				</p>
			</div>
		</Card>
	);
}

/** Replaces the text with someone else's, keeping this device's cursor where it was if it's typing here. */
function applyRemote(el: HTMLTextAreaElement | null, next: string, set: (t: string) => void) {
	const focused = el && document.activeElement === el;
	const start = el?.selectionStart ?? 0;
	const end = el?.selectionEnd ?? 0;
	set(next);
	if (focused && el)
		requestAnimationFrame(() => el.setSelectionRange(Math.min(start, next.length), Math.min(end, next.length)));
}
