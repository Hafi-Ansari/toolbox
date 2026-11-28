// Every piece of copy the UI shows for errors and outcomes (§4, §8.4, §10, §11, §12), plus the number
// formats. Pure functions, so they're unit tested without a browser.
import { tuning } from "./tuning.ts";
import type { BatchPhase, BatchProgress, FtErrorCode, IncomingOffer, PathType, ReceiveMode } from "./types.ts";

/** What the page shows of the transfers in this session. */
export interface Batches {
	/** An incoming manifest waiting for Accept/Decline. */
	offer: IncomingOffer | null;
	/** The latest batch in each direction (kept after it ends, for the done or error line). */
	send: BatchProgress | null;
	receive: BatchProgress | null;
}

export const isActive = (phase: BatchPhase) => phase === "offered" || phase === "running" || phase === "reconnecting";

export const SHORT_NAME = "File Transfer";

/** §11 and the page-level failures. `who` is the other person's name. */
export function errorText(code: FtErrorCode, who = "They"): string {
	switch (code) {
		case "declined":
			return `${who} declined.`;
		case "expired":
			return `${who} didn't answer.`;
		case "busy":
			return `${who} is in another transfer.`;
		case "gone":
			return `${who} isn't here right now.`;
		case "self":
			return "That's you. Open this page on the other device to connect.";
		case "failed-direct":
			return "Couldn't connect directly. One of you is probably on a network that blocks this, which is common on mobile data, work and school networks. Try another network, such as home Wi-Fi.";
		case "disabled":
			return `${SHORT_NAME} is paused right now.`;
		case "full":
			return `Too many people are on ${SHORT_NAME} right now. Try again in a few minutes.`;
		case "too-many-here":
			return `Too many devices from your network are here. Close ${SHORT_NAME} on one of them.`;
		case "slow-down":
		case "too-many":
			return "That was a lot of requests in a row. Wait a minute and try again.";
		case "lost":
			return "Connection lost.";
		case "protocol":
		case "flow-control":
			return "Something went wrong with the connection.";
		case "zip-unsupported":
			return "This browser stopped the download. Try Chrome, Edge or Firefox on a computer.";
		case "too-big":
			return `${who === "They" ? "This" : `${who}'s`} browser can't receive this much. Ask them to use Chrome, Edge or Firefox on a computer.`;
		case "sink-error":
			return "Couldn't save the files. The disk may be full, or permission to the folder was taken back.";
		default:
			// signal-error and every other server code
			return "Couldn't reach the server. Check your connection and try again.";
	}
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
export const filesText = (n: number) => plural(n, "file");

/** "38.4 GB" */
export function bytes(n: number): string {
	const v0 = Math.max(0, Math.round(n));
	if (v0 < 1024) return `${v0} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = v0 / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	// One decimal below 100 ("38.4 GB", §4.3); whole numbers above.
	return `${v < 100 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
/** "71.2 MB/s" */
export const rate = (bytesPerSecond: number) => `${bytes(bytesPerSecond)}/s`;

/** "9 min 12 s", "45 s", "1 h 5 min" */
export function duration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s} s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} min ${s % 60} s`;
	return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** "2 min left", "less than a minute left", "about 1 h 5 min left" */
export function eta(ms: number | null): string | null {
	if (ms === null || !Number.isFinite(ms)) return null;
	const s = Math.round(ms / 1000);
	if (s < 10) return "a few seconds left";
	if (s < 60) return `${s} s left`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min left`;
	return `${Math.floor(m / 60)} h ${m % 60} min left`;
}

/** "here now" / "seen 1 min ago" (§12). */
export function seen(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 30) return "here now";
	const m = Math.max(1, Math.round(s / 60));
	return m < 60 ? `seen ${m} min ago` : `seen ${Math.floor(m / 60)} h ago`;
}

/** "Direct · same network · 6 lanes" */
export function pathText(path: PathType | null, lanes: number): string {
	const parts = [path === "same-network" ? "Direct · same network" : "Direct"];
	if (lanes > 0) parts.push(plural(lanes, "lane"));
	return parts.join(" · ");
}

/** Whole-number percentage that only reads 100 when everything is persisted. */
export function percent(done: number, total: number): number {
	if (total <= 0) return done >= total ? 100 : 0;
	const p = Math.floor((done / total) * 100);
	return done >= total ? 100 : Math.min(99, p);
}

/** The done line on each side (§4.3, §4.4). */
export function doneText(p: BatchProgress, who: string): string {
	const took = (p.endedAt ?? Date.now()) - p.startedAt;
	if (p.side === "send") {
		const avg = took > 0 ? ` · avg ${rate((p.bytes / took) * 1000)}` : "";
		return `Sent ${filesText(p.files)} (${bytes(p.bytes)}) in ${duration(took)}${avg}`;
	}
	const saved = filesText(p.files - p.skipped);
	const skipped = p.skipped > 0 ? ` · ${p.skipped.toLocaleString("en-US")} already there were skipped` : "";
	if (p.mode === "folder") return `Saved ${saved} to ${p.location ?? "the folder"}${skipped}`;
	return `Saved ${saved} to your downloads as ${p.location ?? `Photos from ${who}.zip`}`;
}

/** How a batch that didn't finish ended, for each side. */
export function endedText(p: BatchProgress, who: string): string {
	switch (p.phase) {
		case "declined":
			if (p.side === "receive")
				return p.declineReason === "too-big"
					? `${who} is sending more than this browser can receive (${bytes(tuning.memoryMax)} at most), so it was declined. Use Chrome, Edge or Firefox on a computer.`
					: "You declined.";
			if (p.declineReason === "too-big") return errorText("too-big", who);
			if (p.declineReason === "unsupported") return `${who}'s browser can't receive files.`;
			return `${who} declined.`;
		case "cancelled":
			if (p.cancelledBy === (p.side === "send" ? "sender" : "receiver"))
				return p.side === "send" ? "You stopped sending." : "You stopped receiving.";
			return p.side === "send" ? `${who} stopped receiving.` : `${who} stopped sending.`;
		case "interrupted":
			if (p.side === "receive" && p.mode !== "folder")
				return "Connection lost. The download stopped partway. Send again to start a new one.";
			if (p.side === "send" && p.mode !== "folder")
				return `Connection lost. ${who}'s download stopped partway. Send again to start a new one.`;
			return "Connection lost. Send again to finish: files already saved are skipped.";
		case "failed":
			return errorText(p.error ?? "protocol", who);
		default:
			return "";
	}
}

export const modeText: Record<ReceiveMode, string> = {
	zip: "one .zip in your downloads",
	memory: "one .zip in your downloads",
	folder: "into a folder",
};
