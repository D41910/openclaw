import { beforeEach, describe, expect, it, vi } from "vitest";
import "../commands/doctor-memory-recall.js";
import "../commands/doctor-memory-search.js";
import { runMemorySearchHealthContribution } from "./doctor-health-contribution-runners.workspace.js";
import { createDoctorHealthFlowContext } from "./doctor-health-contributions.test-support.js";

const { note, getManager } = vi.hoisted(() => ({
  note: vi.fn(),
  getManager: vi.fn(() => {
    throw new Error("ordinary Doctor must not open a memory manager");
  }),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));
vi.mock("../plugins/memory-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/memory-runtime.js")>();
  return {
    ...actual,
    getActiveMemorySearchManagerCore: getManager,
    resolveActiveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" })),
  };
});

describe("ordinary Doctor memory output", () => {
  beforeEach(() => {
    note.mockClear();
    getManager.mockClear();
  });

  it.each([true, false])(
    "reports dreaming enabled=%s independently of disabled memory search without opening a manager",
    async (enabled) => {
      const ctx = createDoctorHealthFlowContext({
        cfg: {
          agents: { defaults: { workspace: "/missing-doctor-memory-workspace" } },
          memory: { search: { enabled: false, rememberAcrossConversations: false } },
          plugins: {
            entries: {
              "memory-core": {
                enabled: true,
                config: { dreaming: { enabled, frequency: "0 */4 * * *" } },
              },
            },
          },
        },
        options: { nonInteractive: true },
      });

      await runMemorySearchHealthContribution(ctx);

      expect(note).toHaveBeenCalledWith(
        "Memory search is explicitly disabled (enabled: false).",
        "Memory search",
      );
      expect(note).toHaveBeenCalledWith(
        `Dreaming: ${enabled ? "enabled" : "disabled"} (cadence 0 */4 * * *).`,
        "Memory search",
      );
      expect(getManager).not.toHaveBeenCalled();
    },
  );
});
