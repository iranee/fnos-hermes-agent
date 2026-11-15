import * as fs from "node:fs";
import path from "node:path";
import { isFnosAdmin, requestOrigin } from "./fnos-access.js";

const NAME = "hermes-update";
const SHA = /^[a-f0-9]{40}$/i;
const ID = /^[a-f0-9]{32}$/;
const STATES = ["queued", "running", "succeeded", "failed", "interrupted"];
const BODY_LIMIT = 4096;
const RECEIPT_LIMIT = 2 * 1024 * 1024;
const FILE_LIMIT = 256;
const INITIALIZE = "请先在 fnOS 管理面板初始化可更新的 Hermes 源码内核；此接口不会自动初始化。";
const routes = new Map();
for (const prefix of ["/webapp", "/dashboard"]) {
  for (const [suffix, kind, method] of [
    ["/api/hermes/update", "update", "POST"],
    ["/api/hermes/update/check", "check", "GET"],
    ["/api/actions/hermes-update/status", "status", "GET"],
    ["/api/hermes/update/receipt", "receipt", "GET"],
  ]) routes.set(prefix + suffix, { kind, method });
}
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isSha = value => typeof value === "string" && SHA.test(value);
const isId = value => typeof value === "string" && ID.test(value);
const text = value => typeof value === "string" ? value : null;
const json = (value, status = 200, headers = {}) => Response.json(value, {
  status, headers: { "cache-control": "no-store", ...headers },
});
const localFaults = new WeakSet();
function fault(code, message, status = 503) {
  const error = Object.assign(new Error(message), { code, status });
  localFaults.add(error);
  return error;
}
function refusal(error, message, status) {
  return { status, payload: { ok: false, pid: null, name: NAME, error, message, update_command: "" } };
}
function reply(result) { return json(result.payload, result.status); }
function active(job) { return job && ["queued", "running"].includes(job.state); }
function accepted(job, already = false) {
  // The coordinator does not expose an updater child PID. Never use monitor's PID.
  return { status: 200, payload: { ok: true, pid: null, name: NAME, action_id: job.id,
    ...(already ? { already_running: true } : {}) } };
}
function validSnapshot(value) {
  return object(value) && value.ok === true && Array.isArray(value.lines) &&
    value.lines.every(row => object(row) && typeof row.text === "string") &&
    (value.job === null || (object(value.job) && isId(value.job.id) && STATES.includes(value.job.state)));
}
function sameSelection(a, b) {
  return ["kind", "id", "root", "launcher"].every(key => a[key] === b[key]);
}
function validCheck(result) {
  return result.ok === true && result.supported !== false && !result.error &&
    isSha(result.currentSha) && isSha(result.targetSha) && typeof result.updateAvailable === "boolean" &&
    Number.isSafeInteger(result.behind) && result.behind >= -1;
}
function checkPayload(result, selected) {
  const good = validCheck(result);
  const source = selected.kind === "source";
  const version = text(result.sourceVersion);
  let message = text(result.message);
  if (!source) message = INITIALIZE;
  else if (!good) message ||= "无法完成官方更新检查，请稍后重试。";
  else if (result.behind === 0 && result.held) message ||= "当前构建保持不变，等待兼容的新版本。";
  else if (!result.updateAvailable) message ||= "当前已是最新版本。";
  else if (result.rollback) message ||= `更新将回退到 ${version || "所选发布版本"}。`;
  return {
    install_method: source ? "git" : "managed-runtime",
    // source_check has no derived version: display the current revision, not the target's version.
    current_version: text(result.currentVersion) || (isSha(result.currentSha) ? result.currentSha.slice(0, 12) : null),
    behind: good ? result.behind : null,
    update_available: source && good ? result.updateAvailable : false,
    can_apply: source && good,
    update_command: source && good ? "hermes update" : "",
    message,
    held: result.held ?? null,
    rollback_to: result.rollback ? version : null,
    channel: text(result.channel), branch: text(result.branch), source_version: version,
    // Official actions.py: sha stays named `sha`, shortened to seven; at is seconds.
    commits: good && Array.isArray(result.commits) ? result.commits.slice(0, 20)
      .filter(row => object(row) && isSha(row.sha) && typeof row.summary === "string" &&
        typeof row.author === "string" && Number.isSafeInteger(row.at))
      .map(row => ({ sha: row.sha.slice(0, 7), summary: row.summary, author: row.author, at: Math.floor(row.at / 1000) })) : [],
    ...(!good ? { ok: false, error: text(result.error) || "invalid-check" } : {}),
  };
}
function parameters(url, kind) {
  const allowed = kind === "check" ? ["profile", "force"] : kind === "status" ? ["profile", "lines"] : ["profile"];
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) {
      throw fault("invalid-query", "不支持此查询参数或重复参数", 400);
    }
  }
  // Compatibility only: profile must never select DATA or reach the coordinator.
  const profile = url.searchParams.get("profile");
  if (profile !== null && profile !== "default") {
    throw fault("unsupported-profile", "此接口仅支持缺省或 profile=default，不支持空值或其他配置档案", 400);
  }
  const force = url.searchParams.get("force");
  if (force !== null && !["true", "false"].includes(force)) throw fault("invalid-force", "force 必须为 true 或 false", 400);
  const lines = url.searchParams.get("lines");
  if (lines !== null && (!/^-?\d+$/.test(lines) || !Number.isSafeInteger(Number(lines)))) {
    throw fault("invalid-lines", "lines 必须为安全整数", 400);
  }
  return { force: force === "true", lines: lines === null ? 200 : Math.min(Math.max(Number(lines), 1), 2000) };
}
async function emptyBody(req) {
  const length = req.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
    throw fault("invalid-body", "Content-Length 无效", 400);
  }
  if (Number(length) > BODY_LIMIT) throw fault("body-too-large", "请求体超过 4096 字节", 413);
  const reader = req.body?.getReader(), chunks = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > BODY_LIMIT) {
          void reader.cancel().catch(() => {});
          throw fault("body-too-large", "请求体超过 4096 字节", 413);
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
  }
  let body;
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch { throw fault("invalid-body", "请求体只允许为空或 {}", 400); }
  if (!object(body) || Object.keys(body).length) throw fault("invalid-body", "请求体只允许为空或 {}", 400);
}

function receiptTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19) ? time : NaN;
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function unsafe() { throw fault("receipt-unavailable", "没有可信的当前任务更新回执", 404); }

// Read-only, fail closed. On Linux pin each directory from / with O_NOFOLLOW,
// so an ancestor swap cannot redirect an open outside DATA. No mkdir/chmod/writes.
function withReceiptDirectory(dataDir, read) {
  const location = path.join(dataDir, "logs", "update_receipts");
  const root = path.parse(location).root;
  let cursor = root, fd;
  const observed = [];
  // WHY: Linux O_PATH (not exported by some Node versions) pins search-only ancestors without requiring read permission.
  const directoryFlags = (fs.constants.O_PATH ?? 0x200000) | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  try {
    if (process.platform === "linux") fd = fs.openSync(root, directoryFlags);
    for (const component of path.relative(root, location).split(path.sep)) {
      cursor = path.join(cursor, component);
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe();
      observed.push({ location: cursor, stat });
      if (fd !== undefined) {
        const next = fs.openSync(`/proc/self/fd/${fd}/${component}`, directoryFlags);
        fs.closeSync(fd); fd = next;
        if (!sameFile(stat, fs.fstatSync(fd))) unsafe();
      }
    }
    const directory = fd === undefined ? location : `/proc/self/fd/${fd}`;
    const verify = () => {
      for (const entry of observed) {
        const current = fs.lstatSync(entry.location);
        if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(entry.stat, current)) unsafe();
      }
      if (fd !== undefined && fs.realpathSync(directory) !== location) unsafe();
    };
    verify();
    const result = read(directory);
    verify();
    return result;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readReceiptFile(directory, name) {
  const file = path.join(directory, name), before = fs.lstatSync(file);
  const regular = stat => stat.isFile() && stat.nlink === 1 && stat.size <= RECEIPT_LIMIT;
  if (!regular(before)) unsafe();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!regular(opened) || !sameVersion(before, opened)) unsafe();
    const bytes = Buffer.alloc(RECEIPT_LIMIT + 1);
    let size = 0, count;
    while (size < bytes.length && (count = fs.readSync(fd, bytes, size, bytes.length - size, null))) size += count;
    if (size > RECEIPT_LIMIT || !sameVersion(opened, fs.fstatSync(fd)) || !sameVersion(opened, fs.lstatSync(file))) unsafe();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)).replace(/^\uFEFF/, ""));
  } finally { fs.closeSync(fd); }
}
function receiptBinding(job) {
  const r = job?.receipt;
  if (!isId(job?.id) || job.action === "initialize" || !object(r) || !isId(r.updateId) || !isId(r.correlationId) ||
      !isSha(r.currentSha) || !isSha(r.targetSha) || !["success", "partial", "failed", "refused", "interrupted"].includes(r.outcome) ||
      !Number.isFinite(receiptTime(r.startedAt)) || !Number.isFinite(receiptTime(r.finishedAt)) ||
      receiptTime(r.finishedAt) < receiptTime(r.startedAt) ||
      (job.currentSha != null && job.currentSha !== r.currentSha) ||
      (job.targetSha != null && job.targetSha !== r.targetSha)) return null;
  return r;
}
function validReceipt(r, binding, job) {
  return object(r) && r.schema === 1 && r.update_id === binding.updateId && r.correlation_id === binding.correlationId &&
    r.started_at === binding.startedAt && r.finished_at === binding.finishedAt && r.outcome === binding.outcome &&
    (r.action_id === null || r.action_id === undefined || r.action_id === job.id) &&
    object(r.pre_update) && r.pre_update.sha === binding.currentSha && object(r.post_update) && r.post_update.sha === binding.targetSha &&
    Number.isSafeInteger(r.pid) && r.pid > 0 && Array.isArray(r.argv) && r.argv.every(v => typeof v === "string") &&
    Array.isArray(r.steps) && r.steps.every(s => object(s) && typeof s.name === "string" && typeof s.ok === "boolean") &&
    Array.isArray(r.skips) && r.skips.every(object) && object(r.gateway_restart) && Array.isArray(r.fleet) && r.fleet.every(object) &&
    (r.stages === undefined || (Array.isArray(r.stages) && r.stages.every(object))) &&
    (r.followups === undefined || (Array.isArray(r.followups) && r.followups.every(f => object(f) && typeof f.step === "string"))) &&
    (r.user_action == null || object(r.user_action));
}
function currentReceipt(dataDir, job) {
  const binding = receiptBinding(job);
  if (!binding) return null;
  try {
    return withReceiptDirectory(dataDir, directory => {
      const entries = fs.opendirSync(directory), candidates = [];
      let count = 0, entry, latest = false;
      const archive = new RegExp(`^update_\\d{8}_\\d{6}_[1-9]\\d*_${binding.updateId}\\.json$`);
      try {
        while ((entry = entries.readSync())) {
          if (++count > FILE_LIMIT) unsafe();
          if (archive.test(entry.name)) candidates.push(entry.name);
          if (entry.name === "latest.json") latest = true;
        }
      } finally { entries.closeSync(); }
      // Prefer the per-run archive. A corrupt/ambiguous archive is not repaired
      // by falling back to a potentially stale latest.json from the same run.
      if (candidates.length > 1) unsafe();
      const name = candidates[0] || (latest ? "latest.json" : null);
      if (!name) return null;
      const receipt = readReceiptFile(directory, name);
      if (!validReceipt(receipt, binding, job)) return null;
      const stamp = receipt.started_at.replace(/[^0-9]/g, "").slice(0, 14);
      if (name !== "latest.json" && name !== `update_${stamp.slice(0, 8)}_${stamp.slice(8)}_${receipt.pid}_${binding.updateId}.json`) return null;
      return receipt; // Full official document, never reconstructed or rewritten.
    });
  } catch { return null; }
}
function receiptSummary(receipt, job) {
  return {
    outcome: receipt.outcome, started_at: receipt.started_at, finished_at: receipt.finished_at,
    // Native action_id is job.id, bound above through update_id/correlation_id/SHA.
    // Official action_id may be null: leave it untouched in the full receipt.
    action_id: job.id, pre_sha: receipt.pre_update.sha, post_sha: receipt.post_update.sha,
    post_version: receipt.post_update.version ?? null,
    fleet_states: [...new Set(receipt.fleet.map(e => String(e.state ?? "None")))].sort(),
    followups: (receipt.followups || []).map(f => ({ step: f.step, reason: String(f.reason || "") })),
    user_action: receipt.user_action ?? null,
  };
}

/**
 * Pass the SAME runtime/control/job as the panel; paths have BASE_PATH removed.
 * Route matches before the main proxy's dynamic maintenance/503 gate. handle()
 * owns fnOS admin + POST origin checks; internal control Requests carry no auth
 * headers/token and never reach an upstream WebApp/Dashboard or spawn an action.
 * Unknown routes return null. status/receipt need only job.status() + local DATA,
 * including while WebApp is stopped. Keep this instance for admission coalescing.
 */
export function createKernelNativeApi({ runtime, control, job, dataDir }) {
  if (![runtime?.resolve, control?.handle, job?.status].every(fn => typeof fn === "function") ||
      typeof dataDir !== "string" || !path.isAbsolute(dataDir) || path.resolve(dataDir) === path.parse(dataDir).root) {
    throw new TypeError("Kernel native API requires runtime, control, job and an absolute DATA directory");
  }
  dataDir = path.resolve(dataDir);
  let admission = null;
  async function snapshot() {
    const result = await job.status();
    if (!validSnapshot(result)) throw fault("invalid-job-status", "更新任务状态无效");
    return result;
  }
  function selected() {
    const result = runtime.resolve();
    if (!result || !["source", "package"].includes(result.kind)) throw fault("selection-changed", "内核选择无效，请重新检查");
    return { ...result };
  }
  async function invoke(suffix, body) {
    // Only literal internal paths and a checked SHA can enter the control plane.
    const req = new Request(`http://kernel-native.internal/api/hermes/update${suffix}`, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const response = await control.handle(req);
    if (!(response instanceof Response)) throw fault("invalid-control-response", "更新协调器响应无效");
    let payload;
    try { payload = await response.json(); } catch { throw fault("invalid-control-response", "更新协调器响应不是 JSON"); }
    if (!object(payload)) throw fault("invalid-control-response", "更新协调器响应格式无效");
    return { status: response.status, ok: response.ok, payload };
  }
  async function start() {
    const before = await snapshot();
    if (before.storageError) throw fault("job-storage-error", "任务存储异常，请在管理面板检查");
    if (active(before.job)) return accepted(before.job, true);
    const selection = selected();
    if (selection.kind === "package") return refusal("source-not-initialized", INITIALIZE, 409);
    const checked = await invoke("/check?force=true");
    if (!checked.ok || checked.payload.ok !== true) {
      const raced = await snapshot();
      if (!raced.storageError && active(raced.job)) return accepted(raced.job, true);
      return refusal(text(checked.payload.error) || "check-failed", text(checked.payload.message) || "官方检查失败，未启动更新", checked.ok ? 503 : checked.status);
    }
    const c = checked.payload;
    if (!sameSelection(selection, selected())) throw fault("selection-changed", "内核选择已改变，请重新检查", 409);
    if (!validCheck(c)) {
      throw fault("invalid-check", "官方检查缺少有效的修订或更新状态");
    }
    if (!c.updateAvailable) return refusal(c.held ? "update-held" : "no-update", text(c.message) || "官方检查没有可应用的更新", 409);
    const started = await invoke("", { targetSha: c.targetSha });
    if (!started.ok || started.payload.ok !== true) {
      const raced = await snapshot();
      if (!raced.storageError && active(raced.job)) return accepted(raced.job, true);
      return refusal(text(started.payload.error) || "update-failed", text(started.payload.message) || "无法提交更新任务", started.ok ? 503 : started.status);
    }
    if (!validSnapshot(started.payload) || !active(started.payload.job) || started.payload.storageError || started.payload.job.error) {
      throw fault("invalid-job-status", "协调器未返回有效的后台任务");
    }
    return accepted(started.payload.job);
  }
  async function statusResponse(lines) {
    let result;
    try { result = await snapshot(); }
    catch {
      return json({ name: NAME, running: false, exit_code: 1, pid: null, lines: [], action_id: null, receipt: null,
        error: { code: "invalid-job-status", message: "无法读取更新任务状态" } }, 503);
    }
    const current = result.job;
    const error = result.storageError || current?.error || null;
    const running = Boolean(active(current)) && !result.storageError;
    const exit = error && !running ? 1 : running || !current ? null :
      current.state === "succeeded" ? 0 : current.state === "interrupted" ? 130 : 1;
    const receipt = result.storageError ? null : currentReceipt(dataDir, current);
    const tail = result.lines.map(row => row.text);
    if (error) tail.push(`[${text(error.code) || "job-failed"}] ${text(error.message) || "更新任务失败"}`);
    return json({ name: NAME, running, exit_code: exit, pid: null, lines: tail.slice(-lines),
      action_id: current?.id ?? null, receipt: receipt ? receiptSummary(receipt, current) : null,
      ...(error ? { error: { code: text(error.code) || "job-failed", message: text(error.message) || "更新任务失败" } } : {}),
    }, result.storageError ? 503 : 200);
  }
  async function handle(req, localPath) {
    const url = new URL(req.url), route = routes.get(localPath ?? url.pathname);
    if (!route) return null;
    if (!isFnosAdmin(req)) return reply(refusal("admin-required", "需要 fnOS 管理员权限", 403));
    if (req.method !== route.method) return json({ detail: "Method Not Allowed" }, 405, { allow: route.method });
    if (req.method === "POST") {
      const site = req.headers.get("sec-fetch-site")?.trim().toLowerCase();
      if (!requestOrigin(req) || (site != null && !["same-origin", "same-site", "none"].includes(site))) {
        return reply(refusal("same-origin-required", "更新请求必须来自同源页面", 403));
      }
    }
    try {
      const options = parameters(url, route.kind);
      if (route.kind === "status") return await statusResponse(options.lines);
      if (route.kind === "receipt") {
        let state;
        try { state = await snapshot(); } catch { return json({ detail: "没有可信的当前任务更新回执" }, 404); }
        const receipt = state.storageError ? null : currentReceipt(dataDir, state.job);
        return receipt ? json({ receipt, summary: receiptSummary(receipt, state.job) }) :
          json({ detail: "没有可信的当前任务更新回执" }, 404);
      }
      if (route.kind === "check") {
        const selection = selected();
        const result = await invoke(`/check?force=${options.force}`);
        if (!sameSelection(selection, selected())) throw fault("selection-changed", "内核选择已改变，请重新检查", 409);
        return json(checkPayload(result.ok ? result.payload : { ...result.payload, ok: false }, selection), result.status);
      }
      await emptyBody(req);
      if (admission) {
        const result = await admission;
        return reply(result.payload.ok ? { ...result, payload: { ...result.payload, already_running: true } } : result);
      }
      const pending = start();
      admission = pending;
      try { return reply(await pending); }
      finally { if (admission === pending) admission = null; }
    } catch (error) {
      // Do not reflect arbitrary dependency exceptions (paths, argv or secrets).
      const known = localFaults.has(error);
      return reply(refusal(known ? error.code : "native-api-failed",
        known ? error.message : "更新协调接口暂不可用", known ? error.status : 503));
    }
  }
  return { matches: localPath => routes.has(localPath), handle };
}
