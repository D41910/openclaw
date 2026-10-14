import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi, type Mock } from "vitest";
import type { RunEmbeddedAgentInternalParams as AgentRunParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { mockAcceptedWaitingStatusRun } from "./agent-runner.runreplyagent.waiting-status.cases.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { FollowupRun } from "./queue.js";
import {
  REPLY_OPERATION_RUN_STATE,
  resolveReplyOperationAgentTurn,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";

type RequiredReplyFixture = {
  createMinimalRun: (params?: {
    opts?: InternalGetReplyOptions;
    blockStreamingEnabled?: boolean;
    currentInboundEventKind?: FollowupRun["currentInboundEventKind"];
    sessionCtx?: { MessageSid?: string };
    runOverrides?: Partial<FollowupRun["run"]>;
  }) => {
    followupRun: FollowupRun;
    run: () => Promise<ReplyPayload | ReplyPayload[] | undefined>;
  };
  state: {
    runEmbeddedAgentMock: Pick<Mock, "mockImplementationOnce" | "mockResolvedValueOnce">;
  };
};

export function registerRequiredReplyCompletionCases({
  createMinimalRun,
  state,
}: RequiredReplyFixture): void {
  it("reports missing output after filtering silentExpected narration", async () => {
    const onPartialReply = vi.fn();
    const onBlockReply = vi.fn();
    const onReasoningStream = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      expect(params.silentExpected).toBe(true);
      await params.onReasoningStream?.({ text: "Reasoning:\nI am trying to send NO_REPLY now." });
      await params.onPartialReply?.({ text: "I am trying to send NO_REPLY now." });
      await params.onBlockReply?.({ text: "I am trying to send NO_REPLY now." });
      return { payloads: [{ text: "I am trying to send NO_REPLY now." }], meta: {} };
    });

    const { run } = createMinimalRun({
      opts: { isHeartbeat: false, onPartialReply, onBlockReply, onReasoningStream },
      blockStreamingEnabled: true,
      runOverrides: { silentExpected: true, terminalReplyExpectation: "optional" },
    });
    const res = await run();

    expect(onReasoningStream).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      text: "No answer was returned. Ask again if you still need one.",
      isError: true,
      isStatusNotice: true,
    });
  });

  it.each(["required", "optional"] as const)(
    "honors %s completion with a prepared silent outcome",
    async (terminalReplyExpectation) => {
      const onPartialReply = vi.fn();
      const onBlockReply = vi.fn();
      const onReasoningStream = vi.fn();
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
        expect(params.silentExpected).toBe(true);
        return {
          payloads: [],
          meta: { finalAssistantRawText: "NO_REPLY", terminalReply: { disposition: "silent" } },
        };
      });

      const { run } = createMinimalRun({
        opts: { isHeartbeat: false, onPartialReply, onBlockReply, onReasoningStream },
        blockStreamingEnabled: true,
        runOverrides: { silentExpected: true, terminalReplyExpectation },
      });
      const res = await run();

      expect(onReasoningStream).not.toHaveBeenCalled();
      expect(onPartialReply).not.toHaveBeenCalled();
      expect(onBlockReply).not.toHaveBeenCalled();
      expect(res).toBeUndefined();
    },
  );

  it.each(["required", "optional", "result-required"] as const)(
    "discards unsent earlier output after a %s silent final",
    async (terminalReplyExpectation) => {
      state.runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "Earlier answer" }, { text: "Unsent confirmation" }],
        meta: {
          finalAssistantRawText: "NO_REPLY",
          terminalReply: { disposition: "silent" },
        },
      });
      const onAgentRunTerminalOutcome = vi.fn();
      const { run } = createMinimalRun({
        runOverrides: { terminalReplyExpectation },
        opts: { onAgentRunTerminalOutcome },
      });
      await expect(run()).resolves.toBeUndefined();
      if (terminalReplyExpectation === "result-required") {
        expect(onAgentRunTerminalOutcome).toHaveBeenLastCalledWith("failed");
      } else {
        expect(onAgentRunTerminalOutcome).not.toHaveBeenCalledWith("failed");
      }
    },
  );

  it("returns one missing-answer notice per user input despite repeated empty stream callbacks", async () => {
    for (const messageId of ["empty-input-one", "empty-input-two"]) {
      const onPartialReply = vi.fn();
      const onBlockReply = vi.fn();
      const onAgentRunTerminalOutcome = vi.fn();
      state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
        await params.onPartialReply?.({ text: "" });
        await params.onPartialReply?.({ text: "" });
        await params.onBlockReply?.({ text: "" });
        await params.onBlockReply?.({ text: "" });
        return { payloads: [], meta: {} };
      });
      const { run } = createMinimalRun({
        sessionCtx: { MessageSid: messageId },
        blockStreamingEnabled: true,
        opts: { onPartialReply, onBlockReply, onAgentRunTerminalOutcome },
      });
      const result = await run();
      const payloads = Array.isArray(result) ? result : result ? [result] : [];
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({
        text: "No answer was returned. Ask again if you still need one.",
        isError: true,
        isStatusNotice: true,
        replyToId: messageId,
      });
      expect(onPartialReply).not.toHaveBeenCalled();
      expect(onBlockReply).not.toHaveBeenCalled();
      expect(onAgentRunTerminalOutcome).toHaveBeenLastCalledWith("failed");
    }
  });

  it("delivers a prepared literal NO_REPLY without classifying it again", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "NO_REPLY" }],
      meta: {
        finalAssistantRawText: "NO_REPLY\nNO_REPLY",
        finalAssistantVisibleText: "NO_REPLY",
        terminalReply: { disposition: "visible", text: "NO_REPLY" },
      },
    });
    const { run } = createMinimalRun();
    await expect(run()).resolves.toMatchObject({ text: "NO_REPLY" });
  });

  it.each([
    { label: "empty output", payloads: [] },
    { label: "reasoning-only output", payloads: [{ text: "internal", isReasoning: true }] },
    { label: "commentary-only output", payloads: [{ text: "internal", isCommentary: true }] },
    { label: "directive-only output", payloads: [{ text: "[[reply_to_current]]" }] },
  ])("surfaces successful $label through normal reply delivery", async ({ payloads }) => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads, meta: {} });
    const { run } = createMinimalRun({
      runOverrides: { config: { channels: { whatsapp: { replyToMode: "first" } } } },
    });

    const result = await run();
    const payloadsResult = Array.isArray(result) ? result : [result];

    expect(payloadsResult).toContainEqual(
      expect.objectContaining({
        text: "No answer was returned. Ask again if you still need one.",
        isError: true,
        replyToId: "msg",
      }),
    );
  });

  it("surfaces a marked fallback for an empty message-tool-only completion", async () => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
    const { run } = createMinimalRun({
      opts: { sourceReplyDeliveryMode: "message_tool_only" },
    });

    const result = await run();
    const payload = Array.isArray(result) ? result[0] : result;

    expect(payload).toMatchObject({
      text: "No answer was returned. Ask again if you still need one.",
      isError: true,
    });
    expect(getReplyPayloadMetadata(payload ?? {})?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it.each(["automatic", "message_tool_only"] as const)(
    "delivers a core missing-answer error exactly once through %s",
    async (sourceReplyDeliveryMode) => {
      state.runEmbeddedAgentMock.mockResolvedValueOnce({
        payloads: [
          setReplyPayloadMetadata(
            {
              text: "No answer was returned. Ask again if you still need one.",
              isError: true,
              isStatusNotice: true,
            },
            { assistantTranscriptOwned: true },
          ),
        ],
        meta: {
          error: {
            kind: "incomplete_turn",
            message: "No answer was returned. Ask again if you still need one.",
          },
          terminalReply: { disposition: "silent" },
        },
      });
      const { run } = createMinimalRun({
        opts: { sourceReplyDeliveryMode },
        runOverrides: { sourceReplyDeliveryMode },
      });
      const result = await run();
      const payloads = Array.isArray(result) ? result : result ? [result] : [];
      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({
        text: "No answer was returned. Ask again if you still need one.",
        isError: true,
        isStatusNotice: true,
      });
      expect(
        getReplyPayloadMetadata(expectDefined(payloads[0], "missing-answer notice")),
      ).toMatchObject({
        assistantTranscriptOwned: true,
        deliverDespiteSourceReplySuppression: true,
      });
    },
  );

  it.each([
    { lane: "reasoning", payload: { text: "internal", isReasoning: true } },
    { lane: "commentary", payload: { text: "internal", isCommentary: true } },
  ])("does not let streamed $lane suppress the empty-reply fallback", async ({ payload }) => {
    const onBlockReply = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: AgentRunParams) => {
      await params.onBlockReply?.(payload);
      return { payloads: [], meta: {} };
    });
    const { run } = createMinimalRun({
      blockStreamingEnabled: true,
      opts: {
        onBlockReply,
        reasoningPayloadsEnabled: true,
        commentaryPayloadsEnabled: true,
      },
    });

    const result = await run();
    const payloads = Array.isArray(result) ? result : [result];

    expect(onBlockReply).toHaveBeenCalled();
    expect(onBlockReply.mock.calls[0]?.[0]).toEqual(expect.objectContaining(payload));
    expect(payloads).toContainEqual(
      expect.objectContaining({
        text: "No answer was returned. Ask again if you still need one.",
        isError: true,
      }),
    );
  });

  it.each([
    {
      label: "NO_REPLY",
      pendingContinuation: false,
      expectation: "required",
      result: {
        payloads: [],
        meta: {
          finalAssistantVisibleText: "",
          terminalReply: { disposition: "silent" },
        },
      },
      missing: false,
    },
    {
      label: "optional NO_REPLY",
      pendingContinuation: false,
      expectation: "optional",
      result: {
        payloads: [],
        meta: {
          finalAssistantVisibleText: "",
          terminalReply: { disposition: "silent" },
        },
      },
      missing: false,
    },
    {
      label: "pending tool continuation",
      pendingContinuation: true,
      expectation: "required",
      result: { payloads: [], meta: { pendingToolCalls: [{ name: "hosted_tool" }] } },
      missing: false,
    },
  ] as const)(
    "settles $label according to its reply obligation",
    async ({ result, pendingContinuation, expectation, missing }) => {
      state.runEmbeddedAgentMock.mockResolvedValueOnce(result);
      const onPendingContinuation = vi.fn();
      const { run } = createMinimalRun({
        opts: { onPendingContinuation },
        runOverrides: { terminalReplyExpectation: expectation },
      });

      if (missing) {
        await expect(run()).resolves.toMatchObject({ isError: true });
      } else {
        await expect(run()).resolves.toBeUndefined();
      }
      expect(onPendingContinuation).toHaveBeenCalledTimes(pendingContinuation ? 1 : 0);
    },
  );

  it("delivers a required yield acknowledgment despite silentExpected in message-tool-only mode", async () => {
    await mockAcceptedWaitingStatusRun(state.runEmbeddedAgentMock, {
      payloads: [],
      meta: {
        durationMs: 0,
        yielded: true,
        yieldAcknowledgment: "Research started; results will follow.",
      },
    });
    const { run } = createMinimalRun({
      opts: { sourceReplyDeliveryMode: "message_tool_only" },
      runOverrides: { silentExpected: true, terminalReplyExpectation: "required" },
    });

    const result = await run();
    const payloads = Array.isArray(result) ? result : result ? [result] : [];

    expect(payloads.map((payload) => payload.text)).toEqual([
      "Research started; results will follow.",
    ]);
    expect(getReplyPayloadMetadata(payloads[0] ?? {})).toMatchObject({
      continuationStatus: true,
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it.each([
    {
      label: "room event",
      params: { currentInboundEventKind: "room_event" as const, opts: { isHeartbeat: false } },
    },
    {
      label: "internal handoff",
      params: {
        opts: { isHeartbeat: false },
        runOverrides: {
          inputProvenance: { kind: "internal_system" as const, sourceTool: "restart-sentinel" },
        },
      },
    },
    { label: "heartbeat", params: { opts: { isHeartbeat: true } } },
  ])("records failed empty $label completions without a chat notice", async ({ params }) => {
    state.runEmbeddedAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
    const onAgentRunTerminalOutcome = vi.fn();
    const runState: ReplyOperationRunState = {};
    const { run } = createMinimalRun({
      ...params,
      opts: { ...params.opts, onAgentRunTerminalOutcome, [REPLY_OPERATION_RUN_STATE]: runState },
    });

    await expect(run()).resolves.toBeUndefined();
    expect(onAgentRunTerminalOutcome).toHaveBeenLastCalledWith("failed");
    expect(resolveReplyOperationAgentTurn(runState)).toBe("failed");
  });

  it("retains a failed heartbeat result without lifting its missing-answer notice", async () => {
    const onAgentRunTerminalOutcome = vi.fn();
    const runState: ReplyOperationRunState = {};
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [
        setReplyPayloadMetadata(
          {
            text: "No answer was returned. Ask again if you still need one.",
            isError: true,
            isStatusNotice: true,
          },
          { assistantTranscriptOwned: true },
        ),
      ],
      meta: {
        error: {
          kind: "incomplete_turn",
          message: "No answer was returned. Ask again if you still need one.",
        },
      },
    });
    const { run } = createMinimalRun({
      opts: { isHeartbeat: true, onAgentRunTerminalOutcome, [REPLY_OPERATION_RUN_STATE]: runState },
    });
    await expect(run()).resolves.toBeUndefined();
    expect(onAgentRunTerminalOutcome).toHaveBeenLastCalledWith("failed");
    expect(resolveReplyOperationAgentTurn(runState)).toBe("failed");
  });
}
