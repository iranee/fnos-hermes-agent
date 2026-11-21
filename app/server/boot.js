// Hermes Agent 引导进程 — Node.js HTTP 服务（Unix Socket 拥有者）
//
// 设计目标：本文件只保留最少的代码，保持稳定，今后基本不需要再改。它独占 unix socket 的绑定，
// 无论业务模块 monitor.js 是否成功加载，都能对外提供 UI 静态资源，
// 从而避免 monitor.js 语法错误 / import 崩溃 / 初始化异常时整页白屏。
//
// 加载成功：所有请求转发给 monitor.js 导出的 handleServe / websocket 处理器。
// 加载失败：由本文件内置的兜底静态服务接管，API 一律返回 503 并附带加载错误。
//
// 为保证引导层足够稳定，这里只依赖运行时适配层与少量 Node 核心模块，
// 不引入任何业务模块（channels / dashboard / primary-config 等）。

import { serve, file } from "./node-adapter.js";
import { existsSync, unlinkSync, chmodSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import net from "net";
import { isAbsolute } from "node:path";
import { isFnosAdmin } from "./fnos-access.js";

// ─── 路径解析（仅复刻 monitor.js 中最小必要的推导）─────────────────────
// 生产环境由 cmd/main 注入 APP_DIR，此处优先取环境变量，缺失时从本文件
// 所在目录（<APP_DIR>/server）回退推导，保证脱离 cmd/main 直接运行也可用。
function bootDir() {
  try { return fileURLToPath(new URL(".", import.meta.url)).replace(/[/\\]+$/, ""); }
  catch { return ""; }
}

let APP_DIR = process.env.APP_DIR;
if (!APP_DIR) {
  const dir = bootDir(); // 形如 <APP_DIR>/server
  APP_DIR = dir ? dir.replace(/[/\\][^/\\]+$/, "") : "/vol1/@appcenter/hermes-agent";
}

const DATA_DIR   = process.env.DATA_DIR;
const VAR_DIR    = process.env.VAR_DIR;
if (!DATA_DIR || !isAbsolute(DATA_DIR) || !VAR_DIR || !isAbsolute(VAR_DIR)) {
  console.error("[boot][FATAL] Explicit absolute DATA_DIR and VAR_DIR are required; refusing to open a different data directory");
  process.exit(1);
}
const STATIC_DIR = `${APP_DIR}/ui`;

const SOCKET_PATH = (process.env.MONITOR_SOCKET_PATH || "").trim();
if (!SOCKET_PATH) {
  console.error("[boot][FATAL] MONITOR_SOCKET_PATH is required — unix socket mode only");
  process.exit(1);
}

const INFO_LOG        = `${VAR_DIR}/info.log`;    // 由 cmd/main 重定向 stdout/stderr 的启动日志
const MONITOR_LOG     = `${VAR_DIR}/monitor.log`; // monitor.js 自身日志文件

// ─── 运行状态 ───────────────────────────────────────────────────────────
let mon = null;        // 成功加载的 monitor.js 模块命名空间
let loadError = null;  // monitor.js 加载 / 初始化失败时的错误对象

// ─── 日志：追加北京时间戳，同时写 info.log 与 monitor.log，并在控制台打印 ──
// 说明：cmd/main 已将本进程 stdout/stderr 重定向进 info.log，故 console 输出
// 会在 info.log 中额外留存一份，属预期内的少量冗余。显式追加则保证脱离重定向
// 运行时两份日志文件依然可见。
function beijingTime() {
  const d = new Date(Date.now() + 8 * 3600000);
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}
function bootLog(msg) {
  const line = `[boot] ${beijingTime()} ${msg}\n`;
  try { appendFileSync(INFO_LOG, line); } catch {}
  try { appendFileSync(MONITOR_LOG, line); } catch {}
  console.log(line.replace(/\n$/, ""));
}

// ─── 进程级兜底：boot 现为 socket 拥有者，绑定冲突时退出交由外部重启 ──────
process.on("uncaughtException", (err) => {
  bootLog(`[FATAL] uncaughtException: ${err?.message || err}\n${err?.stack || ""}`);
  if (err?.code === "EADDRINUSE") {
    // 真正的竞态：另一个实例几乎同时通过了下方的存活探测并抢先绑定。
    // 此时不能继续运行成僵尸实例，直接退出，交给外部重启策略处理。
    bootLog("[FATAL] socket 绑定冲突，退出进程");
    process.exit(1);
  }
});
process.on("unhandledRejection", (err) => {
  bootLog(`[FATAL] unhandledRejection: ${err?.message || err}\n${err?.stack || ""}`);
});

// ─── 单实例保护：绑定 unix socket 前先探测是否已有存活实例（自 monitor.js 迁入）──
// serve() 对 unix socket 的 listen 是异步的，EADDRINUSE 只会以 uncaughtException
// 的形式滞后出现，无法同步发现重复启动。因此启动前主动探测 socket 文件是否真的
// 有进程在监听：若有则直接退出避免抢占，若只是上次进程非正常终止残留的旧文件，
// 先删除再正常绑定。
function checkSocketAlive(path) {
  return new Promise((resolve) => {
    const sock = net.connect(path);
    const finish = (alive) => {
      try { sock.destroy(); } catch {}
      resolve(alive);
    };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    setTimeout(() => finish(false), 1000);
  });
}

if (existsSync(SOCKET_PATH)) {
  const alive = await checkSocketAlive(SOCKET_PATH);
  if (alive) {
    bootLog(`[FATAL] 检测到另一个实例已在监听 ${SOCKET_PATH}，本进程退出以避免重复启动`);
    process.exit(1);
  } else {
    bootLog(`[启动清理] 发现残留的 socket 文件（无进程监听），已删除：${SOCKET_PATH}`);
    try { unlinkSync(SOCKET_PATH); } catch (e) {
      bootLog(`[启动清理] 删除残留 socket 文件失败: ${e.message}`);
    }
  }
}

// ─── 兜底静态服务 ───────────────────────────────────────────────────────
// content-type 扩展名映射与 monitor.js handleFetch 中的静态资源逻辑保持一致。
function contentTypeOf(fp) {
  const ext = fp.split(".").pop()?.toLowerCase();
  return ext === "html" ? "text/html; charset=utf-8"
       : ext === "js"   ? "application/javascript"
       : ext === "css"  ? "text/css"
       : ext === "png"  ? "image/png"
       : ext === "svg"  ? "image/svg+xml"
       : ext === "webp" ? "image/webp"
       : ext === "gif"  ? "image/gif"
       : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
       : ext === "json" ? "application/json"
       : "text/plain; charset=utf-8";
}

// 读文件并整体载入 Response（沿用 monitor.serveFile 的 file() 流式读取方式）。
async function serveStatic(filePath, contentType) {
  if (!existsSync(filePath)) return new Response("Not Found", { status: 404 });
  try {
    const chunks = [];
    for await (const chunk of file(filePath)) chunks.push(chunk);
    return new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": contentType || contentTypeOf(filePath) },
    });
  } catch (e) {
    return new Response("Internal Server Error", { status: 500 });
  }
}

// ─── 兜底请求处理（仅在 monitor.js 未加载时命中）─────────────────────────
// 统一剥离 fnOS 网关不剥离的 /app/{appname}/ 前缀后再匹配路径。
function bootFallback(req) {
  const url  = new URL(req.url);
  const path = url.pathname.replace(/^\/app\/[^/]+/, "").replace(/\/+$/, "") || "/";

  // 其它 API：monitor 未加载一律 503
  if (path.startsWith("/api/")) {
    return new Response(JSON.stringify({
      error: "monitor not loaded",
      detail: loadError ? (loadError.message || String(loadError)) : null,
    }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }

  // 静态资源：根路径与 index.html
  if (path === "/" || path === "/index.html") {
    return serveStatic(`${STATIC_DIR}/index.html`, "text/html; charset=utf-8");
  }
  // fnOS 应用描述文件
  if (path === "/config") {
    return serveStatic(`${STATIC_DIR}/config`, "application/json");
  }
  // /scripts/、/images/、/css/、/js/ 下的静态资源
  if (path.startsWith("/scripts/") || path.startsWith("/images/") ||
      path.startsWith("/css/") || path.startsWith("/js/")) {
    const rel = path.slice(1);
    if (rel.includes("..")) return new Response("Forbidden", { status: 403 });
    return serveStatic(`${STATIC_DIR}/${rel}`, contentTypeOf(rel));
  }
  // 其它路径：命中 STATIC_DIR 下真实存在的文件则返回，否则 404
  const rel = path.slice(1);
  if (rel && !rel.includes("..") && existsSync(`${STATIC_DIR}/${rel}`)) {
    return serveStatic(`${STATIC_DIR}/${rel}`, contentTypeOf(rel));
  }
  return new Response("Not Found", { status: 404 });
}

// ─── 绑定 socket 并启动服务 ─────────────────────────────────────────────
// fetch / websocket 均为调度器：monitor 已加载则委派其导出处理器，未加载则走兜底。
serve({
  fetch(req, server) {
    if (!isFnosAdmin(req)) return new Response("fnOS administrator access is required", { status: 403 });
    if (mon && typeof mon.handleServe === "function") {
      return mon.handleServe(req, server);
    }
    return bootFallback(req);
  },
  websocket: {
    open(ws)         { if (mon && mon.websocket && mon.websocket.open)    mon.websocket.open(ws); else { try { ws.close(); } catch {} } },
    message(ws, msg) { if (mon && mon.websocket && mon.websocket.message) mon.websocket.message(ws, msg); },
    close(ws, code, reason) { mon?.websocket?.close?.(ws, code, reason); },
    error(ws, error) { mon?.websocket?.error?.(ws, error); },
    drain(ws)        { if (mon && mon.websocket && mon.websocket.drain)   mon.websocket.drain(ws); },
  },
  error(err) {
    bootLog(`Server error: ${err?.message || err}`);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  },
  unix: SOCKET_PATH,
  idleTimeout: 255,
});

// socket 由 listen 异步创建，此处 chmod 可能早于文件生成而失败（失败直接忽略即可），
// cmd/main 检测到 socket 后还会再执行一次 chmod 777 作为保底，两者行为与原 monitor.js 一致。
try { chmodSync(SOCKET_PATH, 0o777); } catch {}

// ─── 动态加载业务模块 monitor.js ────────────────────────────────────────
// 任何加载 / 初始化异常都被此处捕获：mon 保持为 null，服务自动进入兜底模式（静态页可用，API 返回 503）。
try {
  const m = await import("./monitor.js");
  if (typeof m.startMonitor === "function") await m.startMonitor();
  mon = m;
  bootLog("[启动] 管理服务已就绪");
} catch (e) {
  loadError = e;
  bootLog(`[FATAL] monitor.js 加载失败，进入兜底模式（静态页可用，API 返回 503）: ${e?.message || e}\n${e?.stack || ""}`);
}
