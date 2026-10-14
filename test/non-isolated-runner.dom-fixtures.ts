import path from "node:path";

// Keep both files in the shared runner's existing child: the regression is the
// lifetime mismatch between a retired source generation and the native document.
export function domResourceFixtureFiles(repoRoot: string): Record<string, string> {
  const collectGarbage = JSON.stringify(
    path.join(repoRoot, "ui/src/test-helpers/garbage-collection.ts"),
  );
  return {
    "dependency/node_modules/persistent-dom.cjs": `
exports.install = () => {
  window.addEventListener("error", event => {
    event.preventDefault();
    document.body.dataset.dependencyError = "observed";
  });
  document.addEventListener("dependency-event", () => document.body.dataset.dependencyEvent = "observed");
  const observer = new MutationObserver(() => document.body.dataset.dependencyMutation = "observed");
  observer.observe(document, { childList: true, subtree: true });
};
`,
    "11-dom-a-producer.test.ts": `
/* @vitest-environment jsdom */
import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { collectGarbageForTest } from ${collectGarbage};
it("registers live source and external dependency DOM resources", async () => {
  createRequire(import.meta.url)("./dependency/node_modules/persistent-dom.cjs").install();
  const target = window;
  vi.stubGlobal("window", {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  });
  try {
    window.addEventListener("forwarded-window-event", () => {
      document.body.dataset.forwardedWindow = "observed";
    });
  } finally {
    vi.unstubAllGlobals();
  }
  target.dispatchEvent(new Event("forwarded-window-event"));
  expect(document.body.dataset.forwardedWindow).toBe("observed");
  const released = (() => {
    const payload = { text: "released" };
    const listener = () => {
      document.body.dataset.removedEvent = payload.text;
    };
    const reference = new WeakRef(payload);
    document.addEventListener("removed-event", listener);
    document.addEventListener("removed-event", listener);
    document.removeEventListener("removed-event", listener);
    return reference;
  })();
  await collectGarbageForTest();
  expect(released.deref()).toBeUndefined();
  const temporaryErrorListener = () => {};
  window.addEventListener("error", temporaryErrorListener);
  window.removeEventListener("error", temporaryErrorListener);
  const listener = () => document.body.dataset.repoEvent = "observed";
  for (const target of [window, document, document.body, document.documentElement]) {
    target.addEventListener("repo-event", listener, true);
  }
  const observer = new MutationObserver(() => document.body.dataset.repoMutation = "observed");
  observer.observe(document, { childList: true, subtree: true });
  document.dispatchEvent(new Event("repo-event"));
  document.body.append(document.createElement("div"));
  await new Promise<void>(queueMicrotask);
  expect(document.body.dataset.repoEvent).toBe("observed");
  expect(document.body.dataset.repoMutation).toBe("observed");
  expect(document.body.dataset.dependencyMutation).toBe("observed");
});
`,
    "11-dom-b-observer.test.ts": `
/* @vitest-environment jsdom */
import { expect, it } from "vitest";
it("retires source DOM resources without breaking external dependencies", async () => {
  window.dispatchEvent(new Event("forwarded-window-event"));
  expect(document.body.dataset.forwardedWindow).toBeUndefined();
  for (const target of [window, document, document.body, document.documentElement]) {
    target.dispatchEvent(new Event("repo-event"));
  }
  document.dispatchEvent(new Event("dependency-event"));
  window.dispatchEvent(new ErrorEvent("error", { error: new Error("handled dependency error"), cancelable: true }));
  expect(document.body.dataset.dependencyError).toBe("observed");
  document.body.append(document.createElement("div"));
  await new Promise<void>(queueMicrotask);
  expect(document.body.dataset.repoEvent).toBeUndefined();
  expect(document.body.dataset.repoMutation).toBeUndefined();
  expect(document.body.dataset.dependencyEvent).toBe("observed");
  expect(document.body.dataset.dependencyMutation).toBe("observed");
});
`,
  };
}
