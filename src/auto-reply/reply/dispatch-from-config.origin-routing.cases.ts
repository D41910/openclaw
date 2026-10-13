import { expect, it } from "vitest";
import type { PluginHookReplyDispatchEvent } from "../../plugins/hook-types.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { ReplyPayload } from "../types.js";
import {
  createDispatcher,
  emptyConfig,
  hookMocks,
  mocks,
  replyMediaPathMocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  dispatchReplyFromConfig,
  firstMockCall,
  firstRouteReplyCall,
  installThreadingTestPlugin,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

export function registerOriginRoutingCases() {
  it("routes when OriginatingChannel differs from Provider", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      AccountId: "acc-1",
      MessageThreadId: 123,
      GroupChannel: "ops-room",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall();
    expect(routeCall?.channel).toBe("telegram");
    expect(routeCall?.to).toBe("telegram:999");
    expect(routeCall?.accountId).toBe("acc-1");
    expect(routeCall?.threadId).toBe(123);
    expect(routeCall?.isGroup).toBe(true);
    expect(routeCall?.groupId).toBe("telegram:999");
  });

  it("routes exec-event replies using persisted session delivery context when current turn has no originating route", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "telegram" });
    sessionStoreMocks.currentEntry = {
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "telegram:999", accountId: "acc-1" },
      }),
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "exec-event",
      Surface: "exec-event",
      SessionKey: "agent:main:main",
      AccountId: undefined,
      OriginatingChannel: undefined,
      OriginatingTo: undefined,
    });

    const replyResolver = async () =>
      ({ text: "hi", mediaUrl: "https://example.test/reply.png" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall();
    expect(routeCall?.channel).toBe("telegram");
    expect(routeCall?.to).toBe("telegram:999");
    expect(routeCall?.accountId).toBe("acc-1");
    const normalizerOptions = replyMediaPathMocks.createReplyMediaPathNormalizer.mock
      .calls[0]?.[0] as { accountId?: unknown; messageProvider?: unknown } | undefined;
    expect(normalizerOptions?.messageProvider).toBe("telegram");
    expect(normalizerOptions?.accountId).toBe("acc-1");
    const replyDispatchCall = firstMockCall(
      hookMocks.runner.runReplyDispatch,
      "reply dispatch",
    ) as [PluginHookReplyDispatchEvent, unknown];
    expect(replyDispatchCall?.[0]?.shouldRouteToOriginating).toBe(true);
    expect(replyDispatchCall?.[0]?.originatingChannel).toBe("telegram");
    expect(replyDispatchCall?.[0]?.originatingTo).toBe("telegram:999");
    expect(typeof replyDispatchCall?.[1]).toBe("object");
  });

  it("routes sessions_send internal webchat handoffs through persisted external delivery context", async () => {
    setNoAbort();
    mocks.routeReply.mockClear();
    installThreadingTestPlugin({ id: "feishu" });
    sessionStoreMocks.currentEntry = {
      chatType: "channel",
      delivery: normalizeSessionDeliveryState({
        route: {
          channel: "feishu",
          accountId: "work",
          target: { to: "user:ou_123", chatType: "channel" },
          thread: { id: "thread:om_123", source: "explicit" },
        },
        context: {
          channel: "feishu",
          to: "user:ou_123",
          accountId: "work",
          threadId: "thread:om_123",
        },
      }),
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      SessionKey: "agent:main:feishu:direct:ou_123",
      AccountId: undefined,
      OriginatingChannel: "webchat",
      OriginatingTo: "session:dashboard",
      ChatType: "direct",
      InputProvenance: {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceChannel: "webchat",
      },
    });

    const replyResolver = async () => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    const routeCall = firstRouteReplyCall();
    expect(routeCall?.channel).toBe("feishu");
    expect(routeCall?.to).toBe("user:ou_123");
    expect(routeCall?.accountId).toBe("work");
    expect(routeCall?.threadId).toBe("thread:om_123");
    expect(routeCall?.replyDelivery).toEqual({
      chatType: "channel",
      replyToMode: "all",
    });
    const replyDispatchCall = firstMockCall(
      hookMocks.runner.runReplyDispatch,
      "reply dispatch",
    ) as [PluginHookReplyDispatchEvent, unknown];
    expect(replyDispatchCall?.[0]?.shouldRouteToOriginating).toBe(true);
    expect(replyDispatchCall?.[0]?.originatingChannel).toBe("feishu");
    expect(replyDispatchCall?.[0]?.originatingTo).toBe("user:ou_123");
    expect(replyDispatchCall?.[0]?.originatingAccountId).toBe("work");
    expect(replyDispatchCall?.[0]?.originatingThreadId).toBe("thread:om_123");
    expect(replyDispatchCall?.[0]?.originatingChatType).toBe("channel");
  });
}
