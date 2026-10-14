import type { AgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.types.js";

export function resolveSubagentCompletionResultText(entry: {
  completion?: {
    resultText?: string | null;
    fallbackResultText?: string | null;
    terminalReply?: AgentRunTerminalReplySnapshot;
  };
  execution: {
    outcome?: { status: "ok" | "error" | "timeout" | "unknown" };
  };
}): string | undefined {
  const terminalReply = entry.completion?.terminalReply;
  if (!terminalReply) {
    const legacyResult = entry.completion?.resultText;
    return entry.execution.outcome?.status === "ok" && legacyResult?.trim()
      ? `[truncated-by-retention: complete child answer unavailable]\n${legacyResult}`
      : undefined;
  }
  if (terminalReply.disposition !== "visible") {
    return undefined;
  }
  const resultText = entry.completion?.resultText;
  if (resultText !== undefined && resultText !== null) {
    return resultText;
  }
  return terminalReply.truncated
    ? `[truncated-by-retention: complete child answer unavailable]\n${terminalReply.text}`
    : terminalReply.text;
}
