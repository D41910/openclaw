export const AGENT_RUN_TERMINAL_REPLY_MAX_CHARS = 4_096;

export type AgentRunTerminalReplySnapshot =
  | { disposition: "visible"; text: string; truncated?: true; modelRouteChange?: string }
  | { disposition: "silent" }
  | { disposition: "empty"; code?: "message-tool-not-called" };
