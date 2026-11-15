import { execFile } from "node:child_process";
import { promisify } from "node:util";

const SHA = /^[a-f0-9]{40}$/i;
const SELECTION_KEYS = ["kind", "id", "root", "launcher"];
const CHANNELS = ["main", "stable"];

function failure(error, message) {
  return { ok: false, error, message, updateAvailable: null };
}

function executionFailure(error) {
  if (typeof error?.code === "string" && error.code.startsWith("NP_")) return failure(error.code, error.message);
  // Check buffer errors first: execFile also kills the child on overflow.
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || error?.code === "ENOBUFS") {
    return failure("output-too-large", "官方检查输出超过大小限制");
  }
  if (error?.code === "ENOENT") return failure("launcher-not-found", "无法找到内核启动器或工作目录");
  if (error?.code === "ETIMEDOUT" || (error?.killed && error?.signal === "SIGTERM")) {
    return failure("check-timeout", "官方检查超时");
  }
  if (typeof error?.code === "number" || error?.signal) {
    return failure("check-exit-failed", "官方检查进程未正常退出");
  }
  // Never expose execFile's message: it can contain argv, stdout and stderr.
  return failure("check-execution-failed", "无法执行官方检查");
}

function parseResult(stdout, selected) {
  let payload;
  if (typeof stdout !== "string") return failure("invalid-response", "官方检查输出格式无效");
  try { payload = JSON.parse(stdout); }
  catch { return failure("invalid-json", "官方检查未返回有效 JSON"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      typeof payload.supported !== "boolean" ||
      (payload.error != null && typeof payload.error !== "string") ||
      (payload.message != null && typeof payload.message !== "string")) {
    return failure("invalid-response", "官方检查字段格式无效");
  }
  if (payload.hermesRoot !== selected.root) {
    return failure("root-mismatch", "官方检查返回的内核目录不匹配");
  }
  const validCurrent = typeof payload.currentSha === "string" && payload.currentSha.length === 40 && SHA.test(payload.currentSha);
  // Official failures (including head-unavailable) retain their own explanation.
  if (payload.error || !payload.supported) return { ...payload, ok: false, updateAvailable: null };
  if (!validCurrent || typeof payload.targetSha !== "string" || payload.targetSha.length !== 40 || !SHA.test(payload.targetSha) ||
      typeof payload.updateAvailable !== "boolean" ||
      !Number.isSafeInteger(payload.behind) || payload.behind < -1) {
    return failure("invalid-response", "官方检查缺少有效的修订或更新状态");
  }
  // -1 is upstream's UPDATE_AVAILABLE_NO_COUNT, not a failed check.
  // Do not reinterpret held/aheadOfRelease/rollback or compare versions/SHAs.
  const result = { ...payload, ok: true, updateAvailable: payload.updateAvailable };
  for (const key of ["currentAt", "targetAt"]) {
    if (!Number.isSafeInteger(result[key]) || result[key] <= 0) delete result[key];
  }
  return result;
}

export function createKernelUpdateCheck({ runtime, dataDir, networkProxy, credentials, execute = promisify(execFile) }) {
  async function check({ force = false, channel, env, signal } = {}) {
    if (typeof force !== "boolean") return failure("invalid-force", "force 必须为布尔值");
    if (channel !== undefined && !CHANNELS.includes(channel)) return failure("invalid-channel", "更新通道只能是 main 或 stable");
    let selected;
    try {
      selected = { ...runtime.resolve() };
      if (!["package", "source"].includes(selected.kind)) throw new Error("Invalid selection");
    } catch {
      return failure("selection-changed", "内核选择已改变或不可用，请重新检查");
    }

    let result;
    if (selected.kind === "package") {
      result = { ok: false, supported: false, error: "source-not-initialized",
        message: "尚未初始化可更新的 Hermes 源码内核", updateAvailable: null };
    } else {
      try {
        const args = ["--install-root", selected.root, "--home", dataDir];
        if (force) args.push("--force");
        if (channel) args.push("--set-channel", channel);
        const command = runtime.command(args, { helper: "source-check", selected });
        const invoke = async environment => execute(command.executable, command.args, {
          cwd: command.cwd, env: credentials ? await credentials.environment(environment, { signal }) : environment, shell: false,
          timeout: 90000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8",
          ...(signal ? { signal } : {}),
        });
        const { stdout } = networkProxy && !env
          ? await networkProxy.withEnvironment({ ...command.env, PWD: command.cwd }, invoke, { scope: "updates", signal })
          : await invoke(env || command.env);
        result = parseResult(stdout, selected);
      } catch (error) {
        result = executionFailure(error);
      }
    }

    // Revalidate even on errors; never present a result for a stale/broken active kernel.
    try {
      const current = runtime.resolve();
      if (SELECTION_KEYS.some(key => current[key] !== selected[key])) throw new Error("Selection changed");
    } catch {
      return failure("selection-changed", "内核选择已改变或不可用，请重新检查");
    }
    return result;
  }
  return { check };
}
