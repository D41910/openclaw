/** Tests silent-reply and heartbeat token parsing helpers. */
import { describe, it, expect } from "vitest";
import {
  isInternalFormattingArtifact,
  isSilentReplyPrefixText,
  isSilentReplyPayloadText,
  isSilentReplyText,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "./tokens.js";

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
  it("returns false for undefined/empty", () => {
    expect(isSilentReplyText(undefined)).toBe(false);
    expect(isSilentReplyText("")).toBe(false);
  });

  it.each([".NO_REPLY", "\u{10100}No_RePlY NO_REPLY\u{10101}"])(
    "returns true for punctuation-wrapped token-only text: %j (#98166)",
    (text) => {
      expect(isSilentReplyText(text)).toBe(true);
    },
  );

  it("preserves exact custom-token matches with punctuation-edged tokens", () => {
    // Custom tokens whose first/last character is punctuation must still match
    expect(isSilentReplyText("*SILENT*", "*SILENT*")).toBe(true);
    expect(isSilentReplyText("**SILENT**", "*SILENT*")).toBe(false);
    expect(isSilentReplyText("a+b?!", "a+b?")).toBe(true);
  });
});

describe("isSilentReplyPayloadText", () => {
  it("preserves a fenced token example whose final line is not the silent token", () => {
    expect(isSilentReplyPayloadText("```\nNO_REPLY\n```\n")).toBe(false);
  });

  it.each(["NO_", "NO_R", "NO_RE", "NO_REP", "NO_REPL", " \nNO_R \n"])(
    "recognizes a truncated final silent token: %j",
    (text) => {
      expect(isSilentReplyPayloadText(text)).toBe(true);
    },
  );

  it.each(["N", "NO", "No", "no_r", "No issues found", "NO_R alert", "NO_REPLY_EXTRA"])(
    "preserves ordinary final text: %j",
    (text) => {
      expect(isSilentReplyPayloadText(text)).toBe(false);
    },
  );

  it("keeps custom silent tokens exact in final payloads", () => {
    expect(isSilentReplyPayloadText("HELP-", "HELP-QUIET")).toBe(false);
    expect(isSilentReplyPayloadText("NO_R", "NO_RESPONSE")).toBe(false);
  });

  it.each([
    "The participants already resolved this; another response would be noise.\nNO_REPLY",
    "Tout a déjà été réglé.\nNO_REPLY.",
    "analysis\nMeeting moved to 3 pm.\nNO_REPLY",
    "Here is the actual answer.\n\n  no_reply!  \n\n",
    "The NO_REPLY token is a control marker.\nNO_REPLY?",
    "<think>internal reasoning</think>\nNO_REPLY",
    "<mm:think>internal reasoning\nNO_REPLY",
    "reasoning\r\nNO_REPLY\r\n \t",
    "reasoning\rNO_REPLY\r \t",
    "reasoning\n**NO_REPLY**",
  ])("treats the final nonempty silent-token line as the whole payload's intent: %j", (text) => {
    expect(isSilentReplyPayloadText(text)).toBe(true);
  });

  it.each([
    "Done. NO_REPLY",
    "think\nI will stay quiet here.NO_REPLY",
    "NO_REPLY\nThe answer is 42.",
    "Use NO_REPLY only when there is nothing to add. The answer is 42.",
    "Example:\nNO_REPLY\nThen continue normally.",
    "reasoning\nNO_REPLY is the token",
    "reasoning\nNO_REPLY_EXTRA",
  ])("preserves inline, leading, and in-body token mentions: %j", (text) => {
    expect(isSilentReplyPayloadText(text)).toBe(false);
  });
});

describe("stripSilentToken", () => {
  it("preserves punctuation-attached silent-token literals", () => {
    const text = "Done as requested!NO_REPLY";
    expect(stripSilentToken(text)).toBe(text);
  });

  it.each([["Done. NO_REPLY NO_REPLY", "Done."]])(
    "strips adjacent trailing silent tokens in %j",
    (text, expected) => {
      expect(stripSilentToken(text)).toBe(expected);
    },
  );
});

describe("custom silent tokens", () => {
  it.each(["a+b?"])("keeps interleaved matching independent for %s", (token) => {
    const upper = token.toUpperCase();
    for (let pass = 0; pass < 2; pass++) {
      expect(isSilentReplyText(`${upper} ${token}`, token)).toBe(true);
      expect(isSilentReplyPayloadText(`think\ninternal reasoning\n${token}!`, token)).toBe(true);
      expect(stripSilentToken(`done ${upper}\n`, token)).toBe("done");
      expect(startsWithSilentToken(`${upper}你好`, token)).toBe(true);
      expect(stripLeadingSilentToken(`${upper}你好`, token)).toBe("你好");
      expect(startsWithSilentToken(`${upper}7`, token)).toBe(true);
      expect(startsWithSilentToken(`${upper}: literal`, token)).toBe(false);
      expect(startsWithSilentToken(`${upper}\n: visible`, token)).toBe(true);
      expect(stripLeadingSilentToken(`${upper}\n: visible`, token)).toBe(": visible");
      expect(isSilentReplyText(`visible ${upper}`, token)).toBe(false);
    }
  });
});

describe("startsWithSilentToken", () => {
  it.each(["NO_REPLY NO_REPLY: explanation"])(
    "preserves repeated tokens before substantive punctuation: %j",
    (text) => {
      expect(startsWithSilentToken(text)).toBe(false);
    },
  );
});

describe("isSilentReplyPrefixText", () => {
  it("matches uppercase token lead fragments", () => {
    expect(isSilentReplyPrefixText("NO")).toBe(true);
    expect(isSilentReplyPrefixText("NO_")).toBe(true);
    expect(isSilentReplyPrefixText("NO_RE")).toBe(true);
    expect(isSilentReplyPrefixText("NO_REPLY")).toBe(true);
    expect(isSilentReplyPrefixText("  HEARTBEAT_", "HEARTBEAT_OK")).toBe(true);
  });

  it("rejects ambiguous natural-language prefixes", () => {
    expect(isSilentReplyPrefixText("N")).toBe(false);
    expect(isSilentReplyPrefixText("No")).toBe(false);
    expect(isSilentReplyPrefixText("no")).toBe(false);
    expect(isSilentReplyPrefixText("Hello")).toBe(false);
  });

  it("rejects non-prefixes and mixed characters", () => {
    expect(isSilentReplyPrefixText("NO_X")).toBe(false);
    expect(isSilentReplyPrefixText("NO_REPLY more")).toBe(false);
    expect(isSilentReplyPrefixText("NO-")).toBe(false);
  });

  it("rejects pure-letter prefixes for punctuated tokens to avoid false suppression", () => {
    expect(isSilentReplyPrefixText("HE", "HELP-QUIET")).toBe(false);
    expect(isSilentReplyPrefixText("HELP", "HELP-QUIET")).toBe(false);
    expect(isSilentReplyPrefixText("HELP-", "HELP-QUIET")).toBe(true);
    expect(isSilentReplyPrefixText("HELP-QUIET", "HELP-QUIET")).toBe(true);
  });
});
