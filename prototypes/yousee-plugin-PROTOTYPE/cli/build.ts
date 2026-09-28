// FIXED TEMPLATE FILE. PROTOTYPE — not run (needs Bun >= 1.4).
// Patch from research/playwright-bun-compile: make playwright-core's package.json /
// browsers.json requires static, or the binary only runs on the build machine.
import type { BunPlugin } from "bun";

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

const targets = (process.env.TARGETS ?? "darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64").split(",");
for (const t of targets) {
  await Bun.build({
    entrypoints: ["./src/main.ts"],
    compile: { target: `bun-${t}` as any, outfile: `dist/yousee-${t}${t.startsWith("windows") ? ".exe" : ""}` },
    external: ["chromium-bidi", "electron"],
    plugins: [playwrightStaticRequires],
  });
}
