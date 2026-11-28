// One batch, either way (§4.3, §4.4, §12): waiting for accept, progress (at most 4 renders a second,
// screen readers told at most every 5 s), then done or how it ended.
import { useState } from "react";
import { confirm } from "../../lib/confirm.tsx";
import { Button, Note, Progress } from "../../lib/ui.tsx";
import { bytes, doneText, endedText, eta, filesText, pathText, percent, rate } from "./copy.ts";
import { useThrottled } from "./hooks.ts";
import s from "./Send.module.css";
import { ARIA_LIVE_MIN_MS, CURRENT_FILES_SHOWN, PROGRESS_MIN_MS } from "./tuning.ts";
import type { BatchProgress, PathType, PeerRef } from "./types.ts";

export function ProgressView({
	progress,
	remote,
	path,
	onCancel,
	onSendAgain,
}: {
	progress: BatchProgress;
	remote: PeerRef;
	path: PathType | null;
	onCancel: () => void;
	onSendAgain?: () => void;
}) {
	// Phase changes show at once; byte counts at most every 250 ms, whatever the engine sends.
	const p = useThrottled(progress, PROGRESS_MIN_MS, (a, b) => a.phase !== b.phase || a.batch !== b.batch);
	const [stopping, setStopping] = useState(false);
	const sending = p.side === "send";
	const pct = percent(p.bytesDone, p.bytes);
	const left = eta(p.etaMs);
	const live = useThrottled(
		p.phase === "running" ? `${pct}% ${sending ? "sent" : "received"}${left ? `, ${left}` : ""}` : "",
		ARIA_LIVE_MIN_MS,
	);

	const cancel = async () => {
		if (p.phase === "offered") return onCancel();
		setStopping(true);
		const ok = await confirm({
			title: sending ? `Stop sending to ${remote.name}?` : `Stop receiving from ${remote.name}?`,
			message: sending
				? `${remote.name} keeps the files that have already arrived.`
				: "Files that haven't finished are not saved.",
			confirmLabel: "Stop",
			tone: "danger",
		});
		setStopping(false);
		if (ok) onCancel();
	};

	if (p.phase === "offered")
		return sending ? (
			<div className={s.batch} role="status">
				<p className={s.waiting}>
					<span className={s.spinner} aria-hidden="true" />
					Waiting for {remote.name} to accept {filesText(p.files)} ({bytes(p.bytes)})…
				</p>
				<div>
					<Button variant="ghost" onClick={cancel}>
						Cancel
					</Button>
				</div>
			</div>
		) : null;

	if (p.phase === "done")
		return (
			<div className={s.batch}>
				<Note tone="success">{doneText(p, remote.name)}</Note>
			</div>
		);

	if (p.phase !== "running" && p.phase !== "reconnecting")
		return (
			<div className={s.batch}>
				<Note tone={p.phase === "cancelled" && p.cancelledBy === (sending ? "sender" : "receiver") ? "info" : "danger"}>
					{endedText(p, remote.name)}
				</Note>
				{onSendAgain && (
					<div>
						<Button icon="upload" onClick={onSendAgain}>
							Send again
						</Button>
					</div>
				)}
			</div>
		);

	const where =
		p.mode === "folder"
			? sending
				? "into a folder"
				: "into your folder"
			: sending
				? "as one .zip"
				: "as one .zip in your downloads";
	const speed = p.phase === "reconnecting" ? "Reconnecting…" : [rate(p.rate), left].filter(Boolean).join(" · ");

	return (
		<section className={s.batch} aria-label={sending ? `Sending to ${remote.name}` : `Receiving from ${remote.name}`}>
			<div className={s.batchHead}>
				<span className={s.percent}>{pct}%</span>
				<span className={s.batchWho}>
					<strong>{sending ? `Sending to ${remote.name}` : `Receiving from ${remote.name}`}</strong>
					<span className={s.muted}>
						{where} · {pathText(path, p.lanes)}
					</span>
				</span>
			</div>
			<Progress value={p.bytesDone} max={p.bytes} label={`${bytes(p.bytesDone)} of ${bytes(p.bytes)}`} detail={speed} />
			<div className={s.batchFoot}>
				<span>
					{p.filesDone.toLocaleString("en-US")} of {filesText(p.files)}
					{p.skipped > 0 && <span className={s.muted}> · {p.skipped.toLocaleString("en-US")} already there</span>}
				</span>
				<Button variant="ghost" onClick={cancel} disabled={stopping}>
					Cancel
				</Button>
			</div>
			{p.current.length > 0 && (
				<ul className={s.current} aria-label="Files in progress">
					{p.current.slice(0, CURRENT_FILES_SHOWN).map((name) => (
						<li key={name} className={s.ellipsis}>
							{name}
						</li>
					))}
				</ul>
			)}
			<p className={s.srOnly} aria-live="polite">
				{live}
			</p>
		</section>
	);
}
