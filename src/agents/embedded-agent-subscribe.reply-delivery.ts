import { randomUUID } from "node:crypto";
import {
  appendReplyMediaFailures,
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../auto-reply/reply-payload.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import {
  emitAgentEventWithAssistantSourceIfCurrent,
  readAgentAssistantSource,
  type AgentAssistantProjection,
  type AgentAssistantSourceReceipt,
} from "../infra/agent-events.js";
import { normalizeTextForComparison } from "./embedded-agent-helpers.js";
import type { BlockReplyPayload } from "./embedded-agent-payloads.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import {
  consumePendingAssistantReplyDirectivesIntoReply,
  consumePendingToolMediaIntoReply,
  hasAssistantVisibleReply,
  readPendingToolMediaReply,
  restorePendingToolMediaReply,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";
import type {
  AssistantStreamData,
  EmbeddedAgentSubscribeContext,
} from "./embedded-agent-subscribe.handlers.types.js";
import type { EmbeddedAgentEvent } from "./embedded-agent-subscribe.shared-types.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import type { AgentMessage } from "./runtime/index.js";

type AssistantStreamDelivery = {
  assistantSource?: AgentAssistantSourceReceipt;
  assistantProjection?: AgentAssistantProjection;
  data: AssistantStreamData;
  eventData?: AssistantStreamData;
  emitPartialReply: boolean;
  finalMessage: boolean;
  blockIndex: number;
};

type AssistantStreamScope = {
  delivery?: AssistantStreamDelivery;
  active?: boolean;
  pending?: boolean;
  emitted?: boolean;
};

const isStreamAppend = ({ data, finalMessage }: AssistantStreamDelivery) =>
  !finalMessage && !data.replace && !data.mediaUrls?.length && !data.managedMediaUrls?.length;
const mergeStreamAppend = (previous: AssistantStreamData, next: AssistantStreamData) => ({
  ...next,
  delta: previous.delta + next.delta,
});

type ReplyDeliveryParams = {
  params: SubscribeEmbeddedAgentSessionParams;
  state: EmbeddedAgentSubscribeContext["state"];
  log: EmbeddedAgentSubscribeContext["log"];
};

export function createReplyDelivery({ params, state, log }: ReplyDeliveryParams) {
  const assistantTexts = state.assistantTexts;
  const lastEmittedCommentaryByItem = new Map<string, string>();
  const pendingBlockReplyTasks = new Set<Promise<void>>();
  const pendingPartialReplyTasks = new Set<Promise<void>>();
  let streamScope: AssistantStreamScope = {};
  // These payloads commit durable channel messages; live previews bypass this queue.
  const pendingMessageBlocks: Array<{
    messageIndex: number;
    deliver: (silent: boolean) => void;
    discard?: () => void;
  }> = [];
  let settledMessageIndex = -1;
  let settledMessageSilent = false;
  const settleAssistantMessageDelivery = ({ silent }: { silent: boolean }) => {
    settledMessageIndex = state.assistantMessageStartIndex;
    settledMessageSilent = silent;
    if (silent) {
      for (const itemId of lastEmittedCommentaryByItem.keys()) {
        emitAssistantStreamData(
          { text: "", delta: "", replace: true, phase: "commentary", itemId },
          { finalMessage: true },
        );
      }
    }
    for (const pending of pendingMessageBlocks.splice(0)) {
      pending.deliver(silent);
    }
    if (silent && state.lastStreamedReasoning) {
      const source = readAgentAssistantSource(state.lastAssistant);
      publishAgentEvent(
        {
          stream: "thinking",
          data: { text: "", delta: "", replace: true, itemId: source?.itemId },
        },
        source,
      );
      runBestEffortCallback({
        label: "reasoning clear",
        log,
        callback: () => params.onReasoningStream?.({ text: "" }),
      });
    }
  };
  const discardPendingBlockReplies = (options?: { wholeMessage?: boolean }) => {
    let discarded = false;
    let index = pendingMessageBlocks.length;
    for (const pending of pendingMessageBlocks.toReversed()) {
      index -= 1;
      if (!options?.wholeMessage && pending.messageIndex !== state.assistantMessageIndex) {
        continue;
      }
      pendingMessageBlocks.splice(index, 1);
      pending.discard?.();
      discarded = true;
    }
    if (discarded) {
      if (options?.wholeMessage) {
        state.assistantTextBaseline = state.assistantMessageTextBaseline;
      }
      assistantTexts.splice(state.assistantTextBaseline);
      state.lastAssistantTextTrimmed = undefined;
      state.lastAssistantTextNormalized = undefined;
      state.hasFlushedPartialText = false;
    }
    return discarded;
  };
  const drainPartialReply = (scope: AssistantStreamScope) => {
    if (
      !scope.delivery ||
      !scope.pending ||
      state.unsubscribed ||
      (scope === streamScope && scope.active)
    ) {
      return;
    }
    const data = scope.delivery.data;
    scope.pending = false;
    // Reserve before invocation: callbacks may synchronously enqueue text or open another scope.
    scope.active = true;
    const settled = () => {
      if (scope === streamScope) {
        scope.active = false;
        drainPartialReply(scope);
      }
    };
    runBestEffortCallback({
      callback: () => params.onPartialReply?.(data),
      label: "assistant partial reply",
      log,
      pending: pendingPartialReplyTasks,
      onSuccess: settled,
      onError: settled,
    });
  };
  // Retry subscriptions reuse run IDs and reset message counters. Their scopes
  // must stay distinct so a correction cannot overwrite an earlier attempt.
  const streamId = randomUUID();
  let messageIndex = -1;
  let assistantItemId = "";
  const raw = { text: "", prefix: "", blockIndex: -1 };
  const display = { ...raw };
  let finalText = "";
  let finalized = false;
  const advanceStream = (
    stream: typeof raw,
    data: AssistantStreamData,
    finalMessage: boolean,
  ): AssistantStreamData | undefined => {
    if (stream.blockIndex !== state.assistantMessageIndex) {
      stream.prefix = stream.text;
      stream.blockIndex = state.assistantMessageIndex;
    }
    const text = finalMessage
      ? data.text
      : stream.prefix && data.text
        ? `${stream.prefix}\n${data.text}`
        : stream.prefix || data.text;
    const replace = finalMessage ? !text.startsWith(stream.text) : data.replace === true;
    const delta = finalMessage
      ? replace
        ? ""
        : text.slice(stream.text.length)
      : stream.prefix && stream.text.length === stream.prefix.length && data.delta
        ? `\n${data.delta}`
        : data.delta;
    const eventData =
      text !== stream.text || data.mediaUrls?.length || data.managedMediaUrls?.length
        ? { ...data, text, delta, replace: replace || undefined, itemId: assistantItemId }
        : undefined;
    stream.text = text;
    return eventData;
  };
  const publishAgentEvent = (
    event: EmbeddedAgentEvent,
    assistantSource: AgentAssistantSourceReceipt | undefined,
    assistantProjection?: AgentAssistantProjection,
  ) => {
    const owned = {
      runId: params.runId,
      lifecycleGeneration: params.lifecycleGeneration,
      ...event,
    };
    const emitted = emitAgentEventWithAssistantSourceIfCurrent(
      owned,
      assistantSource,
      assistantProjection,
    );
    if (!emitted) {
      return;
    }
    if (params.onAgentEvent) {
      runBestEffortCallback({
        label: "assistant agent event",
        log,
        callback: () => params.onAgentEvent?.(event),
      });
    }
  };
  const emitAssistantStreamDataSafely = (scope: AssistantStreamScope) => {
    if (!scope.delivery || scope.emitted || state.unsubscribed) {
      return;
    }
    const delivery = scope.delivery;
    const { eventData } = delivery;
    scope.emitted = true;
    scope.pending ||=
      delivery.emitPartialReply && Boolean(params.onPartialReply) && state.shouldEmitPartialReplies;
    const itemId = eventData?.itemId ?? "";
    const progressText = eventData?.phase === "commentary" ? eventData.text.trimEnd() : "";
    const preamblePhase = delivery.finalMessage ? "end" : "update";
    // Completion must survive an identical last delta: first-notification
    // consumers wait for this boundary, not a timer or a repeated text snapshot.
    const commentarySignature = `${preamblePhase}\0${progressText}`;
    const event =
      progressText.trim() ||
      (eventData?.phase === "commentary" && delivery.finalMessage && eventData.replace)
        ? {
            stream: "item" as const,
            data: {
              kind: "preamble",
              title: "Preamble",
              phase: preamblePhase,
              progressText,
              ...(itemId ? { itemId } : {}),
            },
          }
        : !eventData || eventData.phase === "commentary"
          ? undefined
          : { stream: "assistant" as const, data: eventData };
    if (
      event &&
      (event.stream !== "item" || lastEmittedCommentaryByItem.get(itemId) !== commentarySignature)
    ) {
      if (event.stream === "item") {
        lastEmittedCommentaryByItem.set(itemId, commentarySignature);
      }
      publishAgentEvent(event, delivery.assistantSource, delivery.assistantProjection);
    }
    drainPartialReply(scope);
  };
  const emitAssistantStreamData: EmbeddedAgentSubscribeContext["emitAssistantStreamData"] = (
    data,
    options,
  ) => {
    if (state.unsubscribed) {
      return;
    }
    const assistantSource = readAgentAssistantSource(state.lastAssistant);
    if (messageIndex !== state.assistantMessageStartIndex) {
      messageIndex = state.assistantMessageStartIndex;
      assistantItemId = `${streamId}:${messageIndex}`;
      lastEmittedCommentaryByItem.clear();
      for (const stream of [raw, display]) {
        stream.prefix = stream.text = "";
        stream.blockIndex = state.assistantMessageIndex;
      }
      finalText = "";
      finalized = false;
    }
    let eventData: AssistantStreamData | undefined;
    let assistantProjection: AgentAssistantProjection | undefined;
    if (data.phase === "commentary") {
      if (messageIndex === state.assistantMessageStartIndex && display.text !== finalText) {
        display.prefix = display.text = finalText;
        assistantProjection = { itemId: assistantItemId, text: finalText, replace: true };
        // The Gateway moves provisional text into the live commentary item.
        const delivery = streamScope.delivery;
        if (
          delivery &&
          delivery.blockIndex >= messageIndex &&
          delivery.data.phase !== "final_answer"
        ) {
          delivery.assistantProjection = assistantProjection;
        }
      }
      eventData = data;
    } else {
      if (!finalized || options?.finalMessage) {
        eventData = advanceStream(raw, data, options?.finalMessage === true);
        const displayData = advanceStream(display, data, options?.finalMessage === true);
        assistantProjection = {
          itemId: assistantItemId,
          text: display.text,
          replace: displayData?.replace === true,
        };
        finalText =
          data.phase === "final_answer"
            ? display.text
            : display.text.startsWith(finalText)
              ? finalText
              : "";
        finalized = options?.finalMessage === true;
      }
      if (options?.finalMessage && state.lastAssistant?.stopReason === "error") {
        const itemId = assistantItemId;
        const text = raw.text;
        const displayText = display.text;
        params.assistantErrorTranscript?.bindStream(state.lastAssistant, (visible) => {
          clearAssistantStream();
          publishAgentEvent(
            {
              stream: "assistant",
              data: { itemId, text: visible ? text : "", delta: "", replace: true },
            },
            assistantSource,
            { itemId, text: visible ? displayText : "", replace: true },
          );
        });
      }
    }
    // Capture both coordinate domains before any callback can advance message state.
    const delivery = {
      assistantSource,
      assistantProjection,
      data,
      eventData,
      emitPartialReply: options?.emitPartialReply === true,
      finalMessage: options?.finalMessage === true,
      blockIndex: state.assistantMessageIndex,
    };
    if (!eventData && !delivery.emitPartialReply) {
      return;
    }
    const previous = streamScope.delivery;
    const coalesce =
      previous &&
      isStreamAppend(previous) &&
      isStreamAppend(delivery) &&
      previous.blockIndex === delivery.blockIndex &&
      previous.assistantSource === delivery.assistantSource &&
      previous.data.phase === data.phase &&
      previous.data.itemId === data.itemId &&
      previous.emitPartialReply === delivery.emitPartialReply &&
      Boolean(previous.eventData) === Boolean(eventData);
    const scope = coalesce ? streamScope : flushAssistantStream(delivery);
    if (coalesce) {
      // A reentrant boundary may append before this scope has emitted its first snapshot.
      if (!scope.emitted || scope.pending) {
        delivery.data = mergeStreamAppend(previous.data, data);
      }
      if (!scope.emitted && previous.eventData && eventData) {
        delivery.eventData = mergeStreamAppend(previous.eventData, eventData);
      }
      scope.delivery = delivery;
      scope.emitted = false;
    }
    emitAssistantStreamDataSafely(scope);
  };
  const flushAssistantStream = (delivery?: AssistantStreamDelivery) => {
    // Publish the next scope before callbacks: a reentrant boundary can flush it exactly once.
    const previous = streamScope;
    const scope: AssistantStreamScope = { delivery };
    streamScope = scope;
    emitAssistantStreamDataSafely(previous);
    drainPartialReply(previous);
    previous.delivery = undefined;
    return scope;
  };
  const clearAssistantStream = () => {
    streamScope.delivery = undefined;
    streamScope = {};
  };
  const noteLastAssistant = (msg: AgentMessage) => {
    if (msg.role === "assistant") {
      state.lastAssistant = msg;
    }
  };
  const deferredToolMediaReplies = new WeakMap<
    BlockReplyPayload,
    { pendingToolMedia: BlockReplyPayload; autoDeliveryMediaUrls: string[] }
  >();
  const emitBlockReplySafely = (
    payload: Parameters<NonNullable<SubscribeEmbeddedAgentSessionParams["onBlockReply"]>>[0],
    options?: {
      pendingToolMedia?: BlockReplyPayload | null;
      autoDeliveryMediaUrls?: string[];
    },
  ): void => {
    if (!params.onBlockReply) {
      return;
    }
    const assistantMessageIndex = getReplyPayloadMetadata(payload)?.assistantMessageIndex;
    runBestEffortCallback({
      callback: () =>
        assistantMessageIndex === undefined
          ? params.onBlockReply?.(payload)
          : params.onBlockReply?.(payload, { assistantMessageIndex }),
      label: "block reply",
      log,
      pending: pendingBlockReplyTasks,
      onSuccess: () => {
        if (!payload.isReasoning && hasAssistantVisibleReply(payload)) {
          state.visibleBlockReplyCount += 1;
          if (options?.pendingToolMedia) {
            state.pendingToolMediaDeliveryFailed = false;
            state.hasToolMediaBlockReply = true;
          }
          for (const url of options?.autoDeliveryMediaUrls ?? []) {
            state.toolAutoDeliveryMediaUrls.delete(url);
          }
        }
      },
      onError: () => {
        if (options?.pendingToolMedia) {
          restorePendingToolMediaReply(state, options.pendingToolMedia);
          state.pendingToolMediaDeliveryFailed = true;
        }
      },
    });
  };
  const emitBlockReply: EmbeddedAgentSubscribeContext["emitBlockReply"] = (payload, options) => {
    flushAssistantStream();
    const withAssistantDirectives = consumePendingAssistantReplyDirectivesIntoReply(state, payload);
    const pendingToolMedia =
      payload.isReasoning || options?.consumePendingToolMedia === false
        ? null
        : readPendingToolMediaReply(state);
    const withToolMedia =
      options?.consumePendingToolMedia === false
        ? withAssistantDirectives
        : consumePendingToolMediaIntoReply(state, withAssistantDirectives);
    const sentMediaUrls = new Set(state.messagingToolSentMediaUrls.map((url) => url.trim()));
    const autoDeliveryMediaUrls =
      params.sourceReplyDeliveryMode === "message_tool_only"
        ? (pendingToolMedia?.mediaUrls ?? []).filter(
            (url) =>
              state.toolAutoDeliveryMediaUrls.has(url.trim()) && !sentMediaUrls.has(url.trim()),
          )
        : [];
    const pendingAttachments = new Map(
      (pendingToolMedia?.mediaUrls ?? []).map((url, index) => [
        url.trim(),
        pendingToolMedia?.attachments?.[index] ?? {},
      ]),
    );
    const blockPayload: BlockReplyPayload =
      autoDeliveryMediaUrls.length === 0
        ? withToolMedia
        : markReplyPayloadForSourceSuppressionDelivery({
            mediaUrls: autoDeliveryMediaUrls,
            mediaUrl: autoDeliveryMediaUrls[0],
            attachments: autoDeliveryMediaUrls.map(
              (url) => pendingAttachments.get(url.trim()) ?? {},
            ),
            audioAsVoice: pendingToolMedia?.audioAsVoice || undefined,
            trustedLocalMedia: true,
          });
    const assistantTranscriptMediaUrls = Array.from(new Set(payload.mediaUrls ?? []));
    copyReplyPayloadMetadata(payload, blockPayload);
    const taggedPayload =
      options?.assistantMessageIndex !== undefined
        ? setReplyPayloadMetadata(blockPayload, {
            assistantMessageIndex: options.assistantMessageIndex,
            assistantMessageStartIndex: state.assistantMessageStartIndex,
            ...(assistantTranscriptMediaUrls.length > 0 ? { assistantTranscriptMediaUrls } : {}),
          })
        : blockPayload;
    if (blockPayload.text && options?.blockSourceText !== undefined) {
      setReplyPayloadMetadata(taggedPayload, {
        blockSourceText: options.blockSourceText,
        blockSourceRange: options.blockSourceRange,
      });
    }
    const deliver = (silent: boolean) => {
      if (silent) {
        taggedPayload.text = appendReplyMediaFailures(
          undefined,
          getReplyPayloadMetadata(taggedPayload)?.assistantMediaFailures ?? [],
        );
        setReplyPayloadMetadata(taggedPayload, {
          blockSourceText: undefined,
          blockSourceRange: undefined,
        });
      }
      if (!hasAssistantVisibleReply(taggedPayload)) {
        return;
      }
      if (state.deferBlockReplyDelivery) {
        if (pendingToolMedia) {
          deferredToolMediaReplies.set(taggedPayload, { pendingToolMedia, autoDeliveryMediaUrls });
        }
        state.deferredBlockReplies.push(taggedPayload);
      } else {
        emitBlockReplySafely(taggedPayload, { pendingToolMedia, autoDeliveryMediaUrls });
      }
    };
    if (state.assistantMessageStartIndex <= settledMessageIndex) {
      deliver(settledMessageSilent);
    } else if (taggedPayload.text || options?.assistantMessageIndex !== undefined) {
      pendingMessageBlocks.push({
        messageIndex: state.assistantMessageIndex,
        deliver,
        discard: pendingToolMedia
          ? () => restorePendingToolMediaReply(state, pendingToolMedia)
          : undefined,
      });
    } else {
      deliver(false);
    }
  };
  const releaseDeferredReplies = () => {
    if (state.assistantMessageStartIndex > settledMessageIndex) {
      const silent = parseReplyDirectives(state.deltaBuffer).hasSilentIntent;
      if (silent) {
        replaceCurrentAssistantText(SILENT_REPLY_TOKEN);
        emitAssistantStreamData(
          { text: "", delta: "", replace: true },
          { finalMessage: true, emitPartialReply: true },
        );
      }
      settleAssistantMessageDelivery({ silent });
    }
    // A later answer supersedes deferred tool-turn text, not completed answers
    // to earlier user inputs, media, or reasoning. Reconcile both presentation
    // lanes before callbacks can advance the current message boundary.
    const isSuperseded = (index: number | undefined) => {
      if (index === undefined) {
        return false;
      }
      const segment = state.answerSegments.find((candidate) => index <= candidate.messageEnd);
      return index < (segment?.finalMessageStart ?? state.assistantMessageStartIndex);
    };
    const replies = state.deferredBlockReplies.splice(0);
    for (const payload of replies) {
      const index = getReplyPayloadMetadata(payload)?.assistantMessageIndex;
      if (!payload.isReasoning && isSuperseded(index)) {
        payload.text = undefined;
        setReplyPayloadMetadata(payload, { blockSourceText: undefined });
      }
    }
    state.deferBlockReplyDelivery = false;
    flushAssistantStream();
    for (const payload of replies) {
      if (!hasAssistantVisibleReply(payload)) {
        continue;
      }
      const deferredToolMedia = deferredToolMediaReplies.get(payload);
      emitBlockReplySafely(payload, deferredToolMedia);
    }
  };
  const clearDeferredBlockReplies = () => {
    state.deferredBlockReplies.length = 0;
    pendingMessageBlocks.length = 0;
    settledMessageIndex = -1;
    settledMessageSilent = false;
  };

  const rememberAssistantText = (text: string, normalizedText?: string) => {
    state.lastAssistantTextMessageIndex = state.assistantMessageIndex;
    state.lastAssistantTextContentIndex = state.lastAssistantStreamContentIndex;
    state.lastAssistantTextItemId = state.lastAssistantStreamItemId;
    state.lastAssistantTextTrimmed = text.trimEnd();
    const normalized = normalizedText ?? normalizeTextForComparison(text);
    state.lastAssistantTextNormalized = normalized.length > 0 ? normalized : undefined;
  };

  const shouldSkipAssistantText = (text: string, normalizedText?: string) => {
    // Distinct provider content blocks may legitimately contain identical text.
    if (
      state.lastAssistantTextMessageIndex !== state.assistantMessageIndex ||
      state.lastAssistantTextContentIndex !== state.lastAssistantStreamContentIndex
    ) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (trimmed && trimmed === state.lastAssistantTextTrimmed) {
      return true;
    }
    const normalized = normalizedText ?? normalizeTextForComparison(text);
    return normalized.length > 0 && normalized === state.lastAssistantTextNormalized;
  };

  // Callers resolve replay identity first; equal chunks can represent distinct source ranges.
  const pushAssistantText = (text: string, normalizedText?: string) => {
    if (!text || (params.silentExpected && !isSilentReplyText(text, SILENT_REPLY_TOKEN))) {
      return;
    }
    assistantTexts.push(text);
    rememberAssistantText(text, normalizedText);
  };

  const replaceCurrentAssistantText = (text: string) => {
    const count = assistantTexts.length - state.assistantTextBaseline;
    if (!text) {
      assistantTexts.splice(state.assistantTextBaseline, count);
    } else if (count > 0) {
      assistantTexts.splice(state.assistantTextBaseline, count, text);
      rememberAssistantText(text);
    } else if (!shouldSkipAssistantText(text)) {
      pushAssistantText(text);
    }
  };

  const finalizeAssistantTexts: EmbeddedAgentSubscribeContext["finalizeAssistantTexts"] = (
    args,
  ) => {
    const { text, addedDuringMessage, chunkerHasBuffered } = args;

    // Replace timeout-salvaged text on completion; retain it when message_end
    // never arrives after a hard run-budget abort.
    if (args.hasSilentIntent) {
      state.assistantTextBaseline = state.assistantMessageTextBaseline;
      replaceCurrentAssistantText(SILENT_REPLY_TOKEN);
      state.hasFlushedPartialText = false;
    } else if (state.hasFlushedPartialText) {
      replaceCurrentAssistantText(text);
      state.hasFlushedPartialText = false;
    } else if (state.includeReasoning && text && !params.onBlockReply) {
      // Without block replies, the final payload still owns text seen during interim streaming.
      replaceCurrentAssistantText(text);
      state.suppressBlockChunks = true;
    } else if (
      !addedDuringMessage &&
      text &&
      !chunkerHasBuffered &&
      !shouldSkipAssistantText(text)
    ) {
      pushAssistantText(text);
    }

    state.assistantTextBaseline = assistantTexts.length;
  };

  const waitForPendingEvents = async (options?: { includePartialReplies?: boolean }) => {
    // Partial presentation stays concurrent with provider events, but terminal
    // settlement must observe callbacks launched while the event chain drains.
    const includePartialReplies = options?.includePartialReplies !== false;
    while (true) {
      const eventChain = state.pendingEventChain;
      const partialReplyTasks = includePartialReplies ? [...pendingPartialReplyTasks] : [];
      if (!eventChain && partialReplyTasks.length === 0) {
        return;
      }
      await Promise.allSettled([...(eventChain ? [eventChain] : []), ...partialReplyTasks]);
    }
  };

  return {
    assistantTexts,
    clearAssistantStream,
    clearDeferredBlockReplies,
    emitAssistantStreamData,
    emitBlockReply,
    discardPendingBlockReplies,
    settleAssistantMessageDelivery,
    finalizeAssistantTexts,
    flushAssistantStream,
    noteLastAssistant,
    releaseDeferredReplies,
    pendingBlockReplyTasks,
    pushAssistantText,
    replaceCurrentAssistantText,
    shouldSkipAssistantText,
    waitForPendingEvents,
  };
}
