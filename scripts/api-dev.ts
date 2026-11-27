// Serves the Vercel Functions in api/ from Vite's dev and preview servers, so `npx vite` and the
// e2e run (vite preview) answer /api/rooms like production. Without Upstash credentials in the
// environment, the rooms handler uses its in-memory store.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin } from "vite";
import { GET, POST, PUT } from "../api/rooms.ts";

const handlers: Record<string, (r: Request) => Promise<Response>> = { GET, POST, PUT };

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
	const handler = handlers[req.method ?? ""];
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
		configureServer: (server) => void server.middlewares.use("/api/rooms", middleware),
		configurePreviewServer: (server) => void server.middlewares.use("/api/rooms", middleware),
	};
}
