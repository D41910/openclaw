import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";
import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { normalizeSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  hasReplyPayloadSpeechContent,
  isReplyPayloadTerminalContent,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { isSilentReplyText } from "../../auto-reply/tokens.js";
import { hasPersistedMedia } from "../../sessions/user-turn-media.js";
import {
  readAssistantTextBlocksForPhase,
  resolveAssistantMessagePhase,
} from "../../shared/chat-message-content.js";
import { hasAnyNonEmptyString as hasNonEmptyStringArray } from "../delivery-evidence-values.js";

type PayloadVisibilityOptions = {
  includeErrorPayloads?: boolean;
  includeReasoningPayloads?: boolean;
  requireTerminalContent?: boolean;
};

export function collectMediaUrlsFromRecord(
  record: Record<string, unknown>,
  output: Set<string>,
  // Payloads arrive as in-process `unknown` objects, so a malformed
  // self-referential `attachments` chain must not recurse indefinitely.
  seen = new WeakSet<object>(),
) {
  if (seen.has(record)) {
    return;
  }
  seen.add(record);
  for (const key of ["mediaUrl", "mediaUrls", "path", "url", "filePath"] as const) {
    for (const value of normalizeSingleOrTrimmedStringList(record[key])) {
      output.add(value);
    }
  }
  if (Array.isArray(record.attachments)) {
    for (const attachment of record.attachments) {
      const nested = asOptionalRecord(attachment);
      if (nested) {
        collectMediaUrlsFromRecord(nested, output, seen);
      }
    }
  }
}

function hasVisibleAttachmentReference(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  const urls = new Set<string>();
  collectMediaUrlsFromRecord({ attachments: value }, urls);
  return urls.size > 0;
}

export function hasVisibleAgentPayload(
  result: { payloads?: unknown },
  options: PayloadVisibilityOptions = {},
): boolean {
  return (
    Array.isArray(result.payloads) &&
    result.payloads.some((payload) => {
      if (!payload || typeof payload !== "object") {
        return false;
      }
      const record = payload as ReplyPayload & { visible?: unknown };
      if (
        (options.requireTerminalContent &&
          (record.visible === false || !isReplyPayloadTerminalContent(record))) ||
        (options.includeErrorPayloads === false && record.isError === true) ||
        (options.includeReasoningPayloads === false && record.isReasoning === true)
      ) {
        return false;
      }
      const visibleText = hasNonEmptyString(record.text);
      return Boolean(
        visibleText ||
        hasReplyPayloadSpeechContent(record) ||
        hasNonEmptyString(record.mediaUrl) ||
        hasNonEmptyStringArray(record.mediaUrls) ||
        hasVisibleAttachmentReference(record.attachments) ||
        record.visible === true ||
        record.presentation ||
        record.interactive ||
        record.channelData,
      );
    })
  );
}

/** Honors recorded visibility before deriving it from the payload's visible content. */
export function hasExplicitlyVisibleAgentPayload(payload: unknown): boolean {
  const visible = asOptionalRecord(payload)?.visible;
  if (typeof visible === "boolean") {
    return visible;
  }
  return hasVisibleAgentPayload(
    { payloads: [payload] },
    { includeErrorPayloads: false, includeReasoningPayloads: false },
  );
}

export function getTranscriptMessageRole(message: unknown): string | undefined {
  const role = asOptionalObjectRecord(message)?.role;
  return typeof role === "string" ? role : undefined;
}

export function readTerminalSourceReplyDeliveryMirror(
  message: unknown,
): { sourceTurnId: string; toolCallId?: string } | undefined {
  const delivery = asOptionalObjectRecord(asOptionalObjectRecord(message)?.openclawDeliveryMirror);
  if (!delivery) {
    return undefined;
  }
  const sourceTurnId =
    typeof delivery.sourceTurnId === "string" ? delivery.sourceTurnId.trim() : "";
  if (delivery.kind !== "message-tool-source-reply" || delivery.final !== true || !sourceTurnId) {
    return undefined;
  }
  const toolCallId = typeof delivery.toolCallId === "string" ? delivery.toolCallId.trim() : "";
  return { sourceTurnId, ...(toolCallId ? { toolCallId } : {}) };
}

/** System and malformed records do not constitute a resumable transcript tail. */
export function isMeaningfulTranscriptMessage(message: unknown): boolean {
  const role = getTranscriptMessageRole(message);
  return Boolean(role && role !== "system");
}

/** Recognizes persisted progress without mistaking an ordinary assistant answer for completion. */
export function isIntermediateAssistantTranscriptMessage(message: unknown): boolean {
  const record = asOptionalObjectRecord(message);
  if (record?.role !== "assistant") {
    return false;
  }
  if (record.stopReason !== undefined && record.stopReason !== "stop") {
    return false;
  }
  if (hasNonEmptyString(asOptionalRecord(record.openclawAsyncDelivery)?.itemId)) {
    return true;
  }
  const phase = resolveAssistantMessagePhase(message);
  if (phase !== undefined) {
    return phase === "commentary";
  }
  const fallback = asOptionalRecord(record.openclawStreamFallback);
  // Keyed segments are durable progress items; unkeyed/current fallbacks can
  // become the final answer and must never bypass restart completion checks.
  return fallback?.source === "segment" && hasNonEmptyString(fallback.itemId);
}

/** Classifies raw assistant rows after their persisted visibility facts. */
export function isSilentAssistantTranscriptMessage(message: unknown): boolean {
  const record = asOptionalObjectRecord(message);
  if (record?.role !== "assistant") {
    return false;
  }
  if (record.display === false) {
    return true;
  }
  if (
    record.display === true ||
    readTerminalSourceReplyDeliveryMirror(message) ||
    hasPersistedMedia(message) ||
    hasNonEmptyStringArray(asOptionalRecord(record.openclawDelivery)?.mediaUrls)
  ) {
    return false;
  }
  const inlineText = typeof record.text === "string" ? record.text : record.content;
  if (typeof inlineText === "string") {
    return isSilentReplyText(inlineText);
  }
  if (!Array.isArray(record.content)) {
    return false;
  }
  const text: string[] = [];
  for (const block of record.content) {
    const part = asOptionalRecord(block);
    if (
      part?.type === "thinking" ||
      part?.type === "reasoning" ||
      part?.type === "redacted_thinking"
    ) {
      continue;
    }
    if (
      !["text", "input_text", "output_text"].includes(String(part?.type)) ||
      typeof part?.text !== "string"
    ) {
      return false;
    }
    text.push(part.text);
  }
  const finalBlocks = readAssistantTextBlocksForPhase(message, "final_answer");
  return isSilentReplyText(
    finalBlocks.length ? finalBlocks.map((block) => block.text).join("") : text.join(""),
  );
}

/** Only a completed final assistant row can prove terminal silence. */
export function isTerminalSilentAssistantMessage(message: unknown): boolean {
  const record = asOptionalObjectRecord(message);
  return (
    record?.stopReason === "stop" &&
    record.endTurn !== false &&
    !isIntermediateAssistantTranscriptMessage(message) &&
    isSilentAssistantTranscriptMessage(message)
  );
}
