import { defineConfig } from "@playwright/test";

// Headless only. Uses the installed Microsoft Edge, so no browser download is needed.
export default defineConfig({
	testDir: "e2e",
	timeout: 120_000,
	globalSetup: "./e2e/setup.ts",
	use: { baseURL: "http://localhost:4317", channel: "msedge", headless: true, acceptDownloads: true },
	webServer: {
		// Run Vite directly (not through npm) so stopping it releases the port.
		command: "node node_modules/vite/bin/vite.js preview --port 4317 --strictPort",
		url: "http://localhost:4317",
		reuseExistingServer: false,
		timeout: 60_000,
	},
});
