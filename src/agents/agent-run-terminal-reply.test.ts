import { describe, expect, it } from "vitest";
import { resolveRawAssistantAnswerText } from "../shared/assistant-answer-text.js";
import {
  normalizeAgentRunTerminalReplySnapshot,
  prepareAgentRunTerminalReply,
  sanitizeAgentRunTerminalReply,
} from "./agent-run-terminal-reply.js";

describe("prepareAgentRunTerminalReply", () => {
  it.each(["NO_REPLY", " \tNO_REPLY\r\n"])("removes exact silent output %j", (rawText) => {
    expect(prepareAgentRunTerminalReply({ rawText })).toEqual({
      text: "",
      terminalReply: { disposition: "silent" },
    });
  });

  it.each([
    "no_reply",
    "No_Reply",
    "NO_REPLY.",
    '"NO_REPLY"',
    '{"action":"NO_REPLY"}',
    "**NO_REPLY**",
    "NO_REPLY NO_REPLY",
    "NO_REPLYhello",
    "Answer\nNO_REPLY",
    "I will stay quiet here. NO_REPLY",
    "<think>internal</think>\nNO_REPLY",
    " NO_REPLY\nAnswer",
    "NO_REPLY\r\nAnswer",
  ])("preserves ordinary model text %j", (rawText) => {
    const prepared = prepareAgentRunTerminalReply({ rawText });
    expect(prepared.text).toBe(rawText);
    expect(prepared.terminalReply.disposition).toBe("visible");
  });

  it.each([" NO_REPLY\nAnswer  \n", "NO_REPLY\n  Answer  \n", "<think>notes</think>\nNO_REPLY"])(
    "classifies original assistant bytes before display normalization: %j",
    (text) => {
      const rawText = resolveRawAssistantAnswerText({
        role: "assistant",
        content: [{ type: "text", text }],
      });
      expect(rawText).toBe(text);
      const prepared = prepareAgentRunTerminalReply({ rawText });
      expect(prepared.text).toBe(text.startsWith("NO_REPLY\n") ? text.slice(9) : text);
      expect(prepared.terminalReply.disposition).toBe("visible");
    },
  );

  it.each([
    ["NO_REPLY", "Answer"],
    [" ", "NO_REPLY\nAnswer"],
    ["NO_REPLY", "\n", "NO_REPLY"],
  ])("preserves raw block boundaries without inventing delimiters: %j", (...parts) => {
    const rawText = resolveRawAssistantAnswerText({
      role: "assistant",
      content: parts.map((text) => ({ type: "text", text })),
    });
    expect(rawText).toBe(parts.join(""));
  });

  it.each(["  Answer\n\n", "NO_REPLY", "NO_REPLY\nAnswer"])(
    "strips one literal leading line and preserves suffix %j",
    (suffix) => {
      const prepared = prepareAgentRunTerminalReply({ rawText: `NO_REPLY\n${suffix}` });
      expect(prepared.text).toBe(suffix);
      expect(prepared.terminalReply).toEqual({ disposition: "visible", text: suffix.trim() });
      expect(normalizeAgentRunTerminalReplySnapshot(prepared.terminalReply)).toEqual(
        prepared.terminalReply,
      );
    },
  );

  it("sanitizes known-visible tool-owned text without silence classification", () => {
    for (const text of ["NO_REPLY", "NO_REPLY\nAnswer"]) {
      expect(sanitizeAgentRunTerminalReply(text)).toEqual({ disposition: "visible", text });
    }
  });

  it("preserves raw markup for rendering after removing the leading silence line", () => {
    expect(prepareAgentRunTerminalReply({ rawText: "NO_REPLY\n<final></final>" }).text).toBe(
      "<final></final>",
    );
  });

  it("keeps the full payload while bounding terminal evidence", () => {
    const rawText = "answer ".repeat(1_000);
    const prepared = prepareAgentRunTerminalReply({ rawText });
    expect(prepared.text).toBe(rawText);
    expect(prepared.terminalReply.disposition).toBe("visible");
    if (prepared.terminalReply.disposition === "visible") {
      expect(prepared.terminalReply.text.length).toBeLessThanOrEqual(4_096);
      expect(prepared.terminalReply.truncated).toBe(true);
      expect(prepared.terminalReply.text).toMatch(/^answer .*…$/);
    }
  });

  it.each(["x".repeat(4_094) + "😀tail", "x".repeat(4_094) + "  tail"])(
    "records actual cuts even when a Unicode or whitespace boundary shortens the snapshot",
    (rawText) => {
      const prepared = prepareAgentRunTerminalReply({ rawText });
      expect(prepared.text).toBe(rawText);
      expect(prepared.terminalReply).toEqual({
        disposition: "visible",
        text: "x".repeat(4_094) + "…",
        truncated: true,
      });
      expect(normalizeAgentRunTerminalReplySnapshot(prepared.terminalReply)).toEqual(
        prepared.terminalReply,
      );
    },
  );
});
