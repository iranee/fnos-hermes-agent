import { WebappError } from "./webapp-runtime.js";

export function createDashboardRuntime({ control, process: service, basePath, waitMs = 60000, pollMs = 600 }) {
  let queue = Promise.resolve();
  let cached;
  let checkedAt = 0;
  let pending;
  let closed = false;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function serial(fn) {
    const result = queue.then(async () => {
      if (closed) throw new WebappError("Dashboard control is shutting down");
      checkedAt = 0;
      try { return await fn(); } finally { checkedAt = 0; }
    });
    queue = result.catch(() => {});
    return result;
  }
  function inspect() {
    const current = service.inspect();
    if (!["owned", "gone"].includes(current.state)) {
      throw new WebappError(current.reason || "Dashboard PID identity changed", 409);
    }
    return current;
  }
  async function status(fresh = false) {
    if (!fresh && checkedAt && Date.now() - checkedAt < 2000) return cached;
    if (pending) {
      if (!fresh) return pending;
      await pending;
      return status(true);
    }
    pending = (async () => {
      let config = {}, current = { state: "gone" }, healthy = false, error = "";
      try {
        config = await control("dashboard-settings");
      } catch (failure) { error = failure.message; }
      // 即使设置或探测失败，Stop 时也必须停掉仍归本实例所有的进程。
      try {
        current = inspect();
        error ||= config.error || (!config.assets_ready ? "Official Dashboard assets are missing; install the complete application package" : "");
        if (current.state === "owned" && !error) {
          const identity = current.identity;
          try { healthy = await service.healthy(); } catch (failure) { error = failure.message; }
          current = inspect();
          healthy = !!healthy && current.state === "owned" && current.identity.pid === identity.pid &&
            current.identity.starttime === identity.starttime;
        }
      } catch (failure) {
        current = { state: "gone" }; healthy = false; error = failure.message;
      }
      const running = current.state === "owned";
      cached = { assets_ready: null, ...config, public_url: "", port: 9119, running, healthy, pid: current.identity?.pid || null,
        error: error || (running && !healthy ? "Dashboard is starting or unavailable; inspect its log" : "") };
      checkedAt = Date.now();
      return cached;
    })();
    try { return await pending; } finally { pending = null; }
  }
  async function waitForReady() {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && !closed) {
      if (inspect().state !== "owned") throw new WebappError("Dashboard exited during startup; inspect dashboard.log");
      const ready = await status(true);
      if (closed) throw new WebappError("Dashboard control is shutting down");
      if (ready.healthy) return ready;
      await sleep(pollMs);
    }
    throw new WebappError("Dashboard did not become ready in time; inspect dashboard.log");
  }
  async function start() {
    const current = inspect();
    if (current.state === "owned") return { ok: true, dashboard: await waitForReady() };
    await control("dashboard-prepare");
    if (closed) throw new WebappError("Dashboard control is shutting down");
    await service.start();
    try { return { ok: true, dashboard: await waitForReady() }; }
    catch (error) {
      try { await service.stop(); }
      catch (stopError) { throw new WebappError(`${error.message}; Dashboard cleanup failed: ${stopError.message}`); }
      throw error;
    }
  }
  return {
    status,
    start: () => serial(start),
    stop: () => serial(async () => { inspect(); await service.stop(); return { ok: true }; }),
    open: () => serial(async () => {
      const ready = await status(true);
      if (!ready.healthy) await start();
      return { ok: true, path: `${basePath}/dashboard/sessions` };
    }),
    shutdown: async timeoutMs => {
      closed = true;
      await service.shutdown(timeoutMs);
    },
  };
}
