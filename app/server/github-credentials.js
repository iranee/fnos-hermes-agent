// Server-only credential boundary. Never serialize environments or helper stdout.
// The token lives only in this process' memory; DATA/.env stays the single source.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const MESSAGES = Object.freeze({
  GHC_ARGUMENTS: "GitHub 凭据参数无效。",
  GHC_PATH: "无法访问 Hermes 数据目录。",
  GHC_PROFILE: "无法从 .env 读取 GitHub Token（GITHUB_TOKEN）。",
  GHC_HELPER: "GitHub Token 读取未能完成。",
  GHC_CLOSED: "GitHub 凭据服务已关闭。",
  ABORT_ERR: "GitHub 凭据操作已取消。",
});
const HELPER_CODES = new Set(["GHC_ARGUMENTS", "GHC_PATH", "GHC_PROFILE"]);
const validToken = value => typeof value === "string" && /^[\x21-\x7e]{1,4096}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
function failure(code) { return Object.assign(new Error(MESSAGES[code]), { code }); }
function emit(callback, text) {
  try { Promise.resolve(callback(text)).catch(() => {}); } catch { /* Observers cannot affect credentials or jobs. */ }
}
function absolute(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw failure("GHC_ARGUMENTS");
  return path.resolve(value);
}

export function createGitHubCredentials({ appDir, dataDir, networkProxy, log = () => {},
  execute = promisify(execFile), now = Date.now }) {
  appDir = absolute(appDir); dataDir = absolute(dataDir);
  const python = path.join(dataDir, "venv", "bin", "python");
  const args = ["-I", path.join(appDir, "server", "github-credentials.py"), "--home", dataDir];
  let token = null, checkedAt = null, flight = null, closed = false, started = false, lastFailure = null;

  function observe(error) {
    if (error) {
      if (error.code === "ABORT_ERR" || error.code === "GHC_CLOSED" || error.code === lastFailure) return;
      lastFailure = error.code;
      emit(log, `GitHub Token 读取失败（${error.code}）：${error.message}` +
        (token === null ? "GitHub 查询暂按匿名方式进行。" : "继续使用上次读取的 Token。"));
      return;
    }
    if (lastFailure !== null) { lastFailure = null; emit(log, "GitHub Token 已恢复读取。"); }
  }

  async function read(controller) {
    try {
      // Never use runKernelProcess: stdout here is a private IPC containing a token.
      // In particular do not forward execFile's Error (cmd/stdout/stderr/cause).
      const capture = execute(python, [...args], {
        encoding: "utf8", maxBuffer: 32 * 1024, timeout: 15000,
        windowsHide: true, signal: controller.signal,
      });
      // promisify(execFile) can reject on abort before the child emits close.
      // Drain that private process too, so close() really waits for it.
      const childClosed = capture?.child?.once ? new Promise(resolve => capture.child.once("close", resolve)) : null;
      let response;
      try { response = await capture; }
      finally { if (childClosed) await childClosed; }
      if (controller.signal.aborted) throw failure("ABORT_ERR");
      if (typeof response?.stdout !== "string" || Buffer.byteLength(response.stdout) > 32 * 1024) throw failure("GHC_HELPER");
      const value = JSON.parse(response.stdout);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("GHC_HELPER");
      if (HELPER_CODES.has(value.code)) throw failure(value.code);
      if (value.schema !== 1 || !Object.keys(value).every(key => ["schema", "token"].includes(key)) ||
          !(value.token === null || validToken(value.token))) {
        throw failure("GHC_HELPER");
      }
      // An empty or removed GITHUB_TOKEN revokes the in-memory copy.
      token = value.token;
      const timestamp = now();
      checkedAt = integer(timestamp) ? timestamp : null;
      return Object.freeze({ code: "GHC_OK", available: token !== null, checkedAt });
    } catch (error) {
      // Only fixed codes we produced may cross the boundary, even with injected execute().
      const code = controller.signal.aborted ? "ABORT_ERR" :
        (HELPER_CODES.has(error?.code) ? error.code : "GHC_HELPER");
      throw failure(code);
    }
  }

  async function refresh({ signal } = {}) {
    if (signal?.aborted) throw failure("ABORT_ERR");
    if (closed) throw failure("GHC_CLOSED");
    if (flight?.controller.signal.aborted) {
      // A new caller must not inherit the cancellation of the last old waiter.
      // Wait until that old child is fully drained before starting another.
      const draining = flight;
      await new Promise((resolve, reject) => {
        const cancel = () => { signal?.removeEventListener("abort", cancel); reject(failure("ABORT_ERR")); };
        const finished = () => { signal?.removeEventListener("abort", cancel); resolve(); };
        signal?.addEventListener("abort", cancel, { once: true });
        draining.promise.then(finished, finished);
        if (signal?.aborted) cancel();
      });
      return refresh({ signal });
    }
    if (!flight) {
      const operation = { controller: new AbortController(), users: 0, settled: false, promise: null };
      flight = operation;
      operation.promise = read(operation.controller).then(
        result => { observe(null); return result; },
        error => { observe(error); throw error; },
      ).finally(() => {
        operation.settled = true;
        if (flight === operation) flight = null;
      });
    }
    const operation = flight;
    operation.users++;
    // Each waiter can cancel without cancelling another job's coalesced refresh.
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, result) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", cancel);
        operation.users--;
        if (!operation.settled && operation.users === 0) operation.controller.abort();
        error ? reject(error) : resolve(result);
      };
      const cancel = () => finish(failure("ABORT_ERR"));
      signal?.addEventListener("abort", cancel, { once: true });
      operation.promise.then(result => finish(null, result), error => finish(error));
      if (signal?.aborted) cancel();
    });
  }

  function cachedEnvironment(baseEnv) {
    const result = { ...baseEnv };
    if (token !== null) result.GITHUB_TOKEN = token;
    return result;
  }
  async function environment(baseEnv, { signal } = {}) {
    try { await refresh({ signal }); }
    catch (error) {
      // An unreadable .env must not block updates: keep the last token read,
      // or go anonymous. Cancellation and shutdown still stop the caller.
      if (error.code === "ABORT_ERR" || error.code === "GHC_CLOSED") throw error;
    }
    if (signal?.aborted) throw failure("ABORT_ERR");
    return cachedEnvironment(baseEnv);
  }

  async function quota({ signal, env, onEvent = () => {} } = {}) {
    let authSubmitted = false;
    const unavailable = code => {
      const result = Object.freeze({ code, authSubmitted, authenticated: false });
      emit(onEvent, code === "ABORT_ERR" ? "GitHub 额度查询已取消。" :
        "未能查询 GitHub 额度，认证状态也未确认。" + `（${code}）`);
      return result;
    };
    try {
      if (signal?.aborted) return unavailable("ABORT_ERR");
      // Deliberately use the job's explicit environment, NOT process.env, gh or
      // a subsequently rotated manager token. A missing env means anonymous.
      let credential = null;
      for (const key of ["GITHUB_TOKEN", "GH_TOKEN"]) {
        const value = env?.[key];
        if (value == null || value === "") continue;
        if (typeof value !== "string") return unavailable("GHC_QUOTA_TOKEN_INVALID");
        if (!value.trim()) continue;
        if (!validToken(value.trim())) return unavailable("GHC_QUOTA_TOKEN_INVALID");
        credential = value.trim();
        break;
      }
      authSubmitted = credential !== null;
      const headers = { accept: "application/vnd.github+json", "user-agent": "fnos-hermes-update-quota" };
      if (credential) headers.authorization = `Bearer ${credential}`;
      const body = await networkProxy.requestJson("https://api.github.com/rate_limit", {
        headers, timeoutMs: 5000, maxRedirects: 0, maxBytes: 64 * 1024, signal,
      });
      if (signal?.aborted) return unavailable("ABORT_ERR");
      const core = body?.resources?.core;
      if (!core || !["limit", "used", "remaining", "reset"].every(key => integer(core[key])) ||
          core.reset > 253402300799) return unavailable("GHC_QUOTA_INVALID");
      const result = Object.freeze({ code: "GHC_QUOTA_OK", authSubmitted, authenticated: authSubmitted,
        limit: core.limit, used: core.used, remaining: core.remaining, reset: core.reset });
      const resetParts = Object.fromEntries(new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
        day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(core.reset * 1000)).map(part => [part.type, part.value]));
      const resetText = `${resetParts.year}-${resetParts.month}-${resetParts.day} ${resetParts.hour}:${resetParts.minute}:${resetParts.second}`;
      emit(onEvent, `GitHub ${result.authenticated ? "认证" : "匿名"}额度：限额 ${result.limit} 次/小时；已使用 ${result.used}；剩余 ${result.remaining}；重置 ${resetText}。`);
      return result;
    } catch {
      // requestJson rejects non-2xx, including 401; submitting a token is not
      // proof of authentication. Never copy the exception or any response body.
      return unavailable(signal?.aborted ? "ABORT_ERR" : "GHC_QUOTA_UNAVAILABLE");
    }
  }

  function start() {
    // One startup read loads the token. Later reads happen only when an
    // update check actually needs it.
    if (started || closed) return;
    started = true;
    void refresh().catch(() => {});
  }
  async function close() {
    closed = true;
    try { await flight?.promise; } catch { /* Failures were already reported once. */ }
    token = null;
  }
  return Object.freeze({ refresh, environment, cachedEnvironment, quota, start, close });
}
