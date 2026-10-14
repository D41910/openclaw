/* @vitest-environment jsdom */
import { createRouter, definePage } from "@openclaw/uirouter";
import { untrack } from "solid-js";
import { expect, it } from "vitest";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import { solidContent } from "../lit/solid-content.tsx";
import { mountRouterOutlet, settleRouterOutlet } from "./router-outlet.test-support.tsx";

const InitialRoute = defineSolidBridge<{ sessionKey: string }>(
  "openclaw-test-initial-route",
  (props) => {
    // A session owner captures its initial identity when the view is created.
    const initialSession = untrack(() => props.sessionKey);
    return <output>{initialSession}</output>;
  },
  { properties: { sessionKey: { default: "uninitialized", attribute: false } } },
);

it("publishes legacy route props before a nested bridge creates its session owner", async () => {
  const router = createRouter({
    routes: [
      definePage({
        id: "session",
        path: "/session",
        loader: () => "session-one",
        component: () => ({
          render: (sessionKey: string | undefined) => solidContent(InitialRoute, { sessionKey }),
        }),
      }),
    ],
  });
  const outlet = mountRouterOutlet({ router });
  try {
    await router.navigate("session", {});
    await settleRouterOutlet(outlet);
    expect(outlet.querySelectorAll("output")).toHaveLength(1);
    expect(outlet.querySelector("output")?.textContent).toBe("session-one");
  } finally {
    outlet.dispose();
    router.stop();
  }
});
