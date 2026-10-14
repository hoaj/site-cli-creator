// Baseline: today's dependency set (zod + playwright-core), no MCP SDK, no Express.
// Built to measure the binary size the new deps add on top.
import { chromium } from "playwright-core";
import { z } from "zod";

const Args = z.tuple([z.string()]).rest(z.string());
const [cmd] = Args.parse(process.argv.slice(2).length ? process.argv.slice(2) : ["pw"]);
if (cmd === "pw") console.log(`playwright-core ok: chromium path ${chromium.executablePath()}`);
