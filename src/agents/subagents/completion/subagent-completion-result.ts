import {
  AGENT_RUN_TERMINAL_REPLY_MAX_CHARS,
  type AgentRunTerminalReplySnapshot,
} from "../../agent-run-terminal-reply.types.js";

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
  if (terminalReply?.disposition !== "visible") {
    return undefined;
  }
  const text = entry.completion?.resultText ?? terminalReply.text;
  return text.length >= AGENT_RUN_TERMINAL_REPLY_MAX_CHARS
    ? `[truncated-by-retention: complete child answer unavailable]\n${text}`
    : text;
}
