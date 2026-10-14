/** Tests silent-reply and heartbeat token parsing helpers. */
import { describe, it, expect } from "vitest";
import { isInternalFormattingArtifact, isSilentReplyText } from "./tokens.js";

describe("isInternalFormattingArtifact", () => {
  it("matches Harmony channel markers (#88128)", () => {
    expect(isInternalFormattingArtifact("  <channel|>  ")).toBe(true);
    expect(isInternalFormattingArtifact("<channel|answer>")).toBe(true);
    expect(isInternalFormattingArtifact("<lane|reasoning>")).toBe(true);
    expect(isInternalFormattingArtifact("<|>")).toBe(true);
    expect(isInternalFormattingArtifact("<|channel|>")).toBe(true);
  });

  it("matches set-thought directives (#88128)", () => {
    expect(isInternalFormattingArtifact("  set-thought <channel|>  ")).toBe(true);
    expect(isInternalFormattingArtifact("set-thought <lane|reasoning>")).toBe(true);
  });

  it("matches box-drawing HR separators (#88128)", () => {
    expect(isInternalFormattingArtifact("  ───  ")).toBe(true);
  });

  it("returns false for undefined/empty", () => {
    expect(isInternalFormattingArtifact(undefined)).toBe(false);
    expect(isInternalFormattingArtifact("")).toBe(false);
  });

  it("returns false for text that merely contains an artifact pattern", () => {
    expect(isInternalFormattingArtifact("Here are the options:\n───\n1. Option A")).toBe(false);
    expect(isInternalFormattingArtifact("Use <channel|> in your config.")).toBe(false);
    expect(isInternalFormattingArtifact("The set-thought mechanism works like this...")).toBe(
      false,
    );
  });
});

describe("isSilentReplyText", () => {
  it.each(["NO_REPLY", " \tNO_REPLY\r\n"])("recognizes exact control %j", (text) => {
    expect(isSilentReplyText(text)).toBe(true);
  });

  it.each([
    undefined,
    "",
    " ",
    "no_reply",
    "No_Reply",
    "NO_REPLY.",
    ".NO_REPLY",
    '"NO_REPLY"',
    '{"action":"NO_REPLY"}',
    "**NO_REPLY**",
    "NO_REPLY NO_REPLY",
    "NO_REPLYhello",
    "Answer\nNO_REPLY",
    "NO_REPLY\nAnswer",
    "I will stay quiet here. NO_REPLY",
    "<think>internal reasoning</think>\nNO_REPLY",
    ...[".", "!", "?"].map((punctuation) => `think\ninternal reasoning\nNO_REPLY${punctuation}`),
    "think\nThe runtime context confirms another continuation event -- same inbound (msg 24682), and my reply already went out successfully (msg 24683).\n\nThe correct move: NO_REPLY. The user already has my response. Adding more text would be noise.\n\nNO_REPLY.",
    "analysis\nMeeting moved to 3 pm. The NO_REPLY token is a control marker.\nNO_REPLY",
    "think\nThe user asked me to reply NO_REPLY only when there is nothing new.\nHere is the answer: 2+2=4.\nNO_REPLY",
  ])("preserves ordinary text %j", (text) => {
    expect(isSilentReplyText(text)).toBe(false);
  });
});
