import assert from "node:assert/strict";
import test from "node:test";

import { ChannelAdapter, type ChannelAdapterMessageOpts } from "./adapter.js";
import type { ChannelChatDescriptor, ChannelDeliveryCapabilities } from "./capability.js";
import type { SessionThread } from "@dotcraft/sdk/contracts";
import { makeThread, makeTurn } from "./test-contract-fixtures.js";
import type { Transport } from "@dotcraft/sdk/wire";

class NoopTransport implements Transport {
  async readMessage(): Promise<Record<string, unknown>> {
    throw new Error("Not implemented in tests");
  }

  async writeMessage(_msg: Record<string, unknown>): Promise<void> {}

  async close(): Promise<void> {}
}

async function withTimeout<T>(promise: Promise<T>, message: string, ms = 1000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

class RecordingAdapter extends ChannelAdapter {
  readonly deliveries: Array<{ target: string; content: string; metadata: Record<string, unknown> }> = [];
  deliveryError: Error | null = null;

  constructor() {
    super(new NoopTransport(), "test-channel", "test-client", "0.0.0");
    this.client.threadUnsubscribe = async () => {};
  }

  async onDeliver(target: string, content: string, metadata: Record<string, unknown>): Promise<boolean> {
    if (this.deliveryError) throw this.deliveryError;
    this.deliveries.push({ target, content, metadata });
    return true;
  }

  async onApprovalRequest(_request: Record<string, unknown>): Promise<string> {
    return "cancel";
  }

  protected getDisplayName(): string {
    return "Test";
  }

  protected getDeliveryCapabilities(): ChannelDeliveryCapabilities {
    return { text: { format: "plain" }, targets: { group: false, direct: "none" } };
  }

  protected getChatDescriptor(): ChannelChatDescriptor {
    return { kind: "direct", membership: "shared" };
  }
}

test("processMessage reports one generic failure when turn startup fails", async () => {
  const adapter = new RecordingAdapter();
  const client = (adapter as unknown as { client: Record<string, unknown> }).client;
  const diagnostic = "provider diagnostic detail";

  (adapter as unknown as {
    getOrCreateThread: (...args: unknown[]) => Promise<SessionThread>;
  }).getOrCreateThread = async () => makeThread("thread-1", "active");
  client.streamEvents = () => (async function* () {})();
  client.turnStart = async () => { throw new Error(diagnostic); };

  await assert.rejects(
    (adapter as unknown as {
      processMessage: (identityKey: string, opts: ChannelAdapterMessageOpts) => Promise<void>;
    }).processMessage("user-1:chat-1", {
      userId: "user-1",
      userName: "Tester",
      text: "hello",
      channelContext: "chat-1",
    }),
    new RegExp(diagnostic),
  );

  assert.deepEqual(adapter.deliveries, [{
    target: "chat-1",
    content: "DotCraft couldn't start this request. Please try again or check the channel logs.",
    metadata: { failureCode: "channelRequestStartFailed" },
  }]);
  assert.equal(adapter.deliveries[0]?.content.includes(diagnostic), false);
});

test("failure notification delivery errors preserve the original startup failure", async () => {
  const adapter = new RecordingAdapter();
  adapter.deliveryError = new Error("platform send unavailable");
  (adapter as unknown as {
    getOrCreateThread: (...args: unknown[]) => Promise<SessionThread>;
  }).getOrCreateThread = async () => { throw new Error("startup failed"); };

  await assert.rejects(
    (adapter as unknown as {
      processMessage: (identityKey: string, opts: ChannelAdapterMessageOpts) => Promise<void>;
    }).processMessage("user-1:chat-1", {
      userId: "user-1",
      userName: "Tester",
      text: "hello",
      channelContext: "chat-1",
    }),
    /startup failed/,
  );
  assert.deepEqual(adapter.deliveries, []);
});

test("ChannelAdapter lets explicit sender override thread identity and omit implicit channel context groupId", async () => {
  const adapter = new RecordingAdapter();
  const client = (adapter as unknown as { client: Record<string, unknown> }).client;
  const senders: unknown[] = [];
  const inputs: unknown[] = [];

  (adapter as unknown as {
    getOrCreateThread: (...args: unknown[]) => Promise<SessionThread>;
  }).getOrCreateThread = async () => makeThread("thread-1", "active");

  client.turnStart = async (_threadId: string, input: unknown, sender: unknown) => {
    inputs.push(input);
    senders.push(sender);
    return makeTurn(`turn-${senders.length}`, "thread-1", "running");
  };
  client.streamEvents = () =>
    (async function* () {
      yield {
        method: "turn/completed",
        params: { turn: { ...makeTurn(`turn-${senders.length}`, "thread-1", "completed"), items: [] } },
      };
    })();

  await (adapter as unknown as {
    processMessage: (identityKey: string, opts: Record<string, unknown>) => Promise<void>;
  }).processMessage("group:123:group:123", {
    userId: "group:123",
    userName: "QQ Group 123",
    text: "hello",
    channelContext: "group:123",
    sender: { senderId: "user-1", senderName: "Tester", groupId: "group:123" },
    senderExtra: { senderRole: "admin" },
  });

  await (adapter as unknown as {
    processMessage: (identityKey: string, opts: Record<string, unknown>) => Promise<void>;
  }).processMessage("user-1:user:1", {
    userId: "user-1",
    userName: "Tester",
    text: "hello",
    channelContext: "user:1",
    omitSenderGroupId: true,
    inputParts: [{ type: "text", text: "custom part" }],
  });

  assert.deepEqual(senders[0], {
    senderId: "user-1",
    senderName: "Tester",
    groupId: "group:123",
    senderRole: "admin",
  });
  assert.deepEqual(senders[1], {
    senderId: "user-1",
    senderName: "Tester",
    senderRole: "user",
  });
  assert.deepEqual(inputs[1], [{ type: "text", text: "custom part" }]);
});
