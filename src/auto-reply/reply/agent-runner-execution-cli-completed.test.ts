import { assert, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { transformCliResultText } from "../../agents/cli-output-results.js";
import { createCliJsonlStreamingParser } from "../../agents/cli-output-stream.js";
import {
  claudeStreamEvent,
  claudeTextDelta,
  joinJsonlFrames,
} from "../../agents/cli-output.test-helpers.js";
import {
  buildCliRunResult,
  prepareCliAssistantReply,
} from "../../agents/cli-runner/cli-run-settlement.js";
import { createCliEventHandlers } from "../../agents/cli-runner/execute-events.js";
import {
  buildContext,
  buildToolTracking,
} from "../../agents/cli-runner/execute-events.tool-result-args.test-support.js";
import type { GetReplyOptions } from "../types.js";
import {
  createMinimalRunAgentTurnParams,
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  runInitialFallbackAttempt,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

beforeEach(async () => {
  state.isCliProviderMock.mockReturnValue(true);
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
    result: await runInitialFallbackAttempt(params, "claude-cli", "claude-opus-4-6"),
    provider: "claude-cli",
    model: "claude-opus-4-6",
    attempts: [],
  }));
  const { createBlockReplyDeliveryHandler } =
    await vi.importActual<typeof import("./reply-delivery.js")>("./reply-delivery.js");
  state.createBlockReplyDeliveryHandlerMock.mockImplementationOnce(createBlockReplyDeliveryHandler);
});

function createCliTurn(opts: GetReplyOptions) {
  const followupRun = createFollowupRun();
  followupRun.run.provider = "claude-cli";
  followupRun.run.model = "claude-opus-4-6";
  return createMinimalRunAgentTurnParams({
    followupRun,
    sessionCtx: { Provider: "telegram", MessageSid: "msg" },
    opts,
  });
}

it("delivers a completed reply with previews and block streaming off", async () => {
  const { setBlockReplyDelivery } = await import("./block-reply-delivery.js");
  const { onAgentEvent } = await import("../../infra/agent-events.js");
  const snapshots: unknown[] = [];
  let cliRunId: string | undefined;
  onTestFinished(
    onAgentEvent((event) => {
      if (event.runId === cliRunId && event.stream === "assistant" && event.data.text) {
        snapshots.push(event.data.text);
      }
    }),
  );
  state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
    cliRunId = params.runId;
    const { emitAgentEvent } = await import("../../infra/agent-events.js");
    emitAgentEvent({
      runId: params.runId,
      stream: "assistant",
      data: { text: "First answer.", delta: "First answer." },
    });
    emitAgentEvent({
      runId: params.runId,
      stream: "assistant",
      data: { completedText: "First answer.", assistantMessageIndex: 0 },
    });
    return {
      payloads: [{ text: "First answer." }, { text: "Final answer." }],
      meta: { finalAssistantVisibleText: "First answer.\nFinal answer." },
    };
  });
  const onBlockReply = vi.fn<NonNullable<GetReplyOptions["onBlockReply"]>>(async () => {
    setBlockReplyDelivery(Promise.resolve({ outcome: "delivered" }));
  });
  const executeAgentTurn = await getExecuteAgentTurnForTest();
  const result = await executeAgentTurn(createCliTurn({ onBlockReply }));
  expect(snapshots).toEqual(["First answer.", "First answer.\nFinal answer."]);
  expect(onBlockReply).toHaveBeenCalledOnce();
  expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({ text: "First answer." });
  assert(result.kind === "success");
  expect(result.directBlockDeliveries).toEqual([expect.objectContaining({ outcome: "delivered" })]);
  expect(result.runResult.payloads).toEqual([{ text: "First answer." }, { text: "Final answer." }]);
});

it.each([false, true])(
  "waits for prior commentary before completed delivery (start-order=%s)",
  async (preserveProgressCallbackStartOrder) => {
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const { emitAgentEvent } = await import("../../infra/agent-events.js");
      emitAgentEvent({
        runId: params.runId,
        stream: "item",
        data: { kind: "preamble", itemId: "prior-commentary", progressText: "Checking." },
      });
      emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { completedText: "Done.", assistantMessageIndex: 0 },
      });
      return { payloads: [{ text: "Done." }], meta: {} };
    });
    const started = createDeferred();
    const release = createDeferred();
    const order: string[] = [];
    const onBlockReply: NonNullable<GetReplyOptions["onBlockReply"]> = async (payload) => {
      order.push(payload.text ?? "");
      if (payload.isCommentary) {
        started.resolve();
        await release.promise;
        order.push("commentary delivered");
      }
    };
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const run = executeAgentTurn(
      createCliTurn({
        onBlockReply,
        commentaryPayloadsEnabled: true,
        preserveProgressCallbackStartOrder,
      }),
    );
    try {
      await Promise.race([
        started.promise,
        run.then(() => {
          throw new Error("CLI completed before commentary started");
        }),
      ]);
      await Promise.resolve();
      expect(order).toEqual(["Checking."]);
    } finally {
      release.resolve();
      await Promise.allSettled([run]);
    }
    expect(order).toEqual(["Checking.", "commentary delivered", "Done."]);
  },
);

it.each([
  ...[false, true].flatMap((tool) =>
    ["B", "NO_REPLY"].map((accepted) => ({ tool, accepted, acceptFirst: false })),
  ),
  { tool: false, accepted: "NO_REPLY", acceptFirst: true },
])(
  "keeps native Stop-hook drafts out of accepted replies (tool=$tool, accepted=$accepted, prior accepted=$acceptFirst)",
  async ({ tool, accepted, acceptFirst }) => {
    const { setBlockReplyDelivery } = await import("./block-reply-delivery.js");
    const { onAgentEventForRun } = await import("../../infra/agent-events.js");
    const completed: string[] = [];
    const completionsAtMessageStop: string[][] = [];
    const liveItems = new Map<string, string>();
    const onBlockReply = vi.fn<NonNullable<GetReplyOptions["onBlockReply"]>>(async () => {
      setBlockReplyDelivery(Promise.resolve({ outcome: "delivered" }));
    });
    state.runCliAgentMock.mockImplementationOnce(
      async (params: Parameters<typeof import("../../agents/cli-runner.js").runCliAgent>[0]) => {
        const context = buildContext(params.runId);
        context.params = { ...context.params, ...params };
        const handlers = createCliEventHandlers({
          context,
          toolTracking: buildToolTracking(),
          getRunState: () => ({ failed: false, error: undefined }),
        });
        const parser = createCliJsonlStreamingParser({
          backend: { ...context.backendResolved.config, jsonlDialect: "claude-stream-json" },
          providerId: "claude-cli",
          onAssistantDelta: handlers.emitCliAssistantDelta,
          onCompletedReply: handlers.emitCliCompletedReply,
          onThinkingDelta: handlers.emitCliThinkingDelta,
          onCommentaryText: handlers.emitCliCommentaryText,
        });
        const stop = onAgentEventForRun(params.runId, (event) => {
          if (event.stream === "assistant" && typeof event.data.completedText === "string") {
            completed.push(event.data.completedText);
          }
          if (typeof event.data.itemId === "string" && typeof event.data.text === "string") {
            liveItems.set(event.data.itemId, event.data.text);
          }
        });
        const push = (...frames: unknown[]) => parser.push(joinJsonlFrames(...frames, ""));
        const message = (id: string, text: string) => {
          push(
            claudeStreamEvent({ type: "message_start", message: { id } }),
            claudeTextDelta(text),
            claudeStreamEvent({ type: "message_stop" }),
          );
          completionsAtMessageStop.push([...completed]);
        };
        const result = (text: string, interim = false) =>
          push({
            type: "result",
            subtype: "success",
            result: text,
            ...(interim ? { openclaw_interim_result: true } : {}),
          });
        try {
          push(
            claudeStreamEvent({
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "Checking." },
            }),
          );
          message("draft", "A");
          expect(liveItems.get(`cli-assistant:${params.runId}`)).toBe("A");
          if (acceptFirst) {
            result("A", true);
          } else {
            push({ type: "system", subtype: "notification", key: "stop-hook-error" });
            expect(liveItems.get(`cli-assistant:${params.runId}`)).toBe("");
          }
          if (tool) {
            push(
              claudeStreamEvent({ type: "message_start", message: { id: "tool" } }),
              claudeStreamEvent({
                type: "content_block_start",
                index: 0,
                content_block: { type: "tool_use", id: "read-1", name: "Read", input: {} },
              }),
              claudeStreamEvent({ type: "content_block_stop", index: 0 }),
              claudeStreamEvent({ type: "message_stop" }),
              {
                type: "user",
                message: {
                  content: [{ type: "tool_result", tool_use_id: "read-1", content: "ok" }],
                },
              },
            );
          }
          message("accepted", accepted);
          result(accepted, true);
          result(accepted);
          parser.finish();
          const output = parser.getOutput();
          assert(output);
          handlers.emitCliCompletedReply(
            output.rawFinalText ?? output.textParts?.at(-1) ?? output.text,
          );
          expect(liveItems.get(`cli-assistant:${params.runId}`)).toBe(
            accepted === "NO_REPLY" ? (acceptFirst ? "A" : "") : "B",
          );
          if (accepted === "NO_REPLY") {
            expect(liveItems.get(`cli-thinking:${params.runId}`)).toBe("");
          }
          return buildCliRunResult({
            context,
            output,
            assistantText: prepareCliAssistantReply(output).text,
            usedHistoryPrompt: false,
            userTurnHandled: true,
            sessionBindingDisabled: true,
            preparedContextAgentMeta: {},
          });
        } finally {
          stop();
        }
      },
    );
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const execution = await executeAgentTurn(createCliTurn({ onBlockReply }));
    const expected = acceptFirst ? ["A"] : accepted === "NO_REPLY" ? [] : ["B"];
    expect(completionsAtMessageStop).toEqual([[], acceptFirst ? ["A"] : []]);
    expect(completed).toEqual(expected);
    expect(onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual(expected);
    assert(execution.kind === "success");
    expect(
      execution.runResult.payloads
        ?.filter((payload) => !payload.isReasoning)
        .map((payload) => payload.text),
    ).toEqual(acceptFirst ? ["A", "NO_REPLY"] : [accepted]);
  },
);

it.each([
  { text: "NO_REPLY\nMEDIA:https://example.com/result.png", transformed: false },
  {
    text: "Preparing the attachment.\nNO_REPLY\nMEDIA:https://example.com/result.png",
    transformed: false,
  },
  { text: "PRIVATE_MEDIA\nNO_REPLY", transformed: true },
])(
  "delivers an accepted silent attachment before the CLI process ends: $text",
  async ({ text, transformed }) => {
    const { setBlockReplyDelivery } = await import("./block-reply-delivery.js");
    const { onAgentEventForRun } = await import("../../infra/agent-events.js");
    const delivered = createDeferred();
    const continueProcess = createDeferred();
    let processContinued = false;
    const onBlockReply = vi.fn<NonNullable<GetReplyOptions["onBlockReply"]>>(async () => {
      setBlockReplyDelivery(Promise.resolve({ outcome: "delivered" }));
      delivered.resolve();
    });
    state.runCliAgentMock.mockImplementationOnce(
      async (params: Parameters<typeof import("../../agents/cli-runner.js").runCliAgent>[0]) => {
        const context = buildContext(params.runId);
        context.params = { ...context.params, ...params };
        if (transformed) {
          context.backendResolved.textTransforms = {
            output: [
              { from: /PRIVATE_MEDIA/g, to: "MEDIA:https://example.com/result.png" },
              { from: /NO_REPLY/g, to: "" },
            ],
          };
        }
        const handlers = createCliEventHandlers({
          context,
          toolTracking: buildToolTracking(),
          getRunState: () => ({ failed: false, error: undefined }),
        });
        const parser = createCliJsonlStreamingParser({
          backend: { ...context.backendResolved.config, jsonlDialect: "claude-stream-json" },
          providerId: "claude-cli",
          onAssistantDelta: handlers.emitCliAssistantDelta,
          onCompletedReply: handlers.emitCliCompletedReply,
        });
        let previewText: string | undefined;
        const completed: string[] = [];
        const stop = onAgentEventForRun(params.runId, (event) => {
          if (event.stream !== "assistant") {
            return;
          }
          if (typeof event.data.text === "string") {
            previewText = event.data.text;
          }
          if (typeof event.data.completedText === "string") {
            completed.push(event.data.completedText);
          }
        });
        try {
          parser.push(
            joinJsonlFrames(
              claudeStreamEvent({ type: "message_start", message: { id: "attachment" } }),
              claudeTextDelta(text),
              claudeStreamEvent({ type: "message_stop" }),
              { type: "result", subtype: "success", result: text, openclaw_interim_result: true },
              "",
            ),
          );
          expect(previewText).toBe("");
          expect(completed).toHaveLength(1);
          await continueProcess.promise;
          processContinued = true;
          parser.push(joinJsonlFrames({ type: "result", subtype: "success", result: text }, ""));
          parser.finish();
          const rawOutput = parser.getOutput();
          assert(rawOutput);
          const output = transformCliResultText(
            rawOutput,
            context.backendResolved.textTransforms?.output,
          );
          return buildCliRunResult({
            context,
            output,
            assistantText: prepareCliAssistantReply(output).text,
            usedHistoryPrompt: false,
            userTurnHandled: true,
            sessionBindingDisabled: true,
            preparedContextAgentMeta: {},
          });
        } finally {
          stop();
        }
      },
    );
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const run = executeAgentTurn(createCliTurn({ onBlockReply }));
    try {
      await Promise.race([
        delivered.promise,
        run.then(() => {
          throw new Error("CLI settled before delivering its accepted attachment");
        }),
      ]);
      expect(processContinued).toBe(false);
      expect(
        onBlockReply.mock.calls.map(([payload]) => ({
          text: payload.text,
          mediaUrls: payload.mediaUrls,
        })),
      ).toEqual([{ text: undefined, mediaUrls: ["https://example.com/result.png"] }]);
    } finally {
      continueProcess.resolve();
      await run;
    }
    expect(onBlockReply).toHaveBeenCalledOnce();
  },
);
