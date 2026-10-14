/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { useSessionMenuAppearance } from "./session-icon-picker-solid.tsx";

it("keeps custom icon entry focused and ignores Enter while an IME composition is active", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const runAction = vi.fn();
  const mounted = mountSolid(
    () => {
      const appearance = useSessionMenuAppearance(
        host,
        () => ({ session: { icon: null, color: null }, actionDisabledReasons: {} }),
        () => false,
        runAction,
      );
      return appearance.render(true);
    },
    { container: host },
  );
  const custom = mounted.container.querySelector<HTMLButtonElement>(
    ".session-menu__icon-choice--custom",
  )!;
  custom.click();
  flush();
  const input = mounted.container.querySelector<HTMLTextAreaElement>(
    ".session-menu__icon-custom-input",
  )!;
  expect(document.activeElement).toBe(input);
  input.value = "🦀";
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  flush();
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
  );
  expect(runAction).not.toHaveBeenCalled();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(runAction).toHaveBeenCalledExactlyOnceWith({ kind: "set-icon", icon: "🦀" });
  mounted.container.querySelector<HTMLButtonElement>(".session-menu__icon-back")!.click();
  flush();
  expect(document.activeElement).toBe(custom);
  expect(input.value).toBe("");
  mounted.unmount();
  host.remove();
});
