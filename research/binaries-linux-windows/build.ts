// Usage: bun build.ts <bun-target> <outfile>
import type { BunPlugin } from "bun";

const [target, outfile] = process.argv.slice(2);
if (!target || !outfile) throw new Error("usage: bun build.ts <target> <outfile>");

const playwrightStaticRequires: BunPlugin = {
  name: "playwright-core-static-requires",
  setup(build) {
    build.onLoad({ filter: /playwright-core[\\/]lib[\\/]coreBundle\.js$/ }, async ({ path }) => {
      const src = await Bun.file(path).text();
      const re = /require\(import_path\d+\.default\.join\(packageRoot, "(package|browsers)\.json"\)\)/g;
      const hits = src.match(re)?.length ?? 0;
      if (hits !== 2) throw new Error(`expected 2 patch sites, found ${hits}`);
      return { contents: src.replace(re, 'require("../$1.json")'), loader: "js" };
    });
  },
};

const result = await Bun.build({
  entrypoints: ["./main.ts"],
  compile: { target: target as any, outfile },
  external: ["chromium-bidi", "electron"],
  plugins: [playwrightStaticRequires],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${outfile} for ${target}`);
