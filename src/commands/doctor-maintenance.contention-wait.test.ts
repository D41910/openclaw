import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GatewayLockRole } from "../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { DOCTOR_MAINTENANCE_CONTENTION_WAIT_MS } from "./doctor-maintenance-foreground.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeOpenClawStateDatabaseForTest();
});

function holdState(role: GatewayLockRole, update: boolean) {
  const stateDir = dirs.make("doctor-contention-wait-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", update ? "1" : "");
  withOpenClawStateStartupMigrationCheckpointDatabase(() => {});
  closeOpenClawStateDatabaseForTest();
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const holder = acquireGatewayStateOwner({
    databasePath,
    payload: {
      pid: process.pid,
      role,
      createdAt: new Date().toISOString(),
      configPath: path.join(stateDir, "openclaw.json"),
      stateDir,
    },
  });
  return { databasePath, holder, before: fs.readFileSync(databasePath) };
}

function startDoctor() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const clock = { ms: 0 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.ms);
  const firstLog = createDeferredCore();
  const log = vi.fn((..._args: unknown[]) => firstLog.resolve());
  let settled = false;
  // Published drivers can run the activation Doctor without an update authority callback.
  const result = beginDoctorMaintenance({
    options: { repair: true, nonInteractive: true },
    root: null,
    runtime: { log, error: vi.fn(), exit: vi.fn() },
  }).then(
    (maintenance) => {
      settled = true;
      return { maintenance };
    },
    (error: unknown) => {
      settled = true;
      return { error };
    },
  );
  const advanceTo = async (ms: number) => {
    clock.ms = ms;
    await vi.advanceTimersToNextTimerAsync();
  };
  // Without the wait, admission settles before logging anything.
  const firstWait = Promise.race([firstLog.promise, result]);
  return { log, result, advanceTo, firstWait, isSettled: () => settled };
}

it("waits for a transient OpenClaw command to release state before update Doctor maintenance", async () => {
  const { databasePath, holder, before } = holdState("agent-embedded", true);
  const doctor = startDoctor();
  try {
    await doctor.firstWait;
    expect(doctor.log).toHaveBeenCalledWith(
      `Waiting up to 660 s for the OpenClaw agent-embedded process ${process.pid} to release ${databasePath} before Doctor maintenance. Let it finish, or stop it to continue sooner.`,
    );
    await doctor.advanceTo(45_000);
    expect(doctor.log).toHaveBeenCalledWith(
      `Still waiting for the OpenClaw agent-embedded process ${process.pid} to release ${databasePath} (45 s of 660 s).`,
    );
    // Waiting holds no lock and writes nothing; the holder can finish and release.
    await doctor.advanceTo(DOCTOR_MAINTENANCE_CONTENTION_WAIT_MS - 1_000);
    expect(doctor.isSettled()).toBe(false);
    expect(fs.readFileSync(databasePath)).toEqual(before);
    holder.release();
    await doctor.advanceTo(DOCTOR_MAINTENANCE_CONTENTION_WAIT_MS - 500);
    const completed = await doctor.result;
    expect(completed).toHaveProperty("maintenance");
    expect(doctor.log).toHaveBeenCalledWith(
      "State ownership released after 660 s; continuing Doctor maintenance.",
    );
    await ("maintenance" in completed ? completed.maintenance?.finish({}) : undefined);
  } finally {
    holder.release();
  }
});

it("fails update Doctor admission after the wait budget, naming the holder and next step", async () => {
  const { holder } = holdState("agent-embedded", true);
  const doctor = startDoctor();
  try {
    await doctor.firstWait;
    expect(doctor.log).toHaveBeenCalledWith(expect.stringContaining("Waiting up to 660 s"));
    await doctor.advanceTo(DOCTOR_MAINTENANCE_CONTENTION_WAIT_MS - 1);
    expect(doctor.isSettled()).toBe(false);
    await doctor.advanceTo(DOCTOR_MAINTENANCE_CONTENTION_WAIT_MS);
    const completed = await doctor.result;
    const error = "error" in completed ? completed.error : undefined;
    expect(error).toBeInstanceOf(DoctorMaintenanceRefusalError);
    // Contention stays a deferred refusal: no data is at risk.
    expect((error as DoctorMaintenanceRefusalError).refusal).toEqual({
      kind: "deferred",
      reason: "coordinator-contention",
    });
    const message = (error as Error).message;
    expect(message).toContain("Doctor could not enter maintenance.");
    expect(message).toContain(
      `Doctor waited 660 s for the OpenClaw agent-embedded process ${process.pid} to finish;`,
    );
    expect(message).toContain(`The holder ${process.pid} is alive on this host, stop it first.`);
    expect(message).toContain("then run openclaw doctor --fix from an independent shell.");
  } finally {
    holder.release();
  }
});

it.each([
  { name: "manual doctor --fix with a transient holder", role: "agent-embedded", update: false },
  { name: "update Doctor with a Gateway holder", role: "gateway", update: true },
] as const)("keeps immediate contention failure for $name", async ({ role, update }) => {
  const { holder } = holdState(role, update);
  const doctor = startDoctor();
  try {
    const completed = await doctor.result;
    expect(completed).toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining("OpenClaw state database is busy at"),
      }),
    });
    expect(doctor.log).not.toHaveBeenCalledWith(expect.stringContaining("Waiting up to"));
  } finally {
    holder.release();
  }
});
