// Builds test fixtures (a sample EPUB and the PDF made from it) with the Node engine.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

export default function setup() {
	if (!fs.existsSync("out/sample.epub") || !fs.existsSync("out/sample.pdf")) {
		execFileSync(process.execPath, ["scripts/spike.ts"], { stdio: "ignore" });
	}
}
