import { describe, expect, it } from "vitest";
import { onAgentEventForRun, type AgentEventRuntimePayload } from "../../infra/agent-events.js";
import { createCliEventHandlers } from "./execute-events.js";
import { buildContext, buildToolTracking } from "./execute-events.tool-result-args.test-support.js";

describe("CLI completed reply publication", () => {
  it.each([
    "The discussion is already complete.\nNO_REPLY",
    "Nobody asked me for an answer.\n(NO_REPLY)\n\n",
    "Die Frage ist schon beantwortet.\nNO_REPLY.",
  ])("streams previews then clears a silent accepted reply: %j", (text) => {
    const context = buildContext("silent-cli-segment");
    const handlers = createCliEventHandlers({
      context,
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const events: AgentEventRuntimePayload[] = [];
    const unsubscribe = onAgentEventForRun(context.params.runId, (event) => events.push(event));
    try {
      handlers.emitCliThinkingDelta({ text: "Checking.", delta: "Checking." });
      handlers.emitCliCommentaryText("Looking up the answer.");
      handlers.emitCliAssistantDelta({ text: "The discussion", delta: "The discussion" });
      expect(events.map(({ stream, data }) => [stream, data.text ?? data.progressText])).toEqual([
        ["thinking", "Checking."],
        ["item", "Looking up the answer."],
        ["assistant", "The discussion"],
      ]);
      expect(handlers.hasObservedCliActivity()).toBe(true);
      handlers.emitCliCompletedReply(text, 0);
      expect(events.slice(-2).map(({ stream, data }) => ({ stream, data }))).toEqual([
        {
          stream: "assistant",
          data: {
            itemId: "cli-assistant:silent-cli-segment",
            text: "",
            delta: "",
            replace: true,
          },
        },
        {
          stream: "thinking",
          data: {
            itemId: "cli-thinking:silent-cli-segment",
            text: "",
            delta: "",
            isReasoningSnapshot: true,
          },
        },
      ]);
      expect(events.some(({ data }) => typeof data.completedText === "string")).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it.each([
    { from: /NO_REPLY/g, to: "", text: "No update needed.\nNO_REPLY" },
    { from: /SILENT_MARKER/g, to: "NO_REPLY", text: "No update needed.\nSILENT_MARKER" },
  ])("clears silent intent before or after output transforms: $text", ({ from, to, text }) => {
    const context = buildContext("transformed-cli-segment");
    context.backendResolved.textTransforms = { output: [{ from, to }] };
    const handlers = createCliEventHandlers({
      context,
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const events: AgentEventRuntimePayload[] = [];
    const unsubscribe = onAgentEventForRun(context.params.runId, (event) => events.push(event));
    try {
      handlers.emitCliCompletedReply(text);
      expect(events.map(({ data }) => data.text)).toEqual(["", ""]);
      expect(events.some(({ data }) => typeof data.completedText === "string")).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it("keeps accepted substantive replies separate from previews and terminal echoes", () => {
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
      const text = "The PRIVATE_MARKER mentions NO_REPLY inline.";
      handlers.emitCliAssistantDelta({ text, delta: text });
      handlers.emitCliCompletedReply(text, 3);
      handlers.emitCliCompletedReply(text);
      expect(events.map(({ data }) => data)).toEqual([
        {
          itemId: "cli-assistant:visible-cli-segment",
          text: "The answer mentions NO_REPLY inline.",
          delta: "The answer mentions NO_REPLY inline.",
        },
        { assistantMessageIndex: 3, completedText: "The answer mentions NO_REPLY inline." },
      ]);
    } finally {
      unsubscribe();
    }
  });
});
