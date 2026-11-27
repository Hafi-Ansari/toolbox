// Files in a room, from the browser: chunked upload and download through /api/rooms, with each
// chunk's SHA-256 checked on the way up (by the server) and down (here), and the whole file's
// SHA-256 checked here after reassembly. XHR rather than fetch, for upload progress.

const API = "/api/rooms";

export interface RoomFile {
	id: string;
	name: string;
	size: number;
	chunks: number;
	hashes: string[];
	sha256: string;
	/** Upload start, or when it finished once done. */
	at: number;
	done: boolean;
	got: number;
}

export interface FileList {
	files: RoomFile[];
	used: number;
	limit: number;
	maxFile: number;
	maxFiles: number;
}

/** Limits the server also enforces; checked here first to fail fast. Keep in step with api/rooms.ts. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export class FileProblem extends Error {
	code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

const MESSAGES: Record<string, string> = {
	"too-big": "is over the 20 MB limit per file.",
	empty: "is empty: there's nothing to send.",
	"bad-name": "needs a file name.",
	"room-full": "doesn't fit: this room's files are limited to 40 MB together. Delete some first.",
	"too-many": "doesn't fit: a room holds at most 20 files. Delete some first.",
	"site-full": "can't be stored right now: all rooms together are at the site's file limit. Try again later.",
	"slow-down": "is going too fast for the server. Wait a minute and try again.",
	gone: "couldn't be stored: the room has ended.",
	"no-file": "is gone: someone deleted it, or the room ended.",
	expired: "took too long to upload (15 minutes at most). Try again.",
	"bad-hash": "arrived damaged. Try again.",
	corrupt: "arrived damaged (its checksum doesn't match). Try again.",
	network: "couldn't be sent: the connection dropped. Try again.",
	"no-crypto": "can't be checked in this browser (it needs a secure https page).",
};

export const describeProblem = (name: string, e: unknown) =>
	`“${name}” ${MESSAGES[e instanceof FileProblem ? e.code : ""] ?? "failed. Try again."}`;

async function sha256(data: BufferSource): Promise<string> {
	if (!crypto.subtle) throw new FileProblem("no-crypto");
	const d = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function jsonCall<T>(method: string, query: string, body?: unknown): Promise<T> {
	let res: Response;
	try {
		res = await fetch(`${API}${query}`, {
			method,
			headers: body === undefined ? undefined : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			cache: "no-store",
		});
	} catch {
		throw new FileProblem("network");
	}
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw new FileProblem(json.error ?? `http-${res.status}`);
	return json as T;
}

/** The room's files, or null once the room has ended. */
export async function listFiles(room: string): Promise<FileList | null> {
	const r = await jsonCall<FileList | { gone: true }>("GET", `?id=${room}&files=1`);
	return "gone" in r ? null : r;
}

export const deleteFile = (room: string, file: string) =>
	jsonCall("POST", `?id=${room}`, { action: "file-delete", file });

interface Xhr {
	status: number;
	response: unknown;
}

/** One XHR, as a promise; `onProgress` gets the bytes moved so far within this request. */
function xhr(
	method: string,
	url: string,
	body: Blob | null,
	type: XMLHttpRequestResponseType,
	onProgress: (loaded: number) => void,
	signal: AbortSignal,
): Promise<Xhr> {
	return new Promise((resolve, reject) => {
		const req = new XMLHttpRequest();
		req.open(method, url);
		req.responseType = type;
		const progress = (e: ProgressEvent) => onProgress(e.loaded);
		if (body) req.upload.onprogress = progress;
		else req.onprogress = progress;
		req.onload = () => resolve({ status: req.status, response: req.response });
		req.onerror = () => reject(new FileProblem("network"));
		req.onabort = () => reject(new DOMException("Aborted", "AbortError"));
		signal.addEventListener("abort", () => req.abort(), { once: true });
		if (body) req.setRequestHeader("content-type", "application/octet-stream");
		req.send(body);
	});
}

/** Retries a chunk transfer after a dropped connection, a busy server or a damaged chunk. */
async function withRetry<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await run();
		} catch (e) {
			const retriable = e instanceof FileProblem && ["network", "server", "corrupt", "bad-hash"].includes(e.code);
			if (!retriable || attempt >= 3 || signal.aborted) throw e;
			await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
		}
	}
}

const problemFrom = (r: Xhr) => {
	if (r.status >= 500 && r.status !== 507) return new FileProblem("server");
	let code = `http-${r.status}`;
	try {
		const body = typeof r.response === "string" ? r.response : new TextDecoder().decode(r.response as ArrayBuffer);
		code = JSON.parse(body).error ?? code;
	} catch {
		// Not JSON: keep the status.
	}
	return new FileProblem(code);
};

/** Uploads `file` in chunks. `onProgress` gets the bytes sent so far. */
export async function uploadFile(
	room: string,
	file: File,
	onProgress: (sent: number) => void,
	signal: AbortSignal,
): Promise<void> {
	if (file.size > MAX_FILE_BYTES) throw new FileProblem("too-big");
	if (file.size === 0) throw new FileProblem("empty");
	const data = new Uint8Array(await file.arrayBuffer());
	const chunk = 2 * 1024 * 1024;
	const parts: Uint8Array[] = [];
	for (let i = 0; i < data.length; i += chunk) parts.push(data.subarray(i, i + chunk));
	const hashes = await Promise.all(parts.map((p) => sha256(p as Uint8Array<ArrayBuffer>)));
	const started = await jsonCall<{ file: string; chunk: number }>("POST", `?id=${room}`, {
		action: "file-start",
		name: file.name,
		size: data.length,
		hashes,
		sha256: await sha256(data),
	});
	if (started.chunk !== chunk) throw new FileProblem("server");
	let sent = 0;
	for (let n = 0; n < parts.length; n++) {
		const url = `${API}?id=${room}&file=${started.file}&chunk=${n}`;
		const body = new Blob([parts[n] as Uint8Array<ArrayBuffer>]);
		await withRetry(async () => {
			const r = await xhr("PUT", url, body, "text", (loaded) => onProgress(sent + loaded), signal);
			if (r.status !== 200) throw problemFrom(r);
		}, signal);
		sent += parts[n].length;
		onProgress(sent);
	}
}

/** Downloads a finished file, checking every chunk and the whole file against their SHA-256. */
export async function downloadFile(
	room: string,
	f: RoomFile,
	onProgress: (got: number) => void,
	signal: AbortSignal,
): Promise<Blob> {
	const parts: ArrayBuffer[] = [];
	let got = 0;
	for (let n = 0; n < f.chunks; n++) {
		const url = `${API}?id=${room}&file=${f.id}&chunk=${n}`;
		const part = await withRetry(async () => {
			const r = await xhr("GET", url, null, "arraybuffer", (loaded) => onProgress(got + loaded), signal);
			if (r.status !== 200) throw problemFrom(r);
			const buf = r.response as ArrayBuffer;
			if ((await sha256(buf)) !== f.hashes[n]) throw new FileProblem("corrupt");
			return buf;
		}, signal);
		parts.push(part);
		got += part.byteLength;
		onProgress(got);
	}
	const blob = new Blob(parts, { type: "application/octet-stream" });
	if (blob.size !== f.size || (await sha256(await blob.arrayBuffer())) !== f.sha256) throw new FileProblem("corrupt");
	return blob;
}

/** Hands a downloaded file to the browser (iOS Safari shows its download sheet for this too). */
export function saveBlob(blob: Blob, name: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function formatBytes(n: number): string {
	if (n < 1000) return `${n} B`;
	if (n < 1000 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
	return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}
