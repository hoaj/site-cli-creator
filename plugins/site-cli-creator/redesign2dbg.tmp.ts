import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
await page.goto("file:///Users/andrjo/Documents/projects/hobby/skills/.claude/worktrees/split-repos/.claude/plugins-build/site/dist/index.html");
await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
console.log(await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > 376).map((e) => e.tagName + "." + e.className + " " + Math.round(e.getBoundingClientRect().right)).slice(0, 15)));
await browser.close();
