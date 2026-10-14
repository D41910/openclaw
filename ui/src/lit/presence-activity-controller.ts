import { createPresenceActivityLifecycle } from "../lib/presence-activity-lifecycle.ts";
import type { PresenceViewer } from "../lib/presence-users.ts";
import type { SolidControllerHost } from "./solid-controller-host.ts";

/** Refreshes presentation at interaction expiry, without network polling. */
export function createPresenceActivityController(
  host: SolidControllerHost,
  viewers: () => readonly PresenceViewer[],
  refresh = () => host.requestUpdate(),
) {
  const lifecycle = createPresenceActivityLifecycle(viewers, refresh);
  host.addController({
    hostConnected() {
      // Reattaching an already-rendered Lit host need not schedule another update.
      lifecycle.connect();
    },
    hostDisconnected() {
      lifecycle.disconnect();
    },
  });
  return { sync: lifecycle.sync };
}
