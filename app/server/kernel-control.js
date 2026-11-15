import { createKernelVersion, formatKernelVersion } from "./kernel-version.js";

const routes = new Map([
  ["/api/hermes/kernel", "GET"],
  ["/api/hermes/update/check", "GET"],
  ["/api/hermes/update/channel", "POST"],
  ["/api/hermes/update/status", "GET"],
  ["/api/hermes/update/log/clear", "POST"],
  ["/api/hermes/initialize", "POST"],
  ["/api/hermes/update", "POST"],
]);

const commitDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
const dayOf = ms => Number.isSafeInteger(ms) && ms > 0 ? commitDay.format(new Date(ms)) : null;

export function createKernelControl({ runtime, checker, job, version = createKernelVersion({ runtime }) }) {
  const json = (value, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  const checks = new Set();
  const drain = () => Promise.allSettled([...checks]);
  let starting = false;
  async function start(options) {
    if (starting || job.busy()) return json({ ok: false, error: "内核更新任务正在运行，请查看更新日志" }, 409);
    starting = true;
    try {
      await drain();
      return json(await job.start(options), 202);
    } finally { starting = false; }
  }
  async function checked(options) {
    const pending = Promise.all([checker.check(options), version.read({ fresh: true })]);
    checks.add(pending);
    let result, identity;
    try { [result, identity] = await pending; } finally { checks.delete(pending); }
    if (result.currentSha && identity?.commit !== result.currentSha) identity = null;
    if (result.error === "selection-changed") identity = null;
    const targetDate = result.ok ? dayOf(result.targetAt) : null, currentDate = result.ok ? dayOf(result.currentAt) : null;
    const target = result.ok && result.aheadOfRelease === false
      ? formatKernelVersion({ version: String(result.sourceVersion || "").replace(/^v/, ""), commit: result.targetSha, releaseDate: targetDate }) : null;
    // main has no release version: name the upstream commit itself.
    const latest = !result.ok ? null : target?.full || (identity?.commit === result.targetSha ? identity.full
      : !result.channel && typeof result.targetSha === "string" && result.targetSha
        ? `上游提交 ${result.targetSha.slice(0, 12).toLowerCase()}${targetDate ? `（${targetDate}）` : ""}` : "官方未提供版本号");
    // Upstream names only non-main channels; a supported result without one is on main.
    return json({ ...result, channel: result.ok || result.supported === true ? result.channel || "main" : result.channel,
      current: identity?.full || null, currentVersion: identity, latest, targetDate, currentDate });
  }
  async function handle(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/app\/[^/]+/, "").replace(/\/+$/, "") || "/";
    const method = routes.get(path);
    if (!method) return null;
    if (method !== req.method) return new Response("Method Not Allowed", { status: 405, headers: { allow: method } });
    try {
      if (path === "/api/hermes/kernel") {
        const selected = runtime.resolve();
        const identity = starting || job.busy() ? null : await version.read();
        const active = runtime.resolve();
        if (["kind", "id", "root", "launcher"].some(key => active[key] !== selected[key])) {
          return json({ ok: false, error: "内核选择已改变，请刷新" }, 409);
        }
        return json({ ok: true, kind: selected.kind, id: selected.id, current: identity?.full || null,
          currentVersion: identity });
      }
      if (path === "/api/hermes/update/status") {
        const after = url.searchParams.get("after") ?? "0", run = url.searchParams.get("run");
        if (!after || /\D/.test(after) || !Number.isSafeInteger(Number(after)) || url.searchParams.getAll("after").length > 1) {
          return json({ ok: false, error: "Invalid log cursor", code: "invalid-request" }, 400);
        }
        if (url.searchParams.getAll("run").length > 1 || (run !== null && run !== "legacy" &&
          (run.length !== 32 || !/^[a-f0-9]{32}$/.test(run)))) {
          return json({ ok: false, error: "Invalid log run", code: "invalid-request" }, 400);
        }
        return json(await job.status({ after: Number(after), ...(run === null ? {} : { run }) }));
      }
      if (starting || job.busy()) return json({ ok: false, error: "内核更新任务正在运行，请查看更新日志" }, 409);
      if (path === "/api/hermes/update/check") {
        const force = url.searchParams.get("force");
        if (force !== null && !["true", "false"].includes(force)) {
          return json({ ok: false, error: "invalid-force", message: "force 必须为 true 或 false", updateAvailable: null }, 400);
        }
        return await checked({ force: force === "true" });
      }
      if (Number(req.headers.get("content-length")) > 4096) return json({ ok: false, error: "Request body too large" }, 413);
      const reader = req.body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader) {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 4096) {
              await reader.cancel();
              return json({ ok: false, error: "Request body too large" }, 413);
            }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
      }
      const text = Buffer.concat(chunks).toString("utf8");
      let body;
      try { body = text ? JSON.parse(text) : {}; } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "Invalid request" }, 400);
      if (path === "/api/hermes/update/log/clear") {
        if (Object.keys(body).length) return json({ ok: false, error: "Log clearing takes no parameters" }, 400);
        if (starting || job.busy()) return json({ ok: false, error: "内核更新任务正在运行，请查看更新日志" }, 409);
        starting = true;
        try { await drain(); return json(await job.clearLog()); }
        finally { starting = false; }
      }
      if (path === "/api/hermes/update/channel") {
        if (Object.keys(body).some(key => key !== "channel") || !["main", "stable"].includes(body.channel)) {
          return json({ ok: false, error: "invalid-channel", message: "更新通道只能是 main 或 stable", updateAvailable: null }, 400);
        }
        // Persisting the channel is a forced check: the result reflects the new channel at once.
        return await checked({ force: true, channel: body.channel });
      }
      if (path === "/api/hermes/initialize") {
        if (Object.keys(body).length) return json({ ok: false, error: "Initialization takes no parameters" }, 400);
        return await start({ action: "initialize" });
      }
      if (Object.keys(body).some(key => key !== "targetSha") || !/^[a-f0-9]{40}$/i.test(body.targetSha || "")) {
        return json({ ok: false, error: "Check for updates first and submit its targetSha" }, 400);
      }
      return await start({ action: "update", targetSha: body.targetSha });
    } catch (error) {
      if (path === "/api/hermes/update/status" && ["run-not-found", "invalid-request"].includes(error.code)) {
        return json({ ok: false, code: error.code, error: error.code === "run-not-found" ? "Kernel log run not found" : "Invalid log request" },
          error.code === "run-not-found" ? 404 : 400);
      }
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
      // Dependencies can attach private IPC output or credentials to exceptions.
      // Keep HTTP classification, but never serialize their arbitrary messages.
      return json({ ok: false, error: "Kernel control failed" }, status);
    }
  }
  return { handle, drain, matches: path => routes.has(path) };
}
