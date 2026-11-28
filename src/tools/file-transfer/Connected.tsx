// The connected panel (§4.3, §4.4, §12): who I'm connected to and how, a drop zone that takes files and
// folders anywhere on the panel, the offer card for incoming files, and progress both ways.
import { type DragEvent, type RefObject, useEffect, useRef, useState } from "react";
import { confirm } from "../../lib/confirm.tsx";
import { Icon } from "../../lib/Icon.tsx";
import { Button, Card, Note } from "../../lib/ui.tsx";
import { type Batches, isActive, pathText } from "./copy.ts";
import type { FtDeps } from "./deps.ts";
import { OfferCard } from "./OfferCard.tsx";
import { ProgressView } from "./ProgressView.tsx";
import s from "./Send.module.css";
import type { PathType, PeerRef, PeerSession, SendFile, TransferEngine } from "./types.ts";

const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

export function Connected({
	deps,
	remote,
	session,
	engine,
	batches,
	lastSend,
	onDisconnect,
}: {
	deps: FtDeps;
	remote: PeerRef;
	session: PeerSession;
	engine: TransferEngine;
	batches: Batches;
	lastSend: RefObject<{ remote: string; files: SendFile[] } | null>;
	onDisconnect: () => void;
}) {
	const [path, setPath] = useState<PathType | null>(null);
	const [lanes, setLanes] = useState(() => session.lanes().length);
	const [reconnecting, setReconnecting] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const depth = useRef(0);
	const input = useRef<HTMLInputElement>(null);
	const folderInput = useRef<HTMLInputElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const caps = deps.caps();

	useEffect(() => {
		heading.current?.focus();
	}, []);

	useEffect(
		() =>
			session.on((e) => {
				if (e.type === "path") setPath(e.path);
				else if (e.type === "lane-open" || e.type === "lane-lost") setLanes(session.lanes().length);
				else if (e.type === "reconnecting") setReconnecting(true);
				else if (e.type === "reconnected") setReconnecting(false);
			}),
		[session],
	);

	const sending = !!batches.send && isActive(batches.send.phase);
	const running = [batches.send, batches.receive].some((b) => b?.phase === "running" || b?.phase === "reconnecting");

	const send = (files: SendFile[]) => {
		setNotice(null);
		if (!files.length) return setNotice("Nothing to send: that folder is empty.");
		if (sending) return setNotice(`Wait until ${remote.name} has the current files, then add more.`);
		try {
			engine.send(files);
			lastSend.current = { remote: remote.id, files };
		} catch {
			setNotice(`Wait until ${remote.name} has the current files, then add more.`);
		}
	};

	const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
	const drop = {
		onDragEnter(e: DragEvent) {
			if (!hasFiles(e)) return;
			e.preventDefault();
			depth.current++;
			setDragging(true);
		},
		onDragOver(e: DragEvent) {
			if (!hasFiles(e)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
		},
		onDragLeave(e: DragEvent) {
			if (!hasFiles(e)) return;
			depth.current = Math.max(0, depth.current - 1);
			if (depth.current === 0) setDragging(false);
		},
		onDrop(e: DragEvent) {
			if (!hasFiles(e)) return;
			e.preventDefault();
			depth.current = 0;
			setDragging(false);
			// Read the items now: the list expires once this handler returns.
			deps.collect.fromDrop(e.dataTransfer).then(send, () => setNotice("Couldn't read those files."));
		},
	};

	/** Touch devices have no drag and drop: a folder comes in through `webkitdirectory`, which prompts (§9). */
	const chooseFolder = async () => {
		const ok = await confirm({
			title: "Choose a folder",
			message:
				"Your browser will ask you to confirm sending the folder's files to this page. They go only to the person you're connected to.",
			confirmLabel: "Continue",
			cancelLabel: "Back",
		});
		if (ok) folderInput.current?.click();
	};

	const resend =
		batches.send?.phase === "interrupted" && lastSend.current?.remote === remote.id ? lastSend.current.files : null;

	return (
		<>
			{running && (
				<Note tone="info">Keep this tab open until the transfer finishes. Closing it stops the transfer.</Note>
			)}
			<Card className={cx(s.panel, dragging && s.panelDragging)}>
				<div className={s.connectedBody} {...drop}>
					<div className={s.connectedBar}>
						<span className={s.bigEmoji} aria-hidden="true">
							{remote.emoji}
						</span>
						<h2 ref={heading} tabIndex={-1} className={s.connectedTitle}>
							<span>Connected to {remote.name}</span>
							<span className={s.connectedPath} role="status">
								{reconnecting ? "Reconnecting…" : pathText(path, lanes)}
							</span>
						</h2>
						<Button variant="ghost" onClick={onDisconnect} className={s.disconnect}>
							Disconnect
						</Button>
					</div>

					<div className={cx(s.dropZone, dragging && s.dropZoneActive)}>
						<span className={s.dropIcon} aria-hidden="true">
							<Icon name="upload" size={24} />
						</span>
						<span className={s.dropTitle}>
							{dragging ? `Release to send to ${remote.name}` : "Drop photos, videos or folders here"}
						</span>
						<span className={s.dropButtons}>
							<Button icon="upload" onClick={() => input.current?.click()} className={s.chooseButton}>
								Choose files
							</Button>
							{caps.touch && (
								<Button variant="ghost" icon="folder" onClick={chooseFolder}>
									Choose folder
								</Button>
							)}
						</span>
						<span className={s.dropHint}>
							{caps.touch
								? `${remote.name} accepts before anything is sent.`
								: `Any size, any number of files. ${remote.name} accepts before anything is sent.`}
						</span>
						<input
							ref={input}
							type="file"
							multiple
							className={s.srOnly}
							tabIndex={-1}
							aria-hidden="true"
							onChange={(e) => {
								const list = e.currentTarget.files;
								if (list?.length) send(deps.collect.fromInput(list));
								e.currentTarget.value = "";
							}}
						/>
						{caps.touch && (
							<input
								ref={folderInput}
								type="file"
								multiple
								className={s.srOnly}
								tabIndex={-1}
								aria-hidden="true"
								{...{ webkitdirectory: "" }}
								onChange={(e) => {
									const list = e.currentTarget.files;
									if (list?.length) send(deps.collect.fromInput(list));
									e.currentTarget.value = "";
								}}
							/>
						)}
					</div>
					{notice && <Note tone="info">{notice}</Note>}

					{batches.offer && (
						<OfferCard
							key={batches.offer.batch}
							deps={deps}
							offer={batches.offer}
							remote={remote}
							engine={engine}
							canFolder={caps.folder}
						/>
					)}
					{batches.receive && batches.receive.phase !== "offered" && (
						<ProgressView
							progress={batches.receive}
							remote={remote}
							path={path}
							onCancel={() => engine.cancel("receive", batches.receive?.batch ?? 0)}
						/>
					)}
					{batches.send && (
						<ProgressView
							progress={batches.send}
							remote={remote}
							path={path}
							onCancel={() => engine.cancel("send", batches.send?.batch ?? 0)}
							onSendAgain={resend ? () => send(resend) : undefined}
						/>
					)}
				</div>
			</Card>
		</>
	);
}
