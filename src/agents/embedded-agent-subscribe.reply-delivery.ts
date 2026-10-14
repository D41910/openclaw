import { randomUUID } from "node:crypto";
import {
  appendReplyMediaFailures,
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../auto-reply/reply-payload.js";
import {
  isSilentReplyPayloadText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
} from "../auto-reply/tokens.js";
import {
  emitAgentEventWithAssistantSourceIfCurrent,
  readAgentAssistantSource,
  type AgentAssistantProjection,
  type AgentAssistantSourceReceipt,
} from "../infra/agent-events.js";
import { normalizeTextForComparison } from "./embedded-agent-helpers.js";
import type { BlockReplyPayload } from "./embedded-agent-payloads.js";
import {
  createPendingEventWaiter,
  runBestEffortCallback,
} from "./embedded-agent-subscribe.callback.js";
import {
  consumePendingAssistantReplyDirectivesIntoReply,
  consumePendingToolMediaIntoReply,
  hasAssistantVisibleReply,
  readPendingToolMediaReply,
  restorePendingToolMediaReply,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";
import type {
  AssistantStreamData,
  AssistantStreamDelivery,
  AssistantStreamScope,
  EmbeddedAgentSubscribeContext,
  ReplyDeliveryParams,
} from "./embedded-agent-subscribe.handlers.types.js";
import type { EmbeddedAgentEvent } from "./embedded-agent-subscribe.shared-types.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import type { AgentMessage } from "./runtime/index.js";

export function createReplyDelivery({ params, state, log }: ReplyDeliveryParams) {
  const assistantTexts = state.assistantTexts;
  const deferredAssistantScopes: AssistantStreamScope[] = [];
  const lastEmittedCommentaryByItem = new Map<string, string>();
  const pendingBlockReplyTasks = new Set<Promise<void>>();
  const pendingPartialReplyTasks = new Set<Promise<void>>();
  let streamScope: AssistantStreamScope = {};
  // Retain each stream's latest snapshot, but keep every prepared block, until
  // the complete assistant message decides whether any of its text is visible.
  const messageDeliveries = new Map<
    string,
    { deliver: (silent: boolean) => void; onDiscard?: () => void }
  >();
  const messageSilence = new Map<number, boolean>();
  const terminalMessageDeliveries: Array<() => void> = [];
  let settledMessageIndex = -1;
  let blockDeliveryIndex = 0;
  const deliverSettledMessage = (deliver: (silent: boolean) => void, silent: boolean) => {
    if (state.deferBlockReplyDelivery) {
      terminalMessageDeliveries.push(() => deliver(silent));
    } else {
      deliver(silent);
    }
  };
  const deferAssistantMessageDelivery = (
    key: string,
    deliver: (silent: boolean) => void,
    messageStartIndex = state.assistantMessageStartIndex,
    onDiscard?: () => void,
  ) => {
    if (messageStartIndex <= settledMessageIndex) {
      deliverSettledMessage(deliver, messageSilence.get(messageStartIndex) === true);
    } else {
      messageDeliveries.set(key, { deliver, onDiscard });
    }
  };
  const settleAssistantMessageDelivery = ({ silent }: { silent: boolean }) => {
    settledMessageIndex = state.assistantMessageIndex;
    messageSilence.set(state.assistantMessageStartIndex, silent);
    const deliveries = [...messageDeliveries.values()];
    messageDeliveries.clear();
    for (const { deliver } of deliveries) {
      deliverSettledMessage(deliver, silent);
    }
  };
  const discardPendingBlockReplies = () => {
    const prefix = `block:${state.assistantMessageIndex}:`;
    const stale = [...messageDeliveries].filter(([key]) => key.startsWith(prefix));
    if (stale.length === 0) {
      return false;
    }
    // Undo newest reservations first so restored tool media retain their order.
    for (const [key, { onDiscard }] of stale.reverse()) {
      messageDeliveries.delete(key);
      onDiscard?.();
    }
    assistantTexts.splice(state.assistantTextBaseline);
    state.lastAssistantTextTrimmed = undefined;
    state.lastAssistantTextNormalized = undefined;
    state.hasFlushedPartialText = false;
    return true;
  };
  const drainPartialReply = (scope: AssistantStreamScope, delivery = scope.delivery) => {
    if (
      !delivery ||
      !scope.pending ||
      state.unsubscribed ||
      (scope === streamScope && scope.active)
    ) {
      return;
    }
    const data = delivery.data;
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
    const itemId = eventData?.itemId ?? "";
    const progressText = eventData?.phase === "commentary" ? eventData.text.trimEnd() : "";
    const preamblePhase = delivery.finalMessage ? "end" : "update";
    // Completion must survive an identical last delta: first-notification
    // consumers wait for this boundary, not a timer or a repeated text snapshot.
    const commentarySignature = `${preamblePhase}\0${progressText}`;
    const event = progressText.trim()
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
        : {
            stream: "assistant" as const,
            data: { ...eventData, delta: eventData.replace ? "" : eventData.text },
          };
    deferAssistantMessageDelivery(
      `stream:${itemId}`,
      (silent) => {
        if (silent || state.unsubscribed) {
          return;
        }
        scope.pending ||=
          delivery.emitPartialReply &&
          Boolean(params.onPartialReply) &&
          state.shouldEmitPartialReplies;
        if (
          event &&
          (event.stream !== "item" ||
            lastEmittedCommentaryByItem.get(itemId) !== commentarySignature)
        ) {
          if (event.stream === "item") {
            lastEmittedCommentaryByItem.set(itemId, commentarySignature);
          }
          publishAgentEvent(event, delivery.assistantSource, delivery.assistantProjection);
        }
        const text = delivery.assistantProjection?.text ?? delivery.data.text;
        drainPartialReply(scope, {
          ...delivery,
          data: { ...delivery.data, text, delta: text },
        });
      },
      delivery.messageStartIndex,
    );
  };
  const emitAssistantStreamData: EmbeddedAgentSubscribeContext["emitAssistantStreamData"] = (
    data,
    options,
  ) => {
    if (state.unsubscribed) {
      return;
    }
    const assistantSource = readAgentAssistantSource(state.lastAssistant);
    let eventData: AssistantStreamData | undefined;
    let assistantProjection: AgentAssistantProjection | undefined;
    if (data.phase === "commentary") {
      if (messageIndex === state.assistantMessageStartIndex && display.text !== finalText) {
        display.prefix = display.text = finalText;
        assistantProjection = { itemId: assistantItemId, text: finalText, replace: true };
        // HTTP consumers retain append-only raw text. Only the Gateway display
        // transfers provisional text to commentary, including deferred frames.
        for (const scope of [streamScope, ...deferredAssistantScopes]) {
          const delivery = scope.delivery;
          if (
            delivery &&
            delivery.blockIndex >= messageIndex &&
            delivery.data.phase !== "final_answer"
          ) {
            delivery.assistantProjection = assistantProjection;
          }
        }
      }
      eventData = data;
    } else {
      if (messageIndex !== state.assistantMessageStartIndex) {
        messageIndex = state.assistantMessageStartIndex;
        assistantItemId = `${streamId}:${messageIndex}`;
        for (const stream of [raw, display]) {
          stream.prefix = stream.text = "";
          stream.blockIndex = state.assistantMessageIndex;
        }
        finalText = "";
        finalized = false;
      }
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
      if (options?.finalMessage) {
        // Replace the held draft even when completion repeats its last delta.
        eventData = { ...data, ...eventData, text: raw.text, itemId: assistantItemId };
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
      data: options?.finalMessage ? { ...data, delta: data.text } : data,
      eventData,
      emitPartialReply:
        options?.emitPartialReply === true ||
        (options?.finalMessage === true && data.phase !== "commentary" && Boolean(data.text)),
      finalMessage: options?.finalMessage === true,
      blockIndex: state.assistantMessageIndex,
      messageStartIndex: state.assistantMessageStartIndex,
    };
    if (!eventData && !delivery.emitPartialReply) {
      return;
    }
    const deferred = state.deferBlockReplyDelivery && data.phase !== "commentary";
    let scope = streamScope;
    if (
      !deferred ||
      !scope.delivery ||
      scope.delivery.finalMessage ||
      scope.delivery.blockIndex !== delivery.blockIndex ||
      scope.delivery.assistantSource !== delivery.assistantSource
    ) {
      scope = flushAssistantStream(delivery);
    } else {
      scope.delivery = delivery;
    }
    if (!deferred) {
      emitAssistantStreamDataSafely(scope);
    }
  };
  const flushAssistantStream = (delivery?: AssistantStreamDelivery) => {
    // Publish the next scope before callbacks: a reentrant boundary can flush it exactly once.
    const previous = streamScope;
    const scope: AssistantStreamScope = { delivery };
    streamScope = scope;
    if (delivery && state.deferBlockReplyDelivery && delivery.data.phase !== "commentary") {
      deferredAssistantScopes.push(scope);
    }
    if (!state.deferBlockReplyDelivery) {
      const latest = new Map<string, AssistantStreamScope>();
      for (const deferred of deferredAssistantScopes.splice(0)) {
        const delivery = deferred.delivery;
        if (delivery) {
          latest.set(`${delivery.messageStartIndex}:${delivery.eventData?.itemId ?? ""}`, deferred);
        }
      }
      for (const deferred of latest.values()) {
        emitAssistantStreamDataSafely(deferred);
        deferred.delivery = undefined;
      }
    }
    if (!state.deferBlockReplyDelivery || previous.delivery?.data.phase === "commentary") {
      emitAssistantStreamDataSafely(previous);
      drainPartialReply(previous);
      previous.delivery = undefined;
    }
    return scope;
  };
  const clearAssistantStream = () => {
    streamScope.delivery = undefined;
    streamScope = {};
    deferredAssistantScopes.length = 0;
    messageDeliveries.clear();
    terminalMessageDeliveries.length = 0;
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
          deferredToolMediaReplies.set(taggedPayload, {
            pendingToolMedia,
            autoDeliveryMediaUrls,
          });
        }
        state.deferredBlockReplies.push(taggedPayload);
      } else {
        emitBlockReplySafely(taggedPayload, { pendingToolMedia, autoDeliveryMediaUrls });
      }
    };
    if (taggedPayload.text || options?.assistantMessageIndex !== undefined) {
      const lane = payload.isReasoning ? "reasoning" : "block";
      deferAssistantMessageDelivery(
        `${lane}:${state.assistantMessageIndex}:${blockDeliveryIndex++}`,
        deliver,
        state.assistantMessageStartIndex,
        pendingToolMedia ? () => restorePendingToolMediaReply(state, pendingToolMedia) : undefined,
      );
    } else {
      deliver(false);
    }
  };
  const releaseDeferredReplies = () => {
    if (state.assistantMessageStartIndex > settledMessageIndex) {
      const silent = isSilentReplyPayloadText(state.deltaBuffer, SILENT_REPLY_TOKEN);
      if (silent) {
        replaceCurrentAssistantText(SILENT_REPLY_TOKEN);
      }
      settleAssistantMessageDelivery({ silent });
    }
    for (const deliver of terminalMessageDeliveries.splice(0)) {
      deliver();
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
    for (const scope of deferredAssistantScopes) {
      const delivery = scope.delivery;
      if (delivery && isSuperseded(delivery.blockIndex)) {
        if (!delivery.data.mediaUrls?.length) {
          scope.delivery = undefined;
        } else {
          delivery.data = { ...delivery.data, text: "", delta: "" };
          if (delivery.eventData) {
            delivery.eventData = { ...delivery.eventData, text: "", delta: "" };
          }
          if (delivery.assistantProjection) {
            delivery.assistantProjection = { ...delivery.assistantProjection, text: "" };
          }
        }
      }
    }
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
    messageDeliveries.clear();
    terminalMessageDeliveries.length = 0;
    settledMessageIndex = -1;
    messageSilence.clear();
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

  const pushAssistantText = (text: string, normalizedText?: string) => {
    if (
      !text ||
      (params.silentExpected && !isSilentReplyText(text, SILENT_REPLY_TOKEN)) ||
      shouldSkipAssistantText(text, normalizedText)
    ) {
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
    } else {
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
      replaceCurrentAssistantText(SILENT_REPLY_TOKEN);
      state.hasFlushedPartialText = false;
    } else if (state.hasFlushedPartialText) {
      replaceCurrentAssistantText(text);
      state.hasFlushedPartialText = false;
    } else if (state.includeReasoning && text && !params.onBlockReply) {
      // Without block replies, the final payload still owns text seen during interim streaming.
      replaceCurrentAssistantText(text);
      state.suppressBlockChunks = true;
    } else if (!addedDuringMessage && text && !chunkerHasBuffered) {
      pushAssistantText(text);
    }

    state.assistantTextBaseline = assistantTexts.length;
  };

  const waitForPendingEvents = createPendingEventWaiter(state, pendingPartialReplyTasks);

  return {
    assistantTexts,
    clearAssistantStream,
    clearDeferredBlockReplies,
    emitAssistantStreamData,
    emitBlockReply,
    deferAssistantMessageDelivery,
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
