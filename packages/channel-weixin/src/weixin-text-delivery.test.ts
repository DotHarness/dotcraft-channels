import assert from "node:assert/strict";
import test from "node:test";

import { WeixinAdapter } from "./weixin-adapter.js";

test("Weixin reports text delivery failure instead of acknowledging it", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const adapter = new WeixinAdapter();
  const internals = adapter as unknown as {
    apiBaseUrl: string;
    botToken: string;
    contextTokens: Record<string, string>;
  };
  internals.apiBaseUrl = "https://ilink.example";
  internals.botToken = "token";
  internals.contextTokens = { "wx-user-1": "ctx" };

  globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
  console.error = () => {};

  try {
    const delivered = await adapter.onDeliver("wx-user-1", "不会成功发送。", {});
    assert.equal(delivered, false);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("Weixin retries transient text fetch failures with the same client id", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalFetch = globalThis.fetch;
  const adapter = new WeixinAdapter();
  const internals = adapter as unknown as {
    apiBaseUrl: string;
    botToken: string;
    contextTokens: Record<string, string>;
  };
  internals.apiBaseUrl = "https://ilink.example";
  internals.botToken = "token";
  internals.contextTokens = { "wx-user-1": "ctx" };

  const clientIds: string[] = [];
  let attempts = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    attempts += 1;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const msg = body.msg as Record<string, unknown>;
    clientIds.push(String(msg.client_id ?? ""));
    if (attempts < 3) throw new TypeError("fetch failed");
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    let settled = false;
    const delivering = adapter.onDeliver("wx-user-1", "重试后成功。", {}).finally(() => {
      settled = true;
    });
    while (!settled) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(1000);
    }
    assert.equal(await delivering, true);
    assert.equal(attempts, 3);
    assert.equal(new Set(clientIds).size, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Weixin consumes pending user-input replies before forwarding to agent", async () => {
  type PendingUserInput = {
    request: Record<string, unknown>;
    resolve: (response: Record<string, unknown>) => void;
  };
  const adapter = new WeixinAdapter() as unknown as {
    userInputWaiters: Map<string, PendingUserInput>;
    handleInboundUserMessage: (msg: {
      from_user_id?: string;
      item_list?: { type?: number; text_item?: { text?: string } }[];
      context_token?: string;
    }) => Promise<void>;
    handleMessage: (opts: Record<string, unknown>) => Promise<void>;
  };
  let forwarded = false;
  const resolved: Record<string, unknown>[] = [];
  adapter.handleMessage = async () => {
    forwarded = true;
  };
  adapter.userInputWaiters.set("wx-user-1", {
    request: {
      requestId: "req-1",
      questions: [
        {
          id: "mode",
          header: "Pick a mode",
          question: "Which mode?",
          options: [{ label: "Auto" }, { label: "Manual" }],
        },
      ],
    },
    resolve: (response) => resolved.push(response),
  });

  await adapter.handleInboundUserMessage({
    from_user_id: "wx-user-1",
    item_list: [{ type: 1, text_item: { text: "2" } }],
  });

  assert.equal(forwarded, false);
  assert.deepEqual(resolved, [{ answers: { mode: { answers: ["Manual"] } } }]);
  assert.equal(adapter.userInputWaiters.size, 0);
});
