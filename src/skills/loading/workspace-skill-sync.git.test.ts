// Generated sandbox instruction packages must stay out of ordinary Git discovery.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { refreshSkillsDiscovery } from "../runtime/refresh.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";
import { syncWorkspaceSkills } from "./workspace-skill-sync.runtime.js";

const execute = promisify(execFile);
const dirs = useAutoCleanupTempDirTracker(afterEach);

it("hides generated skills through initial sync, reuse and refresh without hiding project changes", async () => {
  const workspace = dirs.make("sandbox-skills-git-");
  const git = async (...args: string[]) =>
    (await execute("git", ["-C", workspace, ...args])).stdout.trim();
  await git("init", "--quiet");
  await fs.writeFile(path.join(workspace, "tracked.txt"), "initial\n");
  await git("add", "tracked.txt");
  await fs.writeFile(path.join(workspace, "tracked.txt"), "changed\n");
  await fs.writeFile(path.join(workspace, "unrelated.txt"), "unrelated\n");
  const sourceSkill = path.join(workspace, "skills", "local-note");
  await writeSkill({ dir: sourceSkill, name: "local-note", description: "Project source skill" });
  const options = {
    config: { plugins: { enabled: false } },
    bundledSkillsDir: path.join(workspace, ".empty-bundled"),
    managedSkillsDir: path.join(workspace, ".empty-managed"),
  };
  const params = {
    ...options,
    sourceWorkspaceDir: workspace,
    targetWorkspaceDir: path.join(workspace, ".openclaw", "sandbox-skills"),
    skillsSnapshot: await buildSkillSnapshot(workspace, options),
  };
  const assertDiscovery = async () => {
    const untracked = (await git("ls-files", "--others", "--exclude-standard")).split("\n");
    expect(untracked).toContain("unrelated.txt");
    expect(untracked).toContain("skills/local-note/SKILL.md");
    expect(untracked.some((file) => file.startsWith(".openclaw/sandbox-skills/"))).toBe(false);
    expect(await git("diff", "--name-only")).toBe("tracked.txt");
    expect(
      await fs.readFile(
        path.join(params.targetWorkspaceDir, "skills", "local-note", "SKILL.md"),
        "utf8",
      ),
    ).toContain("Project source skill");
  };
  await syncWorkspaceSkills(params);
  await assertDiscovery();
  await syncWorkspaceSkills(params);
  await assertDiscovery();
  await refreshSkillsDiscovery({ workspaceDir: workspace });
  await syncWorkspaceSkills({
    ...params,
    skillsSnapshot: await buildSkillSnapshot(workspace, options),
  });
  await assertDiscovery();
});
