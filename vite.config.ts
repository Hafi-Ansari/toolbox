import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Windows shells (e.g. VS Code's) can start with a lowercase drive letter ("c:\…"),
// which makes Vitest load two copies of itself. Normalize it before anything resolves.
if (process.platform === "win32" && /^[a-z]:/.test(process.cwd())) {
	process.chdir(process.cwd()[0].toUpperCase() + process.cwd().slice(1));
}

export default defineConfig({
	plugins: [react()],
	// MuPDF uses top-level await and loads its .wasm via new URL(..., import.meta.url).
	build: { target: "es2022", chunkSizeWarningLimit: 1200 },
	worker: { format: "es" },
	// Pre-bundling would rewrite MuPDF's wasm URL; serve it as-is in dev.
	optimizeDeps: { exclude: ["mupdf"] },
	test: { include: ["src/**/*.test.ts"] },
});
