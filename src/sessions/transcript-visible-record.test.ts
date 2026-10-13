import { describe, expect, it } from "vitest";
import {
  createVisibleAssistantResultEventMatcher,
  isVisibleAssistantResultEventForRun,
} from "./transcript-visible-record.js";

const runId = "current-run";
function assistant(content: string, fields: Record<string, unknown> = {}) {
  return {
    type: "message",
    message: {
      role: "assistant",
      content,
      stopReason: "stop",
      __openclaw: { runId },
      ...fields,
    },
  };
}

describe("stored terminal result selection", () => {
  it.each(["NO_REPLY.", '"NO_REPLY"', '{"action":"NO_REPLY"}', "no_reply", "Done\nNO_REPLY"])(
    "keeps ordinary terminal text %s",
    (text) => {
      expect(isVisibleAssistantResultEventForRun(assistant(text), runId)).toBe(true);
    },
  );

  it("does not resurrect an older answer after explicit terminal silence", () => {
    const events = [assistant("older answer"), assistant("NO_REPLY")];
    expect(events.findLast(createVisibleAssistantResultEventMatcher(runId))).toBeUndefined();
  });

  it("retains a recorded visible final when the same run later ends silently", () => {
    const answer = assistant("complete earlier answer", { display: true });
    const events = [answer, assistant("unsent later text"), assistant("NO_REPLY")];
    expect(events.findLast(createVisibleAssistantResultEventMatcher(runId))).toBe(answer);
  });

  it("retains a final message-tool source row when the model later ends silently", () => {
    const source = assistant("NO_REPLY", {
      openclawDeliveryMirror: {
        kind: "message-tool-source-reply",
        sourceTurnId: runId,
        final: true,
      },
    });
    const events = [source, assistant("NO_REPLY")];
    expect(events.findLast(createVisibleAssistantResultEventMatcher(runId))).toBe(source);
  });

  it("honors display and terminal progress facts before text", () => {
    expect(
      isVisibleAssistantResultEventForRun(assistant("NO_REPLY", { display: true }), runId),
    ).toBe(true);
    expect(
      isVisibleAssistantResultEventForRun(assistant("answer", { display: false }), runId),
    ).toBe(false);
    expect(
      isVisibleAssistantResultEventForRun(assistant("answer", { endTurn: false }), runId),
    ).toBe(false);
    expect(
      isVisibleAssistantResultEventForRun(assistant("answer", { phase: "commentary" }), runId),
    ).toBe(false);
  });
});
