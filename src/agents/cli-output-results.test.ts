import { expect, it } from "vitest";
import { prepareCliReplyPayload } from "../auto-reply/reply/cli-reply-payload.js";
import { transformCliResultText } from "./cli-output-results.js";

const replacements = [
  { from: /PRIVATE_MARKER/g, to: "public" },
  { from: /NO_REPLY/g, to: "" },
];

it.each(["", "\nMEDIA:https://example.com/result.png"])(
  "applies output replacements while preserving raw silent intent: %j",
  (media) => {
    const text = `PRIVATE_MARKER: the conversation is complete.\nNO_REPLY${media}`;
    const output = transformCliResultText({ text }, replacements);
    expect(output.rawText).toBe(text);
    expect(output.text).toContain("public: the conversation is complete.");
    expect(prepareCliReplyPayload(output.text)).toMatchObject({
      text: "",
      mediaUrls: media ? ["https://example.com/result.png"] : undefined,
    });
  },
);

it.each([
  {
    parts: ["First PRIVATE_MARKER answer.", "The discussion is complete.\nNO_REPLY"],
    expected: ["First public answer.", "The discussion is complete.\nNO_REPLY"],
  },
  {
    parts: ["The discussion is complete.\nNO_REPLY", "Last PRIVATE_MARKER answer."],
    expected: ["The discussion is complete.\nNO_REPLY", "Last public answer."],
  },
])(
  "preserves distinct completed segments through output replacements: $parts",
  ({ parts, expected }) => {
    const text = parts.join("\n");
    expect(transformCliResultText({ text, textParts: parts }, replacements)).toEqual({
      text: expected.join("\n"),
      textParts: expected,
      rawText: text,
    });
  },
);

it("allows a non-silent source replacement to produce silent intent", () => {
  expect(
    transformCliResultText({ text: "SILENT_MARKER" }, [{ from: /SILENT_MARKER/g, to: "NO_REPLY" }]),
  ).toEqual({ text: "NO_REPLY", rawText: "SILENT_MARKER" });
});

it.each([false, true])(
  "preserves silent intent while transformed media reaches reply preparation (strip token=%s)",
  (stripToken) => {
    const text = "PRIVATE_MEDIA\nNO_REPLY";
    const output = transformCliResultText({ text }, [
      { from: /PRIVATE_MEDIA/g, to: "MEDIA:https://example.com/result.png" },
      ...(stripToken ? [{ from: /NO_REPLY/g, to: "" }] : []),
    ]);
    expect(output.rawText).toBe(text);
    expect(prepareCliReplyPayload(output.text)).toMatchObject({
      text: "",
      mediaUrls: ["https://example.com/result.png"],
    });
  },
);
