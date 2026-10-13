import { describe, expect, it } from "vitest";
import { createLiveAssistantTextProjection } from "./live-chat-projector.js";

describe("prepared live reply projection", () => {
  it.each([
    "NO_REPLY",
    "NO_REPLY\nNO_REPLY",
    "NO_REPLY.",
    '"NO_REPLY"',
    '{"reply":"NO_REPLY"}',
    "no_reply",
    "NO_REPLYThe user",
    "The answer.\nNO_REPLY",
    "ANNOUNCE_SKIP",
    "REPLY_SKIP",
    "  keep padded  ",
  ])("preserves prepared literal text %j", (text) => {
    const projection = createLiveAssistantTextProjection();
    expect(projection.replace(text)).toMatchObject({
      text,
      suppress: false,
    });
    expect(createLiveAssistantTextProjection({ final: true }).replace(text).text).toBe(text);
  });

  it("forwards every prepared prefix without adding a second control buffer", () => {
    const projection = createLiveAssistantTextProjection();
    let text = "";
    for (const delta of "NO_REPLY") {
      text += delta;
      expect(projection.append(delta)).toMatchObject({ text, delta, suppress: false });
    }
    expect(projection.replace("")).toMatchObject({ text: "", suppress: true, delta: null });
  });
});
