import * as fs from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { runKernelProcess } from "./kernel-process.js";
import { networkEvent } from "./network-proxy-transport.js";
import { publicDiagnosis, diagnosticError } from "./network-diagnostics.js";

const OWNER = "fnos-kernel-update-job";
const ACTIVE_LOCKS = new Set();
const HEX = /^[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{40}$/i;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const STATES = ["queued", "running", "succeeded", "failed", "interrupted"];
const LEVELS = ["info", "warn", "error", "stdout", "stderr"];
const LOG_LIMIT = 8 * 1024 * 1024;
const newId = () => randomBytes(16).toString("hex");
const now = () => new Date().toISOString();
const messages = {
  "invalid-options": "Invalid kernel update job options",
  "invalid-request": "Invalid kernel update request",
  "run-not-found": "Kernel log run not found",
  "log-recovery-required": "Task recovery requires inspection; log display was not cleared",
  "gateway-busy": "Gateway 仍有活动任务，未停止服务、未执行更新；请待任务结束后从控制面板或独立终端更新",
  "job-busy": "Another kernel update job owns the DATA lock",
  "job-stopped": "Kernel update coordinator is shutting down",
  "lock-unknown": "Unverified kernel update lock; preserved without removal",
  "lock-orphan-process": "A previous kernel update still has live processes; lock preserved",
  "storage-unsafe": "Kernel job storage is unrecognized, changed or unsafe; existing data preserved",
  "selection-changed": "Kernel selection changed or is invalid; operation stopped",
  "initialize-source": "Initialization is allowed only for the packaged kernel",
  "update-package": "Initialize the source kernel before running an official update",
  "official-check": "Official update check did not approve an available update",
  "target-changed": "Official target changed; check again before updating",
  "acceptance-failed": "Kernel acceptance did not explicitly succeed",
  "receipt-invalid": "No fresh, correlated and fully accepted official update receipt",
  "pause-contract": "Failed pause did not supply a recovery snapshot; service state requires inspection",
  "job-interrupted": "Kernel job interrupted; no automatic resume or rollback",
  "job-restarted": "Coordinator exited during this job; no automatic continuation or rollback",
  "job-failed": "Kernel update dependency failed; no data or source rollback was attempted",
  "GHC_ARGUMENTS": "GitHub 凭据参数无效。",
  "GHC_PATH": "无法访问 Hermes 数据目录，未能读取 GitHub Token。",
  "GHC_PROFILE": "无法从 .env 读取 GitHub Token（GITHUB_TOKEN）。",
  "GHC_HELPER": "GitHub Token 读取未能完成。",
  "GHC_CLOSED": "GitHub 凭据服务已关闭。",
  "process-options": "Invalid kernel process options",
  "process-spawn": "Cannot start kernel process",
  "process-exit": "Kernel process exited unsuccessfully; inspect the preceding output",
  "process-aborted": "Kernel process was interrupted",
  "process-timeout": "Kernel process timed out; inspect the last started step",
  "process-output-limit": "Kernel process output exceeded its byte limit",
  "process-log-failed": "Kernel process output consumer failed",
  "process-cleanup": "Cannot confirm kernel process cleanup",
  "resume-failed": "Restoring the original service state failed; manual inspection is required",
};
function fail(code) { const e = new Error(messages[code]); e.code = code; return e; }
function safeError(e) {
  if (typeof e?.code === "string" && e.code.startsWith("NP_")) {
    // A dependency's NP_* prefix does not make its message or code public-safe.
    return { ...diagnosticError(e), message: "Kernel update network dependency failed; inspect the preceding output" };
  }
  const code = Object.hasOwn(messages, e?.code) ? e.code : "job-failed";
  return { code, message: messages[code] };
}
function optional(file) {
  try { return fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
function directories(dir) {
  if (typeof dir !== "string" || !path.isAbsolute(dir) || path.resolve(dir) === path.parse(dir).root) throw fail("storage-unsafe");
  let cursor = path.resolve(dir);
  for (;;) {
    if (!fs.lstatSync(cursor).isDirectory()) throw fail("storage-unsafe");
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
function sameFile(a, b) { return a && b && a.dev === b.dev && a.ino === b.ino; }
function regular(file, max = LOG_LIMIT + 8192) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || before.size > max) throw fail("storage-unsafe");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const actual = fs.fstatSync(fd);
    if (!sameFile(before, actual)) throw fail("storage-unsafe");
    return { bytes: fs.readFileSync(fd), stat: actual };
  } finally { fs.closeSync(fd); }
}
function json(bytes) { try { return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")); } catch { throw fail("storage-unsafe"); } }
function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function proc(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const end = text.lastIndexOf(") ");
  const fields = text.slice(end + 2).trim().split(/\s+/);
  if (!text.startsWith(`${pid} (`) || end < 0 || !/^\d+$/.test(fields[19] || "")) throw fail("lock-unknown");
  return { starttime: fields[19], state: fields[0] };
}
function bootId() {
  const id = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!UUID.test(id)) throw fail("lock-unknown");
  return id;
}
function fingerprint(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

// Only these locks are ours. This code never opens/deletes source .git locks,
// gateway PID files, upstream update markers or user-created lock formats.
function createLock(dataDir) {
  const location = path.join(dataDir, ".fnos-kernel-update.lock");
  function ownerValid(record) {
    return exact(record, ["schema", "owner", "dataDir", "pid", "platform", "starttime", "bootId", "uid", "token"]) &&
      record.schema === 1 && record.owner === OWNER && record.dataDir === dataDir && typeof record.token === "string" && HEX.test(record.token) &&
      Number.isSafeInteger(record.pid) && record.pid > 0 && record.platform === process.platform &&
      (process.platform === "linux" ? record.uid === process.getuid() && typeof record.starttime === "string" && /^\d+$/.test(record.starttime) &&
        typeof record.bootId === "string" && UUID.test(record.bootId) :
        record.uid === null && record.starttime === null && record.bootId === null);
  }
  function inspect() {
    const stat = fs.lstatSync(location);
    if (!stat.isDirectory()) throw fail("lock-unknown");
    const fd = process.platform === "linux" ? fs.openSync(location, "r") : undefined;
    try {
      if (fd !== undefined && !sameFile(stat, fs.fstatSync(fd))) throw fail("lock-unknown");
      // Pin the directory inode on Linux. A concurrent stale reclaimer must
      // never unlink an owner in a newly acquired directory at the same path.
      const pinned = process.platform === "linux" ? `/proc/self/fd/${fd}` : location;
      const entries = fs.readdirSync(pinned);
      if (entries.length !== 1 || entries[0] !== "owner.json") throw fail("lock-unknown");
      const file = path.join(pinned, "owner.json");
      const read = regular(file, 8192), record = json(read.bytes);
      if (!ownerValid(record) || (process.platform === "linux" &&
          (stat.uid !== record.uid || read.stat.uid !== record.uid))) throw fail("lock-unknown");
      return { fd, stat, file, bytes: read.bytes, record };
    } catch (e) { if (fd !== undefined) fs.closeSync(fd); throw e; }
  }
  function unchanged(held) {
    const again = regular(held.file, 8192);
    if (!sameFile(held.stat, fs.lstatSync(location)) ||
        !again.bytes.equals(held.bytes)) throw fail("lock-unknown");
  }
  function remove(held) {
    unchanged(held);
    fs.unlinkSync(held.file);
    // Only the successful unlinker can remove this still-pinned empty dir.
    fs.rmdirSync(location);
  }
  function classify(r) {
    if (ACTIVE_LOCKS.has(r.token)) return { state: "live", code: "job-busy" };
    if (process.platform !== "linux") throw fail("lock-unknown"); // No PID-only Windows reclaim.
    if (r.bootId !== bootId()) return { state: "stale" };
    try {
      const p = proc(r.pid);
      if (p.starttime === r.starttime && !["Z", "X", "x"].includes(p.state)) return { state: "live", code: "job-busy" };
    } catch (e) { if (!["ENOENT", "ESRCH"].includes(e.code)) throw e; }
    // The coordinator may have died before detached updater children. UID only
    // narrows the read-only search; the inherited token proves job membership.
    let unknown = false;
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        if (fs.statSync(`/proc/${entry}`).uid !== r.uid) continue;
        const p = proc(Number(entry));
        // A descendant cannot predate its coordinator. Older, non-dumpable
        // processes of the same UID are not evidence about this job.
        if (["Z", "X", "x"].includes(p.state) || BigInt(p.starttime) < BigInt(r.starttime)) continue;
        const env = fs.readFileSync(`/proc/${entry}/environ`, "utf8");
        if (env.split("\0").includes(`FNOS_KERNEL_UPDATE_JOB_TOKEN=${r.token}`)) return { state: "live", code: "lock-orphan-process" };
      } catch (e) {
        if (!["ENOENT", "ESRCH"].includes(e.code)) unknown = true;
      }
    }
    if (unknown) throw fail("lock-unknown");
    return { state: "stale" };
  }
  function probe() {
    let held;
    try {
      directories(dataDir);
      if (!optional(location)) return { state: "absent" };
      held = inspect();
      const result = classify(held.record);
      unchanged(held);
      return result;
    } catch { return { state: "unknown", code: "lock-unknown" }; }
    finally { if (held?.fd !== undefined) fs.closeSync(held.fd); }
  }
  function recover() {
    let held;
    try {
      held = inspect();
      const result = classify(held.record);
      if (result.state !== "stale") throw fail(result.code);
      remove(held);
    } catch (e) {
      if (["job-busy", "lock-orphan-process"].includes(e.code)) throw e;
      throw fail("lock-unknown");
    } finally { if (held?.fd !== undefined) fs.closeSync(held.fd); }
  }
  function acquire() {
    directories(dataDir);
    for (let attempt = 0; attempt < 3; attempt++) {
      try { fs.mkdirSync(location, { mode: 0o700 }); }
      catch (e) {
        if (e.code !== "EEXIST") throw fail("lock-unknown");
        recover(); continue;
      }
      const record = { schema: 1, owner: OWNER, dataDir, pid: process.pid, platform: process.platform,
        starttime: process.platform === "linux" ? proc(process.pid).starttime : null,
        bootId: process.platform === "linux" ? bootId() : null, uid: process.getuid?.() ?? null, token: newId() };
      const file = path.join(location, "owner.json");
      const fd = fs.openSync(file, "wx", 0o600);
      try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      ACTIVE_LOCKS.add(record.token);
      return { token: record.token, release() {
        const held = inspect();
        try {
          if (held.record.token !== record.token) throw fail("lock-unknown");
          remove(held); ACTIVE_LOCKS.delete(record.token);
        } finally { if (held.fd !== undefined) fs.closeSync(held.fd); }
      } };
    }
    throw fail("job-busy");
  }
  return { acquire, busy() {
    const result = probe();
    // Preserve the boolean API for known states; uncertainty is a diagnostic
    // error, not a claim that a job is running. GET probes never reclaim locks.
    if (result.state === "unknown") throw fail(result.code);
    return result.state === "live";
  } };
}

function redactor() {
  const secrets = new Set();
  function add(env) {
    for (const [key, value] of Object.entries(env || {})) {
      if (typeof value !== "string") continue;
      if (/(?:token|secret|password|passwd|api_?key|credential|authorization|proxy)/i.test(key) && value.length >= 3) {
        secrets.add(value); secrets.add(encodeURIComponent(value));
      }
      const match = /^[a-z][a-z\d+.-]*:\/\/([^/@]+)@/i.exec(value);
      if (match) for (const part of match[1].split(":")) {
        if (part.length >= 3) { secrets.add(part); try { secrets.add(decodeURIComponent(part)); } catch {} }
      }
    }
  }
  function text(value) {
    if (typeof value !== "string") return "[non-text output omitted]";
    if (Buffer.byteLength(value) > 16384) return "[oversized output line omitted]";
    let s = value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) s = s.split(secret).join("[REDACTED]");
    s = s.replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
      .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [REDACTED]")
      .replace(/(["']?\b(?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|credential|authorization))["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;]+)/gi, "$1[REDACTED]")
      .replace(/(--(?:password|token|secret|api-key)\s+)\S+/gi, "$1[REDACTED]")
      .replace(/</g, "‹").replace(/>/g, "›");
    return s.slice(0, 4096);
  }
  add(process.env);
  return { add, text };
}

function receiptFiles(dataDir) {
  let dir = dataDir;
  for (const part of ["logs", "update_receipts"]) {
    dir = path.join(dir, part);
    if (!optional(dir)) return [];
    directories(dir);
  }
  const names = fs.readdirSync(dir).filter(n => n === "latest.json" || /^update_[\w-]+\.json$/.test(n));
  if (names.length > 256) throw fail("receipt-invalid");
  return names.map(name => {
    const { bytes } = regular(path.join(dir, name), 2 * 1024 * 1024);
    return { name, hash: fingerprint(bytes), data: json(bytes) };
  });
}
function receiptTime(value) {
  // Official datetime.now(UTC).isoformat(): UTC, with optional microseconds.
  // Date.parse alone also accepts local dates, coerced arrays and invalid days.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) return NaN;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) return NaN;
  return time; // Millisecond precision matches the launcher's Date.now() bounds.
}
function acceptReceipt(before, after, { correlation, started, ended, currentSha, targetSha }) {
  const oldIds = new Set(before.map(r => r.data?.update_id));
  const candidates = after.filter(r => r.data?.correlation_id === correlation);
  if (!candidates.length) throw fail("receipt-invalid");
  let chosen;
  for (const { data: r, name, hash } of candidates) {
    const start = receiptTime(r.started_at), end = receiptTime(r.finished_at);
    if (r.schema !== 1 || typeof r.update_id !== "string" || !HEX.test(r.update_id) || oldIds.has(r.update_id) ||
        before.some(b => b.name === name && b.hash === hash) || r.outcome !== "success" ||
        !Number.isFinite(start) || !Number.isFinite(end) || start < started || end < start || end > ended ||
        r.pre_update?.sha !== currentSha || r.post_update?.sha !== targetSha ||
        !Array.isArray(r.steps) || r.steps.some(s => s?.ok !== true) ||
        (r.stages !== undefined && (!Array.isArray(r.stages) || r.stages.some(s => !["success", "skipped"].includes(s?.outcome)))) ||
        (r.followups !== undefined && (!Array.isArray(r.followups) || r.followups.length)) || r.user_action ||
        (r.exit_code !== undefined && r.exit_code !== 0) || (r.pm_exit_code !== undefined && r.pm_exit_code !== 0) ||
        (r.pm_sync_outcome !== undefined && r.pm_sync_outcome !== "ok") ||
        r.gateway_restart?.incomplete || r.gateway_restart?.phase_error || r.gateway_restart?.failed_units?.length ||
        (chosen && chosen.updateId !== r.update_id)) throw fail("receipt-invalid");
    chosen = { updateId: r.update_id, correlationId: correlation, startedAt: r.started_at,
      finishedAt: r.finished_at, outcome: "success", currentSha, targetSha };
  }
  return chosen;
}

/**
 * Injected contracts:
 * - pause(): {gateway,dashboard,webappEnabled}. On ANY rejection, error.snapshot
 *   MUST be present (null after pause's own restoration, or for no changes).
 *   A failed self-restoration also sets error.recoveryRequired. Without a
 *   snapshot recovery is unknowable; resume(null) must be a no-op.
 * - resume(snapshot,{success,selected,signal}): restores/verifies ONLY the former
 *   running services, never enables WebApp. selected may be null if resolve broke;
 *   in that case it must reject rather than launch a fallback. It must honor signal.
 * - complete/verify: explicit {ok:true}; any other result fails acceptance.
 * - checker.check receives {force:true,env,signal}. Legacy checkers that only
 *   accept force MUST be wrapped by the integrator to use the supplied env/signal.
 * - bootstrap must pass env/signal through EVERY subprocess; log(text,level) is
 *   already filtered here. No global process.env mutation is used.
 * - credentials (optional for isolated tests; injected by monitor in production):
 *   environment(base,{signal}) resolves credentials before opening the bridge;
 *   cachedEnvironment(base) is synchronous and applied to each child environment;
 *   quota({signal,env,onEvent}) is read-only/advisory. Never persist its raw result.
 */
export function createKernelUpdateJob({ dataDir, varDir, runtime, bootstrap, checker,
  networkProxy, services, credentials, run = runKernelProcess, log = () => {} }) {
  try { directories(dataDir); directories(varDir); } catch { throw fail("storage-unsafe"); }
  dataDir = path.resolve(dataDir); varDir = path.resolve(varDir);
  if (![runtime?.resolve, runtime?.environment, runtime?.command, runtime?.prepareAdapter, runtime?.publishInitial,
    bootstrap?.prepare, bootstrap?.complete, bootstrap?.verify, bootstrap?.prepareUpdate, checker?.check,
    networkProxy?.withEnvironment, services?.pause, services?.resume, run, log].every(x => typeof x === "function")) throw fail("invalid-options");
  const stateFile = path.join(varDir, "kernel-update-job.json"), logFile = path.join(varDir, "kernel-update-job.log");
  const lock = createLock(dataDir), redact = redactor();
  if (credentials !== undefined && ![credentials?.environment, credentials?.cachedEnvironment, credentials?.quota]
    .every(x => typeof x === "function")) throw fail("invalid-options");
  // Keep the append-only bounded journal plus the existing 400-line state tail.
  // Starting a run never rotates, truncates or clears the journal.
  let storeId = newId(), job = null, rows = [], lines = [], next = 0, clearedThrough = 0, stateBytes = null, logStat = null;
  let active = null, controller = null, stopped = false, storageError = null;
  function selection(value) {
    if (!exact(value, ["kind", "id", "root", "launcher"]) || !["package", "source"].includes(value.kind) ||
        typeof value.root !== "string" || !path.isAbsolute(value.root) || typeof value.launcher !== "string" || !path.isAbsolute(value.launcher) ||
        (value.kind === "package" && value.id !== "package") || (value.kind === "source" &&
          (!HEX.test(value.id) || value.root !== path.join(dataDir, "kernels", value.id, "src") ||
            value.launcher !== path.join(value.root, ".hermes", "bin", "hermes")))) throw fail("selection-changed");
    return { ...value };
  }
  function resolve() { try { return selection(runtime.resolve()); } catch { throw fail("selection-changed"); } }
  function unchanged(expected) {
    const current = resolve();
    if (Object.keys(current).some(k => current[k] !== expected[k])) throw fail("selection-changed");
  }
  const validId = value => typeof value === "string" && value.length === 32 && HEX.test(value);
  const validTime = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  function runMetadata(value) {
    return { id: value.id, action: value.action, queuedAt: validTime(value.queuedAt) ? value.queuedAt : null,
      state: value.state, finishedAt: validTime(value.finishedAt) ? value.finishedAt : null,
      logTruncated: value.logTruncated === true };
  }
  function validRun(value) {
    return exact(value, ["id", "action", "queuedAt", "state", "finishedAt", "logTruncated"]) && validId(value.id) &&
      ["initialize", "update"].includes(value.action) && (value.queuedAt === null || validTime(value.queuedAt)) &&
      STATES.includes(value.state) && (value.finishedAt === null || validTime(value.finishedAt)) && typeof value.logTruncated === "boolean";
  }
  function validLine(l) {
    return (exact(l, ["seq", "time", "level", "text"]) ||
      (exact(l, ["seq", "time", "level", "text", "run"]) && validRun(l.run))) &&
      Number.isSafeInteger(l.seq) && l.seq > 0 && typeof l.time === "string" && Number.isFinite(Date.parse(l.time)) &&
      LEVELS.includes(l.level) && typeof l.text === "string" && l.text.length <= 4096;
  }
  function availableLines() {
    return [...new Map([...rows, ...lines].map(line => [line.seq, line])).values()].sort((a, b) => a.seq - b.seq);
  }
  function publicValue(value) {
    if (typeof value === "string") return redact.text(value);
    if (Array.isArray(value)) return value.map(publicValue);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicValue(item)]));
    return value;
  }
  function load() {
    directories(varDir);
    let state = null, persisted = [], loadedStateBytes = null, loadedLogStat = null, loadedStoreId = storeId;
    const hasState = optional(stateFile), hasLog = optional(logFile);
    if (hasState) {
      const read = regular(stateFile, 4 * 1024 * 1024);
      state = json(read.bytes);
      if (!exact(state, ["schema", "owner", "dataDir", "storeId", "job", "lines", "next",
          ...(Object.hasOwn(state, "clearedThrough") ? ["clearedThrough"] : [])]) ||
          state.schema !== 1 || state.owner !== OWNER || state.dataDir !== dataDir || !validId(state.storeId) ||
          !Number.isSafeInteger(state.next) || state.next < 0 ||
          (Object.hasOwn(state, "clearedThrough") && (!Number.isSafeInteger(state.clearedThrough) || state.clearedThrough < 0 || state.clearedThrough > state.next)) ||
          !Array.isArray(state.lines) || state.lines.length > 400 ||
          !state.lines.every(validLine) || state.lines.some((l, i) => (i && l.seq <= state.lines[i - 1].seq) || l.seq > state.next) ||
          (state.job !== null && (!validId(state.job.id) ||
            !STATES.includes(state.job.state) || !["initialize", "update"].includes(state.job.action)))) throw fail("storage-unsafe");
      loadedStateBytes = read.bytes; loadedStoreId = state.storeId;
    }
    if (hasLog) {
      const read = regular(logFile);
      const rows = read.bytes.toString("utf8").split("\n");
      if (rows.pop() !== "") throw fail("storage-unsafe");
      const header = json(Buffer.from(rows.shift() || ""));
      if (!exact(header, ["schema", "owner", "storeId"]) || header.schema !== 1 || header.owner !== OWNER ||
          !validId(header.storeId) || (state && header.storeId !== loadedStoreId)) throw fail("storage-unsafe");
      loadedStoreId = header.storeId;
      persisted = rows.map(row => json(Buffer.from(row)));
      if (!persisted.every(validLine) || persisted.some((l, i) => i && l.seq <= persisted[i - 1].seq)) throw fail("storage-unsafe");
      loadedLogStat = read.stat;
    }
    const merged = new Map();
    const identities = new Map();
    for (const line of [...persisted, ...(state?.lines || [])]) {
      const prior = merged.get(line.seq);
      if (prior && JSON.stringify(publicValue(prior)) !== JSON.stringify(publicValue(line))) throw fail("storage-unsafe");
      if (line.run) {
        const identity = JSON.stringify([line.run.action, line.run.queuedAt]);
        if (identities.has(line.run.id) && identities.get(line.run.id) !== identity) throw fail("storage-unsafe");
        identities.set(line.run.id, identity);
      }
      merged.set(line.seq, line);
    }
    if (state?.job && identities.has(state.job.id)) {
      const current = runMetadata(state.job);
      if (identities.get(current.id) !== JSON.stringify([current.action, current.queuedAt])) throw fail("storage-unsafe");
    }
    // Commit only after complete validation; failed reads cannot replace a
    // fail-closed in-memory terminal state with an older successful snapshot.
    stateBytes = loadedStateBytes; logStat = loadedLogStat; storeId = loadedStoreId;
    job = state?.job || null;
    rows = persisted;
    lines = [...merged.values()].sort((a, b) => a.seq - b.seq).slice(-400);
    next = Math.max(state?.next || 0, lines.at(-1)?.seq || 0);
    clearedThrough = state?.clearedThrough || 0;
  }
  function save() {
    directories(varDir);
    const present = optional(stateFile);
    if (stateBytes ? !present || !regular(stateFile, 4 * 1024 * 1024).bytes.equals(stateBytes) : present) throw fail("storage-unsafe");
    const bytes = Buffer.from(JSON.stringify({ schema: 1, owner: OWNER, dataDir, storeId,
      job: publicValue(job), lines: publicValue(lines), next, clearedThrough }) + "\n");
    const temp = path.join(varDir, `.kernel-update-${newId()}.tmp`);
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (stateBytes) fs.renameSync(temp, stateFile);
      else { fs.linkSync(temp, stateFile); fs.unlinkSync(temp); }
      stateBytes = bytes;
      if (process.platform === "linux") {
        const parent = fs.openSync(varDir, "r");
        try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      }
    } finally { if (optional(temp)) fs.unlinkSync(temp); }
  }
  function append(text, level = "info") {
    if (!LEVELS.includes(level)) level = "info";
    const line = { seq: ++next, time: now(), level, text: redact.text(text), ...(job ? { run: runMetadata(job) } : {}) };
    lines.push(line); if (lines.length > 400) lines.shift();
    directories(varDir);
    if (!logStat) {
      if (optional(logFile)) throw fail("storage-unsafe");
      const fd = fs.openSync(logFile, "wx", 0o600);
      try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify({ schema: 1, owner: OWNER, storeId }) + "\n"); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      logStat = fs.lstatSync(logFile);
    }
    const current = fs.lstatSync(logFile);
    if (!current.isFile() || current.nlink !== 1 || !sameFile(current, logStat) || current.size !== logStat.size || current.mtimeMs !== logStat.mtimeMs) throw fail("storage-unsafe");
    const payload = JSON.stringify(line) + "\n";
    if (current.size + Buffer.byteLength(payload) <= LOG_LIMIT) {
      const fd = fs.openSync(logFile, fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0));
      try {
        if (!sameFile(fs.fstatSync(fd), current)) throw fail("storage-unsafe");
        fs.writeFileSync(fd, payload); fs.fsyncSync(fd); logStat = fs.fstatSync(fd);
        rows.push(line);
      } finally { fs.closeSync(fd); }
    } else if (job) {
      job.logTruncated = true; line.run.logTruncated = true;
    } // Current tail still saved in bounded JSON state.
    try { log(line.text, line.level); } catch {} // External logger cannot compromise recovery.
  }
  function phase(value) { job.phase = value; append(value); save(); }
  function checkFact(value) {
    if (value == null) return null;
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") return "[unsupported field type]";
    // Redact before truncation/JSON escaping, so neither can split a credential.
    const text = redact.text(value);
    return text.length > 512 ? `${text.slice(0, 496)} [truncated]` : text;
  }
  function checkFacts(checked) {
    return Object.fromEntries(["ok", "updateAvailable", "held", "aheadOfRelease", "error", "message"]
      .map(key => [key, checkFact(checked?.[key])]));
  }
  load();
  // A second live monitor only observes. Reclaim/mark only under the same DATA lock.
  if (job && ["queued", "running"].includes(job.state)) {
    let held;
    try {
      held = lock.acquire(); load();
      job.state = "interrupted"; job.finishedAt = now(); job.error = safeError(fail("job-restarted"));
      job.recoveryRequired = true; append(messages["job-restarted"], "warn"); save();
    } catch (e) {
      if (!["job-busy", "lock-unknown", "lock-orphan-process"].includes(e.code)) throw fail("storage-unsafe");
    } finally { held?.release(); }
  }
  function aborted() { if (stopped || controller.signal.aborted) throw fail("job-interrupted"); }
  async function execute(held) {
    let snapshot, hasSnapshot = false, pauseRecoveryFailed = false, resumed = false, workSucceeded = false, selected = job.initialSelection;
    let caught = null, networkLogError = null, diagnosing = false, sampleReported = false;
    const routes = new Map();
    const signal = controller.signal;
    const onNetworkEvent = value => {
      const event = networkEvent(value);
      if (!event || signal.aborted || networkLogError) return;
      try {
        job.proxyRoute = event.route;
        const target = event.hostname ? `；目标 ${event.hostname}` : "";
        const latency = typeof event.latencyMs === "number" ? `；连接 ${event.latencyMs.toFixed(1)} ms` : "";
        if (event.bytes > 0 && event.durationMs > 0) {
          if (diagnosing || job.networkDiagnosis || sampleReported) return;
          sampleReported = true;
          append(`采样速度 ${(event.bytes * 1000 / event.durationMs / 1024).toFixed(1)} KiB/s（${event.bytes} bytes / ${event.durationMs.toFixed(1)} ms，非宽带总带宽）；路线 ${event.route}${target}`);
        } else {
          // NO_PROXY targets do not represent a failure or recovery of the upstream proxy.
          const lane = event.reason === "no-proxy" ? "bypass" : "upstream";
          const key = JSON.stringify([event.route, event.protocol, event.reason,
            event.route === "direct-fallback" ? event.hostname : null]);
          if (routes.get(lane) === key) return;
          routes.set(lane, key);
          if (diagnosing && event.route !== "direct-fallback") return;
          append(`${event.route === "proxy" ? "使用代理" : event.route === "direct-fallback" ? "代理不可用已转直连" : "使用直连"}；协议 ${event.protocol || "direct"}；原因 ${event.reason || "未提供"}${target}${latency}`,
            event.route === "direct-fallback" ? "warn" : "info");
        }
        save();
      } catch (error) { networkLogError = error; }
    };
    const restore = async () => {
      if (!hasSnapshot || resumed || stopped || signal.aborted) return;
      resumed = true;
      // Recovery must still be attempted when persistence/phase logging failed.
      try { phase("resuming"); } catch (e) { caught ||= e; }
      let current = null;
      try { current = resolve(); } catch (e) { caught ||= e; }
      try {
        await services.resume(snapshot, { success: workSucceeded && !caught, selected: current, signal });
        aborted();
        // resume(null) is a no-op, not proof that pause's own failed recovery
        // succeeded. Keep that explicit diagnostic even if resume resolves.
        job.servicesRestored = !pauseRecoveryFailed;
      } catch { throw fail("resume-failed"); }
    };
    try {
      aborted(); job.state = "running"; job.startedAt = now(); phase("network");
      unchanged(job.initialSelection);
      let base = runtime.environment(selected);
      Object.assign(base, { HOME: dataDir, HERMES_HOME: dataDir, FNOS_KERNEL_UPDATE_JOB_TOKEN: held.token });
      redact.add(base);
      if (credentials) base = await credentials.environment(base, { signal });
      redact.add(base); aborted();
      await networkProxy.withEnvironment(base, async (effective, metadata) => {
        aborted();
        if (!effective || typeof effective !== "object") throw fail("invalid-options");
        redact.add(effective);
        job.proxyMode = ["direct", "http", "socks", "socks5", "proxy", "system", "disabled"].includes(metadata?.mode) ? metadata.mode : "unspecified";
        append(`网络模式 ${job.proxyMode}；后续仅记录路线变化和异常`);
        const diagnose = metadata?.diagnose || (networkProxy.diagnose ? options => networkProxy.diagnose(options) : null);
        if (diagnose) {
          diagnosing = true;
          const diagnosticController = new AbortController();
          const diagnosticSignal = AbortSignal.any([signal, diagnosticController.signal]);
          let cancel;
          const cancelled = new Promise((_resolve, reject) => {
            cancel = () => reject(Object.assign(new Error("Network diagnosis cancelled"), {
              code: signal.aborted ? "ABORT_ERR" : "NP_TIMEOUT",
            }));
            diagnosticSignal.addEventListener("abort", cancel, { once: true });
            if (diagnosticSignal.aborted) cancel();
          });
          const timer = setTimeout(() => diagnosticController.abort(), 10000);
          try {
            // Advisory work must release the job even if the dependency ignores abort.
            const result = publicDiagnosis(await Promise.race([cancelled, Promise.resolve().then(() => {
              diagnosticSignal.throwIfAborted();
              return diagnose({ signal: diagnosticSignal });
            })]));
            job.networkDiagnosis = result;
            for (const [name, point] of [["国内测点", result.domestic], ["国外测点", result.overseas]]) {
              const timing = point.timings;
              const milliseconds = value => value == null ? "未测" : value.toFixed(1);
              append(`${name} ${point.source || "未知"}；路线 ${point.route || "未测"}；协议 ${point.detectedProtocol || "未测"}；${point.ok ? "可达" : `测试失败 ${point.error?.code || "未测"}${point.error?.statusCode ? ` HTTP ${point.error.statusCode}` : ""}`}；连接 ${milliseconds(timing.connectMs)} ms / 首字节 ${milliseconds(timing.ttfbMs)} ms / 总计 ${milliseconds(timing.totalMs)} ms`, point.ok ? "info" : "warn");
              if (point.download?.bytes > 0 && point.download.durationMs > 0) {
                append(`${name}采样速度 ${(point.download.bytesPerSecond / 1024).toFixed(1)} KiB/s（${point.download.bytes} bytes / ${point.download.durationMs.toFixed(1)} ms，非宽带总带宽）`);
              } else append(`${name}采样速度未测`);
            }
          } catch (error) {
            aborted(); // Shutdown remains fatal; a diagnostic failure is informational.
            routes.clear();
            append(`网络诊断未完成 ${diagnosticError(error).code}；采样速度未测；继续按实际目标连接`, "warn");
          } finally {
            clearTimeout(timer); diagnosticSignal.removeEventListener("abort", cancel); diagnosticController.abort();
            diagnosing = false;
          }
          aborted();
        }
        if (networkLogError) throw networkLogError;
        save();
        // Apply the proxy delta to each newly selected runtime, not stale package
        // PYTHONPATH/launcher variables carried from the initial environment.
        const environment = selectedRuntime => {
          if (networkLogError) throw networkLogError;
          const result = { ...runtime.environment(selectedRuntime) };
          for (const key of new Set([...Object.keys(base), ...Object.keys(effective)])) {
            if (!Object.hasOwn(effective, key)) delete result[key];
            else if (effective[key] !== base[key]) result[key] = effective[key];
          }
          const required = runtime.environment(selectedRuntime);
          for (const key of ["APP_DIR", "DATA_DIR", "VAR_DIR", "USERPROFILE", "PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "FNOS_KERNEL_ID", "FNOS_KERNEL_ROOT"]) {
            if (Object.hasOwn(required, key)) result[key] = required[key]; else delete result[key];
          }
          Object.assign(result, { HOME: dataDir, HERMES_HOME: dataDir, FNOS_KERNEL_UPDATE_JOB_TOKEN: held.token,
            PWD: selectedRuntime.kind === "source" ? selectedRuntime.root : dataDir });
          const cached = credentials ? credentials.cachedEnvironment(result) : result;
          redact.add(cached);
          const prepared = metadata?.prepareEnvironment ? metadata.prepareEnvironment(cached) : cached;
          redact.add(prepared); return prepared;
        };
        const quotaSnapshot = async () => {
          if (!credentials || signal.aborted || stopped) return;
          const quotaController = new AbortController();
          const quotaSignal = AbortSignal.any([signal, quotaController.signal]);
          let listening = true, abort;
          const cancelled = new Promise(resolve => { abort = resolve; quotaSignal.addEventListener("abort", abort, { once: true }); });
          // Advisory diagnostics are bounded and must not hold up cancellation,
          // even if an injected implementation ignores its AbortSignal.
          const timer = setTimeout(() => { emit("GitHub 只读额度快照超时；不影响更新结果"); quotaController.abort(); }, 5000);
          const emit = text => {
            if (!listening || quotaSignal.aborted) return;
            try { append(text); } catch (error) { networkLogError ||= error; }
          };
          try {
            const env = environment(selected);
            await Promise.race([cancelled, Promise.resolve().then(() => credentials.quota({ signal: quotaSignal, env, onEvent: emit }))
              .catch(() => emit("GitHub 只读额度快照未完成；不影响更新结果"))]);
          } catch { emit("GitHub 只读额度快照未完成；不影响更新结果"); }
          finally {
            listening = false; clearTimeout(timer); quotaSignal.removeEventListener("abort", abort); quotaController.abort();
          }
        };
        let updateAttempted = false;
        try {
          await quotaSnapshot(); aborted();
          unchanged(job.initialSelection);
          if (job.action === "update") {
            phase("checking");
            const checkEnv = environment(selected);
            const notStarted = "尚未暂停服务，尚未执行 hermes update";
            append(`开始官方安全复检（force=true，不复用页面检查结果）；${notStarted}`); save();
            const checkStarted = performance.now();
            const elapsed = () => `${Math.max(0, performance.now() - checkStarted).toFixed(1)} ms`;
            let checked;
            try {
              checked = await checker.check({ force: true, env: checkEnv, signal });
            } catch (error) {
              const duration = elapsed();
              const code = checkFact(typeof error?.code === "string" ? error.code : null);
              const reason = checkFact(typeof error === "string" ? error :
                typeof error?.message === "string" ? error.message : "[no textual reason]");
              append(`官方安全复检异常（checker-threw）；耗时 ${duration}；error=${JSON.stringify(code)}；reason=${JSON.stringify(reason)}；${notStarted}`, "error");
              aborted();
              // Raw exceptions (including NP_* messages) must not become UI errors.
              throw fail("official-check");
            }
            const duration = elapsed(), facts = checkFacts(checked);
            append(`官方安全复检返回；耗时 ${duration}；结果 ${JSON.stringify(facts)}；${notStarted}`);
            aborted(); unchanged(selected);
            const refuse = (reason, explanation, code = "official-check") => {
              append(`官方安全复检拒绝（${reason}）；${explanation}；${notStarted}`, "error");
              throw fail(code);
            };
            if (checked?.ok !== true) refuse("not-approved", "官方响应未批准检查成功；原因见上方 error/message");
            if (checked.updateAvailable !== true) {
              if (checked.updateAvailable !== false) refuse("invalid-update-state", "官方未返回明确的 updateAvailable 布尔值");
              // Only describe held after updateAvailable has already denied the update.
              // Never use it (or SHA equality/aheadOfRelease) as an additional gate.
              const held = checked.held === true || (typeof checked.held === "string" && checked.held.length > 0);
              refuse(held ? "held" : "no-update", held ? "官方报告无可用更新并提供暂缓信息；以 held/message 为准" : "官方报告当前无可用更新（updateAvailable=false）");
            }
            for (const key of ["currentSha", "targetSha"]) {
              if (typeof checked[key] !== "string" || checked[key].length !== 40 || !SHA.test(checked[key])) {
                refuse(`invalid-${key}`, `官方 ${key} 不是有效的 40 位 SHA`);
              }
            }
            if (job.requestedTargetSha && job.requestedTargetSha !== checked.targetSha) {
              refuse("target-changed", "复检目标与提交目标不一致，必须重新检查后再更新", "target-changed");
            }
            job.currentSha = checked.currentSha; job.targetSha = checked.targetSha;
            // Keep bounded, redacted informational facts, never reinterpret their policy.
            job.check = { ok: true, updateAvailable: true, held: facts.held, aheadOfRelease: facts.aheadOfRelease };
            append(`官方安全复检及目标校验通过；继续原有更新与验收流程；${notStarted}`);
          }
          phase("pausing"); aborted(); unchanged(job.initialSelection);
          try { snapshot = await services.pause(); hasSnapshot = true; }
          catch (e) {
            pauseRecoveryFailed = e?.recoveryRequired === true;
            job.recoveryRequired ||= pauseRecoveryFailed;
            if (e && Object.hasOwn(e, "snapshot")) { snapshot = e.snapshot; hasSnapshot = true; throw e; }
            job.recoveryRequired = true; throw fail("pause-contract");
          }
          aborted(); unchanged(job.initialSelection);
          if (job.action === "initialize") {
            phase("preparing");
            selected = selection(await bootstrap.prepare({ env: environment(selected), signal, prepareEnvironment: metadata?.prepareEnvironment, log: append }));
            aborted(); unchanged(job.initialSelection);
            if (selected.kind !== "source") throw fail("acceptance-failed");
            job.selected = selected;
            phase("adapter"); await runtime.prepareAdapter(selected);
            aborted(); unchanged(job.initialSelection);
            phase("completing");
            const completed = await bootstrap.complete(selected, { env: environment(selected), signal, prepareEnvironment: metadata?.prepareEnvironment, log: append });
            aborted(); unchanged(job.initialSelection);
            if (completed?.ok !== true) throw fail("acceptance-failed");
          } else {
            phase("updating");
            await bootstrap.prepareUpdate(selected, { env: environment(selected), signal, prepareEnvironment: metadata?.prepareEnvironment, log: append });
            aborted(); unchanged(selected);
            const before = receiptFiles(dataDir), correlation = newId();
            const command = runtime.command(["update", "--yes", "--no-gateway-restart"], { selected });
            if (command.executable !== selected.launcher || command.cwd !== selected.root ||
                JSON.stringify(command.args) !== JSON.stringify(["update", "--yes", "--no-gateway-restart"])) throw fail("selection-changed");
            const env = { ...command.env, ...environment(selected), HERMES_UPDATE_CORRELATION_ID: correlation };
            redact.add(env); aborted(); unchanged(selected);
            job.sourceMayHaveChanged = true; job.executionStartedAt = now(); save();
            const started = Date.now();
            updateAttempted = true;
            const result = await run(command.executable, command.args, { cwd: selected.root, env, signal,
              onLine: (text, stream) => append(text, stream) });
            const ended = Date.now();
            aborted(); unchanged(selected);
            if (result?.code !== 0) throw fail("acceptance-failed");
            job.receipt = acceptReceipt(before, receiptFiles(dataDir), { correlation, started, ended,
              currentSha: job.currentSha, targetSha: job.targetSha });
          }
          phase("verifying");
          const verified = await bootstrap.verify(selected, { env: environment(selected), signal, prepareEnvironment: metadata?.prepareEnvironment, log: append })
            .catch(e => { throw Object.hasOwn(messages, e?.code) || String(e?.code).startsWith("NP_") ? e : fail("acceptance-failed"); });
          aborted(); unchanged(job.initialSelection);
          if (verified?.ok !== true) throw fail("acceptance-failed");
          if (job.action === "initialize") {
            phase("publishing"); aborted(); unchanged(job.initialSelection);
            try { await runtime.publishInitial(selected); job.published = true; }
            catch (e) { if (e?.selectionPublished === true) job.published = true; throw e; }
            aborted(); unchanged(selected);
          }
          workSucceeded = true;
        } catch (e) { caught = e; throw e; }
        finally { if (updateAttempted) await quotaSnapshot(); await restore(); }
      }, { scope: "updates", signal, onEvent: onNetworkEvent });
      aborted();
      if (networkLogError) throw networkLogError;
      if (caught) throw caught;
      if (!workSucceeded || !job.servicesRestored) throw fail("acceptance-failed");
      unchanged(selected);
    } catch (e) { caught = e; }
    finally {
      // Also handles a proxy failure before/after its callback and partial pause.
      try { await restore(); } catch (e) { caught = e; }
      if (stopped || signal.aborted) caught = fail("job-interrupted");
      job.state = caught ? (stopped || signal.aborted ? "interrupted" : "failed") : "succeeded";
      job.finishedAt = now(); job.error = caught ? safeError(caught) : null;
      job.recoveryRequired ||= Boolean(caught && (job.published || job.sourceMayHaveChanged || (hasSnapshot && !job.servicesRestored)));
      try { append(job.error?.message || "Kernel job succeeded", caught ? "error" : "info"); save(); }
      catch {
        storageError = safeError(fail("storage-unsafe")); job.state = stopped ? "interrupted" : "failed"; job.error = storageError;
        job.recoveryRequired ||= Boolean(job.published || job.sourceMayHaveChanged || (hasSnapshot && !job.servicesRestored));
      }
      try { held.release(); }
      catch { job.state = stopped ? "interrupted" : "failed"; job.error = safeError(fail("lock-unknown")); job.recoveryRequired = true; try { save(); } catch {} }
    }
  }
  function status({ after = 0, run } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || (run !== undefined && run !== "legacy" && !validId(run))) {
      throw Object.assign(fail("invalid-request"), { status: 400 });
    }
    if (!active && !storageError) { try { load(); } catch { storageError = safeError(fail("storage-unsafe")); } }
    const all = availableLines(), available = all.filter(line => line.seq > clearedThrough), groups = new Map();
    const history = { limitBytes: LOG_LIMIT, persistedBytes: logStat?.size || 0,
      limited: Boolean(job?.logTruncated || rows.length < next), missingLines: Math.max(0, next - all.length) };
    for (const line of available) {
      if (line.run) groups.set(line.run.id, { ...line.run });
      else groups.set("legacy", { id: "legacy", action: null, queuedAt: null, state: null, finishedAt: null, logTruncated: false });
    }
    // A bounded journal may lack an old run's terminal line. Never claim that
    // such a historical run is still active, or invent an outcome for it.
    for (const group of groups.values()) if (group.id !== job?.id && ["queued", "running"].includes(group.state)) {
      group.state = null; group.finishedAt = null; group.logTruncated = true;
    }
    if (job && (groups.has(job.id) || ["queued", "running"].includes(job.state) || job.recoveryRequired || clearedThrough < next)) {
      groups.set(job.id, runMetadata(job));
    }
    if (run !== undefined && !groups.has(run)) throw Object.assign(fail("run-not-found"), { status: 404 });
    const selectedRun = run ?? (groups.has(job?.id) ? job.id : null);
    return { ok: true, job: publicValue(job), runs: [...groups.values()].reverse(), selectedRun, clearedThrough,
      lines: publicValue(available.filter(l => (l.run?.id || "legacy") === selectedRun && l.seq > after)), next, history,
      ...(storageError ? { storageError } : {}) };
  }
  async function start({ action, targetSha } = {}) {
    if (!["initialize", "update"].includes(action) || (targetSha !== undefined && (action !== "update" || !SHA.test(targetSha)))) throw fail("invalid-request");
    if (stopped) throw fail("job-stopped");
    if (active) throw fail("job-busy");
    const held = lock.acquire();
    try {
      load(); const initialSelection = resolve();
      if (action === "initialize" && initialSelection.kind !== "package") throw fail("initialize-source");
      if (action === "update" && initialSelection.kind !== "source") throw fail("update-package");
      job = { id: newId(), action, state: "queued", phase: "queued", queuedAt: now(), startedAt: null, finishedAt: null,
        error: null, initialSelection, selected: initialSelection, requestedTargetSha: targetSha ?? null,
        currentSha: null, targetSha: null, check: null, receipt: null, proxyMode: null, proxyRoute: null, networkDiagnosis: null, executionStartedAt: null,
        published: false, sourceMayHaveChanged: false, servicesRestored: false, recoveryRequired: false, logTruncated: false };
      storageError = null; append("Kernel job queued"); save();
      controller = new AbortController();
      const queued = status();
      active = new Promise(resolveTask => setImmediate(resolveTask)).then(() => execute(held)).finally(() => { active = null; controller = null; });
      return queued;
    } catch (e) { held.release(); throw Object.hasOwn(messages, e?.code) ? e : fail("storage-unsafe"); }
  }
  function clearLog() {
    if (stopped) throw fail("job-stopped");
    if (active || lock.busy()) throw Object.assign(fail("job-busy"), { status: 409 });
    if (storageError) throw fail("storage-unsafe");
    const held = lock.acquire();
    try {
      load();
      if (["queued", "running"].includes(job?.state)) throw Object.assign(fail("job-busy"), { status: 409 });
      if (job?.recoveryRequired) throw Object.assign(fail("log-recovery-required"), { status: 409 });
      // A single atomic cursor hides old output without deleting recovery evidence.
      const previous = clearedThrough;
      clearedThrough = next;
      try { save(); }
      catch (error) { clearedThrough = previous; throw error; }
      return { ok: true, clearedThrough };
    } finally { held.release(); }
  }
  return { start, status, clearLog, busy: () => Boolean(active) || lock.busy(), async shutdown() {
    stopped = true; controller?.abort(); if (active) await active;
  } };
}
