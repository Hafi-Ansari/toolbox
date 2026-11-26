import { describe, expect, it } from "vitest";
import { readerCss } from "./readerCss.ts";
import { layered, relativeSizes, softenInline } from "./render.ts";
import { contrast, DEFAULT_SETTINGS, normalizeSettings } from "./settings.ts";

describe("layered", () => {
	it("wraps publisher CSS in the publisher layer", () => {
		const out = layered("p { color: #000 !important; }");
		expect(out).toMatch(/^\s*@layer publisher \{\n/);
		expect(out).toContain("p { color: #000 !important; }");
		expect(out.trimEnd().endsWith("}")).toBe(true);
	});

	it("hoists @namespace and drops @charset", () => {
		const out = layered('@charset "utf-8";\n@namespace epub "http://www.idpf.org/2007/ops";\np{}');
		expect(out.startsWith('@namespace epub "http://www.idpf.org/2007/ops";')).toBe(true);
		expect(out).not.toContain("@charset");
		expect(out.indexOf("@namespace")).toBeLessThan(out.indexOf("@layer"));
	});
});

describe("relativeSizes", () => {
	it("turns absolute font sizes into rem", () => {
		expect(relativeSizes("p { font-size: 12px }")).toBe("p { font-size: 0.75rem }");
		expect(relativeSizes("p{font-size:12pt}")).toBe("p{font-size:1rem}");
		expect(relativeSizes("small { font-size: small; }")).toBe("small { font-size: 0.8125rem; }");
	});

	it("leaves relative sizes and look-alike keywords alone", () => {
		for (const css of [
			"p { font-size: 1.2em }",
			"p { font-size: 90% }",
			"p { font-size: smaller }",
			"p { margin: 12px }",
		])
			expect(relativeSizes(css)).toBe(css);
	});
});

describe("softenInline", () => {
	it("drops !important from inline styles", () => {
		expect(softenInline("color: #000 !important; background: #fff ! important")).toBe("color: #000; background: #fff");
	});
});

describe("readerCss", () => {
	const g = { width: 700, height: 900, padX: 40, padY: 56 };

	it("lives in the reader layer and forces the chosen text color", () => {
		const css = readerCss({ ...DEFAULT_SETTINGS, textColor: "#ffcf87" }, g, false);
		expect(css.startsWith("@layer reader {")).toBe(true);
		expect(css).toContain("color: #ffcf87 !important");
	});

	it("keeps the book's colors when asked", () => {
		const css = readerCss({ ...DEFAULT_SETTINGS, colors: "original", textColor: "#ffcf87" }, g, false);
		expect(css).not.toContain("#ffcf87");
		expect(css).not.toContain("color: inherit !important");
	});

	it("adds stroke weight only when boldness is raised", () => {
		expect(readerCss(DEFAULT_SETTINGS, g, false)).not.toContain("text-stroke");
		expect(readerCss({ ...DEFAULT_SETTINGS, weight: 2 }, g, false)).toContain("-webkit-text-stroke: 0.034em");
	});
});

describe("normalizeSettings", () => {
	it("migrates older stored settings", () => {
		const s = normalizeSettings({ theme: "dark", lineHeight: "1.8", size: 99, font: "comic" });
		expect(s.theme).toBe("night");
		expect(s.lineHeight).toBe(1.8);
		expect(s.size).toBe(32);
		expect(s.font).toBe(DEFAULT_SETTINGS.font);
	});

	it("rejects malformed colors", () => {
		expect(normalizeSettings({ textColor: "red; background: url(x)" }).textColor).toBeNull();
		expect(normalizeSettings({ textColor: "#A1b2C3" }).textColor).toBe("#A1b2C3");
	});
});

describe("contrast", () => {
	it("computes WCAG ratios", () => {
		expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
		expect(contrast("#001e2b", "#000000")).toBeLessThan(1.5);
	});
});
