// The lobby (§4.1, §4.2, §12): who I am, everyone else on the page, invite links, and the incoming
// request panel. Tiles are copied from the Shared room's lobby (src/tools/room), as the spec asks.
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../lib/Icon.tsx";
import { Button, Card, Note } from "../../lib/ui.tsx";
import { errorText, seen } from "./copy.ts";
import { useNow } from "./hooks.ts";
import { cleanName, EMOJIS, randomProfile } from "./profile.ts";
import s from "./Send.module.css";
import { COPIED_MS, INVITE_PARAM, REQUEST_TIMEOUT_MS, TOOL_PATH } from "./tuning.ts";
import {
	type FtErrorCode,
	type IncomingRequest,
	isFtError,
	type PeerInfo,
	type PeerRef,
	type Presence,
	type PresenceSnapshot,
} from "./types.ts";

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

export const inviteUrl = (id: string) => `${location.origin}${TOOL_PATH}?${INVITE_PARAM}=${id}`;

function inviteTarget(): string | null {
	return new URLSearchParams(location.search).get(INVITE_PARAM);
}

function clearInvite() {
	const url = new URL(location.href);
	url.searchParams.delete(INVITE_PARAM);
	history.replaceState(history.state, "", url);
}

/** Copy button with "Copied" for 2 s (§12). Clipboard writes in a click need no permission. */
function CopyInvite({ id, variant = "ghost" }: { id: string; variant?: "primary" | "ghost" }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef(0);
	useEffect(() => () => clearTimeout(timer.current), []);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(inviteUrl(id));
			setCopied(true);
			clearTimeout(timer.current);
			timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
		} catch {
			// No clipboard (insecure context): show the link so it can be copied by hand.
			window.getSelection()?.selectAllChildren(document.getElementById(`invite-${id}`) ?? document.body);
		}
	};
	return (
		<>
			<Button variant={variant} icon={copied ? "check" : "copy"} onClick={copy}>
				{copied ? "Copied" : "Copy invite link"}
			</Button>
			<span id={`invite-${id}`} className={s.srOnly}>
				{inviteUrl(id)}
			</span>
		</>
	);
}

/* ---------- Me bar */

function MeBar({ presence, me }: { presence: Presence; me: PeerRef & { hidden: boolean } }) {
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(me.name);
	const [emoji, setEmoji] = useState(me.emoji);
	const input = useRef<HTMLInputElement>(null);
	const editButton = useRef<HTMLButtonElement>(null);
	const emojiGroup = useId();

	const start = () => {
		setName(me.name);
		setEmoji(me.emoji);
		setEditing(true);
	};
	useEffect(() => {
		if (editing) input.current?.select();
	}, [editing]);
	const finish = (save: boolean) => {
		if (save) {
			const clean = cleanName(name);
			if (clean) presence.setProfile({ name: clean, emoji });
		}
		setEditing(false);
		requestAnimationFrame(() => editButton.current?.focus());
	};
	const onKey = (e: KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			finish(true);
		} else if (e.key === "Escape") {
			e.preventDefault();
			finish(false);
		}
	};
	const shuffle = () => {
		const r = randomProfile();
		setName(r.name);
		setEmoji(r.emoji);
	};

	return (
		<div className={s.meBar}>
			{editing ? (
				// biome-ignore lint/a11y/noStaticElementInteractions: Enter/Escape for the whole editor; every control in it is focusable
				<div className={s.meEdit} onKeyDown={onKey}>
					<div className={s.meEditRow}>
						<span className={s.bigEmoji} aria-hidden="true">
							{emoji}
						</span>
						<input
							ref={input}
							className={s.nameInput}
							value={name}
							maxLength={40}
							onChange={(e) => setName(e.target.value)}
							aria-label="Your name"
							autoComplete="off"
							spellCheck={false}
						/>
						<Button onClick={() => finish(true)} disabled={!cleanName(name)}>
							Save
						</Button>
						<Button variant="ghost" onClick={() => finish(false)}>
							Cancel
						</Button>
					</div>
					<div className={s.emojiRow} role="radiogroup" aria-label="Your animal">
						{EMOJIS.map((e) => (
							<label key={e} className={cx(s.emojiChoice, e === emoji && s.emojiChosen)}>
								<input
									type="radio"
									name={emojiGroup}
									value={e}
									checked={e === emoji}
									onChange={() => setEmoji(e)}
									className={s.srOnly}
								/>
								<span aria-hidden="true">{e}</span>
								<span className={s.srOnly}>{e}</span>
							</label>
						))}
						<button type="button" className={s.textButton} onClick={shuffle}>
							Random name
						</button>
					</div>
				</div>
			) : (
				<div className={s.meWho}>
					<span className={s.bigEmoji} aria-hidden="true">
						{me.emoji}
					</span>
					<span className={s.meName}>
						You're <strong>{me.name}</strong>
					</span>
					<button ref={editButton} type="button" className={s.textButton} onClick={start}>
						Edit name
					</button>
				</div>
			)}
			<div className={s.meActions}>
				<button
					type="button"
					role="switch"
					aria-checked={!me.hidden}
					className={s.switch}
					onClick={() => presence.setProfile({ hidden: !me.hidden })}
				>
					<span className={s.switchTrack} aria-hidden="true">
						<span className={s.switchThumb} />
					</span>
					{me.hidden ? "Hidden" : "Visible"}
				</button>
				<CopyInvite id={me.id} />
			</div>
			{me.hidden && (
				<p className={cx(s.muted, s.meNote)}>Others can't see you. People with your invite link can still connect.</p>
			)}
		</div>
	);
}

/* ---------- Tiles */

function PeerTile({
	peer,
	now,
	asking,
	locked,
	onRequest,
	onCancel,
}: {
	peer: PeerInfo;
	now: number;
	asking: boolean;
	locked: boolean;
	onRequest: (p: PeerRef) => void;
	onCancel: () => void;
}) {
	const text = (
		<>
			<span className={s.emoji} aria-hidden="true">
				{peer.emoji}
			</span>
			<span className={s.tileText}>
				<span className={s.tileName}>
					<span className={s.ellipsis}>{peer.name}</span>
					{peer.near && <span className={s.badge}>Same network</span>}
				</span>
				<span className={s.muted}>
					{asking ? `Asking ${peer.name}…` : peer.busy ? "In a transfer" : seen(now - peer.seen)}
				</span>
			</span>
		</>
	);
	if (asking)
		return (
			<div className={cx(s.tile, s.tileAsking)} role="status">
				{text}
				<Button variant="ghost" className={s.tileCancel} onClick={onCancel}>
					Cancel
				</Button>
			</div>
		);
	const disabled = peer.busy || locked;
	return (
		<button
			type="button"
			className={cx(s.tile, peer.busy && s.tileBusy)}
			aria-disabled={disabled || undefined}
			aria-label={`${peer.name}${peer.near ? ", same network" : ""}${peer.busy ? ", in a transfer" : ""}`}
			onClick={() => !disabled && onRequest(peer)}
		>
			{text}
		</button>
	);
}

/* ---------- Lobby */

export function Lobby({ presence, snap }: { presence: Presence; snap: PresenceSnapshot }) {
	const now = useNow(15_000);
	const [invite, setInvite] = useState(inviteTarget);
	const [problem, setProblem] = useState<{ code: FtErrorCode; name: string } | null>(null);
	/** Names of people I asked, for messages after they've left the list. */
	const asked = useRef(new Map<string, string>());
	const { me, peers, outgoing, outcome, error, state } = snap;

	const request = async (peer: PeerRef | { id: string; name?: string }) => {
		setProblem(null);
		const name = peer.name ?? "They";
		asked.current.set(peer.id, name);
		try {
			await presence.request(peer.id);
		} catch (e) {
			setProblem({ code: isFtError(e) ? e.code : "signal-error", name });
		}
	};
	const pending = outgoing && outgoing.state === "pending" ? outgoing : null;
	const outcomeName = outcome
		? (peers.find((p) => p.id === outcome.to)?.name ?? asked.current.get(outcome.to) ?? "They")
		: "";

	if (state === "away")
		return (
			<Card className={s.panel}>
				<Note tone="info">You're hidden after 2 hours away.</Note>
				<div>
					<Button onClick={() => presence.wake()}>Be visible again</Button>
				</div>
			</Card>
		);

	const invitePeer = invite && me && invite !== me.id ? peers.find((p) => p.id === invite) : undefined;
	const listed = invitePeer ? peers.filter((p) => p.id !== invitePeer.id) : peers;
	const pendingStranger = pending && !peers.some((p) => p.id === pending.to) ? pending : null;

	return (
		<Card className={s.panel}>
			{me ? <MeBar presence={presence} me={me} /> : <p className={s.muted}>Getting you a name…</p>}
			{error && <Note tone="danger">{errorText(error)}</Note>}
			{outcome && <Note tone="info">{errorText(outcome.code, outcomeName)}</Note>}
			{problem && <Note tone="danger">{errorText(problem.code, problem.name)}</Note>}

			{invite && me && (
				<section className={s.invite} aria-label="Invite link">
					{invite === me.id ? (
						<p className={s.muted}>This is your own invite link. Open it on the other device to connect to you.</p>
					) : invitePeer ? (
						<>
							<div className={s.inviteWho}>
								<span className={s.bigEmoji} aria-hidden="true">
									{invitePeer.emoji}
								</span>
								<span className={s.tileText}>
									<span className={s.tileName}>
										{invitePeer.name}
										{invitePeer.near && <span className={s.badge}>Same network</span>}
									</span>
									<span className={s.muted}>
										{pending?.to === invitePeer.id
											? `Asking ${invitePeer.name}…`
											: invitePeer.busy
												? "In a transfer"
												: "Invited you to connect"}
									</span>
								</span>
							</div>
							{pending?.to === invitePeer.id ? (
								<Button variant="ghost" onClick={() => void presence.cancelRequest()}>
									Cancel
								</Button>
							) : (
								<Button onClick={() => request(invitePeer)} disabled={invitePeer.busy || !!pending}>
									Connect to {invitePeer.name}
								</Button>
							)}
						</>
					) : pendingStranger ? (
						<>
							<p role="status">Asking the person who shared this link…</p>
							<Button variant="ghost" onClick={() => void presence.cancelRequest()}>
								Cancel
							</Button>
						</>
					) : (
						<>
							<p>
								The person who shared this link isn't here right now.{" "}
								<span className={s.muted}>If they hid themselves, you can still try.</span>
							</p>
							<Button variant="ghost" onClick={() => request({ id: invite })} disabled={!!pending}>
								Try to connect
							</Button>
						</>
					)}
					<button
						type="button"
						className={s.iconButton}
						aria-label="Dismiss invite"
						onClick={() => {
							clearInvite();
							setInvite(null);
						}}
					>
						<Icon name="x" size={16} />
					</button>
				</section>
			)}

			{!me ? (
				<p className={s.muted}>Looking for people…</p>
			) : listed.length === 0 && !invitePeer ? (
				<div className={s.empty}>
					<p className={s.emptyTitle}>No one else is here yet</p>
					<p className={s.muted}>Open this page on the other device, or send someone your invite link.</p>
					<CopyInvite id={me.id} variant="primary" />
				</div>
			) : listed.length > 0 ? (
				<ul className={s.grid} aria-label="People on this page">
					{listed.map((p) => (
						<li key={p.id}>
							<PeerTile
								peer={p}
								now={now}
								asking={pending?.to === p.id}
								locked={!!pending}
								onRequest={request}
								onCancel={() => void presence.cancelRequest()}
							/>
						</li>
					))}
				</ul>
			) : null}
		</Card>
	);
}

/* ---------- Incoming request (§4.2 step 2, §12) */

export function IncomingPanel({ request, presence }: { request: IncomingRequest; presence: Presence }) {
	const ref = useRef<HTMLDivElement>(null);
	const [busy, setBusy] = useState(false);
	const [left, setLeft] = useState(() => Math.max(0, request.at + REQUEST_TIMEOUT_MS - Date.now()));
	const titleId = useId();
	const descId = useId();

	// Focus moves to the panel when it appears; back where it was when it goes.
	useEffect(() => {
		const before = document.activeElement as HTMLElement | null;
		ref.current?.querySelector<HTMLButtonElement>("[data-accept]")?.focus();
		return () => {
			if (before?.isConnected && document.activeElement === document.body) before.focus();
		};
	}, []);
	useEffect(() => {
		const t = setInterval(() => setLeft(Math.max(0, request.at + REQUEST_TIMEOUT_MS - Date.now())), 250);
		return () => clearInterval(t);
	}, [request.at]);

	const answer = async (accept: boolean) => {
		setBusy(true);
		try {
			await presence.respond(accept);
		} catch {
			setBusy(false);
		}
	};

	return (
		<div ref={ref} className={s.incoming} role="alertdialog" aria-labelledby={titleId} aria-describedby={descId}>
			<span className={s.bigEmoji} aria-hidden="true">
				{request.from.emoji}
			</span>
			<div className={s.incomingText}>
				<p id={titleId} className={s.incomingTitle}>
					<strong>{request.from.name}</strong> wants to connect
				</p>
				<p id={descId} className={s.muted}>
					You can then send files to each other. Nothing is saved until you accept a transfer.
				</p>
				<div className={s.countdown} aria-hidden="true">
					<div className={s.countdownBar} style={{ width: `${(left / REQUEST_TIMEOUT_MS) * 100}%` }} />
				</div>
			</div>
			<div className={s.incomingActions}>
				<Button data-accept="" onClick={() => answer(true)} disabled={busy}>
					Accept
				</Button>
				<Button variant="ghost" onClick={() => answer(false)} disabled={busy}>
					Decline
				</Button>
			</div>
		</div>
	);
}
