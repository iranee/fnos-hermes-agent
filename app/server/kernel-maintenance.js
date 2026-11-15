import { setTimeout as sleep } from "node:timers/promises";
import { WebappError } from "./webapp-runtime.js";

export function createKernelMaintenance({ drain, inspectGateway, inspectDashboard, control,
  stopGateway, startGateway, dashboard, gatewayHealthy, webappHealthy,
  stopping = () => false, waitMs = 60000, pollMs = 600 }) {
  let active = false;
  function inspect(read) {
    const state = read();
    if (!["owned", "gone"].includes(state.state)) throw new WebappError(state.reason || "Service identity cannot be verified", 409);
    return state.state === "owned";
  }
  async function restore(snapshot, { signal } = {}) {
    if (stopping() || signal?.aborted) return;
    const config = await control("settings");
    if (config.enabled !== snapshot.webappEnabled) throw new WebappError("WebApp enablement changed during kernel maintenance; refusing to overwrite the setting", 409);
    const failures = [];
    if (snapshot.gateway) {
      try {
        if (!inspect(inspectGateway)) await startGateway();
        const deadline = Date.now() + waitMs;
        let healthy = false;
        while (Date.now() < deadline) {
          signal?.throwIfAborted();
          if (stopping()) return;
          if (!inspect(inspectGateway)) throw new WebappError("Gateway exited while restoring services");
          healthy = await gatewayHealthy() && (!snapshot.webappEnabled || await webappHealthy());
          if (healthy) break;
          await sleep(pollMs, undefined, { signal });
        }
        if (!healthy) throw new WebappError("Gateway did not become healthy after kernel maintenance");
      } catch (error) { failures.push(error); }
    }
    if (snapshot.dashboard && !stopping() && !signal?.aborted) {
      try { await dashboard.start(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new WebappError(failures.map(error => error.message).join("; "));
  }
  async function resume(snapshot, options = {}) {
    try {
      if (!snapshot || stopping() || options.signal?.aborted) return;
      if (Object.hasOwn(options, "selected") && !options.selected) throw new WebappError("Kernel selection is unavailable; refusing to restore a different kernel", 409);
      await restore(snapshot, options);
    } finally { active = false; }
  }
  async function pause() {
    if (active || stopping()) throw Object.assign(new WebappError("Kernel maintenance is already active or shutting down", 409), { snapshot: null });
    active = true;
    let snapshot = null, mayHaveStopped = false;
    try {
      await drain();
      if (stopping()) throw new WebappError("Monitor is shutting down");
      const gateway = inspect(inspectGateway);
      const dashboardRunning = inspect(inspectDashboard);
      const config = await control("settings");
      if (typeof config.enabled !== "boolean" || config.error) throw new WebappError(config.error || "Cannot read WebApp enablement");
      snapshot = { gateway, dashboard: dashboardRunning, webappEnabled: config.enabled };
      if (gateway) {
        try { await control("idle"); }
        catch (error) {
          // Only the idle endpoint's known 409 active-task rejection proves
          // business-level busy protection. No service has been stopped yet.
          if (error?.status === 409 && ["Gateway has active tasks",
            "Gateway has active tasks; wait for them to finish before changing WebApp settings"].includes(error.message)) {
            throw Object.assign(new WebappError("Gateway has active tasks", 409), { code: "gateway-busy" });
          }
          throw error;
        }
      }
      if (dashboardRunning) { mayHaveStopped = true; await dashboard.stop(); }
      if (gateway) { mayHaveStopped = true; await stopGateway(); }
      if (inspect(inspectGateway) || inspect(inspectDashboard)) throw new WebappError("Services are still running after maintenance stop", 409);
      return snapshot;
    } catch (error) {
      try { if (snapshot && mayHaveStopped) await restore(snapshot); }
      catch (restoration) {
        error = new WebappError(`${error.message}; service recovery failed: ${restoration.message}`);
        error.recoveryRequired = true;
      }
      active = false;
      error.snapshot = null;
      throw error;
    }
  }
  return { pause, resume, busy: () => active };
}
