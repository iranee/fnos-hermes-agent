import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, openSync, closeSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createDashboardOwnership, DASHBOARD_ARGS } from "./process-ownership.js";
import { WebappError } from "./webapp-runtime.js";

export function createDashboardProcess({ appDir, dataDir, varDir, env, runtime, basePath = "", log = () => {} }) {
  const ownership = createDashboardOwnership({ appDir, dataDir });
  const pidFile = `${varDir}/dashboard.pid`;
  const stateFile = `${varDir}/dashboard-state.json`;
  const prefix = `${basePath}/dashboard`;
  let record;
  let unverified;
  let starting;
  let closing = false;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function read(path) {
    try { return readFileSync(path, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  function remove(path) {
    try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  function load() {
    if (record) return record;
    const saved = read(stateFile);
    if (saved === null) {
      const marker = read(pidFile);
      if (marker === null) return null;
      const text = marker.trim();
      const pid = /^\d+$/.test(text) ? Number(text) : NaN;
      // 单凭 PID 无法证明归属，只有操作系统确认进程退出、且守卫内容未变时才能撤销守卫。
      if (Number.isSafeInteger(pid) && pid > 1 && ownership.inspect(pid).state === "gone" && read(pidFile) === marker) {
        remove(pidFile);
        return null;
      }
      throw new WebappError("Dashboard PID has no verified launch record; stop the application in fnOS first", 409);
    }
    let value;
    try { value = JSON.parse(saved); } catch { throw new WebappError("Invalid Dashboard launch record", 409); }
    if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 1 ||
        typeof value.starttime !== "string" || !/^\d+$/.test(value.starttime) ||
        typeof value.public_url !== "string" || typeof value.ready_file !== "string" ||
        !/^dashboard-ready-[a-f0-9]{24}\.json$/.test(value.ready_file)) {
      throw new WebappError("Invalid Dashboard launch record", 409);
    }
    record = value;
    return record;
  }
  function clear(current) {
    if (read(pidFile)?.trim() === String(current.pid)) remove(pidFile);
    const saved = read(stateFile);
    if (saved) {
      const identity = JSON.parse(saved);
      if (identity.pid === current.pid && identity.starttime === current.starttime) remove(stateFile);
    }
    remove(`${varDir}/${current.ready_file}`);
    if (record?.pid === current.pid && record.starttime === current.starttime) record = null;
  }
  function inspect() {
    if (unverified) return { state: "unverified", reason: unverified.reason };
    const current = load();
    if (!current) return { state: "gone" };
    const result = ownership.inspect(current.pid, current);
    if (result.state === "gone" || result.state === "replaced") {
      clear(current);
      return { state: "gone" };
    }
    return { ...result, public_url: current.public_url };
  }
  async function start() {
    if (closing) throw new WebappError("Dashboard process is shutting down");
    if (starting) return starting;
    starting = (async () => {
      const current = inspect();
      if (current.state === "owned") return current;
      if (current.state !== "gone") throw new WebappError(current.reason || "Cannot verify Dashboard ownership", 409);
      if (process.platform !== "linux") throw new WebappError("Dashboard ownership requires Linux /proc");
      mkdirSync(`${dataDir}/logs`, { recursive: true });
      const readyFile = `dashboard-ready-${randomBytes(12).toString("hex")}.json`;
      const command = runtime ? runtime.command(DASHBOARD_ARGS.slice(2)) : {
        executable: `${dataDir}/venv/bin/python`, args: DASHBOARD_ARGS, cwd: dataDir,
        env: { ...env, HERMES_WEB_DIST: `${appDir}/hermes-src/hermes_cli/web_dist` },
      };
      const launch = command.selected?.kind === "source" ? { id: command.selected.id, root: command.selected.root,
        token: randomBytes(32).toString("hex") } : null;
      const fd = openSync(`${dataDir}/logs/dashboard.log`, "a", 0o600);
      let child, identity, exited = false;
      try {
        const clean = { ...command.env };
        delete clean.HERMES_DASHBOARD_PUBLIC_URL;
        child = spawn(command.executable, command.args, {
          cwd: command.cwd, env: { ...clean,
            ...(launch ? { FNOS_LAUNCH_TOKEN: launch.token, FNOS_LAUNCH_ROLE: "Dashboard" } : {}),
            HERMES_DESKTOP_READY_FILE: `${varDir}/${readyFile}` },
          stdio: ["ignore", fd, fd], detached: true,
        });
      } finally { closeSync(fd); }
      child.once("exit", (code, signal) => {
        exited = true;
        log(`[dashboard] Exited (code=${code}, signal=${signal || "none"})`);
        try {
          if (identity) clear(identity);
          else if (unverified?.pid === child.pid) {
            if (read(pidFile)?.trim() === String(child.pid)) remove(pidFile);
            remove(`${varDir}/${readyFile}`);
            unverified = null;
          }
        } catch (error) { log(`[dashboard] PID cleanup failed: ${error.message}`); }
      });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      const deadline = Date.now() + (launch ? 30000 : 2000);
      while (!exited) {
        const verified = launch ? ownership.claim(child.pid, launch) : ownership.inspect(child.pid);
        if (verified.state === "owned") {
          identity = { ...verified.identity, public_url: "", ready_file: readyFile };
          record = identity;
          const temporary = `${stateFile}.${readyFile}.tmp`;
          try {
            writeFileSync(temporary, JSON.stringify(identity), { flag: "wx", mode: 0o600 });
            renameSync(temporary, stateFile);
            writeFileSync(pidFile, String(identity.pid), { mode: 0o600 });
          } catch (error) {
            const failures = [];
            try { await ownership.stop(identity); clear(identity); }
            catch (failure) { failures.push(failure.message); }
            try { remove(temporary); } catch (failure) { failures.push(failure.message); }
            throw new WebappError(`${error.message}${failures.length ? `; Dashboard cleanup failed: ${failures.join("; ")}` : ""}`);
          }
          child.unref();
          const live = inspect();
          if (live.state !== "owned") throw new WebappError(live.reason || "Dashboard exited during startup; inspect dashboard.log");
          return live;
        }
        if (Date.now() >= deadline) {
          const failure = new WebappError(verified.reason || "Cannot verify spawned Dashboard");
          if (verified.state !== "gone") {
            // 身份未经验证就不能发任何信号。这道默认拒绝（fail-closed）的保护会一直保持（monitor 重启后也保留），直到子进程退出。
            unverified = { pid: child.pid, reason: failure.message };
            try { writeFileSync(pidFile, String(child.pid), { mode: 0o600 }); }
            catch (error) { failure.message += `; Cannot persist Dashboard PID guard: ${error.message}`; }
          }
          remove(`${varDir}/${readyFile}`);
          throw failure;
        }
        await sleep(25);
      }
      remove(`${varDir}/${readyFile}`);
      throw new WebappError("Dashboard exited during startup; inspect dashboard.log");
    })();
    try { return await starting; } finally { starting = null; }
  }
  async function healthy() {
    const current = inspect();
    if (current.state !== "owned") return false;
    let ready;
    try { ready = JSON.parse(read(`${varDir}/${record.ready_file}`)); } catch { return false; }
    if (ready?.port !== 9119) return false;
    try {
      const response = await fetch("http://127.0.0.1:9119/", {
        headers: { Host: "127.0.0.1:9119", "X-Forwarded-Prefix": prefix },
        redirect: "manual", signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return false;
      await response.arrayBuffer();
      const live = inspect();
      return live.state === "owned" && live.identity.pid === current.identity.pid &&
        live.identity.starttime === current.identity.starttime;
    } catch { return false; }
  }
  async function stop(timeoutMs = 28000) {
    if (starting) await starting.catch(() => {});
    const current = inspect();
    if (current.state === "gone") return { ok: true };
    if (current.state !== "owned") throw new WebappError(current.reason || "Cannot verify Dashboard ownership", 409);
    const identity = record;
    await ownership.stop(current.identity, { timeoutMs });
    clear(identity);
    return { ok: true };
  }
  return { inspect, start, stop, healthy, shutdown: async timeoutMs => { closing = true; return stop(timeoutMs); } };
}
