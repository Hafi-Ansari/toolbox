// Blazing Fast File Transfer: zip download streaming service worker (docs/file-transfer/SPEC.md §8.2).
// Plain JS, not bundled, served at /ft-sw.js with scope /file-transfer/dl/.
//
// The page posts { type: "open", id, name, length, port } (types.ts `SwOpen`), then points a hidden
// iframe at /file-transfer/dl/<id>/<name>. The fetch handler answers with a stream fed from the port,
// so the browser saves one download with no prompt. Flow control: the stream's pull() grants credit to
// the page with { want: bytes }; the page sends at most that much (ArrayBuffers, ownership transferred),
// then { type: "end" } or { type: "abort", reason }. The page pings every 10 s to keep this worker alive.

/** Bytes the stream buffers before the page has to wait. */
const HIGH_WATER = 4 * 1024 * 1024;
/** An opened download whose iframe never fetched it is forgotten after this. */
const OPEN_TTL_MS = 60_000;

/** id → { name, length, port, timer } */
const pending = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
	const msg = event.data;
	if (!msg || typeof msg !== "object") return;
	if (msg.type === "ping") return;
	if (msg.type !== "open") return;
	const port = msg.port || event.ports[0];
	if (typeof msg.id !== "string" || !/^[0-9a-f]{32}$/.test(msg.id) || !port) return;
	const length = Number.isSafeInteger(msg.length) && msg.length >= 0 ? msg.length : null;
	const timer = setTimeout(() => {
		pending.delete(msg.id);
		port.close();
	}, OPEN_TTL_MS);
	pending.set(msg.id, { name: String(msg.name || "download.zip"), length, port, timer });
});

/** Content-Disposition with an ASCII fallback and the UTF-8 name (RFC 6266 / 5987), as api/rooms.ts. */
function attachment(name) {
	const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%]/g, "_") || "download.zip";
	const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

function stream(id, entry) {
	const { port } = entry;
	let granted = 0; // credit given to the page and not yet used
	let wake = null; // resolves the pending pull()
	let done = false;
	const settle = () => {
		const w = wake;
		wake = null;
		w?.();
	};
	return new ReadableStream(
		{
			start(controller) {
				port.onmessage = (event) => {
					if (done) return;
					const data = event.data;
					if (data instanceof ArrayBuffer) {
						granted -= data.byteLength;
						if (data.byteLength) controller.enqueue(new Uint8Array(data));
					} else if (data && data.type === "end") {
						done = true;
						controller.close();
						port.close();
					} else if (data && data.type === "abort") {
						done = true;
						controller.error(new Error(String(data.reason || "aborted")));
						port.close();
					}
					settle();
				};
				port.postMessage({ type: "started", id });
			},
			pull(controller) {
				if (done) return;
				const want = (controller.desiredSize ?? 0) - granted;
				if (want > 0) {
					granted += want;
					port.postMessage({ want });
				}
				return new Promise((resolve) => {
					wake = resolve;
				});
			},
			cancel() {
				done = true;
				port.postMessage({ type: "cancelled", id });
				port.close();
				settle();
			},
		},
		new ByteLengthQueuingStrategy({ highWaterMark: HIGH_WATER }),
	);
}

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	const match = /^\/file-transfer\/dl\/([0-9a-f]{32})\//.exec(url.pathname);
	if (!match) return;
	const entry = pending.get(match[1]);
	if (!entry) {
		event.respondWith(new Response("This download has ended.", { status: 404, headers: { "Cache-Control": "no-store" } }));
		return;
	}
	pending.delete(match[1]);
	clearTimeout(entry.timer);
	const headers = {
		"Content-Type": "application/zip",
		"Content-Disposition": attachment(entry.name),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	};
	if (entry.length !== null) headers["Content-Length"] = String(entry.length);
	event.respondWith(new Response(stream(match[1], entry), { headers }));
});
