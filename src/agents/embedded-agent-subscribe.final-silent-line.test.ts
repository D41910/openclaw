import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { onAgentEventForRun } from "../infra/agent-events.js";
import type { AssistantMessage } from "../llm/types.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

const subscriptions: ReturnType<typeof createSubscribedSessionHarness>["subscription"][] = [];
afterEach(() => {
  for (const subscription of subscriptions.splice(0)) {
    subscription.unsubscribe();
  }
});

function setup(options: { deferred?: boolean; reasoning?: "on" | "stream" } = {}) {
  const onPartialReply = vi.fn();
  const onBlockReply = vi.fn();
  const onAgentEvent = vi.fn();
  const onReasoningStream = vi.fn();
  const harness = createSubscribedSessionHarness({
    runId: "final-line-silence",
    onPartialReply,
    onBlockReply,
    onAgentEvent,
    onReasoningStream,
    ...(options.reasoning ? { reasoningMode: options.reasoning } : {}),
    blockReplyBreak: "text_end",
    blockReplyChunking: { minChars: 1, maxChars: 40, breakPreference: "newline" },
    ...(options.deferred ? { onBeforeTerminalDelivery: async () => undefined } : {}),
  });
  subscriptions.push(harness.subscription);
  const answer = (text: string) =>
    makeAgentAssistantMessage({ api: "ollama", content: [{ type: "text", text }] });
  const start = () => harness.emit({ type: "message_start", message: answer("") });
  const delta = (text: string, fullText = text) => {
    const message = answer(fullText);
    harness.emit({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", delta: text, contentIndex: 0, partial: message },
    });
  };
  const end = (text: string) => {
    const message = answer(text);
    harness.emit({ type: "message_end", message });
    return message;
  };
  const assistantEvents = () =>
    onAgentEvent.mock.calls.filter(([event]) => event.stream === "assistant");
  const publishedText = () => [
    ...onPartialReply.mock.calls.map(([payload]) => payload.text ?? ""),
    ...onBlockReply.mock.calls.map(([payload]) => payload.text ?? ""),
    ...assistantEvents().map(([event]) => event.data.text ?? ""),
  ];
  return {
    ...harness,
    start,
    delta,
    end,
    onPartialReply,
    onBlockReply,
    onAgentEvent,
    onReasoningStream,
    assistantEvents,
    publishedText,
  };
}

describe("assistant message final-line silence", () => {
  it.each(["NO_REPLY", "**NO_REPLY**", "\tNO_REPLY.  \n\n"])(
    "streams a live preview and retracts it when the final %j is known",
    async (token) => {
      const h = setup();
      const reasoning =
        "This is a group conversation.\nThe follow-up does not require another answer.";
      h.start();
      h.delta(reasoning);
      expect(h.onPartialReply).toHaveBeenCalledWith(expect.objectContaining({ text: reasoning }));
      expect(h.assistantEvents()).toContainEqual([
        expect.objectContaining({ data: expect.objectContaining({ text: reasoning }) }),
      ]);
      const previewItemId = h.assistantEvents().at(-1)?.[0].data.itemId;
      expect(previewItemId).toEqual(expect.any(String));
      expect(h.onBlockReply).not.toHaveBeenCalled();
      h.delta(`\n${token}`, `${reasoning}\n${token}`);
      h.end(`${reasoning}\n${token}`);
      await h.subscription.waitForPendingEvents();
      expect(h.onPartialReply).toHaveBeenLastCalledWith(expect.objectContaining({ text: "" }));
      expect(h.assistantEvents().at(-1)).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            text: "",
            delta: "",
            replace: true,
            itemId: previewItemId,
          }),
        }),
      ]);
      expect(h.onBlockReply).not.toHaveBeenCalled();
      expect(h.subscription.assistantTexts).toEqual(["NO_REPLY"]);
    },
  );

  it("streams an ordinary answer before committing it at message completion", async () => {
    const h = setup();
    const text = "The marker NO_REPLY can be mentioned in an ordinary answer.";
    h.start();
    h.delta(text);
    expect(h.onPartialReply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text }));
    expect(h.onBlockReply).not.toHaveBeenCalled();
    h.end(text);
    await h.subscription.waitForPendingEvents();
    expect(h.onPartialReply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text }));
    expect(h.onBlockReply.mock.calls.map(([payload]) => payload.text).join(" ")).toBe(text);
    expect(h.assistantEvents()).toHaveLength(1);
  });

  it("keeps attachments when final-line silence retracts the preview", async () => {
    const h = setup();
    const reasoning =
      "The requested attachment is already prepared.\nNo extra explanation is needed.";
    h.start();
    h.delta(reasoning);
    h.end(`${reasoning}\nNO_REPLY\nMEDIA:/tmp/final-silent-line.png`);
    await h.subscription.waitForPendingEvents();
    expect(h.onPartialReply).toHaveBeenLastCalledWith(expect.objectContaining({ text: "" }));
    expect(h.onBlockReply.mock.calls.map(([payload]) => payload.text).filter(Boolean)).toEqual([]);
    expect(h.onBlockReply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ mediaUrls: ["/tmp/final-silent-line.png"] }),
      expect.anything(),
    );
    expect(h.subscription.assistantTexts).toEqual(["NO_REPLY"]);
  });

  it("reports rejected media after retracting the silent message's preview", async () => {
    const h = setup();
    const reasoning = "The attachment finishes this task without another explanation.";
    h.start();
    h.delta(reasoning);
    h.end(`${reasoning}\nNO_REPLY\nMEDIA:media://inbound/`);
    await h.subscription.waitForPendingEvents();
    const warning =
      "⚠️ Media not attached: Use a public HTTPS URL without credentials or attach a local file by a safe path.";
    expect(h.onPartialReply).toHaveBeenCalledWith(expect.objectContaining({ text: reasoning }));
    expect(h.onPartialReply).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: warning, replace: true }),
    );
    expect(h.assistantEvents().at(-1)?.[0].data).toMatchObject({ text: warning, replace: true });
    expect(h.onBlockReply.mock.calls.map(([payload]) => payload.text)).toEqual([warning]);
    expect(h.subscription.assistantTexts).toEqual(["NO_REPLY"]);
  });

  it.each([undefined, "final_answer", "commentary"] as const)(
    "discards earlier text blocks without suppressing the following message (last phase: %s)",
    async (lastPhase) => {
      const phased = lastPhase !== undefined;
      const h = setup();
      const reasoning = "No additional reply is needed for this group discussion.";
      h.start();
      h.delta(reasoning);
      const silent = makeAgentAssistantMessage({
        api: phased ? "openai-responses" : "ollama",
        content: [
          {
            type: "text",
            text: reasoning,
            ...(phased
              ? { textSignature: JSON.stringify({ v: 1, id: "answer-0", phase: "final_answer" }) }
              : {}),
          },
          {
            type: "text",
            text: "NO_REPLY",
            ...(phased
              ? { textSignature: JSON.stringify({ v: 1, id: "answer-1", phase: lastPhase }) }
              : {}),
          },
        ],
      });
      h.emit({
        type: "message_update",
        message: silent,
        assistantMessageEvent: {
          type: "text_delta",
          delta: "NO_REPLY",
          contentIndex: 1,
          partial: silent,
        },
      });
      h.emit({ type: "message_end", message: silent });
      await h.subscription.waitForPendingEvents();
      expect(h.onPartialReply).toHaveBeenLastCalledWith(expect.objectContaining({ text: "" }));
      expect(h.onBlockReply).not.toHaveBeenCalled();
      expect(h.subscription.assistantTexts).toEqual(["NO_REPLY"]);
      h.start();
      h.delta("Here is the requested answer.");
      h.end("Here is the requested answer.");
      await h.subscription.waitForPendingEvents();
      expect(h.onPartialReply).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "Here is the requested answer." }),
      );
      expect(h.onBlockReply.mock.calls.some(([payload]) => payload.text?.includes(reasoning))).toBe(
        false,
      );
    },
  );

  it("keeps commentary after a leading silent final-answer block", async () => {
    const h = setup();
    const commentary = "I will inspect the attachment.";
    const blocks = [
      {
        type: "text" as const,
        text: "NO_REPLY",
        textSignature: JSON.stringify({ v: 1, id: "answer", phase: "final_answer" }),
      },
      {
        type: "text" as const,
        text: commentary,
        textSignature: JSON.stringify({ v: 1, id: "progress", phase: "commentary" }),
      },
    ];
    h.emit({
      type: "message_start",
      message: makeAgentAssistantMessage({ api: "openai-responses", content: [] }),
    });
    for (const [contentIndex, block] of blocks.entries()) {
      const message = makeAgentAssistantMessage({
        api: "openai-responses",
        content: blocks.slice(0, contentIndex + 1),
      });
      h.emit({
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex,
          delta: block.text,
          partial: message,
        },
      });
    }
    expect(h.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "item",
        data: expect.objectContaining({ progressText: commentary }),
      }),
    );
    h.emit({
      type: "message_end",
      message: makeAgentAssistantMessage({ api: "openai-responses", content: blocks }),
    });
    await h.subscription.waitForPendingEvents();
    const preambles = h.onAgentEvent.mock.calls
      .filter(([event]) => event.stream === "item" && event.data.kind === "preamble")
      .map(([event]) => event.data.progressText);
    expect(preambles).toEqual([commentary]);
    expect(h.publishedText().filter(Boolean)).toEqual([]);
  });

  it("replaces a prepared source correction without losing reserved tool media", async () => {
    const h = setup();
    await h.subscription.runToolLifecycle({
      toolName: "read",
      toolCallId: "prepared-voice",
      args: {},
      execute: async (onStart) => {
        onStart();
        return { details: { media: { mediaUrl: "/tmp/reply.opus", audioAsVoice: true } } };
      },
    });
    h.start();
    h.delta("[[audio_as_voice]]The current value is one for this item. Keep the final result.");
    expect(h.onBlockReply).not.toHaveBeenCalled();
    h.end(
      "[[audio_as_voice]]The current value is thirty-three for this item. Keep the final result.",
    );
    await h.subscription.waitForPendingEvents();
    const replies = h.onBlockReply.mock.calls.map(([payload]) => payload);
    const text = replies.map((payload) => payload.text ?? "").join(" ");
    expect(text).toContain("The current value is thirty-three for this item.");
    expect(text).not.toContain("The current value is one for this item.");
    expect(replies.flatMap((payload) => payload.mediaUrls ?? [])).toEqual(["/tmp/reply.opus"]);
    expect(h.subscription.getPendingToolMediaReply()).toBeNull();
    expect(h.subscription.hasToolMediaBlockReply()).toBe(true);
  });

  it("streams previews while terminal-hook custody holds durable delivery", async () => {
    const h = setup({ deferred: true });
    h.start();
    h.delta("The answer is ready.");
    const message = h.end("The answer is ready.");
    expect(h.onPartialReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "The answer is ready." }),
    );
    expect(h.onBlockReply).not.toHaveBeenCalled();
    h.emit({ type: "agent_end", messages: [message], willRetry: false });
    await h.subscription.waitForPendingEvents();
    expect(h.onPartialReply).toHaveBeenCalledOnce();
    expect(h.onBlockReply).toHaveBeenCalledOnce();
  });

  it.each([
    { silent: false, deferred: false },
    { silent: true, deferred: false },
    { silent: false, deferred: true },
    { silent: true, deferred: true },
  ])(
    "settles held text without message_end (silent: $silent, hook: $deferred)",
    async ({ silent, deferred }) => {
      const h = setup({ deferred });
      const text = `An interrupted answer is still recoverable.${silent ? "\nNO_REPLY" : ""}`;
      h.start();
      h.delta(text);
      expect(h.onBlockReply).not.toHaveBeenCalled();
      h.emit({ type: "agent_end", messages: [], willRetry: false });
      await h.subscription.waitForPendingEvents();
      const delivered = h.onBlockReply.mock.calls.map(([payload]) => payload.text ?? "").join(" ");
      expect(delivered).toBe(silent ? "" : text);
    },
  );

  it.each([
    { completion: "interrupted", media: "https://example.invalid/result.png" },
    { completion: "interrupted", media: "media://inbound/" },
    { completion: "commentary", media: "https://example.invalid/result.png" },
    { completion: "commentary", media: "media://inbound/" },
  ] as const)(
    "retracts native reasoning when $completion silence precedes MEDIA:$media",
    async ({ completion, media }) => {
      const h = setup({ reasoning: "stream" });
      const thinkingEvents: unknown[] = [];
      onTestFinished(
        onAgentEventForRun("final-line-silence", (event) => {
          if (event.stream === "thinking") {
            thinkingEvents.push(event.data);
          }
        }),
      );
      const thinking = { type: "thinking" as const, thinking: "Private model analysis." };
      h.start();
      const thought = makeAgentAssistantMessage({ api: "ollama", content: [thinking] });
      h.emit({
        type: "message_update",
        message: thought,
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: thinking.thinking,
          partial: thought,
        },
      });
      const text = `This group turn does not require an answer.\nNO_REPLY\nMEDIA:${media}`;
      if (completion === "interrupted") {
        h.delta(text);
        h.emit({ type: "agent_end", messages: [], willRetry: false });
      } else {
        const message = makeAgentAssistantMessage({
          api: "ollama",
          content: [
            thinking,
            {
              type: "text",
              text,
              textSignature: JSON.stringify({ v: 1, id: "progress", phase: "commentary" }),
            },
          ],
        });
        h.emit({
          type: "message_update",
          message,
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 1,
            delta: text,
            partial: message,
          },
        });
        h.emit({ type: "message_end", message });
      }
      await h.subscription.waitForPendingEvents();
      expect(h.onReasoningStream).toHaveBeenCalledWith(
        expect.objectContaining({ text: thinking.thinking }),
      );
      expect(h.onReasoningStream).toHaveBeenLastCalledWith(expect.objectContaining({ text: "" }));
      expect(thinkingEvents.at(-1)).toMatchObject({ text: "", replace: true });
      expect(h.onBlockReply.mock.calls.map(([payload]) => payload.text).filter(Boolean)).toEqual(
        [],
      );
    },
  );

  it("streams commentary before the message completes", async () => {
    const h = setup();
    const message: AssistantMessage = makeAgentAssistantMessage({
      content: [
        {
          type: "text",
          text: "I will inspect the attachment.",
          textSignature: JSON.stringify({ v: 1, id: "commentary", phase: "commentary" }),
        },
      ],
    });
    h.emit({ type: "message_start", message });
    h.emit({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        delta: "I will inspect the attachment.",
        contentIndex: 0,
        partial: message,
      },
    });
    expect(h.assistantEvents()).toEqual([]);
    expect(h.onPartialReply).not.toHaveBeenCalled();
    expect(h.publishedText()).toEqual([]);
    expect(h.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "item",
        data: expect.objectContaining({ progressText: "I will inspect the attachment." }),
      }),
    );
    h.emit({ type: "message_end", message });
    await h.subscription.waitForPendingEvents();
    expect(h.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "item",
        data: expect.objectContaining({ progressText: "I will inspect the attachment." }),
      }),
    );
  });

  it.each(["on", "stream"] as const)(
    "retracts same-message commentary and native reasoning after a silent final (%s)",
    async (reasoning) => {
      const h = setup({ reasoning });
      const thinkingEvents: unknown[] = [];
      onTestFinished(
        onAgentEventForRun("final-line-silence", (event) => {
          if (event.stream === "thinking") {
            thinkingEvents.push(event.data);
          }
        }),
      );
      const thinking = { type: "thinking" as const, thinking: "Private model analysis." };
      const commentary = {
        type: "text" as const,
        text: "I am considering whether to respond.",
        textSignature: JSON.stringify({ v: 1, id: "progress", phase: "commentary" }),
      };
      const final = {
        type: "text" as const,
        text: "NO_REPLY",
        textSignature: JSON.stringify({ v: 1, id: "final", phase: "final_answer" }),
      };
      h.emit({ type: "message_start", message: makeAgentAssistantMessage({ content: [] }) });
      const thought = makeAgentAssistantMessage({ content: [thinking] });
      h.emit({
        type: "message_update",
        message: thought,
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: thinking.thinking,
          partial: thought,
        },
      });
      const progress = makeAgentAssistantMessage({ content: [thinking, commentary] });
      h.emit({
        type: "message_update",
        message: progress,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 1,
          delta: commentary.text,
          partial: progress,
        },
      });
      if (reasoning === "stream") {
        expect(h.onReasoningStream).toHaveBeenCalledWith(
          expect.objectContaining({ text: thinking.thinking }),
        );
      }
      expect(thinkingEvents).toContainEqual(expect.objectContaining({ text: thinking.thinking }));
      expect(h.onAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: "item",
          data: expect.objectContaining({ progressText: commentary.text }),
        }),
      );
      h.emit({
        type: "message_end",
        message: makeAgentAssistantMessage({ content: [thinking, commentary, final] }),
      });
      await h.subscription.waitForPendingEvents();
      if (reasoning === "stream") {
        expect(h.onReasoningStream).toHaveBeenLastCalledWith(expect.objectContaining({ text: "" }));
      }
      expect(thinkingEvents.at(-1)).toMatchObject({ text: "", replace: true });
      expect(h.onBlockReply).not.toHaveBeenCalled();
      expect(
        h.onAgentEvent.mock.calls.findLast(([event]) => event.stream === "item")?.[0].data,
      ).toMatchObject({ progressText: "" });
    },
  );
});
