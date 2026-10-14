import { expect, it } from "vitest";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { buildPayloads } from "./payloads.test-helpers.js";

it.each([
  { tail: "NO_REPLY", prior: false, expected: [] },
  {
    tail: "NO_REPLY\nMEDIA:https://example.com/result.png",
    prior: false,
    expected: [expect.objectContaining({ mediaUrl: "https://example.com/result.png" })],
  },
  {
    tail: "NO_REPLY\nMEDIA:media://inbound/",
    prior: false,
    expected: [
      expect.objectContaining({
        text: "⚠️ Media not attached: Use a public HTTPS URL without credentials or attach a local file by a safe path.",
      }),
    ],
  },
  {
    tail: "NO_REPLY",
    prior: true,
    expected: [expect.objectContaining({ text: "Earlier completed answer." })],
  },
])(
  "honors a silent commentary tail without reviving its selected answer: $tail, prior=$prior",
  ({ tail, prior, expected }) => {
    const assistant = makeAgentAssistantMessage({
      content: [
        { type: "thinking", thinking: "Private decision." },
        {
          type: "text",
          text: "This answer was withdrawn.",
          textSignature: JSON.stringify({ v: 1, id: "answer", phase: "final_answer" }),
        },
        {
          type: "text",
          text: tail,
          textSignature: JSON.stringify({ v: 1, id: "tail", phase: "commentary" }),
        },
      ],
    });
    const payloads = buildPayloads({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAssistant: assistant,
      reasoningLevel: "on",
      ...(prior
        ? {
            answerSegments: [
              {
                textEnd: 0,
                messageEnd: 0,
                finalMessageStart: 0,
                lastAssistant: makeAgentAssistantMessage({
                  content: [{ type: "text", text: "Earlier completed answer." }],
                }),
              },
            ],
          }
        : {}),
    });
    expect(payloads).toEqual(expected);
    expect(payloads.some((payload) => payload.isReasoning)).toBe(false);
  },
);

it("keeps commentary after a selected silent answer out of final payloads", () => {
  const assistant = makeAgentAssistantMessage({
    content: [
      {
        type: "text",
        text: "NO_REPLY",
        textSignature: JSON.stringify({ v: 1, id: "answer", phase: "final_answer" }),
      },
      {
        type: "text",
        text: "This is still commentary.",
        textSignature: JSON.stringify({ v: 1, id: "tail", phase: "commentary" }),
      },
    ],
  });
  expect(
    buildPayloads({ assistantTexts: [], lastAssistant: assistant, currentAssistant: assistant }),
  ).toEqual([]);
});
