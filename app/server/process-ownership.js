import { readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { posix as path } from "node:path";

export const DASHBOARD_ARGS = ["-m", "hermes_cli.main", "dashboard", "--host", "127.0.0.1",
  "--port", "9119", "--no-open", "--skip-build", "--isolated"];

export function createGatewayOwnership(options) { return createOwnership(options, "Gateway"); }
export function createDashboardOwnership(options) { return createOwnership(options, "Dashboard"); }

function createOwnership({ appDir, dataDir, platform = process.platform,
  readFile = readFileSync, readlink = readlinkSync, realpath = realpathSync, statFile = statSync,
  uid = process.getuid?.(), kill = process.kill.bind(process),
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }, role) {
  const bin = `${dataDir}/venv/bin`;
  const python = new Set([`${bin}/python`, `${bin}/python3`]);
  const expectedEnv = { APP_DIR: appDir, DATA_DIR: dataDir, HERMES_HOME: dataDir, HOME: dataDir };
  const validPid = pid => Number.isSafeInteger(pid) && pid > 1;
  function stat(pid) {
    const text = readFile(`/proc/${pid}/stat`, "utf8");
    const end = text.lastIndexOf(") ");
    if (!text.startsWith(`${pid} (`) || end < 0) throw new Error("Invalid proc stat");
    const fields = text.slice(end + 2).trim().split(/\s+/);
    // fields[0] 对应第 3 个字段（state），第 22 个字段是相对开机时间的启动时间。
    if (!/^[RSDZTtXxKWPI]$/.test(fields[0]) || !/^\d+$/.test(fields[19] || "")) throw new Error("Invalid proc state/starttime");
    return { starttime: fields[19], state: fields[0] };
  }
  function commandMatches(argv) {
    // 仅规范化本实例 Python 的可选 -P -m，后续仍使用原有精确参数规则。
    if (python.has(argv[0]) && argv[1] === "-P" && argv[2] === "-m") argv = [argv[0], ...argv.slice(2)];
    if (role === "Dashboard") return python.has(argv[0]) && argv.length === DASHBOARD_ARGS.length + 1 &&
      DASHBOARD_ARGS.every((arg, i) => argv[i + 1] === arg);
    let args;
    if (argv[0] === `${bin}/hermes`) args = argv.slice(1);
    else if (python.has(argv[0]) && argv[1] === `${bin}/hermes`) args = argv.slice(2);
    else if (python.has(argv[0]) && argv[1] === "-m" && argv[2] === "hermes_cli.main") args = argv.slice(3);
    else return false;
    return args[0] === "gateway" && args[1] === "run" &&
      (args.length === 2 || (args.length === 3 && args[2] === "--quiet"));
  }
  const dead = snapshot => ["Z", "X", "x"].includes(snapshot.state);
  const hasManaged = expected => expected != null && "managed" in Object(expected);
  const bootPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const canonicalPath = value => typeof value === "string" && !value.includes("\0") &&
    path.isAbsolute(value) && path.normalize(value) === value;
  function within(parent, child) {
    const relative = path.relative(parent, child);
    return relative !== "" && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative);
  }
  function validateRecord(record, claiming) {
    const keys = claiming ? ["id", "root", "token"] : ["id", "root", "token", "uid", "bootId", "exe", "cwd"];
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        Reflect.ownKeys(record).length !== keys.length ||
        !keys.every(key => Object.hasOwn(record, key)) ||
        typeof record.id !== "string" || record.id.length !== 32 || !/^[0-9a-f]{32}$/.test(record.id) ||
        typeof record.token !== "string" || record.token.length !== 64 || !/^[0-9a-f]{64}$/.test(record.token) ||
        !canonicalPath(record.root) || record.root !== `${dataDir}/kernels/${record.id}/src`) {
      throw new Error(`Invalid ${role} ${claiming ? "launch" : "managed"} record`);
    }
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error("Managed UID must be a positive integer");
    if (!claiming && (record.uid !== uid || typeof record.bootId !== "string" ||
        record.bootId.length !== 36 || !bootPattern.test(record.bootId) || !canonicalPath(record.exe) || !canonicalPath(record.cwd))) {
      throw new Error(`Invalid ${role} managed identity`);
    }
  }
  function bootId() {
    const text = readFile("/proc/sys/kernel/random/boot_id", "utf8");
    const value = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (value.length !== 36 || !bootPattern.test(value)) throw new Error("Invalid boot_id");
    return value;
  }
  function nulEntries(text, name) {
    if (typeof text !== "string" || !text.endsWith("\0")) throw new Error(`Incomplete ${name}`);
    const entries = text.slice(0, -1).split("\0");
    if (entries.some(entry => !entry)) throw new Error(`Empty ${name}`);
    return entries;
  }
  function managedEnvironment(record) {
    return { ...expectedEnv, FNOS_KERNEL_ID: record.id, FNOS_KERNEL_ROOT: record.root,
      FNOS_LAUNCH_TOKEN: record.token, FNOS_LAUNCH_ROLE: role };
  }
  function checkEnvironment(entries, required, managed) {
    if (managed) {
      const keys = entries.map(entry => {
        const separator = entry.indexOf("=");
        if (separator <= 0) throw new Error("Invalid environ entry");
        return entry.slice(0, separator);
      });
      if (new Set(keys).size !== keys.length) throw new Error("Duplicate environ key");
    }
    for (const [key, value] of Object.entries(required)) {
      const values = entries.filter(entry => entry.startsWith(`${key}=`));
      if (values.length !== 1 || values[0] !== `${key}=${value}`) throw new Error(`${role} ${key} does not match this instance`);
    }
  }
  function actualPath(procPath) {
    const link = readlink(procPath);
    // 不把 argv[0] 或链接文本当作真实文件，也拒绝已删除的映像/目录。
    if (!canonicalPath(link) || link.endsWith(" (deleted)") ||
        realpath(procPath) !== link || realpath(link) !== link) throw new Error(`Unverifiable ${procPath}`);
    return link;
  }
  function osEvidence(pid, root) {
    const text = readFile(`/proc/${pid}/status`, "utf8");
    const lines = text.split("\n").filter(line => line.startsWith("Uid:"));
    const match = lines.length === 1 && /^Uid:[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]*$/.exec(lines[0]);
    if (!text.endsWith("\n") || !match || !match.slice(1).every(value => Number(value) === uid)) {
      throw new Error("Unverifiable proc status UID");
    }
    const resolvedRoot = realpath(root), tools = realpath(`${dataDir}/tools`);
    if (!canonicalPath(resolvedRoot) || !canonicalPath(tools)) throw new Error("Invalid managed realpath");
    const cwd = actualPath(`/proc/${pid}/cwd`), exe = actualPath(`/proc/${pid}/exe`);
    if (cwd !== resolvedRoot) throw new Error("Managed cwd does not match kernel root");
    if (!within(tools, exe)) throw new Error("Managed exe is outside tools");
    const file = statFile(`/proc/${pid}/exe`), installed = statFile(exe);
    if (!file.isFile() || !installed.isFile() || !(file.mode & 0o111) || !sameFile(file, installed)) {
      throw new Error("Managed exe is not the same regular executable file");
    }
    return { uid, exe, cwd, tools, file };
  }
  function sameFile(a, b) {
    return ["dev", "ino", "mode", "uid", "gid"].every(key => a[key] === b[key]);
  }
  function sameEvidence(a, b) {
    return ["uid", "exe", "cwd", "tools"].every(key => a[key] === b[key]) && sameFile(a.file, b.file);
  }
  function checkManagedIdentity(record, evidence) {
    if (!["uid", "exe", "cwd"].every(key => record[key] === evidence[key])) throw new Error("Managed OS identity changed");
  }
  function failure(pid, error, before, expected) {
    // exe/cwd/status/cmdline/environ 缺失不能证明退出，只有 stat 缺失才算。
    try {
      const latest = stat(pid);
      if ((expected && (expected.pid !== pid || expected.starttime !== latest.starttime)) ||
          (before && before.starttime !== latest.starttime)) return { state: "replaced" };
      if (dead(latest)) return { state: "gone" };
    } catch (statError) {
      if (statError.code === "ENOENT" || statError.code === "ESRCH") return { state: "gone" };
    }
    return { state: "unverified", reason: `Cannot verify ${role} ownership: ${error.code || error.message}` };
  }
  function verify(pid, { expected, launch, claiming = false }) {
    if (platform !== "linux" || !validPid(pid)) return { state: "unverified", reason: "Linux /proc and a positive gateway PID are required" };
    let before;
    try {
      before = stat(pid);
      // 已保存的进程身份记录必须核对 pid 和启动时间（starttime）。首次认领（claim）时也不能伪造 expected 来跳过这项检查。
      if (!claiming && expected && (expected.pid !== pid || expected.starttime !== before.starttime)) return { state: "replaced" };
      if (dead(before)) return { state: "gone" };
      const managed = claiming || hasManaged(expected);
      const record = claiming ? launch : expected?.managed;
      let bootBefore, evidenceBefore;
      if (managed) {
        validateRecord(record, claiming);
        bootBefore = bootId();
        if (!claiming && record.bootId !== bootBefore) return { state: "replaced" };
        evidenceBefore = osEvidence(pid, record.root);
        if (!claiming) checkManagedIdentity(record, evidenceBefore);
      }
      const split = text => text.endsWith("\0") ? text.slice(0, -1).split("\0") : [];
      const argvText = readFile(`/proc/${pid}/cmdline`, "utf8");
      // managed 只接受显式 launch 记录及 OS 证据。-c 源码和进程名不参与认领。
      const argv = managed ? nulEntries(argvText, "cmdline") : split(argvText);
      if (!managed && !commandMatches(argv)) throw new Error(`${role} command does not belong to this application`);
      const envText = readFile(`/proc/${pid}/environ`, "utf8");
      checkEnvironment(managed ? nulEntries(envText, "environ") : split(envText),
        managed ? managedEnvironment(record) : expectedEnv, managed);
      const evidenceAfter = managed ? osEvidence(pid, record.root) : null;
      const bootAfter = managed ? bootId() : null;
      const after = stat(pid);
      if (before.starttime !== after.starttime || (managed && bootBefore !== bootAfter)) return { state: "replaced" };
      if (dead(after)) return { state: "gone" };
      if (managed && !sameEvidence(evidenceBefore, evidenceAfter)) throw new Error("Managed OS evidence changed during inspection");
      const identity = { pid, starttime: after.starttime };
      if (managed) identity.managed = { id: record.id, root: record.root, token: record.token,
        uid, bootId: bootAfter, exe: evidenceAfter.exe, cwd: evidenceAfter.cwd };
      return { state: "owned", identity };
    } catch (error) { return failure(pid, error, before, claiming ? undefined : expected); }
  }
  function inspect(pid, expected) { return verify(pid, { expected }); }
  // 仅供调用方刚 spawn 的官方 launcher 子 PID exec 后使用。launch token 必须来自该次 spawn。
  function claim(pid, launch) { return verify(pid, { launch, claiming: true }); }
  function signal(identity, value) {
    const result = inspect(identity?.pid, identity);
    if (result.state === "gone" || result.state === "replaced") return false;
    if (result.state !== "owned") throw new Error(result.reason);
    // inspect 之后保留最后一次 stat 结果。对 managed 进程还要核对 boot/exe/cwd/UID，并在这些读取前后各做一次 stat，确认期间进程没有被替换。
    try {
      const latest = stat(identity.pid);
      if (latest.starttime !== identity.starttime || dead(latest)) return false;
      if (hasManaged(identity)) {
        if (bootId() !== identity.managed.bootId) return false;
        checkManagedIdentity(identity.managed, osEvidence(identity.pid, identity.managed.root));
        const final = stat(identity.pid);
        if (final.starttime !== identity.starttime || dead(final)) return false;
      }
    } catch (error) {
      const checked = failure(identity.pid, error, undefined, identity);
      if (checked.state === "gone" || checked.state === "replaced") return false;
      throw new Error(checked.reason);
    }
    try { kill(identity.pid, value); }
    catch (error) { if (error.code === "ESRCH" || error.code === "ENOENT") return false; throw error; }
    return true;
  }
  async function stop(identity, { timeoutMs = 28000, termMs = 25000, pollMs = 100 } = {}) {
    const deadline = now() + Math.min(28000, Math.max(0, timeoutMs));
    const termDeadline = Math.min(deadline - 1000, now() + termMs);
    if (!signal(identity, "SIGTERM")) return { ok: true };
    let escalated = false;
    for (;;) {
      const result = inspect(identity.pid, identity);
      if (result.state === "gone" || result.state === "replaced") return { ok: true };
      if (result.state !== "owned") throw new Error(result.reason);
      if (now() >= deadline) throw new Error("Gateway did not exit within the shutdown deadline");
      if (!escalated && now() >= termDeadline) {
        if (!signal(identity, "SIGKILL")) return { ok: true };
        escalated = true;
      }
      await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
    }
  }
  return { inspect, claim, signal, stop };
}
