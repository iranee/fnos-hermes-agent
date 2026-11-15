// Hermes Agent 监控服务 — Node.js HTTP 服务（Unix Socket）
// serve() 的调用已移交 boot.js，本模块仅导出 handleServe/websocket 处理器，故不再引入 serve。
import { file } from "./node-adapter.js";
import { writeFileSync, readFileSync, unlinkSync, renameSync, existsSync, mkdirSync, statSync, lstatSync, watch, readdirSync, openSync, closeSync, fsyncSync, fstatSync, fchmodSync } from "fs";
import { randomBytes } from "crypto";
import { networkInterfaces } from "os";
import { spawn as spawnAsync } from "child_process";
import { createGatewayOwnership } from "./process-ownership.js";
import { createKernelRuntime } from "./kernel-runtime.js";
import { createKernelVersion } from "./kernel-version.js";
import { createGitHubCredentials } from "./github-credentials.js";
import { createKernelUpdateCheck } from "./kernel-update-check.js";
import { createKernelBootstrap } from "./kernel-bootstrap.js";
import { createKernelUpdateJob } from "./kernel-update-job.js";
import { runKernelProcess } from "./kernel-process.js";
import { createKernelMaintenance } from "./kernel-maintenance.js";
import { createKernelControl } from "./kernel-control.js";
import { createKernelNativeApi } from "./kernel-native-api.js";
import { createKernelControlSocket } from "./kernel-control-socket.js";
import { createNetworkProxy } from "./network-proxy.js";
import { createNetworkControl } from "./network-control.js";
import { initChannels, handleGetChannels, handleSaveChannel, handleToggleChannel, handleWeixinQr, handleWeixinQrStatus, handleWeixinSave, handleTelegramQr, handleTelegramQrStatus, handleTelegramQrApply, handleWhatsAppQr, handleWhatsAppQrStatus, handleWhatsAppQrApply, handleQqbotQr, handleQqbotQrStatus, handleQqbotQrApply, handleWecomQr, handleWecomQrStatus, handleWecomQrApply } from "./channels.js";
import { initPrimaryConfig, readModelConfiguration, patchModelConfiguration,
  resolveModelTestProvider, fetchGatewayModels, probeApiFormat } from "./primary-config.js";
import { createWebappProxy } from "./webapp-proxy.js";
import { createPythonControl, createWebappRuntime, WebappError } from "./webapp-runtime.js";
import { createStartupDeadline, STARTUP_TIMEOUT_MS } from "./startup-readiness.js";
import { isFnosAdmin, requestOrigin, browserOrigin, authorizePanel, panelDenied, panelToken, authorizedOrigin } from "./fnos-access.js";
import { createDashboardProcess } from "./dashboard-process.js";
import { createDashboardProxy } from "./dashboard-proxy.js";
import { createDashboardRuntime } from "./dashboard-runtime.js";
// 应用包版本信息查询（整合自 update-check.js 和 update-fpk.js。自动升级链路已移除，仅保留只读查询）
import { checkLatestVersion, createUpdateChecker, pickFpkDownloadUrl } from "./update-fpk.js";
import { fileURLToPath } from "url";
import pathModule, { dirname, join } from "path";

// 动态检测当前运行路径 - 完全不使用硬编码的盘符或路径
const ENV_APP_DIR   = process.env.APP_DIR;
const ENV_DATA_DIR  = process.env.DATA_DIR;
const ENV_VAR_DIR   = process.env.VAR_DIR;

// ESM：由 import.meta.url 推导 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = pathModule.dirname(__filename);

let APP_DIR;

if (ENV_APP_DIR) {
  // 优先级最高：环境变量指定的路径
  APP_DIR = ENV_APP_DIR;
} else {
  // 从当前 monitor.js 所在的文件路径自动推导 APP_DIR
  // __dirname 是 monitor.js 所在目录，即 <APP_DIR>/server
  // ESM 中 require 不可用，__dirname 已通过 fileURLToPath + pathModule.dirname 计算
  APP_DIR = pathModule.dirname(__dirname);
}

APP_DIR = pathModule.resolve(APP_DIR);
console.log(`[初始化] APP_DIR=${APP_DIR}`);

// 从 manifest 动态读取应用版本号（基于包升级模式），支持多层 fallback
function readAppVersion() {
  const MANIFEST_FILE = `${APP_DIR}/manifest`;  // APP_DIR 此时已确定
  const candidates = [
    MANIFEST_FILE,                            // 优先级 1：主 manifest（随包部署）
    "/var/apps/hermes-agent/manifest",        // 优先级 2：系统路径
    `${process.cwd()}/manifest`,              // 优先级 3：当前工作目录
  ];
  
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, "../../manifest"));
    candidates.push(join(here, "../manifest"));
  } catch {}
  
  let firstFailedPath = null;
  for (const fp of candidates) {
    try {
      const txt = readFileSync(fp, "utf8");
      const m = txt.match(/^version\s*=\s*(\S+)/m);
      if (m) {
        const v = m[1].trim();
        if (v && v !== "unknown") {
          log(`[版本读取] ${fp} → ${v}`);
          return v;
        }
      } else if (!firstFailedPath) {
        firstFailedPath = fp;  // 记录第一个失败的路径
      }
    } catch (e) {
      if (!firstFailedPath) firstFailedPath = fp;  // 记录第一个失败的路径
    }
  }
  
  // 只输出一次失败的提示
  if (firstFailedPath) {
    log(`[版本读取] 尝试了多个路径但都失败`);
  }
  return "unknown";
}

let APP_VERSION;

// 读取本地应用包版本（/api/update/check 契约的 local 字段来源）：
// 优先部署态 config/bootstrap/app-version.env（APP_VERSION=...，兼容带引号写法），
// 回退 APP_VERSION（manifest 读取，见 readAppVersion）。合回自原 update-check.js 的 getLocalVersion 逻辑。
function readLocalAppBuild() {
  const envPaths = [
    `${APP_DIR}/config/bootstrap/app-version.env`,
    `${process.cwd()}/config/bootstrap/app-version.env`,
  ];
  for (const fp of envPaths) {
    try {
      const text = readFileSync(fp, "utf8");
      const get = (k) => { const m = text.match(new RegExp(`^${k}\\s*=\\s*(.+)$`, "m")); return m ? m[1].trim().replace(/^["']|["']$/g, "") : ""; };
      const v = get("APP_VERSION");
      if (v && v !== "unknown") return { version: v, build_time: get("APP_BUILD_TIME"), build_date: get("APP_BUILD_DATE") };
    } catch {}
  }
  return { version: APP_VERSION || "unknown", build_time: "", build_date: "" };
}
function readLocalAppVersion() { return readLocalAppBuild().version; }

// 版本号是“月日序号”而非语义化版本（11101 与 11911 字典序/数值序都不代表先后），
// 所以只用 GitHub release 的 published_at 与本机构建时间判断新旧，版本串仅作展示。
// 返回 true/false，或 null（时间信息不足以判断）。
function decideHasUpdate(local, latest, publishedAt) {
  if (!latest || latest === "unknown" || !local.version || local.version === "unknown") return false;
  if (latest === local.version) return false;
  const published = Date.parse(publishedAt || "");
  if (!Number.isFinite(published)) return null;
  const built = Date.parse(local.build_time || "");
  if (Number.isFinite(built)) return published > built;
  // 旧包只有 APP_BUILD_DATE（构建机本地日期）：按日比较，同一天无法判断
  if (/^\d{4}-\d{2}-\d{2}$/.test(local.build_date || "")) {
    const publishedDay = new Date(published).toISOString().slice(0, 10);
    if (publishedDay === local.build_date) return null;
    return publishedDay > local.build_date;
  }
  return null;
}


if (!ENV_DATA_DIR || !pathModule.isAbsolute(ENV_DATA_DIR) || !ENV_VAR_DIR || !pathModule.isAbsolute(ENV_VAR_DIR)) {
  throw new Error("Explicit absolute DATA_DIR and VAR_DIR are required; refusing to open a different data directory");
}
const DATA_DIR = pathModule.resolve(ENV_DATA_DIR);
const VAR_DIR = pathModule.resolve(ENV_VAR_DIR);
const LOG_FILE       = `${VAR_DIR}/monitor.log`; // Monitor 自身日志（原 hermes.log，更名以便理解）
const PID_GATEWAY    = `${VAR_DIR}/gateway.pid`;
const GATEWAY_STATE  = `${VAR_DIR}/gateway-state.json`;
const TOKEN_FILE     = `${VAR_DIR}/monitor.token`;
const VERSION_FILE   = `${VAR_DIR}/hermes_version.txt`;
const START_TIME     = Date.now();

let lastUpdateCheckResult = false; // 跟踪上次检查结果，避免重复日志
// 获取本机 LAN IP（排除 loopback）
function getLANIP() {
  const ifs = networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const iface of ifs[name]) {
      if (iface.internal || iface.family !== "IPv4") continue;
      return iface.address;
    }
  }
  return "127.0.0.1";
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}天`);
  if (h > 0) parts.push(`${h}小时`);
  parts.push(`${m}分钟`);
  return parts.join(" ");
}

// 只选择 Gateway 端口。端口占用不作为进程归属或清理依据。
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || (isPortListening(8642) ? 28642 : 8642));
if (!Number.isInteger(GATEWAY_PORT) || GATEWAY_PORT < 1 || GATEWAY_PORT > 65535) throw new Error("Invalid GATEWAY_PORT");
const GATEWAY_API = `http://localhost:${GATEWAY_PORT}/v1`;

const SOCKET_PATH    = (process.env.MONITOR_SOCKET_PATH || "").trim();
if (!SOCKET_PATH) {
  console.error("[FATAL] MONITOR_SOCKET_PATH is required — unix socket mode only");
  process.exit(1);
}
const BASE_PATH      = (process.env.BASE_PATH || "").replace(/\/+$/, "");
const STATIC_DIR     = `${APP_DIR}/ui`; // 仅用于控制面板 index.html 等简单静态文件
const kernelRuntime = createKernelRuntime({ appDir: APP_DIR, dataDir: DATA_DIR, varDir: VAR_DIR });
const kernelVersion = createKernelVersion({ runtime: kernelRuntime });
const networkProxy = createNetworkProxy({ appDir: APP_DIR, dataDir: DATA_DIR });
// GITHUB_TOKEN is read from DATA/.env into memory only.
const githubCredentials = createGitHubCredentials({ appDir: APP_DIR, dataDir: DATA_DIR,
  networkProxy, log: text => log(`[github] ${text}`) });
const kernelUpdateCheck = createKernelUpdateCheck({ runtime: kernelRuntime, dataDir: DATA_DIR, networkProxy,
  credentials: githubCredentials });
const kernelRequests = new Set();
let kernelUpdateJob;
let kernelGateError = "";
function kernelBusy() {
  try {
    const busy = !!kernelUpdateJob?.busy();
    kernelGateError = "";
    return busy;
  } catch {
    if (!kernelGateError) log("[kernel-update] 无法确认更新锁状态，已暂停服务操作和自动启动；请检查更新日志");
    kernelGateError = "无法确认内核更新锁状态，请检查更新日志";
    return true;
  }
}
function kernelAutoStartAllowed() {
  if (kernelBusy()) return false;
  try {
    const status = kernelUpdateJob.status();
    return !status.storageError && !status.job?.recoveryRequired;
  } catch { return false; }
}

// ─── Node.js 运行时探测（hermes TUI 需要 node。版本在安装期由 install_callback 固定） ───

// data 优先：install_callback 的 ensure_node 会把最佳来源（飞牛 Node.js 应用 / 在线
// 下载）materialize 成 data/node 完整发行版并 chown 给 app 用户（最大权限、可自管）。
// 故 data/node 为权威运行时。app/runtime/node（若未来随包内置）仅作 data 缺失时的兜底。
const NODE_CANDIDATES = [
  `${DATA_DIR}/node/bin/node`,                   // ① data 权威运行时（最大权限，与 python venv 对齐）
  `${APP_DIR}/runtime/node/bin/node`,            // ② 打包内置兜底（若未来随包分发）
];
const resolvedNodeBin = NODE_CANDIDATES.find(p => {
  try { return existsSync(p) && (statSync(p).mode & 0o111) !== 0; } catch { return false; }
}) || null;
const resolvedNodeDir = resolvedNodeBin ? resolvedNodeBin.replace(/\/[^/]+$/, "") : null;

// 向上游发请求时统一使用的浏览器风格 UA，避免 Cloudflare 类网关因缺少 User-Agent 掐断连接
const UPSTREAM_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// APP_DIR 现已确定，可以安全读取 manifest 版本
APP_VERSION = readAppVersion();
log(`[启动检测] 应用包版本 (manifest): ${APP_VERSION}`);

mkdirSync(VAR_DIR, { recursive: true });

function formatHermesVersion(raw) {
  if (!raw) return "unknown";
  const text = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  // 只读 Hermes 行，兼容完整的历史版本缓存，找不到时绝不改从依赖、路径或诊断信息里推测版本/日期。
  const named = text.match(/^[ \t]*Hermes[ \t]+Agent[ \t]+([^\r\n]*)/im);
  const match = (named ? named[1].trim() : text).match(/^v?(unknown|\d+\.\d+\.\d+)(?:[ \t]+\((\d{4})[-./](\d{1,2})[-./](\d{1,2})\))?(?:[ \t]+·[ \t]+(?:upstream[ \t]+[a-f0-9]{7,40}|(?:stable|preview|edge)[ \t]+·[ \t]+local[ \t]+[a-f0-9]{7,40}))?$/i);
  if (!match || match[1].toLowerCase() === "unknown" || /^\d{4}\./.test(match[1])) return "unknown";
  let out = `v${match[1]}`;
  if (match[2]) out += ` (${match[2]}.${Number(match[3])}.${Number(match[4])})`;
  return out;
}
let HERMES_VERSION = "unknown";
// 版本检测逻辑（带异常处理）
try {
  // 优先读缓存文件（瞬间完成），让服务器尽快启动
  if (existsSync(VERSION_FILE)) {
    const cached = formatHermesVersion(readFileSync(VERSION_FILE, "utf8"));
    if (cached !== "unknown") HERMES_VERSION = cached;
  }
  
} catch (e) {
  log(`[版本检测] 版本探测异常：${e.message}`);
}
// 必须走异步执行：此定时器在服务开始监听后触发，同步子进程一旦挂起会冻结事件循环，
// 导致首屏 index.html 等全部请求被拖住直至子进程退出（#141 白屏根因）。
let versionProbe = 0;
function refreshHermesVersion() {
  const probe = ++versionProbe;
  log(`[版本检测] 准备刷新缓存 (当前=${HERMES_VERSION}, 文件=${VERSION_FILE})`);
  return kernelVersion.read({ fresh: true }).then((identity) => {
      if (probe !== versionProbe) return;
      if (!identity) {
        log("[版本检测] 无法核实当前内核的本地版本信息");
        return;
      }
      if (identity.short) {
        const realVer = identity.short;
        if (realVer !== HERMES_VERSION) {
          HERMES_VERSION = realVer;
          try { writeFileSync(VERSION_FILE, realVer, { mode: 0o644 }); } catch (e2) {
            log(`[版本检测] 后台刷新写入缓存失败: ${e2.message}`);
          }
          log(`[版本检测] Hermes Agent 版本已刷新：${realVer}`);
        }
      }
    }).catch((e) => {
      log(`[版本检测] 后台刷新异常：${e.message}`);
    });
}
process.nextTick(refreshHermesVersion);
log(`[启动检测] Hermes Agent 版本: ${HERMES_VERSION}`);

// ─── 启动令牌（写入 VAR_DIR 供本机 CLI/脚本读取）────────────────────────────
const HERMES_TOKEN_MIRROR = `${DATA_DIR}/.monitor_token`;
function readExistingToken(path) {
  let entry;
  try { entry = lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!entry.isFile()) throw new Error(`Refusing non-file token: ${path}`);
  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new Error(`Existing token is empty; preserved for recovery: ${path}`);
  return token;
}
const MONITOR_TOKEN = (() => {
  const existing = readExistingToken(TOKEN_FILE);
  if (existing) return existing;
  const token = readExistingToken(HERMES_TOKEN_MIRROR) || randomBytes(24).toString("hex");
  writeFileSync(TOKEN_FILE, token, { mode: 0o600, flag: "wx" });
  return token;
})();

// ─── 主模型配置模块接入：注入路径 / 日志 / 本机令牌等共用设施 ───────────
initPrimaryConfig({ varDir: VAR_DIR, dataDir: DATA_DIR, log, monitorToken: MONITOR_TOKEN,
  runtime: kernelRuntime, networkProxy });


function syncTokenToHermesHome() {
  try { writeFileSync(HERMES_TOKEN_MIRROR, MONITOR_TOKEN, { mode: 0o600, flag: "wx" }); }
  catch (e) { if (e.code !== "EEXIST") log(`同步 token 到 Hermes home 失败: ${e?.message || e}`); }
}
syncTokenToHermesHome();

// ─── 令牌同步结束（data-preservation.test.js 以此行切分源码，改动时同步修改测试）

function beijingTime() {
  const d = new Date(Date.now() + 8 * 3600000);
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}
function log(...args) {
  const msg = `[monitor] ${beijingTime()} ${args.join(" ")}`;
  console.log(msg);
  try { writeFileSync(LOG_FILE, msg + "\n", { flag: "a" }); } catch {}
}

// 直接读 /proc/net/tcp[6] 判断本机是否有进程在指定端口 LISTEN。
// 适用于非 HTTP 的内部端口（如 8642 网关通信端口），不受 HTTP 探活失败或
// localhost 解析为 IPv6 影响，比 portAlive 的 HTTP OPTIONS 探测更可靠。
function isPortListening(port) {
  const suffix = ":" + Number(port).toString(16).toUpperCase().padStart(4, "0");
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      const lines = readFileSync(f, "utf8").split("\n");
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].trim().split(/\s+/);
        if (parts.length < 4) continue;
        // parts[1]=本地地址(HEX_IP:HEX_PORT)  parts[3]=状态(0A=LISTEN)
        if (parts[3] === "0A" && parts[1] && parts[1].toUpperCase().endsWith(suffix)) {
          return true;
        }
      }
    } catch {}
  }
  return false;
}

function getProcessRssKB(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

async function getStatus() {
  let webapp = await webappRuntime.status();
  let owned;
  try { owned = inspectGateway(); }
  catch (error) { owned = { state: "unverified", reason: error.message }; }
  const running = owned.state === "owned";
  const pid = running ? owned.identity.pid : null;
  if (!running) webapp = { ...webapp, running: false, healthy: false, gateway_running: false, pid: null };
  return {
    gateway: { running, healthy: running && !!webapp.gateway_running,
      desired_running: gatewayDesired,
      state: running ? "running" : (owned.state !== "gone" ? "unknown" : (gatewayDesired ? "starting" : "stopped")),
      pid, port: GATEWAY_PORT, crash_loop: gatewayCrashLoop, ownership: owned.state,
      error: owned.reason || "",
      version: HERMES_VERSION, hermes: HERMES_VERSION, app_version: readLocalAppVersion() },
    webapp,
  };
}

function createLogStream(req, lastOffset) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (data, ev = "log") => {
        if (closed) return;
        try { controller.enqueue(enc.encode(`event: ${ev}\ndata: ${data}\n\n`)); }
        catch { closed = true; try { controller.close(); } catch {} }
      };

      // offset >= 0 = 重连，跳过历史，-1 = 首次连接，发送历史
      let offset = 0;
      if (lastOffset >= 0) {
        let fileSize = 0;
        try { if (existsSync(LOG_FILE)) fileSize = statSync(LOG_FILE).size; } catch {}
        if (lastOffset <= fileSize) {
          offset = lastOffset;
        } else {
          try {
            if (existsSync(LOG_FILE))
              readFileSync(LOG_FILE, "utf8").split("\n").filter(l => l.trim()).slice(-30)
                .forEach(l => send(l));
          } catch {}
          offset = fileSize;
        }
      } else {
        try {
          if (existsSync(LOG_FILE))
            readFileSync(LOG_FILE, "utf8").split("\n").filter(l => l.trim()).slice(-30)
              .forEach(l => send(l));
        } catch {}
        try { if (existsSync(LOG_FILE)) offset = statSync(LOG_FILE).size; } catch {}
      }

      const flush = () => {
        try {
          if (!existsSync(LOG_FILE)) return;
          const sz = statSync(LOG_FILE).size;
          if (sz < offset) {
            offset = 0;
          }
          if (sz > offset) {
            const chunk = readFileSync(LOG_FILE, "utf8").slice(offset);
            offset = sz;
            chunk.split("\n").filter(l => l.trim()).forEach(l => send(l));
          }
        } catch {}
      };

      let watcher = null;
      try {
        watcher = watch(existsSync(LOG_FILE) ? LOG_FILE : VAR_DIR, () => flush());
      } catch {}

      const heartbeat = setInterval(() => send("", "heartbeat"), 30000);

      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(heartbeat);
        try { watcher?.close(); } catch {}
        try { controller.close(); } catch {}
      });
    },
  });
}

// ─── 静态文件服务 ─────────────────────────────────────────────────────
async function serveFile(filePath, contentType) {
  if (!existsSync(filePath)) return new Response("Not Found", { status: 404 });
  
  const fileObj = file(filePath);

  try {
    const chunks = [];
    for await (const chunk of fileObj) {
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks);
    return new Response(content, {
      headers: { "Content-Type": contentType },
    });
  } catch (e) {
    log(`ServeFile error: ${e.message}`);
    return new Response("Internal Server Error", { status: 500 });
  }
}

// 只跟踪显式且已验证的网关 PID，绝不按端口反查归属。
const ownership = createGatewayOwnership({ appDir: APP_DIR, dataDir: DATA_DIR });
let gatewayIdentity = null;
let gatewayStarting = null;
let gatewayTelegramProxy = null;
const gatewayReadiness = createStartupDeadline();
let expectedGatewayExit = null;
let gatewayDesired = true;
let gatewayCrashLoop = false;
let gatewayCrashes = [];
let shuttingDown = false;
let gatewayCrashLoopAt = 0;

function readGatewayPid() {
  let value;
  try { value = readFileSync(PID_GATEWAY, "utf8").trim(); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Cannot read Gateway PID: ${error.code || "I/O failure"}`);
  }
  if (!/^[1-9]\d*$/.test(value)) throw new Error("Invalid Gateway PID file: expected a positive integer");
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid Gateway PID file: expected a safe integer greater than 1");
  return pid;
}
function readGatewayRecord() {
  let text;
  try {
    if (!lstatSync(GATEWAY_STATE).isFile()) throw new Error("not a regular file");
    text = readFileSync(GATEWAY_STATE, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Cannot read Gateway launch record: ${error.code || "not a regular file"}`);
  }
  let saved;
  // JSON parser messages can contain record contents (including launch tokens).
  try { saved = JSON.parse(text); }
  catch { throw new Error("Invalid Gateway launch record: empty or malformed JSON"); }
  if (!saved || !Number.isSafeInteger(saved.pid) || saved.pid <= 1 || !/^\d+$/.test(saved.starttime || "")) {
    throw new Error("Invalid Gateway launch record: expected PID and starttime");
  }
  return saved;
}
function durableWriteGatewayRecord(target, value) {
  const temporary = `${target}.${randomBytes(12).toString("hex")}.tmp`;
  let fileFd, directoryFd, ownsTemporary = false;
  const errors = [];
  try {
    fileFd = openSync(temporary, "wx", 0o600);
    ownsTemporary = true;
    if (process.platform !== "win32") {
      // fnOS may inherit permissions; correct only our new, empty descriptor.
      if ((fstatSync(fileFd).mode & 0o777) !== 0o600) fchmodSync(fileFd, 0o600);
      if ((fstatSync(fileFd).mode & 0o777) !== 0o600) throw new Error("Cannot create a private Gateway launch record/PID");
    }
    writeFileSync(fileFd, value, "utf8");
    fsyncSync(fileFd);
    const fd = fileFd;
    fileFd = undefined; // Never retry close on a possibly released descriptor.
    closeSync(fd);
    renameSync(temporary, target);
    ownsTemporary = false; // Publication is not rolled back if directory fsync fails.
    if (process.platform === "linux") {
      directoryFd = openSync(dirname(target), "r");
      fsyncSync(directoryFd);
    }
  } catch (error) { errors.push(error); }
  finally {
    for (const fd of [fileFd, directoryFd]) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch (error) { errors.push(error); }
      }
    }
    if (ownsTemporary) {
      try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") errors.push(error); }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Gateway launch record/PID persistence and cleanup failed");
}
function persistGatewayIdentity(identity) {
  durableWriteGatewayRecord(GATEWAY_STATE, JSON.stringify(identity));
  durableWriteGatewayRecord(PID_GATEWAY, String(identity.pid));
}
function clearGatewayPid(pid) {
  if (readGatewayPid() === pid) unlinkSync(PID_GATEWAY);
  if (readGatewayRecord()?.pid === pid) unlinkSync(GATEWAY_STATE);
}
function trackGatewayIdentity(identity) {
  gatewayReadiness.observe(`${identity.pid}:${identity.starttime}`);
  gatewayIdentity = identity;
}
function inspectGateway() {
  if (!gatewayIdentity) gatewayIdentity = readGatewayRecord();
  const marker = readGatewayPid();
  if (gatewayIdentity && marker && gatewayIdentity.pid !== marker) throw new WebappError("Gateway PID conflicts with its launch record", 409);
  const pid = gatewayIdentity?.pid || marker;
  if (!pid) return { state: "gone" };
  const result = ownership.inspect(pid, gatewayIdentity);
  if (result.state === "owned") trackGatewayIdentity(result.identity);
  // A reused PID is not confirmed absence; do not adopt it or let the watchdog spawn.
  if (result.state === "gone") {
    clearGatewayPid(pid);
    gatewayIdentity = null;
    gatewayReadiness.reset();
    return { state: "gone" };
  }
  return result;
}
function acceptGatewayPid(pid) {
  if (gatewayIdentity && gatewayIdentity.pid !== pid && inspectGateway().state !== "gone") {
    throw new WebappError("Gateway PID conflicts with the tracked instance", 409);
  }
  const result = ownership.inspect(pid, gatewayIdentity?.pid === pid ? gatewayIdentity : undefined);
  if (result.state !== "owned") throw new WebappError(result.reason || `Gateway identity is ${result.state}`, 409);
  trackGatewayIdentity(result.identity);
  if (readGatewayPid() !== pid) durableWriteGatewayRecord(PID_GATEWAY, String(pid));
}
function resetGatewayCrashLoop() { gatewayCrashes = []; gatewayCrashLoop = false; gatewayCrashLoopAt = 0; }
function recordGatewayCrash() {
  const now = Date.now();
  gatewayCrashes = gatewayCrashes.filter(at => now - at < 60000);
  gatewayCrashes.push(now);
  gatewayCrashLoop = gatewayCrashes.length >= 3;
  if (gatewayCrashLoop) { gatewayCrashLoopAt = now; log("[gateway] 短时间内多次异常退出，5 分钟后自动重试"); }
}
async function stopOwnedGateway(timeoutMs = 28000) {
  let result = inspectGateway();
  if (result.state === "gone") {
    if (gatewayIdentity) clearGatewayPid(gatewayIdentity.pid);
    gatewayIdentity = null;
    const telegramProxy = gatewayTelegramProxy;
    gatewayTelegramProxy = null;
    await telegramProxy?.close();
    return { ok: true };
  }
  if (result.state !== "owned") throw new WebappError(result.reason || "Gateway identity cannot be verified", 409);
  const identity = result.identity;
  await instanceControl("idle", undefined, { duringShutdown: true });
  result = inspectGateway();
  if (result.state !== "owned" || result.identity.pid !== identity.pid || result.identity.starttime !== identity.starttime) {
    throw new WebappError("Gateway identity changed before stop", 409);
  }
  expectedGatewayExit = identity;
  try {
    const stopped = await ownership.stop(identity, { timeoutMs });
    const telegramProxy = gatewayTelegramProxy;
    gatewayTelegramProxy = null;
    await telegramProxy?.close();
    clearGatewayPid(identity.pid);
    if (gatewayIdentity?.pid === identity.pid && gatewayIdentity.starttime === identity.starttime) gatewayIdentity = null;
    return stopped;
  } catch (error) { expectedGatewayExit = null; throw error; }
}
async function spawnHermes() {
  if (shuttingDown) throw new WebappError("Monitor is shutting down");
  if (gatewayStarting) return gatewayStarting;
  if (gatewayCrashLoop) throw new WebappError("Gateway crash loop; inspect logs and retry manually", 409);
  gatewayStarting = (async () => {
    const previous = inspectGateway();
    if (previous.state === "owned") return { ok: true, pid: previous.identity.pid };
    if (previous.state !== "gone") throw new WebappError(previous.reason || "Gateway PID was replaced", 409);
    if (process.platform !== "linux") throw new WebappError("Gateway ownership requires Linux /proc");
    await instanceControl("configure-default");
    if (shuttingDown) throw new WebappError("Monitor is shutting down");
    const configured = inspectGateway();
    if (configured.state !== "gone") throw new WebappError(configured.reason || "Gateway appeared during default WebApp setup", 409);
    mkdirSync(`${DATA_DIR}/logs`, { recursive: true });
    const command = kernelRuntime.command(["gateway", "run", "--quiet"]);
    const launch = command.selected.kind === "source" ? { id: command.selected.id, root: command.selected.root,
      token: randomBytes(32).toString("hex") } : null;
    const fd = openSync(`${DATA_DIR}/logs/gateway.log`, "a", 0o600);
    let child, telegramProxy;
    const startedAt = Date.now();
    try {
      telegramProxy = await networkProxy.openTelegramProxy({ ...command.env, PWD: command.cwd });
      if (shuttingDown) throw new WebappError("Monitor is shutting down");
      const current = inspectGateway();
      if (current.state !== "gone") throw new WebappError(current.reason || "Gateway appeared before spawn", 409);
      child = spawnAsync(command.executable, command.args, {
        cwd: command.cwd, env: { ...telegramProxy.env, API_SERVER_KEY: MONITOR_TOKEN,
          ...(launch ? { FNOS_LAUNCH_TOKEN: launch.token, FNOS_LAUNCH_ROLE: "Gateway" } : {}),
          API_SERVER_PORT: String(GATEWAY_PORT), API_SERVER_HOST: "127.0.0.1" },
        stdio: ["ignore", fd, fd], detached: true,
      });
      gatewayTelegramProxy = telegramProxy;
    } catch (error) {
      await telegramProxy?.close();
      throw error;
    } finally { closeSync(fd); }
    const closeTelegramProxy = () => {
      if (gatewayTelegramProxy === telegramProxy) gatewayTelegramProxy = null;
      return telegramProxy.close();
    };
    let exited = false;
    let childIdentity = null;
    child.once("exit", (code, signal) => {
      exited = true;
      closeTelegramProxy().catch(() => log("[gateway] Telegram proxy cleanup failed"));
      log(`[gateway] Exited (code=${code}, signal=${signal || "none"})`);
      if (!shuttingDown && expectedGatewayExit?.pid !== child.pid) {
        if (Date.now() - startedAt >= 60000) resetGatewayCrashLoop();
        recordGatewayCrash();
        if (!gatewayCrashLoop) setTimeout(() => keepGatewayAlive("异常退出后自动拉起"), 3000).unref();
      }
      try { clearGatewayPid(child.pid); } catch (error) { log(`[gateway] PID cleanup failed: ${error.message}`); }
      if (childIdentity && gatewayIdentity?.pid === childIdentity.pid && gatewayIdentity.starttime === childIdentity.starttime) gatewayIdentity = null;
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", error => {
        recordGatewayCrash();
        closeTelegramProxy().then(() => reject(error), () => reject(error));
      });
    });
    expectedGatewayExit = null;
    // exec 和 /proc 可见性可能略晚于 spawn 事件。不能只信 child.pid。
    const deadline = Date.now() + (launch ? 30000 : 2000);
    while (!exited) {
      const result = launch ? ownership.claim(child.pid, launch) : ownership.inspect(child.pid);
      if (result.state === "owned") {
        childIdentity = result.identity;
        trackGatewayIdentity(childIdentity);
        try { persistGatewayIdentity(childIdentity); }
        catch (error) {
          // Startup bookkeeping failure is not proof of idle. Keep the verified
          // identity in memory for diagnosis instead of killing a starting service.
          child.unref();
          throw new WebappError(`Cannot persist Gateway identity; tracked process left running: ${error.message}`);
        }
        child.unref();
        return { ok: true, pid: child.pid };
      }
      if (Date.now() >= deadline) {
        await closeTelegramProxy();
        if (result.state !== "gone") durableWriteGatewayRecord(PID_GATEWAY, String(child.pid));
        throw new WebappError(result.reason || "Cannot verify spawned gateway");
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new WebappError("Gateway exited during startup; inspect the gateway log");
  })();
  try { return await gatewayStarting; } finally { gatewayStarting = null; }
}

// 共享进行中的重启 Promise（包括其 rejection），而不是吞掉失败。
let channelRestartInFlight = null;
initChannels({ dataDir: DATA_DIR, log, networkProxy, restartGateway: reason => {
  if (shuttingDown) return Promise.resolve();
  if (!channelRestartInFlight) {
    log(`[channels] 重启网关: ${reason}`);
    channelRestartInFlight = manageServices(() => gatewayDesired ? restartGateway() : undefined)
      .finally(() => { channelRestartInFlight = null; });
  }
  return channelRestartInFlight;
}, nodeBin: resolvedNodeBin, nodeDir: resolvedNodeDir });

const WEBAPP_PORT = Number(process.env.WEBAPP_PORT || 9120);
if (!Number.isInteger(WEBAPP_PORT) || WEBAPP_PORT < 1 || WEBAPP_PORT > 65535) throw new Error("Invalid WEBAPP_PORT");
const pythonControl = createPythonControl({ runtime: kernelRuntime, home: DATA_DIR, log });
async function instanceControl(action, payload, { duringShutdown = false } = {}) {
  if (shuttingDown && !(duringShutdown && ["status", "idle"].includes(action))) throw new WebappError("Monitor is shutting down");
  const tracked = inspectGateway();
  if (!["owned", "gone"].includes(tracked.state)) throw new WebappError(tracked.reason || "Gateway PID was replaced", 409);
  if (action === "configure-default" && tracked.state !== "gone") {
    throw new WebappError("Gateway is already running; default settings were not changed", 409);
  }
  if (["configure", "idle", "launch"].includes(action)) {
    const live = await instanceControl("status", undefined, { duringShutdown });
    const verified = inspectGateway();
    if (tracked.state === "owned" && (verified.state !== "owned" || verified.identity.pid !== tracked.identity.pid
        || verified.identity.starttime !== tracked.identity.starttime)) {
      throw new WebappError("Gateway identity changed before control operation", 409);
    }
    const absent = live.state === "off" && live.pid === null && verified.state === "gone";
    if (live.control_ready !== true && !(absent && action !== "launch")) {
      throw new WebappError(live.reason || "Gateway control is not ready; no service settings were changed");
    }
  }
  const result = await pythonControl.control(action, payload);
  if (action !== "status") {
    if (action === "idle" && result?.idle !== true) throw new WebappError("Gateway did not confirm idle; no service was stopped", 409);
    return result;
  }
  if (!result || typeof result.control_ready !== "boolean"
      || !(result.pid === null || (Number.isSafeInteger(result.pid) && result.pid > 1))
      || !["off", "starting", "serving", "unavailable"].includes(result.state)) {
    throw new WebappError("Gateway returned an invalid control status");
  }
  const current = inspectGateway();
  if (!["owned", "gone"].includes(current.state)
      || (tracked.state === "owned" && (current.state !== "owned"
        || tracked.identity.pid !== current.identity.pid || tracked.identity.starttime !== current.identity.starttime))) {
    throw new WebappError(current.reason || "Gateway identity changed during control query", 409);
  }
  if (result.pid) acceptGatewayPid(result.pid);
  if (result.control_ready && !result.pid) throw new WebappError("Gateway control replied without a verified PID", 409);
  if ((!result.control_ready && (gatewayIdentity || result.state !== "off")) || result.state === "starting") {
    // No invented PID: retain only Python's diagnostic PID. Ownership alone never
    // authorizes configure/idle/launch, even during the startup grace period.
    if (!gatewayIdentity) gatewayReadiness.observe("pid-discovery");
    const expired = gatewayReadiness.expired();
    return { ...result, state: expired ? "unavailable" : "starting", gateway_starttime: gatewayIdentity?.starttime || null,
      reason: expired ? `Gateway startup did not complete within 60 seconds (${result.reason || "control/listener not ready"})` : result.reason };
  }
  return { ...result, gateway_starttime: gatewayIdentity?.starttime || null };
}
const webappRuntime = createWebappRuntime({
  control: instanceControl, stopGateway: () => stopOwnedGateway(),
  basePath: BASE_PATH, port: WEBAPP_PORT, startGateway: spawnHermes,
  onPid: pid => { if (pid) acceptGatewayPid(pid); },
});
const webappProxy = createWebappProxy({
  port: WEBAPP_PORT, basePath: BASE_PATH,
  authorize: req => isFnosAdmin(req),
  // 面板注入 WebApp 的界面补丁：ui/webapp-patch/patch.{js,css} 注入到 WebApp 页面，不改动 hermes-src。
  patchDir: `${STATIC_DIR}/webapp-patch`,
});

if ([GATEWAY_PORT, WEBAPP_PORT].includes(9119)) throw new Error("Dashboard port 9119 must not overlap Gateway or WebApp");
const dashboardProcess = createDashboardProcess({ appDir: APP_DIR, dataDir: DATA_DIR, varDir: VAR_DIR,
  runtime: kernelRuntime, basePath: BASE_PATH, log });
const dashboardRuntime = createDashboardRuntime({
  control: (action, payload) => pythonControl.control(action, payload), process: dashboardProcess, basePath: BASE_PATH,
});
const dashboardProxy = createDashboardProxy({
  port: 9119, basePath: BASE_PATH,
  authorize: req => isFnosAdmin(req),
});
let managementQueue = Promise.resolve();
function manageServices(action) {
  const result = managementQueue.then(() => {
    if (shuttingDown) throw new WebappError("Monitor is shutting down");
    if (kernelBusy()) throw new WebappError("内核维护期间不能操作应用服务", 409);
    return action();
  });
  managementQueue = result.catch(() => {});
  return result;
}

const kernelMaintenance = createKernelMaintenance({
  drain: async () => {
    await Promise.allSettled([...kernelRequests]);
    await kernelControl.drain();
    await managementQueue;
    if (gatewayStarting) await gatewayStarting;
  },
  inspectGateway, inspectDashboard: () => dashboardProcess.inspect(),
  control: (action, payload) => instanceControl(action, payload),
  stopGateway: () => stopOwnedGateway(),
  startGateway: () => { resetGatewayCrashLoop(); return spawnHermes(); },
  dashboard: dashboardRuntime, stopping: () => shuttingDown,
  gatewayHealthy,
  webappHealthy: async () => (await webappRuntime.status(true)).healthy === true,
});
const kernelBootstrap = createKernelBootstrap({ appDir: APP_DIR, dataDir: DATA_DIR, varDir: VAR_DIR,
  runtime: kernelRuntime, run: runKernelProcess });
kernelUpdateJob = createKernelUpdateJob({ dataDir: DATA_DIR, varDir: VAR_DIR, runtime: kernelRuntime,
  bootstrap: kernelBootstrap, checker: kernelUpdateCheck, networkProxy, credentials: githubCredentials,
  services: { ...kernelMaintenance, async resume(...args) {
    try { return await kernelMaintenance.resume(...args); }
    finally {
      HERMES_VERSION = "unknown";
      await refreshHermesVersion();
    }
  } },
  log: (text, level) => log(`[kernel-update][${level || "info"}] ${text}`) });
const kernelControl = createKernelControl({ runtime: kernelRuntime, checker: kernelUpdateCheck, job: kernelUpdateJob, version: kernelVersion });
const kernelNativeApi = createKernelNativeApi({ runtime: kernelRuntime, control: kernelControl, job: kernelUpdateJob, dataDir: DATA_DIR });
const networkControl = createNetworkControl({ networkProxy, busy: () => shuttingDown || kernelBusy(),
  onChanged: status => manageServices(async () => {
    if (!gatewayDesired || inspectGateway().state === "gone" || (!status.enabled && gatewayTelegramProxy?.mode !== "proxy")) {
      return { gateway_restarted: false };
    }
    await restartGateway();
    return { gateway_restarted: true };
  }),
});
// 公私入口共用操作锁，以及“等待进行中的请求结束”（drain）的计数。维护期间仍允许读取代理状态。
async function handleNetworkRequest(req) {
  const pending = networkControl.handle(req);
  kernelRequests.add(pending);
  try { return await pending; } finally { kernelRequests.delete(pending); }
}
const kernelControlSocket = createKernelControlSocket({ varDir: VAR_DIR, handle: req =>
  networkControl.matches(new URL(req.url).pathname) ? handleNetworkRequest(req) : kernelControl.handle(req) });
export async function startMonitor() {
  await kernelControlSocket.start();
  githubCredentials.start();
  manageServices(() => kernelAutoStartAllowed() ? dashboardRuntime.start() : undefined)
    .catch(error => log(`[dashboard] 默认启动失败: ${error.message}`));
}

async function gatewayHealthy() {
  try {
    const live = await instanceControl("status");
    if (!live.pid || live.control_ready !== true) return false;
    const response = await fetch(`${GATEWAY_API}/models`, { headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
      signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}
async function waitForGateway() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (!shuttingDown && Date.now() < deadline) {
    const current = inspectGateway();
    if (current.state !== "owned") throw new WebappError(current.reason || "Gateway exited during startup");
    if (await gatewayHealthy()) return { ok: true };
    await new Promise(resolve => setTimeout(resolve, 600));
  }
  throw new WebappError("Gateway did not become healthy in time; inspect the gateway log");
}
async function restartGateway() {
  await instanceControl("idle");
  await stopOwnedGateway();
  gatewayDesired = true;
  resetGatewayCrashLoop();
  await spawnHermes();
  return waitForGateway();
}

// 手动停止只暂停本次应用运行的自动拉起，重新启动应用恢复默认运行。
let keepAliveInFlight = null;
// 每次 Monitor 启动尝试完整开启 WebApp。手动操作接管后，本轮不再自动重新开启。
let webappAutoStartPending = true;
let webappAutoStartCancelled = false;
function keepGatewayAlive(reason, verifyExisting = false) {
  if (shuttingDown || !gatewayDesired || !kernelAutoStartAllowed() || gatewayStarting || keepAliveInFlight) return keepAliveInFlight || Promise.resolve();
  if (gatewayCrashLoop) {
    if (Date.now() - gatewayCrashLoopAt < 5 * 60000) return Promise.resolve();
    resetGatewayCrashLoop();
  }
  let state;
  try { state = inspectGateway().state; } catch (error) { log(`[gateway] 自动拉起前检查失败: ${error.message}`); return Promise.resolve(); }
  const autoEnableRequested = webappAutoStartPending && !webappAutoStartCancelled;
  if (state !== "gone" && !(state === "owned" && (verifyExisting || autoEnableRequested))) return Promise.resolve();
  log(`[gateway] 自动启动/就绪核查: ${reason}`);
  keepAliveInFlight = manageServices(async () => {
    // 被手动操作取消的开启任务直接退出，不能退化成一次普通 Gateway 拉起。
    if (!gatewayDesired || !kernelAutoStartAllowed() || (autoEnableRequested && webappAutoStartCancelled)) return;
    const current = inspectGateway();
    if (!["owned", "gone"].includes(current.state)) throw new WebappError(current.reason || "Gateway identity cannot be verified", 409);
    const enableWebapp = webappAutoStartPending && !webappAutoStartCancelled;
    if (current.state === "owned" && !verifyExisting && !enableWebapp) return;
    if (enableWebapp) {
      // 与设置页共用 check/idle/configure/restart/readiness，不预先 spawn 或嵌套管理队列。
      const result = await webappRuntime.ensureRunning();
      if (result?.ok !== true || result.webapp?.healthy !== true) throw new WebappError("WebApp startup did not confirm readiness");
    } else if (current.state === "gone") await spawnHermes();
    await waitForGateway();
    log("[gateway] Gateway 已按现有配置就绪");
    if (enableWebapp) {
      webappAutoStartPending = false;
      log("[webapp] 已通过设置页启动流程确认就绪");
      return;
    }
    const config = await instanceControl("settings");
    if (typeof config?.enabled !== "boolean" || config.error) throw new WebappError(config?.error || "Cannot read WebApp enablement");
    if (config.enabled === true) {
      try { await webappRuntime.waitUntilHealthy(); }
      catch (error) { throw new WebappError(`Gateway 已起，WebApp 未就绪: ${error.message}`); }
      log("[webapp] 已按现有配置就绪");
    }
  }).catch(error => log(`[gateway] 自动启动/就绪核查失败: ${error.message}`))
    .finally(() => { keepAliveInFlight = null; });
  return keepAliveInFlight;
}
setTimeout(() => keepGatewayAlive("应用启动", true), 2500).unref();
setInterval(() => keepGatewayAlive("定时巡检发现未运行"), 30000).unref();

// 应用包版本更新检查器（/api/update/check 用，实时查询 GitHub，仅成功结果缓存 5 分钟、失败态不缓存）
const appUpdateChecker = createUpdateChecker({ appDir: APP_DIR, log, cacheFile: `${VAR_DIR}/update-latest.txt`, networkProxy, credentials: githubCredentials });

// ─── 请求处理器 ─────────────────────────────────────────────────────────
async function handleFetch(req) {
  const url  = new URL(req.url);
  // fnOS gateway 反向代理不剥路径前缀（/app/{appname}/），这里手动剥离并归一化
  const path = url.pathname.replace(/^\/app\/[^/]+/, "").replace(/\/+$/, "") || "/";

  const refusal = authorizePanel(req, MONITOR_TOKEN);
  if (refusal) return refusal;
  const networkRequest = networkControl.matches(path);
  // 浏览器读取可以没有 Origin。网络写操作须同时通过管理令牌和同源校验。
  if (networkRequest && (req.headers.has("origin") || !["GET", "HEAD", "OPTIONS"].includes(req.method))
      && !requestOrigin(req) && !authorizedOrigin(req, MONITOR_TOKEN)) {
    return panelDenied("PANEL_ORIGIN", "浏览器入口未通过同源校验，请刷新状态后重试");
  }
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (networkRequest) return handleNetworkRequest(req);

  const corsOrigin = requestOrigin(req) || "null";
  const jsonHeaders = (extra = {}) => ({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": corsOrigin,
    ...extra,
  });

  if (path === "/api/health") {
    const origin = req.headers.get("x-panel-origin");
    const token = origin ? panelToken(origin, MONITOR_TOKEN) : MONITOR_TOKEN;
    if (!token || (origin && req.headers.has("origin") && browserOrigin(req) !== origin)) {
      return panelDenied("PANEL_ORIGIN", "浏览器入口地址无效，请重新打开面板");
    }
    // 授权只供同源脚本读取，绑定浏览器入口，不依赖反向代理改写后的 Host。
    return Response.json({ ok: true, ts: Date.now(), token }, { headers: { "Cache-Control": "no-store" } });
  }

  // 端口在监听不能证明网关属于本实例。
  if (path === "/api/gateway/health") {
    const status = await getStatus();
    if (!status.gateway.running) return Response.json({ ok: false, error: "No verified gateway", port: GATEWAY_PORT }, { status: 503, headers: jsonHeaders() });
    const t0 = Date.now();
    let ok = false, err = null;
    try {
      const r = await fetch(`${GATEWAY_API}/models`, {
        headers: { "Authorization": `Bearer ${MONITOR_TOKEN}` },
        signal: AbortSignal.timeout(2000),
      });
      ok = r.ok;
      if (!ok) err = `HTTP ${r.status}`;
    } catch (e) { err = e?.message || String(e); }
    return new Response(JSON.stringify({ ok, latency: Date.now() - t0, error: err, port: GATEWAY_PORT }), {
      headers: jsonHeaders(),
    });
  }

  if (path === "/api/status") {
    const s = await getStatus();
    const uptimeMs = Date.now() - START_TIME;
    const uptimeStr = formatUptime(uptimeMs);
    const monPid = process.pid;
    const gwPid = s.gateway.pid;
    const logDir = `${DATA_DIR}/logs`;
    const logFiles = [
      { name: "monitor.log",             label: "Monitor 日志" },
      { name: "agent.log",              label: "Agent 日志" },
      { name: "gui.log",                label: "GUI 日志" },
      { name: "errors.log",             label: "错误日志" },
      { name: "gateway.log",            label: "Gateway 日志" },
      { name: "gateway-restart.log",    label: "Gateway 重启记录" },
      { name: "gateway-shutdown-diag.log", label: "Gateway 关闭诊断" },
      { name: "gateway-exit-diag.log",  label: "Gateway 退出诊断" },
    ].map(({ name, label }) => {
      const fp = `${logDir}/${name}`;
      let size = 0, mtime = null;
      try { const s2 = statSync(fp); size = s2.size; mtime = s2.mtime.toISOString(); } catch {}
      return { name, label, size, mtime };
    });
    // 不枚举进程：只处理本 Monitor 和刚验证过的网关。
    const memKB = Math.round(process.memoryUsage().rss / 1024) + (gwPid ? getProcessRssKB(gwPid) : 0);
    return new Response(JSON.stringify({
      ...s,
      uptime: uptimeStr,
      uptimeMs,
      pid: monPid,
      gatewayPid: gwPid,
      gatewayAlive: s.gateway.running,
      memoryKB: memKB,
      logFiles,
      token: MONITOR_TOKEN,
      transport: SOCKET_PATH ? "unix" : "tcp",
      socket_path: SOCKET_PATH || null,
      api_server_port: GATEWAY_PORT,
      api_server_url: `http://${getLANIP()}:${GATEWAY_PORT}`,
    }), { headers: jsonHeaders() });
  }

  // ── 应用包版本更新检查（前端契约：{ ok, local, latest|null, has_update: true|false|null, error? }）──
  // local 来自 config/bootstrap/app-version.env（回退 manifest），
  // latest 来自 GitHub Releases（update-fpk.js checkLatestVersion，失败时 latest=null + error 降级，绝不 500）
  // has_update 按 release published_at 与本机 APP_BUILD_TIME 判断（见 decideHasUpdate），null = 无法判断先后
  // force=1 时前端语义为强制刷新（跳过成功结果的 5 分钟缓存，重新查询 GitHub），每小时最多 5 次，
  // 超限时沿用上次成功结果并带 limited=true；force_* 与 last_* 字段供更新页展示配额和最后一次检测到的版本
  if (path === "/api/update/check") {
    const localBuild = readLocalAppBuild();
    const local = localBuild.version;
    let latest = null;
    let publishedAt = null;
    let error = null;
    let limited = false;
    try {
      const r = await appUpdateChecker.check({ force: url.searchParams.get("force") === "1" });
      limited = Boolean(r && r.limited);
      if (r && r.ok && r.latest) {
        latest = r.latest;
        publishedAt = r.published_at || null;
      } else if (r && !r.ok) {
        error = r.error || "fetch_failed";
      } else {
        error = "fetch_failed";
      }
    } catch (e) {
      error = e?.message || "fetch_failed";
    }
    const has_update = latest ? decideHasUpdate(localBuild, latest, publishedAt) : false;
    const quota = appUpdateChecker.forceQuota();
    const lastKnown = appUpdateChecker.getLastResult();
    const payload = { ok: true, local, latest, has_update, checked_at: Date.now(),
      local_build_time: localBuild.build_time || localBuild.build_date || null, latest_published_at: publishedAt,
      force_limit: quota.limit, force_remaining: quota.remaining, force_reset_at: quota.resetAt,
      last_latest: lastKnown && lastKnown.ok ? lastKnown.latest : null, last_checked_at: appUpdateChecker.getLastCheckedAt() };
    if (limited) payload.limited = true;
    if (error) payload.error = error;
    return new Response(JSON.stringify(payload), { headers: { ...jsonHeaders(), "Cache-Control": "no-store" } });
  }

  // ── 应用包更新检查（/api/app/update/check）────────────────────────────
  // 返回完整版本信息：当前版本、最新版本、更新可用性、下载链接、发布时间等
  if (path === "/api/app/update/check") {
    try {
      const GITHUB_REPO = process.env.GITHUB_REPO || "iranee/fnos-hermes-agent";
      const data = await checkLatestVersion(networkProxy, { credentials: githubCredentials });
      if (!data.ok) {
        return new Response(JSON.stringify({
          ...data,
          current: readLocalAppVersion(),
          latest: null,
          updateAvailable: null,
          repo: GITHUB_REPO
        }), { status: 502, headers: jsonHeaders() });
      }
      if (!data.tag_name) {
        throw new Error("GitHub API 未返回 release 信息");
      }

      const tag = String(data.tag_name || "");
      const latest = tag.replace(/^fnos-hermes-agent_v|^v/, "").trim() || "unknown";
      // current 与 /api/update/check 同源：app-version.env 优先、manifest 回退
      // （manifest 不部署到设备端，直接读 APP_VERSION 会得到 unknown 导致 updateAvailable 恒 false）
      const currentBuild = readLocalAppBuild();
      const current = currentBuild.version;
      const updateAvailable = decideHasUpdate(currentBuild, latest, data.published_at) === true;

      const download_url = pickFpkDownloadUrl(data.assets);

      // 仅在检测新版本或异常时打印日志
      if (updateAvailable && !lastUpdateCheckResult) {
        log(`[更新检查] 发现新版本：current=${current}, latest=${latest}`);
      } else if (!download_url) {
        log(`[更新检查] 警告：未找到 .fpk 安装包下载链接`);
      }
      lastUpdateCheckResult = updateAvailable;

      return new Response(JSON.stringify({
        current,
        latest,
        updateAvailable,
        html_url: data.html_url || "",
        download_url,
        published_at: data.published_at || "",
        body: data.body || "",
        repo: GITHUB_REPO
      }), { headers: jsonHeaders() });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message || String(e) }), {
        status: 502, headers: jsonHeaders()
      });
    }
  }

  // ── FPK 版本信息查询（手动下载模式）─────────────────────────────
  // GET  /api/app/update/latest → 只读：最新版本 + 下载链接（不触发任何安装）
  // 自动升级链路已移除：POST /api/app/update/auto、GET /api/app/update/status、
  // POST /api/app/install/manual 均返回 410 Gone，提示改为手动下载安装。

  // 查询最新版本（只读，含 GitHub release 页面与 FPK 资产下载直链）
  if (path === "/api/app/update/latest" && req.method === "GET") {
    try {
      const result = await checkLatestVersion(networkProxy, { credentials: githubCredentials });
      return new Response(JSON.stringify(result), {
        headers: { ...jsonHeaders(), "Cache-Control": "no-store" }
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e.message }), {
        status: 500, headers: { ...jsonHeaders() }
      });
    }
  }

  // 自动升级已移除：提示用户手动下载 FPK 并在 fnOS 应用中心安装
  if (path === "/api/app/update/auto" && req.method === "POST") {
    return new Response(JSON.stringify({
      ok: false,
      error: "应用内自动升级已移除。请通过 /api/app/update/latest 获取下载链接，手动下载 FPK 后在 fnOS 应用中心安装。",
      manual_download: true
    }), {
      status: 410, headers: { ...jsonHeaders() }
    });
  }

  // 升级状态轮询已随自动升级一并移除
  if (path === "/api/app/update/status" && req.method === "GET") {
    return new Response(JSON.stringify({
      status: "idle",
      upgrading: false,
      error: "自动升级已移除，无升级任务状态可查询",
      manual_download: true
    }), {
      status: 410, headers: { ...jsonHeaders() }
    });
  }

  // 手动上传安装占位接口一并停用（改为 fnOS 应用中心安装）
  if (path === "/api/app/install/manual" && req.method === "POST") {
    return new Response(JSON.stringify({
      error: "应用内安装已停用。请手动下载 FPK 后在 fnOS 应用中心安装。",
      manual_download: true
    }), {
      status: 410, headers: { ...jsonHeaders() }
    });
  }


  if (path === "/api/hermes/update/check") return kernelControl.handle(req);
  if (kernelControl.matches(path)) return kernelControl.handle(req);

  if (path === "/api/webapp/status" && req.method === "GET") {
    return Response.json({ ok: true, ...await webappRuntime.status(true) }, { headers: jsonHeaders() });
  }
  if (path === "/api/dashboard/status" && req.method === "GET") {
    return Response.json({ ok: true, ...await dashboardRuntime.status(true) }, { headers: jsonHeaders() });
  }
  if (path === "/api/webapp/launch" && req.method === "POST") {
    // 就绪后才签发标签页票据，启动期间由等待页继续轮询。
    const origin = browserOrigin(req);
    if (!origin) return Response.json({ ok: false, error: "Browser origin is required to open WebApp" }, { status: 400, headers: jsonHeaders() });
    if (keepAliveInFlight || gatewayStarting) return Response.json({ ok: false, starting: true }, { status: 503, headers: jsonHeaders() });
    const began = Date.now();
    try {
      const current = await webappRuntime.status(true);
      if (current.enabled === false) throw new WebappError("WebApp is disabled; enable it in the control panel", 409);
      if (current.error) throw new WebappError(current.error);
      if (!current.running || !current.healthy) return Response.json({ ok: false, starting: true }, { status: 503, headers: jsonHeaders() });
      const result = await webappRuntime.launch();
      log(`[webapp] 签发 WebApp 访问 Token 耗时 ${Date.now() - began}ms`);
      return Response.json({ ok: true, url: `${origin}${result.path}${result.hash}`, elapsed_ms: Date.now() - began }, { headers: jsonHeaders() });
    } catch (error) {
      return Response.json({ ok: false, error: error.message }, { status: error.status || 503, headers: jsonHeaders() });
    }
  }
  if (req.method === "POST" && ["/api/start", "/api/restart", "/api/gateway/start", "/api/gateway/stop",
    "/api/webapp/start", "/api/webapp/stop", "/api/webapp/open", "/api/dashboard/start", "/api/dashboard/stop", "/api/dashboard/open"].includes(path)) {
    try {
      // 入队前撤销自动开启，避免已排队的巡检抢在手动停止之前再次开启。
      // Gateway-only 操作不等同于开启 WebApp。显式操作失败也不由巡检重放。
      if (!path.startsWith("/api/dashboard/") && !shuttingDown && !kernelBusy()) webappAutoStartCancelled = true;
      const result = await manageServices(async () => {
        const origin = browserOrigin(req);
        if (path === "/api/gateway/stop") {
          await instanceControl("idle");
          gatewayDesired = false;
          await stopOwnedGateway();
          if (inspectGateway().state !== "gone") throw new WebappError("Gateway has not stopped", 409);
          return { ok: true };
        }
        if (path === "/api/gateway/start") {
          gatewayDesired = true;
          resetGatewayCrashLoop();
          await spawnHermes();
          return waitForGateway();
        }
        if (path === "/api/webapp/stop") return webappRuntime.stop();
        if (path === "/api/start" || path === "/api/webapp/start") {
          gatewayDesired = true;
          resetGatewayCrashLoop();
          const result = await webappRuntime.ensureRunning();
          if (result?.ok === true && result.webapp?.healthy === true) webappAutoStartPending = false;
          return result;
        }
        if (path === "/api/restart") return restartGateway();
        if (path === "/api/webapp/open") {
          if (!origin) throw new WebappError("Browser origin is required to open WebApp", 400);
          gatewayDesired = true;
          resetGatewayCrashLoop();
          const result = await webappRuntime.open();
          return { ok: true, url: `${origin}${result.path}${result.hash}` };
        }
        if (path === "/api/dashboard/start") return dashboardRuntime.start();
        if (path === "/api/dashboard/stop") return dashboardRuntime.stop();
        if (!origin) throw new WebappError("Browser origin is required to open Dashboard", 400);
        const result = await dashboardRuntime.open();
        return { ok: true, url: `${origin}${result.path}` };
      });
      return Response.json(result, { headers: jsonHeaders() });
    } catch (error) {
      return Response.json({ ok: false, error: error.message }, { status: error.status || 503, headers: jsonHeaders() });
    }
  }

  if (path === "/api/logs") {
    const offsetParam = url.searchParams.get("offset");
    const lastOffset = offsetParam !== null ? parseInt(offsetParam, 10) : -1;
    return new Response(createLogStream(req, isNaN(lastOffset) ? -1 : lastOffset), {
      headers: {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
        "Access-Control-Allow-Origin": corsOrigin,
      },
    });
  }

  if (path === "/api/logs/history") {
    let lines = [];
    let fileSize = 0;
    try {
      if (existsSync(LOG_FILE)) {
        fileSize = statSync(LOG_FILE).size;
        lines = readFileSync(LOG_FILE, "utf8").split("\n").filter(l => l.trim()).slice(-100);
      }
    } catch {}
    return new Response(JSON.stringify({ lines, fileSize }), { headers: jsonHeaders() });
  }

  // ─── 读取任意日志文件 ────────────────────────────────────────────────
  if (path === "/api/logs/read") {
    const file = url.searchParams.get("file") || "";
    const allowed = [
      "gateway.log","errors.log","agent.log","gui.log",
      "gateway-restart.log","gateway-shutdown-diag.log","gateway-exit-diag.log","monitor.log","info.log",
    ];
    if (!allowed.includes(file)) {
      return new Response(JSON.stringify({ error: "disallowed" }), { headers: jsonHeaders() });
    }
    // monitor.log（Monitor 自身日志）与 info.log（安装日志）在 VAR_DIR，其余为 Hermes 真实日志在 DATA_DIR/logs
    const fp = (file === "monitor.log" || file === "info.log") ? `${VAR_DIR}/${file}` : `${DATA_DIR}/logs/${file}`;
    // 前端可传 lines 指定返回末尾行数（50/100/200/500），未传或非法时兜底 200，上限 2000 防止过大响应
    let want = parseInt(url.searchParams.get("lines") || "", 10);
    if (!Number.isFinite(want) || want <= 0) want = 200;
    if (want > 2000) want = 2000;
    let lines = [], size = 0;
    try {
      if (existsSync(fp)) {
        size = statSync(fp).size;
        lines = readFileSync(fp, "utf8").split("\n").filter(l => l.trim()).slice(-want);
      }
    } catch {}
    return new Response(JSON.stringify({ lines, size }), { headers: jsonHeaders() });
  }

  // ─── 清空（截断）日志文件 ──────────────────────────────────────────────
  if (path === "/api/logs/clear" && req.method === "POST") {
    let body = {};
    try { body = await req.json(); } catch {}
    const file = body.file || "monitor.log";
    const allowed = [
      "gateway.log","errors.log","agent.log","gui.log",
      "gateway-restart.log","gateway-shutdown-diag.log","gateway-exit-diag.log","monitor.log","info.log",
    ];
    if (!allowed.includes(file)) {
      return new Response(JSON.stringify({ error: "disallowed" }), { headers: jsonHeaders() });
    }
    const fp = (file === "monitor.log" || file === "info.log") ? `${VAR_DIR}/${file}` : `${DATA_DIR}/logs/${file}`;
    try {
      if (existsSync(fp)) writeFileSync(fp, "");
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: jsonHeaders() });
    }
    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders() });
  }

  // ─── 频道 bot 配置路由 ─────────────────────────────────────────────────
  if (path === "/api/channels" && req.method === "GET") {
    return new Response(JSON.stringify(handleGetChannels()), { headers: jsonHeaders() });
  }
  const chToggleMatch = path.match(/^\/api\/channels\/([^/]+)\/toggle$/);
  if (chToggleMatch && req.method === "POST") {
    try {
      const body = await req.json();
      const res = handleToggleChannel(decodeURIComponent(chToggleMatch[1]), body);
      return new Response(JSON.stringify(res), { status: res.ok ? 200 : 400, headers: jsonHeaders() });
    } catch (e) { return new Response(JSON.stringify({ ok: false, error: e?.message || "bad request" }), { status: 400, headers: jsonHeaders() }); }
  }
  // 微信扫码保存：专用分支须先于通用 /api/channels/:id 保存分支匹配
  if (path === "/api/channels/weixin" && req.method === "POST") {
    try {
      const body = await req.json();
      const r = handleWeixinSave(body);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: jsonHeaders() });
    } catch (e) { return new Response(JSON.stringify({ ok: false, error: e?.message || "bad request" }), { status: 400, headers: jsonHeaders() }); }
  }
  const chMatch = path.match(/^\/api\/channels\/([^/]+)$/);
  if (chMatch && req.method === "POST") {
    try {
      const body = await req.json();
      const res = handleSaveChannel(decodeURIComponent(chMatch[1]), body);
      return new Response(JSON.stringify(res), { status: res.ok ? 200 : 400, headers: jsonHeaders() });
    } catch (e) { return new Response(JSON.stringify({ ok: false, error: e?.message || "bad request" }), { status: 400, headers: jsonHeaders() }); }
  }

  // ─── 频道扫码流程路由（微信 / Telegram / WhatsApp）───────────────
  if (path === "/api/channels/weixin/qr" && req.method === "GET") {
    const r = await handleWeixinQr();
    return new Response(JSON.stringify(r.body), { status: r.status, headers: jsonHeaders() });
  }
  if (path === "/api/channels/weixin/qr/status" && req.method === "GET") {
    const qrcode = url.searchParams.get("qrcode") || "";
    const r = await handleWeixinQrStatus(qrcode);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: jsonHeaders() });
  }
  if (path === "/api/channels/telegram/qr" && req.method === "GET") {
    const botName = url.searchParams.get("bot_name") || "";
    const r = await handleTelegramQr(botName, { signal: req.signal });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: jsonHeaders() });
  }
  if (path === "/api/channels/telegram/qr/status" && req.method === "GET") {
    const pairingId = url.searchParams.get("pairing_id") || "";
    const r = await handleTelegramQrStatus(pairingId, { signal: req.signal });
    return new Response(JSON.stringify(r.body), { status: r.status, headers: jsonHeaders() });
  }
  if (path === "/api/channels/telegram/qr/apply" && req.method === "POST") {
    try {
      const body = await req.json();
      const r = handleTelegramQrApply(body);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: jsonHeaders() });
    } catch (e) { return new Response(JSON.stringify({ ok: false, error: e?.message || "bad request" }), { status: 400, headers: jsonHeaders() }); }
  }
  if (path === "/api/channels/whatsapp/qr" && req.method === "GET") {
    const mode = url.searchParams.get("mode") || "self-chat";
    const r = await handleWhatsAppQr(mode);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: jsonHeaders() });
  }
  if (path === "/api/channels/whatsapp/qr/status" && req.method === "GET") {
    const pairingId = url.searchParams.get("pairing_id") || "";
    const r = handleWhatsAppQrStatus(pairingId);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: jsonHeaders() });
  }
  if (path === "/api/channels/whatsapp/qr/apply" && req.method === "POST") {
    try {
      const body = await req.json();
      const r = handleWhatsAppQrApply(body);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: jsonHeaders() });
    } catch (e) { return new Response(JSON.stringify({ ok: false, error: e?.message || "bad request" }), { status: 400, headers: jsonHeaders() }); }
  }
  if (path === "/api/channels/qqbot/qr" && req.method === "GET") {
    const r = await handleQqbotQr();
    return new Response(JSON.stringify(r.body), { status: r.status, headers: jsonHeaders() });
  }
  if (path === "/api/channels/qqbot/qr/status" && req.method === "GET") {
    const taskId = url.searchParams.get("task_id") || "";
    const r = await handleQqbotQrStatus(taskId);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: jsonHeaders() });
  }
  if (path === "/api/channels/qqbot/qr/apply" && req.method === "POST") {
    try {
      const body = await req.json();
      const r = handleQqbotQrApply(body);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: jsonHeaders() });
    } catch (e) { return new Response(JSON.stringify({ ok: false, error: e?.message || "bad request" }), { status: 400, headers: jsonHeaders() }); }
  }
  if (path === "/api/channels/wecom/qr" && req.method === "GET") {
    const r = await handleWecomQr();
    return new Response(JSON.stringify(r.body), { status: r.status, headers: jsonHeaders() });
  }
  if (path === "/api/channels/wecom/qr/status" && req.method === "GET") {
    const scode = url.searchParams.get("scode") || "";
    const r = await handleWecomQrStatus(scode);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: jsonHeaders() });
  }
  if (path === "/api/channels/wecom/qr/apply" && req.method === "POST") {
    try {
      const body = await req.json();
      const r = handleWecomQrApply(body);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: jsonHeaders() });
    } catch (e) { return new Response(JSON.stringify({ ok: false, error: e?.message || "bad request" }), { status: 400, headers: jsonHeaders() }); }
  }

  // ─── 模型配置：真实快照与精确补丁，不读取旧同步源 ─────────────────────
  if (path === "/api/config") {
    return Response.json({ ok: false, error: "旧模型同步接口已停用，请使用 /api/model-config 的 GET/PATCH" },
      { status: 410, headers: jsonHeaders() });
  }
  if (path === "/api/model-config" && ["GET", "PATCH"].includes(req.method)) {
    let phase = "read";
    try {
      if (req.method === "GET") return Response.json(readModelConfiguration(), { headers: jsonHeaders() });
      phase = "validate";
      const body = await req.json();
      phase = "maintenance";
      const result = await manageServices(() => patchModelConfiguration(body));
      return Response.json(result, { headers: jsonHeaders() });
    } catch (error) {
      return Response.json({ ok: false, error: error.message, phase: error.phase || phase,
        committed: error.committed || [], configWriteUncertain: error.configWriteUncertain || false,
        envWriteUncertain: error.envWriteUncertain || false,
      }, { status: error.status || (phase === "validate" ? 400 : 500), headers: jsonHeaders() });
    }
  }

  // 只有显式测试才访问上游，source/id 必须从当前快照还原，空凭证不回填。
  if (path === "/api/config/test" && req.method === "POST") {
    try {
      const body = await req.json();
      if (!body || typeof body !== "object" || !body.provider || typeof body.provider !== "object" || Array.isArray(body.provider)) {
        throw Object.assign(new Error("provider object is required"), { status: 400 });
      }
      const provider = resolveModelTestProvider(body.provider);
      const result = await fetchGatewayModels(provider, UPSTREAM_UA);
      return Response.json(result, { status: result.ok ? 200 : 502, headers: jsonHeaders() });
    } catch (error) {
      return Response.json({ ok: false, source: "remote", models: [], error: error.message },
        { status: error.status || (error instanceof SyntaxError ? 400 : 500), headers: jsonHeaders() });
    }
  }
  if (path === "/api/config/detect-format" && req.method === "POST") {
    try {
      const provider = resolveModelTestProvider(await req.json());
      return Response.json(await probeApiFormat(provider.base_url, provider.api_key), { headers: jsonHeaders() });
    } catch (error) {
      return Response.json({ ok: false, error: error.message }, { status: error.status || 400, headers: jsonHeaders() });
    }
  }
  // 兼容显式远程查询，模型配置 GET 本身不触发网络发现。
  if (path === "/api/models" && req.method === "GET") {
    try {
      const result = await fetchGatewayModels(resolveModelTestProvider(), UPSTREAM_UA);
      return Response.json(result, { status: result.ok ? 200 : 502, headers: jsonHeaders() });
    } catch (error) {
      return Response.json({ ok: false, source: "remote", models: [], error: error.message },
        { status: error.status || 500, headers: jsonHeaders() });
    }
  }

  // 静态 UI — 根路径返回 index.html（来自 ${APP_DIR}/ui）
  if (path === "/") {
    return serveFile(`${STATIC_DIR}/index.html`, "text/html; charset=utf-8");
  }

  // /images/、/css/、/js/、/scripts/ 等简单静态资源（来自 ${APP_DIR}/ui）
  if (path.startsWith("/images/") || path.startsWith("/css/") || 
      path.startsWith("/js/") || path.startsWith("/scripts/")) {
    const relPath = path.slice(1);
    if (relPath.includes("..")) return new Response("Forbidden", { status: 403 });
    const fp  = `${STATIC_DIR}/${relPath}`;
    const ext = fp.split(".").pop()?.toLowerCase();
    const ct  = ext === "js"  ? "application/javascript"
              : ext === "css" ? "text/css"
              : ext === "png" ? "image/png"
              : ext === "svg" ? "image/svg+xml"
              : "text/plain";
    return serveFile(fp, ct);
  }

  return new Response("Not Found", { status: 404 });
}

// ─── SIGTERM / SIGINT：优雅关闭 ─────────────────────────────────────
async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = Date.now() + 28000;
  const timer = setTimeout(() => {
    log("[shutdown] 28s deadline reached; leaving unverified processes untouched");
    process.exit(1);
  }, 28000);
  try {
    webappProxy.close();
    dashboardProxy.close();
    const jobCleanup = await Promise.allSettled([kernelUpdateJob.shutdown(), kernelControlSocket.close()]);
    jobCleanup.push(...await Promise.allSettled([githubCredentials.close()]));
    const stopped = await Promise.allSettled([
      (async () => {
        if (gatewayStarting) await gatewayStarting.catch(error => log(`[shutdown] Startup failed: ${error.message}`));
        await stopOwnedGateway(Math.max(0, deadline - Date.now()));
      })(),
      dashboardRuntime.shutdown(Math.max(0, deadline - Date.now())),
    ]);
    const failures = [...jobCleanup, ...stopped].filter(result => result.status === "rejected");
    if (failures.length) throw new Error(failures.map(result => result.reason.message).join("; "));
    log("Shutdown complete");
    clearTimeout(timer);
    process.exit(0);
  } catch (error) {
    log(`[shutdown] Service cleanup failed: ${error.message}`);
    clearTimeout(timer);
    process.exit(1);
  }
}
process.on("SIGTERM", () => gracefulShutdown());
process.on("SIGINT",  () => gracefulShutdown());

// ─── 崩溃保护：记录错误而非退出 ─────────────────────────
process.on("uncaughtException", (err) => {
  log(`[FATAL] uncaughtException: ${err?.message || err}\n${err?.stack || ""}`);
  if (err?.code === "EADDRINUSE") {
    // 真正的竞态：两个实例几乎同时通过了上面的存活检测。此时不能继续
    // 假装"Monitor ready"，否则会得到一个端口/socket 都没绑定成功、
    // 但进程仍在运行的僵尸实例，外部很难察觉。直接退出，交给外部的
    // 重启策略处理。
    log(`[FATAL] socket 绑定冲突，退出进程`);
    process.exit(1);
  }
});
process.on("unhandledRejection", (err) => {
  log(`[FATAL] unhandledRejection: ${err?.message || err}\n${err?.stack || ""}`);
});

function redirectTo(location) {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}
function isDocumentRequest(req) {
  if (req.method !== "GET" || req.headers.get("upgrade")) return false;
  const dest = req.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  return /text\/html/i.test(req.headers.get("accept") || "");
}
function startingPage(kind, failure = "") {
  const label = kind === "webapp" ? "WebApp" : "Dashboard";
  // WebApp：页面自己签发一次性票据，标签页立即渲染，不用等 302。
  const config = JSON.stringify({ label, status: `${BASE_PATH}/api/${kind}/status`, panel: `${BASE_PATH}/`, failure,
    launch: kind === "webapp" ? `${BASE_PATH}/api/webapp/launch` : "", token: kind === "webapp" ? MONITOR_TOKEN : "" });
  const heading = kind === "webapp" && !failure ? "正在进入 WebApp…" : `正在启动 ${label}…`;
  const lead = kind === "webapp" && !failure ? "正在获取入口凭证…" : "首次启动约需 10～60 秒，就绪后自动进入。";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f4f5f7;color:#1f2328}
@media(prefers-color-scheme:dark){body{background:#0f1115;color:#e6e6e6}.box{background:#171a21!important;border-color:#2a2f3a!important}.muted{color:#9aa4b2!important}.btn{background:#222733!important;color:#e6e6e6!important;border-color:#3a4150!important}}
.box{width:min(420px,calc(100vw - 32px));box-sizing:border-box;padding:28px 28px 22px;background:#fff;border:1px solid #e3e6ea;border-radius:12px;text-align:center}
.spin{width:34px;height:34px;margin:0 auto 16px;border:3px solid rgba(127,127,127,.25);border-top-color:#2f81f7;border-radius:50%;animation:r .9s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
h1{font-size:16px;margin:0 0 6px;font-weight:600}
.muted{color:#656d76;font-size:13px;min-height:1.6em;overflow-wrap:anywhere}
.err{color:#d1242f;font-size:13px;margin-top:10px;white-space:pre-wrap;overflow-wrap:anywhere}
.err:empty,.acts:empty{display:none}
.acts{margin-top:16px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.btn{display:inline-block;padding:6px 14px;border-radius:7px;border:1px solid #d0d7de;background:#f6f8fa;color:#1f2328;text-decoration:none;font-size:13px;cursor:pointer}
</style></head><body><div class="box">
<div class="spin" id="spin"></div><h1 id="title">${heading}</h1>
<div class="muted" id="hint">${lead}</div>
<div class="err" id="err"></div><div class="acts" id="acts"></div></div>
<script>
(function(){
  var cfg=${config};
  var zh=[['Official WebApp assets are missing','WebApp 资源缺失或过期，请通过应用中心覆盖安装完整应用包'],['Official Dashboard assets are missing','Dashboard 资源缺失，请通过应用中心覆盖安装完整应用包'],['Gateway crash loop','Gateway 短时间内多次异常退出，稍后会自动重试'],['Dashboard is starting','Dashboard 正在启动'],['Dashboard did not become ready','Dashboard 启动超时，请查看 dashboard.log'],['Dashboard exited during startup','Dashboard 启动过程中退出，请查看 dashboard.log'],['Gateway did not apply WebApp settings','Gateway 未在规定时间内就绪，请查看 Gateway 日志'],['Gateway failed to start','Gateway 启动失败，请查看日志'],['WebApp is unavailable','WebApp 暂不可用'],['WebApp is disabled','WebApp 未开启，请在控制面板的设置中开启 WebApp 功能'],['Existing config.yaml is unreadable or invalid','原配置无法读取或格式有误，文件已保留，请查看控制面板日志'],['WebApp is still starting','WebApp 仍在启动中，请稍后重试'],['WebApp still demands a separate sign-in','WebApp 仍要求单独登录，请在控制面板重启 Gateway 后重试'],['Gateway returned','Gateway 返回了无效的 WebApp 入口链接，请重启 Gateway 后重试'],['Monitor is shutting down','面板正在关闭']];
  function t(m){m=String(m||'');for(var i=0;i<zh.length;i++)if(m.indexOf(zh[i][0])===0)return zh[i][1];return /[\\u4e00-\\u9fff]/.test(m)?m:(cfg.label+' 启动失败，详情见控制面板日志。');}
  var hint=document.getElementById('hint'),err=document.getElementById('err'),acts=document.getElementById('acts'),title=document.getElementById('title'),spin=document.getElementById('spin');
  var started=Date.now(),lastError='',fails=0;
  function finish(message){
    spin.style.display='none';title.textContent=cfg.label+' 未能启动';hint.textContent='';err.textContent=message;
    acts.innerHTML='<a class="btn" href="javascript:location.reload()">重试</a><a class="btn" href="'+cfg.panel+'">返回控制面板</a>';
  }
  if(cfg.failure){finish(t(cfg.failure));return;}
  var fatal=/assets are missing|crash loop|requires Linux/;
  function enter(){
    var t0=performance.now();
    fetch(cfg.launch,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'accept':'application/json','x-monitor-token':cfg.token}}).then(function(r){
      if(r.status===403){finish('需要 fnOS 管理员身份，请重新登录 fnOS 后重试。');return null;}
      return r.json().catch(function(){throw new Error('HTTP '+r.status);});
    }).then(function(j){
      if(!j)return;fails=0;
      if(j.ok&&j.url){title.textContent='WebApp 已就绪，正在进入…';hint.textContent='入口凭证签发耗时 '+Math.round(performance.now()-t0)+' ms';location.replace(j.url);return;}
      if(j.starting){
        lastError=j.error||'';title.textContent='正在启动 WebApp…';hint.textContent='首次启动约需 10～60 秒，就绪后自动进入。';
        if(lastError&&fatal.test(lastError)){finish(t(lastError));return;}
        setTimeout(tick,1500);return;
      }
      finish(t(j.error));
    }).catch(function(){
      if(++fails>=8){finish('无法联系控制面板，请回到控制面板查看日志。');return;}
      setTimeout(enter,2000);
    });
  }
  function tick(){
    fetch(cfg.status,{credentials:'same-origin',cache:'no-store',headers:{'accept':'application/json'}}).then(function(r){
      if(r.status===403){finish('需要 fnOS 管理员身份，请重新登录 fnOS 后重试。');return null;}
      if(!r.ok)throw new Error('HTTP '+r.status);return r.json();
    }).then(function(s){
      if(!s)return;fails=0;
      if(s.healthy===true){
        if(cfg.launch){enter();return;}
        title.textContent=cfg.label+' 已就绪，正在进入…';location.reload();return;
      }
      lastError=s.error||'';
      hint.textContent=s.running?(cfg.label+' 进程已启动，等待就绪…'):('正在拉起 '+cfg.label+'…');
      if(lastError&&fatal.test(lastError)){finish(t(lastError));return;}
      if(Date.now()-started>120000){finish(t(lastError)||(cfg.label+' 启动超时，请回到控制面板查看日志。'));return;}
      setTimeout(tick,1500);
    }).catch(function(){
      if(++fails>=8){finish('无法读取服务状态，请回到控制面板查看日志。');return;}
      setTimeout(tick,2000);
    });
  }
  if(cfg.launch)enter();else tick();
})();
</script></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// ─── 服务处理器导出（socket 绑定、chmod 与单实例检查已移交 boot.js）──────
// boot.js 独占 unix socket 与 serve()，并在其 fetch(req, server) 中调用本函数，
// 官方 WebApp 与 Dashboard 使用独立同源子路径。
export async function handleServe(req, server) {
  const url = new URL(req.url);
  if (BASE_PATH && url.pathname !== BASE_PATH && !url.pathname.startsWith(`${BASE_PATH}/`)) return new Response("Not Found", { status: 404 });
  if (!isFnosAdmin(req)) return panelDenied("PANEL_ADMIN", "需要 fnOS 管理员身份，请重新登录");
  if (shuttingDown) return new Response("Monitor is shutting down", { status: 503 });
  const localPath = (url.pathname.slice(BASE_PATH.length) || "/").replace(/\/+$/, "") || "/";
  // WebApp 后端面板不能检查或执行更新，避免绕过管理面板消耗 GitHub API；状态与回执仍可读。
  if (localPath === "/webapp/api/hermes/update" || localPath === "/webapp/api/hermes/update/check") {
    return Response.json({ ok: false, pid: null, name: "hermes-update", error: "webapp-update-disabled",
      message: "WebApp 中的后端更新已停用，请在管理面板「更新」页面检查和升级 Hermes。", update_command: "" },
    { status: 403, headers: { "cache-control": "no-store" } });
  }
  if (kernelNativeApi.matches(localPath)) return kernelNativeApi.handle(req, localPath);
  const controlRequest = kernelControl.matches(localPath) && !["/api/hermes/update/check", "/api/hermes/update/channel"].includes(localPath);
  const networkRequest = networkControl.matches(localPath);
  const dynamic = /^\/(api|webapp|dashboard|open)(\/|$)/.test(localPath);
  if (dynamic && !controlRequest && !networkRequest && kernelBusy()) {
    return Response.json({ ok: false, error: kernelGateError || "内核维护中，请在更新页面查看进度" }, { status: 503,
      headers: { "cache-control": "no-store", "retry-after": "3" } });
  }
  if (!dynamic || controlRequest || networkRequest) return dispatchServe(req, server);
  const pending = dispatchServe(req, server);
  kernelRequests.add(pending);
  try { return await pending; } finally { kernelRequests.delete(pending); }
}

async function dispatchServe(req, server) {
  const url = new URL(req.url);
  const openMatch = url.pathname === `${BASE_PATH}/open/webapp` || url.pathname === `${BASE_PATH}/open/dashboard`;
  if (openMatch) {
    if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
    const kind = url.pathname.endsWith("/webapp") ? "webapp" : "dashboard";
    // 两个入口都不先探测 Python 就直接响应，新标签页不会空白：
    // WebApp 页面自己签发一次性票据（每个标签页都要新的，所以按钮不能直接链到 /webapp/），
    // Dashboard 代理则按需自行启动服务。
    if (kind === "webapp") return startingPage("webapp");
    return redirectTo(`${BASE_PATH}/dashboard/sessions`);
  }
  if (webappProxy.matches(url.pathname)) {
    const status = await webappRuntime.status();
    if (!status.healthy && isDocumentRequest(req)) {
      return redirectTo(`${BASE_PATH}/open/webapp`);
    }
    return req.headers.get("upgrade")?.toLowerCase() === "websocket"
      ? webappProxy.upgrade(req, server) : webappProxy.handleHttp(req);
  }
  if (dashboardProxy.matches(url.pathname)) {
    try {
      const status = await dashboardRuntime.status();
      const current = dashboardProcess.inspect();
      if (!status.healthy || current.state !== "owned" || current.identity.pid !== status.pid) {
        if (isDocumentRequest(req)) {
          manageServices(() => dashboardRuntime.open()).catch(error => log(`[dashboard] 启动失败: ${error.message}`));
          return startingPage("dashboard");
        }
        return new Response("Start the official Dashboard from the control panel first", { status: 503 });
      }
      return req.headers.get("upgrade")?.toLowerCase() === "websocket"
        ? dashboardProxy.upgrade(req, server) : dashboardProxy.handleHttp(req);
    } catch (error) {
      return Response.json({ ok: false, error: error.message }, { status: error.status || 503 });
    }
  }
  const wsPath = url.pathname.slice(BASE_PATH.length) || "/";
  if (wsPath.startsWith("/api/chat") || wsPath.startsWith("/proxy/dashboard")
      || wsPath.startsWith("/api/hermes/rebuild-web")) {
    return Response.json({ ok: false, error: "旧聊天和在线核心构建入口已停用；请使用官方 WebApp 或 Dashboard，核心与前端由匹配的应用包一起升级。" }, { status: 410 });
  }
  return handleFetch(req);
}

export const websocket = {
  ...webappProxy.websocket,
  message(ws, message) {
    if (kernelBusy()) { ws.close(1012, "Kernel maintenance"); return; }
    webappProxy.websocket.message(ws, message);
  },
};