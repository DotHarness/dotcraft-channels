import { copyFile, cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "out", "plugins");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function copy(source, target) {
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

function check(id, field, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${id}: plugin.json ${field} is ${JSON.stringify(actual)}, but the channel manifest has ${JSON.stringify(expected)}.`);
  }
}

const packages = (await readdir(join(root, "packages"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && existsSync(join(root, "packages", entry.name, "plugin", ".craft-plugin", "plugin.json")))
  .map((entry) => entry.name)
  .sort();
if (!packages.length) throw new Error("No channel plugins found under packages/*/plugin.");

await rm(output, { recursive: true, force: true });
for (const id of packages) {
  const source = join(root, "packages", id);
  const target = join(output, id);
  const plugin = await readJson(join(source, "plugin", ".craft-plugin", "plugin.json"));
  const pkg = await readJson(join(source, "package.json"));
  const channel = await readJson(join(source, "manifest.json"));

  if (plugin.id !== id) throw new Error(`${id}: plugin.json id is ${JSON.stringify(plugin.id)}.`);
  if (!/^\d+\.\d+\.\d+$/.test(plugin.version ?? "")) throw new Error(`${id}: plugin.json requires a MAJOR.MINOR.PATCH version.`);
  if (pkg.version !== plugin.version) throw new Error(`${id}: package.json version ${pkg.version} does not match plugin.json ${plugin.version}.`);
  const name = channel.localizedDisplayName?.en ?? channel.displayName;
  check(id, "displayName", plugin.displayName, name);
  check(id, "interface.displayName", plugin.interface?.displayName, name);
  check(id, "interface.shortDescription", plugin.interface?.shortDescription, channel.interface?.shortDescription);
  check(id, "interface.longDescription", plugin.interface?.longDescription, channel.interface?.longDescription);
  check(id, "interface.defaultPrompt", plugin.interface?.defaultPrompt, channel.interface?.previewPrompt);

  await cp(join(source, "plugin"), target, { recursive: true });
  await copy(join(source, "manifest.json"), join(target, plugin.channel.manifest));
  await copy(join(source, "dist", "cli.bundle.mjs"), join(target, plugin.channel.entry));
  const channelRoot = join(target, posix.dirname(plugin.channel.manifest));
  for (const file of pkg.channelFiles ?? []) await copy(join(source, file), join(channelRoot, file));
  await copyFile(join(source, "dist", "licenses.txt"), join(target, "THIRD_PARTY_LICENSES.txt"));
  await copyFile(join(root, "LICENSE"), join(target, "LICENSE"));
  console.log(`Packaged ${id} ${plugin.version}.`);
}
