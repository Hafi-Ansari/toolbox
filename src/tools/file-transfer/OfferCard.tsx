// The receiver's offer card (§4.4, §12): what's coming, and how to save it. The default is one streamed
// .zip download with no browser prompt; a folder is opt-in, behind an in-page explanation (§8.3, §9).
import { useEffect, useRef, useState } from "react";
import { confirm } from "../../lib/confirm.tsx";
import { Button, Note } from "../../lib/ui.tsx";
import { bytes, errorText, filesText } from "./copy.ts";
import type { FtDeps } from "./deps.ts";
import s from "./Send.module.css";
import { tuning, zipName } from "./tuning.ts";
import { type IncomingOffer, isFtError, type PeerRef, type ReceiveSink, type TransferEngine } from "./types.ts";

const LIST_MAX = 200;

export function OfferCard({
	deps,
	offer,
	remote,
	engine,
	canFolder,
}: {
	deps: FtDeps;
	offer: IncomingOffer;
	remote: PeerRef;
	engine: TransferEngine;
	canFolder: boolean;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ref = useRef<HTMLElement>(null);
	const ctx = { peerName: remote.name, batch: offer.batch };
	const zip = deps.caps().zip;
	const tooBig = !zip && offer.total > tuning.memoryMax;

	// The memory fallback can't take this: decline at once and say why, on both sides (§8.4, §12).
	useEffect(() => {
		if (tooBig) engine.decline(offer.batch, "too-big");
	}, [tooBig, engine, offer.batch]);

	useEffect(() => {
		ref.current?.querySelector<HTMLButtonElement>("[data-accept]")?.focus();
	}, []);

	const start = async (pick: () => Promise<ReceiveSink | null>) => {
		setBusy(true);
		setError(null);
		try {
			const sink = deps.sinks.test(ctx) ?? (await pick());
			if (!sink) return setBusy(false);
			await engine.accept(offer.batch, sink);
		} catch (e) {
			if (isFtError(e) && e.code === "too-big") engine.decline(offer.batch, "too-big");
			else {
				setError(errorText(isFtError(e) ? e.code : "sink-error", remote.name));
				setBusy(false);
			}
		}
	};

	const acceptZip = () => start(() => (zip ? deps.sinks.zip(ctx, offer) : deps.sinks.memory(ctx)));

	const acceptFolder = async () => {
		const ok = await confirm({
			title: "Save into a folder",
			message: `Your browser will ask you to pick a folder, then ask permission to save files into it. File Transfer only writes the files ${remote.name} is sending.`,
			confirmLabel: "Continue",
			cancelLabel: "Back",
		});
		if (ok) await start(() => deps.sinks.folder(ctx));
	};

	if (tooBig) return null;

	const shown = offer.files.slice(0, LIST_MAX);
	return (
		<section ref={ref} className={s.offer} aria-labelledby={`offer-${offer.batch}`}>
			<h3 id={`offer-${offer.batch}`} className={s.offerTitle}>
				<span>
					<strong>{remote.name}</strong> is sending {filesText(offer.count)}
				</span>
				<span className={s.offerSize}>{bytes(offer.total)}</span>
			</h3>
			<details className={s.fileDetails}>
				<summary>Show files</summary>
				<ul className={s.fileList}>
					{shown.map((f) => (
						<li key={f.i}>
							<span className={s.ellipsis} title={f.path}>
								{f.path}
							</span>
							<span className={s.muted}>{bytes(f.size)}</span>
						</li>
					))}
				</ul>
				{offer.files.length > LIST_MAX && (
					<p className={s.muted}>and {filesText(offer.files.length - LIST_MAX)} more</p>
				)}
				{canFolder && (
					<p className={s.muted}>
						Saved into a folder, files are dated when they're saved: browsers can't keep the original dates. The dates
						inside photos are unchanged. The .zip keeps them.
					</p>
				)}
			</details>
			{error && <Note tone="danger">{error}</Note>}
			<div className={s.offerActions}>
				<div className={s.offerPrimary}>
					<Button data-accept="" icon="download" onClick={acceptZip} disabled={busy}>
						Accept
					</Button>
					<span className={s.muted}>Saves as one .zip in your downloads: {zipName(remote.name)}</span>
				</div>
				{canFolder && (
					<Button variant="ghost" icon="folder" onClick={acceptFolder} disabled={busy}>
						Save into a folder…
					</Button>
				)}
				<Button
					variant="ghost"
					onClick={() => engine.decline(offer.batch, "declined")}
					disabled={busy}
					className={s.decline}
				>
					Decline
				</Button>
			</div>
		</section>
	);
}
