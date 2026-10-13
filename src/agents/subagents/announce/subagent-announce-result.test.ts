import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { prepareAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  readSubagentRunAnnounceResultUsing,
  SubagentAnnouncePreparationConflictError,
} from "./subagent-announce-result.js";

function completedChild(rawText: string): SubagentRunRecord {
  const prepared = prepareAgentRunTerminalReply({ rawText });
  return {
    runId: "completed-run",
    childSessionKey: "agent:main:subagent:completed",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "Return the complete report",
    cleanup: "delete",
    createdAt: 1,
    execution: { status: "terminal", outcome: { status: "ok" } },
    completion: {
      required: true,
      terminalReply: prepared.terminalReply,
      resultText: prepared.text,
    },
  };
}

function resultDeps(readSubagentRun: () => SubagentRunRecord | undefined) {
  return {
    readSubagentRun,
    getRuntimeConfig: () => ({}),
    resolveSessionStorePathCore: () => "/unused/session-store",
    readSubagentSessionEntry: async () => undefined,
    findTranscriptEvent: async () => {
      throw new Error("Prepared completion must not read transcript fallback");
    },
    findSessionTranscriptArchiveEventReadOnly: async () => {
      throw new Error("Prepared completion must not read archive fallback");
    },
  };
}

describe("prepared announcement results", () => {
  it("delivers a visible fact whose complete text is literally NO_REPLY", async () => {
    const child = completedChild("NO_REPLY\nNO_REPLY");
    await expect(
      readSubagentRunAnnounceResultUsing(
        child,
        resultDeps(() => child),
      ),
    ).resolves.toMatchObject({
      text: "NO_REPLY",
    });
  });

  it("delivers the full result rather than the bounded terminal snapshot", async () => {
    const text = `${"report ".repeat(1_000)}required-tail`;
    const child = completedChild(text);
    expect(child.completion?.terminalReply).not.toEqual({ disposition: "visible", text });
    await expect(
      readSubagentRunAnnounceResultUsing(
        child,
        resultDeps(() => child),
      ),
    ).resolves.toMatchObject({ text });
  });

  it.each(["silent", "empty", "absent"] as const)(
    "does not resurrect stale output for a %s fact",
    async (disposition) => {
      const child = completedChild("old result");
      child.completion = {
        required: true,
        terminalReply: disposition === "absent" ? undefined : { disposition },
        resultText: "stale result",
        fallbackResultText: "stale fallback",
      };
      await expect(
        readSubagentRunAnnounceResultUsing(
          child,
          resultDeps(() => child),
        ),
      ).resolves.toMatchObject({ text: undefined });
    },
  );

  it("does not substitute a snapshot when full prepared output is missing", async () => {
    const child = completedChild("bounded evidence");
    child.completion!.resultText = undefined;
    await expect(
      readSubagentRunAnnounceResultUsing(child, {
        ...resultDeps(() => child),
        findTranscriptEvent: async () => undefined,
        findSessionTranscriptArchiveEventReadOnly: async () => undefined,
      }),
    ).resolves.toMatchObject({ text: undefined });
  });

  it("retrieves full visible output from the recorded run rather than a snapshot", async () => {
    const text = `${"full report ".repeat(700)}required-tail`;
    const child = completedChild(text);
    child.completion!.resultText = undefined;
    child.execution.transcriptTarget = {
      agentId: "main",
      sessionId: "completed-session",
      sessionKey: child.childSessionKey,
      storePath: "/unused/session-store",
    };
    await expect(
      readSubagentRunAnnounceResultUsing(child, {
        ...resultDeps(() => child),
        findTranscriptEvent: async (_scope, match) => {
          expect(match).toEqual({ kind: "visible-final", runId: child.runId });
          return {
            event: {
              type: "message",
              message: { role: "assistant", content: [{ type: "text", text }] },
            },
          };
        },
      }),
    ).resolves.toMatchObject({ text });
  });

  it.each(["silent replacement", "failed outcome", "transcript target", "retired run"] as const)(
    "rejects %s during full transcript retrieval",
    async (change) => {
      const child = completedChild("original answer");
      child.completion!.resultText = undefined;
      child.execution.transcriptTarget = {
        agentId: "main",
        sessionId: "completed-session",
        sessionKey: child.childSessionKey,
        storePath: "/unused/session-store",
      };
      let current: SubagentRunRecord | undefined = child;
      const started = createDeferred();
      const release = createDeferred();
      const pending = readSubagentRunAnnounceResultUsing(child, {
        ...resultDeps(() => current),
        findTranscriptEvent: async () => {
          started.resolve();
          await release.promise;
          return { event: { message: { role: "assistant", content: "original answer" } } };
        },
      });
      const rejected = expect(pending).rejects.toBeInstanceOf(
        SubagentAnnouncePreparationConflictError,
      );
      await started.promise;
      current = structuredClone(child);
      if (change === "silent replacement") {
        current.completion = { required: true, terminalReply: { disposition: "silent" } };
      } else if (change === "failed outcome") {
        current.execution.outcome = { status: "error", error: "cancelled" };
      } else if (change === "transcript target") {
        current.execution.transcriptTarget!.sessionId = "replacement-session";
      } else {
        current = undefined;
      }
      release.resolve();
      await rejected;
    },
  );

  it("invalidates prepared output when the authoritative completion changes", async () => {
    const child = completedChild("original result");
    let current = child;
    const result = await readSubagentRunAnnounceResultUsing(
      child,
      resultDeps(() => current),
    );
    expect(result.isCurrent()).toBe(true);
    current = {
      ...child,
      completion: { required: true, terminalReply: { disposition: "silent" } },
    };
    expect(result.isCurrent()).toBe(false);
  });

  it("rejects retired completion owners", async () => {
    const child = completedChild("retired result");
    await expect(
      readSubagentRunAnnounceResultUsing(
        child,
        resultDeps(() => undefined),
      ),
    ).rejects.toBeInstanceOf(SubagentAnnouncePreparationConflictError);
  });
});
