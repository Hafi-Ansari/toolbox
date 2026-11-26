import { defineConfig } from "@playwright/test";

// Headless only. Uses the installed Microsoft Edge, so no browser download is needed.
// Agents working in parallel worktrees each pick their own E2E_PORT.
const port = Number(process.env.E2E_PORT) || 4317;

export default defineConfig({
	testDir: "e2e",
	timeout: 120_000,
	globalSetup: "./e2e/setup.ts",
	use: { baseURL: `http://localhost:${port}`, channel: "msedge", headless: true, acceptDownloads: true },
	webServer: {
		// Run Vite directly (not through npm) so stopping it releases the port.
		command: `node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`,
		url: `http://localhost:${port}`,
		reuseExistingServer: false,
		timeout: 60_000,
	},
});
