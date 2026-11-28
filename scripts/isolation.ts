// Cross-origin isolation for the tools that need it (multithreaded WASM needs SharedArrayBuffer),
// on Vite's dev and preview servers. vercel.json sets the same headers in production; keep the two
// in step. Isolation is scoped: only these documents, and only the worker scripts they start, get
// the headers, so no other tool runs isolated.
import type { Connect, Plugin } from "vite";

/** Documents served isolated (the SPA route of each isolated tool in src/tools/registry.ts). */
const ISOLATED_PAGES = /^\/transcribe(\/|$|\?)/;
/** Worker scripts those pages start: the transcribe worker and onnxruntime's thread script. */
const ISOLATED_WORKERS = /transcribe\.worker|ort-wasm-/;

const middleware: Connect.NextHandleFunction = (req, res, next) => {
	const url = (req as { originalUrl?: string }).originalUrl ?? req.url ?? "";
	if (ISOLATED_PAGES.test(url)) {
		res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
		res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	} else if (ISOLATED_WORKERS.test(url)) {
		res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	}
	next();
};

export function isolation(): Plugin {
	return {
		name: "toolbox-isolation",
		configureServer(server) {
			server.middlewares.use(middleware);
		},
		configurePreviewServer(server) {
			server.middlewares.use(middleware);
		},
	};
}
