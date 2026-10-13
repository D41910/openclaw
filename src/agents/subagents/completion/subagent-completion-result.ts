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
  return entry.completion?.terminalReply?.disposition === "visible"
    ? (entry.completion.resultText ?? undefined)
    : undefined;
}
