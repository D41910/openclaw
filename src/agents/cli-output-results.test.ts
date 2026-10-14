import { expect, it } from "vitest";
import { transformCliResultText } from "./cli-output-results.js";

const replacements = [
  { from: /PRIVATE_MARKER/g, to: "public" },
  { from: /NO_REPLY/g, to: "" },
];

it("preserves a raw silent completion before applying output replacements", () => {
  const text = "PRIVATE_MARKER: the conversation is complete.\nNO_REPLY";
  expect(transformCliResultText({ text }, replacements)).toEqual({ text, rawText: text });
});

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
