import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { apiDev } from "./scripts/api-dev.ts";
import { isolation } from "./scripts/isolation.ts";


export default defineConfig({
	// apiDev: /api/rooms (a Vercel Function in production) on the dev and preview servers.
	// isolation: COOP/COEP for /transcribe and its workers, as vercel.json sets them in production.
	plugins: [react(), apiDev(), isolation()],
	// MuPDF uses top-level await and loads its .wasm via new URL(..., import.meta.url).
	build: { target: "es2022", chunkSizeWarningLimit: 1200 },
	worker: { format: "es" },
	// Pre-bundling would rewrite MuPDF's wasm URL; serve it as-is in dev.
	optimizeDeps: { exclude: ["mupdf"] },
	// Run tests with `npm test` (scripts/test.ts), which fixes Windows drive-letter casing.
	test: { include: ["src/**/*.test.ts"] },
});
