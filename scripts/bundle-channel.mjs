import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";

async function writeBundleLicenses(inputs, output) {
  const roots = new Set();
  for (const input of inputs) {
    let dir = dirname(resolve(input));
    while (dir !== dirname(dir)) {
      const parent = dirname(dir);
      if (basename(parent) === "node_modules"
          || (basename(parent).startsWith("@") && basename(dirname(parent)) === "node_modules")) {
        roots.add(dir);
        break;
      }
      dir = parent;
    }
  }

  const notices = [];
  for (const root of [...roots].sort()) {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const files = (await readdir(root)).filter((name) => /^(licen[cs]e|notice|copying)(\.|$)/i.test(name)).sort();
    const key = `${pkg.name}@${pkg.version}`;
    const fallback = {
      "agent-base@6.0.2": "node-proxy-agents.txt",
      "https-proxy-agent@5.0.1": "node-proxy-agents.txt",
      "tr46@0.0.3": "tr46-0.0.3.txt",
    }[key];
    if (!files.length && !fallback) throw new Error(`No license included for bundled package ${key}.`);
    const texts = files.length
      ? await Promise.all(files.map((file) => readFile(join(root, file), "utf8")))
      : [await readFile(new URL(`../licenses/${fallback}`, import.meta.url), "utf8")];
    notices.push(`${pkg.name}@${pkg.version}\n\n${texts.join("\n\n").trim()}`);
  }
  await writeFile(output, notices.join("\n\n==============================================================================\n\n") + "\n");
}

export const channelBundleBanner = [
  "import{createRequire as __dotcraftCreateRequire}from'node:module';",
  "import{fileURLToPath as __dotcraftFileURLToPath}from'node:url';",
  "import{dirname as __dotcraftPathDirname}from'node:path';",
  "const require=__dotcraftCreateRequire(import.meta.url);",
  "const __filename=__dotcraftFileURLToPath(import.meta.url);",
  "const __dirname=__dotcraftPathDirname(__filename);",
].join("");

export async function bundleChannelEntry(entryPoint, outfile) {
  return await build({
    entryPoints: [resolve(entryPoint)],
    metafile: true,
    target: "node22",
    legalComments: "eof",
    outfile: resolve(outfile),
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["node:*"],
    banner: { js: channelBundleBanner },
  });
}

export async function bundleChannelPackage(packageRoot) {
  const root = resolve(packageRoot);
  const { metafile } = await bundleChannelEntry(resolve(root, "dist", "cli.js"), resolve(root, "dist", "cli.bundle.mjs"));
  await writeBundleLicenses(Object.keys(metafile.inputs), resolve(root, "dist", "licenses.txt"));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const packageRoot = process.argv[2];
  if (!packageRoot) {
    console.error("Usage: node scripts/bundle-channel.mjs <channel-package-root>");
    process.exitCode = 1;
  } else {
    await bundleChannelPackage(packageRoot);
  }
}
