import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { prepareAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "../registry/subagent-run-generation.js";
import { readChildCompletionFindings, testing } from "./subagent-announce-output.test-support.js";
import {
  buildChildCompletionFindings,
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
    execution: {
      status: "terminal",
      outcome: { status: "ok" },
      transcriptTarget: {
        agentId: "main",
        sessionId: "completed-session",
        sessionKey: "agent:main:subagent:completed",
        storePath: "/unused/session-store",
      },
    },
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
    findTranscriptEvent: async () => undefined,
    findSessionTranscriptArchiveEventReadOnly: async () => undefined,
  };
}

describe("prepared announcement results", () => {
  it("delivers a visible fact whose complete text is literally NO_REPLY", async () => {
    const child = completedChild("NO_REPLY\nNO_REPLY");
    await expect(
      readSubagentRunAnnounceResultUsing(child, {
        ...resultDeps(() => child),
        findTranscriptEvent: async () => ({
          event: { message: { role: "assistant", display: true, content: "NO_REPLY" } },
        }),
      }),
    ).resolves.toMatchObject({
      text: "NO_REPLY",
    });
  });

  it("retrieves the full report instead of the released record's capped result", async () => {
    const text = `${"report ".repeat(1_200)}\nrequired-field: complete`;
    const child = completedChild(text);
    child.completion = { required: true, resultText: text.slice(0, 4_096) };
    const prepared = await readSubagentRunAnnounceResultUsing(child, {
      ...resultDeps(() => child),
      findTranscriptEvent: async (scope, match) => {
        expect(scope).toEqual({
          agentId: "main",
          sessionId: "completed-session",
          sessionKey: child.childSessionKey,
          storePath: "/unused/session-store",
        });
        expect(match).toEqual({ kind: "visible-final", runId: child.runId });
        return { event: { message: { role: "assistant", content: text } } };
      },
    });
    expect(text.length).toBeGreaterThan(8_000);
    expect(prepared.text).toBe(text);
    const findings = buildChildCompletionFindings([{ ...child, announceResult: prepared.text }]);
    expect(findings).toContain("required-field: complete");
  });

  it.each(["silent", "empty"] as const)(
    "does not resurrect stale output for a %s fact",
    async (disposition) => {
      const child = completedChild("old result");
      child.completion = {
        required: true,
        terminalReply: { disposition },
        resultText: "stale result",
        fallbackResultText: "stale fallback",
      };
      await expect(
        readSubagentRunAnnounceResultUsing(child, {
          ...resultDeps(() => child),
          findTranscriptEvent: async () => {
            throw new Error("Recorded terminal disposition must not read the transcript");
          },
          findSessionTranscriptArchiveEventReadOnly: async () => {
            throw new Error("Recorded terminal disposition must not read the archive");
          },
        }),
      ).resolves.toMatchObject({ text: undefined });
    },
  );

  it.each([
    {
      name: "full retained result",
      rawText: "x".repeat(5_000),
      resultText: "x".repeat(5_000),
      expected: "x".repeat(5_000),
    },
    {
      name: "surrogate-shortened capped snapshot",
      rawText: "x".repeat(4_094) + "😀tail",
      resultText: undefined,
      expected: `[truncated-by-retention: complete child answer unavailable]\n${"x".repeat(4_094)}…`,
    },
    {
      name: "uncapped snapshot",
      rawText: "bounded evidence",
      resultText: undefined,
      expected: "bounded evidence",
    },
  ])(
    "recovers $name without guessing from its length",
    async ({ rawText, resultText, expected }) => {
      const child = completedChild(rawText);
      child.completion!.resultText = resultText;
      await expect(
        readSubagentRunAnnounceResultUsing(
          child,
          resultDeps(() => child),
        ),
      ).resolves.toMatchObject({ text: expected });
    },
  );

  it.each([
    { rawText: "NO_REPLY.", expected: "NO_REPLY." },
    { rawText: '{"answer":"NO_REPLY"}', expected: '{"answer":"NO_REPLY"}' },
    { rawText: " \nNO_REPLY\t", expected: undefined },
    { rawText: "NO_REPLY\nNO_REPLY", expected: "NO_REPLY" },
  ])("prepares the absent-fact raw row $rawText exactly once", async ({ rawText, expected }) => {
    const child = completedChild(rawText);
    child.completion = { required: true, resultText: "stale cached result" };
    const prepared = await readSubagentRunAnnounceResultUsing(child, {
      ...resultDeps(() => child),
      findTranscriptEvent: async () => ({
        event: { message: { role: "assistant", content: rawText } },
      }),
    });
    expect(prepared.text).toBe(expected);
    const findings = buildChildCompletionFindings([{ ...child, announceResult: prepared.text }]);
    expect(findings).not.toContain("stale cached result");
    expect(findings).toContain(expected ?? "(no output)");
  });

  it("retrieves the full archived report before accepting a visible cached prefix", async () => {
    const text = `${"archived report ".repeat(700)}\nrequired-field: archived`;
    const child = completedChild(text);
    child.completion!.resultText = text.slice(0, 4_096);
    const prepared = await readSubagentRunAnnounceResultUsing(child, {
      ...resultDeps(() => child),
      findSessionTranscriptArchiveEventReadOnly: async (scope, runId) => {
        expect(scope).toEqual({
          agentId: "main",
          sessionId: "completed-session",
          sessionKey: child.childSessionKey,
          storePath: "/unused/session-store",
        });
        expect(runId).toBe(child.runId);
        return { event: { message: { role: "assistant", content: text } } };
      },
    });
    expect(prepared.text).toBe(text);
  });

  it("marks the released capped result when retention removes the complete report", async () => {
    const text = `${"retained report ".repeat(600)}required-field: complete`;
    const child = completedChild(text);
    const retained = text.slice(0, 4_096);
    child.completion = { required: true, resultText: retained };
    const prepared = await readSubagentRunAnnounceResultUsing(
      child,
      resultDeps(() => child),
    );
    expect(prepared.text).toBe(
      `[truncated-by-retention: complete child answer unavailable]\n${retained}`,
    );
    expect(prepared.text).not.toContain("required-field: complete");
  });

  it.each([
    {
      recordedFact: true,
      expected: "retained prepared result",
    },
    {
      recordedFact: false,
      expected:
        "[truncated-by-retention: complete child answer unavailable]\nretained prepared result",
    },
  ])(
    "preserves retained-result eligibility when recordedFact=$recordedFact and the transcript is unavailable",
    async ({ recordedFact, expected }) => {
      const child = completedChild("retained prepared result");
      if (!recordedFact) {
        child.completion!.terminalReply = undefined;
      }
      await expect(
        readSubagentRunAnnounceResultUsing(
          child,
          resultDeps(() => child),
        ),
      ).resolves.toMatchObject({ text: expected });
    },
  );

  it.each([
    "silent replacement",
    "failed outcome",
    "transcript target",
    "retired run",
    "Gateway recovery",
  ] as const)("rejects %s during full transcript retrieval", async (change) => {
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
    current =
      change === "Gateway recovery"
        ? structuredClone(child)
        : copySubagentRunRuntimeOwner(child, structuredClone(child));
    if (change === "silent replacement") {
      current.completion = { required: true, terminalReply: { disposition: "silent" } };
    } else if (change === "failed outcome") {
      current.execution.outcome = { status: "error", error: "cancelled" };
    } else if (change === "transcript target") {
      current.execution.transcriptTarget!.sessionId = "replacement-session";
    } else if (change === "retired run") {
      current = undefined;
    }
    release.resolve();
    await rejected;
  });

  it("invalidates prepared output when the authoritative completion changes", async () => {
    const child = completedChild("original result");
    let current = child;
    const result = await readSubagentRunAnnounceResultUsing(
      child,
      resultDeps(() => current),
    );
    expect(result.isCurrent()).toBe(true);
    current = copySubagentRunRuntimeOwner(child, {
      ...child,
      completion: { required: true, terminalReply: { disposition: "silent" } },
    });
    expect(result.isCurrent()).toBe(false);
  });
  it("retains prepared authority across an equivalent immutable publication", async () => {
    const child = completedChild("original answer");
    let current = child;
    const result = await readSubagentRunAnnounceResultUsing(
      child,
      resultDeps(() => current),
    );
    current = copySubagentRunRuntimeOwner(child, structuredClone(child));
    current.completion!.capturedAt = 10;
    current.delivery = { status: "delivered" };
    expect(result.text).toBe("original answer");
    expect(result.isCurrent()).toBe(true);
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

describe("completion batch freshness", () => {
  afterEach(() => testing.setDepsForTest());

  it.each(["during", "after"] as const)(
    "rejects an earlier child's change %s preparation",
    async (timing) => {
      const first = completedChild("first answer");
      const second = completedChild("second answer");
      second.runId = "second-run";
      second.execution.transcriptTarget!.sessionId = "second-session";
      const current = new Map([
        [first.runId, first],
        [second.runId, second],
      ]);
      const started = createDeferred();
      const release = createDeferred();
      testing.setDepsForTest({
        findTranscriptEvent: async (scope) => {
          if (scope.sessionId === "second-session") {
            started.resolve();
            await release.promise;
          }
          return {
            event: {
              message: {
                role: "assistant",
                content: scope.sessionId === "second-session" ? "second answer" : "first answer",
              },
            },
          };
        },
      });
      const pending = readChildCompletionFindings([first, second], (runId) => current.get(runId));
      await started.promise;
      await Promise.resolve();
      const replaceFirst = () =>
        current.set(
          first.runId,
          copySubagentRunRuntimeOwner(first, {
            ...structuredClone(first),
            completion: { required: true, terminalReply: { disposition: "silent" } },
          }),
        );
      if (timing === "during") {
        const rejected = expect(pending).rejects.toBeInstanceOf(
          SubagentAnnouncePreparationConflictError,
        );
        replaceFirst();
        release.resolve();
        await rejected;
      } else {
        release.resolve();
        const prepared = await pending;
        expect(prepared.text).toContain("first answer");
        expect(prepared.isCurrent()).toBe(true);
        replaceFirst();
        expect(prepared.isCurrent()).toBe(false);
      }
    },
  );
});
