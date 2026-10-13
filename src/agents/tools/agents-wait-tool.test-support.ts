import { isDeepStrictEqual } from "node:util";
import type { PreparedSubagentRunsRead } from "../subagents/registry/subagent-registry-read-snapshot.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import { createAgentsWaitTool, waitForCollectorCompletion } from "./agents-wait-tool.js";

export const collectorFinals = new Map<string, string>();

export async function readCollectorResult(
  entry: SubagentRunRecord,
  readRun?: (runId: string) => SubagentRunRecord | undefined,
) {
  if (!readRun) {
    throw new Error("Collector result fixture requires a current run reader");
  }
  const captured = structuredClone(entry);
  return {
    text:
      entry.completion?.terminalReply?.disposition === "visible"
        ? collectorFinals.get(entry.runId)
        : undefined,
    isCurrent: () => isDeepStrictEqual(readRun(entry.runId), captured),
  };
}

export function createMainSessionWaitTool() {
  return createAgentsWaitTool({
    agentSessionKey: "agent:main:main",
    agentId: "main",
    config: { tools: { swarm: true } },
  });
}

export function waitAtBoundary(boundary: "tool" | "bridge", runId: string, signal?: AbortSignal) {
  return boundary === "tool"
    ? createMainSessionWaitTool()
        .execute("wait", { ids: [runId], timeoutSeconds: 1 }, signal)
        .then((result) => result.details)
    : waitForCollectorCompletion({
        runId,
        currentSessionKeys: new Set(["agent:main:main"]),
        currentAgentId: "main",
        signal,
      });
}

export function selectRuns(
  records: ReadonlyMap<string, SubagentRunRecord>,
  runIds: readonly string[],
): Map<string, SubagentRunRecord> {
  return new Map(
    runIds.flatMap((runId) => {
      const entry =
        records.get(runId) ??
        [...records.values()].find((candidate) => candidate.swarmRunId === runId);
      return entry ? [[runId, entry] as const] : [];
    }),
  );
}

export function preparedRuns(
  read: () => ReadonlyMap<string, SubagentRunRecord>,
): PreparedSubagentRunsRead {
  return {
    consume: (consume) => ({ ready: true, value: consume(read()) }),
  };
}

export function collectorRun(
  runId: string,
  requesterSessionKey: string,
  completion?: SubagentRunRecord["collectorCompletion"],
): SubagentRunRecord {
  if (completion) {
    collectorFinals.set(runId, `result-${runId}`);
  }
  return {
    runId,
    childSessionKey: `agent:worker:subagent:${runId}`,
    controllerSessionKey: requesterSessionKey,
    requesterSessionKey,
    requesterDisplayKey: requesterSessionKey,
    task: runId,
    cleanup: "keep",
    createdAt: Date.now(),
    execution: { status: completion ? "terminal" : "running" },
    collect: true,
    swarmRequesterSessionKey: requesterSessionKey,
    groupId: "group",
    completion: {
      required: false,
      resultText: completion ? `result-${runId}` : undefined,
      terminalReply: completion ? { disposition: "visible", text: `result-${runId}` } : undefined,
    },
    collectorCompletion: completion,
  };
}
