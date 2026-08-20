// Hermes Agent 监控服务 — Node.js HTTP 服务（Unix Socket）
// serve() 的调用已移交 boot.js，本模块仅导出 handleServe/websocket 处理器，故不再引入 serve。
import { file, spawn } from "./node-adapter.js";
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, statSync, symlinkSync, watch, chmodSync, readdirSync, rmSync } from "fs";
import { randomBytes } from "crypto";
import { networkInterfaces } from "os";
import net from "net";
import { spawnSync, spawn as spawnAsync } from "child_process";
import { PROVIDER_PRESETS, PROVIDER_MODELS, PROVIDER_API_KEYS, PROVIDER_CLASSES, PROVIDER_HERMES_IDS } from "./primary-config.js";
import { createCheckpointer, resumeStreamingMessages } from "./primary-config.js";
import { initChannels, handleGetChannels, handleSaveChannel, handleToggleChannel, handleWeixinQr, handleWeixinQrStatus, handleWeixinSave, handleTelegramQr, handleTelegramQrStatus, handleTelegramQrApply, handleWhatsAppQr, handleWhatsAppQrStatus, handleWhatsAppQrApply } from "./channels.js";
import { toolDisplayName, toolEmoji } from "./primary-config.js";
import { parseFallback, buildFallbackBlock, applyFallbackToYaml, syncFallbackKeysToHermesEnv } from "./primary-config.js";
import { detectApiFormat, probeApiFormat, apiModeForFormat, normalizeApiFormat } from "./primary-config.js";
import { initDashboard, DEFAULT_DASHBOARD_PORT, ALTERNATE_DASHBOARD_PORT, spawnDashboard, handleDashboardStart, handleDashboardStop, checkDashboardHealth, handleDashboardHttp, matchDashboardWsPath, upgradeDashboardWs, handleDashboardWsOpen, handleDashboardWsMessage, handleDashboardWsClose } from "./dashboard.js";
import { initPrimaryConfig, resolveRealApiKey, loadProvidersState, writeProvidersState, writeConfigYaml, saveProviderKeysToEnv, syncActiveKeyToHermesEnv, cleanupRemovedProviderKeys, resolveBridgePrimary } from "./primary-config.js";
import { createBridgeKeeper } from "./bridge-keeper.js";
// 应用包版本信息查询（整合自 update-check.js 和 update-fpk.js；自动升级链路已移除，仅保留只读查询）
import { checkLatestVersion, createUpdateChecker } from "./update-fpk.js";
import { compareVersions } from "./update-fpk.js";
import { fileURLToPath } from "url";
import pathModule, { dirname, join } from "path";

// 动态检测当前运行路径 - 完全不使用硬编码的盘符或路径
const ENV_APP_DIR   = process.env.APP_DIR;
const ENV_DATA_DIR  = process.env.DATA_DIR;
const ENV_VAR_DIR   = process.env.VAR_DIR;

// ESM: import.meta.url → __dirname
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

console.log(`[初始化] APP_DIR=${APP_DIR}`);

// 从 manifest 动态读取应用版本号（基于包升级模式），支持多层 fallback
function readAppVersion() {
  const MANIFEST_FILE = `${APP_DIR}/manifest`;  // APP_DIR 此时已确定
  const candidates = [
    MANIFEST_FILE,                            // Priority 1: main manifest (package-based)
    "/var/apps/hermes-agent/manifest",        // Priority 2: system path
    `${process.cwd()}/manifest`,              // Priority 3: cwd
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

function reloadAppVersion() {
  APP_VERSION = readAppVersion();
  log(`[版本重载] manifest 重新读取：${APP_VERSION}`);
  return APP_VERSION;
}

// 读取本地应用包版本（/api/update/check 契约的 local 字段来源）：
// 优先部署态 config/bootstrap/app-version.env（APP_VERSION=...，兼容带引号写法），
// 回退 APP_VERSION（manifest 读取，见 readAppVersion）。合回自原 update-check.js 的 getLocalVersion 逻辑。
function readLocalAppVersion() {
  const envPaths = [
    `${APP_DIR}/config/bootstrap/app-version.env`,
    `${process.cwd()}/config/bootstrap/app-version.env`,
  ];
  for (const fp of envPaths) {
    try {
      const m = readFileSync(fp, "utf8").match(/^APP_VERSION\s*=\s*(.+)$/m);
      if (m) {
        const v = m[1].trim().replace(/^["']|["']$/g, "");
        if (v && v !== "unknown") return v;
      }
    } catch {}
  }
  return APP_VERSION || "unknown";
}


const DATA_DIR = ENV_DATA_DIR || `${APP_DIR}/data`;
const VAR_DIR = ENV_VAR_DIR || `${APP_DIR}/var`;
const LOG_FILE       = `${VAR_DIR}/monitor.log`; // Monitor 自身日志（原 hermes.log，更名以便理解）
const PID_GATEWAY    = `${VAR_DIR}/gateway.pid`;
const PID_DASHBOARD  = `${VAR_DIR}/dashboard.pid`;
const TOKEN_FILE     = `${VAR_DIR}/monitor.token`;
const VERSION_FILE   = `${VAR_DIR}/hermes_version.txt`;
const START_TIME     = Date.now();
const CONFIG_VERSION = "1.0";

// 仪表盘会话令牌（与仪表盘共享，代理转发时免 401 鉴权）
const DASHBOARD_TOKEN_FILE = `${VAR_DIR}/dashboard.token`;
const DASHBOARD_SESSION_TOKEN = (() => {
    try {
        if (existsSync(DASHBOARD_TOKEN_FILE)) return readFileSync(DASHBOARD_TOKEN_FILE, "utf8").trim();
    } catch {}
    const t = crypto.randomUUID(); // 或 randomBytes(24).toString("hex")
    writeFileSync(DASHBOARD_TOKEN_FILE, t, { mode: 0o600 });
    return t;
})();

// ── Hermes 自更新状态 ──
let updateState = "idle";       // idle | checking | updating | done | error
let updateOutput = [];           // 最近的 stdout/stderr 输出行
let updateExitCode = null;
let updateProc = null;

// ── Web 前端重建状态 ──
let rebuildWebState = "idle";
let rebuildWebOutput = [];
let rebuildWebExitCode = null;
let rebuildWebProc = null;
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

// ─── 端口配置（优先使用环境变量，如有冲突则切换到备选端口）─────────────
// Dashboard 端口候选常量由 dashboard.js 提供（顶部 import）；下面的
// gateway/dashboard 联合端口决策属两进程共用逻辑，保留在 monitor.js
const DEFAULT_GATEWAY_PORT   = 8642;
const ALTERNATE_GATEWAY_PORT = 28642;

let GATEWAY_PORT   = Number(process.env.GATEWAY_PORT);
let DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT);

// 只有当环境变量未设置时，才在 monitor.js 中进行兜底检测
if (!GATEWAY_PORT && !DASHBOARD_PORT) {
  // 两个端口都未设置，尝试使用默认组合
  const gwUsed = isPortListening(DEFAULT_GATEWAY_PORT);
  const dbUsed = isPortListening(DEFAULT_DASHBOARD_PORT);
  if (gwUsed || dbUsed) {
    GATEWAY_PORT   = ALTERNATE_GATEWAY_PORT;
    DASHBOARD_PORT = ALTERNATE_DASHBOARD_PORT;
    console.log(`[端口检测] 默认端口 ${DEFAULT_GATEWAY_PORT}/${DEFAULT_DASHBOARD_PORT} 被占用，切换至 ${ALTERNATE_GATEWAY_PORT}/${ALTERNATE_DASHBOARD_PORT}`);
  } else {
    GATEWAY_PORT   = DEFAULT_GATEWAY_PORT;
    DASHBOARD_PORT = DEFAULT_DASHBOARD_PORT;
  }
} else if (!GATEWAY_PORT) {
  // 只有 Gateway 端口未设置，检查默认值是否可用（兜底情况）
  if (isPortListening(DEFAULT_GATEWAY_PORT)) {
    GATEWAY_PORT = ALTERNATE_GATEWAY_PORT;
    console.log(`[端口检测] Gateway 端口 ${DEFAULT_GATEWAY_PORT} 被占用，切换至 ${ALTERNATE_GATEWAY_PORT}`);
  } else {
    GATEWAY_PORT = DEFAULT_GATEWAY_PORT;
  }
} else if (!DASHBOARD_PORT) {
  // 只有 Dashboard 端口未设置，检查默认值是否可用（兜底情况）
  if (isPortListening(DEFAULT_DASHBOARD_PORT)) {
    DASHBOARD_PORT = ALTERNATE_DASHBOARD_PORT;
    console.log(`[端口检测] Dashboard 端口 ${DEFAULT_DASHBOARD_PORT} 被占用，切换至 ${ALTERNATE_DASHBOARD_PORT}`);
  } else {
    DASHBOARD_PORT = DEFAULT_DASHBOARD_PORT;
  }
}

const SOCKET_PATH    = (process.env.MONITOR_SOCKET_PATH || "").trim();
if (!SOCKET_PATH) {
  console.error("[FATAL] MONITOR_SOCKET_PATH is required — unix socket mode only");
  process.exit(1);
}
const BASE_PATH      = (process.env.BASE_PATH || "").replace(/\/+$/, "");
const STATIC_DIR     = `${APP_DIR}/ui`; // 仅用于控制面板 index.html 等简单静态文件
const VENV_BIN       = `${DATA_DIR}/venv/bin`;
const HERMES_BIN     = `${VENV_BIN}/hermes`;
const UV_BIN_PATH    = `${VENV_BIN}/uv`;

// ─── Node.js 运行时探测（hermes TUI 需要 node；版本在安装期由 install_callback 固定） ───

// data 优先：install_callback 的 ensure_node 会把最佳来源（飞牛 Node.js 应用 / 在线
// 下载）materialize 成 data/node 完整发行版并 chown 给 app 用户（最大权限、可自管）。
// 故 data/node 为权威运行时；app/runtime/node（若未来随包内置）仅作 data 缺失时的兜底。
const NODE_CANDIDATES = [
  `${DATA_DIR}/node/bin/node`,                   // ① data 权威运行时（最大权限，与 python venv 对齐）
  `${APP_DIR}/runtime/node/bin/node`,            // ② 打包内置兜底（若未来随包分发）
];
const resolvedNodeBin = NODE_CANDIDATES.find(p => {
  try { return existsSync(p) && (statSync(p).mode & 0o111) !== 0; } catch { return false; }
}) || null;
const resolvedNodeDir = resolvedNodeBin ? resolvedNodeBin.replace(/\/[^/]+$/, "") : null;

// ─── HERMES_TUI_DIR：TUI 运行时 shim 目录 ──────────────────────────────
const TUI_DIR = `${DATA_DIR}/tui`;

// ─── 聊天数据路径（统一在 workspace 目录下） ────────────────
const CHAT_DIR      = `${VAR_DIR}/chat`;
const CONFIG_FILE   = `${CHAT_DIR}/config.json`;
const SESSIONS_DIR  = `${CHAT_DIR}/sessions`;
const WORKSPACE_DIR = `${DATA_DIR}/workspace`;
const TMP_DIR       = `${WORKSPACE_DIR}/tmp`;
const UPLOAD_DIR    = `${WORKSPACE_DIR}/uploads`;
const UPLOAD_IMG_DIR = `${WORKSPACE_DIR}/images`;
const UPLOAD_FILE_DIR = `${WORKSPACE_DIR}/files`;
const GATEWAY_API   = `http://localhost:${GATEWAY_PORT}/v1`;
// 向上游发请求时统一使用的浏览器风格 UA，避免 Cloudflare 类网关因缺少 User-Agent 掐断连接
const UPSTREAM_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ─── Dashboard 模块接入：注入解析后的端口/路径与共用基础设施 ─────────────
// log/readPid/stopPid/spawnHermes/findGatewayPid/isPortListening/portAlive
// 均为本文件的函数声明（作用域提升可见），此处仅传引用，实际调用发生在请求期
initDashboard({
  port: DASHBOARD_PORT,
  gatewayPort: GATEWAY_PORT,
  basePath: BASE_PATH,
  pidFile: PID_DASHBOARD,
  log,
  readPid,
  stopPid,
  spawnHermes,
  findGatewayPid,
  isPortListening,
  portAlive,
  dashboardSessionToken: DASHBOARD_SESSION_TOKEN,
});

// APP_DIR 现已确定，可以安全读取 manifest 版本
APP_VERSION = readAppVersion();
log(`[启动检测] 应用包版本 (manifest): ${APP_VERSION}`);

// ─── API Key 自动生成（12位随机字母数字）─────────────────────────────────────
function generateApiKey() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(12);
  let key = "";
  for (let i = 0; i < 12; i++) key += chars[bytes[i] % chars.length];
  return key;
}

mkdirSync(VAR_DIR, { recursive: true });
initChatData();

// ─── TUI shim 初始化：确保 TUI_DIR/dist/entry.js 可用 ──────────────────
try {
  mkdirSync(`${TUI_DIR}/dist`, { recursive: true });
  const tuiEntry = `${TUI_DIR}/dist/entry.js`;
  if (!existsSync(tuiEntry)) {
    // 动态探测 hermes_cli 的 tui_dist/entry.js（不硬编码 python 版本）；
    // 限 10 秒：此处在服务监听前同步执行，子进程挂起会无限期推迟服务启动
    const pyResult = spawnSync(
      `${VENV_BIN}/python3`,
      ["-c", "import hermes_cli,os;print(os.path.dirname(hermes_cli.__file__))"],
      { stdout: "pipe", stderr: "pipe", timeout: 10000, killSignal: "SIGKILL" }
    );
    const hermesCli = pyResult.stdout?.toString().trim();
    if (hermesCli && existsSync(`${hermesCli}/tui_dist/entry.js`)) {
      try { unlinkSync(tuiEntry); } catch {}
      symlinkSync(`${hermesCli}/tui_dist/entry.js`, tuiEntry);
      console.log(`[monitor] tui symlink: ${tuiEntry} -> ${hermesCli}/tui_dist/entry.js`);
    } else {
      console.log("[monitor] WARNING: hermes_cli/tui_dist/entry.js not found, TUI may rely on bundled fallback");
    }
  }
} catch (e) {
  console.log(`[monitor] WARNING: TUI shim init failed (${e.message}), non-fatal`);
}

// ─── 启动清理：杀掉残留进程、清除旧 PID、重置日志 ─────────
function readPidSync(path) {
  try { return Number(readFileSync(path, "utf8").trim()); } catch { return null; }
}
function pidAliveSync(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
try {
  // 限 10 秒：启动清理在服务监听前同步执行，不允许无限期阻塞
  spawnSync("pkill", ["-SIGKILL", "-f", "hermes-agent.*(gateway|dashboard)"], { timeout: 10000, killSignal: "SIGKILL" });
} catch (e) {
  log(`[启动清理] pkill 执行失败: ${e.message}`);
}
for (const pidFile of [PID_GATEWAY, PID_DASHBOARD]) {
  const oldPid = readPidSync(pidFile);
  if (oldPid && pidAliveSync(oldPid)) {
    try { process.kill(oldPid, "TERM"); } catch {}
  }
  try { unlinkSync(pidFile); } catch {}
}
try { writeFileSync(LOG_FILE, ""); } catch {}


// 异步执行外部命令并带超时强杀：版本探测一类的子进程调用统一走此函数。
// 同步 spawnSync 会冻结整个事件循环，若子进程挂起（NAS 上 hermes CLI 冷启动或异常时可达分钟级），
// 期间所有 HTTP 请求（含首屏 index.html、/api/health、/api/status）都无法响应，表现为整页白屏。
function runCmdAsync(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      // Linux 下以独立进程组启动，超时可整组强杀（覆盖 sh -c 派生的孙进程）
      child = spawnAsync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (e) { resolve({ stdout: "", stderr: "", error: e }); return; }
    let out = "", err = "", settled = false;
    let timer = null;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };
    timer = setTimeout(() => {
      // 优先按进程组负 PID 强杀，失败时回退为仅杀直接子进程
      let killed = false;
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); killed = true; } catch {}
      }
      if (!killed) { try { child.kill("SIGKILL"); } catch {} }
      finish({ stdout: out.trim(), stderr: err.trim(), error: new Error(`命令超时（${timeoutMs}ms）已强制终止`) });
    }, timeoutMs);
    if (child.stdout) child.stdout.on("data", (d) => { out += d; });
    if (child.stderr) child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => finish({ stdout: "", stderr: "", error: e }));
    child.on("close", () => finish({ stdout: out.trim(), stderr: err.trim(), error: null }));
  });
}

function formatHermesVersion(raw) {
  if (!raw) return "unknown";
  const verMatch = raw.match(/(\d+\.\d+\.\d+)/);
  // 尝试匹配多种日期格式：vYYYY.M.D、YYYY-M-D、YYYY.M.D
  const dateMatch = raw.match(/(?:v)?(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  
  if (!verMatch) return raw.trim().split("\n")[0].slice(0, 64) || "unknown";
  
  let out = `v${verMatch[1]}`;
  
  if (dateMatch) {
    // 检查日期是否已经以 v 开头（如 v2026.8.3 -> v2026.8.3 应该变成 (2026.8.3)）
    const y = dateMatch[1], m = Number(dateMatch[2]), d = Number(dateMatch[3]);
    // 格式化日期为 YYYY.MM.DD
    out += ` (${y}.${m}.${d})`;
  }
  
  return out;
}
let HERMES_VERSION = "unknown";
// 尝试探测 hermes 实际位置
let HERMES_BIN_PATH = `${VENV_BIN}/hermes`;
if (!existsSync(HERMES_BIN_PATH)) {
  try {
    const files = readdirSync(VENV_BIN);
    const hermesFile = files.find(f => f.startsWith('hermes') && !f.endsWith('.pyc'));
    if (hermesFile) {
      HERMES_BIN_PATH = `${VENV_BIN}/${hermesFile}`;
      log(`[版本检测] 找到替代路径：${HERMES_BIN_PATH}`);
    }
  } catch {}
}
// 版本检测逻辑（带异常处理）
try {
  // 优先读缓存文件（瞬间完成），让服务器尽快启动
  if (existsSync(VERSION_FILE)) {
    const cached = readFileSync(VERSION_FILE, "utf8").trim();
    if (cached) HERMES_VERSION = cached;
  }
  
  // 缓存没有时才执行 hermes --version（可能耗时数秒）
  if (HERMES_VERSION === "unknown") {
    log(`[版本检测] 尝试从 hermes 二进制获取版本号：${HERMES_BIN_PATH}`);
    
    // 尝试 1: 标准方式；限 15 秒：此处在服务监听前同步执行，子进程挂起会无限期推迟服务启动
    const verResult = spawnSync("sh", ["-c", `${HERMES_BIN_PATH} --version`], { 
      stdout: "pipe", 
      stderr: "pipe",
      timeout: 15000,
      killSignal: "SIGKILL"
    });
    
    let verOut = "";
    log(`[版本检测] exitCode=${verResult.status}, hasStdout=${!!verResult.stdout}, hasStderr=${!!verResult.stderr}`);
    
    if (verResult.stdout) {
      try {
        verOut = verResult.stdout.toString("utf8").trim();
        log(`[版本检测] stdout: ${verOut ? `"${verOut}"` : "(empty)"}`);
      } catch (e) {
        log(`[版本检测] stdout 解码失败：${e.message}`);
      }
    }
    
    if (!verOut && verResult.stderr) {
      try {
        verOut = verResult.stderr.toString("utf8").trim();
        log(`[版本检测] stderr: ${verOut ? `"${verOut}"` : "(empty)"}`);
      } catch (e) {
        log(`[版本检测] stderr 解码失败：${e.message}`);
      }
    }
    
    // 尝试 2: 如果 standard way 不行，试试直接运行不加参数
    if (!verOut) {
      log(`[版本检测] 标准方式失败，尝试备选方案...`);
      
      // 检查是否是 shebang 问题
      let firstLine = "";
      try {
        if (existsSync(HERMES_BIN_PATH)) {
          const buf = readFileSync(HERMES_BIN_PATH, { encoding: 'utf8' }).slice(0, 256);
          firstLine = buf.split('\n')[0];
          log(`[版本检测] 文件第一行：${firstLine.substring(0, 50)}...`);
        }
      } catch (e) {
        log(`[版本检测] 读取文件第一行失败：${e.message}`);
      }
      
      // 如果是 Python 脚本，直接用 python3 运行
      if (firstLine.includes('python') || firstLine.includes('#!')) {
        log(`[版本检测] 检测到 shebang，使用 Python 运行`);
        // 限 15 秒：同上，避免备选探测无限期阻塞启动
        const pyResult = spawnSync("python3", [HERMES_BIN_PATH, "--version"], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: 15000,
          killSignal: "SIGKILL"
        });
        
        if (pyResult.stdout) {
          verOut = pyResult.stdout.toString("utf8").trim();
          log(`[版本检测] Python3 方式输出：${verOut ? `"${verOut}"` : "(empty)"}`);
        }
      }
    }
    
    if (verOut) {
      log(`[版本检测] 原始版本字符串：${JSON.stringify(verOut)}`);
      HERMES_VERSION = formatHermesVersion(verOut);
      try { writeFileSync(VERSION_FILE, HERMES_VERSION, { mode: 0o644 }); } catch {}
      log(`[版本检测] 成功解析版本：${HERMES_VERSION}`);
    } else {
      log(`[版本检测] hermes --version 所有方式都失败`);
    }
  }
} catch (e) {
  log(`[版本检测] 版本探测异常：${e.message}`);
}
// 必须走异步执行：此定时器在服务开始监听后触发，同步子进程一旦挂起会冻结事件循环，
// 导致首屏 index.html 等全部请求被拖住直至子进程退出（#141 白屏根因）。
process.nextTick(() => {
  log(`[版本检测] 准备刷新缓存 (当前=${HERMES_VERSION}, 文件=${VERSION_FILE})`);
  runCmdAsync(HERMES_BIN_PATH, ["--version"], 15000).then((r) => {
      const out = r.stdout || r.stderr;
      if (out) {
        const realVer = formatHermesVersion(out);
        if (realVer !== HERMES_VERSION) {
          HERMES_VERSION = realVer;
          try { writeFileSync(VERSION_FILE, realVer, { mode: 0o644 }); } catch (e2) {
            log(`[版本检测] 后台刷新写入缓存失败: ${e2.message}`);
          }
          log(`版本已刷新：${realVer}`);
        }
      } else if (r.error) {
        log(`[版本检测] 后台刷新执行失败: ${r.error.message}`);
      }
    }).catch((e) => {
      log(`[版本检测] 后台刷新异常：${e.message}`);
    });
});
log(`[启动检测] Hermes Agent 版本: ${HERMES_VERSION}`);

// ─── 启动令牌（写入 VAR_DIR 供本机 CLI/脚本读取）────────────────────────────
const MONITOR_TOKEN = (() => {
  try {
    if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  } catch {}
  const t = randomBytes(24).toString("hex");
  writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
})();

function checkToken(req) {
  const h = req.headers.get("x-monitor-token") || "";
  return h === MONITOR_TOKEN;
}

// ─── 主模型配置模块接入：注入路径 / 日志 / 本机令牌等共用设施 ───────────
initPrimaryConfig({ varDir: VAR_DIR, dataDir: DATA_DIR, log, monitorToken: MONITOR_TOKEN });


const HERMES_TOKEN_MIRROR = `${DATA_DIR}/.monitor_token`;
function syncTokenToHermesHome() {
  try { writeFileSync(HERMES_TOKEN_MIRROR, MONITOR_TOKEN, { mode: 0o600 }); }
  catch (e) { log(`同步 token 到 Hermes home 失败: ${e?.message || e}`); }
}
syncTokenToHermesHome();

// ── defaultConfig：初始配置模板（fallback_providers 默认空数组）───────────────
function defaultConfig() {
  return {
    providers: [{
      id: "hermes",
      name: "Hermes Gateway",
      type: "openai-compatible",
      base_url: GATEWAY_API,
      api_key: generateApiKey(),
      model: "auto",
      temperature: 0.7,
      max_tokens: 4096,
    }],
    active_provider: "Hermes Gateway",
    fallback_providers: [],   // 备选 provider name 列表（按顺序尝试）
    _version: CONFIG_VERSION,
  };
}

function initChatData() {
  mkdirSync(CHAT_DIR, { recursive: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(UPLOAD_IMG_DIR, { recursive: true });
  mkdirSync(UPLOAD_FILE_DIR, { recursive: true });
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  let needsReset = !existsSync(CONFIG_FILE);
  if (!needsReset) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
      needsReset = !cfg._version || cfg._version !== CONFIG_VERSION || !Array.isArray(cfg.providers);
    } catch {
      needsReset = true;
    }
  }
  if (needsReset) {
    writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig(), null, 2));
    try { chmodSync(CONFIG_FILE, 0o600); } catch {}
    log("Config reset to defaults (version mismatch or corrupted)");
  }
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}
function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2));
  try { chmodSync(path, 0o600); } catch {}
}

// ── active_provider 同步：优先读 config.yaml（稳定 provider id），兜底 chat/config.json ──
function syncActiveProviderFromConfigYaml(cfg) {
  try {
    const cfgPath = `${DATA_DIR}/config.yaml`;
    if (!existsSync(cfgPath)) return;
    const yml = readFileSync(cfgPath, "utf8");
    const provMatch = yml.match(/^model:\s*\n\s+provider:\s*(\S+)/m);
    if (!provMatch) return;
    const cfgProvider = provMatch[1];
    const modelMatch = yml.match(/^model:\s*\n\s+default:\s*(\S+)/m);
    const cfgModel = modelMatch ? modelMatch[1] : null;
    const matched = cfg.providers.find(p =>
      String(p.id) === cfgProvider || String(p.name) === cfgProvider
    );
    if (!matched) return;

    if (cfg.active_provider !== matched.name) {
      cfg.active_provider = matched.name;
      log(`active_provider synced from config.yaml → "${matched.name}"`);
    }
    if (cfgModel && (!matched.model || matched.model === 'auto')) {
      matched.model = cfgModel;
      log(`model synced from config.yaml → "${cfgModel}"`);
    }
  } catch (e) {
  }
}

function getChatConfig() {
  try {
    const cfg = readJSON(CONFIG_FILE);
    if (!cfg._version || cfg._version !== CONFIG_VERSION ||
        !Array.isArray(cfg.providers) || cfg.providers.length === 0) {
      const def = defaultConfig();
      writeJSON(CONFIG_FILE, def);
      return def;
    }
    syncActiveProviderFromConfigYaml(cfg);
    if (!cfg.fallback_providers) {
      cfg.fallback_providers = [];
    }
    let needsSave = false;
    const hermesIdx = cfg.providers.findIndex(p => p.id === "hermes");
    if (hermesIdx >= 0) {
      if (cfg.providers[hermesIdx].base_url !== "LOCAL") {
        cfg.providers[hermesIdx].base_url = "LOCAL";
        needsSave = true;
      }
    }
    const oldProviders = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")).providers || [];
    cfg.providers.forEach(p => {
      if (p.base_url === "LOCAL" || p.id === "hermes") {
        p.api_key = MONITOR_TOKEN;
        return;
      }
      const needsKeyRecovery = (p.api_key && p.api_key.startsWith("****") && !p.api_key.startsWith("****keep"))
        || (p.api_key_configured && (!p.api_key || p.api_key.startsWith("****")));
      if (needsKeyRecovery) {
        const envKey = PROVIDER_API_KEYS[p.id] || PROVIDER_API_KEYS[p.name];
        if (envKey) {
          try {
            let envVal = process.env[envKey];
            if (!envVal) {
              const envProvPath = `${VAR_DIR}/.env.providers`;
              if (existsSync(envProvPath)) {
                const provEnv = readFileSync(envProvPath, "utf8");
                const m = provEnv.match(new RegExp(`^${envKey}=(.*)$`, "m"));
                if (m && m[1]) envVal = m[1].trim();
              }
            }
            if (envVal) { p.api_key = envVal; return; }
          } catch {}
        }
        const old = oldProviders.find(op => op.id === p.id || op.name === p.name);
        if (old && old.api_key && !old.api_key.startsWith("****")) {
          p.api_key = old.api_key;
        }
      }
    });
    if (needsSave) writeJSON(CONFIG_FILE, cfg);
    return cfg;
  } catch {
    const def = defaultConfig();
    writeJSON(CONFIG_FILE, def);
    return def;
  }
}
function saveChatConfig(cfg) {
  writeJSON(CONFIG_FILE, cfg);
}
function getActiveProvider() {
  const cfg = getChatConfig();
  return cfg.providers.find(p => p.name === cfg.active_provider) || cfg.providers[0];
}

function sessionFile(id) {
  return `${SESSIONS_DIR}/${id}.json`;
}
function listSessions() {
  try {
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
    return files.map(f => {
      try {
        const s = readJSON(`${SESSIONS_DIR}/${f}`);
        return { id: s.id, title: s.title, created_at: s.created_at, updated_at: s.updated_at, message_count: (s.messages || []).length };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.updated_at - a.updated_at);
  } catch { return []; }
}
function getSession(id) {
  const f = sessionFile(id);
  if (!existsSync(f)) return null;
  try { return readJSON(f); } catch { return null; }
}
function saveSession(s) {
  s.updated_at = Date.now();
  writeJSON(sessionFile(s.id), s);
}
function deleteSession(id) {
  const f = sessionFile(id);
  if (existsSync(f)) unlinkSync(f);
}

function createSSEParser(onDelta, onDone, onError, onToolEvent) {
  let buffer = "";
  let currentEvent = "";
  let toolData = {};
  let toolDispatched = false;

  function tryToolEvent() {
    if (currentEvent === "hermes.tool.progress" && toolData.toolCallId && !toolDispatched) {
      toolDispatched = true;
      if (onToolEvent) {
        onToolEvent({
          tool: toolData.tool,
          toolCallId: toolData.toolCallId,
          status: toolData.status,
          emoji: toolData.emoji || "",
          label: toolData.label || "",
          // 中文显示名与 Agent Bridge 链路共用 tool-names.js 单一映射
          toolZh: toolDisplayName(toolData.tool),
        });
      }
    }
  }

  return {
    feed(chunk) {
      buffer += chunk;
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        let eventData = "";
        currentEvent = "";
        toolData = {};
        toolDispatched = false;

        for (const line of part.split("\n")) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            eventData = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            eventData = line.slice(5).trim();
          }
          // 工具事件：逐行累积字段，空行时统一派发
          if (currentEvent === "hermes.tool.progress" && eventData) {
            try {
              const tj = JSON.parse(eventData);
              if (tj.tool) toolData.tool = tj.tool;
              if (tj.toolCallId) toolData.toolCallId = tj.toolCallId;
              if (tj.status) toolData.status = tj.status;
              if (tj.emoji) toolData.emoji = tj.emoji;
              if (tj.label) toolData.label = tj.label;
            } catch {}
            eventData = ""; // 不再走普通 delta 路径
          }
        }
        tryToolEvent();

        if (!eventData) continue;
        if (eventData === "[DONE]") { onDone(); return; }
        try {
          const json = JSON.parse(eventData);
          if (json.error) { onError(typeof json.error === 'string' ? json.error : (json.error.message || JSON.stringify(json.error))); return; }
          const delta = json.choices?.[0]?.delta?.content || "";
          if (delta) onDelta(delta);
        } catch {
          // 忽略非 JSON 行
        }
      }
    },
    flush() {
      // 处理剩余 buffer 中可能未结束的工具事件
      if (buffer.trim()) {
        currentEvent = "";
        toolData = {};
        toolDispatched = false;
        const lines = buffer.split("\n");
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (currentEvent === "hermes.tool.progress" && data) {
              try {
                const tj = JSON.parse(data);
                if (tj.tool) toolData.tool = tj.tool;
                if (tj.toolCallId) toolData.toolCallId = tj.toolCallId;
                if (tj.status) toolData.status = tj.status;
                if (tj.emoji) toolData.emoji = tj.emoji;
                if (tj.label) toolData.label = tj.label;
              } catch {}
              continue;
            }
            if (data === "[DONE]") { tryToolEvent(); onDone(); return; }
            try {
              const json = JSON.parse(data);
              if (json.error) { onError(typeof json.error === 'string' ? json.error : (json.error.message || JSON.stringify(json.error))); return; }
              const delta = json.choices?.[0]?.delta?.content || "";
              if (delta) onDelta(delta);
            } catch {}
          }
        }
        tryToolEvent();
      }
      onDone();
    },
  };
}

// ─── 聊天：Gateway 代理 ─────────────────────────────────────────────────────
async function fetchGatewayModels(provider) {
  const t0 = Date.now();
  try {
    const headers = { "User-Agent": UPSTREAM_UA, "Accept": "application/json" };
    // LOCAL provider 必须用真实 MONITOR_TOKEN
    const isLocal = (provider.base_url === "LOCAL" || provider.id === "hermes");
    if (!isLocal && !provider.base_url) {
      return { models: [], latency: 0, error: 'base_url 未填写' };
    }
    if (isLocal) {
      headers["Authorization"] = `Bearer ${MONITOR_TOKEN}`;
    } else if (provider.api_key && provider.api_key !== "none") {
      headers["Authorization"] = `Bearer ${provider.api_key}`;
    }
    const baseUrl = isLocal ? GATEWAY_API : provider.base_url.replace(/\/$/, "");
    const r = await fetch(`${baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    const latency = Date.now() - t0;
    if (!r.ok) return { models: [], latency, error: `HTTP ${r.status}` };
    const data = await r.json();
    let models = (data.data || data.models || []).map(m => ({ id: m.id, name: m.id }));
    if (isLocal) {
      try {
        const cfgPath = `${DATA_DIR}/config.yaml`;
        if (existsSync(cfgPath)) {
          const yml = readFileSync(cfgPath, "utf8");
          const m = yml.match(/^model:\s*\n\s+default:\s*(\S+)/m);
          if (m && m[1]) {
            models = [{ id: m[1], name: m[1], current: true }];
          }
        }
      } catch {}
      if (models.length === 0) {
        models = [{ id: "hermes-agent", name: "hermes-agent", fake: true }];
      }
    }
    return { models, latency };
  } catch (e) {
    return { models: [], latency: Date.now() - t0, error: e.message };
  }
}

function resolveProviderBase(provider) {
  return GATEWAY_API.replace(/\/$/, "");
}

async function autoTitle(userMsg, provider) {
  // userMsg 可能是字符串，也可能是多模态 content 数组（图片消息），这里只取文字部分用于生成标题
  let plainMsg = userMsg;
  if (Array.isArray(userMsg)) {
    const textPart = userMsg.find(p => p && p.type === "text");
    plainMsg = (textPart && textPart.text) || "[图片消息]";
  } else if (typeof userMsg !== "string") {
    plainMsg = String(userMsg ?? "");
  }
  const text = plainMsg.slice(0, 200);
  provider = provider || getActiveProvider();
  try {
    const providerBase = resolveProviderBase(provider);
    const apiKey = resolveRealApiKey(provider);
    const headers = { "Content-Type": "application/json" };
    if (apiKey && apiKey !== "none") {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const r = await fetch(`${providerBase}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: provider.model || "auto",
        messages: [
          { role: "system", content: "Generate a concise title (max 8 words, no quotes, no period) for this user message. Reply with ONLY the title text." },
          { role: "user", content: text },
        ],
        temperature: 0.3,
        max_tokens: 30,
        stream: false,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return text.slice(0, 30);
    const data = await r.json();
    const title = data.choices?.[0]?.message?.content?.trim();
    return (title || text.slice(0, 30)).slice(0, 60);
  } catch {
    return text.slice(0, 30);
  }
}

async function chatRequest(provider, message, history, reqSignal) {
  const providerBase = resolveProviderBase(provider);
  const isGateway = providerBase === GATEWAY_API.replace(/\/$/, "");
  const apiKey = isGateway ? MONITOR_TOKEN : resolveRealApiKey(provider);
  if (apiKey && apiKey !== "none" && !isGateway) {
    const officialEntry = Object.entries(PROVIDER_PRESETS).find(
      ([, v]) => v.base_url === provider.base_url
    );
    const isKnownPreset = !!officialEntry;
    const isLocal = !provider.base_url || provider.base_url === "LOCAL" || provider.base_url === GATEWAY_API;
    if (!isLocal && !isKnownPreset) {
      throw new Error(`Provider "${provider.name}" 的 base_url 未在预设列表中，拒绝发送 API key`);
    }
  }

  const headers = { "Content-Type": "application/json", "User-Agent": UPSTREAM_UA, "Accept": "application/json" };
  if (apiKey && apiKey !== "none") {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const upstream = await fetch(`${providerBase}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: provider.model || "auto",
      messages: history,
      temperature: provider.temperature ?? 0.7,
      max_tokens: provider.max_tokens ?? 4096,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal: reqSignal,
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    throw new Error(`Gateway ${upstream.status}: ${errText.slice(0, 200)}`);
  }
  return upstream;
}

// ─── Agent Bridge IPC 客户端（轮询模式）────────────────────────────
// 协议约定：与 agent-bridge 服务端（bridge_server.py 的 action 分发）配套的帧格式/action 定义。
// 帧格式：每个请求建立一条新连接，写入 JSON.stringify(payload) + "\n"，
//         读取单行 JSON 响应后连接即关闭（一问一答）。
// 默认 socket 放在本实例私有 VAR_DIR 下（避免 /tmp 全局可写目录被抢占/伪造；
// VAR_DIR 本身按应用实例隔离，双实例场景 socket 路径天然互不冲突），
// 仍可用 HERMES_AGENT_BRIDGE_ENDPOINT 环境变量覆盖
const BRIDGE_ENDPOINT = process.env.HERMES_AGENT_BRIDGE_ENDPOINT || `ipc://${VAR_DIR}/agent-bridge.sock`;
const BRIDGE_POLL_INTERVAL_MS = 100;        // 轮询间隔，与参考实现 streamOutput 一致
const BRIDGE_POLL_FAIL_WINDOW_MS = 30000;   // 连续轮询失败超过 30s 才判定失败（替代 2 分钟整体超时）
const BRIDGE_POLL_RETRY_MS = 500;           // 单次轮询失败后的重试间隔
const BRIDGE_CHAT_TIMEOUT_MS = 120000;      // chat 请求本身的超时（与参考 DEFAULT_AGENT_BRIDGE_TIMEOUT_MS 一致）
const BRIDGE_POLL_TIMEOUT_MS = 10000;       // 单次 get_output 请求超时
const BRIDGE_PING_TIMEOUT_MS = 1500;        // 可用性探测超时
const BRIDGE_HEALTH_PING_TIMEOUT_MS = 5000; // 保活健康检查专用探活超时（高负载下防误判僵死）
const PID_BRIDGE = `${VAR_DIR}/bridge.pid`;

// bridge IPC 共享密钥 — monitor 启动时生成随机 token（0600 落盘 VAR_DIR），
// 每个 IPC 请求 payload 附带 auth 字段，并经 HERMES_BRIDGE_TOKEN env 传给 bridge 进程。
// 注意：服务端是否校验取决于 hermes_bridge.py 版本（旧版忽略未知字段，不影响通信）；
// token 读写失败时降级为空（不带 auth），不破坏通信。
const BRIDGE_TOKEN_FILE = `${VAR_DIR}/bridge.token`;
const BRIDGE_TOKEN = (() => {
  try {
    if (existsSync(BRIDGE_TOKEN_FILE)) {
      const t = readFileSync(BRIDGE_TOKEN_FILE, "utf8").trim();
      if (t) return t;
    }
  } catch {}
  try {
    const t = randomBytes(24).toString("hex");
    writeFileSync(BRIDGE_TOKEN_FILE, t, { mode: 0o600 });
    return t;
  } catch { return ""; }
})();

// 工具徽章的中文显示名/图标映射已抽为外接模块 tool-names.js（单一数据源，
// bridge IPC 与 SSE 降级两条链路共用；Hermes 升级新增工具时只需维护该文件）

function bridgeConnect(timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    let sock;
    if (BRIDGE_ENDPOINT.startsWith("ipc://")) {
      sock = net.createConnection(BRIDGE_ENDPOINT.slice("ipc://".length));
    } else if (BRIDGE_ENDPOINT.startsWith("tcp://")) {
      const u = new URL(BRIDGE_ENDPOINT);
      sock = net.createConnection({ host: u.hostname || "127.0.0.1", port: Number(u.port) });
    } else {
      reject(new Error(`不支持的 bridge endpoint: ${BRIDGE_ENDPOINT}`));
      return;
    }
    // connect 级超时，防止 endpoint 无响应时无限挂起
    const timer = timeoutMs > 0
      ? setTimeout(() => { cleanup(); sock.destroy(); reject(new Error(`Agent Bridge 连接超时 (${timeoutMs}ms)`)); }, timeoutMs)
      : null;
    const cleanup = () => { if (timer) clearTimeout(timer); sock.off("connect", onConnect); sock.off("error", onError); };
    const onConnect = () => { cleanup(); resolve(sock); };
    const onError = (err) => { cleanup(); sock.destroy(); reject(err); };
    sock.once("connect", onConnect);
    sock.once("error", onError);
  });
}

async function bridgeRequest(payload, timeoutMs = BRIDGE_CHAT_TIMEOUT_MS) {
  // timeoutMs 覆盖 connect + 读响应全程（先记 deadline，再发起连接）
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
  const sock = await bridgeConnect(timeoutMs);
  // 每个请求附带共享密钥；服务端校验依赖 hermes_bridge.py 版本（忽略未知字段时不影响通信）
  sock.write(JSON.stringify(BRIDGE_TOKEN ? { ...payload, auth: BRIDGE_TOKEN } : payload) + "\n");
  const raw = await new Promise((resolve, reject) => {
    // 按字节累积 Buffer，找 0x0A 分行后整体 decode，避免 UTF-8 多字节字符跨包乱码
    const buffers = [];
    const readTimeoutMs = deadline ? Math.max(1, deadline - Date.now()) : 0;
    const timer = readTimeoutMs > 0
      ? setTimeout(() => { cleanup(); sock.destroy(); reject(new Error(`Agent Bridge 请求超时 (${timeoutMs}ms)`)); }, readTimeoutMs)
      : null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      sock.off("data", onData); sock.off("error", onError);
      sock.off("end", onEnd); sock.off("close", onClose);
    };
    // cleanup 摘除监听后补一个 no-op error 监听，防对端 RST 抛 uncaughtException
    const finish = (line) => { cleanup(); sock.on("error", () => {}); sock.end(); resolve(line); };
    const bufferedLine = () => {
      const all = Buffer.concat(buffers);
      const idx = all.indexOf(0x0a);
      return (idx >= 0 ? all.subarray(0, idx) : all).toString("utf8").trim();
    };
    const onData = (chunk) => {
      buffers.push(chunk);
      if (chunk.includes(0x0a)) finish(bufferedLine());
    };
    const onError = (err) => { cleanup(); sock.destroy(); reject(err); };
    const onEnd = () => { const line = bufferedLine(); if (line) finish(line); };
    // close 时若仍有未换行残留（对端异常断开），按一行处理而不是挂起等超时
    const onClose = () => {
      const line = bufferedLine();
      if (line) finish(line);
      else { cleanup(); reject(new Error("Agent Bridge socket 关闭且无响应")); }
    };
    sock.on("data", onData);
    sock.once("error", onError);
    sock.once("end", onEnd);
    sock.once("close", onClose);
  });
  const resp = JSON.parse(raw);
  if (!resp.ok) {
    const err = new Error(resp.error || "Agent Bridge 请求失败");
    err.response = resp;
    throw err;
  }
  return resp;
}

async function bridgeAvailable() {
  try { await bridgeRequest({ action: "ping" }, BRIDGE_PING_TIMEOUT_MS); bridgeUnavailableLoggedAt = 0; return true; }
  catch (e) {
    // 限频记录：同一持续不可用期 5 分钟内只记一条，恢复后重置
    if (Date.now() - bridgeUnavailableLoggedAt > 300000) {
      bridgeUnavailableLoggedAt = Date.now();
      log(`[bridge] bridge 不可用，本次对话降级 HTTP SSE: ${e?.message || e}`);
    }
    return false;
  }
}
let bridgeUnavailableLoggedAt = 0; // 上次记录 bridge 不可用日志的时间戳（防刷屏）

// 发起对话 → {ok, run_id, session_id, status}
// runtime（可选 {model, provider}）：面板主模型，随请求透传给 bridge（请求字段
// 优先于 config.yaml 默认）；缺省不传，bridge 回落默认模型，旧版 bridge 忽略未知字段
function bridgeChat(sessionId, message, history, instructions, runtime) {
  return bridgeRequest({
    action: "chat",
    session_id: sessionId,
    message,
    ...(history && history.length ? { conversation_history: history } : {}),
    ...(instructions ? { instructions } : {}),
    ...(runtime && runtime.model ? { model: runtime.model } : {}),
    ...(runtime && runtime.provider ? { provider: runtime.provider } : {}),
  }, BRIDGE_CHAT_TIMEOUT_MS);
}

// 轮询输出 → {ok, delta, cursor, output, done, status, error, events, event_cursor}
function bridgeGetOutput(runId, cursor, eventCursor) {
  return bridgeRequest({
    action: "get_output",
    run_id: runId,
    cursor,
    event_cursor: eventCursor,
  }, BRIDGE_POLL_TIMEOUT_MS);
}

// 用户中断（fire-and-forget）
function bridgeInterrupt(sessionId) {
  return bridgeRequest({ action: "interrupt", session_id: sessionId }, 5000).catch(() => {});
}

// 将 bridge 的 tool.started / tool.completed 事件映射为前端 tool_progress 结构，
// 字段与现有 hermes.tool.progress 转发格式一致：{tool, toolCallId, status, emoji, label, toolZh}
function mapBridgeToolEvent(ev) {
  const tool = String(ev.tool_name || "");
  return {
    tool,
    toolCallId: String(ev.tool_call_id || "") || `bridge-${tool}`,
    status: ev.event === "tool.completed" ? "completed" : "running",
    emoji: toolEmoji(tool),
    label: "",
    toolZh: toolDisplayName(tool),
  };
}

// Bridge 轮询主循环：返回 {fullReply, hadToolCalls, aborted}
// 失败时抛错；若错误发生前已向前端输出过内容，err.bridgeEmitted=true（调用方不得降级重放）
async function runBridgeChat({ sessionId, message, history, instructions, signal, onDelta, onTool, model, provider }) {
  // 网页对话与网关/微信链路对齐：解析面板主模型随请求传入；
  // 解析失败/LOCAL 时为 null（不传字段，维持 bridge 默认模型行为），不阻断对话
  let primaryRuntime = null;
  try { 
    // Use reconnected model/provider if provided, otherwise resolve from active provider
    const resolvedProvider = (model && provider) ? { name: provider, id: model } : getActiveProvider();
    primaryRuntime = resolveBridgePrimary(resolvedProvider); 
  } catch {}
  const started = await bridgeChat(sessionId, message, history, instructions, primaryRuntime);
  const runId = started.run_id;
  let cursor = 0;
  let eventCursor = 0;
  let fullReply = "";
  let hadToolCalls = false;
  let lastPollOkAt = Date.now();

  const fail = (msg) => {
    const err = new Error(msg);
    err.bridgeEmitted = fullReply.length > 0 || hadToolCalls;
    err.partial = fullReply;
    throw err;
  };

  // 错误文案归一：非字符串时取 .message 或 JSON 序列化，避免 "[object Object]"
  const asErrText = (e, dflt) => {
    if (typeof e === "string" && e.trim()) return e;
    if (e && typeof e === "object") {
      if (typeof e.message === "string" && e.message.trim()) return e.message;
      try { const s = JSON.stringify(e); if (s && s !== "{}") return s; } catch {}
    }
    return dflt;
  };

  for (;;) {
    if (signal && signal.aborted) {
      bridgeInterrupt(sessionId);
      return { fullReply, hadToolCalls, aborted: true };
    }
    let chunk;
    try {
      chunk = await bridgeGetOutput(runId, cursor, eventCursor);
      lastPollOkAt = Date.now();
    } catch (e) {
      // 错误分类——bridge 进程已死（unix socket ENOENT/ECONNREFUSED）或协议级
      // 错误（resp.ok=false，e.response 存在，如 unknown run_id）立即失败；
      // 仅网络瞬断类错误走 30s 重试窗口
      const _code = e && e.code;
      const _procDead = _code === "ENOENT" || _code === "ECONNREFUSED";
      const _protocolErr = !!(e && e.response);
      if (_procDead || _protocolErr) {
        fail(`Agent Bridge ${_protocolErr ? "协议错误" : "进程不可达"}: ${e.message || e}`);
      }
      // 轮询模式下不设整体超时：连续失败超过窗口才判定失败
      if (Date.now() - lastPollOkAt > BRIDGE_POLL_FAIL_WINDOW_MS) {
        fail(`Agent Bridge 轮询连续失败超过 ${Math.round(BRIDGE_POLL_FAIL_WINDOW_MS / 1000)}s: ${e.message || e}`);
      }
      await new Promise(r => setTimeout(r, BRIDGE_POLL_RETRY_MS));
      continue;
    }
    cursor = chunk.cursor ?? cursor;
    eventCursor = chunk.event_cursor ?? eventCursor;

    // 参考 applyBridgeChunkAsync：events 里出现 stream.delta（与工具事件按真实顺序
    // 交错）时按事件顺序消费文本，此时不能再消费聚合的 chunk.delta（会重复）
    let sawStreamDeltaEvent = false;
    for (const ev of chunk.events || []) {
      const evType = ev && ev.event;
      if (evType === "stream.delta") {
        // 仅在实际消费到非空 delta 文本时才屏蔽聚合 chunk.delta，
        // 避免空 stream.delta 事件误丢本轮聚合文本
        const text = String(ev.delta || "");
        if (text) { sawStreamDeltaEvent = true; fullReply += text; if (onDelta) onDelta(text); }
      } else if (evType === "message.interim") {
        // 中间轮 assistant 文本（不经流式通道）：already_streamed=false 时作为 delta
        // 下发；true 表示流式已推过，跳过防重复。interim 文本不在聚合 chunk.delta
        // 中，故不置 sawStreamDeltaEvent（否则会误丢本轮聚合文本）。
        // 护栏：旧引擎可能不带 already_streamed（缺省 false）但文本已走过流式
        // 回调；fullReply 或本轮尚未消费的聚合 chunk.delta 已包含该文本时
        // 跳过防重复（事件先于聚合 delta 处理，需两处都查）
        if (!ev.already_streamed) {
          const text = String(ev.text || "");
          if (text && !fullReply.includes(text) && !String(chunk.delta || "").includes(text)) {
            fullReply += text; if (onDelta) onDelta(text);
          }
        }
      } else if (evType === "tool.started" || evType === "tool.completed") {
        hadToolCalls = true;
        if (onTool) onTool(mapBridgeToolEvent(ev));
      }
    }
    if (!sawStreamDeltaEvent && chunk.delta) {
      const text = String(chunk.delta);
      fullReply += text;
      if (onDelta) onDelta(text);
    }

    if (chunk.done) {
      if (chunk.status === "error") {
        fail(String(chunk.error || "Agent Bridge run 失败"));
      }
      const res = (chunk.result && typeof chunk.result === "object") ? chunk.result : {};
      const interrupted = chunk.status === "interrupted";
      // 候选最终文本：聚合 output 优先；trim 后为空时回退 result 里的整段回复
      //（final_response → response → output 逐层取第一个非空字符串；非 string
      //  跳过，防 "[object Object]" 下发；与 Python 侧 or 链语义对齐）
      let candidate = chunk.output != null ? String(chunk.output) : "";
      if (!candidate.trim()) {
        candidate = "";
        for (const v of [res.final_response, res.response, res.output]) {
          if (typeof v === "string" && v.trim()) { candidate = v; break; }
        }
      }
      // 引擎报告失败（用户主动中断优先，不当失败处理）：无可用内容时按
      // error 收尾透传真实错误；有内容时保留内容下发，仅在末尾附加警示
      const hasContent = !!(candidate || fullReply);
      if (!interrupted && res.failed && !hasContent) {
        fail(asErrText(res.error, "bridge 任务失败"));
      }
      // 包含性补发：candidate 未被 fullReply 完整包含时——前缀关系按差额
      // tail 补发（闭合丢文本窗口）；否则以空行分隔追加整段下发，避免
      // interim 计入 fullReply 导致前缀失配时静默丢最终回复；
      // 已完整包含则不动作，防重复
      if (candidate && !fullReply.includes(candidate)) {
        if (candidate.startsWith(fullReply)) {
          const tail = candidate.slice(fullReply.length);
          fullReply = candidate;
          if (onDelta) onDelta(tail);
        } else {
          const sep = fullReply ? "\n\n" : "";
          fullReply += sep + candidate;
          if (onDelta) onDelta(sep + candidate);
        }
      }
      if (!interrupted && res.failed && hasContent) {
        const warn = "\n\n⚠️ 本次回复未完全成功，内容可能不完整";
        fullReply += warn;
        if (onDelta) onDelta(warn);
      }
      return { fullReply, hadToolCalls, aborted: interrupted };
    }
    await new Promise(r => setTimeout(r, BRIDGE_POLL_INTERVAL_MS));
  }
}

// ─── Agent Bridge 进程管理 ──────────────────────────────────────────────
// 启动命令：<python> hermes_bridge.py --endpoint <ep> [--agent-root ..] [--hermes-home ..]
// bridge 脚本按候选路径探测；找不到则跳过（依赖降级路径）
function findBridgeScript() {
  const candidates = [
    process.env.HERMES_BRIDGE_SCRIPT || "",
    `${APP_DIR}/server/vendor/agent-bridge/hermes_bridge.py`,
    `${DATA_DIR}/agent-bridge/hermes_bridge.py`,
  ].filter(Boolean);
  return candidates.find(p => { try { return existsSync(p); } catch { return false; } }) || null;
}

// 模块级启动锁，防止 /api/start 与 /api/restart 并发触发时重复 spawn
let bridgeStartLock = false;
// bridge 保活器实例（在 manualStopEpoch 声明后初始化，见 initChannels 之后）
let bridgeKeeper = null;

function startAgentBridge() {
  if (bridgeStartLock) return { ok: true, msg: "start_in_progress" };
  bridgeStartLock = true;
  try {
    if (readBridgePid()) return { ok: true, msg: "already_running" };
    const script = findBridgeScript();
    if (!script) {
      log("[bridge] 未找到 hermes_bridge.py（候选：HERMES_BRIDGE_SCRIPT / server/vendor/agent-bridge / data/agent-bridge），跳过启动，对话将降级为 HTTP SSE");
      return { ok: false, error: "script_not_found" };
    }
    const python = existsSync(`${VENV_BIN}/python3`) ? `${VENV_BIN}/python3`
      : (existsSync(`${VENV_BIN}/python`) ? `${VENV_BIN}/python` : "python3");
    const logPath = `${VAR_DIR}/bridge.log`;
    // 追加写保留崩溃历史；超限时保留尾部 256KB，启动时写入带时间戳分隔行
    try {
      let prev = "";
      try { if (existsSync(logPath) && statSync(logPath).size <= 8388608) prev = readFileSync(logPath, "utf8"); } catch {}
      if (prev.length > 262144) prev = prev.slice(-262144);
      writeFileSync(logPath, prev + `\n===== bridge start ${new Date().toISOString()} =====\n`);
    } catch {}
    // node-adapter 的对象式 spawn 不透传 detached/进程组选项（仅接受
    // cmd/env/stdout/stderr/stdin），无法以独立进程组启动后按 -pgid 杀组；
    // 停止侧由 stopAgentBridge() 对 hermes_bridge.py 命令行匹配补杀
    const p = spawn({
      cmd: [python, script, "--endpoint", BRIDGE_ENDPOINT, "--hermes-home", DATA_DIR],
      env: {
        ...process.env,
        HOME: DATA_DIR,
        HERMES_HOME: DATA_DIR,
        HERMES_AGENT_BRIDGE_ENDPOINT: BRIDGE_ENDPOINT,
        // 共享密钥经 env 传给 bridge（服务端校验依赖 hermes_bridge.py 版本）
        ...(BRIDGE_TOKEN ? { HERMES_BRIDGE_TOKEN: BRIDGE_TOKEN } : {}),
        HERMES_YOLO_MODE: "1",
        // PATH 与 spawnHermes 对齐（注入 resolvedNodeDir / HERMES_NODE）
        PATH: resolvedNodeDir
          ? `${resolvedNodeDir}:${VENV_BIN}:/usr/local/bin:/usr/bin:/bin`
          : `${VENV_BIN}:/usr/local/bin:/usr/bin:/bin`,
        ...(resolvedNodeBin ? { HERMES_NODE: resolvedNodeBin } : {}),
      },
      stdout: file(logPath),
      stderr: file(logPath),
      stdin: "ignore",
    });
    // spawn 异步失败（如可执行文件不存在）时 pid 无效：按启动失败返回，不写 PID、不挂保活
    if (!Number.isInteger(p.pid) || p.pid <= 0) {
      log("[bridge] Agent Bridge 启动失败：spawn 未返回有效 pid");
      return { ok: false, error: "spawn_no_pid" };
    }
    p.unref();
    writeFileSync(PID_BRIDGE, String(p.pid));
    if (bridgeKeeper) bridgeKeeper.watch(p, p.pid); // 保活：登记进程并挂退出监听
    log(`[bridge] Agent Bridge 已启动 pid=${p.pid} endpoint=${BRIDGE_ENDPOINT}`);
    return { ok: true, pid: p.pid };
  } catch (e) {
    // 失败容忍：仅记录日志，对话自动降级为 HTTP SSE
    log(`[bridge] Agent Bridge 启动失败（将降级为 HTTP SSE）: ${e.message || e}`);
    return { ok: false, error: e.message || String(e) };
  } finally {
    bridgeStartLock = false;
  }
}

// ── 辅助：对话流式公共参数 ──────────────────────────────────────
const PROVIDER_TIMEOUT_MS = 300000; // 流式不活动超时：连接或相邻数据块之间超过该时长无数据才中断
const activeChatStreams = new Map();
const wsMessageQueue = new Map(); // session_id → message，WS 连接前暂存
const wsQueueTimers = new Map();  // session_id → 队列清理定时器句柄（同 session 重复入队时先清旧定时器，避免误删新消息）

// ─── 多会话并发运行表（任务 #8）─────────────────────────────────────────
// session_id → 运行态条目。对话运行期间实时更新；结束后保留 TTL 供前端
// 切回窗口时拉取最终态，超时由周期性扫描清理。
// 覆盖 Agent Bridge 与 HTTP SSE 降级两条链路（均在调用方回调处挂钩）。
const LIVE_RUN_TTL_MS = 10 * 60 * 1000;      // 结束后保留 10 分钟
const LIVE_RUN_OUTPUT_CAP = 2 * 1024 * 1024; // 单会话输出缓存上限（字符），超出后丢头保尾
const LIVE_RUN_TOOL_CAP = 500;               // 单会话工具事件缓存上限
const liveRuns = new Map();

// 新建运行条目，返回 monitor 级 run_id（与 bridge 内部 run_id 无关）。
// 同 session 新运行接管时直接覆盖旧条目；旧运行的后续回调因 run_id 不匹配而被忽略
function liveRunStart(sessionId, prompt) {
  const runId = randomBytes(8).toString("hex");
  liveRuns.set(sessionId, {
    run_id: runId,
    status: "running",       // running | complete | interrupted | error
    prompt: prompt != null ? prompt : "",  // 本轮用户提问（与助手输出同源，供跨窗口流转时渲染当前问题）
    output: "",
    output_base: 0,          // 被丢弃的头部字符数（绝对游标 = output_base + output.length）
    tool_events: [],
    tool_base: 0,            // 被丢弃的头部事件数
    started_at: Date.now(),
    updated_at: Date.now(),
    done: false,
  });
  return runId;
}
function liveRunEntry(sessionId, runId) {
  const e = liveRuns.get(sessionId);
  return e && e.run_id === runId ? e : null;
}
function liveRunDelta(sessionId, runId, text) {
  const e = liveRunEntry(sessionId, runId);
  if (!e || !text) return;
  e.output += text;
  if (e.output.length > LIVE_RUN_OUTPUT_CAP) {
    const drop = e.output.length - LIVE_RUN_OUTPUT_CAP;
    e.output = e.output.slice(drop);
    e.output_base += drop;
  }
  e.updated_at = Date.now();
}
function liveRunTool(sessionId, runId, toolEvent) {
  const e = liveRunEntry(sessionId, runId);
  if (!e) return;
  e.tool_events.push(toolEvent);
  if (e.tool_events.length > LIVE_RUN_TOOL_CAP) {
    const drop = e.tool_events.length - LIVE_RUN_TOOL_CAP;
    e.tool_events.splice(0, drop);
    e.tool_base += drop;
  }
  e.updated_at = Date.now();
}
function liveRunEnd(sessionId, runId, status) {
  const e = liveRunEntry(sessionId, runId);
  if (!e || e.done) return;
  e.status = status;
  e.done = true;
  e.updated_at = Date.now();
}
// 周期性清理：已结束且超过 TTL 的条目
const liveRunSweeper = setInterval(() => {
  const now = Date.now();
  for (const [sid, e] of liveRuns) {
    if (e.done && now - e.updated_at > LIVE_RUN_TTL_MS) liveRuns.delete(sid);
  }
}, 60000);
if (liveRunSweeper.unref) liveRunSweeper.unref();

function combineSignals(signals) {
  const valid = signals.filter(Boolean);
  if (typeof AbortSignal.any === "function") return AbortSignal.any(valid);
  const ctrl = new AbortController();
  for (const s of valid) {
    if (s.aborted) { ctrl.abort(s.reason); break; }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

// 前端渲染能力声明：作为system message注入每次对话最前面
const UI_CAPABILITIES_PROMPT = `你正在通过网页聊天窗口对话，前端按以下规则渲染你的输出：

1. 完整 GFM Markdown（标题/粗斜体/列表/引用/表格/代码块等）会被渲染，正常输出 Markdown，不要输出 HTML 标签。
2. 标准链接语法 [文字](https://...) 或裸 http(s) 链接会自动变可点击超链接。
3. 二维码：用 [qr](https://...)（链接文字必须是小写 "qr"）会渲染成可扫码的二维码按钮。需要扫码场景（微信链接、内网地址、非标准端口、OAuth回调等）主动使用此格式。不要用字符/emoji画二维码图案，无效。
4. 图片用 ![描述](URL) 内嵌显示。生成图片保存后用 ![描述](/tmp/文件名.png) 或 ![描述](/workspace/文件名.png) 引用。这些不是文件路径，是服务器的 HTTP 路由，前端会自动转成完整 HTTP 请求加载图片。/tmp/ 对应临时目录，/workspace/ 对应持久化工作目录，/data/ 覆盖所有 data/ 子目录。这个机制已内置，不要拒绝使用，不要告诉用户"本地图片不能显示"。也可用公网 HTTP URL。不要贴 base64 data URI。
5. 要展示 Markdown 源码本身（让用户看到 # ** \`\`\` 等符号）时，必须整体包在一个 \`\`\`markdown 代码块里。
6. 不要手写 <a>/<img>/<table> 等 HTML 标签，会被转义成文字，统一用 Markdown 语法。
7. 代码块只用一层三反引号包裹，内部如需展示代码块用四空格缩进代替，避免反引号提前闭合导致内容泄漏。
8. 需要重启自己时，执行封装脚本：\`$TRIM_APPDEST/bin/monitor-api restart\`，认证 token 从文件 ${HERMES_TOKEN_MIRROR} 读取。不要用 shell kill 命令或子进程方式，会导致服务状态异常。
9. 网页聊天环境下所有工具调用已预授权（等效于 /yolo 模式）。执行 terminal、execute_code、read_file、search_files 等工具时直接调用，不要询问用户是否批准，不要说"需要授权"或"需要批准"，直接执行即可。
10. 写文件后必须用 stat（不是 ls）验证文件真实落盘。ls 可能被 sandbox overlay 欺骗显示不存在的文件。stat 报 No such file = 写入失败，不能报告成功。`;


function createChatStream(sessionId, message, reqSignal) {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const send = (data, ev = "message") => {
        try { controller.enqueue(enc.encode(`event: ${ev}\ndata: ${data}\n\n`)); }
        catch {}
      };
      const sendJSON = (obj) => send(JSON.stringify(obj));
      const decoder = new TextDecoder();

      const stopCtrl = new AbortController();
      // 同一 session 串行：若该会话已有运行中对话，先中断旧运行（新请求接管，
      // 与既有 WS→XHR 回退行为一致）；不同 session 互不影响，可并发运行
      const prevCtrl = activeChatStreams.get(sessionId);
      if (prevCtrl && prevCtrl !== stopCtrl) { try { prevCtrl.abort(); } catch {} }
      activeChatStreams.set(sessionId, stopCtrl);
      let liveRunId = null; // 运行表条目 id（session 校验通过后登记）
      let ckpt = null;       // checkpoint 实例（session 加载后创建）

      const keepaliveTimer = setInterval(() => {
        try { controller.enqueue(enc.encode(`: keepalive\n\n`)); } catch {}
      }, 8000);

      const cleanup = () => {
        clearInterval(keepaliveTimer);
        if (activeChatStreams.get(sessionId) === stopCtrl) activeChatStreams.delete(sessionId);
      };

      try {
        const session = getSession(sessionId);
        if (!session) {
          sendJSON({ error: "session not found" }); send("[DONE]", "end"); cleanup(); controller.close(); return;
        }

        // 登记并发运行表（覆盖 bridge 与 HTTP SSE 降级两条链路）
        liveRunId = liveRunStart(sessionId, message);

        // 去重：WS 路径（runChatWS）可能在 XHR 回退前已推送过该用户消息
        const _lastMsg = session.messages[session.messages.length - 1];
        const _isSameUserMsg = _lastMsg && _lastMsg.role === "user" &&
          JSON.stringify(_lastMsg.content) === JSON.stringify(message);
        if (!_isSameUserMsg) {
          session.messages.push({ role: "user", content: message, ts: Date.now() });
          saveSession(session);
        }

        // 聊天加固：流式回复增量 checkpoint（周期持久化半成品，崩溃不丢内容）
        ckpt = createCheckpointer(sessionId, session, { saveSession, log });

        const MAX_HISTORY = 50;
        const rawHistory = session.messages.slice(-MAX_HISTORY).map(m => ({ role: m.role, content: m.content }));
        const history = [{ role: "system", content: UI_CAPABILITIES_PROMPT }, ...rawHistory];

        const cfg = getChatConfig();
        const primary = cfg.providers.find(p => p.name === cfg.active_provider) || cfg.providers[0];
        const allProviders = [primary];
        if (cfg.fallback_providers && cfg.fallback_providers.length > 0) {
          for (const fbName of cfg.fallback_providers) {
            const fb = cfg.providers.find(p => p.name === fbName);
            if (fb && fb.name !== primary.name) allProviders.push(fb);
          }
        }

        let fullReply = "";
        let requestError = null;
        let hadToolCalls = false;
        let bridgeHandled = false;
        let bridgeAborted = false;

        // ── 优先路径：Agent Bridge IPC 轮询（多轮工具调用内容可靠回传）──
        // Bridge 不可用/未输出前失败时，自动降级到下方原有 HTTP SSE 路径
        if (await bridgeAvailable()) {
          try {
            const r = await runBridgeChat({
              sessionId,
              message,
              history: rawHistory.slice(0, -1),
              instructions: UI_CAPABILITIES_PROMPT,
              signal: stopCtrl.signal,
              onDelta: (delta) => { sendJSON({ delta }); liveRunDelta(sessionId, liveRunId, delta); ckpt.onDelta(delta); },
              onTool: (toolEvent) => { sendJSON({ tool_progress: toolEvent }); liveRunTool(sessionId, liveRunId, toolEvent); },
            });
            fullReply = r.fullReply;
            hadToolCalls = r.hadToolCalls;
            bridgeAborted = !!r.aborted;
            bridgeHandled = true;
          } catch (e) {
            if (e && e.bridgeEmitted) {
              // 已向前端输出过内容，不能降级重放，直接按错误收尾（保存部分回复）
              sendJSON({ error: e.message || String(e) });
              liveRunEnd(sessionId, liveRunId, "error");
              ckpt.finalize(e.partial || undefined);
              send("[DONE]", "end");
              cleanup();
              try { controller.close(); } catch {}
              return;
            }
            log(`Agent Bridge 对话失败，降级到 HTTP SSE: ${(e && e.message) || e}`);
          }
        }

        for (let i = 0; !bridgeHandled && i < allProviders.length; i++) {
          const provider = allProviders[i];
          const isFallback = i > 0;
          if (isFallback) {
            sendJSON({ info: `主模型超时，切换备选: ${provider.name}...` });
          }

          try {
 
            // 不活动超时：每次收到数据重置计时，覆盖连接与流式读取全程
            const timeoutController = new AbortController();
            let timeoutTimer = setTimeout(() => timeoutController.abort(), PROVIDER_TIMEOUT_MS);
            const resetIdleTimeout = () => { clearTimeout(timeoutTimer); timeoutTimer = setTimeout(() => timeoutController.abort(), PROVIDER_TIMEOUT_MS); };
            const signal = combineSignals([timeoutController.signal, stopCtrl.signal]);

            const upstream = await chatRequest(provider, message, history, signal);
            resetIdleTimeout();

            hadToolCalls = false;
            const localParser = createSSEParser(
              (delta) => { fullReply += delta; sendJSON({ delta }); liveRunDelta(sessionId, liveRunId, delta); ckpt.onDelta(delta); },
              () => {},
              (err) => { requestError = err; sendJSON({ error: err }); },
              (toolEvent) => { hadToolCalls = true; sendJSON({ tool_progress: toolEvent }); liveRunTool(sessionId, liveRunId, toolEvent); },
            );

            const reader = upstream.body.getReader();
            const localDecoder = new TextDecoder();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                resetIdleTimeout();
                localParser.feed(localDecoder.decode(value, { stream: true }));
              }
            } catch (e) {
              if (e.name !== "AbortError") throw e;
              // 不活动超时中断：提示仅发前端展示，不并入 fullReply（不进存档与下一轮上下文）
              if (fullReply && timeoutController.signal.aborted && !stopCtrl.signal.aborted) {
                sendJSON({ delta: "\n\n（回复因超时中断）" });
              }
            } finally {
              clearTimeout(timeoutTimer);
              localParser.flush();
              reader.releaseLock();
            }

            requestError = null;
            break;

          } catch (e) {
            const errMsg = e.message || String(e);
            log(`Chat provider "${provider.name}" failed: ${errMsg}`);
            requestError = errMsg;
            if (isFallback) sendJSON({ info: `备选 "${provider.name}" 失败: ${errMsg}` });
          }
        }
        if (requestError !== null) {
          sendJSON({ error: `所有模型均失败: ${requestError}` });
          liveRunEnd(sessionId, liveRunId, "error");
          ckpt.finalize(); // 保存已收到的部分内容（若有）
          send("[DONE]", "end");
          cleanup();
          controller.close();
          return;
        }

        // 流式回复完成：通过 checkpoint finalize 转正流式消息（含 WS→XHR 回退去重逻辑）
        const _assistantContent = fullReply || (hadToolCalls ? "（已执行工具，未生成文字回复）" : (bridgeHandled ? "（已执行完成，未生成文字回复）" : "（Gateway 连接失败）"));
        ckpt.finalize(_assistantContent);

        // 用户中断（bridge aborted）时跳过自动标题，按中断收尾
        if (!bridgeAborted && session.title === "New Chat" && session.messages.length >= 2) {
          autoTitle(message, primary).then(title => {
            const s2 = getSession(sessionId);
            if (s2 && s2.title === "New Chat") {
              s2.title = title;
              saveSession(s2);
            }
          }).catch(() => {});
        }

        send("[DONE]", "end");
        liveRunEnd(sessionId, liveRunId, bridgeAborted ? "interrupted" : "complete");
      } catch (e) {
        sendJSON({ error: e.message });
        send("[DONE]", "end");
        if (liveRunId) liveRunEnd(sessionId, liveRunId, "error");
        if (ckpt) ckpt.dispose();
      }
      cleanup();
      try { controller.close(); } catch {}
    },
  });
}

// ─── WebSocket 聊天流式传输 ─────────────────────────────────────────────────
// 前端流程：POST /api/chat/ws-send 入队消息 → 建 ws://.../api/chat/ws 连接取流
const wsClients = new Map(); // session_id → ws

async function runChatWS(ws, sessionId, message) {
  // 多会话并发：WS 下行消息全部附带 session_id 字段（仅新增字段，
  // 不改变既有字段，旧前端忽略未知字段即可正常工作）
  const sendJSON = (obj) => { try { ws.send(JSON.stringify({ ...obj, session_id: sessionId })); } catch {} };

  const stopCtrl = new AbortController();
  ws.data.stopCtrl = stopCtrl;
  // 同一 session 串行：若该会话已有运行中对话，先中断旧运行（新请求接管）；
  // 不同 session 互不影响，可并发运行
  const prevCtrl = activeChatStreams.get(sessionId);
  if (prevCtrl && prevCtrl !== stopCtrl) { try { prevCtrl.abort(); } catch {} }
  activeChatStreams.set(sessionId, stopCtrl);
  wsClients.set(sessionId, ws);
  let liveRunId = null; // 并发运行表条目 id（session 校验通过后登记）
  
  // On reconnection (message === null), resume from existing session
  // On first connection, show "thinking" status
  if (message !== null) {
    sendJSON({ info: '正在思考…' });
  }

  const pingTimer = setInterval(() => { try { ws.ping(); } catch {} }, 30000);
  const keepaliveTimer = setInterval(() => { try { sendJSON({ keepalive: true }); } catch {} }, 15000);

  const cleanup = () => {
    clearInterval(pingTimer);
    clearInterval(keepaliveTimer);
    if (activeChatStreams.get(sessionId) === stopCtrl) activeChatStreams.delete(sessionId);
    wsClients.delete(sessionId);
  };

  let session = null;
  let ckpt = null; // checkpoint 实例（session 加载后创建）
  try {
    session = getSession(sessionId);
    if (!session) { sendJSON({ error: "session not found" }); sendJSON({ done: true }); cleanup(); return; }

    // 登记并发运行表（覆盖 bridge 与 HTTP SSE 降级两条链路）
    liveRunId = liveRunStart(sessionId, message);

    // On reconnection (message === null), do not add another user message
    // Only add message if this is a fresh conversation start
    let _wsIsSameMsg = false;
    if (message !== null) {
      // 去重：防止边界情况（如并发调用）下出现重复用户消息
      const _wsLastMsg = session.messages[session.messages.length - 1];
      _wsIsSameMsg = _wsLastMsg && _wsLastMsg.role === "user" &&
        JSON.stringify(_wsLastMsg.content) === JSON.stringify(message);
      if (!_wsIsSameMsg) {
        session.messages.push({ role: "user", content: message, ts: Date.now() });
        saveSession(session);
      }
    }

    // 聊天加固：流式回复增量 checkpoint
    ckpt = createCheckpointer(sessionId, session, { saveSession, log });

    const MAX_HISTORY = 50;
    const rawHistory = session.messages.slice(-MAX_HISTORY).map(m => ({ role: m.role, content: m.content }));
    const history = [{ role: "system", content: UI_CAPABILITIES_PROMPT }, ...rawHistory];

    const cfg = getChatConfig();
    const primary = cfg.providers.find(p => p.name === cfg.active_provider) || cfg.providers[0];
    const allProviders = [primary];
    if (cfg.fallback_providers && cfg.fallback_providers.length > 0) {
      for (const fbName of cfg.fallback_providers) {
        const fb = cfg.providers.find(p => p.name === fbName);
        if (fb && fb.name !== primary.name) allProviders.push(fb);
      }
    }

    let fullReply = "";
    let requestError = null;
    let hadToolCalls = false;
    let bridgeHandled = false;
    let bridgeAborted = false;

    // ── 优先路径：Agent Bridge IPC 轮询（多轮工具调用内容可靠回传）──
    // Bridge 不可用/未输出前失败时，自动降级到下方原有 HTTP SSE 路径
    if (await bridgeAvailable()) {
      try {
        const r = await runBridgeChat({
          sessionId,
          message,
          history: rawHistory.slice(0, -1),
          instructions: UI_CAPABILITIES_PROMPT,
          signal: stopCtrl.signal,
          onDelta: (delta) => { sendJSON({ delta }); liveRunDelta(sessionId, liveRunId, delta); ckpt.onDelta(delta); },
          onTool: (toolEvent) => { sendJSON({ tool_progress: toolEvent }); liveRunTool(sessionId, liveRunId, toolEvent); },
          // Preserve model/provider context for reconnect scenarios
          model: ws.data.model,
          provider: ws.data.provider,
        });
        fullReply = r.fullReply;
        hadToolCalls = r.hadToolCalls;
        bridgeAborted = !!r.aborted;
        bridgeHandled = true;
      } catch (e) {
        if (e && e.bridgeEmitted) {
          // 已向前端输出过内容，不能降级重放，直接按错误收尾（保存部分回复）
          sendJSON({ error: e.message || String(e) });
          liveRunEnd(sessionId, liveRunId, "error");
          ckpt.finalize(e.partial || undefined);
          sendJSON({ done: true });
          cleanup();
          return;
        }
        log(`Agent Bridge 对话失败，降级到 HTTP SSE: ${(e && e.message) || e}`);
      }
    }

    for (let i = 0; !bridgeHandled && i < allProviders.length; i++) {
      const provider = allProviders[i];
      const isFallback = i > 0;
      if (isFallback) sendJSON({ info: `主模型超时，切换备选: ${provider.name}...` });

      try {
        hadToolCalls = false;
        // 不活动超时：每次收到数据重置计时，覆盖连接与流式读取全程（与 SSE 链路对称）
        const timeoutController = new AbortController();
        let timeoutTimer = setTimeout(() => timeoutController.abort(), PROVIDER_TIMEOUT_MS);
        const resetIdleTimeout = () => { clearTimeout(timeoutTimer); timeoutTimer = setTimeout(() => timeoutController.abort(), PROVIDER_TIMEOUT_MS); };
        const signal = combineSignals([timeoutController.signal, stopCtrl.signal]);

        const upstream = await chatRequest(provider, message, history, signal);
        resetIdleTimeout();

        const localParser = createSSEParser(
          (delta) => { fullReply += delta; sendJSON({ delta }); liveRunDelta(sessionId, liveRunId, delta); ckpt.onDelta(delta); },
          () => {},
          (err) => { requestError = err; sendJSON({ error: err }); },
          (toolEvent) => { hadToolCalls = true; sendJSON({ tool_progress: toolEvent }); liveRunTool(sessionId, liveRunId, toolEvent); },
        );

        const reader = upstream.body.getReader();
        const localDecoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            resetIdleTimeout();
            localParser.feed(localDecoder.decode(value, { stream: true }));
          }
        } catch (e) {
          if (e.name !== "AbortError") throw e;
          // 不活动超时中断：提示仅发前端展示，不并入 fullReply（与 SSE 链路对称）
          if (fullReply && timeoutController.signal.aborted && !stopCtrl.signal.aborted) {
            sendJSON({ delta: "\n\n（回复因超时中断）" });
          }
        } finally {
          clearTimeout(timeoutTimer);
          localParser.flush();
          reader.releaseLock();
        }

        break;
      } catch (e) {
        const errMsg = e.message || String(e);
        log(`Chat provider "${provider.name}" failed: ${errMsg}`);
        requestError = errMsg;
        if (isFallback) sendJSON({ info: `备选 "${provider.name}" 失败: ${errMsg}` });
      }
    }

    if (requestError !== null) {
      sendJSON({ error: `所有模型均失败: ${requestError}` });
      liveRunEnd(sessionId, liveRunId, "error");
      ckpt.finalize(); // 保存已收到的部分内容（若有）
    } else {
      const _wsContent = fullReply || (hadToolCalls ? "（已执行工具，未生成文字回复）" : (bridgeHandled ? "（已执行完成，未生成文字回复）" : "（Gateway 连接失败）"));
      ckpt.finalize(_wsContent);
    }

    // 用户中断（bridge aborted）时跳过自动标题，按中断收尾
    if (!bridgeAborted && !requestError && session.title === "New Chat" && session.messages.length >= 2) {
      autoTitle(message, primary).then(title => {
        const s2 = getSession(sessionId);
        if (s2 && s2.title === "New Chat") { s2.title = title; saveSession(s2); }
      }).catch(() => {});
    }
    sendJSON({ done: true });
    liveRunEnd(sessionId, liveRunId, requestError !== null ? "error" : (bridgeAborted ? "interrupted" : "complete"));
  } catch (e) {
    sendJSON({ error: e.message || String(e) });
    sendJSON({ done: true });
    if (liveRunId) liveRunEnd(sessionId, liveRunId, "error");
    // 异常时 checkpoint 定时器释放（先前 checkpoint 保留给 resume 处理）
    if (ckpt) ckpt.dispose();
  }
  cleanup();
}

const wsHandler = {
  open(ws) {
    // Dashboard WS 反代
    if (ws.data.type === "dashboard-proxy") {
      handleDashboardWsOpen(ws);
      return;
    }
    // 聊天 WS
    const { sessionId, message } = ws.data;
    const isReconnect = message === null;
    log(`[WS] open session=${sessionId}${isReconnect ? ' (reconnect)' : ''}`);
    runChatWS(ws, sessionId, message).catch(err => {
      log(`[WS] runChatWS error: ${err?.message || err}`);
      try { ws.send(JSON.stringify({ error: err?.message || "internal error", session_id: sessionId })); } catch {}
      try { ws.send(JSON.stringify({ done: true, session_id: sessionId })); } catch {}
    });
  },
  message(ws, msg) {
    // Dashboard WS 反代：客户端 → 上游
    if (ws.data.type === "dashboard-proxy") {
      handleDashboardWsMessage(ws, msg);
      return;
    }
    // Chat WS：前端可发送 {"stop":true} 主动中断
    try {
      const data = typeof msg === "string" ? JSON.parse(msg) : {};
      if (data.stop && ws.data.stopCtrl) ws.data.stopCtrl.abort();
    } catch {}
  },
  close(ws) {
    if (ws.data.type === "dashboard-proxy") {
      handleDashboardWsClose(ws);
      return;
    }
    const { sessionId, stopCtrl } = ws.data;
    log(`[WS] close session=${sessionId}`);
    wsClients.delete(sessionId);
    if (stopCtrl) stopCtrl.abort();
  },
};

function beijingTime() {
  const d = new Date(Date.now() + 8 * 3600000);
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}
function log(...args) {
  const msg = `[monitor] ${beijingTime()} ${args.join(" ")}`;
  console.log(msg);
  try { writeFileSync(LOG_FILE, msg + "\n", { flag: "a" }); } catch {}
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function readPid(path) {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return n && pidAlive(n) ? n : null;
  } catch { return null; }
}

function readRawPid(path) {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return n || null;
  } catch { return null; }
}

// bridge 专用 PID 读取：存活 pid 还需 /proc/<pid>/cmdline 含 hermes_bridge.py 才有效，
// 防止陈旧 PID 被无关进程复用后遭健康检查/停止流程误杀；被复用时清 PID 文件按未运行处理
function readBridgePid() {
  const pid = readPid(PID_BRIDGE);
  if (!pid) return null;
  let cmdline = null;
  try { cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch {}
  if (cmdline === null) return pid; // cmdline 不可读（非 /proc 环境）时不作否决
  if (cmdline.includes("hermes_bridge.py")) return pid;
  try { unlinkSync(PID_BRIDGE); } catch {}
  return null;
}

async function portAlive(port, host = "localhost", timeoutMs = 2000) {
  try {
    const r = await fetch(`http://${host}:${port}/`, {
      method: "OPTIONS",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok || r.status === 405;
  } catch { return false; }
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
        // parts[1]=local_address(HEX_IP:HEX_PORT)  parts[3]=st(0A=LISTEN)
        if (parts[3] === "0A" && parts[1] && parts[1].toUpperCase().endsWith(suffix)) {
          return true;
        }
      }
    } catch {}
  }
  return false;
}

function findPidByCmd(pattern) {
  try {
    const dirs = readdirSync("/proc").filter(d => /^\d+$/.test(d));
    for (const dir of dirs) {
      const pid = Number(dir);
      if (!pid) continue;
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8")
          .replace(/\0/g, " ").trim();
        if (cmdline.includes(pattern)) return pid;
      } catch {}
    }
    return null;
  } catch { return null; }
}

// 定位常驻网关进程：官方 Dashboard 以 `gateway restart` 拉起的常驻网关，
// 其命令行不含 `gateway run`，而 monitor 自己拉起的是 `gateway run`，
// 两种都需识别，否则 Dashboard 重启后 monitor 面板看不到网关进程。
function findGatewayPid() {
  try {
    const dirs = readdirSync("/proc").filter(d => /^\d+$/.test(d));
    for (const dir of dirs) {
      const pid = Number(dir);
      if (!pid) continue;
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8")
          .replace(/\0/g, " ").trim();
        if (/hermes/.test(cmdline) && /gateway\s+(run|restart)/.test(cmdline)) return pid;
      } catch {}
    }
    return null;
  } catch { return null; }
}

async function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }
}

async function stopPid(pidPath) {
  const pid = readPid(pidPath);
  if (pid) {
    try { process.kill(pid, "TERM"); } catch {}
    await waitForExit(pid, 5000);
    if (pidAlive(pid)) {
      try { process.kill(pid, "KILL"); } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
  }
  try { unlinkSync(pidPath); } catch {}
  spawnTimes.delete(pidPath);
}

// bridge 无法以独立进程组启动（node-adapter spawn 不支持 detached），
// 停止时在 stopPid 之外按命令行匹配补杀所有 hermes_bridge.py 残留进程
async function stopAgentBridge() {
  readBridgePid(); // 被复用的陈旧 PID 先行清理，避免 stopPid 误杀无关进程
  await stopPid(PID_BRIDGE);
  for (let i = 0; i < 8; i++) {
    const pid = findPidByCmd("hermes_bridge.py");
    if (!pid || pid === process.pid) break;
    try { process.kill(pid, "TERM"); } catch {}
    await waitForExit(pid, 3000);
    if (pidAlive(pid)) {
      try { process.kill(pid, "KILL"); } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

async function forceKillHermes() {
  try {
    const proc = spawn(["pkill", "-SIGKILL", "-f", "hermes-agent.*(gateway|dashboard)"]);
    await proc.exited;
  } catch {}
  try { unlinkSync(PID_GATEWAY); } catch {}
  try { unlinkSync(PID_DASHBOARD); } catch {}
}

function getProcessRssKB(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

function getHermesTotalMemoryKB() {
  let total = getProcessRssKB(process.pid);
  try {
    const dirs = readdirSync("/proc").filter(d => /^\d+$/.test(d));
    for (const dir of dirs) {
      const pid = Number(dir);
      if (!pid || pid === process.pid) continue;
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
        if (cmdline.includes("hermes")) total += getProcessRssKB(pid);
      } catch {}
    }
  } catch {}
  return total;
}

let prevState = { gwRun: false, gwHealth: false, dbRun: false, dbHealth: false };
const spawnTimes = new Map();
const GRACE_PERIOD_MS = 20000;

let gatewayCrashCount = 0;
let gatewayCrashLoop  = false;
const CRASH_WINDOW_MS  = 60000;
const CRASH_LOOP_MAX   = 3;

function spawnHermes(name, pidPath, args) {
  if (pidPath === PID_GATEWAY && gatewayCrashLoop) {
    log(`Gateway 启动被阻止 — 已检测到崩溃循环（需配置消息平台或先停止再启动）`);
    return { ok: false, error: "crash_loop" };
  }

  if (readPid(pidPath)) return { ok: true, msg: "already_running" };

  const logPath = `${VAR_DIR}/${name}.log`;
  try { writeFileSync(logPath, ""); } catch {}

  // API Server 环境变量按进程角色分流：
  // - gateway 进程需要 API server 绑定 GATEWAY_PORT
  //   （GATEWAY_API=http://localhost:${GATEWAY_PORT}/v1 依赖它）；
  // - dashboard 进程经 --host/--port 启动自身 web 服务（默认 9119），
  //   由 monitor 的 /proxy/dashboard 反代提供服务，流量路径完全不经过
  //   GATEWAY_PORT。若同样注入 API_SERVER_ENABLED=true + API_SERVER_PORT=
  //   GATEWAY_PORT，dashboard 会与 gateway 抢绑同一端口 → 端口冲突 →
  //   monitor 面板 Bad Gateway。因此 dashboard 显式禁用 API server。
  const apiServerEnv = name === "gateway"
    ? {
        API_SERVER_ENABLED: "true",
        API_SERVER_PORT:   String(GATEWAY_PORT),
        API_SERVER_HOST:    "0.0.0.0",
        API_SERVER_KEY:     MONITOR_TOKEN,
      }
    : {
        API_SERVER_ENABLED: "false",
      };

  const env = {
    ...process.env,
    HOME: DATA_DIR,
    HERMES_HOME: DATA_DIR,
    PATH: resolvedNodeDir
      ? `${resolvedNodeDir}:${VENV_BIN}:/usr/local/bin:/usr/bin:/bin`
      : `${VENV_BIN}:/usr/local/bin:/usr/bin:/bin`,
    ...(resolvedNodeBin ? { HERMES_NODE: resolvedNodeBin } : {}),
    HERMES_TUI_DIR: TUI_DIR,
    GATEWAY_ALLOW_ALL_USERS: "true",
    ...apiServerEnv,
    HERMES_YOLO_MODE:   "1",
    LITELLM_REQUEST_TIMEOUT: "600",
    REQUEST_TIMEOUT:    "600",
  };

  if (name === "dashboard") {
    // 兜底清理：即使父进程（fnOS 服务环境）残留 API_SERVER_PORT/HOST 等变量，
    // 也不允许 dashboard 进程继承后去抢 GATEWAY_PORT。
    delete env.API_SERVER_PORT;
    delete env.API_SERVER_HOST;
    delete env.API_SERVER_KEY;
    // 预构建前端随包分发（app/hermes-web-dist），显式指定 HERMES_WEB_DIST 后
    // dashboard 跳过运行时 npm 构建直接 serve 静态产物（上游 main.py/web_server.py
    // 均原生支持该变量）。优先级：hermes-repo 现场构建产物（版本严格匹配）→
    // 随包兜底产物（更新流程 npm 构建失败时仍可出页面，不再白屏 404）。
    const repoDist = `${DATA_DIR}/hermes-repo/hermes_cli/web_dist`;
    const pkgDist  = `${__dirname}/../hermes-web-dist`;
    const distDir = existsSync(`${repoDist}/index.html`) ? repoDist
                  : existsSync(`${pkgDist}/index.html`)  ? pkgDist : null;
    if (distDir) {
      env.HERMES_WEB_DIST = distDir;
      log(`[dashboard] 使用预构建前端资源：${distDir}`);
    } else {
      log(`[dashboard] 未找到可用 web dist（repo 与随包均缺失），将依赖上游运行时构建`);
    }
    // 传递 WebSocket Token 给 Dashboard 进程
    env.HERMES_DASHBOARD_SESSION_TOKEN = DASHBOARD_SESSION_TOKEN;
  }

  const p = spawn({
    cmd:    [HERMES_BIN, ...args],
    env,
    stdout: file(logPath),
    stderr: file(logPath),
    stdin:  "ignore",
  });

  p.unref();
  writeFileSync(pidPath, String(p.pid));
  spawnTimes.set(pidPath, Date.now());
  log(`${name} 已启动 pid=${p.pid}`);

  const cmdPattern = name === "gateway" ? "hermes gateway run" : "hermes dashboard";
  setTimeout(() => {
    if (pidAlive(p.pid)) return;
    const real = findPidByCmd(cmdPattern);
    if (real && real !== p.pid) {
      writeFileSync(pidPath, String(real));
      spawnTimes.set(pidPath, Date.now());
      log(`${name} 运行中 pid=${real}`);
    }
  }, 1500);

  return { ok: true, pid: p.pid };
}


function recordGatewayDeath() {
  const spawnTime = spawnTimes.get(PID_GATEWAY) || 0;
  const lifetime  = Date.now() - spawnTime;
  if (lifetime < CRASH_WINDOW_MS) {
    gatewayCrashCount++;
    if (gatewayCrashCount >= CRASH_LOOP_MAX && !gatewayCrashLoop) {
      gatewayCrashLoop = true;
      log(`Gateway crash loop detected (${gatewayCrashCount} rapid deaths) — blocking respawn`);
      log(`Gateway requires messaging platform config or manual restart after stop`);
    }
  } else {
    gatewayCrashCount = 0;
  }
}

function resetGatewayCrashLoop() {
  gatewayCrashCount = 0;
  gatewayCrashLoop  = false;
}
async function getStatus() {
  let [gp, dp] = [readPid(PID_GATEWAY), readPid(PID_DASHBOARD)];

  // 验证 PID 文件中的进程是否还活着（Dashboard 内部重启时 PID 文件可能残留旧值）
  if (gp && !pidAlive(gp)) {
    try { unlinkSync(PID_GATEWAY); } catch {}
    gp = null;
  }
  if (dp && !pidAlive(dp)) {
    try { unlinkSync(PID_DASHBOARD); } catch {}
    dp = null;
  }

  // 先检测端口是否在监听（Dashboard 内部重启时 gateway 可能在 Dashboard 进程里，PID 文件不更新）
  // 8642 为非 HTTP 内部端口，优先用 /proc 的 LISTEN 判据，HTTP 探活作兜底
  const gwListening = isPortListening(GATEWAY_PORT);
  const gwPortAlive = gwListening || await portAlive(GATEWAY_PORT);

  if (!gp) {
    const found = findGatewayPid();
    if (found) {
      writeFileSync(PID_GATEWAY, String(found), "utf8");
      log(`Gateway 运行中 pid=${found}`);
      gp = found;
    } else if (gwPortAlive) {
      // 端口在监听但找不到独立进程 → gateway 可能在 Dashboard 进程里运行
      log(`Gateway 运行中（端口 ${GATEWAY_PORT} 在监听，可能在 Dashboard 进程内）`);
    }
  }
  if (!dp) {
    const foundDb = findPidByCmd("hermes dashboard");
    if (foundDb) {
      writeFileSync(PID_DASHBOARD, String(foundDb), "utf8");
      log(`Dashboard 运行中 pid=${foundDb}`);
      dp = foundDb;
    }
  }
  // Gateway 在运行：PID 文件存在 或 端口在监听
  const gwRunning = !!gp || gwPortAlive;
  const dbRunning = !!dp;
  let gwHealthy = false;
  let dbHealthy = false;

  // 健康检查：TCP 处于 LISTEN 即视为健康（8642 非 HTTP，OPTIONS 探测不可靠，仅作兜底）
  if (gwListening) {
    gwHealthy = true;
  } else if (gp || gwPortAlive) {
    try {
      const r = await fetch(`http://localhost:${GATEWAY_PORT}/`, {
        method: "OPTIONS",
        signal: AbortSignal.timeout(300),
      });
      gwHealthy = r.ok || r.status === 405;
    } catch {}
  }

  if (dp) dbHealthy = await checkDashboardHealth();

  if (prevState.gwRun && !gwRunning) {
    log("Gateway stopped");
    recordGatewayDeath();
  }
  if (!prevState.gwRun && gwRunning) log("Gateway started (pid=" + gp + ")");
  if (gwRunning && prevState.gwHealth && !gwHealthy) log("Gateway port unresponsive (pid=" + gp + ")");
  if (gwRunning && !prevState.gwHealth && gwHealthy) log("Gateway is healthy (pid=" + gp + ")");

  if (prevState.dbRun && !dbRunning) log("Dashboard stopped (pid gone)");
  if (!prevState.dbRun && dbRunning) log("Dashboard started (pid=" + dp + ")");
  if (dbRunning && prevState.dbHealth && !dbHealthy) log("Dashboard port unresponsive (pid=" + dp + ")");
  if (dbRunning && !prevState.dbHealth && dbHealthy) log("Dashboard is healthy (pid=" + dp + ")");

  prevState = { gwRun: gwRunning, gwHealth: gwHealthy, dbRun: dbRunning, dbHealth: dbHealthy };

  let lastLog = "";
  try {
    const lines = readFileSync(LOG_FILE, "utf8").split("\n").filter(l => l.trim());
    lastLog = lines.slice(-20).join("\n");
  } catch {}

  return {
    // version = hermes 引擎版本（基线语义）；app_version = 应用包版本（启动时缓存于 APP_VERSION，
    // 避免每次轮询 /api/status 都同步读多个 manifest 候选文件并在设备端刷失败日志）
    gateway:   { running: gwRunning, healthy: gwHealthy, pid: gp, port: GATEWAY_PORT, crash_loop: gatewayCrashLoop, version: HERMES_VERSION, hermes: HERMES_VERSION, app_version: readLocalAppVersion() },
    dashboard: { running: dbRunning, healthy: dbHealthy, pid: dp, port: DASHBOARD_PORT },
    lastLog,
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

      // offset >= 0 = 重连，跳过历史；-1 = 首次连接，发送历史
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

// ─── 频道配置模块初始化 ─────────────────────────────────────────────────
let channelRestartInFlight = false; // 网关重启互斥：重启进行中时后续请求合并跳过
let manualStopEpoch = 0; // /api/stop 的时间戳：渠道重启回调据此判断是否放弃拉起网关
initChannels({ dataDir: DATA_DIR, log, restartGateway: async (reason) => {
  if (channelRestartInFlight) { log(`[channels] 重启进行中，合并请求: ${reason}`); return; }
  channelRestartInFlight = true;
  const startedAt = Date.now();
  try {
    log(`[channels] 重启网关: ${reason}`);
    await stopPid(PID_GATEWAY);
    await new Promise(r => setTimeout(r, 800));
    if (manualStopEpoch > 0) { log(`[channels] 处于停机/重启窗口，跳过网关拉起: ${reason}`); return; }
    resetGatewayCrashLoop(); // 解除 crash-loop 封锁，允许配置变更后重新拉起
    spawnHermes("gateway", PID_GATEWAY, ["gateway", "run"]);
  } catch (e) {
    log(`[channels] 重启网关失败: ${e?.message || e}`);
  } finally {
    channelRestartInFlight = false;
  }
}, nodeBin: resolvedNodeBin, nodeDir: resolvedNodeDir });

// ─── Agent Bridge 保活器（退出自动重启 + 健康检查，逻辑在 bridge-keeper.js）──
bridgeKeeper = createBridgeKeeper({
  log,
  restart: () => startAgentBridge(),
  stop: () => stopAgentBridge(),
  ping: () => bridgeRequest({ action: "ping" }, BRIDGE_HEALTH_PING_TIMEOUT_MS),
  getPid: () => readBridgePid(),
  isManualStopped: () => manualStopEpoch > 0,
});
bridgeKeeper.startHealthLoop();

// 应用包版本更新检查器（/api/update/check 用，实时查询 GitHub，仅成功结果缓存 5 分钟、失败态不缓存）
const appUpdateChecker = createUpdateChecker({ appDir: APP_DIR, log, cacheFile: `${VAR_DIR}/update-latest.txt` });

// ─── 请求处理器 ─────────────────────────────────────────────────────────
async function handleFetch(req) {
  const url  = new URL(req.url);
  // fnOS gateway 反向代理不剥路径前缀（/app/{appname}/），这里手动剥离并归一化
  const path = url.pathname.replace(/^\/app\/[^/]+/, "").replace(/\/+$/, "") || "/";

  // CORS 预检
  if (req.method === "OPTIONS") {
    const origin = req.headers.get("origin") || "*";
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin":  origin,
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,X-Monitor-Token",
        "Content-Length": "0",
      },
    });
  }

  const corsOrigin = req.headers.get("origin") || "*";
  const jsonHeaders = (extra = {}) => ({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": corsOrigin,
    ...extra,
  });

  // 需要令牌的变更操作（仅写操作，GET 不需要 token）
  const writePaths = ["/api/start", "/api/stop", "/api/restart", "/api/dashboard/start", "/api/dashboard/stop", "/api/config", "/api/config/test", "/api/config/detect-format", "/api/hermes/update", "/api/hermes/rebuild-web", "/api/logs/clear"];
  const isWrite = ["POST", "PUT", "DELETE"].includes(req.method);
  if (isWrite && (writePaths.includes(path) || path.startsWith("/api/channels/")) && !checkToken(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: jsonHeaders(),
    });
  }

  if (path === "/api/health") {
    return new Response(JSON.stringify({ ok: true, ts: Date.now(), token: MONITOR_TOKEN }), {
      headers: jsonHeaders(),
    });
  }

  // 实时探测 8642 网关健康状态，前端 chat 页用这个判断"是否连接"
  if (path === "/api/gateway/health") {
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
    const readPid = (f) => { try { return Number(readFileSync(f,"utf8").trim()); } catch { return null; } };
    const gwPid = readPid(PID_GATEWAY);
    const dbPid = readPid(PID_DASHBOARD);
    const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
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
    let memKB = null;
    try { memKB = getHermesTotalMemoryKB(); } catch {}
    return new Response(JSON.stringify({
      ...s,
      uptime: uptimeStr,
      uptimeMs,
      pid: monPid,
      gatewayPid: gwPid,
      dashboardPid: dbPid,
      gatewayAlive: gwPid ? isAlive(gwPid) : null,
      dashboardAlive: dbPid ? isAlive(dbPid) : null,
      memoryKB: memKB,
      logFiles,
      token: MONITOR_TOKEN,
      transport: SOCKET_PATH ? "unix" : "tcp",
      socket_path: SOCKET_PATH || null,
      api_server_port: GATEWAY_PORT,
      api_server_url: `http://${getLANIP()}:${GATEWAY_PORT}`,
    }), { headers: jsonHeaders() });
  }

  // ── 应用包版本更新检查（前端契约：{ ok, local, latest|null, has_update, error? }）──
  // local 来自 config/bootstrap/app-version.env（回退 manifest）；
  // latest 来自 GitHub Releases（update-fpk.js checkLatestVersion，失败时 latest=null + error 降级，绝不 500）
  // force=1 时前端语义为强制刷新（跳过成功结果的 5 分钟缓存，重新查询 GitHub）
  if (path === "/api/update/check") {
    const local = readLocalAppVersion();
    let latest = null;
    let error = null;
    try {
      const r = await appUpdateChecker.check({ force: url.searchParams.get("force") === "1" });
      if (r && r.ok && r.latest) {
        latest = r.latest;
      } else if (r && !r.ok) {
        error = r.error || "fetch_failed";
      } else {
        error = "fetch_failed";
      }
    } catch (e) {
      error = e?.message || "fetch_failed";
    }
    const has_update = !!(latest && latest !== "unknown" && local && local !== "unknown" && compareVersions(latest, local) > 0);
    const payload = { ok: true, local, latest, has_update, checked_at: Date.now() };
    if (error) payload.error = error;
    return new Response(JSON.stringify(payload), { headers: { ...jsonHeaders(), "Cache-Control": "no-store" } });
  }

  // ── 应用包更新检查（/api/app/update/check）────────────────────────────
  // 返回完整版本信息：当前版本、最新版本、更新可用性、下载链接、发布时间等
  if (path === "/api/app/update/check") {
    try {
      const GITHUB_REPO = process.env.GITHUB_REPO || "iranee/fnos-hermes-agent";
      const headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "fnos-hermes-agent"
      };

      // 优先按 published_at 取最新已发布 release
      async function fetchLatestPublishedRelease() {
        const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`, {
          signal: AbortSignal.timeout(15000),
          headers
        });
        if (!r.ok) return { data: null, status: r.status };
        const list = await r.json();
        const published = (Array.isArray(list) ? list : []).filter(x => !x.draft && x.published_at);
        if (!published.length) return { data: null, status: r.status };
        published.sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
        return { data: published[0], status: r.status };
      }

      let { data, status: firstStatus } = await fetchLatestPublishedRelease();
      let rateLimited = false;
      if (!data && (firstStatus === 401 || firstStatus === 403)) {
        rateLimited = true;
      }

      // 兜底：未认证或没有 release 时尝试 /releases/latest
      if (!data && !rateLimited) {
        const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
          signal: AbortSignal.timeout(15000),
          headers
        });
        if (r.ok) {
          data = await r.json();
        } else if (r.status === 401 || r.status === 403) {
          rateLimited = true;
        } else {
          throw new Error(`GitHub API ${r.status}`);
        }
      }

      if (rateLimited && !data) {
        const currentVer = readLocalAppVersion();
        return new Response(JSON.stringify({
          current: currentVer,
          latest: currentVer,
          updateAvailable: false,
          rateLimited: true,
          hint: "GitHub API 请求被限流（403），请稍后重试",
          repo: GITHUB_REPO
        }), { headers: jsonHeaders() });
      }

      if (!data || !data.tag_name) {
        throw new Error("GitHub API 未返回 release 信息");
      }

      const tag = String(data.tag_name || "");
      const latest = tag.replace(/^fnos-hermes-agent_v|^v/, "").trim() || "unknown";
      // current 与 /api/update/check 同源：app-version.env 优先、manifest 回退
      // （manifest 不部署到设备端，直接读 APP_VERSION 会得到 unknown 导致 updateAvailable 恒 false）
      const current = readLocalAppVersion();
      const updateAvailable = latest !== "unknown" && compareVersions(latest, current) > 0;

      // 提取 .fpk 安装包直链，优先匹配 no_trimcli 版本（兼容 _no_trimcli 与 _no-trimcli 两种产物命名）
      let download_url = "";
      if (Array.isArray(data.assets)) {
        // 先查找 no_trimcli 版本（下划线/连字符命名均匹配）
        const noTrimCliAsset = data.assets.find(a => /[_-]no[-_]trimcli\.fpk$/i.test(a.name || ""));
        if (noTrimCliAsset && noTrimCliAsset.browser_download_url) {
          download_url = noTrimCliAsset.browser_download_url;
        } else {
          // 如果没有 no_trimcli，查找其他 .fpk 文件
          const asset = data.assets.find(a => /\.fpk$/i.test(a.name || ""));
          if (asset && asset.browser_download_url) download_url = asset.browser_download_url;
        }
      }

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
      const result = await checkLatestVersion();
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


  // ── Hermes 自更新（直接使用 uv，不依赖 dashboard）────────
  // GET  /api/hermes/update/check  → 从 PyPI 查询最新版本
  // POST /api/hermes/update        → 触发 uv pip install --upgrade（后台执行）
  // GET  /api/hermes/update/status → 轮询更新进度
  if (path === "/api/hermes/update/check") {
    try {
      // 每次检查都重新运行 hermes --version，确保版本准确（不依赖缓存）；
      // 异步执行并限 5 秒，避免同步子进程冻结事件循环拖住其它请求
      let current = HERMES_VERSION;
      try {
        const vr = await runCmdAsync(HERMES_BIN_PATH, ["--version"], 5000);
        const vOut = vr.stdout || vr.stderr;
        if (vOut) {
          current = formatHermesVersion(vOut);
          if (current !== HERMES_VERSION) {
            HERMES_VERSION = current;
            try { writeFileSync(VERSION_FILE, current, { mode: 0o644 }); } catch (e2) {
              log(`[更新检查] 写入版本缓存失败: ${e2.message}`);
            }
            log(`版本已刷新 (check): ${current}`);
          }
        } else if (vr.error) {
          log(`[更新检查] hermes --version 执行失败: ${vr.error.message}`);
        }
      } catch (e) {
        log(`[更新检查] 版本探测异常: ${e.message}`);
      }
      const currentVer = current.replace(/^v/, "").split(" ")[0];

      // 通过 GitHub Releases API 检查是否有更新
      let updateAvailable = false;
      let latestDisplay = current; // 默认与当前版本相同

      try {
        // hermes 引擎最新版本查上游官方仓库 NousResearch/hermes-agent
        // （修复回归：此前误用应用打包仓库 iranee/fnos-hermes-agent）
        const HERMES_GITHUB_REPO = process.env.HERMES_GITHUB_REPO || "NousResearch/hermes-agent";
        const res = await fetch(`https://api.github.com/repos/${HERMES_GITHUB_REPO}/releases/latest`, {
          signal: AbortSignal.timeout(15000),
          headers: {
            'User-Agent': 'fnos-hermes-agent/0.19.0',
          },
        });
        if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
        const data = await res.json();
        
        // 优先从 release name 解析语义版本号（如"Hermes Agent v0.20.0 (2026.8.3)" → "0.20.0"），
        // 其次 fallback 到 body，最后才用 tag_name（通常是日期格式）
        const semVerRe = /v?(\d+\.\d+\.\d+)/;
        let realVer = null;
        if (data.name) {
          const m = String(data.name).match(semVerRe);
          if (m && m[1]) { realVer = m[1]; }
        }
        if (!realVer && data.body) {
          const m = String(data.body).match(semVerRe);
          if (m && m[1]) { realVer = m[1]; }
        }
        if (!realVer) {
          const tag = String((data.tag_name||'').replace(/^v/, ''));
          if (/^\d+\.\d+\.\d+$/.test(tag)) { realVer = tag; }
        }
        
        if (!realVer) {
          log(`[更新检查] GitHub 返回无有效语义版本：name=${String(data.name||'')}, tag=${String(data.tag_name||'')}`);
          updateAvailable = false;
          latestDisplay = current;
        } else {
          const curVerNum = current.replace(/^v/, '').split(/[^\d.]/)[0];
          log(`[更新检查] GitHub realVersion=v${realVer}, current=${curVerNum}`);
          const cmp = compareVersions(realVer, curVerNum);
                  
          // 解析发布日期：优先从 tag_name (v2026.8.3) 取，fallback 到 published_at
          let dateStr = '';
          const tagDateMatch = String(data.tag_name || '').replace(/^v/, '').match(/^(\d{4})[-.](\d{1,2})[-.](\d{1,2})/);
          if (tagDateMatch) {
            dateStr = `${tagDateMatch[1]}.${tagDateMatch[2]}.${tagDateMatch[3]}`;
          } else {
            const pubAt = String(data.published_at || '');
            const d = new Date(pubAt);
            if (!isNaN(d.getTime())) {
              const mm = [d.getMonth()+1, d.getDate()].map(n => n.toString().padStart(2,'0'));
              dateStr = `${d.getFullYear()}.${mm[0]}.${mm[1]}`;
            }
          }
                  
          if (cmp > 0) {
            updateAvailable = true;
            latestDisplay = dateStr ? `v${realVer} (${dateStr})` : `v${realVer}`;
            log(`[更新检查] 新版本：${latestDisplay} > ${curVerNum}`);
          } else {
            updateAvailable = false;
            latestDisplay = dateStr ? `v${realVer} (${dateStr})` : `v${realVer}`;
            log(`[更新检查] 已是最新：${latestDisplay} <= ${curVerNum}`);
          }
        }
      } catch (e) {
        log(`[更新检查] GitHub API 失败：${e.message}`);
        updateAvailable = false;
        latestDisplay = current;
      }
      log(`[更新检查] 最终结果：current=${current}, latest=${latestDisplay}, available=${updateAvailable}`);
      return new Response(JSON.stringify({ current, latest: latestDisplay, updateAvailable }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message || String(e) }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
  }

  if (path === "/api/hermes/update" && req.method === "POST") {
    // ===== 更新逻辑（根据调研结论 & 官方 install.sh） =====
    // ❌ 不要从 PyPI 安装（已废弃，停在 0.19.0）
    // ✅ 正确流程：git clone + uv pip install -e (editable to existing venv)
    // 📝 目录要求：必须在 DATA_DIR 下持久化，不能在 target/
    
    if (updateState === "updating") {
      return new Response(JSON.stringify({ error: "更新进行中，请等待" }), {
        status: 409, headers: { "Content-Type": "application/json" },
      });
    }

    // 查找或初始化 hermes-repo 目录
    const HERMES_REPO_DIR = `${DATA_DIR}/hermes-repo`;
    const VENV_DIR = `${DATA_DIR}/venv`;
    const VENV_PY = `${VENV_DIR}/bin/python3`;
    // GitHub 镜像加速：尝试多个候选 URL，防止 GnuTLS -110 / DNS 污染等网络错误
    const GITHUB_MIRROR_PREFIXES = [
      "",                          // 直连
      "https://ghproxy.com/",      // gh-proxy
      "https://mirror.ghproxy.com/", // mirror.ghproxy
      "https://gh-proxy.com/",     // gh-proxy
    ];
    const REPO_PATH = "NousResearch/hermes-agent";
    function repoUrlCandidates() {
      return GITHUB_MIRROR_PREFIXES.map(p => p ? `${p}https://github.com/${REPO_PATH}.git` : `https://github.com/${REPO_PATH}.git`);
    }
    function fetchUrlCandidates(repoDir) {
      return GITHUB_MIRROR_PREFIXES.map(p => p ? `${p}https://github.com/${REPO_PATH}.git` : `https://github.com/${REPO_PATH}.git`);
    }
        
    // uv 优先用 data/bin/uv（安装脚本落地位置），兜底 venv/bin/uv 软链
    const UV = existsSync(`${DATA_DIR}/bin/uv`) ? `${DATA_DIR}/bin/uv` : UV_BIN_PATH;
    
    log(`[更新] hermes-repo=${HERMES_REPO_DIR}, venv=${VENV_DIR}, uv=${UV}`);
    
    // 判断是否需要重新 clone：目录不存在，或存在但缺 pyproject.toml/setup.py（残缺）
    const repoValid = existsSync(`${HERMES_REPO_DIR}/pyproject.toml`) || existsSync(`${HERMES_REPO_DIR}/setup.py`);
    const shouldClone = !repoValid;
    
    // 重置状态
    updateState = "updating";
    updateOutput = [];
    updateExitCode = null;
    
    // 获取最新 release 的 tag 名（比如 v2026.8.3）
    let targetTag = "main"; // 默认主分支
    try {
      // 与 /api/hermes/update/check 一致：查上游官方仓库（修复误用打包仓库的回归）
      const HERMES_GITHUB_REPO = process.env.HERMES_GITHUB_REPO || "NousResearch/hermes-agent";
      const res = await fetch(`https://api.github.com/repos/${HERMES_GITHUB_REPO}/releases/latest`, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'fnos-hermes-agent/0.19.0' },
      });
      if (res.ok) {
        const data = await res.json();
        targetTag = String(data.tag_name || "main");
        log(`[更新] 目标版本 tag: ${targetTag}`);
      }
    } catch (e) {
      log(`[更新] GitHub API 失败，使用默认 main: ${e.message}`);
    }
    
    const env = {
      ...process.env,
      HOME: DATA_DIR,
      PATH: `${VENV_BIN}:${DATA_DIR}/bin:/usr/local/bin:/usr/bin:/bin`,
      UV_CACHE_DIR: `${DATA_DIR}/.uv-cache`,
      // 显式设置 VIRTUAL_ENV 以便 uv 知道用哪个 venv
      VIRTUAL_ENV: VENV_DIR,
      // 钉住解释器，防止继承的 UV_PYTHON 让 uv 重建 venv（对齐官方 install.sh）
      UV_PYTHON: VENV_PY,
    };
    
    // 后台执行器：走 node-adapter 的 spawn（单参数对象形式），逐行收集 stdout/stderr
    // 可选 envOverride：构建 web/ui-tui 时需把 data/node/bin 挂进 PATH，缺省沿用闭包 env
    const runStep = (cmdArr, envOverride) => new Promise((resolve) => {
      let proc;
      try {
        proc = spawn({ cmd: cmdArr, env: envOverride || env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      } catch (e) {
        updateOutput.push(`[stderr] spawn 失败：${e.message || e}`);
        resolve(-1);
        return;
      }
      updateProc = proc;
      const decoder = new TextDecoder();
      const pump = async (stream, isErr) => {
        if (!stream) return;
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            for (const line of text.split("\n")) {
              if (line.trim()) {
                updateOutput.push((isErr ? "[stderr] " : "") + line.trim());
                if (updateOutput.length > 200) updateOutput.shift();
              }
            }
          }
        } catch {}
      };
      pump(proc.stdout, false);
      pump(proc.stderr, true);
      proc.exited.then((code) => resolve(code));
    });

    (async () => {
      try {
        // 步骤 1：clone（首次/残缺）或 fetch+reset（已有）从最新 release tag
        if (shouldClone) {
          if (existsSync(HERMES_REPO_DIR)) {
            log(`[更新] 目录残缺，先清理 ${HERMES_REPO_DIR}`);
            const rmCode = await runStep(["rm", "-rf", HERMES_REPO_DIR]);
            if (rmCode !== 0) throw new Error(`清理旧目录失败 (exit ${rmCode})`);
          }
          const urls = repoUrlCandidates();
          log(`[更新] 开始克隆 (${urls.length}个镜像)...`);
          let lastError = null;
          for (const url of urls) {
            log(`[更新] 尝试：${url}`);
            // 从 tag 直接 checkout
            const code = await runStep(["git", "clone", "--depth", "1", "--branch", targetTag, url, HERMES_REPO_DIR]);
            if (code === 0) {
              log(`[更新] 克隆成功（经 ${url.split('/')[2] || 'direct'}）`);
              break;
            } else {
              lastError = new Error(`git clone 失败 (exit ${code})`);
              log(`[更新] 克隆失败：exit ${code}`);
            }
            // 若失败则删除可能产生的空目录
            try { rmSync(HERMES_REPO_DIR, { recursive: true, force: true }); } catch {}
          }
          if (!existsSync(HERMES_REPO_DIR)) throw lastError;
        } else {
          // 对齐 hermes update：git fetch tag + reset --hard，避免本地改动导致冲突
          const urls = fetchUrlCandidates();
          log(`[更新] 开始 fetch tag ${targetTag} (尝试${urls.length}个镜像)...`);
          let lastError = null;
          let success = false;
          for (const url of urls) {
            try {
              log(`[更新] 设置 origin: ${url}`);
              const setUrlCode = await runStep(["sh", "-c", `cd "${HERMES_REPO_DIR}" && git remote set-url origin ${url}`]);
              if (setUrlCode !== 0) throw new Error(`设置 origin 失败`);
                      
              log(`[更新] fetch tag: ${targetTag}`);
              const fetchCode = await runStep(["sh", "-c", `cd "${HERMES_REPO_DIR}" && git fetch --depth 1 origin ${targetTag}`]);
              if (fetchCode !== 0) throw new Error(`fetch 失败 exit ${fetchCode}`);
                      
              log(`[更新] reset to tag: ${targetTag}`);
              const resetCode = await runStep(["sh", "-c", `cd "${HERMES_REPO_DIR}" && git reset --hard FETCH_HEAD`]);
              if (resetCode !== 0) throw new Error(`reset 失败 exit ${resetCode}`);
                      
              success = true;
              log(`[更新] 更新成功（经 ${url.split('/')[2] || 'direct'}）`);
              break;
            } catch (e) {
              lastError = e;
              log(`[更新] 本次尝试失败：${e.message}`);
            }
          }
          if (!success) throw lastError;
        }
        log(`[更新] 代码就绪`);

        // 步骤 2：分层 editable 安装到现有 venv（对齐官方 install.sh 四层策略）
        //   Tier 0: uv sync --extra all --locked（哈希校验，需 uv.lock）
        //   Tier 1: uv pip install -e ".[all]"
        //   Tier 3: uv pip install -e "."（裸装保底）
        //   注意：是 --extra all，不是 --all-extras（后者会拉 matrix/rl 等需系统编译的 extra）
        let insCode = 1;
        if (existsSync(`${HERMES_REPO_DIR}/uv.lock`)) {
          log(`[更新] Tier 0: uv sync --extra all --locked`);
          insCode = await runStep(["sh", "-c", `cd "${HERMES_REPO_DIR}" && UV_PROJECT_ENVIRONMENT="${VENV_DIR}" "${UV}" sync --extra all --locked`]);
          if (insCode === 0) log(`[更新] Tier 0 成功（哈希校验 uv sync）`);
        }
        if (insCode !== 0) {
          log(`[更新] Tier 1: ${UV} pip install --python ${VENV_PY} -e .[all]`);
          insCode = await runStep(["sh", "-c", `cd "${HERMES_REPO_DIR}" && "${UV}" pip install --python "${VENV_PY}" -e ".[all]"`]);
          if (insCode === 0) log(`[更新] Tier 1 成功（-e .[all]）`);
        }
        if (insCode !== 0) {
          log(`[更新] Tier 3: ${UV} pip install --python ${VENV_PY} -e .`);
          insCode = await runStep(["sh", "-c", `cd "${HERMES_REPO_DIR}" && "${UV}" pip install --python "${VENV_PY}" -e "."`]);
          if (insCode === 0) log(`[更新] Tier 3 成功（core only）`);
        }
        if (insCode !== 0) throw new Error(`editable 安装失败（Tier 0/1/3 均失败，exit ${insCode}）`);
        log(`[更新] editable 安装完成`);

        // 步骤 2.6：补齐 provider SDK（anthropic / openai）
        // 原因：Tier 0 `uv sync --extra all --locked` 会按 lock 裁剪 venv，若 lock 的
        // all extra 不含 anthropic，会把它卸载掉，导致 anthropic_messages 模式报
        // "The 'anthropic' package is required"。此处显式重装兵先保底。
        log(`[更新] 补齐 provider SDK（anthropic / openai）...`);
        const sdkCode = await runStep(["sh", "-c",
          `"${UV}" pip install --python "${VENV_PY}" "anthropic>=0.39.0" "openai"`]);
        if (sdkCode === 0) log(`[更新] provider SDK 就绪`);
        else log(`[更新] ⚠️ provider SDK 安装失败 (exit ${sdkCode})，Anthropic 对话可能不可用`);

        // 步骤 2.5：确保 Node.js 环境（git 版需要 npm 构建 web/ui-tui）
        const NODE_INSTALL_DIR = `${DATA_DIR}/node`;
        const NODE_BIN_DIR = `${NODE_INSTALL_DIR}/bin`;
        const NODE_EXE_PATH = `${NODE_BIN_DIR}/node`;
        const NODE_TGZ = `${TMP_DIR}/node.tgz`;
        let arch = process.arch; // x64 or arm64
        let nodeVer = 'v24.15.0'; // 满足 >=22.22.0 要求
        let nodeUrl = '';
        if (arch === 'x64') {
          nodeUrl = `https://nodejs.org/download/release/${nodeVer}/node-${nodeVer}-linux-x64.tar.gz`;
        } else if (arch === 'arm64') {
          nodeUrl = `https://nodejs.org/download/release/${nodeVer}/node-${nodeVer}-linux-arm64.tar.gz`;
        }
        
        if (!nodeUrl) {
          log(`[更新] 警告：不支持的架构 ${arch}，跳过 Node.js 安装`);
        } else if (existsSync(NODE_EXE_PATH)) {
          log(`[更新] Node.js 已存在：${NODE_EXE_PATH}`);
        } else {
          log(`[更新] 未检测到 Node.js，将从官方下载并解压到 ${NODE_INSTALL_DIR}...`);
          mkdirSync(DATA_DIR, { recursive: true }); // 确保 parent dir 存在
          
          try {
            // 用 curl+sh 管道方式下载并解压（参考 ensure_uv 模式）
            log(`[更新] 下载 Node.js ${arch} tarball (${nodeUrl})...`);
            const installNodeCode = await runStep([
              "sh", "-c",
              `curl -L --retry 3 --max-time 120 '${nodeUrl}' -o '${NODE_TGZ}' 2>&1 && ` +
              `tar -xzf '${NODE_TGZ}' -C '${DATA_DIR}' --strip-components=1 2>&1`
            ]);
            
            if (installNodeCode === 0 && existsSync(NODE_EXE_PATH)) {
              // 验证：运行 --version
              const versionCheck = spawnSync(NODE_EXE_PATH, ["--version"]);
              const verOut = (versionCheck.stdout || "").toString("utf8").trim();
              if (verOut) {
                log(`[更新] Node.js 安装成功：${verOut}`);
              } else {
                log(`[更新] ⚠️ Node.js 解压后无法运行`);
              }
            } else {
              log(`[更新] ⚠️ Node.js 安装失败 (exit ${installNodeCode}), 后续构建将跳过`);
            }
          } catch (e) {
            log(`[更新] Node.js 安装异常：${e.message || e}`);
          } finally {
            try { unlinkSync(NODE_TGZ); } catch {}
          }
        }

        // 步骤 3：确保 Node.js 在 PATH 中（data/node/bin），然后构建 web 和 ui-tui 组件
        if (!NODE_EXE_PATH) {
          log(`[更新] 警告：未检测到 Node.js 环境 (${NODE_EXE_PATH} 不存在)，跳过构建`);
        } else {
          log(`[更新] Node.js found: ${NODE_EXE_PATH}, 构建 web 和 ui-tui 组件...`);
          const envWithNode = { ...process.env, PATH: `${NODE_BIN_DIR}:${process.env.PATH}` };
          
          // 3.1: web 组件（Dashboard SPA）→ 产物在 hermes_cli/web_dist
          // 要点：
          //   1. 国内网络直连 registry.npmjs.org 极易超时 → 先用 npmmirror 镜像，失败再回退官方源
          //   2. web 依赖 @hermes/shared(file: workspace 包)，须从仓库根按 workspace 装全
          //   3. 以 web_dist/index.html + assets/*.js 存在为成功判据：产物缺失时 Dashboard
          //      只会返回 HTML 壳，/assets/* 全部 404 → /chat 白屏（0.20 Git 版升级后的典型故障）
          const WEB_DIST_DIR = `${HERMES_REPO_DIR}/hermes_cli/web_dist`;
          const webDistOk = () => {
            try {
              if (!existsSync(`${WEB_DIST_DIR}/index.html`)) return false;
              return readdirSync(`${WEB_DIST_DIR}/assets`).some(f => f.endsWith(".js"));
            } catch { return false; }
          };
          const npmRegistries = ["https://registry.npmmirror.com", "https://registry.npmjs.org"];
          let webBuilt = false;
          for (const registry of npmRegistries) {
            if (webBuilt) break;
            try {
              log(`[更新] 构建 web 前端（npm 源：${registry}）...`);
              const code1 = await runStep([
                "sh", "-c",
                `cd "${HERMES_REPO_DIR}" && npm install --workspace web --include=dev --no-audit --no-fund --registry ${registry} 2>&1 && npm run -w web build`
              ], envWithNode);
              if (code1 === 0 && webDistOk()) {
                webBuilt = true;
                log(`[更新] web 构建成功（web_dist 产物已验证）`);
                // 同步到随包兜底目录（app/hermes-web-dist），作为 HERMES_WEB_DIST 兜底链的最新产物
                try {
                  const PKG_DIST = `${__dirname}/../hermes-web-dist`;
                  const syncCode = await runStep(
                    ["sh", "-c", `rm -rf "${PKG_DIST}" && cp -r "${WEB_DIST_DIR}" "${PKG_DIST}"`],
                    envWithNode
                  );
                  log(syncCode === 0
                    ? `[更新] web 产物已同步到随包兜底目录`
                    : `[更新] 同步随包兜底目录失败 exit=${syncCode}（不影响本次）`);
                } catch (e2) {
                  log(`[更新] 同步随包兜底目录异常：${e2.message}（不影响本次）`);
                }
              } else if (code1 === 0) {
                log(`[更新] ⚠️ web 构建 exit=0 但 web_dist 产物缺失，尝试下一个 npm 源`);
              } else {
                log(`[更新] web 构建失败 (exit ${code1})，尝试下一个 npm 源`);
              }
            } catch (e) {
              log(`[更新] web 构建异常：${e.message}`);
            }
          }
          if (!webBuilt) {
            log(`[更新] ⚠️ web 现场构建失败：Dashboard /chat 将因 /assets 资源缺失而白屏，请在更新页点「重建前端」修复`);
          }
          
          // 3.2: ui-tui 组件（/chat 页面 TUI）
          try {
            log(`[更新] 构建 ui-tui 终端...`);
            const code2 = await runStep([
              "sh", "-c",
              `cd "${HERMES_REPO_DIR}/ui-tui" && npm run build:ink 2>&1 && npm run build 2>&1`
            ], envWithNode);
            if (code2 === 0) {
              const entryPath = `${HERMES_REPO_DIR}/ui-tui/dist/entry.js`;
              if (existsSync(entryPath)) {
                const size = (await statSync(entryPath)).size;
                log(`[更新] ui-tui 构建成功 (entry.js ${size} bytes)`);
              } else {
                log(`[更新] ui-tui 构建成功但 entry.js 未找到`);
              }
            } else {
              log(`[更新] ui-tui 构建失败 (exit ${code2})，可能 PTY 连接时会懒构建`);
            }
          } catch (e) {
            log(`[更新] ui-tui 构建异常：${e.message}`);
          }
        }

        // 步骤 4：清缓存并重新探测版本
        try { unlinkSync(VERSION_FILE); } catch {}
        let newVer = null;
        
        // 等待新版本二进制文件准备好（避免 race condition）
        log(`[更新] 等待 2 秒让新的 Hermes 二进制文件就绪...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const verResult = await runCmdAsync("sh", ["-c", `${HERMES_BIN_PATH} --version`], 10000);
        const verOut = verResult.stdout || verResult.stderr || "";
        if (verOut) {
          newVer = formatHermesVersion(verOut);
          HERMES_VERSION = newVer;
          try { writeFileSync(VERSION_FILE, newVer, { mode: 0o644 }); } catch {}
          log(`[更新] 新版本号：${newVer}`);
        } else {
          throw new Error(`无法获取新版本号 (${verResult.error ? verResult.error.message : 'no output'})`);
        }

        updateExitCode = 0;
        updateState = "done";
        updateProc = null;
        log(`[更新] 成功！版本：${newVer}`);
      } catch (e) {
        updateExitCode = 1;
        updateState = "error";
        updateProc = null;
        updateOutput.push(`[错误] ${e.message || String(e)}`);
        log(`[更新] 失败：${e.message || String(e)}`);
      }
    })();

    return new Response(JSON.stringify({ 
      ok: true, 
      message: "开始从 GitHub 克隆/更新代码...",
      repoDir: HERMES_REPO_DIR,
      venvDir: VENV_DIR,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (path === "/api/hermes/update/status") {
    let currentVer = HERMES_VERSION;
    if (updateState === "done") {
      try {
        // 异步执行并限 5 秒，避免同步子进程冻结事件循环拖住其它请求
        const verResult = await runCmdAsync("sh", ["-c", `${HERMES_BIN_PATH} --version`], 5000);
        const verOut = verResult.stdout || verResult.stderr;
        if (verOut) {
          currentVer = formatHermesVersion(verOut);
          HERMES_VERSION = currentVer;
          try { writeFileSync(VERSION_FILE, currentVer, { mode: 0o644 }); } catch {}
        }
      } catch {}
    }
    return new Response(JSON.stringify({
      status: updateState,
      output: updateOutput.slice(-50),
      exitCode: updateExitCode,
      version: currentVer,
    }), { headers: { "Content-Type": "application/json" } });
  }

  // ===== Web 前端单独重建（升级后 web_dist 产物缺失时不用重跑完整更新） =====
  if (path === "/api/hermes/rebuild-web" && req.method === "POST") {
    if (rebuildWebState === "building") {
      return new Response(JSON.stringify({ error: "重建进行中，请等待" }), {
        status: 409, headers: { "Content-Type": "application/json" },
      });
    }
    if (updateState === "updating") {
      return new Response(JSON.stringify({ error: "完整更新进行中，请等待完成" }), {
        status: 409, headers: { "Content-Type": "application/json" },
      });
    }
    const REPO_DIR = `${DATA_DIR}/hermes-repo`;
    if (!existsSync(`${REPO_DIR}/web/package.json`)) {
      return new Response(JSON.stringify({ error: "hermes-repo 不存在（尚未执行过 Git 版更新），请先在更新页执行完整更新" }), {
        status: 400, headers: jsonHeaders(),
      });
    }
    const NODE_BIN = `${DATA_DIR}/node/bin`;
    if (!existsSync(`${NODE_BIN}/node`)) {
      return new Response(JSON.stringify({ error: "Node.js 不存在（data/node/bin/node），无法构建前端" }), {
        status: 400, headers: jsonHeaders(),
      });
    }

    rebuildWebState = "building";
    rebuildWebOutput = [];
    rebuildWebExitCode = null;

    const envNode = { ...process.env, HOME: DATA_DIR, PATH: `${NODE_BIN}:${DATA_DIR}/bin:/usr/local/bin:/usr/bin:/bin` };
    const runBuildStep = (cmdArr) => new Promise((resolve) => {
      let proc;
      try {
        proc = spawn({ cmd: cmdArr, env: envNode, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      } catch (e) {
        rebuildWebOutput.push(`[stderr] spawn 失败：${e.message || e}`);
        resolve(-1);
        return;
      }
      rebuildWebProc = proc;
      const decoder = new TextDecoder();
      const pump = async (stream, isErr) => {
        if (!stream) return;
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            for (const line of text.split("\n")) {
              if (line.trim()) {
                rebuildWebOutput.push((isErr ? "[stderr] " : "") + line.trim());
                if (rebuildWebOutput.length > 200) rebuildWebOutput.shift();
              }
            }
          }
        } catch {}
      };
      pump(proc.stdout, false);
      pump(proc.stderr, true);
      proc.exited.then((code) => resolve(code));
    });

    (async () => {
      try {
        const DIST = `${REPO_DIR}/hermes_cli/web_dist`;
        const distOk = () => {
          try {
            if (!existsSync(`${DIST}/index.html`)) return false;
            return readdirSync(`${DIST}/assets`).some(f => f.endsWith(".js"));
          } catch { return false; }
        };
        // 镜像优先，官方源兑底（与更新流程同一策略）
        const registries = ["https://registry.npmmirror.com", "https://registry.npmjs.org"];
        let ok = false;
        for (const registry of registries) {
          if (ok) break;
          log(`[重建前端] npm 源: ${registry}`);
          rebuildWebOutput.push(`>>> npm install + build（源: ${registry}）...`);
          const code = await runBuildStep([
            "sh", "-c",
            `cd "${REPO_DIR}" && npm install --workspace web --include=dev --no-audit --no-fund --registry ${registry} 2>&1 && npm run -w web build`
          ]);
          if (code === 0 && distOk()) {
            ok = true;
            log(`[重建前端] 构建成功（web_dist 产物已验证）`);
          } else {
            log(`[重建前端] 本次尝试未产出有效产物 (exit ${code})`);
          }
        }
        if (!ok) throw new Error("web 构建失败（两个 npm 源均未产出 web_dist 产物，详见输出日志）");

        // 把版本严格匹配的产物同步到随包兜底目录（app/hermes-web-dist），
        // 以后即使 hermes-repo 被清，dashboard 仍能出页面（HERMES_WEB_DIST 兜底链）
        const PKG_DIST = `${__dirname}/../hermes-web-dist`;
        const syncCode = await runBuildStep([
          "sh", "-c", `rm -rf "${PKG_DIST}" && cp -r "${DIST}" "${PKG_DIST}"`
        ]);
        if (syncCode === 0) {
          log(`[重建前端] 产物已同步到随包兜底目录: ${PKG_DIST}`);
        } else {
          log(`[重建前端] 同步随包兜底目录失败（不影响本次生效）exit=${syncCode}`);
        }

        // 重启 Dashboard 使其加载新静态资源（web_server 对 index.html 有令牌注入等处理，重启最稳）
        const dbPid = readPid(PID_DASHBOARD);
        if (dbPid) {
          rebuildWebOutput.push(">>> 重启 Dashboard 以加载新前端...");
          await stopPid(PID_DASHBOARD);
          await new Promise(r => setTimeout(r, 800));
          spawnDashboard();
          log(`[重建前端] Dashboard 已重启 (old pid=${dbPid})`);
        }
        rebuildWebExitCode = 0;
        rebuildWebState = "done";
      } catch (e) {
        rebuildWebExitCode = 1;
        rebuildWebState = "error";
        rebuildWebOutput.push(`[错误] ${e.message || String(e)}`);
        log(`[重建前端] 失败：${e.message || String(e)}`);
      } finally {
        rebuildWebProc = null;
      }
    })();

    return new Response(JSON.stringify({ ok: true, message: "开始重建 Dashboard 前端..." }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (path === "/api/hermes/rebuild-web/status") {
    return new Response(JSON.stringify({
      status: rebuildWebState,
      output: rebuildWebOutput.slice(-50),
      exitCode: rebuildWebExitCode,
    }), { headers: { "Content-Type": "application/json" } });
  }

  if (path === "/api/start" && req.method === "POST") {
    // 启动前检查：必须有至少一个真实模型服务商（非 Hermes Gateway 自身）
    const statePath = `${VAR_DIR}/providers-state.yaml`;
    let hasRealProvider = false;
    try {
      if (existsSync(statePath)) {
        const stateContent = readFileSync(statePath, "utf8");
        const provIds = [...stateContent.matchAll(/^  ([a-zA-Z0-9_-]+):\s*$/gm)].map(m => m[1]);
        hasRealProvider = provIds.some(id => id !== "hermes");
      }
    } catch {}
    if (!hasRealProvider) {
      return new Response(JSON.stringify({ ok: false, error: "请先在设置中添加至少一个模型服务商" }), { status: 400, headers: jsonHeaders() });
    }
    manualStopEpoch = 0; // 解除手动停机态，恢复 bridge 保活
    const r1 = spawnHermes("gateway",   PID_GATEWAY,   ["gateway", "run"]);
    const r2 = spawnDashboard();
    const r3 = startAgentBridge(); // 失败容忍：仅记日志，对话自动降级 HTTP SSE
    return new Response(JSON.stringify({ gateway: r1, dashboard: r2, bridge: r3 }), { headers: jsonHeaders() });
  }

  if (path === "/api/stop" && req.method === "POST") {
    manualStopEpoch = Date.now(); // 阻止进行中的渠道重启回调再拉起网关，并暂停 bridge 保活重启
    const gwAlive = readPid(PID_GATEWAY);
    const dbAlive = readPid(PID_DASHBOARD);
    const brAlive = readBridgePid();
    await stopPid(PID_GATEWAY);
    await stopPid(PID_DASHBOARD);
    await stopAgentBridge();
    await forceKillHermes();
    resetGatewayCrashLoop();
    if (gwAlive) log("Gateway stopped (pid=" + gwAlive + ")");
    if (dbAlive) log("Dashboard stopped (pid=" + dbAlive + ")");
    if (brAlive) log("Agent Bridge stopped (pid=" + brAlive + ")");
    if (!gwAlive && !dbAlive) log("Stop: no running processes");
    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders() });
  }

  if (path === "/api/restart" && req.method === "POST") {
    log("Restarting gateway ...");
    manualStopEpoch = Date.now(); // 重启期间的 bridge 退出属预期，暂停保活重启
    // 重启流程在后台异步执行，接口立即返回；停止等待（最长约 15 秒）不再阻塞响应，
    // 前端恢复状态由既有的 /api/status 轮询自然反映（对齐控制面板重启的交互模式）
    (async () => {
      try {
        await stopPid(PID_GATEWAY);
        await stopPid(PID_DASHBOARD);
        await stopAgentBridge();
        await forceKillHermes();
        resetGatewayCrashLoop();
        await new Promise(r => setTimeout(r, 1500));
      } finally {
        manualStopEpoch = 0; // 任何异常路径都复位，避免保活被永久禁用
      }
      spawnHermes("gateway",   PID_GATEWAY,   ["gateway", "run"]);
      spawnDashboard();
      startAgentBridge(); // 失败容忍：仅记日志，对话自动降级 HTTP SSE
    })().catch(e => log(`Restart failed: ${e?.message || e}`));
    return new Response(JSON.stringify({ ok: true, restarting: true }), { headers: jsonHeaders() });
  }

  // Dashboard 独立启停
  if (path === "/api/dashboard/start" && req.method === "POST") {
    return handleDashboardStart(jsonHeaders);
  }

  if (path === "/api/dashboard/stop" && req.method === "POST") {
    return handleDashboardStop(jsonHeaders);
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
    const r = await handleTelegramQr(botName);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: jsonHeaders() });
  }
  if (path === "/api/channels/telegram/qr/status" && req.method === "GET") {
    const pairingId = url.searchParams.get("pairing_id") || "";
    const r = await handleTelegramQrStatus(pairingId);
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

  // ─── 聊天：配置 API ──────────────────────────────────────────────────────
  if (path === "/api/config" && req.method === "GET") {
    // ── 读取 providers-state.yaml（控制面板专属配置文件）────────────
    let ymlProviders = [];
    let activeProvName = "";
    let activeModel = "";
    let provModelMap = {}; // { "minimax-cn": "MiniMax-M2.7", ... }
    let fallbackIds = [];  // 面板回退模型 id 列表（解析自 config.yaml 顶层 fallback_providers）

    try {
      // 读取 Hermes config.yaml 获取当前 active provider
      const yamlPath = `${DATA_DIR}/config.yaml`;
      let provId = "";
      if (existsSync(yamlPath)) {
        const yml = readFileSync(yamlPath, "utf8");
        const provMatch = yml.match(/^model:\s*\n\s+provider:\s*(\S+)/m);
        const modelMatch = yml.match(/^model:\s*\n\s+default:\s*(\S+)/m);
        provId = provMatch ? provMatch[1] : "";
        activeModel = modelMatch ? modelMatch[1] : "";
        fallbackIds = parseFallback(yml);
      }

      // 读取控制面板专属 .env.providers 获取 API keys
      const envApiKeys = {};
      try {
        const envProvPath = `${VAR_DIR}/.env.providers`;
        // 迁移：如果 .env.providers 不存在但 Hermes .env 有 key，先迁移
        if (!existsSync(envProvPath) && existsSync(`${DATA_DIR}/.env`)) {
          const legacyEnv = readFileSync(`${DATA_DIR}/.env`, "utf8");
          const legacyKeys = {};
          Object.keys(PROVIDER_API_KEYS).forEach(id => {
            const envKey = PROVIDER_API_KEYS[id];
            const m = legacyEnv.match(new RegExp(`^${envKey}=(.*)$`, "m"));
            if (m && m[1].length > 0) legacyKeys[envKey] = m[1];
          });
          const customRe2 = /^CUSTOM_(?:PROVIDER_)?([A-Z0-9_]+)_API_KEY=(.+)$/gm;
          let cm2;
          while ((cm2 = customRe2.exec(legacyEnv)) !== null) {
            legacyKeys[`CUSTOM_${cm2[1]}_API_KEY`] = cm2[2];
          }
          if (Object.keys(legacyKeys).length > 0) {
            writeFileSync(envProvPath,
              Object.entries(legacyKeys).map(([k,v]) => `${k}=${v}`).join("\n") + "\n");
          }
        }
        if (existsSync(envProvPath)) {
          const envContent = readFileSync(envProvPath, "utf8");
          Object.keys(PROVIDER_API_KEYS).forEach(id => {
            const envKey = PROVIDER_API_KEYS[id];
            const m = envContent.match(new RegExp(`^${envKey}=(.*)$`, "m"));
            if (m && m[1].length > 0) envApiKeys[id] = m[1];
          });
          const customRe = /^CUSTOM_(?:PROVIDER_)?([A-Z0-9_]+)_API_KEY=(.+)$/gm;
          let cm;
          while ((cm = customRe.exec(envContent)) !== null) {
            const customId = "custom-" + cm[1].toLowerCase().replace(/_/g, "-");
            if (!envApiKeys[customId]) envApiKeys[customId] = cm[2];
          }
        }
      } catch (e) {}

      // 解析 providers-state.yaml（格式: providers:\n  id:\n    model: xxx ...；共享解析逻辑在 primary-config.js）
      provModelMap = loadProvidersState();

      // ── 迁移：providers-state.yaml 为空时，从 .env.providers 反推 ───
      if (Object.keys(provModelMap).length === 0) {
        Object.keys(envApiKeys).forEach(id => {
          const preset = PROVIDER_PRESETS[id];
          const defaults = PROVIDER_MODELS[id];
          const model = (defaults && defaults.length > 0) ? defaults[0] : "auto";
          provModelMap[id] = { model, base_url: preset ? preset.base_url : "" };
        });
      }

      // ── 构建返回的 provider 列表 ────────────────────────────────────
      Object.entries(provModelMap).forEach(([id, info]) => {
        const preset = PROVIDER_PRESETS[id];
        const isCustom = !preset;
        const savedName = (typeof info === "object" && info.name) ? info.name.trim() : "";
        const name = savedName || (preset ? `${preset.name} (${id})` : id);
        const model = (typeof info === "string") ? info : (info.model || "");
        const baseUrl = (typeof info === "string") ? "" : (info.base_url || "");
        const maskedKey = envApiKeys[id]
          ? "****" + String(envApiKeys[id]).slice(-4)
          : "";
        if (id === provId) activeProvName = name;
        ymlProviders.push({
          id,
          name,
          type: "openai-compatible",
          base_url: preset ? preset.base_url : baseUrl,
          model,
          temperature: info.temperature ?? 0.7,
          max_tokens: info.max_tokens ?? 4096,
          api_key_masked: maskedKey,
          api_key_configured: !!envApiKeys[id],
          is_custom: isCustom,
          // API 格式：空串表示自动识别（保存时按 URL/key 启发式判定）
          api_format: (typeof info === "object" && info.api_format) || "",
        });
      });
    } catch (e) {}

    // 首次安装无 config.yaml 时，注入默认 Hermes Gateway，避免前端 POST 时 active_provider 为空导致 400
    if (ymlProviders.length === 0) {
      const hermesName = "Hermes Gateway";
      ymlProviders.push({
        id: "hermes",
        name: hermesName,
        type: "openai-compatible",
        base_url: "LOCAL",
        model: "auto",
        temperature: 0.7,
        max_tokens: 4096,
        api_key_masked: "",
        api_key_configured: false,
        is_custom: false,
      });
      if (!activeProvName) activeProvName = hermesName;
    }

    // 过滤掉内部 Hermes Gateway provider，不返回给前端
    var visibleProviders = ymlProviders.filter(function(p) { return p.id !== "hermes" && p.base_url !== "LOCAL"; });
    if (visibleProviders.length === 0 && activeProvName === "Hermes Gateway") {
      activeProvName = "";
    }

    // 构建前端配置结构
    const safe = {
      providers: visibleProviders,
      active_provider: activeProvName,
      // 只返回仍存在于面板列表中的回退 id（被删商自动失效）
      fallback_providers: fallbackIds.filter(id => visibleProviders.some(p => p.id === id)),
      _version: CONFIG_VERSION,
      presets: Object.keys(PROVIDER_PRESETS).map(id => ({
        id,
        name: PROVIDER_PRESETS[id].name,
        base_url: PROVIDER_PRESETS[id].base_url,
      })),
      provider_models: PROVIDER_MODELS,
      provider_classes: PROVIDER_CLASSES,
    };
    return new Response(JSON.stringify(safe), { headers: jsonHeaders() });
  }

  // /api/config POST: 写入 providers-state.yaml + .env.providers（设为默认时同步到 Hermes .env）
  if (path === "/api/config" && req.method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return new Response(JSON.stringify({ ok: false, error: "invalid JSON body" }), { status: 400, headers: jsonHeaders() });
      }

      // ── 找到 active provider ─────────────────────────────────────────────────
      const activeProv = (body.providers || []).find(p =>
        p.name === body.active_provider
      );
      if (!activeProv || !activeProv.id) {
        return new Response(JSON.stringify({ ok: false, error: "no active provider" }), { status: 400, headers: jsonHeaders() });
      }
      const providerId = String(activeProv.id).trim();

      // ── 收集所有 provider 的模型 + base_url + 自定义名称 ────────────────────────
      const allProvConfig = {};
      // 先读现有的 providers-state.yaml（保留未编辑的 provider；共享解析逻辑在 primary-config.js）
      try {
        Object.assign(allProvConfig, loadProvidersState());
      } catch (e) {}

      // 合并 body.providers 的数据（前端传来的优先，包括自定义名称 name）
      (body.providers || []).forEach(p => {
        if (!p.id) return;
        let model = p.model;
        if (!model || model === "auto") {
          const defaults = PROVIDER_MODELS[p.id];
          model = (defaults && defaults.length > 0) ? defaults[0] : "auto";
        }
        const existingEntry = allProvConfig[p.id];
        const incomingName = (p.name && String(p.name).trim()) || "";
        // base_url：A 类内置服务商强制存 PROVIDER_PRESETS 默认 URL（编辑框只读，地址由 Hermes 管理），
        // B 类/custom 存用户填写值；确保 providers-state.yaml 对所有商都保存完整 URL 供编辑框回显。
        let baseUrl;
        if (PROVIDER_CLASSES[p.id] === "A" && PROVIDER_PRESETS[p.id]) {
          baseUrl = PROVIDER_PRESETS[p.id].base_url || "";
        } else {
          baseUrl = p.base_url || existingEntry?.base_url || "";
          // 内置预设兜底：用户未填时回填默认 URL
          if (!baseUrl && PROVIDER_PRESETS[p.id]) baseUrl = PROVIDER_PRESETS[p.id].base_url || "";
        }
        const incomingTemp = p.temperature != null ? parseFloat(p.temperature) : null;
        const incomingMax = p.max_tokens != null ? parseInt(p.max_tokens, 10) : null;
        // API 格式：前端显式传值（openai/anthropic）优先；缺省时保留已存值（自动识别态为空串）
        let incomingFmt = p.api_format !== undefined ? normalizeApiFormat(p.api_format) : null;
        // key 前缀启发式只在保存时拿得到明文 key：自动识别态下 sk-ant- 前缀固化为 anthropic
        if (!incomingFmt && p._raw_api_key && String(p._raw_api_key).startsWith("sk-ant-")) {
          incomingFmt = "anthropic";
        }
        allProvConfig[p.id] = {
          model,
          base_url: baseUrl,
          name: incomingName || existingEntry?.name || "",
          temperature: (incomingTemp != null && !isNaN(incomingTemp)) ? incomingTemp : (existingEntry?.temperature ?? null),
          max_tokens: (incomingMax != null && !isNaN(incomingMax)) ? incomingMax : (existingEntry?.max_tokens ?? null),
          api_format: incomingFmt != null ? incomingFmt : (existingEntry?.api_format || ""),
        };
      });

      // 白名单过滤：前端提交的 providers 列表为完整列表，删除 allProvConfig 中已不存在的条目
      if (body.providers) {
        const validIds = new Set(body.providers.map(p => p.id).filter(Boolean));
        Object.keys(allProvConfig).forEach(id => {
          if (!validIds.has(id)) delete allProvConfig[id];
        });
      }

      // ── 写入 providers-state.yaml ───────────────────────────────────────────
      writeProvidersState(allProvConfig, providerId);

      // ── 同步 model section + 自定义 provider 到 Hermes config.yaml ───────────
      // 回退模型 id 列表（首期单选）：校验存在于面板列表且 ≠ active provider；
      //    null 表示本次请求未携带该字段，config.yaml 现有回退配置保持不动；
      //    被删 provider 已被上方白名单过滤剔出 allProvConfig，此处联动清空（双保险）。
      const fallbackIds = Array.isArray(body.fallback_providers)
        ? body.fallback_providers.filter(id => allProvConfig[id] && id !== providerId).slice(0, 1)
        : null;

      // 构建与写入逻辑在 primary-config.js；写失败属致命错误，返回 500。
      const cfgWrite = writeConfigYaml({ allProvConfig, providerId, fallbackIds });
      if (!cfgWrite.ok) {
        return new Response(JSON.stringify({ ok: false, error: cfgWrite.error }), { status: 500, headers: jsonHeaders() });
      }

      // ── 保存 API key 到控制面板专属 .env.providers ────────────────────
      saveProviderKeysToEnv(body.providers);

      // ── 设为默认时，同步 active provider 的 key 到 Hermes .env ──
      syncActiveKeyToHermesEnv(providerId);

      // ── 同步回退服务商 key 到 Hermes .env（缺失会导致回退触发时 401）──
      try {
        if (fallbackIds && fallbackIds.length > 0) {
          syncFallbackKeysToHermesEnv(fallbackIds, `${VAR_DIR}/.env.providers`, `${DATA_DIR}/.env`);
        }
      } catch (e) {}

      // ── 删除已移除 provider 的 .env.providers key ─────────────────────
      cleanupRemovedProviderKeys(body.providers);

      // ── 同步 chat/config.json（保持向后兼容）────────────────────────────────
      try {
        const chatCfg = getChatConfig();
        chatCfg.active_provider = activeProv.name;
        const existingChat = chatCfg.providers.find(p => p.id === activeProv.id);
        if (!existingChat) {
          chatCfg.providers.unshift(activeProv);
        } else {
          // 已存在的条目也同步 model/temperature/max_tokens 等字段，
          // 否则用户修改温度后 chatRequest 读到的仍是旧值
          const norm = allProvConfig[providerId] || {};
          if (activeProv.name) existingChat.name = activeProv.name;
          if (norm.model || activeProv.model) existingChat.model = norm.model || activeProv.model;
          if (norm.base_url || activeProv.base_url) existingChat.base_url = norm.base_url || activeProv.base_url;
          const _t = norm.temperature != null ? norm.temperature : parseFloat(activeProv.temperature);
          if (_t != null && !isNaN(_t)) existingChat.temperature = _t;
          const _x = norm.max_tokens != null ? norm.max_tokens : parseInt(activeProv.max_tokens, 10);
          if (_x != null && !isNaN(_x)) existingChat.max_tokens = _x;
        }
        saveChatConfig(chatCfg);
      } catch {}

      return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders() });
    }

  if (path === "/api/config/test" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    let provider = body.provider || getActiveProvider();
    // 始终从 .env 解析真实 API Key（body.provider 的 key 可能被掩码或为空）
    if (!provider.api_key || provider.api_key.startsWith("****") || provider.api_key === "****keep****") {
      const realKey = resolveRealApiKey(provider);
      if (realKey) provider.api_key = realKey;
    }
    const result = await fetchGatewayModels(provider);
    return new Response(JSON.stringify(result), { headers: jsonHeaders() });
  }

  // API 格式在线探测：后端代理探测 base_url，避免前端跨域（外接模块 api-format.js）
  if (path === "/api/config/detect-format" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const baseUrl = String(body.base_url || "").trim();
    if (!baseUrl) {
      return new Response(JSON.stringify({ ok: false, error: "missing base_url" }), { status: 400, headers: jsonHeaders() });
    }
    // 掩码/缺省 key 时尝试从 .env.providers 解析真实 key（提升探测命中率，非必需）
    let probeKey = String(body.api_key || "").trim();
    if ((!probeKey || probeKey.startsWith("****") || probeKey === "****keep****") && body.id) {
      try {
        const realKey = resolveRealApiKey({ id: body.id, api_key: "" });
        if (realKey) probeKey = realKey;
      } catch { /* 探测可无 key 进行 */ }
    }
    const probed = await probeApiFormat(baseUrl, probeKey);
    // 在线探测失败时降级返回启发式识别结果，保证按钮总有可用反馈
    if (!probed.ok) {
      const guessed = detectApiFormat(baseUrl, probeKey);
      return new Response(JSON.stringify({ ok: false, error: probed.error, guess: guessed.format }), { headers: jsonHeaders() });
    }
    return new Response(JSON.stringify(probed), { headers: jsonHeaders() });
  }

  // ─── 聊天：模型 API ──────────────────────────────────────────────────────
  if (path === "/api/models" && req.method === "GET") {
    const provider = getActiveProvider();
    const result = await fetchGatewayModels(provider);
    return new Response(JSON.stringify(result), { headers: jsonHeaders() });
  }

  // ─── 聊天：会话 API ────────────────────────────────────────────────────
  if (path === "/api/sessions" && req.method === "GET") {
    return new Response(JSON.stringify({ sessions: listSessions() }), { headers: jsonHeaders() });
  }

  if (path === "/api/sessions" && req.method === "POST") {
    const s = {
      id: crypto.randomUUID(),
      title: "New Chat",
      messages: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    saveSession(s);
    return new Response(JSON.stringify(s), { headers: jsonHeaders() });
  }

  // 匹配 /api/sessions/:id
  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const sid = decodeURIComponent(sessionMatch[1]);
    if (req.method === "GET") {
      const s = getSession(sid);
      if (!s) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: jsonHeaders() });
      return new Response(JSON.stringify(s), { headers: jsonHeaders() });
    }
    if (req.method === "DELETE") {
      deleteSession(sid);
      return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders() });
    }
    if (req.method === "POST") {
      // resume：把未完成的 _streaming checkpoint 消息转正（去掉标记保留内容），
      // 避免上次崩溃/断电留下的半成品状态干扰继续对话
      const s = getSession(sid);
      if (!s) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: jsonHeaders() });
      // 保护：会话正在运行（liveRun 未结束）时不转正，避免误伤流式中的 checkpoint
      const _live = liveRuns.get(sid);
      if (_live && !_live.done) {
        return new Response(JSON.stringify({ ok: true, resumed: false, running: true, session: s }), { headers: jsonHeaders() });
      }
      const resumed = resumeStreamingMessages(s, saveSession);
      return new Response(JSON.stringify({ ok: true, resumed, session: s }), { headers: jsonHeaders() });
    }
    if (req.method === "PATCH") {
      const s = getSession(sid);
      if (!s) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: jsonHeaders() });
      try {
        const body = await req.json();
        if (typeof body.title === "string" && body.title.trim()) {
          s.title = body.title.trim().slice(0, 200);
          saveSession(s);
        }
      } catch { return new Response(JSON.stringify({ error: "invalid body" }), { status: 400, headers: jsonHeaders() }); }
      return new Response(JSON.stringify({ ok: true, title: s.title }), { headers: jsonHeaders() });
    }
  }

  // ─── 多会话并发：运行表查询/恢复接口（供前端切窗口时调用）───────────
  // 运行表快照：所有运行中/刚结束（TTL 内）的会话
  if (path === "/api/chat/sessions/active" && req.method === "GET") {
    const items = [];
    for (const [sid, e] of liveRuns) {
      items.push({
        session_id: sid,
        status: e.status,
        started_at: e.started_at,
        updated_at: e.updated_at,
        output_len: e.output_base + e.output.length,
        done: e.done,
      });
    }
    return new Response(JSON.stringify(items), { headers: jsonHeaders() });
  }

  // 单会话运行态增量拉取：?cursor=N（输出文本绝对游标）&tool_cursor=M（工具事件绝对游标）
  const liveMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)\/live$/);
  if (liveMatch && req.method === "GET") {
    const sid = decodeURIComponent(liveMatch[1]);
    const e = liveRuns.get(sid);
    if (!e) {
      // 不在运行表中（从未运行/已过 TTL 被清理）：历史内容请走现有会话接口
      return new Response(JSON.stringify({ status: "idle" }), { headers: jsonHeaders() });
    }
    const cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
    const toolCursor = Math.max(0, Number(url.searchParams.get("tool_cursor")) || 0);
    // 游标早于缓存窗口（头部已被丢弃）时从窗口起点返回，truncated 提示前端有缺口
    const truncated = cursor < e.output_base;
    const outStart = Math.max(0, cursor - e.output_base);
    const toolStart = Math.max(0, toolCursor - e.tool_base);
    return new Response(JSON.stringify({
      status: e.status,
      prompt: e.prompt,
      output: e.output.slice(outStart),
      cursor: e.output_base + e.output.length,
      tool_events: e.tool_events.slice(toolStart),
      tool_cursor: e.tool_base + e.tool_events.length,
      done: e.done,
      truncated,
      started_at: e.started_at,
      updated_at: e.updated_at,
    }), { headers: jsonHeaders() });
  }

  // ─── Chat: WebSocket 消息队列（前端先 POST 消息入队，再建 WS 连接取流）──────
  if (path === "/api/chat/ws-send" && req.method === "POST") {
    const body = await req.json();
    const { session_id, message } = body;
    const messageEmpty = message == null || (Array.isArray(message) && message.length === 0) || (typeof message === "string" && message.length === 0);
    if (!session_id || messageEmpty) {
      return new Response(JSON.stringify({ error: "session_id and message required" }), { status: 400, headers: jsonHeaders() });
    }
    wsMessageQueue.set(session_id, message);
    // 30秒后自动清除（防止 WS 连接未建立导致泄漏）；
    // 同 session 重复入队时先清掉旧定时器，避免旧定时器在新消息 30s 窗口内误删队列
    const _prevTimer = wsQueueTimers.get(session_id);
    if (_prevTimer) clearTimeout(_prevTimer);
    wsQueueTimers.set(session_id, setTimeout(() => {
      wsMessageQueue.delete(session_id);
      wsQueueTimers.delete(session_id);
    }, 30000));
    return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders() });
  }

  // ─── 聊天：流式 API ──────────────────────────────────────────────────────
  if (path === "/api/chat/stream" && req.method === "POST") {
    const body = await req.json();
    const { session_id, message } = body;
    const messageEmpty = message == null || (Array.isArray(message) && message.length === 0) || (typeof message === "string" && message.length === 0);
    if (!session_id || messageEmpty) {
      return new Response(JSON.stringify({ error: "session_id and message required" }), {
        status: 400,
        headers: jsonHeaders(),
      });
    }
    return new Response(createChatStream(session_id, message, req.signal), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no", // 告诉中间的反向代理（常见于 App 内嵌 WebView 的前置网关）不要缓冲，立即转发每个 chunk
        "Access-Control-Allow-Origin": corsOrigin,
      },
    });
  }

  // 显式停止生成（用户主动点击"停止"按钮时调用）——和客户端连接断开是两件事，
  // 普通网络抖动/断线不会再触发这里，只有真正点了停止才会中断模型调用。
  if (path === "/api/chat/stop" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body.session_id) {
      // 按 session 隔离停止：只中断对应会话，其它并发会话不受影响
      const ctrl = activeChatStreams.get(body.session_id);
      if (ctrl) {
        ctrl.abort();
        activeChatStreams.delete(body.session_id);
        return new Response(JSON.stringify({ ok: true, stopped: 1 }), { headers: jsonHeaders() });
      }
      return new Response(JSON.stringify({ ok: false, error: "no active stream for this session" }), { headers: jsonHeaders() });
    }
    // 向后兼容：不带 session_id 时停止全部运行中的会话
    let stopped = 0;
    for (const [sid, ctrl] of activeChatStreams) {
      try { ctrl.abort(); } catch {}
      activeChatStreams.delete(sid);
      stopped++;
    }
    if (stopped > 0) return new Response(JSON.stringify({ ok: true, stopped }), { headers: jsonHeaders() });
    return new Response(JSON.stringify({ ok: false, error: "no active stream" }), { headers: jsonHeaders() });
  }

  // ─── 聊天：图片上传 API ─────────────────────────────────────────────────
  if (path === "/api/chat/upload-image" && req.method === "POST") {
    // 安全：仅在 Gateway 存活时允许上传
    const gwPid = readPidSync(PID_GATEWAY);
    if (!gwPid || !pidAliveSync(gwPid)) {
      return new Response(JSON.stringify({ error: "Gateway offline, image upload disabled" }), {
        status: 503,
        headers: jsonHeaders(),
      });
    }
    // MIME 类型白名单
    const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];
    // 扩展名白名单（MIME → 安全扩展名映射）
    const SAFE_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };
    const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
    try {
      const form = await req.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") {
        return new Response(JSON.stringify({ error: "No file provided" }), { status: 400, headers: jsonHeaders() });
      }
      if (!IMAGE_TYPES.includes(file.type)) {
        return new Response(JSON.stringify({ error: "Unsupported file type" }), { status: 415, headers: jsonHeaders() });
      }
      const buf = await file.arrayBuffer();
      if (buf.byteLength > MAX_SIZE) {
        return new Response(JSON.stringify({ error: "File too large (max 10 MB)" }), { status: 413, headers: jsonHeaders() });
      }
      const ext = SAFE_EXT[file.type] || "bin";
      const filename = randomBytes(16).toString("hex") + "." + ext;
      writeFileSync(`${UPLOAD_IMG_DIR}/${filename}`, Buffer.from(buf));
      return new Response(JSON.stringify({ url: `/uploads/images/${filename}`, path: `${UPLOAD_IMG_DIR}/${filename}` }), { headers: jsonHeaders() });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Upload failed" }), { status: 500, headers: jsonHeaders() });
    }
  }

  // ─── 聊天：通用文件上传 API（非图片附件，落盘到 Hermes home 下，让 Hermes
  //      自己用文件工具读取，而不是把全文本塞进 prompt 撑爆/卡死浏览器）──────────
  if (path === "/api/chat/upload-file" && req.method === "POST") {
    const gwPid = readPidSync(PID_GATEWAY);
    if (!gwPid || !pidAliveSync(gwPid)) {
      return new Response(JSON.stringify({ error: "Gateway offline, file upload disabled" }), {
        status: 503,
        headers: jsonHeaders(),
      });
    }
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB（文件直接落盘、不内联进 prompt，限制可以放宽）
    try {
      const form = await req.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") {
        return new Response(JSON.stringify({ error: "No file provided" }), { status: 400, headers: jsonHeaders() });
      }
      const buf = await file.arrayBuffer();
      if (buf.byteLength > MAX_FILE_SIZE) {
        return new Response(JSON.stringify({ error: "File too large (max 50 MB)" }), { status: 413, headers: jsonHeaders() });
      }
      // 原始文件名做安全清洗，保留可读性（方便 Hermes/用户辨认），但去掉路径分隔符等危险字符
      const origName = (file.name || "file").toString();
      const safeBase = origName.replace(/[/\\]/g, "_").replace(/\.\.+/g, ".").slice(-100) || "file";
      const filename = `${Date.now()}_${randomBytes(6).toString("hex")}_${safeBase}`;
      const fullPath = `${UPLOAD_FILE_DIR}/${filename}`;
      writeFileSync(fullPath, Buffer.from(buf));
      return new Response(JSON.stringify({
        url: `/uploads/files/${encodeURIComponent(filename)}`,
        path: fullPath,
        name: origName,
        size: buf.byteLength,
      }), { headers: jsonHeaders() });
    } catch (err) {
      return new Response(JSON.stringify({ error: "Upload failed" }), { status: 500, headers: jsonHeaders() });
    }
  }

  // ─── 方案 B：/assets/* 兜底路由 ────────────────
  // 前端构建产物用绝对路径 "/assets/xxx" 硬编码在 JS bundle 里（Vite/Rolldown modulepreload），
  // 浏览器会直接请求根路径 /assets/xxx，而非经过 /proxy/dashboard/ 前缀。
  // 此路由从 hermes-web-dist/assets/ 提供对应文件，兜底解决 404 问题。
  // TODO: 一旦前端以 base:'./' 重新构建部署，此兜底可删除。
  if (path.startsWith("/assets/")) {
    const assetRel = path.slice("/assets/".length);
    if (assetRel.includes("..") || !assetRel) return new Response("Forbidden", { status: 403 });
    const assetFp = `${APP_DIR}/hermes-web-dist/assets/${assetRel}`;
    if (!existsSync(assetFp)) return new Response("Not Found", { status: 404 });
    const ext = assetFp.split(".").pop()?.toLowerCase();
    const ct = ext === "js"   ? "application/javascript; charset=utf-8"
             : ext === "css"  ? "text/css; charset=utf-8"
             : ext === "map"  ? "application/json"
             : ext === "woff2" ? "font/woff2"
             : ext === "woff" ? "font/woff"
             : "application/octet-stream";
    return serveFile(assetFp, ct);
  }

  // /fonts/ 和 /fonts-terminal/ 兜底（index.html 中的字体引用）
  if (path.startsWith("/fonts/") || path.startsWith("/fonts-terminal/")) {
    const fontRel = path.slice(1); // 去掉前导 /
    if (fontRel.includes("..")) return new Response("Forbidden", { status: 403 });
    const fontFp = `${APP_DIR}/hermes-web-dist/${fontRel}`;
    if (!existsSync(fontFp)) return new Response("Not Found", { status: 404 });
    const ext = fontFp.split(".").pop()?.toLowerCase();
    const ct = ext === "woff2" ? "font/woff2" : ext === "woff" ? "font/woff" : "application/octet-stream";
    return serveFile(fontFp, ct);
  }

  // /favicon.ico 兜底
  if (path === "/favicon.ico") {
    const fp = `${APP_DIR}/hermes-web-dist/favicon.ico`;
    if (existsSync(fp)) return serveFile(fp, "image/x-icon");
  }

  // Dashboard 反代
  if (path.startsWith("/proxy/dashboard")) {
    return handleDashboardHttp(req, path);
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

  // 持久化上传（图片 + 文件），从 DATA_DIR/uploads（= HERMES_HOME/uploads）提供
  if (path.startsWith("/uploads/")) {
    const relPath = decodeURIComponent(path.slice("/uploads/".length));
    if (relPath.includes("..") || !relPath) return new Response("Forbidden", { status: 403 });
    const fp = `${UPLOAD_DIR}/${relPath}`;
    if (!existsSync(fp)) return new Response("Not Found", { status: 404 });
    const ext = fp.split(".").pop()?.toLowerCase();
    const ct  = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
              : ext === "png"  ? "image/png"
              : ext === "gif"  ? "image/gif"
              : ext === "webp" ? "image/webp"
              : ext === "svg"  ? "image/svg+xml"
              : ext === "pdf"  ? "application/pdf"
              : ext === "txt"  ? "text/plain; charset=utf-8"
              : ext === "json" ? "application/json"
              : "application/octet-stream";
    return serveFile(fp, ct);
  }

  // 临时上传图片（兼容路径 /tmp/filename.ext，从 TMP_DIR 提供）
  if (path.startsWith("/tmp/")) {
    const filename = path.slice(5); // 去掉 "/tmp/"
    if (filename.includes("..") || !filename) return new Response("Forbidden", { status: 403 });
    const fp = `${TMP_DIR}/${filename}`;
    if (!existsSync(fp)) return new Response("Not Found", { status: 404 });
    const ext = fp.split(".").pop()?.toLowerCase();
    const ct  = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
              : ext === "png"  ? "image/png"
              : ext === "gif"  ? "image/gif"
              : ext === "webp" ? "image/webp"
              : ext === "svg"  ? "image/svg+xml"
              : "application/octet-stream";
    return serveFile(fp, ct);
  }

  // 工作区文件（持久化），从 DATA_DIR/workspace 提供
  if (path.startsWith("/workspace/")) {
    const relPath = decodeURIComponent(path.slice("/workspace/".length));
    if (relPath.includes("..") || !relPath) return new Response("Forbidden", { status: 403 });
    const fp = `${WORKSPACE_DIR}/${relPath}`;
    if (!existsSync(fp)) return new Response("Not Found", { status: 404 });
    const ext = fp.split(".").pop()?.toLowerCase();
    const ct  = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
              : ext === "png"  ? "image/png"
              : ext === "gif"  ? "image/gif"
              : ext === "webp" ? "image/webp"
              : ext === "svg"  ? "image/svg+xml"
              : ext === "pdf"  ? "application/pdf"
              : ext === "txt"  ? "text/plain; charset=utf-8"
              : ext === "json" ? "application/json"
              : ext === "csv"  ? "text/csv; charset=utf-8"
              : ext === "html" ? "text/html; charset=utf-8"
              : "application/octet-stream";
    return serveFile(fp, ct);
  }

  // data 目录文件（广义），从 DATA_DIR 提供
  // /data/workspace/... 作为子路径自动覆盖
  // 安全：屏蔽敏感文件/目录（.env、config.yaml、configs/、sessions/、venv/、隐藏文件）
  if (path.startsWith("/data/")) {
    const relPath = decodeURIComponent(path.slice("/data/".length));
    if (relPath.includes("..") || !relPath) return new Response("Forbidden", { status: 403 });
    // 屏蔽敏感路径
    if (/^\.env/i.test(relPath) ||        // .env 文件
        /^config\.ya?ml/i.test(relPath) || // config.yaml / config.yml
        /^configs\//i.test(relPath) ||     // configs/（令牌、API Key）
        /^sessions\//i.test(relPath) ||    // sessions/（私密聊天数据）
        /^venv\//i.test(relPath) ||        // venv/（Python 环境）
        /(^|\/)\./.test(relPath))          // 任意隐藏文件/目录
      return new Response("Forbidden", { status: 403 });
    const fp = `${DATA_DIR}/${relPath}`;
    if (!existsSync(fp)) return new Response("Not Found", { status: 404 });
    const ext = fp.split(".").pop()?.toLowerCase();
    const ct  = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
              : ext === "png"  ? "image/png"
              : ext === "gif"  ? "image/gif"
              : ext === "webp" ? "image/webp"
              : ext === "svg"  ? "image/svg+xml"
              : ext === "pdf"  ? "application/pdf"
              : ext === "txt"  ? "text/plain; charset=utf-8"
              : ext === "json" ? "application/json"
              : ext === "csv"  ? "text/csv; charset=utf-8"
              : ext === "html" ? "text/html; charset=utf-8"
              : "application/octet-stream";
    return serveFile(fp, ct);
  }

  return new Response("Not Found", { status: 404 });
}

// ─── SIGTERM / SIGINT：优雅关闭 ─────────────────────────────────────
let shuttingDown = false;
async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log("Received SIGTERM, shutting down gateway + dashboard ...");
  await Promise.all([stopPid(PID_GATEWAY), stopPid(PID_DASHBOARD)]);
  // 兜底：PID 文件丢失/过期时 pkill 按路径模式清理残留进程
  await forceKillHermes();
  log("Shutdown complete");
  process.exit(0);
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

// ─── 服务处理器导出（socket 绑定、chmod 与单实例检查已移交 boot.js）──────
// boot.js 独占 unix socket 与 serve()，并在其 fetch(req, server) 中调用本函数；
// 保持原 serve().fetch 的路由语义不变：/api/chat/ws 升级、Dashboard WS 反代、
// 其余交回 handleFetch。原“Monitor ready”日志与 socket chmod 现由 boot.js 负责。
export function handleServe(req, server) {
  const url = new URL(req.url);
  const wsPath = url.pathname.replace(/^\/app\/[^/]+/, "") || "/";
  // WebSocket 升级：/api/chat/ws?session_id=xxx&token=xxx
  if (wsPath === "/api/chat/ws") {
    const token = url.searchParams.get("token") || "";
    if (MONITOR_TOKEN && token !== MONITOR_TOKEN) {
      // Better error handling - write directly to socket for Bun compatibility
      // Note: This will be handled by node-adapter.js upgrade handler
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
    const sessionId = url.searchParams.get("session_id") || "";
    const _q = wsMessageQueue.get(sessionId);
    
    // Allow empty queue connections (for reconnection scenarios)
    if (!sessionId) {
      return new Response(JSON.stringify({ error: "no session_id provided" }), { status: 400 });
    }
    
    // Only delete queued message if it exists (preserve context for reconnects)
    // ws-send 入队的是原始 message（string/array，前端契约），同时兼容
    // {message, system, model, provider} 对象形式；无队列项 = 重连（message=null）
    const message = _q
      ? (typeof _q === "object" && !Array.isArray(_q) && _q !== null && "message" in _q ? _q.message : _q)
      : null;
    const _qObj = (_q && typeof _q === "object" && !Array.isArray(_q)) ? _q : {};
    const system = _qObj.system || "";
    const model = _qObj.model || "";
    const provider = _qObj.provider || "";
    if (_q) {
      wsMessageQueue.delete(sessionId);
      // 队列已被 WS 连接消费，取消待执行的清理定时器
      const _t = wsQueueTimers.get(sessionId);
      if (_t) { clearTimeout(_t); wsQueueTimers.delete(sessionId); }
    }
    
    // Store enhanced data for reconnection support
    const upgraded = server.upgrade(req, { 
      data: { 
        sessionId,
        message,  // Can be null on reconnect
        system,
        model,
        provider,  // Preserve context
        stopCtrl: null
      } 
    });
    if (!upgraded) return new Response("WebSocket upgrade failed", { status: 500 });
    return; // 已升级
  }
  // Dashboard WebSocket 反代：/proxy/dashboard/api/(ws|events|pty)
  if (matchDashboardWsPath(wsPath)) {
    return upgradeDashboardWs(req, server, wsPath, url);
  }
  return handleFetch(req);
}

// WebSocket 处理器导出：boot.js 的 websocket 调度器据此委派 open/message/close。
export { wsHandler as websocket };