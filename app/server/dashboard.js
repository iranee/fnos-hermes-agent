// Dashboard 集成模块

//
// 使用方式（monitor.js）:

import { spawn, WebSocketClient } from "./node-adapter.js";
import { unlinkSync } from "node:fs";

// ─── Dashboard 端口常量（monitor.js 的 gateway/dashboard 联合端口决策会引用） ───
export const DEFAULT_DASHBOARD_PORT = 9119;
export const ALTERNATE_DASHBOARD_PORT = 29119;
export const DASHBOARD_BIND = "127.0.0.1";

// ─── 注入的运行时依赖与解析后配置 ─────────────────────────────────────
let D = {
  port: DEFAULT_DASHBOARD_PORT,   // 解析后的 Dashboard 端口
  gatewayPort: 0,                 // 网关端口（反代层网关重启收尾判定用）
  basePath: "",                   // BASE_PATH（fnOS 反代前缀）
  pidFile: "",                    // dashboard.pid 路径
  log: () => {},
  readPid: () => null,
  stopPid: async () => {},
  spawnHermes: () => ({ ok: false }),
  findGatewayPid: () => null,
  isPortListening: () => false,
  portAlive: async () => false,
};

export function initDashboard(deps) {
  D = { ...D, ...deps };
  // 补充传递 session token（由 monitor.js 注入）
  if (deps.dashboardSessionToken) {
    D.dashboardSessionToken = deps.dashboardSessionToken;
  }
}

export function getDashboardPort() {
  return D.port;
}

// ─── 进程启停 ───────────────────────────────────────────────────────
export function spawnDashboard() {
  const result = D.spawnHermes("dashboard", D.pidFile, ["dashboard", "--host", DASHBOARD_BIND, "--port", String(D.port), "--no-open", "--insecure"]);
  if (result.ok) {
    D.log(`[Dashboard] 启动成功 pid=${result.pid}`);
  } else {
    D.log(`[Dashboard] ⚠️ 启动失败：${JSON.stringify(result)}`);
  }
  return result;
}

// POST /api/dashboard/start
export function handleDashboardStart(jsonHeaders) {
  const r = spawnDashboard();
  if (r.ok) {
    D.log(`[Dashboard] 启动成功 pid=${r.pid}`);
  } else {
    D.log(`[Dashboard] ⚠️ 启动失败：${JSON.stringify(r)}`);
  }
  return new Response(JSON.stringify({ dashboard: r }), { headers: jsonHeaders() });
}

// POST /api/dashboard/stop
export async function handleDashboardStop(jsonHeaders) {
  const dbAlive = D.readPid(D.pidFile);
  await D.stopPid(D.pidFile);
  // 强制杀掉残留的 dashboard 进程（PID 文件可能已失效）
  try {
    const proc = spawn(["pkill", "-SIGKILL", "-f", "hermes-agent.*dashboard"]);
    await proc.exited;
  } catch {}
  if (dbAlive) D.log("Dashboard stopped (pid=" + dbAlive + ")");
  return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders() });
}

// ─── 健康探测（getStatus 在 PID 存活时调用） ─────────────────────────
export async function checkDashboardHealth() {
  try {
    const r = await fetch(`http://${DASHBOARD_BIND}:${D.port}/`, {
      signal: AbortSignal.timeout(300),
    });
    const healthy = r.ok;
    
    // 只在状态变化时记录日志
    if (healthy && lastDashboardHealthStatus !== true) {
      D.log(`[Dashboard Health] ✓ 健康检查通过 (端口 ${D.port})`);
      lastDashboardHealthStatus = true;
    } else if (!healthy && lastDashboardHealthStatus !== false) {
      D.log(`[Dashboard Health] ✗ 健康检查失败：${r.status || 'fetch failed'}`);
      lastDashboardHealthStatus = false;
    }
    
    return healthy;
  } catch (e) { 
    // 只在首次失败时记录详细错误
    if (lastDashboardHealthStatus !== false) {
      D.log(`[Dashboard Health] ✗ 健康检查失败：${e?.message || e}`);
      lastDashboardHealthStatus = false;
    }
    return false; 
  }
}

// ─── HTTP 反代 ──────────────────────────────────────────────────────
const RESTART_SETTLE_MS = 6000;
let lastGatewayRestartTs = 0;

// Dashboard 健康检查状态跟踪（避免每秒重复日志）
let lastDashboardHealthStatus = null;

// 本地进程存活检查（避免依赖 monitor.js 私有函数）
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

let restartFirstSeen = { pid: 0, ts: 0 };

// /proxy/dashboard 路由入口：前缀剥离守卫 + 未运行 503 + 反代
export function handleDashboardHttp(req, path) {
  const subPath = path.replace(/^\/proxy\/dashboard/, "") || "/";
  if (subPath.includes("..")) return new Response("Forbidden", { status: 403 });

  // Dashboard 未运行时直接返回 503，不进入 proxy 避免打错误日志
  const dbPid = D.readPid(D.pidFile);
  if (!dbPid) {
    D.log(`[Dashboard Proxy] Dashboard 未运行 (PID 文件缺失)`);
    return new Response(JSON.stringify({ error: "Dashboard is not running" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  // 额外检查：进程是否真正存活
  if (!pidAlive(dbPid)) {
    D.log(`[Dashboard Proxy] Dashboard 进程已死亡 (pid=${dbPid})`);
    try { unlinkSync(D.pidFile); } catch {}
    return new Response(JSON.stringify({ error: "Dashboard process died" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  return proxyDashboard(req);
}

async function proxyDashboard(req) {
  const url     = new URL(req.url);
  // 自动探测 Portal 前缀：从路径中提取 /proxy/dashboard 之前的部分
  const _dashPrefixBase = (url.pathname.split("/proxy/dashboard")[0] || "").replace(/\/+$/, "");
  const basePathClean = (D.basePath || "").replace(/\/+$/, "");
  const prefix = (_dashPrefixBase || basePathClean || "/") + "/proxy/dashboard";

  // [LOG] 记录请求入口信息
  D.log(`[Dashboard Proxy] REQUEST: prefix=${prefix}, request.url=${req.url}, url.pathname=${url.pathname}`);

  // req.url 仍含 BASE_PATH 前缀（handleFetch 只剥了 path 变量），需先去掉
  const subPath = url.pathname
    .replace(new RegExp(`^${prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`), "")
    .replace(/^\/proxy\/dashboard/, "") || "/";
  const target  = `http://${DASHBOARD_BIND}:${D.port}${subPath}${url.search}`;

  // [LOG] 记录解析后的子路径和目标 URL
  D.log(`[Dashboard Proxy] PARSED: subPath="${subPath}", targetUrl="${target}"`);

// 记录网关重启请求时刻
  let restartPreGwPid = 0;
  if (req.method === "POST" && subPath === "/api/gateway/restart") {
    lastGatewayRestartTs = Date.now();
    restartPreGwPid = D.findGatewayPid() || 0;
  }

  try {
    const headers = new Headers(req.headers);
    headers.delete("host");
    const hasReqBody = req.method !== "GET" && req.method !== "HEAD";
    const upstream = await fetch(target, {
      method:  req.method,
      headers,
      body:    hasReqBody ? req.body : undefined,
      duplex:  hasReqBody ? "half" : undefined,
      signal:  AbortSignal.timeout(10000),
    });

    const respHeaders = new Headers(upstream.headers);

    // ── 3xx 重定向：改写 Location 头 ──
    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = respHeaders.get("location");
      if (loc) {
        try {
          const abs = new URL(loc, target);
          respHeaders.set("location", prefix + abs.pathname + abs.search);
          D.log(`[Dashboard Proxy] REDIRECT: Location 改为 ${prefix + abs.pathname + abs.search}`);
        } catch {}
      }
      return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
    }

    const contentType = respHeaders.get("content-type") || "";

    // [LOG] 记录上游返回的 Content-Type（用于后续 HTML/CSS 识别）
    D.log(`[Dashboard Proxy] UPSTREAM RESPONSE: status=${upstream.status}, content-type="${contentType}"`);

    // ── 网关重启 POST：强制重发 ──
    if (req.method === "POST" && subPath === "/api/gateway/restart") {
      let bodyText = await upstream.text();
      try {
        const j = JSON.parse(bodyText);
        const rpid = Number(j && j.pid) || 0;
        if (rpid && restartPreGwPid && rpid === restartPreGwPid && D.isPortListening(D.gatewayPort)) {
          D.log(`[restart] 官方复用旧网关进程 pid=${rpid}(未真正重启)，杀掉后强制重发重启`);
          try { process.kill(rpid, "SIGTERM"); } catch {}
          // 以端口是否仍在 LISTEN 判断旧网关是否已退出（比 pidAlive 更可靠：
          // 进程成为 zombie 时 kill(pid,0) 仍返回存活，会误判）。
          const deadline = Date.now() + 3000;
          while (D.isPortListening(D.gatewayPort) && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 100));
          }
          if (D.isPortListening(D.gatewayPort)) {
            try { process.kill(rpid, "SIGKILL"); } catch {}
            await new Promise(r => setTimeout(r, 300));
          }
          // 旧进程已退出，官方复用守卫的 poll() 将失效 → 重发触发真正的新 restart
          restartFirstSeen = { pid: 0, ts: 0 };
          lastGatewayRestartTs = Date.now();
          const rh = new Headers(req.headers);
          rh.delete("host");
          // 重发不带 body，须清除原始请求的 body 相关头，否则上游等 body 超时
          rh.delete("content-length");
          rh.delete("content-type");
          rh.delete("transfer-encoding");
          try {
            const up2 = await fetch(target, { method: "POST", headers: rh, signal: AbortSignal.timeout(10000) });
            bodyText = await up2.text();
            D.log(`[restart] 已强制重发重启，官方应 spawn 新 gateway restart 进程`);
          } catch (e) {
            D.log(`[restart] 强制重发重启失败：${e?.message || e}`);
          }
        }
      } catch {}
      respHeaders.delete("content-length");
      respHeaders.set("cache-control", "no-store");
      return new Response(bodyText, { status: upstream.status, headers: respHeaders });
    }

    // ── 网关重启 action 状态改写 ──
    if (req.method === "GET" && subPath === "/api/actions/gateway-restart/status") {
      let bodyText = await upstream.text();
      try {
        const j = JSON.parse(bodyText);
        if (j && j.running === true) {
          const now = Date.now();
          const pid = Number(j.pid) || 0;
// pid 变化视为新的重启进程
          if (restartFirstSeen.pid !== pid) {
            restartFirstSeen = { pid, ts: now };
          }
          // 以「用户最近一次点击重启」或「首次观测到 running」中较晚者为起点计 settle
          const startedMs = Math.max(restartFirstSeen.ts, lastGatewayRestartTs || 0);
          const settled = (now - startedMs) > RESTART_SETTLE_MS;
// 优先用 /proc 的 LISTEN 判据
          const listening = D.isPortListening(D.gatewayPort);
          const alive = settled && (listening || await D.portAlive(D.gatewayPort));
          if (settled && alive) {
            j.running = false;
            if (j.exit_code === null || j.exit_code === undefined) j.exit_code = 0;
            bodyText = JSON.stringify(j);
            D.log(`[restart] 网关端口 ${D.gatewayPort} 健康且已 settle(${((now - startedMs) / 1000).toFixed(1)}s)，改写 gateway-restart 状态为完成以收尾「重启中」`);
          } else {
            D.log(`[restart] gateway-restart 仍 running：settled=${settled} listening=${listening} pid=${pid}`);
          }
        } else {
          restartFirstSeen = { pid: 0, ts: 0 };
        }
      } catch {}
      respHeaders.delete("content-length");
      respHeaders.set("cache-control", "no-store");
      return new Response(bodyText, { status: upstream.status, headers: respHeaders });
    }

// ── CSS 响应：改写 url(/...) ──
    // [METHOD 1] 通过 contentType 判断
    // [METHOD 2] 兜底：检查 subPath 是否指向 .css 文件
    const isCssByType = contentType.toLowerCase().includes("text/css");
    const isCssByPath = subPath.endsWith(".css");
    
    if (isCssByType || isCssByPath) {
      D.log(`[Dashboard Proxy] CSS DETECTED: isCssByType=${isCssByType}, isCssByPath=${isCssByPath}, subPath="${subPath}"`);
      
      let css = await upstream.text();
      
      // [MODIFY] 路径重写
      const originalCss = css.substring(0, 200).replace(/[\r\n]/g, '\\n');
      D.log(`[Dashboard Proxy] CSS CONTENT STARTS WITH: ${originalCss}`);
      
      css = css.replace(/url\((\/[^)'"\+])\)/g, `url(${prefix}$1)`);
      
      respHeaders.delete("content-length");
      return new Response(css, { status: upstream.status, headers: respHeaders });
    }

// ── HTML 响应：注入 <base> + 路径改写脚本 ──
    // [STRATEGY 1] 通过 contentType 判断（原方法，兼容各种变体）
    const isHtmlByContentType = contentType.toLowerCase().includes("text/html") 
        || contentType.startsWith("application/xhtml")
        || (upstream.headers.get("content-type") && upstream.headers.get("content-type").match(/html|xml/i));
    
    // [STRATEGY 2] 通过 subPath 后缀判断（更可靠，不依赖上游返回的 header）
    const isHtmlByPath = subPath === "/" || subPath.endsWith(".html");
    
    // [STRATEGY 3] Trim CLI 模式：已知 SPA 路由强制 HTML 处理（即使 content-type 错误）
    const isKnownSpaRoute = /^(\/chat|\/models|\/profiles|\/files|\/mcp|\/webhooks|\/rules|\/sessions|\/skills|\/analytics|\/cron|\/env|\/system|\/docs|\/log|\/pairing|\/console)$/i.test(subPath);
    
    // [DIAGNOSTIC] 当是已知的 SPA 路由但返回非 HTML 类型时输出警告
    if (isKnownSpaRoute && !contentType.includes("text/html")) {
      D.log(`[Dashboard Proxy] WARNING: SPA route '${subPath}' returned non-HTML content-type (${contentType}), forcing HTML processing`);
    }
    
    // 组合判断：优先使用 STRATEGY 3（强制），然后其他策略任意一个匹配即可
    const isHtmlResponse = isKnownSpaRoute || isHtmlByContentType || isHtmlByPath;
    
    if (isHtmlResponse) {
      // [LOG] HTML 检测结果详情
      D.log(`[Dashboard Proxy] HTML DETECTION:`);
      D.log(`  - isHtmlByContentType: ${isHtmlByContentType} (contentType="${contentType}")`);
      D.log(`  - isHtmlByPath: ${isHtmlByPath} (subPath="${subPath}")`);
      D.log(`  - isKnownSpaRoute: ${isKnownSpaRoute}`);
      D.log(`  - FINAL DECISION: HTML response will be processed`);
          
      let html = await upstream.text();
          
      // [LOG] 原始 HTML 片段（前 500 字符）
      const htmlPreview = html.substring(0, 500).replace(/\r\n/g, '\\n');
      D.log(`[Dashboard Proxy] HTML PREVIEW (${html.length} bytes): ${htmlPreview}`);
      
      // [CHECK] 检查原始 HTML 是否已有 base 标签
      const hasOriginalBaseTag = /<base\s[^>]*>/gi.test(html);
      D.log(`[Dashboard Proxy] HAS ORIGINAL BASE TAG: ${hasOriginalBaseTag}`);
      
      // <base> 处理相对路径（多模式兼容）—— 根治静态脚本 404
      html = html.replace(/<base\s[^>]*>/gi, ""); // 先删除原有 base（如果有）
      
      if (hasOriginalBaseTag) {
        D.log(`[Dashboard Proxy] INFO: Removed existing <base> tag`);
      }

      // 尝试：<head attr="value"> / <head/> / <head \n...>
      const headMatch = html.match(/<head(?:\s[^>]*)?>/i);
      if (headMatch) {
        const endIdx = headMatch.index + headMatch[0].length;
        const newBaseTag = `<base href="${prefix}/">`;
        html = html.slice(0, endIdx) + newBaseTag + html.slice(endIdx);
        D.log(`[Dashboard Proxy] INJECTED <base> tag into <head>: ${newBaseTag}`);
      } else {
        // 兜底：有 <html> 标签时插入其后；既无 <head> 也无 <html> 时直接置于文档开头
        const baseTag = `<base href="${prefix}/">`;
        const htmlIdx = html.indexOf('<html');
        if (htmlIdx !== -1) {
          html = html.slice(0, htmlIdx) + baseTag + html.slice(htmlIdx);
          D.log(`[Dashboard Proxy] INSERTED <base> after <html> tag`);
        } else {
          html = baseTag + html;
          D.log(`[Dashboard Proxy] APPENDED <base> at document start (fallback)`);
        }
      }

      // [LOG] Injected base tag verification
      const verifiedBaseTag = /<base\shref="([^"]+)"/i.exec(html);
      if (verifiedBaseTag) {
        D.log(`[Dashboard Proxy] VERIFIED BASE TAG: href="${verifiedBaseTag[1]}"`);
      } else {
        D.log(`[Dashboard Proxy] WARNING: Base tag not found in final HTML!`);
      }

      // 静态重写 src 属性中的绝对路径
      const scriptCountBefore = (html.match(/src="\//g) || []).length;
      html = html.replace(/\bsrc="\/(?!\/)/g, `src="${prefix}/`);
      const prefixRegexForMatch = 'src="' + prefix + '/';
      const scriptCountAfter = (html.split(prefixRegexForMatch).length - 1);
      if (scriptCountBefore !== scriptCountAfter) {
        D.log('[Dashboard Proxy] SRC REWRITE: ' + scriptCountBefore + ' -> ' + scriptCountAfter);
      }
            
      // 也处理单引号的情况
      const singleQuoteSrcBefore = (html.match(/src='\//g) || []).length;
      html = html.replace(/\bsrc='\/(?!\/)/g, `src='${prefix}/`);
      const singleQuoteMatchPattern = "src='" + prefix + "/";
      const singleQuoteSrcAfter = (html.split(singleQuoteMatchPattern).length - 1);
      if (singleQuoteSrcBefore !== singleQuoteSrcAfter) {
        D.log('[Dashboard Proxy] SINGLE-QUOTE SRC REWRITE: ' + singleQuoteSrcBefore + ' -> ' + singleQuoteSrcAfter);
      }
      
      // 静态重写 <link href>（CSS 样式表），不改写 <a href>（SPA 路由需要原始路径）
      const linkHrefBefore = (html.match(/href="\//g) || []).length;
      html = html.replace(/<link(\s[^>]*)href="\/(?!\/)/g, function(m, a) { return '<link' + a + 'href="' + prefix + '/'; });
      html = html.replace(/<link(\s[^>]*)href='\/(?!\/)/g, function(m, a) { return "<link" + a + "href='" + prefix + "'/"; });
      const doubleQuoteMatchPattern = 'href="' + prefix + '/';
      const singleQuoteMatchPattern2 = "href='" + prefix + "'/";
      const linkHrefAfter = (html.split(doubleQuoteMatchPattern).length - 1) + (html.split(singleQuoteMatchPattern2).length - 1);
      if (linkHrefBefore !== linkHrefAfter) {
        D.log('[Dashboard Proxy] LINK HREF REWRITE: ' + linkHrefBefore + ' -> ' + linkHrefAfter);
      }
      
      // 额外补漏：把模块 preload links 也加前缀
      html = html.replace(/<link(\s[^>]*)rel="modulepreload"(\s[^>]*)href="\/assets\//g,
        function(match, before, after) { return '<link' + before + 'rel="modulepreload"' + after + 'href="' + prefix + '/assets/'; });
      html = html.replace(/<link(\s[^>]*)rel='modulepreload'(\s[^>]*)href='\/assets\//g,
        function(match, before, after) { return "<link" + before + "rel='modulepreload'" + after + "href='" + prefix + "/assets/"; });

// ── inject window.__HERMES_BASE_PATH__（Chat WS 根因修复）──────────────
      const originalBasePath = html.match(/window\.__HERMES_BASE_PATH__="([^"]*)"/);
      html = html.replace(/window\.__HERMES_BASE_PATH__="[^"]*"/g, `window.__HERMES_BASE_PATH__="${prefix}"`);
      
      if (originalBasePath) {
        D.log(`[Dashboard Proxy] HERMES_BASE_PATH: changed from "${originalBasePath[1]}" to "${prefix}"`);
      } else {
        // 补充：若上游未注入（旧版 Dashboard），兜底添加 ──
        if (!/<script>window\.__HERMES_BASE_PATH__=/.test(html)) {
          html = html.replace("</head>", `<script>window.__HERMES_BASE_PATH__="${prefix}";</script></head>`);
          D.log(`[Dashboard Proxy] HERMES_BASE_PATH: injected new <script> tag`);
        } else {
          D.log(`[Dashboard Proxy] HERMES_BASE_PATH: already exists in another format`);
        }
      }
      
      // [DIAGNOSTIC] Verify base path was set
      const verifiedBasePath = html.match(/window\.__HERMES_BASE_PATH__="([^"]*)"/);
      if (verifiedBasePath) {
        D.log(`[Dashboard Proxy] BASE PATH INJECTION VERIFIED: ${verifiedBasePath[1]}`);
      } else {
        D.log(`[Dashboard Proxy] WARNING: Base path variable not found in final HTML!`);
      }

// 注入 CSS：小屏 UI 修正
      const styleInject = `<style>
@media (max-width: 1023.98px) {
  #app-sidebar {
    background: var(--background-base, #041c1c) !important;
    background: color-mix(in srgb, var(--background-base, #041c1c) 80%, transparent) !important;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }
}
@media (max-width: 768px) {
  :root {
    --theme-base-size: 15px !important;
  }
  html {
    font-size: var(--theme-base-size, 15px) !important;
  }
}
@media (max-width: 639.98px) {
  #app-sidebar button[aria-haspopup="listbox"]:not(:has(svg)) .hidden {
    display: inline !important;
  }
}
@supports not selector(:has(*)) {
  @media (max-width: 639.98px) {
    #app-sidebar button[aria-haspopup="listbox"] .hidden {
      display: inline !important;
    }
  }
}
/* Dashboard 模型管理区按钮对齐：统一 Refresh Models / Cancel / Switch 三个按钮的高度 */
.lucide-refresh-cw,
[class*="lucide-"] svg {
  width: 1rem !important;
  height: 1rem !important;
}
.font-mono.group.relative.grid.cursor-pointer.flex.items-center.gap-2.mx-auto button {
  min-height: 2.5rem !important;
  padding: 0.625em 1em !important;
}
</style>`;

// 注入 JS：智能前缀管理 - 已移除 conflict 的 history 劫持逻辑（避免与 React Router basename 冲突）
      const inject = `<script>
(function(){
  var P="${prefix}";
  console.log('[Dashboard Proxy] Base path:', P);
  function rw(u){
    if(typeof u!=="string")return u;
    if(u.indexOf("//")===0||/^[a-z]+:/i.test(u))return u;
    if(u.charAt(0)==="/" ){if(u.indexOf(P)===0)return u;return P+u;}
    return u;
  }
  function strip(u){
    if(typeof u!=="string")return u;
    if(u.indexOf(P)===0)return u.substring(P.length)||"/";
    return u;
  }
  /* ── fetch / XHR：添加前缀 ── */
  var _f=window.fetch;
  window.fetch=function(i,o){
    if(typeof i==="string")i=rw(i);
    else if(i&&i.url)return _f(new Request(rw(i.url),i),o);
    return _f.call(this,i,o);
  };
  var _xo=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(){
    if(arguments.length>1)arguments[1]=rw(arguments[1]);
    return _xo.apply(this,arguments);
  };
  /* ── MutationObserver：改写 src 和 href ── */
  function rwAttr(el,attr){
    var v=el.getAttribute(attr);
    if(v&&v.charAt(0)==="/"&&v.indexOf(P)!==0){el.setAttribute(attr,P+v);}
  }
  function rwEl(el){
    if(el.hasAttribute("src"))rwAttr(el,"src");
    if(el.tagName==="LINK"&&el.hasAttribute("href"))rwAttr(el,"href");
  }
  new MutationObserver(function(ms){ms.forEach(function(m){if(m.type==="childList")m.addedNodes.forEach(function(n){if(n.nodeType===1){rwEl(n);n.querySelectorAll&&n.querySelectorAll("[src],link[href]").forEach(rwEl);}});if(m.type==="attributes"&&m.target.nodeType===1)rwEl(m.target);});}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["src","href"]});
  document.querySelectorAll("[src],link[href]").forEach(rwEl);
  /* ── hook HTMLScriptElement.src setter：createElement("script") 后 v.src=...
     走的不是 fetch/XHR，需要在这里加前缀 ── */
  var _sp=HTMLScriptElement.prototype,_sd=Object.getOwnPropertyDescriptor(_sp,"src");
  if(_sd&&_sd.set){var _ss=_sd.set,_sg=_sd.get;Object.defineProperty(_sp,"src",{get:function(){return _sg?_sg.call(this):undefined;},set:function(v){if(typeof v==="string"&&v.charAt(0)==="/"&&v.indexOf(P)!==0)v=P+v;_ss.call(this,v);},configurable:true,enumerable:_sd.enumerable});}
  /* ── hook HTMLLinkElement.href setter：createElement("link") 后 x.href=...
     走的不是 fetch/XHR，需要在这里加前缀 ── */
  var _lp=HTMLLinkElement.prototype,_ld=Object.getOwnPropertyDescriptor(_lp,"href");
  if(_ld&&_ld.set){var _ls=_ld.set,_lg=_ld.get;Object.defineProperty(_lp,"href",{get:function(){return _lg?_lg.call(this):undefined;},set:function(v){if(typeof v==="string"&&v.charAt(0)==="/"&&v.indexOf(P)!==0)v=P+v;_ls.call(this,v);},configurable:true,enumerable:_ld.enumerable});}
  /* ── hook setAttribute：拦截所有通过 setAttribute 设置的 src/href ── */
  var _origSetAttr=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(name,value){
    if((name==="src"||name==="href")&&typeof value==="string"&&value.charAt(0)==="/"&&value.indexOf(P)!==0&&value.indexOf("//")!==0){
      value=P+value;
    }
    return _origSetAttr.call(this,name,value);
  };
  /* ── hook WebSocket：给 dashboard WS URL 加前缀，路由到 monitor 反代 ── */
  var _WS=window.WebSocket;
  /* iOS 第三方输入法(如百度)在 xterm 终端无法输入的补偿所需：
     捕获 /api/pty 连接并包裹其 send 以记录 xterm 实际发出的输入 */
  var _activePty=null, _ptySent=[];
  function _hookPty(sock, pathname){
    try{
      if(!sock||!pathname||pathname.indexOf("/api/pty")===-1)return sock;
      _activePty=sock;
      var _os=sock.send;
      sock.send=function(d){
        try{
          var s=(typeof d==="string")?d:(d?new TextDecoder().decode(d):"");
          if(s){_ptySent.push({t:Date.now(),s:s});if(_ptySent.length>80)_ptySent.shift();}
        }catch(e){}
        return _os.apply(this,arguments);
      };
      sock.addEventListener("close",function(){if(_activePty===sock)_activePty=null;});
    }catch(e){}
    return sock;
  }
  window.WebSocket=function(url,protocols){
    try{
      if(typeof url==="string"){
        var u=new URL(url,location.origin);
        if(u.pathname.charAt(0)==="/"&&u.pathname.indexOf(P)!==0){
          var newUrl=(location.protocol==="https:"?"wss:":"ws:")+"//"+location.host+P+u.pathname+(u.search||"")+(u.hash||"");
          return _hookPty(new _WS(newUrl,protocols),u.pathname);
        }
        return _hookPty(new _WS(url,protocols),u.pathname);
      }
    }catch(e){}
    return new _WS(url,protocols);
  };
  window.WebSocket.prototype=_WS.prototype;

  window.WebSocket.CONNECTING=_WS.CONNECTING;
  window.WebSocket.OPEN=_WS.OPEN;
  window.WebSocket.CLOSING=_WS.CLOSING;
  window.WebSocket.CLOSED=_WS.CLOSED;
  /* ── iOS 第三方输入法(百度等)组合输入补偿 ──
     现象：iPhone 上用第三方 IME 在 Dashboard 终端(xterm)对话打不出字，自带键盘正常。
     根因：部分第三方 IME 的组合提交未触发 xterm 期望的事件序列，组合文字从不经
     /api/pty 发出。这里在组合结束/插入后核对：若该文字未被 xterm 经 pty socket 发出，
     则由我们补发到 /api/pty（服务端 pty_ws 同时接受 text/bytes 帧，text 按 UTF-8 编码）。
     去重：仅当"事件发生之后"pty 未发出该文字才补发；xterm 正常处理会在事件后立即发出，
     且我们自己的补发也会被记录，天然避免重复；不同次提交按时间戳区分，允许连续重复字。 */
  function _isTermTarget(t){
    try{return !!(t&&((t.classList&&t.classList.contains("xterm-helper-textarea"))||(t.closest&&t.closest(".xterm"))));}
    catch(e){return false;}
  }
  function _ptyReconcileSend(text,mark){
    if(!text||!_activePty||_activePty.readyState!==1)return;
    setTimeout(function(){
      try{
        if(!_activePty||_activePty.readyState!==1)return;
        var after="";
        for(var i=0;i<_ptySent.length;i++){if(_ptySent[i].t>=mark-5)after+=_ptySent[i].s;}
        if(after.indexOf(text)!==-1)return;   /* xterm 已发出，勿重复 */
        _activePty.send(text);
      }catch(e){}
    },80);
  }
  document.addEventListener("compositionend",function(ev){
    try{if(ev&&ev.data&&_isTermTarget(ev.target))_ptyReconcileSend(String(ev.data),Date.now());}catch(e){}
  },true);
  document.addEventListener("input",function(ev){
    try{
      if(!ev||ev.isComposing||!ev.data||!_isTermTarget(ev.target))return;
      if(ev.inputType&&ev.inputType!=="insertText"&&ev.inputType!=="insertCompositionText")return;
      _ptyReconcileSend(String(ev.data),Date.now());
    }catch(e){}
  },true);
})();
<\/script>`;

      html = html.replace("</head>", styleInject + inject + "\n</head>");

      respHeaders.delete("content-length");
      respHeaders.delete("content-encoding");
      // 强制禁用缓存，确保每次都能获取最新的 HTML
      respHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
      respHeaders.set("Pragma", "no-cache");
      respHeaders.set("Expires", "0");
      return new Response(html, { status: upstream.status, headers: respHeaders });
    }

    // ── 非 HTML 响应：原样透传 ──
    return new Response(upstream.body, {
      status:  upstream.status,
      headers: respHeaders,
    });
  } catch (e) {
    // 连接拒绝/Dashboard 未就绪属正常现象（启动期间），仅非预期错误才记录
    const msg = e?.message || '';
    if (msg && !/connect|refused|abort|ECONN/i.test(msg)) D.log(`proxy error: ${msg}`);
    return new Response(JSON.stringify({ error: "Dashboard unavailable" }), {
      status:  502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ─── WS 反代 ────────────────────────────────────────────────────────
export function matchDashboardWsPath(wsPath) {
  return wsPath.startsWith("/proxy/dashboard/api/ws") ||
         wsPath.startsWith("/proxy/dashboard/api/events") ||
         wsPath.startsWith("/proxy/dashboard/api/pty");
}


export function upgradeDashboardWs(req, server, wsPath, url) {
  if (!D.readPid(D.pidFile)) {
    return new Response(JSON.stringify({ error: "Dashboard is not running" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  // 自动探测 Portal 前缀并从子路径中剥离
  const _dashPrefixBase = (wsPath.split("/proxy/dashboard")[0] || "").replace(/\/+$/, "");
  const subPath = wsPath.replace(new RegExp(`^${(_dashPrefixBase || D.basePath).replace(/\/+$/, "")}/proxy/dashboard`), "") || "/";
  
  // WebSocket 连接需要附加 session token（避免 401 鉴权失败）
  const _sep = url.search ? "&" : "?";
  const targetUrl = `ws://${DASHBOARD_BIND}:${D.port}${subPath}${url.search}${_sep}token=${D.dashboardSessionToken}`;
  
  const upgraded = server.upgrade(req, { data: { type: "dashboard-proxy", targetUrl } });
  if (!upgraded) return new Response("WebSocket upgrade failed", { status: 500 });
  return;
}

// wsHandler.open 的 dashboard-proxy 分支
export function handleDashboardWsOpen(ws) {
  const { targetUrl } = ws.data;
  if (!targetUrl) {
    D.log(`[WS-PROXY] open with empty targetUrl, closing`);
    try { ws.close(1011, "no target url"); } catch {}
    return;
  }
D.log(`[WS-PROXY] open → ${maskUrlToken(targetUrl)}`);
  // 加固接入：上游断线重连、双向心跳、消息缓冲
  wrapDashboardProxy(ws, () => new WebSocketClient(targetUrl, {
    headers: { "Host": `${DASHBOARD_BIND}:${D.port}` },
  }), { log: D.log });
}

// wsHandler.message 的 dashboard-proxy 分支：客户端 → 上游
export function handleDashboardWsMessage(ws, msg) {
  if (ws.data.upstream && ws.data.upstream.readyState === 1) {
    try { ws.data.upstream.send(msg); } catch {}
  }
}

// wsHandler.close 的 dashboard-proxy 分支
export function handleDashboardWsClose(ws) {
  if (ws.data.upstream) {
    try { ws.data.upstream.close(); } catch {}
  }
  D.log(`[WS-PROXY] client closed`);
}

// ─── WS 反代加固 ──────────────────────────────────────────────────────
// 由上方 handleDashboardWsOpen 在 open() 一处接入

// 指数退避延迟：baseMs 起步，每次 ×2，封顶 maxMs
function backoffDelay(attempt, baseMs = 500, maxMs = 8000) {
  return Math.min(baseMs * Math.pow(2, Math.max(0, attempt)), maxMs);
}


function classifyClose(code) {
  if (code === 1000 || code === 1001) return "passthrough";
  if (code === 4409) return "silent-reconnect";
  return "backoff-reconnect";
}


const CTRL_WS_DIAG_WINDOW_MS = 10000;   // 重连次数统计的滚动窗口
const CTRL_WS_SHORT_LIFE_MS = 2000;     // 判定「秒关」的存活时长阈值
const ctrlWsRecentCloses = [];          // 近期秒关时刻（毫秒时间戳），仅诊断用

// 
function maskToken(token) {
  if (!token) return "none";
  const s = String(token);
  if (s.length <= 8) return s.slice(0, 2) + "…";
  return s.slice(0, 4) + "…" + s.slice(-4);
}

// 掩码 URL 查询串中的 token=... 明文（日志打印 targetUrl 前调用，避免会话 token 落进 monitor.log）
function maskUrlToken(url) {
  return String(url || "").replace(/([?&]token=)[^&]*/g, "$1***");
}

function wrapDashboardProxy(ws, upstreamFactory, opts = {}) {
  const {
    log = () => {},
    pingIntervalMs = 30000,   // 双向心跳间隔
    pongTimeoutMs = 10000,    // ping 后等待 pong 的超时
    reconnectBaseMs = 500,    // 退避起步延迟
    reconnectMaxMs = 8000,    // 退避封顶延迟
    maxAttempts = 10,         // 连续重连上限
    silentRetryMs = 200,      // 4409 静默重连的固定短延迟
    maxQueue = 256,           // 断线缓冲队列上限（超出丢弃最新消息）
    stableResetMs = 5000,     // 连接保持该时长后重连计数归零
  } = opts;

  const state = {
    closed: false,   // 整条反代链路已终止
    attempts: 0,     // 连续重连次数（连接稳定后归零）
    queue: [],       // 重连窗口内浏览器侧待发消息（FIFO）
  };
  let clientPingTimer = null, clientPongTimer = null, reconnectTimer = null;
  let clearUpstreamTimers = () => {};

  // openTs 记录首次建立时刻
  const openTs = Date.now();
  let ctrlWsDiag = null;
  try {
    const tu = new URL(ws.data && ws.data.targetUrl);
    if (tu.pathname.startsWith("/api/ws")) {
      ctrlWsDiag = {
        path: tu.pathname,
        token: tu.searchParams.get("token"),
        channel: tu.searchParams.get("channel"),
      };
    }
  } catch {}

// 终止整条链路
  function shutdown() {
    if (state.closed) return;
    state.closed = true;
    state.queue.length = 0;
    clearInterval(clientPingTimer);
    clearTimeout(clientPongTimer);
    clearTimeout(reconnectTimer);
    clearUpstreamTimers();
    const up = ws.data && ws.data.upstream;
    if (up && !up.isReconnectBuffer) { try { up.close(); } catch {} }
  }

// 重连窗口内的缓冲桩
  function bufferStub() {
    return {
      readyState: 1,
      isReconnectBuffer: true,
      send: (msg) => { if (state.queue.length < maxQueue) state.queue.push(msg); },
      close: () => shutdown(),
    };
  }

  function flushQueue(upstream) {
    while (state.queue.length > 0) {
      const msg = state.queue.shift();
      try { upstream.send(msg); } catch { break; }
    }
  }

  function scheduleReconnect(kind, code, reason) {
    if (state.closed) return;
    if (state.attempts >= maxAttempts) {

      log(`[WS-PROXY] reconnect gave up after ${state.attempts} attempts (last code=${code})`);
      try { ws.close(1011, String(reason || "upstream unavailable")); } catch {}
      shutdown();
      return;
    }
    const delay = kind === "silent-reconnect"
      ? silentRetryMs
      : backoffDelay(state.attempts, reconnectBaseMs, reconnectMaxMs);
    state.attempts += 1;
    ws.data.upstream = bufferStub();
    log(`[WS-PROXY] upstream lost (code=${code}), reconnect #${state.attempts} in ${delay}ms`);
    reconnectTimer = setTimeout(dial, delay);
  }

  function dial() {
    if (state.closed) return;
    let upstream;
    try {
      upstream = upstreamFactory();
    } catch (e) {
      log(`[WS-PROXY] upstream dial failed: ${e?.message || e}`);
      scheduleReconnect("backoff-reconnect", 1006, "dial failed");
      return;
    }
    attach(upstream);
  }

  function attach(upstream) {
    let upPingTimer = null, upPongTimer = null, stableTimer = null;
    let settled = false; // 同一连接的 close 只处理一次
    const clearUp = () => {
      clearInterval(upPingTimer);
      clearTimeout(upPongTimer);
      clearTimeout(stableTimer);
    };
    clearUpstreamTimers = clearUp;

    upstream.addEventListener("open", () => {
      if (state.closed) { try { upstream.close(); } catch {} return; }
      log(`[WS-PROXY] upstream connected${state.attempts ? ` (reconnect #${state.attempts})` : ""}`);
      // 连上后才把真实上游暴露给转发分支，并把缓冲队列按原顺序补发
      ws.data.upstream = upstream;
      flushQueue(upstream);
// 连接稳定后重连计数归零
      stableTimer = setTimeout(() => { state.attempts = 0; }, stableResetMs);

      if (typeof upstream.ping === "function") {
        upPingTimer = setInterval(() => {
          try { upstream.ping(); } catch { return; }
          if (!upPongTimer) {
            upPongTimer = setTimeout(() => {
              log("[WS-PROXY] upstream pong timeout, terminating");
              try { (upstream.terminate || upstream.close).call(upstream); } catch {}
            }, pongTimeoutMs);
          }
        }, pingIntervalMs);
        if (typeof upstream.on === "function") {
          upstream.on("pong", () => { clearTimeout(upPongTimer); upPongTimer = null; });
        }
      }
    });

    upstream.addEventListener("message", (event) => {
      try {
// Frame Type Preservation
        const path = ws.data.targetUrl?.replace(/\?.*$/, "") || "unknown";
        const isJsonPath = path.endsWith("/api/ws") || path.endsWith("/api/events");
        
        if (isJsonPath) {
// Force text frame for JSON-RPC messages
          const payload = Buffer.isBuffer(event.data) ? event.data.toString("utf8") : String(event.data);
          ws.send(payload, { binary: false });
        } else {
// Preserve binary frame
          ws.send(event.data, { binary: true });
        }
      } catch {}
    });

    upstream.addEventListener("close", (event) => {
      // 连接断开时
      if (settled) return;
      settled = true;
      clearUp();
      if (state.closed) return;
      const code = event && event.code;
      const reason = event && event.reason;
      const decision = classifyClose(code);
      log(`[WS-PROXY] upstream closed code=${code} → ${decision}`);
      // ── /api/ws 控制通道秒关诊断 ──
      if (ctrlWsDiag && code === 1000) {
        const aliveMs = Date.now() - openTs;
        if (aliveMs < CTRL_WS_SHORT_LIFE_MS) {
          const now = Date.now();
          ctrlWsRecentCloses.push(now);

          while (ctrlWsRecentCloses.length && now - ctrlWsRecentCloses[0] > CTRL_WS_DIAG_WINDOW_MS) {
            ctrlWsRecentCloses.shift();
          }
          const chan = ctrlWsDiag.channel ? ` channel=${ctrlWsDiag.channel}` : "";
          log(`[WS-PROXY][diag] /api/ws 秒关 token=${maskToken(ctrlWsDiag.token)} path=${ctrlWsDiag.path}${chan} openAt=${new Date(openTs).toISOString()} code=${code} reason=${reason || ""} alive=${aliveMs}ms 近10s重连${ctrlWsRecentCloses.length}次`);
        }
      }
      if (decision === "passthrough") {
        try { ws.close(code, reason); } catch {}
        shutdown();
      } else {
        scheduleReconnect(decision, code, reason);
      }
    });

    upstream.addEventListener("error", () => {
      // 拨号失败或传输异常
    });
  }

// 浏览器侧心跳
  if (typeof ws.ping === "function") {
    clientPingTimer = setInterval(() => {
      try { ws.ping(); } catch { return; }
      if (!clientPongTimer) {
        clientPongTimer = setTimeout(() => {
          log("[WS-PROXY] client pong timeout, closing");
          try { ws.close(1011, "client pong timeout"); } catch {}
          shutdown();
        }, pongTimeoutMs);
      }
    }, pingIntervalMs);
    if (typeof ws.on === "function") {
      ws.on("pong", () => { clearTimeout(clientPongTimer); clientPongTimer = null; });
    }
  }

  if (typeof ws.on === "function") ws.on("close", () => shutdown());

// 首连前先挂缓冲桩
  ws.data.upstream = bufferStub();
  dial();

  return { state, shutdown };
}
