import { readdir, readFile } from "node:fs/promises";

const pluginsRoot = new URL("../out/plugins/", import.meta.url);
const available = (await readdir(pluginsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const selected = process.env.SELECTED;
const version = (process.env.TAG ?? "").match(/^v(\d+\.\d+\.\d+)$/)?.[1];
if (!version) throw new Error("Run the release on a vX.Y.Z tag.");
if (selected !== "all" && !available.includes(selected)) {
  throw new Error(`Select all or one of: ${available.join(", ")}.`);
}

const plugins = selected === "all" ? available : [selected];
for (const id of plugins) {
  const manifest = JSON.parse(await readFile(new URL(`${id}/.craft-plugin/plugin.json`, pluginsRoot), "utf8"));
  if (manifest.version !== version) throw new Error(`${id} version ${manifest.version} does not match v${version}.`);
}
console.log(`plugins=${JSON.stringify(plugins)}`);
