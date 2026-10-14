import { afterEach, describe, expect, it } from "vitest";
import { en } from "../../../i18n/locales/en.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import { createGroupedMessageHarness } from "./chat-message-native.test-support.tsx";
import baseCss from "../../../styles/base.css?inline";
import layoutCss from "../../../styles/chat/layout.css?inline";
import messageCss from "../../../styles/chat/message-layout.css?inline";
import textCss from "../../../styles/chat/text.css?inline";

const views = new Map<HTMLElement, ReturnType<typeof createGroupedMessageHarness>>();
const originalCopy = en.chat.pairingQrExpired;
afterEach(() => {
  if (originalCopy === undefined) {
    delete en.chat.pairingQrExpired;
  } else {
    en.chat.pairingQrExpired = originalCopy;
  }
  for (const [container, view] of views) {
    view.unmount();
    container.remove();
  }
  views.clear();
});

describe("expired pairing QR layout", () => {
  it.each([
    { width: 768, direction: "ltr", scale: 1, long: false },
    { width: 280, direction: "ltr", scale: 1.5, long: true },
    { width: 280, direction: "rtl", scale: 1.5, long: true },
  ])(
    "keeps readable insets at $width px, $direction, scale $scale",
    ({ width, direction, scale, long }) => {
      if (long) {
        en.chat.pairingQrExpired = {
          title: "A deliberately long pairing invitation title that wraps across several lines",
          badge: "Expired setup invitation",
          reason:
            "Generate a fresh setup code for VeryLongUnbrokenDeviceIdentifierThatMustNotClipAtTheCardEdge.",
        };
      }
      const container = document.body.appendChild(document.createElement("section"));
      container.style.width = width + "px";
      container.dir = direction;
      container.style.setProperty("--control-ui-text-scale", String(scale));
      const message = {
        role: "assistant",
        content: Array.from({ length: 2 }, () => ({
          type: "openclaw_pairing_qr",
          expiresAtMs: 1,
        })),
      };
      const stylesheet = document.createElement("style");
      stylesheet.textContent = baseCss + layoutCss + messageCss + textCss;
      const group = document.createElement("div");
      group.className = "chat-group assistant";
      container.append(stylesheet, group);
      const view = createGroupedMessageHarness(group);
      views.set(container, view);
      view.render(prepareChatMessageRender(message), "expired-qr", {
        isStreaming: false,
        showReasoning: false,
      });
      const cards = [...container.querySelectorAll<HTMLElement>(".chat-pairing-qr-expired")];
      expect(cards).toHaveLength(2);
      for (const card of cards) {
        const box = card.getBoundingClientRect();
        const reason = card.querySelector<HTMLElement>(".chat-assistant-attachment-card__reason")!;
        const title = card.querySelector<HTMLElement>(".chat-pairing-qr-expired__title")!;
        const badge = card.querySelector(".chat-pairing-qr-expired__badge")!;
        const icon = card.querySelector("svg")!.getBoundingClientRect();
        expect(box.bottom - reason.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(14);
        const edge = direction === "rtl" ? "right" : "left";
        expect(title.getBoundingClientRect()[edge]).toBeCloseTo(
          reason.getBoundingClientRect()[edge],
          1,
        );
        expect(icon.width).toBeGreaterThanOrEqual(16);
        expect(icon.height).toBeGreaterThanOrEqual(16);
        expect(getComputedStyle(badge).borderWidth).toBe("0px");
        expect(getComputedStyle(badge).backgroundColor).toBe("rgba(0, 0, 0, 0)");
        expect(getComputedStyle(badge).padding).toBe("0px");
        expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
        expect(reason.scrollWidth).toBeLessThanOrEqual(reason.clientWidth);
        expect(Number.parseFloat(getComputedStyle(title).fontSize)).toBeCloseTo(13 * scale);
      }
      expect(
        cards[1]!.getBoundingClientRect().top - cards[0]!.getBoundingClientRect().bottom,
      ).toBeGreaterThanOrEqual(8);
    },
  );
});
