import { codexNativeSubagentRunId } from "./native-subagent-assignment.js";
/** Pure native metadata mutations, invoked inside the binding owner's transaction. */
import type { CodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import {
  mutateNativePendingAssignments,
  type CodexNativeSubagentPendingAssignment,
} from "./native-subagent-pending-assignments.js";
import {
  mutateCodexNativeSubagentSubmissions,
  readCodexNativeSubagentSubmissions,
  matchesCodexNativeSubagentSubmissionOwner,
  type CodexNativeSubagentSubmission,
} from "./native-subagent-submission.js";
import {
  matchesCodexNativeSubagentSubmissionBinding,
  ownsStoredSessionGeneration,
  type CodexAppServerBindingIdentity,
  type StoredCodexAppServerBinding,
} from "./session-binding-record.js";

export type CodexNativeSubagentBindingMutation =
  | {
      kind: "record-native-subagent-assignment";
      owner: CodexNativeSubagentHistoryOwner;
      assignment: CodexNativeSubagentPendingAssignment;
    }
  | {
      kind: "consume-native-subagent-assignment";
      owner: CodexNativeSubagentHistoryOwner;
      assignment: CodexNativeSubagentPendingAssignment;
      undelivered?: true;
    }
  | {
      kind: "record-native-subagent-submission";
      owner: CodexNativeSubagentHistoryOwner;
      receipt: CodexNativeSubagentSubmission;
    }
  | {
      kind: "consume-native-subagent-submission";
      owner: CodexNativeSubagentHistoryOwner;
      receipt: CodexNativeSubagentSubmission;
    };

/** The caller supplies the transaction's freshly parsed row and current-authority closure. */
export function mutateNativeSubagentBinding({
  identity,
  current,
  mutation,
  assertCurrent,
}: {
  identity: CodexAppServerBindingIdentity;
  current: StoredCodexAppServerBinding | undefined;
  mutation: CodexNativeSubagentBindingMutation;
  assertCurrent: (() => void) | undefined;
}): { result: boolean; next?: StoredCodexAppServerBinding } {
  const isAssignment =
    mutation.kind === "record-native-subagent-assignment" ||
    mutation.kind === "consume-native-subagent-assignment";
  if (!assertCurrent) {
    const operation = isAssignment ? "assignment" : "subagent submission";
    throw new Error(`Codex native ${operation} mutation requires current authority.`);
  }
  assertCurrent();
  if (
    current?.state !== "active" ||
    !ownsStoredSessionGeneration(identity, current) ||
    (identity.kind === "session" && mutation.owner.sessionId !== identity.sessionId) ||
    !matchesCodexNativeSubagentSubmissionBinding(current.binding, mutation.owner)
  ) {
    return { result: false };
  }
  const field = isAssignment ? "nativeSubagentAssignments" : "nativeSubagentSubmissions";
  const changed = isAssignment
    ? mutateNativePendingAssignments({
        current: current.nativeSubagentAssignments,
        owner: mutation.owner,
        assignment: mutation.assignment,
        consume: mutation.kind === "consume-native-subagent-assignment",
      })
    : mutateCodexNativeSubagentSubmissions({
        current: current.nativeSubagentSubmissions,
        owner: mutation.owner,
        receipt: mutation.receipt,
        consume: mutation.kind === "consume-native-subagent-submission",
      });
  if (!changed.applied) {
    return { result: false };
  }
  const { [field]: _previous, ...bindingOwner } = current;
  if (mutation.kind === "consume-native-subagent-assignment" && mutation.undelivered) {
    const submissions = readCodexNativeSubagentSubmissions(bindingOwner.nativeSubagentSubmissions);
    if (
      submissions &&
      matchesCodexNativeSubagentSubmissionOwner(submissions.owner, mutation.owner)
    ) {
      const receipts = submissions.receipts.filter(
        (receipt) =>
          receipt.childThreadId !== mutation.assignment.childThreadId ||
          (receipt.submissionId !== mutation.assignment.nativeTurnId &&
            codexNativeSubagentRunId(receipt.childThreadId, receipt.submissionId) !==
              mutation.assignment.runId),
      );
      delete bindingOwner.nativeSubagentSubmissions;
      if (receipts.length) {
        bindingOwner.nativeSubagentSubmissions = { ...submissions, receipts };
      }
    }
  }
  return {
    result: true,
    next: {
      ...bindingOwner,
      ...(changed.next ? { [field]: changed.next } : {}),
    },
  };
}
