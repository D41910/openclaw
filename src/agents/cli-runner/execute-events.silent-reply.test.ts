import { describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { onAgentEventForRun, type AgentEventRuntimePayload } from "../../infra/agent-events.js";
import { createCliJsonlStreamingParser } from "../cli-output-stream.js";
import { claudeStreamEvent, claudeTextDelta, joinJsonlFrames } from "../cli-output.test-helpers.js";
import { buildCliRunResult } from "./cli-run-settlement.js";
import { createCliEventHandlers } from "./execute-events.js";
import { buildContext, buildToolTracking } from "./execute-events.tool-result-args.test-support.js";

function textEvents(events: AgentEventRuntimePayload[]) {
  return events.filter(({ data }) =>
    [data.text, data.delta, data.completedText, data.progressText].some(
      (text) => typeof text === "string" && text.length > 0,
    ),
  );
}

describe("CLI completed reply publication", () => {
  it.each([
    "The discussion is already complete.\nNO_REPLY",
    "Nobody asked me for an answer.\n(NO_REPLY)\n\n",
    "Die Frage ist schon beantwortet.\nNO_REPLY.",
    "The attachment is ready.\nNO_REPLY\nMEDIA:https://example.com/result.png",
    "The attachment is ready.\nNO_REPLY\nMEDIA:https://user:synthetic-password@example.com/result.png",
  ])("holds text-bearing events and discards a silent completed segment: %j", (text) => {
    const context = buildContext("silent-cli-segment");
    context.params.onExecutionPhase = vi.fn();
    const handlers = createCliEventHandlers({
      context,
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const events: AgentEventRuntimePayload[] = [];
    const unsubscribe = onAgentEventForRun(context.params.runId, (event) => events.push(event));
    try {
      handlers.emitCliThinkingDelta({ text: "Private reasoning.", delta: "Private reasoning." });
      handlers.emitCliCommentaryText("I am considering whether to answer.");
      handlers.emitCliAssistantDelta({ text: "The discussion", delta: "The discussion" });
      expect(textEvents(events)).toEqual([]);
      expect(handlers.hasObservedCliActivity()).toBe(true);
      expect(context.params.onExecutionPhase).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "assistant_output_started" }),
      );
      handlers.emitCliCompletedReply(text, 0);
      expect(textEvents(events)).toEqual([]);

      handlers.emitCliThinkingDelta({
        text: "Private reasoning.Next thought.",
        delta: "Next thought.",
      });
      handlers.emitCliCompletedReply("A later real answer.", 1);
      handlers.emitCliCompletedReply(text, 2);
      handlers.emitCliCompletedReply("A final answer.");
      expect(textEvents(events).map(({ data }) => data.text ?? data.completedText)).toEqual([
        "Next thought.",
        "A later real answer.",
        "A later real answer.\nA final answer.",
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("publishes completed progress with transforms and preserves non-text activity", () => {
    const context = buildContext("visible-cli-segment");
    context.backendResolved.textTransforms = {
      output: [{ from: /PRIVATE_MARKER/g, to: "answer" }],
    };
    const handlers = createCliEventHandlers({
      context,
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const events: AgentEventRuntimePayload[] = [];
    const unsubscribe = onAgentEventForRun(context.params.runId, (event) => events.push(event));
    try {
      handlers.emitCliThinkingDelta({ text: "Checking.", delta: "Checking." });
      handlers.emitCliCommentaryText("Looking up the PRIVATE_MARKER.");
      handlers.emitCliAssistantDelta({ text: "The PRIVATE_MARKER", delta: "The PRIVATE_MARKER" });
      handlers.emitCliThinkingProgress({ progressTokens: 2 });
      expect(textEvents(events)).toEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({ stream: "thinking", data: { progressTokens: 2 } }),
      );
      handlers.emitCliCompletedReply("The PRIVATE_MARKER mentions NO_REPLY inline.", 3);
      expect(
        textEvents(events).map(({ data }) => data.text ?? data.progressText ?? data.completedText),
      ).toEqual(["Checking.", "Looking up the answer.", "The answer mentions NO_REPLY inline."]);
      expect(events.at(-1)?.data).toMatchObject({ assistantMessageIndex: 3 });
      const publishedCount = textEvents(events).length;
      handlers.emitCliCompletedReply("The PRIVATE_MARKER mentions NO_REPLY inline.");
      handlers.emitCliCompletedReply("");
      expect(textEvents(events)).toHaveLength(publishedCount);

      context.backendResolved.textTransforms = { output: [{ from: /NO_REPLY/g, to: "" }] };
      handlers.emitCliThinkingDelta({
        text: "Checking.Hidden reasoning.",
        delta: "Hidden reasoning.",
      });
      handlers.emitCliCompletedReply(
        "The discussion is complete.\nNO_REPLY\nMEDIA:https://example.com/result.png",
        4,
      );
      expect(textEvents(events)).toHaveLength(publishedCount);

      context.backendResolved.textTransforms = {
        output: [{ from: /SILENT_MARKER/g, to: "NO_REPLY" }],
      };
      handlers.emitCliCommentaryText("Hidden commentary.");
      handlers.emitCliCompletedReply(
        "The attachment is ready.\nSILENT_MARKER\nMEDIA:https://example.com/result.png",
        5,
      );
      expect(textEvents(events)).toHaveLength(publishedCount);

      context.backendResolved.textTransforms = undefined;
      handlers.emitCliThinkingDelta({
        text: "Checking.Hidden reasoning.Final thought.",
        delta: "Final thought.",
      });
      handlers.emitCliCompletedReply("A final visible reply.");
      expect(textEvents(events).findLast(({ stream }) => stream === "thinking")?.data.text).toBe(
        "Checking.Final thought.",
      );
    } finally {
      unsubscribe();
    }
  });
});

describe("native CLI message completion", () => {
  it.each([
    { thinking: "native", silentFirst: false },
    { thinking: "tagged", silentFirst: false },
    { thinking: "native", silentFirst: true },
    { thinking: "tagged", silentFirst: true },
  ])(
    "settles $thinking reasoning at message_stop (silent first=$silentFirst)",
    ({ thinking, silentFirst }) => {
      const context = buildContext(`native-cli-${thinking}-${silentFirst}`);
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
      const events: AgentEventRuntimePayload[] = [];
      const unsubscribe = onAgentEventForRun(context.params.runId, (event) => events.push(event));
      const delivered = () =>
        textEvents(events).map(({ stream, data }) => ({
          stream,
          text: data.text ?? data.progressText ?? data.completedText,
        }));
      const pushMessage = (id: string, text: string, thought: string, tool: boolean) => {
        const sourceText = thinking === "tagged" ? `<think>${thought}</think>${text}` : text;
        const content = [
          ...(thinking === "native" ? [{ type: "thinking", thinking: thought }] : []),
          { type: "text", text: sourceText },
          ...(tool ? [{ type: "tool_use", id: "read-1", name: "Read", input: {} }] : []),
        ];
        parser.push(
          joinJsonlFrames(
            claudeStreamEvent({ type: "message_start", message: { id } }),
            ...(thinking === "native"
              ? [
                  claudeStreamEvent({
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "thinking_delta", thinking: thought },
                  }),
                ]
              : []),
            claudeTextDelta(sourceText, 1),
            ...(tool
              ? [
                  claudeStreamEvent({
                    type: "content_block_start",
                    index: 2,
                    content_block: { type: "tool_use", id: "read-1", name: "Read", input: {} },
                  }),
                ]
              : []),
            { type: "assistant", message: { id, stop_reason: null, content } },
            claudeStreamEvent({ type: "message_stop" }),
            claudeStreamEvent({ type: "message_stop" }),
            "",
          ),
        );
      };
      try {
        const firstText = silentFirst ? "No update needed.\nNO_REPLY" : "Checking the workspace.";
        pushMessage("first", firstText, "First thought.", true);
        const firstOutput = silentFirst
          ? []
          : [
              { stream: "thinking", text: "First thought." },
              { stream: "item", text: "Checking the workspace." },
            ];
        expect(delivered()).toEqual(firstOutput);
        const finalText = silentFirst ? "The check is complete." : "No answer needed.\nNO_REPLY";
        pushMessage("final", finalText, "First thought. Next thought.", false);
        const expected = silentFirst
          ? [
              { stream: "thinking", text: "First thought. Next thought." },
              { stream: "assistant", text: "The check is complete." },
            ]
          : firstOutput;
        expect(delivered()).toEqual(expected);
        for (const interim of [true, true, false]) {
          parser.push(
            joinJsonlFrames(
              {
                type: "result",
                subtype: "success",
                result: finalText,
                ...(interim ? { openclaw_interim_result: true } : {}),
              },
              "",
            ),
          );
        }
        parser.finish();
        expect(delivered()).toEqual(expected);
        const output = parser.getOutput();
        if (!output) {
          throw new Error("Expected the completed native CLI output");
        }
        expect(output).toMatchObject({ text: finalText, textParts: [finalText] });
        if (silentFirst) {
          const result = buildCliRunResult({
            context,
            output,
            assistantText: finalText,
            usedHistoryPrompt: false,
            userTurnHandled: true,
            sessionBindingDisabled: true,
            preparedContextAgentMeta: {},
          });
          expect(textEvents(events).at(-1)?.data.assistantMessageIndex).toBe(0);
          expect(getReplyPayloadMetadata(result.payloads?.[0] ?? {})?.assistantMessageIndex).toBe(
            0,
          );
        }
      } finally {
        unsubscribe();
      }
    },
  );
});
