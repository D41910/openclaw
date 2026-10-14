import { afterEach, expect, it, vi } from "vitest";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { currentThemeBranding, setCurrentThemeBranding } from "../app/theme-branding.ts";
import {
  readAvatarGatewayContext,
  setAvatarGatewayOrigin,
} from "../lib/identity-avatar-context.ts";
import { LitContent } from "../lit/solid-content.tsx";
import { renderChatWorkingIndicator } from "../pages/chat/components/chat-working-indicator.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import "../test-helpers/load-styles.ts";

afterEach(cleanupSolid);

it("keeps custom working-indicator artwork at 18 pixels through the legacy helper", async () => {
  const previous = currentThemeBranding();
  const gateway = readAvatarGatewayContext();
  const artworkUrl = "/__openclaw__/plugin-theme-art/synthetic/layout/icons/brand-size";
  const fetch = globalThis.fetch;
  const artworkFetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) =>
      input === artworkUrl
        ? Promise.resolve(
            new Response(
              '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#4169e1"/></svg>',
              { headers: { "Content-Type": "image/svg+xml" } },
            ),
          )
        : fetch(input, init),
    );
  try {
    setAvatarGatewayOrigin(location.origin);
    setCurrentThemeBranding(
      resolveThemeBranding({
        brandIcon: "synthetic",
        artwork: { icons: { synthetic: { url: artworkUrl } } },
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
      ).toBe(256);
    });
    const icon = view.container.querySelector("openclaw-theme-brand-icon")!;
    expect(icon.clientWidth).toBe(18);
    expect(icon.clientHeight).toBe(18);
  } finally {
    artworkFetch.mockRestore();
    setAvatarGatewayOrigin(gateway.origin, gateway.authTokens, gateway.resourceBasePath);
    setCurrentThemeBranding(previous);
  }
});
