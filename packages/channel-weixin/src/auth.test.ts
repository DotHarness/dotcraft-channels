import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import QRCode from "qrcode";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveModuleStatePath, resolveModuleTempPath } from "@dotcraft/channel";

import { WeixinAdapter } from "./weixin-adapter.js";
import type { WeixinCredentials } from "./state.js";
import { DEFAULT_WEIXIN_API_BASE_URL } from "./weixin-config.js";

function createWorkspaceContext(rootName: string): {
  workspaceRoot: string;
  craftPath: string;
  channelName: string;
  moduleId: string;
} {
  const workspaceRoot = mkdtempSync(join(tmpdir(), `${rootName}-`));
  const craftPath = join(workspaceRoot, ".craft");
  mkdirSync(craftPath, { recursive: true });
  return {
    workspaceRoot,
    craftPath,
    channelName: "weixin",
    moduleId: "weixin-standard",
  };
}

function writeConfig(craftPath: string): string {
  const configPath = join(craftPath, "weixin.json");
  writeFileSync(configPath, JSON.stringify({ dotcraft: { wsUrl: "ws://127.0.0.1:9100/ws" } }), "utf-8");
  return configPath;
}

test("no saved credentials transitions to authRequired", async () => {
  const context = createWorkspaceContext("weixin-auth-none");
  writeConfig(context.craftPath);

  const adapter = new WeixinAdapter();
  let beginAuthFlowCalled = false;
  (adapter as unknown as { beginAuthFlow: (reason: "startup" | "expired") => void }).beginAuthFlow = () => {
    beginAuthFlowCalled = true;
  };

  await adapter.startWithContext(context);

  assert.equal(adapter.getStatus(), "authRequired");
  assert.equal(beginAuthFlowCalled, true);
});

test("canceling sign-in removes the URL and prevents a pending PNG from reappearing", async (t) => {
  const context = createWorkspaceContext("weixin-qr-cleanup");
  t.after(() => rmSync(context.workspaceRoot, { force: true, recursive: true }));
  const configPath = writeConfig(context.craftPath);
  const writtenConfig = readFileSync(configPath, "utf-8");
  let requestOrigin: string | undefined;

  const qrUrl = "https://example.invalid/qr";
  let finishPng!: (data: Buffer) => void;
  const pendingPng = new Promise<Buffer>((resolve) => { finishPng = resolve; });
  let markRendered!: () => void;
  const rendered = new Promise<void>((resolve) => { markRendered = resolve; });
  t.mock.method(QRCode, "toBuffer", () => {
    markRendered();
    return pendingPng;
  });
  t.mock.method(globalThis, "fetch", async (url: URL, init?: RequestInit) => {
    if (url.pathname.endsWith("get_bot_qrcode")) {
      requestOrigin = url.origin;
      return Response.json({ qrcode: "test", qrcode_img_content: qrUrl });
    }
    if (init?.signal?.aborted) throw init.signal.reason;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  });

  const adapter = new WeixinAdapter();
  await adapter.startWithContext(context);
  await rendered;
  assert.equal(requestOrigin, DEFAULT_WEIXIN_API_BASE_URL);
  assert.equal(readFileSync(configPath, "utf-8"), writtenConfig);
  const temp = resolveModuleTempPath(context);
  assert.equal(existsSync(join(temp, "qr-url.txt")), true);
  await adapter.stop();
  finishPng(Buffer.from("png fixture"));
  await setImmediate();
  assert.equal(existsSync(join(temp, "qr-url.txt")), false);
  assert.equal(existsSync(join(temp, "qr.png")), false);
});

test("valid saved credentials avoid authRequired on startup", async () => {
  const context = createWorkspaceContext("weixin-auth-existing");
  writeConfig(context.craftPath);

  const stateDir = resolveModuleStatePath(context);
  mkdirSync(stateDir, { recursive: true });
  const credentials: WeixinCredentials = {
    botToken: "bot-token",
    ilinkBotId: "bot-id",
    baseUrl: "https://ilinkai.weixin.qq.com",
    savedAt: new Date().toISOString(),
  };
  writeFileSync(join(stateDir, "credentials.json"), JSON.stringify(credentials, null, 2), "utf-8");

  const adapter = new WeixinAdapter();
  (adapter as unknown as { ensureDotCraftReady: () => Promise<void> }).ensureDotCraftReady = async () => {
    (adapter as unknown as { setStatus: (status: "ready") => void }).setStatus("ready");
  };
  (adapter as unknown as { startMonitor: () => void }).startMonitor = () => {};

  await adapter.startWithContext(context);

  assert.notEqual(adapter.getStatus(), "authRequired");
});
