import { describe, expect, it } from "vitest";
import { classifyHeartbeatAgentOutcome } from "./heartbeat-delivery-normalization.js";

describe("heartbeat prepared outcomes", () => {
  const classify = (agentRun: Parameters<typeof classifyHeartbeatAgentOutcome>[0]["agentRun"]) =>
    classifyHeartbeatAgentOutcome({
      agentRun,
      useHeartbeatFailureCopy: false,
      hasRelayableExecCompletion: false,
      suppressUnmarkedSourceReplies: false,
      responsePrefix: undefined,
      ackMaxChars: 300,
    });

  it("uses the silent completion fact without requiring a marker payload", () => {
    expect(
      classify({
        agentRunFailed: false,
        replyCompletion: { expectation: "optional", outcome: "silent" },
      }),
    ).toEqual({ kind: "ack", eventStatus: "ok-token", silent: false });
  });

  it.each(["NO_REPLY", "NO_REPLY.", '{"action":"NO_REPLY"}', "No channel reply."])(
    "delivers prepared literal text: %s",
    (text) => {
      expect(classify({ agentRunFailed: false, replyPayload: { text } })).toMatchObject({
        kind: "delivery",
        normalized: { text, shouldSkip: false },
      });
    },
  );

  it("keeps the heartbeat-owned acknowledgement control", () => {
    expect(
      classify({ agentRunFailed: false, replyPayload: { text: "HEARTBEAT_OK" } }),
    ).toMatchObject({ kind: "ack", eventStatus: "ok-token" });
  });

  it("preserves tool media and failures despite a silent assistant completion", () => {
    const replyCompletion = { expectation: "optional", outcome: "silent" } as const;
    expect(
      classify({
        agentRunFailed: false,
        replyCompletion,
        replyPayload: { mediaUrl: "https://example.test/report.png" },
      }),
    ).toMatchObject({ kind: "delivery", mediaUrls: ["https://example.test/report.png"] });
    expect(
      classify({
        agentRunFailed: true,
        replyCompletion,
        replyPayload: { text: "Provider failed", isError: true },
      }),
    ).toMatchObject({ kind: "failure", normalized: { text: "Provider failed" } });
  });
});
