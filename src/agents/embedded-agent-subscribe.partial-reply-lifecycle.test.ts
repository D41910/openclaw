import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { onAgentEventForRun } from "../infra/agent-events.js";

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  isEnabled: vi.fn(() => false),
  trace: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => logger,
}));

import {
  createStubSessionHarness,
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitMessageStartAndEndForAssistantText,
} from "./embedded-agent-subscribe.e2e-harness.js";
import {
  measureNativeReasoningSubscription,
  NATIVE_REASONING_BENCH_PREFIX,
} from "./embedded-agent-subscribe.native-reasoning.test-support.js";
import { createReplyDelivery } from "./embedded-agent-subscribe.reply-delivery.js";
import { createEmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.run-state.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";

function createDelivery(params: Omit<SubscribeEmbeddedAgentSessionParams, "session">) {
  const { session } = createStubSessionHarness();
  const options = { ...params, session };
  return createReplyDelivery({
    params: options,
    state: createEmbeddedAgentSubscribeState(options),
    log: logger,
  });
}

function emitPartialThenProviderFailure(emit: (event: unknown) => void): void {
  emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: "partial answer" },
  });
  const failedAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "partial answer" }],
    stopReason: "error",
    errorMessage: "provider failed after partial",
    provider: "test-provider",
    model: "test-model",
  };
  emit({ type: "message_end", message: failedAssistant });
  emit({ type: "agent_end", messages: [failedAssistant], willRetry: false });
}

describe("subscribeEmbeddedAgentSession partial reply lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("joins a partial reply task created while terminal events settle", async () => {
    const partial = createDeferred();
    const onPartialReply = vi.fn(() => partial.promise);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-partial-provider-failure",
      onBeforeTerminalDelivery: async () => undefined,
      onPartialReply,
    });

    emitPartialThenProviderFailure(emit);
    let settled = false;
    const settlement = subscription.waitForPendingEvents().then(() => {
      settled = true;
    });

    await subscription.waitForPendingEvents({ includePartialReplies: false });
    expect(onPartialReply).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    partial.resolve();
    await settlement;
    expect(settled).toBe(true);
  });

  it("contains and logs a rejected partial reply after unsubscribe", async () => {
    const callbackError = new Error("draft send rejected");
    const partial = createDeferred();
    const onPartialReply = vi.fn(() => partial.promise);
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-partial-rejection",
      onPartialReply,
    });

    emitMessageStartAndEndForAssistantText({ emit, text: "partial answer" });
    expect(onPartialReply).toHaveBeenCalledOnce();
    emit({ type: "message_start", message: { role: "assistant", content: [] } });
    emitAssistantTextDelta({ emit, delta: " queued" });
    emitAssistantTextDelta({ emit, delta: " tail" });
    await subscription.waitForPendingEvents({ includePartialReplies: false });
    expect(onPartialReply).toHaveBeenCalledOnce();
    subscription.unsubscribe();
    partial.reject(callbackError);
    await expect(subscription.waitForPendingEvents()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      `assistant partial reply callback failed: ${String(callbackError)}`,
    );
    expect(onPartialReply).toHaveBeenCalledOnce();
  });

  it("keeps nested tool execution independent of the held answer", async () => {
    const pending = createDeferred();
    const starts: string[] = [];
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-partial-nested-tool",
      onPartialReply: (payload) => {
        starts.push(`partial:${payload.text}`);
        return pending.promise;
      },
      onAgentEvent: (event) => {
        if (event.stream === "tool" && event.data.phase === "start") {
          starts.push("tool");
        }
      },
    });
    try {
      emit({ type: "message_start", message: { role: "assistant", content: [] } });
      for (const delta of ["First", " second", " third"]) {
        emitAssistantTextDelta({ emit, delta });
      }
      await subscription.waitForPendingEvents({ includePartialReplies: false });
      expect(starts).toEqual([]);
      const tool = {
        toolName: "read",
        toolCallId: "read-after-text",
        args: { path: "/tmp/input" },
      };
      await subscription.runToolLifecycle({
        ...tool,
        execute: async (onStart) => {
          onStart();
          return { content: [{ type: "text", text: "Read complete." }] };
        },
      });
      await subscription.waitForPendingEvents({ includePartialReplies: false });
      expect(starts).toEqual(["tool"]);
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "First second third" }],
        },
      });
      await subscription.waitForPendingEvents({ includePartialReplies: false });
      expect(starts).toEqual(["tool", "partial:First second third"]);
    } finally {
      pending.resolve();
      subscription.unsubscribe();
      await subscription.waitForPendingEvents();
    }
  });

  it("starts the first partial once before a reentrant block reply", async () => {
    const starts: string[] = [];
    const delivery: ReturnType<typeof createReplyDelivery> = createDelivery({
      runId: "run-partial-reentrant-block",
      onAgentEvent: (event) => {
        if (event.stream === "assistant") {
          delivery.emitBlockReply({ text: "Block." });
        }
      },
      onPartialReply: (payload) => {
        starts.push(`partial:${payload.text}`);
      },
      onBlockReply: (payload) => {
        starts.push(`block:${payload.text}`);
      },
    });
    delivery.emitAssistantStreamData(
      { text: "First", delta: "First" },
      { emitPartialReply: true, finalMessage: true },
    );
    delivery.settleAssistantMessageDelivery({ silent: false });
    await delivery.waitForPendingEvents();
    expect(starts).toEqual(["partial:First", "block:Block."]);
  });
});

describe("native reasoning projection", () => {
  it("does not rescan the growing reasoning prefix on every provider delta", async ({ signal }) => {
    const runId = "native-reasoning-prefix-work";
    const probe = vi.spyOn(String.prototype, "startsWith");
    let comparedPrefixChars = 0;
    const collectPrefixWork = () => {
      for (const [index, [search, position]] of probe.mock.calls.entries()) {
        const text = probe.mock.contexts[index];
        if (
          typeof text === "string" &&
          typeof search === "string" &&
          (position ?? 0) === 0 &&
          text.slice(0, NATIVE_REASONING_BENCH_PREFIX.length) === NATIVE_REASONING_BENCH_PREFIX &&
          search.length > NATIVE_REASONING_BENCH_PREFIX.length
        ) {
          comparedPrefixChars += search.length;
        }
      }
      // Keeping every argument would itself retain all historical prefixes.
      probe.mockClear();
    };
    const off = onAgentEventForRun(runId, collectPrefixWork);
    try {
      const measurement = await measureNativeReasoningSubscription({ signal, runId });
      collectPrefixWork();
      console.log("native-reasoning-work", JSON.stringify({ ...measurement, comparedPrefixChars }));
      expect(measurement.textMatches).toBe(true);
      expect(measurement.deltaMatches).toBe(true);
      expect(measurement.events).toBe(1);
      expect(comparedPrefixChars).toBeLessThan(measurement.chars * 4);
    } finally {
      off();
      probe.mockRestore();
    }
  });
});
