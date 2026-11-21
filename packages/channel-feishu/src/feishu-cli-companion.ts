import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const extract = promisify(execFile);
const maxArchiveBytes = 64 * 1024 * 1024;
type LockedArtifact = { file: string; sha256: string };
type Lock = { version: string; repository: string; artifacts: Record<string, LockedArtifact> };
type Marker = { version: string; platform: string; arch: string; archiveSha256: string; executableSha256: string };

export async function prepareFeishuCli(
  moduleRoot: string,
  stateDir: string,
  signal: AbortSignal,
): Promise<{ executable: string; catalogPath: string; version: string }> {
  signal.throwIfAborted();
  const lockRoot = join(moduleRoot, "official-cli");
  const { version, repository, artifacts } = await readJson<Lock>(join(lockRoot, "lark-cli.lock.json"));
  const { platform, arch } = process;
  const target = artifacts?.[`${platform}-${arch}`];
  if (repository !== "larksuite/cli" || !/^\d+\.\d+\.\d+$/.test(version) ||
      !target || !/^lark-cli-[a-z0-9.\-]+(?:\.zip|\.tar\.gz)$/.test(target.file) ||
      !/^[0-9a-f]{64}$/.test(target.sha256)) {
    throw new Error("No pinned Feishu CLI companion for this host.");
  }
  const executableName = platform === "win32" ? "lark-cli.exe" : "lark-cli";
  const parent = join(stateDir, "lark-cli", version);
  const destination = join(parent, `${platform}-${arch}`);
  const catalogPath = join(lockRoot, "lark-cli-shortcuts.json");

  const executable = join(destination, executableName);
  try {
    const marker = await readJson<Marker>(join(destination, "lark-cli-artifact.json"));
    await access(executable, platform === "win32" ? constants.R_OK : constants.R_OK | constants.X_OK);
    if (marker.version !== version || marker.platform !== platform || marker.arch !== arch ||
        marker.archiveSha256 !== target.sha256 || sha256(await readFile(executable)) !== marker.executableSha256) {
      throw new Error("The installed Feishu CLI companion does not match its pinned version.");
    }
    return { executable, catalogPath, version };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const url = `https://github.com/${repository}/releases/download/v${version}/${target.file}`;
  const bytes = await download(url, AbortSignal.any([signal, AbortSignal.timeout(90_000)]));
  if (sha256(bytes) !== target.sha256) throw new Error("Feishu CLI archive checksum mismatch.");
  signal.throwIfAborted();

  await mkdir(parent, { recursive: true });
  const staged = await mkdtemp(join(parent, ".stage-"));
  try {
    const archive = join(staged, target.file);
    await writeFile(archive, bytes);
    await extract("tar", ["-xf", archive, "-C", staged, executableName, "LICENSE"], { signal, timeout: 15_000 });
    await rm(archive);
    const stagedExecutable = join(staged, executableName);
    if (platform !== "win32") await chmod(stagedExecutable, 0o755);
    const marker: Marker = {
      version,
      platform,
      arch,
      archiveSha256: target.sha256,
      executableSha256: sha256(await readFile(stagedExecutable)),
    };
    await writeFile(join(staged, "lark-cli-artifact.json"), JSON.stringify(marker) + "\n");
    signal.throwIfAborted();
    await rename(staged, destination);
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
  return { executable, catalogPath, version };
}

async function download(url: string, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`Feishu CLI download returned HTTP ${response.status}.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      total += value.byteLength;
      if (total > maxArchiveBytes) throw new Error("Feishu CLI archive exceeds the download limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
