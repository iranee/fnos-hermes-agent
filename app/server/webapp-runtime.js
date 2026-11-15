import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStartupDeadline, STARTUP_TIMEOUT_MS } from "./startup-readiness.js";

export class WebappError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

export function createPythonControl({ python, home, env, runtime, log = () => {} }) {
  const helper = fileURLToPath(new URL("./webapp-control.py", import.meta.url));
  function run(args, payload, timeout, parse) {
    return new Promise((resolve, reject) => {
      const command = runtime ? runtime.command(parse ? args.slice(1) : args.slice(2),
        parse ? { helper: "webapp-control" } : {}) : { executable: python, args, env, cwd: home };
      const child = spawn(command.executable, command.args, { cwd: command.cwd,
        env: { ...command.env, HERMES_HOME: home }, windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      let diagnostics = "";
      let failure;
      const label = args[args.length - 1];
      const timer = setTimeout(() => { failure = new WebappError("Hermes control timed out; inspect service status before retrying"); child.kill(); }, timeout);
      child.on("error", () => { clearTimeout(timer); reject(new WebappError("Cannot start the packaged Hermes Python runtime")); });
      child.stdout.on("data", chunk => {
        output += chunk.toString();
        if (output.length > 1024 * 1024) { failure = new WebappError("Hermes control output exceeded its limit"); child.kill(); }
      });
      child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); });
      child.stdin.on("error", () => {});
      child.on("close", code => {
        clearTimeout(timer);
        const fail = error => {
          const trace = diagnostics.trim();
          if (trace) log(`[webapp-control] ${label} 失败 (exit=${code}):\n${trace}`);
          reject(error);
        };
        if (failure) return fail(failure);
        if (!parse) return code === 0 ? resolve() : fail(new WebappError("Gateway refused to stop or failed to exit; check active tasks and the gateway log", 409));
        let result;
        try { result = JSON.parse(output.trim()); }
        catch { return fail(new WebappError("Hermes returned an invalid control response")); }
        if (code !== 0 || result.ok !== true) return fail(new WebappError(result.error || "Hermes control failed", result.status || 503));
        resolve(result.result);
      });
      child.stdin.end(payload === undefined ? undefined : JSON.stringify(payload));
    });
  }
  return {
    control: (action, payload) => run([helper, "--home", home, action], payload, 30000, true),
    stopGateway: () => run(["-m", "hermes_cli.main", "gateway", "stop"], undefined, 60000, false),
  };
}


function loopbackOrigin(value, port) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || (port !== undefined && Number(url.port || 80) !== port)) return null;
    // Never let DNS turn a diagnostic control URL into a probe of another origin.
    if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    return url.origin;
  } catch { return null; }
}

async function probeWebapp(origin) {
  try {
    const response = await fetch(`${origin}/webapp/launch`, { redirect: "manual", signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    // Official launch_page returns a public HTML handoff page before ticket
    // redemption. 401/403, a sign-in redirect, 404 and 503 are not that page.
    return response.status === 200;
  } catch { return false; }
}

// A failed readiness probe (including HTTP 503 or a timeout) is NOT proof of exit.
async function probeWebappStopped(origin) {
  try {
    const response = await fetch(`${origin}/webapp/launch`, { redirect: "manual", signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    return false;
  } catch (error) {
    if (error.cause?.code === "ECONNREFUSED") return true;
    throw new WebappError("Cannot confirm that the old WebApp listener has stopped");
  }
}

export function createWebappRuntime({ control, startGateway, stopGateway, basePath, port = 9120,
  onPid = () => {}, waitMs = STARTUP_TIMEOUT_MS, pollMs = 600, probe = probeWebapp,
  probeStopped = probeWebappStopped, now = () => Date.now() }) {
  const readiness = createStartupDeadline({ waitMs, now });
  let queue = Promise.resolve();
  let settingsCache;
  let statusCache;
  let settingsAt = 0;
  let statusAt = 0;
  let statusPending;
  let generation = 0;
  let settingsRequest = 0;
  let statusRequest = 0;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function invalidate() { generation++; settingsAt = 0; statusAt = 0; statusPending = undefined; }
  function serial(fn) {
    const pending = queue.then(async () => { invalidate(); try { return await fn(); } finally { invalidate(); } });
    queue = pending.catch(() => {});
    return pending;
  }
  async function settings(fresh = false) {
    if (!fresh && settingsAt && Date.now() - settingsAt <= 15000) return settingsCache;
    const request = ++settingsRequest;
    const epoch = generation;
    settingsAt = 0;
    const result = await control("settings");
    if (!result || typeof result.enabled !== "boolean" || typeof result.assets_ready !== "boolean") {
      throw new WebappError("Hermes returned an invalid WebApp settings response");
    }
    const config = { ...result, version: typeof result.version === "string" && result.version.trim() ? result.version : null,
      build: typeof result.build === "string" && result.build.length === 12 && /^[a-f0-9]{12}$/.test(result.build) ? result.build : null };
    if (request === settingsRequest && epoch === generation) {
      settingsCache = config;
      settingsAt = Date.now();
    }
    return config;
  }
  function validateLive(live) {
    if (!live || !["off", "starting", "serving", "unavailable"].includes(live.state)
      || !(live.pid === null || (Number.isSafeInteger(live.pid) && live.pid > 0))
      || (live.control_ready !== undefined && typeof live.control_ready !== "boolean")
      || (live.state === "serving" && !live.pid)) {
      throw new WebappError("Hermes returned an invalid or unknown WebApp status response");
    }
    return live;
  }
  async function status(fresh = false) {
    if (!fresh && statusAt && Date.now() - statusAt < 2000) return statusCache;
    if (!fresh && statusPending) return statusPending;
    const request = ++statusRequest;
    const epoch = generation;
    statusAt = 0;
    const pending = (async () => {
      let config = { enabled: null, assets_ready: null, version: null, build: null };
      let result;
      try {
        config = await settings(fresh);
        const live = validateLive(await control("status"));
        const serving = live.state === "serving";
        const origin = serving ? loopbackOrigin(live.url, port) : null;
        // A listener is running before HTTP is usable (503 gateway_not_ready).
        const ready = serving && live.control_ready !== false && !!origin && await probe(origin) === true;
        const pending = live.state === "starting" || (serving && !ready);
        if (request === statusRequest && epoch === generation) {
          if (pending) readiness.observe(`${live.pid}:${live.gateway_starttime || ""}`);
          else if (ready || live.state === "off") readiness.reset();
        }
        const expired = pending && readiness.expired();
        const error = config.error || (!config.assets_ready ? "Official WebApp assets are missing or stale; repair the application package" : "")
          || (live.state === "unavailable" ? live.reason || "WebApp is unavailable" : "")
          || (serving && !origin ? "Gateway reported an untrusted or outdated WebApp listener address" : "")
          || (expired ? "WebApp did not become healthy within the startup deadline; inspect the gateway log" : "");
        result = { ...config, running: serving, healthy: ready && config.enabled && !error, pid: live.pid || null,
          control_ready: live.control_ready ?? null, gateway_running: !!live.pid, port, error,
          state: expired || (serving && !origin) ? "unavailable" : pending ? "starting" : live.state };
      } catch (error) {
        result = { ...config, running: false, healthy: false, pid: null, gateway_running: null,
          port, state: "unknown", error: error.message };
      }
      // Older requests may finish after a fresh read or a mutation. They must not
      // republish their settings, status or PID into the new generation.
      if (request === statusRequest && epoch === generation) {
        try { if (result.gateway_running !== null) onPid(result.pid); }
        catch (error) {
          result = { ...result, running: false, healthy: false, pid: null, gateway_running: null,
            state: "unknown", error: error.message };
        }
        statusCache = result;
        statusAt = Date.now();
      }
      return result;
    })();
    statusPending = pending;
    try { return await pending; } finally { if (statusPending === pending) statusPending = undefined; }
  }
  async function waitFor() {
    const deadline = now() + waitMs;
    while (now() < deadline) {
      const result = await status(true);
      if (result.healthy) return result;
      if (result.error || ["unknown", "unavailable"].includes(result.state)) {
        throw new WebappError(result.error || "WebApp cannot be served");
      }
      await sleep(pollMs);
    }
    throw new WebappError("WebApp did not become healthy in time; inspect the gateway log");
  }
  async function settledGateway() {
    const deadline = now() + waitMs;
    let waited = false;
    while (now() < deadline) {
      const live = validateLive(await control("status"));
      if (live.state === "unavailable") throw new WebappError(live.reason || "Gateway is unavailable");
      if (live.state !== "starting" && !(live.control_ready === false && live.pid)) {
        if ((!live.pid && live.state !== "off") || (waited && !live.pid)) {
          throw new WebappError("Cannot determine Gateway identity after startup; no settings were changed", 409);
        }
        return live;
      }
      waited = true;
      await sleep(pollMs);
    }
    throw new WebappError("Gateway control did not become ready in time; no settings were changed");
  }
  async function assertIdle() {
    const idle = await control("idle");
    if (idle?.idle !== true) throw new WebappError("Cannot verify whether Gateway is idle; no service was stopped", 409);
  }
  async function restartRunning(live) {
    validateLive(live);
    if (live.state === "starting" || live.state === "unavailable" || (live.pid && live.control_ready === false)) {
      throw new WebappError("Gateway is not ready for a safe restart", 409);
    }
    if (live.pid) {
      await assertIdle();
      const stopped = await stopGateway();
      if (stopped === false || stopped?.ok === false) throw new WebappError(stopped?.error || "Gateway failed to stop", 409);
    }
    const result = await startGateway();
    if (result === false || result?.ok === false) throw new WebappError(result?.error || "Gateway failed to start");
  }
  async function stop() {
    const original = validateLive(await control("status"));
    if ((!original.pid && original.state !== "off") || (original.pid && original.control_ready === false)
        || original.state === "starting") {
      throw new WebappError("Cannot determine whether Gateway is ready; no WebApp settings were changed");
    }
    const origins = new Set([`http://127.0.0.1:${port}`]);
    if (original.url) {
      const origin = loopbackOrigin(original.url);
      if (!origin) throw new WebappError("Cannot verify the old WebApp listener address; no settings were changed");
      origins.add(origin);
    } else if (original.state === "serving") {
      throw new WebappError("Gateway did not report its WebApp listener address; no settings were changed");
    }
    if (original.pid) {
      const idle = await control("idle");
      if (idle?.idle !== true) throw new WebappError("Cannot verify whether Gateway is idle; no settings were changed", 409);
    }
    const configured = await control("configure", { enabled: false });
    if (typeof configured?.changed !== "boolean") throw new WebappError("Gateway did not confirm the WebApp configuration write");
    if (original.pid) {
      const stopped = await stopGateway();
      if (stopped === false || stopped?.ok === false) throw new WebappError(stopped?.error || "Gateway failed to stop", 409);
      const started = await startGateway();
      if (started === false || started?.ok === false) throw new WebappError(started?.error || "Gateway failed to start");
    }
    const deadline = Date.now() + waitMs;
    let detail = "";
    while (Date.now() < deadline) {
      const result = await status(true);
      // off + a new PID is a reply from the replacement Gateway's control socket,
      // not the PID/lock-file startup window or the old process's cached answer.
      const gatewayReady = original.pid ? result.gateway_running === true && result.control_ready !== false && result.pid !== original.pid
        : result.gateway_running === false;
      if (result.enabled === false && result.state === "off" && gatewayReady) {
        try {
          let closed = true;
          for (const origin of origins) if (await probeStopped(origin) !== true) closed = false;
          if (closed) return { ok: true, webapp: result };
          detail = "The old WebApp listener is still accepting connections";
        } catch (error) { detail = error.message; }
      } else {
        detail = result.error || "Gateway has not confirmed WebApp is off with its original running state preserved";
      }
      await sleep(pollMs);
    }
    throw new WebappError(`WebApp stop was not confirmed in time: ${detail}`);
  }
  // 私有回环 WebApp：不设公网 URL、不需二次登录，由 fnOS 登录保护代理。
  async function ensureRunning() {
    await control("check");
    const live = await settledGateway();
    // Already-owned startup (including serving + HTTP 503) is a wait, not a
    // configure/restart request. A timeout must leave the process untouched.
    if (live.state === "serving" && (await settings(true)).enabled) {
      const current = await status(true);
      if (current.healthy) return { ok: true, webapp: current };
      if (current.state !== "serving") return { ok: true, webapp: await waitFor() };
      // A ready HTTP listener with a settings error can still be explicitly
      // reconfigured (e.g. the old public_url), but only after confirmed idle.
    }
    if (live.pid) await assertIdle();
    const result = await control("configure", { enabled: true, port });
    if (typeof result?.changed !== "boolean") throw new WebappError("Gateway did not confirm the WebApp configuration write");
    if (result.changed || !live.pid || live.state !== "serving") await restartRunning(live);
    return { ok: true, webapp: await waitFor() };
  }
  const launchHash = /^#ticket=[A-Za-z0-9_-]{43}(&query=[^&#]*)?$/;
  function launchLink(result) {
    // 上游会保留启动时 public_url 带来的 auth_required，只有重启才能清除。
    if (result.sign_in === true) throw Object.assign(new WebappError("WebApp still demands a separate sign-in; restart Gateway to reset its public address", 409), { signIn: true });
    let url;
    try { url = new URL(result.url); } catch { throw new WebappError("Gateway returned an invalid WebApp URL"); }
    if (url.origin !== `http://127.0.0.1:${port}` || url.pathname !== "/webapp/launch" || url.search || !launchHash.test(url.hash)) {
      throw new WebappError("Gateway returned an unexpected WebApp launch link");
    }
    return { ok: true, path: `${basePath}/webapp/webapp/launch`, hash: url.hash };
  }
  return {
    status,
    waitUntilHealthy: waitFor,
    stop: () => serial(stop),
    ensureRunning: () => serial(ensureRunning),
    // 只调一次 Python：票据一次性且 60 秒有效，每个标签页进入前自己签发。
    launch: () => serial(async () => {
      const link = launchLink(await control("launch"));
      if (!await probe(`http://127.0.0.1:${port}`)) throw new WebappError("WebApp is still starting; retry shortly");
      return link;
    }),
    restart: () => serial(async () => {
      await control("check");
      const live = await settledGateway();
      if (live.pid) await assertIdle();
      await control("configure", { enabled: true, port });
      await restartRunning(live);
      await waitFor();
      return { ok: true };
    }),
    open: () => serial(async () => {
      let ready = await status(true);
      if (!ready.healthy) ready = (await ensureRunning()).webapp;
      try { return launchLink(await control("launch")); }
      catch (error) {
        if (!error.signIn) throw error;
        const live = await settledGateway();
        if (live.pid) await assertIdle();
        await control("configure", { enabled: true, port });
        await restartRunning(live);
        await waitFor();
        return launchLink(await control("launch"));
      }
    }),
  };
}
