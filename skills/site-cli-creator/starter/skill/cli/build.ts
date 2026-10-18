// Compiles src/main.ts into one self-contained binary.
// Usage: bun build.ts <bun-target> <outfile>
//   bun-target: bun-darwin-arm64 | bun-darwin-x64 | bun-linux-x64 | bun-linux-arm64 | bun-windows-x64
//
// playwright-core reads its own package.json and browsers.json through a path built from
// __dirname, and `bun build --compile` freezes that path to the build machine. Without the
// patch below the binary only runs where it was built. The patch rewrites both requires to
// static relative ones, which Bun embeds. The exact-count guard fails the build loudly if a
// playwright-core upgrade moves the call sites, so keep playwright-core pinned.
import type { BunPlugin } from "bun";
import { rm } from "node:fs/promises";
import { join } from "node:path";

export const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-windows-x64",
] as const;

const PATCH_SITE = /require\(import_path\d+\.default\.join\(packageRoot, "(package|browsers)\.json"\)\)/g;

export function patchCoreBundle(src: string): string {
  const hits = src.match(PATCH_SITE)?.length ?? 0;
  if (hits !== 2) {
    throw new Error(`playwright-core patch: expected 2 patch sites in coreBundle.js, found ${hits}`);
  }
  return src.replace(PATCH_SITE, 'require("../$1.json")');
}

const playwrightStaticRequires: BunPlugin = {
  name: "playwright-core-static-requires",
  setup(build) {
    build.onLoad({ filter: /playwright-core[\\/]lib[\\/]coreBundle\.js$/ }, async ({ path }) => ({
      contents: patchCoreBundle(await Bun.file(path).text()),
      loader: "js",
    }));
  },
};

async function main(argv: string[]): Promise<number> {
  const [target, outfile] = argv;
  if (!target || !outfile || !target.startsWith("bun-")) {
    console.error(`usage: bun build.ts <bun-target> <outfile>\n  targets: ${TARGETS.join(" ")}`);
    return 2;
  }
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "src", "main.ts")],
    compile: { target: target as Bun.Build.CompileTarget, outfile },
    external: ["chromium-bidi", "electron"],
    plugins: [playwrightStaticRequires],
    // No minify: the bug key uses function names from stack frames. The embedded source map
    // maps frames back to src/ paths.
    sourcemap: "linked",
  }).catch((err: unknown) => ({ success: false as const, logs: [err] }));
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    return 1;
  }
  // The map is embedded in the binary; the copy written next to it would only clutter dist/.
  for (const output of result.outputs) {
    if (output.kind === "sourcemap") await rm(output.path, { force: true });
  }
  console.error(`built ${outfile} for ${target}`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
