import { createHookRunner } from "../../../plugins/hooks.js";
import type { completeEmbeddedAttemptResult } from "./attempt-result.js";
import type { EmbeddedRunAttemptResult, EmbeddedRunAttemptTrajectoryRecorder } from "./types.js";

export const TEST_OPERATIONAL_RUN_INSTANCE = { runId: "run-1" };

export function createResultFixture(params?: {
  terminal?: EmbeddedRunAttemptResult["terminal"];
  currentAttemptCompletedAssistant?: EmbeddedRunAttemptResult["currentAttemptCompletedAssistant"];
  hasSuccessfulModelResponse?: boolean;
  heartbeatToolResponse?: EmbeddedRunAttemptResult["heartbeatToolResponse"];
  replyOptional?: boolean;
  trajectoryRecorder?: EmbeddedRunAttemptTrajectoryRecorder;
  messagesSnapshot?: EmbeddedRunAttemptResult["messagesSnapshot"];
  successfulNestedToolNames?: string[];
  latestMcpAppChannelView?: { viewId: string };
  clientToolCallSlots?: Array<{
    toolCallId: string;
    name: string;
    params?: Record<string, unknown>;
    completed: boolean;
  }>;
  pendingToolMediaReply?: { mediaUrls?: string[]; audioAsVoice?: boolean };
  toolAutoDeliveryMediaUrls?: string[];
  messagingToolSentMediaUrls?: string[];
  didSendViaMessagingTool?: boolean;
  yieldDetected?: boolean;
  yieldAcknowledgment?: string;
  yieldMessageWaitRegistered?: boolean;
  assistantTexts?: readonly string[];
  allowedToolNames?: string[];
  toolMetas?: Array<{
    toolName: string;
    toolCallId?: string;
    meta?: string;
    replaySafe?: boolean;
    isError?: boolean;
    terminate?: boolean;
    asyncStarted?: boolean;
    asyncTaskRunId?: string;
    asyncTaskId?: string;
  }>;
}) {
  const state: Parameters<typeof completeEmbeddedAttemptResult>[0]["state"] = {
    beforeAgentRunBlockedBy: undefined,
    terminal: params?.terminal ?? { kind: "ok" },
    trajectoryEndRecorded: false,
  };
  const settled: Parameters<typeof completeEmbeddedAttemptResult>[1] = {
    promptError: null,
    promptErrorSource: null,
    timedOutDuringCompaction: false,
    compactionOccurredThisAttempt: false,
    sessionIdUsed: "session-1",
    messagesSnapshot: params?.messagesSnapshot ?? [],
    lastAssistant: undefined,
    currentAttemptAssistant: undefined,
    currentAttemptCompletedAssistant: params?.currentAttemptCompletedAssistant,
    successfulNestedToolNames: params?.successfulNestedToolNames ?? [],
    attemptUsage: undefined,
    lastCallUsage: undefined,
    promptCache: undefined,
  };
  const prompt: Parameters<typeof completeEmbeddedAttemptResult>[2] = {
    preflightRecovery: undefined,
    contextBudgetStatus: undefined,
    yieldAborted: false,
    sessionIdUsed: settled.sessionIdUsed,
    sessionFileUsed: undefined,
    messagesSnapshot: settled.messagesSnapshot,
  };
  const subscription = {
    assistantTexts: [...(params?.assistantTexts ?? [])],
    didSendDeterministicApprovalPrompt: () => false,
    didSendViaMessagingTool: () => params?.didSendViaMessagingTool ?? false,
    getAcceptedSessionSpawns: () => [],
    getAssistantTurnCount: () => 0,
    getCompactionCount: () => 0,
    getHeartbeatToolResponse: () => params?.heartbeatToolResponse,
    getItemLifecycle: (): EmbeddedRunAttemptResult["itemLifecycle"] => ({
      startedCount: 0,
      completedCount: 0,
      activeCount: 0,
    }),
    getLastAssistantTextMessageIndex: () => undefined,
    getKeptAnswer: () => undefined,
    getLastCompactionTokensAfter: () => undefined,
    getLastToolError: () => undefined,
    getLatestMcpAppChannelView: () => params?.latestMcpAppChannelView,
    getLatestMcpConnectAction: () => undefined,
    getMessagingToolSentMediaUrls: () => params?.messagingToolSentMediaUrls ?? [],
    getMessagingToolSentTargets: () => [],
    getMessagingToolSentTexts: () => [],
    getMessagingToolSourceReplyPayloads: () => [],
    getSourceReplyDelivered: () => undefined,
    getSourceReplyDeliveryState: () => undefined,
    endsWithSourceProgress: () => false,
    getPendingToolMediaReply: () => params?.pendingToolMediaReply,
    getToolAutoDeliveryMediaUrls: () => params?.toolAutoDeliveryMediaUrls ?? [],
    getReplayState: () => ({ replayInvalid: false, hadPotentialSideEffects: false }),
    getSuccessfulCronAdds: () => 0,
    getVisibleBlockReplyCount: () => 0,
    hasToolMediaBlockReply: () => false,
    hasSuccessfulModelResponse: () => params?.hasSuccessfulModelResponse ?? false,
    setTerminalLifecycleMeta: () => {},
    toolMetas: params?.toolMetas ?? [],
  };
  const hookRunner = createHookRunner({ hooks: [], typedHooks: [], plugins: [] });
  const input = {
    attempt: {
      runId: "run-1",
      admittedRunContext: { operationalRunInstance: TEST_OPERATIONAL_RUN_INSTANCE },
      sessionId: "session-1",
      provider: "test",
      modelId: "model",
      model: { api: "openai-responses" },
      trigger: "user",
      allowEmptyAssistantReplyAsSilent: params?.replyOptional,
      terminalReplyExpectation: params?.replyOptional ? "optional" : undefined,
    },
    state,
    diagnostics: { diagnosticTrace: { traceId: "trace-1", spanId: "span-1" } },
    setup: { sessionAgentId: "main" },
    lifecycle: {
      readYieldState: () => ({
        yieldDetected: params?.yieldDetected ?? false,
        yieldAcknowledgment: params?.yieldAcknowledgment,
        yieldMessageWaitRegistered: params?.yieldMessageWaitRegistered,
      }),
    },
    prepared: {
      toolCatalog: {
        toolSearchRunPlan: { liveAllowedToolNames: new Set(params?.allowedToolNames) },
      },
      bootstrap: { bootstrapPromptWarning: {} },
      systemPrompt: { systemPromptReport: undefined },
      sessionRuntime: {
        agentSession: {
          clientToolCallSlots: params?.clientToolCallSlots ?? [],
          hasDeliveredSourceReply: () => false,
          hookRunner,
        },
        state: { promptCache: undefined },
        cacheTrace: null,
        trajectoryRecorder: params?.trajectoryRecorder,
        transport: { streamStrategy: "default" },
      },
    },
    preparedStreamRuntime: {
      stream: { subscription },
      cache: {},
    },
  };
  return { input, state, settled, prompt, hookRunner };
}
