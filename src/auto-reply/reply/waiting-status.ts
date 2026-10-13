import type { AcceptedSessionSpawn } from "../../agents/accepted-session-spawn.js";
import { adoptMediaGenerationProgressDraft } from "../../agents/media-generation-activity.js";
import type { ReplyCompletion } from "../../agents/reply-completion.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  SubagentRegistryWriteError,
} from "../../agents/subagents/registry/subagent-registry-persistence.js";
import type { ProgressContinuationCapability } from "../../channels/progress-continuation.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import type { PendingContinuationSettlement } from "./get-reply.types.js";
import { isSilentReplyTokenOnly } from "./mixed-silent-reply-tokens.js";
import { resolveReplyOperationAbortReason } from "./reply-operation-abort.js";
import { replyRunRegistry, type ReplyOperation } from "./reply-run-registry.js";

export function buildWaitingStatusPayload(params: {
  completion: ReplyCompletion;
  continuationPending?: boolean;
  yieldAcknowledgment?: string;
  yielded?: boolean;
  hasVisibleMessageDelivery: boolean;
  mediaRequester?: { sessionKey: string; agentId?: string };
}): ReplyPayload | undefined {
  // Media handoff still uses the shipped status transport; child yields require authored text.
  const acknowledgment =
    params.yieldAcknowledgment?.trim() ||
    (params.mediaRequester
      ? "I’m continuing this work and will send the result when it is ready."
      : undefined);
  if (
    params.completion.expectation === "optional" ||
    params.completion.outcome !== "pending" ||
    (!params.yielded && !params.continuationPending) ||
    params.hasVisibleMessageDelivery ||
    !acknowledgment ||
    isSilentReplyTokenOnly(acknowledgment, SILENT_REPLY_TOKEN)
  ) {
    return undefined;
  }
  return setReplyPayloadMetadata(
    {
      text: acknowledgment,
    },
    {
      deliverDespiteSourceReplySuppression: true,
      continuationStatus: true,
    },
  );
}

/**
 * Ordinary and queued waiting replies offer their progress draft to the work
 * that owes the result: the yielding turn's children, or its in-flight media runs.
 */
async function attachWaitingStatusProgressContinuation(params: {
  payload: ReplyPayload;
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[];
  /** Set only for a media continuation, which has no completion child. */
  mediaRequester?: { sessionKey: string; agentId?: string };
  operation: ReplyOperation;
}): Promise<void> {
  const { acceptedSessionSpawns, mediaRequester, operation } = params;
  let adoptDraft: ProgressContinuationCapability["adopt"];
  if (mediaRequester) {
    adoptDraft = (draft) =>
      adoptMediaGenerationProgressDraft(mediaRequester.sessionKey, mediaRequester.agentId, draft);
  } else if (acceptedSessionSpawns?.length) {
    // Ordinary replies must not load the subagent registry.
    const { adoptSubagentProgressDraft } =
      await import("../../agents/subagents/registry/subagent-progress-draft.js");
    adoptDraft = (draft) => adoptSubagentProgressDraft(acceptedSessionSpawns, draft);
  } else {
    return;
  }
  let open = true;
  setReplyPayloadMetadata(params.payload, {
    progressContinuation: {
      adopt: (draft) =>
        open && resolveReplyOperationAbortReason(operation) === undefined && adoptDraft(draft),
      close: () => {
        open = false;
      },
    },
  });
}

export async function prepareWaitingStatusContinuation(params: {
  payload?: ReplyPayload;
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[];
  mediaRequester?: { sessionKey: string; agentId?: string };
  operation: ReplyOperation;
  owner?: {
    stateContext: OpenClawStateWorkerContext;
    operationKey: string;
    operationSessionId: string;
  };
  requester: { sessionKey?: string; agentId?: string; runId: string };
}): Promise<PendingContinuationSettlement | undefined> {
  if (params.payload) {
    await attachWaitingStatusProgressContinuation({ ...params, payload: params.payload });
  }
  if (!params.owner) {
    return undefined;
  }
  const acceptedSessionSpawns = params.acceptedSessionSpawns;
  const requesterSessionKey = params.requester.sessionKey;
  if (!requesterSessionKey || !acceptedSessionSpawns?.length) {
    throw new Error("accepted continuation has no requester or children");
  }
  const { stateContext, operationKey, operationSessionId } = params.owner;
  const assertRequesterCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    // Abort can still owe cleanup; replacement cannot inherit this cohort.
    if (
      replyRunRegistry.get(operationKey) !== params.operation ||
      params.operation.key !== operationKey ||
      params.operation.sessionId !== operationSessionId
    ) {
      throw new Error("Requester continuation lost its original reply operation");
    }
  };
  assertRequesterCurrent();
  let settlementPromise: Promise<void> | undefined;
  return {
    settle: (outcome) =>
      (settlementPromise ??= (async () => {
        try {
          assertRequesterCurrent();
          // Ordinary replies have no child-registry lifecycle; load only for this captured cohort.
          const { settleRequesterAfterSessionSpawns } =
            await import("../../agents/subagents/registry/subagent-registry.js");
          assertRequesterCurrent();
          const transferred = await settleRequesterAfterSessionSpawns({
            requesterSessionKey,
            requesterAgentId: params.requester.agentId,
            requesterTurnRunId: params.requester.runId,
            acceptedSessionSpawns,
            requesterYielded:
              resolveReplyOperationAbortReason(params.operation) === undefined &&
              (outcome === "delivered" || (outcome === "silent" && !params.payload)),
            stateContext,
            assertCurrent: assertRequesterCurrent,
          });
          if (!transferred) {
            throw new Error("accepted continuation children could not transfer terminal delivery");
          }
          try {
            assertRequesterCurrent();
          } catch (error) {
            throw new SubagentRegistryWriteError("committed", error, "published");
          }
        } finally {
          if (params.payload) {
            getReplyPayloadMetadata(params.payload)?.progressContinuation?.close();
          }
        }
      })().catch((error: unknown) => {
        if (!(error instanceof SubagentRegistryWriteError) || error.outcome === "not-committed") {
          settlementPromise = undefined;
        }
        throw error;
      })),
  };
}
