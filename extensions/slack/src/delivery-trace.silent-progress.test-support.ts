import {
  runDeliveryTraceScenario,
  type DeliveryTraceDispatch,
  type WireRecorder,
} from "openclaw/plugin-sdk/channel-contract-testing";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { expect, it } from "vitest";
import {
  collectSlackVisibleMessages,
  collectSlackWireTexts,
} from "./delivery-trace.test-support.js";
import type { PreparedSlackMessage } from "./monitor/message-handler/types.js";

export function registerSlackSilentProgressCases(params: {
  setup: (
    recorder: Pick<WireRecorder, "recordWireCall">,
    profile: "progress-native-unified" | "progress-session-card",
    configure: (prepared: PreparedSlackMessage) => void,
  ) => Promise<DeliveryTraceDispatch>;
  getReplyOptions: () => GetReplyOptions | undefined;
  assertNoRuntimeError: () => void;
}) {
  it.each([
    { native: false, retry: false },
    { native: false, retry: true },
    { native: true, retry: false },
    { native: true, retry: true },
  ])(
    "removes silent progress at completion (native=$native, required retry=$retry)",
    async ({ native, retry }) => {
      const events = await runDeliveryTraceScenario({
        scenario: {
          name: "silent-progress-completion",
          steps: [
            { kind: "final", text: "Earlier finalized answer." },
            { kind: "partial", text: "SILENT_REASONING about this optional completion." },
            { kind: "tool-progress", name: "read", phase: "start" },
            { kind: "advance", ms: 2000 },
            { kind: "cancel" },
            ...(retry
              ? [
                  { kind: "partial" as const, text: "Required retry." },
                  { kind: "advance" as const, ms: 2000 },
                  { kind: "final" as const, text: "Required answer." },
                ]
              : []),
            { kind: "idle" },
          ],
        },
        setup: async (recorder) => {
          const dispatch = await params.setup(
            recorder,
            native ? "progress-native-unified" : "progress-session-card",
            (prepared) => {
              prepared.account.config.streaming = {
                mode: "progress",
                progress: {
                  nativeTaskCards: native,
                  style: "card",
                  toolProgress: true,
                  commentary: true,
                },
              };
            },
          );
          return async (step) => {
            const reply = params.getReplyOptions();
            if (step.kind === "partial") {
              if (step.text.startsWith("SILENT_REASONING")) {
                await reply?.onQueuedFollowupAdmitted?.();
              }
              if (!native) {
                await reply?.onItemEvent?.({
                  kind: "preamble",
                  itemId: step.text,
                  phase: "end",
                  progressText: step.text,
                });
                return;
              }
            }
            if (step.kind === "cancel") {
              await reply?.onPartialReply?.({ text: "", delta: "", replace: true });
              if (retry) {
                await reply?.onAssistantMessageStart?.();
              }
            }
            await dispatch(step);
          };
        },
      });
      expect(collectSlackWireTexts(events).join("\n")).toContain("SILENT_REASONING");
      const visible = [...collectSlackVisibleMessages(events).values()].join("\n");
      expect(visible).toContain("Earlier finalized answer.");
      expect(visible).not.toContain("SILENT_REASONING");
      if (retry) {
        expect(visible).toContain("Required answer.");
      }
      params.assertNoRuntimeError();
    },
  );
}
