import type { AgentRunTerminalReplySnapshot } from "../../agents/agent-run-terminal-reply.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";

const privateFinalReplyLogger = createSubsystemLogger("source-reply/private-final");

type PrivateMessageToolFinalContext = {
  sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined;
  sendPolicyDenied: boolean;
  successfulSourceReplyDelivery: boolean;
  isHeartbeat: boolean;
  isRoomEvent: boolean;
  terminalReply?: AgentRunTerminalReplySnapshot;
};

/** A terminal reply is stranded when the configured tool did not deliver it. */
export function isStrandedPrivateMessageToolFinal(params: PrivateMessageToolFinalContext): boolean {
  return Boolean(
    params.terminalReply &&
    params.terminalReply.disposition !== "silent" &&
    params.sourceReplyDeliveryMode === "message_tool_only" &&
    !params.isHeartbeat &&
    !params.isRoomEvent &&
    !params.sendPolicyDenied &&
    !params.successfulSourceReplyDelivery,
  );
}

/**
 * Emit metadata-only operator signal. The body is intentionally omitted:
 * `message_tool_only` keeps normal final text private by design.
 */
export function warnPrivateMessageToolFinal(params: {
  sessionKey: string | undefined;
  channel: string | undefined;
  finalTextLength: number;
}): void {
  privateFinalReplyLogger.warn(
    "agent produced a private final reply without calling the configured delivery tool (message_tool_only); response kept private and not delivered to the source channel",
    {
      sessionKey: params.sessionKey,
      channel: params.channel,
      chars: params.finalTextLength,
    },
  );
}
