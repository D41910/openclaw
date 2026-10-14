import { TICK_INTERVAL_MS } from "../gateway/server-constants.js";
import { acquireWithWait } from "../infra/acquire-with-wait.js";
import { acquireGatewayLock, GatewayLockError } from "../infra/gateway-lock.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { GatewayStateOwnerContentionError } from "../infra/gateway-state-owner.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "../infra/restart-budget.js";
import type { RuntimeEnv } from "../runtime.js";
import { sleep } from "../utils/sleep.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import { isDoctorUpdateRepairMode, resolveDoctorRepairMode } from "./doctor-repair-mode.js";

/**
 * Update-time Doctor's single wait for another OpenClaw process to release state:
 * the installation-check interval, restart drain, and service stop allowances a
 * replaced Gateway already gets (11 minutes). With the slowest measured update
 * Doctor (258 s with 60 agents on 1 CPU and 10 MB/s disk) it stays well inside
 * the 30-minute update step timeout.
 */
export const DOCTOR_MAINTENANCE_CONTENTION_WAIT_MS =
  TICK_INTERVAL_MS + resolveGatewayRestartDeferralTimeoutMs() + GATEWAY_SERVICE_STOP_TIMEOUT_MS;
const CONTENTION_PROGRESS_INTERVAL_MS = 30_000;

function formatSeconds(ms: number) {
  return `${Math.max(0, Math.round(ms / 1000))} s`;
}

function describeHolder(error: GatewayStateOwnerContentionError) {
  const { holder } = error;
  return `the OpenClaw ${holder?.role ? `${holder.role} ` : ""}process ${holder?.pid ?? "(unknown PID)"}`;
}

export async function acquireDoctorGatewayMaintenanceOwner(
  databasePath: string,
  env: NodeJS.ProcessEnv,
  params: {
    options: DoctorOptions;
    runtime: RuntimeEnv;
    assertCurrent?: () => void;
    deadlineMs?: number;
    signal?: AbortSignal;
  },
) {
  const updateRepair = isDoctorUpdateRepairMode(resolveDoctorRepairMode(params.options));
  const startedAt = performance.now();
  // Installation replacement is an unsupervised restart: detection, drain,
  // then server close and process exit each retain their owner's allowance.
  const contentionDeadlineMs = startedAt + DOCTOR_MAINTENANCE_CONTENTION_WAIT_MS;
  // A Gateway holder is bounded by any service stop Doctor started. A transient
  // holder is not: nothing Doctor stopped waits on it, and waiting holds no lock.
  const gatewayDeadlineMs = Math.min(params.deadlineMs ?? Infinity, contentionDeadlineMs);
  let waiting: "gateway" | "transient" | undefined;
  let nextProgressAt = 0;
  let pollMs = 100;
  // Each wait kind ends exactly at its own deadline.
  const pollUntil = (deadlineMs: number, now: number) => {
    const delayMs = Math.min(pollMs, deadlineMs - now);
    pollMs = Math.min(pollMs * 2, 1_000);
    return { delayMs };
  };
  let lastContention: GatewayStateOwnerContentionError | undefined;
  const acquire = async () => {
    try {
      const owner = await acquireGatewayLock({
        env,
        role: "sqlite-maintenance",
        allowInTests: true,
        lifecycleDeadlineMs: params.deadlineMs,
        assertCurrent: params.assertCurrent,
        onWait: params.runtime.log,
      });
      if (!owner) {
        throw new Error(`Doctor could not acquire maintenance ownership for ${databasePath}`);
      }
      return owner;
    } catch (error) {
      if (
        error instanceof GatewayLockError &&
        error.cause instanceof GatewayStateOwnerContentionError
      ) {
        throw error.cause;
      }
      throw error;
    }
  };
  try {
    const owner = await acquireWithWait({
      acquire,
      shouldRetry: (error) => {
        if (!updateRepair || !(error instanceof GatewayStateOwnerContentionError)) {
          return false;
        }
        params.signal?.throwIfAborted();
        params.assertCurrent?.();
        lastContention = error;
        const now = performance.now();
        // A recorded non-Gateway role is a command that finishes on its own. An
        // unknown or Gateway holder keeps the existing serving-owner decisions.
        const role = error.holder?.role;
        if (role !== undefined && role !== "gateway") {
          if (now >= contentionDeadlineMs) {
            return false;
          }
          if (waiting !== "transient" || now >= nextProgressAt) {
            params.runtime.log(
              waiting === "transient"
                ? `Still waiting for ${describeHolder(error)} to release ${error.databasePath} (${formatSeconds(now - startedAt)} of ${formatSeconds(DOCTOR_MAINTENANCE_CONTENTION_WAIT_MS)}).`
                : `Waiting up to ${formatSeconds(DOCTOR_MAINTENANCE_CONTENTION_WAIT_MS)} for ${describeHolder(error)} to release ${error.databasePath} before Doctor maintenance. Let it finish, or stop it to continue sooner.`,
            );
            nextProgressAt = now + CONTENTION_PROGRESS_INTERVAL_MS;
          }
          waiting = "transient";
          return pollUntil(contentionDeadlineMs, now);
        }
        // A delegated updater may reach Doctor before its replaced foreground
        // Gateway observes the new installation and finishes releasing state.
        if (!params.assertCurrent || now >= gatewayDeadlineMs) {
          return false;
        }
        if (waiting !== "gateway") {
          waiting = "gateway";
          params.runtime.log("Waiting for the previous foreground Gateway to release state.");
        }
        // The physical lock decides ownership. A replacement owner may make us
        // wait until the same bounded deadline, but cannot grant unsafe access.
        return pollUntil(gatewayDeadlineMs, now);
      },
      deadlineMs: contentionDeadlineMs,
      pollIntervalMs: 100,
      sleep: (ms) => sleep(ms, params.signal),
    });
    if (waiting === "transient") {
      params.runtime.log(
        `State ownership released after ${formatSeconds(performance.now() - startedAt)}; continuing Doctor maintenance.`,
      );
    }
    return owner;
  } catch (error) {
    if (
      waiting === "transient" &&
      error === lastContention &&
      error instanceof GatewayStateOwnerContentionError
    ) {
      // Keep the contention class: admission still classifies it as deferred.
      throw new GatewayStateOwnerContentionError(
        error.databasePath,
        error,
        `Doctor waited ${formatSeconds(performance.now() - startedAt)} for ${describeHolder(error)} to finish; ${error.holderDetail ?? "it is still running."}`,
        error.holder,
      );
    }
    throw error;
  }
}
