import { describe, expect, it } from "vitest";
import { resolveSubagentCompletionResultText } from "./subagent-completion-result.js";

describe("resolveSubagentCompletionResultText", () => {
  it.each([
    {
      name: "visible",
      terminalReply: {
        disposition: "visible",
        text: "retained first sentence.",
        modelRouteChange: "Model route changed: requested/model → actual/model.",
      } as const,
      expected: "retained first sentence.\nremaining findings",
    },
    {
      name: "silent",
      terminalReply: { disposition: "silent" } as const,
      expected: undefined,
    },
    {
      name: "empty",
      terminalReply: { disposition: "empty" } as const,
      expected: undefined,
    },
  ])(
    "uses $name terminal eligibility with the full retained result",
    ({ terminalReply, expected }) => {
      expect(
        resolveSubagentCompletionResultText({
          completion: {
            resultText: "retained first sentence.\nremaining findings",
            fallbackResultText: "older visible fallback",
            terminalReply,
          },
          execution: { outcome: { status: "ok" } },
        }),
      ).toBe(expected);
    },
  );

  it("keeps the released-writer warning when only its retained prefix survives", () => {
    expect(
      resolveSubagentCompletionResultText({
        completion: { resultText: "released capped prefix" },
        execution: { outcome: { status: "ok" } },
      }),
    ).toBe("[truncated-by-retention: complete child answer unavailable]\nreleased capped prefix");
  });

  it.each(["error", "timeout", "unknown"] as const)(
    "preserves a %s outcome independently of terminal reply eligibility",
    (status) => {
      for (const terminalReply of [
        { disposition: "visible", text: "bounded snapshot" },
        { disposition: "silent" },
        { disposition: "empty" },
      ] as const) {
        const entry = {
          completion: {
            resultText: "NO_REPLY",
            terminalReply,
          },
          execution: { outcome: { status } },
        };
        expect(resolveSubagentCompletionResultText(entry)).toBe(
          terminalReply.disposition === "visible" ? "NO_REPLY" : undefined,
        );
        expect(entry.execution.outcome).toEqual({ status });
      }
    },
  );

  it.each([
    { status: "error", resultText: " \n\t " },
    { status: "timeout", resultText: "" },
    { status: "unknown", resultText: " \n\t " },
  ] as const)(
    "preserves blank prepared bytes when a $status completion is visible ($#)",
    ({ status, resultText }) => {
      expect(
        resolveSubagentCompletionResultText({
          completion: {
            resultText,
            fallbackResultText: "  actionable captured findings  ",
            terminalReply: { disposition: "visible", text: "bounded snapshot" },
          },
          execution: { outcome: { status } },
        }),
      ).toBe(resultText);
    },
  );
});
