import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { bundleChannelEntry } from "./bundle-channel.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsRoot = join(projectRoot, "out", "plugins");
const channelPackages = (await readdir(pluginsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

function runNode(script, args = [], env = process.env) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env, timeout: 10_000 });
}

function outputOf(result) {
  return `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
}

const fixtureRoot = await mkdtemp(join(tmpdir(), "dotcraft-channel-bundle-"));
try {
  const fixturePlugins = join(fixtureRoot, "plugins");
  const workspace = join(fixtureRoot, "workspace");
  const craftPath = join(fixtureRoot, "host-craft");
  const env = { ...process.env, DOTCRAFT_CHANNEL_CRAFT_PATH: craftPath };
  await cp(pluginsRoot, fixturePlugins, { recursive: true });
  await mkdir(workspace);
  for (const packageName of channelPackages) {
    const pluginRoot = join(fixturePlugins, packageName);
    const manifest = JSON.parse(await readFile(join(pluginRoot, ".craft-plugin", "plugin.json"), "utf8"));
    const bundle = join(pluginRoot, manifest.channel.entry);
    const result = runNode(bundle);
    const output = outputOf(result);
    if (result.status !== 1 || !output.includes("Missing value for --workspace.")) {
      throw new Error(
        `${packageName} bundle did not reach CLI argument validation (exit=${result.status}).\n${output}`,
      );
    }
    const workspaceResult = runNode(bundle, ["--workspace", workspace], env);
    const workspaceOutput = outputOf(workspaceResult);
    if (workspaceResult.status !== 1 ||
        ![craftPath, JSON.stringify(craftPath).slice(1, -1)].some((value) => workspaceOutput.includes(value))) {
      throw new Error(`${packageName} did not use the managed craft path.\n${outputOf(workspaceResult)}`);
    }
  }

  const entry = join(fixtureRoot, "globals.mjs");
  const bundle = join(fixtureRoot, "globals.bundle.mjs");
  await writeFile(
    entry,
    [
      'const fs = require("node:fs");',
      'if (!fs.existsSync(__filename)) throw new Error("missing __filename");',
      'if (typeof __dirname !== "string") throw new Error("missing __dirname");',
      'console.log("channel-bundle-globals-ok");',
    ].join("\n"),
    "utf8",
  );
  await bundleChannelEntry(entry, bundle);
  const result = runNode(bundle);
  if (result.status !== 0 || result.stdout.trim() !== "channel-bundle-globals-ok") {
    throw new Error(`Channel bundle CommonJS-global fixture failed.\n${outputOf(result)}`);
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

console.log(`Verified ${channelPackages.length} channel bundles and the CommonJS-global shim.`);
