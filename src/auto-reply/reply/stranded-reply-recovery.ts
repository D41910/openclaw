import type { AgentRunTerminalReplySnapshot } from "../../agents/agent-run-terminal-reply.types.js";
import { createMissingReplyNotice } from "../../agents/reply-completion.js";
import { isRuntimeToolAllowed } from "../../agents/tool-policy-match.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { getReplyPayloadMetadata, isReplyPayloadTerminalContent } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { isStrandedPrivateMessageToolFinal } from "./private-message-tool-final.js";
import type { FollowupRun } from "./queue/types.js";

const STRANDED_REPLY_RETRY_MARKER = "stranded-reply-retry";

type StrandedReplyRecovery =
  | { kind: "none" }
  | { kind: "retry"; run: FollowupRun }
  | { kind: "diagnostic"; payload: ReplyPayload };

/** Resolve the one allowed recovery action for a final that missed source delivery. */
export function resolveStrandedReplyRecovery(params: {
  base: FollowupRun;
  payloads: readonly ReplyPayload[];
  finalText: string;
  terminalReply?: AgentRunTerminalReplySnapshot;
  sourceReplyDeliveryMode: SourceReplyDeliveryMode | undefined;
  sendPolicyDenied: boolean;
  successfulSourceReplyDelivery: boolean;
  isHeartbeat: boolean;
  isRoomEvent: boolean;
}): StrandedReplyRecovery {
  // Host-owned payloads can still be awaiting transport when completion bookkeeping runs.
  if (
    !isStrandedPrivateMessageToolFinal(params) ||
    params.payloads.some(
      (payload) =>
        (isReplyPayloadTerminalContent(payload) || payload.isError === true) &&
        getReplyPayloadMetadata(payload)?.deliverDespiteSourceReplySuppression === true,
    )
  ) {
    return { kind: "none" };
  }
  if (params.base.strandedReplyRetry === true) {
    return {
      kind: "diagnostic",
      payload: createMissingReplyNotice(),
    };
  }
  return {
    kind: "retry",
    run: {
      ...params.base,
      prompt: buildStrandedReplyRetryPrompt(params.finalText),
      summaryLine: STRANDED_REPLY_RETRY_MARKER,
      strandedReplyRetry: true,
      disableCollectBatching: true,
      toolsAllow: isRuntimeToolAllowed("message", params.base.toolsAllow) ? ["message"] : [],
      transcriptPrompt: undefined,
      userTurnTranscriptRecorder: undefined,
      currentInboundContext: undefined,
      // Internally generated system turn: the client turn's lifecycle (gateway cancel
      // identity) completes with the parent run. turnAdoptionLifecycle is one-shot
      // WeakSet-tracked, so a shared object would be double-owned and free cancel
      // while the retry still runs.
      turnAdoptionLifecycle: undefined,
      replyOperationRunStates: undefined,
      run: {
        ...params.base.run,
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        suppressNextUserMessagePersistence: true,
      },
    },
  };
}

function buildStrandedReplyRetryPrompt(finalText: string): string {
  return formatSystemTurnPrompt(
    `Your previous reply was not delivered to the conversation because ` +
      `you did not call message(action=send). Your reply text was:\n\n` +
      `"${finalText}"\n\n` +
      `Please deliver this reply now by calling message(action=send). ` +
      `Do not add any extra commentary; just deliver the original reply.`,
  );
}
