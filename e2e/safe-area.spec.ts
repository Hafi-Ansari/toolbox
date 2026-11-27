// iPhone notch and home bar: index.html opts into viewport-fit=cover, so pages must keep their
// content inside env(safe-area-inset-*). Chromium can fake the insets through DevTools.
import { expect, type Page, test } from "@playwright/test";

const cases = [
	{ name: "portrait", width: 390, height: 844, insets: { top: 47, bottom: 34, left: 0, right: 0 } },
	{ name: "landscape", width: 844, height: 390, insets: { top: 0, bottom: 21, left: 47, right: 47 } },
];

async function phone(browser: import("@playwright/test").Browser, c: (typeof cases)[number]): Promise<Page> {
	const ctx = await browser.newContext({
		viewport: { width: c.width, height: c.height },
		isMobile: true,
		hasTouch: true,
	});
	const page = await ctx.newPage();
	const cdp = await ctx.newCDPSession(page);
	await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: c.insets } as never);
	return page;
}

for (const c of cases) {
	test(`${c.name}: the reader and the site stay clear of the notch and home bar`, async ({ browser }) => {
		const page = await phone(browser, c);
		await page.goto("/read");
		await page.locator('input[type="file"]').first().setInputFiles("out/sample.epub");
		await expect(page.locator("[class*=_stage_]")).toBeVisible({ timeout: 20_000 });
		const stage = await page.locator("[class*=_stage_]").boundingBox();
		expect(stage).toMatchObject({
			x: c.insets.left,
			y: c.insets.top,
			width: c.width - c.insets.left - c.insets.right,
			height: c.height - c.insets.top - c.insets.bottom,
		});

		await page.goto("/room");
		const main = await page.locator("main").boundingBox();
		expect(main?.x).toBe(Math.max(16, c.insets.left));
		expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
		await page.context().close();
	});
}
