import type { ChannelToolDescriptor, RuntimeAdditionalContextEntry } from "@dotcraft/channel";

import {
  FeishuCliRunner,
  FeishuCliRunnerError,
  logFeishuCliFailure,
} from "./feishu-cli-runner.js";
import type { FeishuConfig } from "./feishu-types.js";

const FEISHU_CLI_RUNTIME_CONTEXT: Record<string, RuntimeAdditionalContextEntry> = {
  "feishu.cli": {
    kind: "application",
    value:
      "FeishuCli uses the pinned official CLI with adapter-managed credentials. "
      + "Read a known Skill directly; use skills list only when the relevant Skill is unknown. "
      + "When a Skill links a reference, read it first with args=['read','<skill-name>','<relative-path>']; do not guess parameters. "
      + "Identity comes from the identity input: leave it unset for the Bot, and pass identity='user' only for a personal resource the Bot cannot reach, such as a calendar, drive, or mailbox the operator owns. "
      + "User identity is read-only. When a Bot call is denied for permissions, retry the same command once with identity='user' before giving up. "
      + "If that reports no authorized account, call FeishuAuthorizeUser; if it reports that user identity is not enabled, say an administrator must configure its scopes in the channel settings. Never try auth, config, or profiles. "
      + "GroupChatId names a live Feishu chat, a topic when it carries /thread:<id>; messages posted there before this turn are not in your context, so read them with FeishuCli before answering. "
      + "Call FeishuCli directly instead of locating lark-cli through Shell. Do not pass --yes. Document, wiki, file, media, and page tokens are valid resource identifiers.",
  },
};

export function getFeishuCliRuntimeAdditionalContext(
  enabled: boolean,
): Record<string, RuntimeAdditionalContextEntry> | undefined {
  return enabled ? FEISHU_CLI_RUNTIME_CONTEXT : undefined;
}

export function getFeishuCliToolDescriptors(enabled: boolean): ChannelToolDescriptor[] {
  if (!enabled) return [];
  return [{
    name: "FeishuCli",
    description:
      "Run one command from the pinned official Feishu CLI. "
      + "Pass the subcommand in command and each following argv token in args.",
    requiresChatContext: false,
    approval: {
      kind: "remoteResource",
      targetArgument: "command",
      operation: "invoke",
    },
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "One lark-cli subcommand token, such as skills, docs, wiki, or calendar.",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Argument tokens following command. Do not include --as, --profile, or --yes. Business resource tokens are allowed.",
        },
        identity: {
          type: "string",
          enum: ["bot", "user"],
          description: "Who the command acts as. Defaults to bot. Use user only for read-only access to a personal resource the bot cannot reach.",
        },
      },
      required: ["command", "args"],
      additionalProperties: false,
    },
  }];
}

export class FeishuCliTool {
  private readonly abortController = new AbortController();

  private preparation: Promise<FeishuCliRunner> | undefined;

  private constructor(private readonly state:
    | { runner: FeishuCliRunner }
    | { prepare: (signal: AbortSignal) => Promise<FeishuCliRunner> }) {}

  static create(
    workspaceRoot: string,
    stateDir: string,
    config: FeishuConfig["feishu"],
    getTenantAccessToken: () => Promise<string>,
    getUserAccessToken: () => Promise<string>,
  ): FeishuCliTool {
    return new FeishuCliTool({
      prepare: (signal) => FeishuCliRunner.fromModule(
        workspaceRoot, stateDir, config, getTenantAccessToken, getUserAccessToken, signal,
      ),
    });
  }

  stop(): void {
    this.abortController.abort();
  }

  async invoke(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let runner: FeishuCliRunner;
    try {
      this.abortController.signal.throwIfAborted();
      const state = this.state;
      runner = "runner" in state
        ? state.runner
        : await (this.preparation ??= state.prepare(this.abortController.signal));
    } catch (error) {
      this.preparation = undefined;
      const failure = error instanceof FeishuCliRunnerError
        ? error
        : new FeishuCliRunnerError(
          "FeishuCliArtifactUnavailable",
          "The pinned Feishu CLI is unavailable. Check the host's network and retry.",
        );
      logFeishuCliFailure(failure);
      return failureResult(failure);
    }

    const command = typeof args.command === "string" ? args.command : "";
    const cliArgs = Array.isArray(args.args) ? args.args : [];
    const identity = args.identity === "user" ? "user" : "bot";
    try {
      const result = await runner.run(command, cliArgs as string[], {
        identity,
        signal: this.abortController.signal,
      });
      return {
        success: true,
        contentItems: result.contentItems,
        ...(result.structuredResult === undefined
          ? {}
          : { structuredResult: result.structuredResult }),
      };
    } catch (error) {
      logFeishuCliFailure(error);
      return failureResult(error instanceof FeishuCliRunnerError
        ? error
        : new FeishuCliRunnerError("FeishuCliExecutionFailed", "Feishu CLI execution failed."));
    }
  }
}

function failureResult(error: FeishuCliRunnerError): Record<string, unknown> {
  return {
    success: false,
    errorCode: error.code,
    errorMessage: error.message,
    ...(error.structuredResult === undefined
      ? {}
      : { structuredResult: error.structuredResult }),
  };
}
