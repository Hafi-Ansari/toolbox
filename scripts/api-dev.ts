// Serves the Vercel Functions in api/ from Vite's dev and preview servers, so `npx vite` and the
// e2e run (vite preview) answer /api/rooms and /api/file-transfer like production. Without Upstash
// credentials in the environment, the handlers use their in-memory stores.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin } from "vite";
import * as fileTransfer from "../api/file-transfer.ts";
import { GET, POST, PUT } from "../api/rooms.ts";

const handlers: Record<string, (r: Request) => Promise<Response>> = { GET, POST, PUT };
const ftHandlers: Record<string, (r: Request) => Promise<Response>> = {
	GET: fileTransfer.GET,
	POST: fileTransfer.POST,
};

async function toRequest(req: IncomingMessage & { originalUrl?: string }): Promise<Request> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	const body = chunks.length ? Buffer.concat(chunks) : undefined;
	const headers = new Headers();
	for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
	const method = req.method ?? "GET";
	return new Request(`http://${req.headers.host ?? "localhost"}${req.originalUrl ?? req.url}`, {
		method,
		headers,
		body: method === "GET" || method === "HEAD" ? undefined : body,
	});
}

const middleware: Connect.NextHandleFunction = (req, res: ServerResponse, next) => {
	const ft = (req as { originalUrl?: string }).originalUrl?.startsWith("/api/file-transfer");
	const handler = (ft ? ftHandlers : handlers)[req.method ?? ""];
	if (!handler) return next();
	void (async () => {
		const response = await handler(await toRequest(req as IncomingMessage & { originalUrl?: string }));
		res.statusCode = response.status;
		for (const [k, v] of response.headers) res.setHeader(k, v);
		res.end(Buffer.from(await response.arrayBuffer()));
	})().catch(next);
};

export function apiDev(): Plugin {
	return {
		name: "toolbox-api-dev",
		configureServer: (server) => {
			server.middlewares.use("/api/rooms", middleware);
			server.middlewares.use("/api/file-transfer", middleware);
		},
		configurePreviewServer: (server) => {
			server.middlewares.use("/api/rooms", middleware);
			server.middlewares.use("/api/file-transfer", middleware);
		},
	};
}
