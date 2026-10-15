import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claudeBlockStart,
  claudeBlockStop,
  claudeStreamEvent,
  claudeTextDelta,
  createClaudeParser,
  joinJsonlFrames,
} from "../../agents/cli-output.test-helpers.js";
import { createCliEventHandlers } from "../../agents/cli-runner/execute-events.js";
import {
  buildContext,
  buildToolTracking,
} from "../../agents/cli-runner/execute-events.tool-result-args.test-support.js";
import { createChannelProgressDraftCompositor } from "../../channels/progress-draft-compositor.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { runCliAgentWithLifecycle } from "./agent-runner-cli-dispatch.js";

const runCliAgentMock = vi.hoisted(() => vi.fn());
vi.mock("../../agents/cli-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/cli-runner.js")>()),
  runCliAgent: runCliAgentMock,
}));

afterEach(() => {
  resetAgentEventsForTest();
  runCliAgentMock.mockReset();
});

describe("CLI channel progress", () => {
  it("publishes a plan after the parser reclassifies assistant text as tool commentary", async () => {
    const context = buildContext("cli-commentary-plan");
    const handlers = createCliEventHandlers({
      context,
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const update = vi.fn<(text: string) => void>();
    const progress = createChannelProgressDraftCompositor({
      preparedItems: true,
      active: true,
      mode: "progress",
      seed: "cli-progress",
      update,
      entry: {
        streaming: { mode: "progress", progress: { label: "Working", toolProgress: true } },
      },
    });
    runCliAgentMock.mockImplementationOnce(async () => {
      const parser = createClaudeParser({
        onAssistantDelta: handlers.emitCliAssistantDelta,
        onCommentaryText: handlers.emitCliCommentaryText,
        onToolUseStart: handlers.emitParsedToolUseStart,
        onToolResult: handlers.emitParsedToolResult,
      });
      parser.push(
        joinJsonlFrames(
          claudeStreamEvent({ type: "message_start" }),
          claudeTextDelta("I will inspect the workspace."),
          claudeBlockStart(
            {
              type: "tool_use",
              id: "plan-1",
              name: "progress_card",
              input: { plan: [{ step: "Inspect workspace", status: "in_progress" }] },
            },
            1,
          ),
          claudeBlockStop(1),
          {
            type: "user",
            message: {
              content: [{ type: "tool_result", tool_use_id: "plan-1", content: "ok" }],
            },
          },
          "",
        ),
      );
      parser.finish();
      return { payloads: [], meta: {} };
    });
    const planVisibility: boolean[] = [];
    await runCliAgentWithLifecycle({
      runId: context.params.runId,
      runParams: context.params,
      preserveProgressCallbackStartOrder: true,
      onAssistantText: async (payload) => {
        if (payload.replace && payload.text === "") {
          await progress.retractAssistantMessage();
        }
      },
      onItemEvent: async (item) => {
        await progress.pushItemEvent(item);
      },
      onCommentaryText: async ({ text, itemId }) => {
        await progress.pushItemEvent({
          kind: "preamble",
          phase: "end",
          itemId,
          progressText: text,
        });
      },
      onPlanUpdate: async (payload) => {
        planVisibility.push(await progress.pushPlanProgress(payload.steps, payload));
      },
    });
    progress.markFinalReplyStarted();
    expect(planVisibility).toEqual([true]);
    expect(update.mock.calls.some(([text]) => text.includes("Inspect workspace"))).toBe(true);
  });
});
