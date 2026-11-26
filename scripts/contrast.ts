// Checks WCAG contrast for every text/background pair the UI uses. Run: node scripts/contrast.ts
import fs from "node:fs";

const css = fs.readFileSync(new URL("../src/app/tokens.css", import.meta.url), "utf8");
const tokens = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));

const lum = (hex: string) => {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
};

// [foreground, background, minimum] — 4.5 for body text, 3 for large text and UI marks.
const pairs: [string, string, number][] = [
	["text", "bg", 4.5],
	["text", "surface", 4.5],
	["text", "surface-2", 4.5],
	["text-muted", "bg", 4.5],
	["text-muted", "surface", 4.5],
	["accent-ink", "accent", 4.5],
	["accent-ink", "accent-soft", 4.5],
	["text", "accent-deep", 4.5],
	["accent", "accent-ink", 4.5],
	["accent-soft", "bg", 4.5],
	["accent", "surface", 3],
	["border-strong", "surface", 1.5],
];

let failed = 0;
for (const [fg, bg, min] of pairs) {
	const r = ratio(tokens[fg], tokens[bg]);
	const ok = r >= min;
	if (!ok) failed++;
	console.log(`${ok ? "pass" : "FAIL"}  ${r.toFixed(2).padStart(5)}:1  (min ${min})  --${fg} on --${bg}`);
}
process.exit(failed ? 1 : 0);
