import { describe, expect, it } from "vitest";
import { CSP } from "./render.ts";

describe("chapter CSP", () => {
	// The frame's sandbox allows scripts (WebKit runs none of the reader's listeners otherwise),
	// so this policy is what keeps book code from running.
	it("allows no script and no network request", () => {
		const rules = new Map(
			CSP.split(";")
				.map((r) => r.trim().split(/\s+/) as [string, ...string[]])
				.map(([k, ...v]) => [k, v]),
		);
		expect(rules.get("script-src")).toEqual(["'none'"]);
		expect(rules.get("default-src")).toEqual(["'none'"]);
		for (const [, sources] of rules)
			for (const s of sources) expect(s).toMatch(/^(?:'none'|'unsafe-inline'|blob:|data:)$/);
		expect(rules.get("style-src")).not.toContain("'unsafe-eval'");
	});
});
