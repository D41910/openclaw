import { describe, expect, it } from "vitest";
import { normalizeMessage } from "../../ui/src/lib/chat/message-normalizer.ts";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { sanitizeChatHistoryMessage } from "./chat-display-projection.sanitize.js";
import { stripSuppressedControlReplyToken } from "./control-reply-text.js";
import { projectLiveAssistantBufferedText } from "./live-chat-projector.js";

const textBlock = (text: string) => ({ type: "text", text });
const assistant = (content: unknown) => ({ role: "assistant", content });

describe("control reply display projection", () => {
  it.each([
    ...[
      "REPLY_SKIP\n\nRE",
      "reply_skip\n\nre",
      "ANNOUNCE_SKIP\nREPLY_SKIP",
      "\u00a0“NO_REPLY”\ufeff",
      "«announce_skip»",
      "*** \nREPLY_SKIP***",
      "The participants have already resolved this.\nNO_REPLY.",
    ].map((text) => ({ text, visible: "" })),
    ...[
      "REPLY_SKIP means the peer exchange is over.",
      "The literal marker is `REPLY_SKIP`.",
      "  keep padded  ",
    ].map((text) => ({ text, visible: text })),
    { text: "The handoff is complete.\n\nREPLY_SKIP", visible: "The handoff is complete." },
    { text: "Done. NO_REPLY", visible: "Done." },
  ])(
    "projects completed reply $text consistently in live and stored messages",
    ({ text, visible }) => {
      expect(stripSuppressedControlReplyToken(text)).toBe(visible);
      expect(projectLiveAssistantBufferedText(text, { suppressLeadFragments: false })).toEqual({
        text: visible,
        suppress: !visible,
        pendingLeadFragment: false,
      });
      for (const content of [text, [textBlock(text)]]) {
        const expected = typeof content === "string" ? visible : [textBlock(visible)];
        expect(projectChatDisplayMessages([assistant(content)])).toEqual(
          visible ? [assistant(expected)] : [],
        );
      }
    },
  );

  it.each([63, 64])("classifies replies at the %i-character padding boundary", (length) => {
    for (const padding of [" ".repeat(length), "。".repeat(length)]) {
      const control = `${padding}NO_REPLY`;
      expect(
        projectLiveAssistantBufferedText(control, { suppressLeadFragments: false }),
      ).toMatchObject({
        text: "",
        suppress: true,
      });
      expect(projectChatDisplayMessages([assistant(control)])).toEqual([]);
      const text = `${padding}Ready to continue.`;
      expect(projectLiveAssistantBufferedText(text)).toMatchObject({ text, suppress: false });
      expect(projectChatDisplayMessages([assistant(text)])).toEqual([assistant(text)]);
    }
  });

  it.each(["NO_REPLY", "ANNOUNCE_SKIP", "REPLY_SKIP"])(
    "distinguishes pending prefixes from completed %s text",
    (token) => {
      for (let length = 1; length < token.length; length += 1) {
        const prefix = token.slice(0, length);
        for (const text of [prefix, `${token}\n\n${token}\n\n${prefix}`]) {
          expect(projectLiveAssistantBufferedText(text).suppress, text).toBe(true);
        }
        const reservedFragment = token === "NO_REPLY" && length >= "NO_".length;
        expect(projectLiveAssistantBufferedText(prefix, { suppressLeadFragments: false })).toEqual({
          text: reservedFragment ? "" : prefix,
          suppress: reservedFragment,
          pendingLeadFragment: false,
        });
        expect(projectChatDisplayMessages([assistant(prefix)])).toEqual(
          reservedFragment ? [] : [assistant(prefix)],
        );
      }
      expect(projectLiveAssistantBufferedText(`${token}\n\nReady to continue.`).suppress).toBe(
        false,
      );
      const text = `${" \t\n".repeat(10)}${token.slice(0, token.indexOf("_") + 1)}\u00a0\ufeff`;
      expect(projectLiveAssistantBufferedText(text)).toEqual({
        text: token === "NO_REPLY" ? "" : text,
        suppress: true,
        pendingLeadFragment: token !== "NO_REPLY",
      });
    },
  );

  const forwarded = {
    ...assistant([textBlock("NO_REPLY")]),
    provenance: {
      kind: "inter_session",
      sourceSessionKey: "agent:main:webchat:source",
      sourceTool: "sessions_send",
    },
  };
  it.each([
    {
      name: "displayable image",
      message: assistant([
        textBlock("NO_REPLY"),
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
      ]),
      expected: [
        assistant([
          textBlock(""),
          {
            type: "image",
            source: { type: "base64", media_type: "image/png" },
            omitted: true,
            bytes: 2,
          },
        ]),
      ],
    },
    {
      name: "visible sibling text",
      message: assistant([textBlock("Visible reply"), textBlock("NO_REPLY")]),
      expected: [],
    },
    { name: "forwarded reply", message: forwarded, expected: [forwarded] },
    {
      name: "model thinking",
      message: assistant([
        { type: "thinking", thinking: "The loop is complete." },
        textBlock("REPLY_SKIP"),
      ]),
      expected: [],
    },
  ])("projects a control token alongside $name", ({ message, expected }) => {
    expect(stripSuppressedControlReplyToken("NO_REPLY")).toBe("");
    expect(projectChatDisplayMessages([message])).toEqual(expected);
  });

  it.each([false, true])(
    "hides all silent-message text before media projection (phased: %s)",
    (phased) => {
      const commentary = {
        ...textBlock("The participants have already resolved this."),
        ...(phased
          ? { textSignature: JSON.stringify({ v: 1, id: "progress", phase: "commentary" }) }
          : {}),
      };
      const terminal = {
        ...textBlock("NO_REPLY"),
        ...(phased
          ? { textSignature: JSON.stringify({ v: 1, id: "final", phase: "final_answer" }) }
          : {}),
      };
      const image = { type: "image", url: "/media/proof.png", mimeType: "image/png" };
      const message = assistant([
        { type: "thinking", thinking: "Native reasoning is private too." },
        commentary,
        image,
        terminal,
      ]);
      const original = structuredClone(message);
      const expected = assistant(
        phased ? [image, { ...terminal, text: "" }] : [textBlock(""), image, textBlock("")],
      );
      expect(
        projectChatDisplayMessages([message], { includeCommentaryFallbacks: true, maxChars: 8 }),
      ).toEqual([expected]);
      expect(sanitizeChatHistoryMessage(message, 8).message).toEqual(expected);
      expect(message).toEqual(original);
    },
  );

  it("decides silence before removing managed media directives or capping raw text", () => {
    const image = { type: "image", url: "/media/proof.png", mimeType: "image/png" };
    const message = {
      ...assistant([textBlock("The attachment is enough.\nNO_REPLY\nMEDIA:./report.png"), image]),
      openclawDelivery: { mediaUrls: ["./report.png"] },
    };
    expect(sanitizeChatHistoryMessage(message, 8).message).toEqual(
      assistant([textBlock(""), image]),
    );
    expect(
      projectChatDisplayMessages([
        assistant("No further explanation is needed.\nNO_REPLY\nMEDIA:media://inbound/"),
      ]),
    ).toEqual([]);
  });

  it.each(["[[audio_as_voice]]", "[[reply_to_current]]"])(
    "hides silent-message reasoning before a trailing %s directive",
    (directive) => {
      const message = assistant([
        { type: "thinking", thinking: "Native reasoning must stay private." },
        textBlock(`The discussion is complete.\nNO_REPLY\n${directive}`),
      ]);
      expect(projectChatDisplayMessages([message])).toEqual([]);
    },
  );

  it("keeps completed progress separate from a later silent message", () => {
    const progress = assistant([textBlock("Completed the tool step.")]);
    const silent = assistant([textBlock("The group needs no more detail."), textBlock("NO_REPLY")]);
    expect(projectChatDisplayMessages([progress, silent])).toEqual([progress]);
  });

  it("keeps attachment facts while removing the silent caption", () => {
    const metadata = { media: [{ url: "/media/proof.png", contentType: "image/png" }] };
    const message = { ...assistant("No announcement is needed.\nNO_REPLY"), __openclaw: metadata };
    expect(projectChatDisplayMessages([message], { maxChars: 8 })).toEqual([
      { ...assistant(""), __openclaw: metadata },
    ]);
  });

  it.each(["string", "blocks", "text"] as const)(
    "keeps directive-only attachments from a silent %s message through UI normalization",
    (shape) => {
      const text = "No explanation needed.\nNO_REPLY\nMEDIA:https://example.com/result.png";
      const message =
        shape === "text"
          ? { role: "assistant", text }
          : assistant(
              shape === "string"
                ? text
                : [
                    {
                      ...textBlock(text),
                      textSignature: JSON.stringify({ v: 1, id: "final", phase: "final_answer" }),
                    },
                  ],
            );
      const original = structuredClone(message);
      const projected = projectChatDisplayMessages([message]);
      expect(projected).toHaveLength(1);
      expect(normalizeMessage(projected[0]).content).toEqual([
        {
          type: "attachment",
          attachment: {
            url: "https://example.com/result.png",
            kind: "image",
            label: "result.png",
            mimeType: "image/png",
          },
        },
      ]);
      expect(message).toEqual(original);
    },
  );
});
