import { afterEach, expect, it, vi } from "vitest";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { currentThemeBranding, setCurrentThemeBranding } from "../app/theme-branding.ts";
import { LitContent } from "../lit/solid-content.tsx";
import { renderChatWorkingIndicator } from "../pages/chat/components/chat-working-indicator.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import "../test-helpers/load-styles.ts";

vi.mock("../pages/plugins/icon-loader.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pages/plugins/icon-loader.ts")>()),
  fetchPluginThemeArtworkBlobUrl: async () =>
    `data:image/svg+xml,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="royalblue"/></svg>',
    )}`,
}));

afterEach(cleanupSolid);

it("keeps custom working-indicator artwork at 18 pixels through the legacy helper", async () => {
  const previous = currentThemeBranding();
  try {
    setCurrentThemeBranding(
      resolveThemeBranding({
        brandIcon: "synthetic",
        artwork: { icons: { synthetic: { url: "/synthetic-brand.svg" } } },
      }),
    );
    const view = mountSolid(() => (
      <LitContent
        value={renderChatWorkingIndicator(
          { kind: "reading-indicator", key: "synthetic-brand", startedAt: 1 },
          { workingIndicator: "brand", waitingApproval: true },
        )}
      />
    ));
    await vi.dynamicImportSettled();
    await waitForSolid(() => {
      expect(
        view.container.querySelector<HTMLImageElement>("openclaw-theme-brand-icon img")
          ?.naturalWidth,
      ).toBe(64);
    });
    const icon = view.container.querySelector("openclaw-theme-brand-icon")!;
    expect(icon.clientWidth).toBe(18);
    expect(icon.clientHeight).toBe(18);
  } finally {
    setCurrentThemeBranding(previous);
  }
});
