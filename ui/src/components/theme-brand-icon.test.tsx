import { createSignal } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { ThemeBrandingIcon } from "./theme-brand-icon.tsx";

afterEach(cleanupSolid);

it("follows the selected brand while preserving caller-owned claw and neutral artwork", () => {
  const [brandIcon, setBrandIcon] = createSignal("claw");
  const branding = resolveThemeBranding(undefined);
  const view = mountSolid(() => (
    <ThemeBrandingIcon
      branding={{ ...branding, brandIcon: brandIcon() }}
      claw={<span>Caller claw</span>}
      neutral={<span>Caller mark</span>}
    />
  ));
  flush();
  expect(view.container.textContent).toBe("Caller claw");
  setBrandIcon("mark");
  flush();
  expect(view.container.textContent).toBe("Caller mark");
  setBrandIcon("missing-art");
  flush();
  expect(view.container.textContent).toBe("");
  expect(
    view.container.querySelector("openclaw-theme-brand-icon svg")?.getAttribute("viewBox"),
  ).toBe("0 0 120 120");
});
