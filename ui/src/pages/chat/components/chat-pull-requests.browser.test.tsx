import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { PRESENTATION_CHANGED_EVENT } from "../../../lit/presentation-binding.ts";
import { SolidContentPresentation } from "../../../lit/solid-content.tsx";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatPullRequests } from "./chat-pull-requests.tsx";
import baseStyles from "../../../styles/base.css?inline";
import layoutStyles from "../../../styles/chat/layout.css?inline";

const container = document.createElement("div");
let mounted: ReturnType<typeof mountSolid> | undefined;
let originalViewport: { width: number; height: number };
beforeEach(() => {
  originalViewport = { width: window.innerWidth, height: window.innerHeight };
});
afterEach(async () => {
  mounted?.unmount();
  mounted = undefined;
  container.remove();
  await page.viewport(originalViewport.width, originalViewport.height);
});

it.each(["props", "owner", "parked"])(
  "hides a retained pane's CI popup and restores disclosure through %s presentation",
  async (mode) => {
    await page.viewport(800, 600);
    document.body.append(container);
    const owner = new EventTarget();
    let isPresented = true;
    let updatePresented!: (value: boolean) => void;
    let updateParked!: (value: boolean) => void;
    const binding = { owner, isPresented: () => isPresented };
    mounted = mountSolid(
      () => {
        const [presented, setPresented] = createSignal(true);
        const [active, setActive] = createSignal(true);
        updatePresented = setPresented;
        updateParked = setActive;
        return (
          <SolidContentPresentation value={active}>
            <style>
              {baseStyles}
              {layoutStyles}
            </style>
            <section
              style={`width: 500px; padding-top: 260px; opacity: ${mode === "props" && !presented() ? 0 : 1}`}
            >
              <ChatPullRequests
                pullRequests={[
                  {
                    number: 42,
                    owner: "example",
                    repo: "release-planning",
                    branch: "review",
                    title: "Review release checklist",
                    url: "https://github.com/example/release-planning/pull/42",
                    state: "open",
                    checks: { state: "passing", passed: 4, failed: 0, skipped: 0, running: 0 },
                  },
                ]}
                status="ready"
                presented={mode === "props" ? presented() : binding}
                onDismiss={() => {}}
              />
            </section>
          </SolidContentPresentation>
        );
      },
      { container },
    );
    const draw = (presented: boolean) => {
      isPresented = presented;
      if (mode === "props") {
        updatePresented(presented);
      } else {
        owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
        if (mode === "parked") {
          updateParked(presented);
        }
      }
      flush();
    };
    draw(true);
    const disclosure = container.querySelector<HTMLDetailsElement>(".chat-pr__checks")!;
    const summary = disclosure.querySelector("summary")!;
    const menu = page.elementLocator(
      container.querySelector<HTMLElement>(".chat-pr__checks-menu")!,
    );
    await page.elementLocator(summary).click();
    await expect.element(menu).toBeVisible();

    draw(false);
    await expect.element(menu).not.toBeVisible();
    expect(disclosure.open).toBe(true);

    draw(true);
    await expect.element(menu).toBeVisible();
    expect(container.querySelector(".chat-pr__checks")).toBe(disclosure);
    expect(disclosure.open).toBe(true);
    summary.focus();
    await userEvent.keyboard(" ");
    await expect.element(menu).not.toBeVisible();
  },
);
