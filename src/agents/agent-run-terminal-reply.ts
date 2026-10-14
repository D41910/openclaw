import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import { stripInternalMetadataForDisplay } from "../auto-reply/reply/display-text-sanitize.js";
import { isSilentReplyText } from "../auto-reply/tokens.js";
import { normalizeAgentRunRouteChange } from "./agent-run-terminal-receipt.js";
import {
  AGENT_RUN_TERMINAL_REPLY_MAX_CHARS,
  type AgentRunTerminalReplySnapshot,
} from "./agent-run-terminal-reply.types.js";

function isMessageToolNotCalledTerminalReply(
  reply: AgentRunTerminalReplySnapshot | undefined,
): boolean {
  return reply?.disposition === "empty" && reply.code === "message-tool-not-called";
}

/** Sanitizes and caps producer-owned text before it enters lifecycle or durable state. */
export function sanitizeAgentRunTerminalReplyText(text: string): string {
  return truncateWithMarker(
    stripInternalMetadataForDisplay(text).trim(),
    AGENT_RUN_TERMINAL_REPLY_MAX_CHARS,
    {
      marker: "…",
      reserve: 1,
      trimEnd: true,
    },
  );
}

export type PreparedAgentRunTerminalReply = {
  text: string;
  terminalReply: AgentRunTerminalReplySnapshot;
};

/** Classifies raw final text, then strips one literal leading silence line before rendering. */
export function prepareAgentRunTerminalReply(params: {
  rawText?: string;
}): PreparedAgentRunTerminalReply {
  const rawText = params.rawText ?? "";
  if (isSilentReplyText(rawText)) {
    return { text: "", terminalReply: { disposition: "silent" } };
  }
  const text = rawText.startsWith("NO_REPLY\n") ? rawText.slice("NO_REPLY\n".length) : rawText;
  const snapshotText = sanitizeAgentRunTerminalReplyText(text);
  return {
    text,
    terminalReply: snapshotText
      ? { disposition: "visible", text: snapshotText }
      : { disposition: "empty" },
  };
}

/** Normalizes lifecycle/RPC evidence without allowing raw or unbounded text through. */
export function normalizeAgentRunTerminalReplySnapshot(
  value: unknown,
): AgentRunTerminalReplySnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const disposition = value.disposition;
  if (disposition === "silent") {
    return { disposition };
  }
  if (disposition === "empty") {
    if (value.code === "message-tool-not-called") {
      return { disposition, code: "message-tool-not-called" };
    }
    return { disposition };
  }
  if (disposition !== "visible") {
    return undefined;
  }
  const rawText = value.text;
  if (typeof rawText !== "string") {
    return undefined;
  }
  const text = sanitizeAgentRunTerminalReplyText(rawText);
  const modelRouteChange = normalizeAgentRunRouteChange(value.modelRouteChange);
  return text
    ? { disposition: "visible", text, ...(modelRouteChange ? { modelRouteChange } : {}) }
    : { disposition: "empty" };
}

/** Reply evidence merges independently from sticky timeout/cancellation precedence. */
export function mergeAgentRunTerminalReplySnapshot(
  existing: AgentRunTerminalReplySnapshot | undefined,
  incoming: AgentRunTerminalReplySnapshot | undefined,
): AgentRunTerminalReplySnapshot | undefined {
  if (!incoming || isMessageToolNotCalledTerminalReply(existing)) {
    return existing;
  }
  if (
    !existing ||
    isMessageToolNotCalledTerminalReply(incoming) ||
    existing.disposition === "empty"
  ) {
    return incoming;
  }
  return incoming.disposition === "empty" ? existing : incoming;
}
