import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const page_url = "file:///Users/andrjo/Documents/projects/hobby/skills/.claude/worktrees/split-repos/.claude/plugins-build/site/dist/index.html";
const out = "/Users/andrjo/.claude/jobs/4b4f9221/tmp";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
for (const width of [1280, 375]) {
  for (const scheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto(page_url);
    await page.waitForTimeout(600);
    if (process.argv[2] === "open") await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
    const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    console.log(width, scheme, w);
    if (width === 375 && w[0] !== w[1]) throw new Error("horizontal scroll at 375");
    await page.screenshot({ path: `${out}/v2-${width}-${scheme}${process.argv[2] === "open" ? "-open" : ""}.png`, fullPage: true });
    await ctx.close();
  }
}
await browser.close();
