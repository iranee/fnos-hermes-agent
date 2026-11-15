import * as http from "node:http";
import { readFile } from "node:fs/promises";
import { Readable, pipeline } from "node:stream";
import { WebSocket } from "./vendor/ws/wrapper.mjs";

const CONNECT_TIMEOUT = 5_000;
// 单帧上限与下行 WebSocketServer 默认值一致：pet.info 的精灵图、长会话恢复都是数 MB 的单帧，
// 原先 1 MB 会让上游连接直接断开，客户端重连后再拉一次又断，表现为 Gateway 持续掉线。
const MAX_MESSAGE_BYTES = 100 * 1024 * 1024;
// 积压上限只计算新消息到达前已排队/未发出的字节，单条大帧本身不触发。
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_MESSAGES = 64;
// 面板注入的界面补丁文件：由面板同源提供，上游 CSP 的 script-src/style-src 'self' 允许加载，
// 页面 HTML 超过此大小时放弃注入，原样转发。
const PATCH_ROUTE = "/__fnos/";
const PATCH_FILES = {
  "patch.js": "text/javascript; charset=utf-8",
  "patch.css": "text/css; charset=utf-8",
};
const MAX_PATCHED_HTML_BYTES = 2 * 1024 * 1024;
const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);
const failure = (status) => new Response(http.STATUS_CODES[status], { status });

function hopHeaders(headers) {
  return new Set([...HOP_HEADERS, ...(headers.get("connection") || "")
    .split(",").map((name) => name.trim().toLowerCase()).filter(Boolean)]);
}

function upstreamHeaders(rawHeaders, embeddable = false) {
  const headers = new Headers();
  for (let i = 0; i < rawHeaders.length; i += 2) headers.append(rawHeaders[i], rawHeaders[i + 1]);
  for (const name of hopHeaders(headers)) headers.delete(name);
  if (embeddable) allowSameOriginFraming(headers);
  return headers;
}

// 上游在 WebApp 及其启动交接页上发送 frame-ancestors 'none'，面板用同源 iframe 嵌入这两者，
// 所以只把这一条指令放宽为 'self'。
function allowSameOriginFraming(headers) {
  const policy = headers.get("content-security-policy");
  if (policy) headers.set("content-security-policy", policy.replace(/frame-ancestors\s+'none'/gi, "frame-ancestors 'self'"));
  headers.delete("x-frame-options");
}

function asResponse(incoming, method, embeddable = false) {
  const noBody = method === "HEAD" || [204, 205, 304].includes(incoming.statusCode);
  if (noBody) incoming.resume();
  return new Response(noBody ? null : Readable.toWeb(incoming, {
    strategy: { highWaterMark: 64 * 1024, size: (chunk) => chunk.length },
  }), {
    status: incoming.statusCode,
    statusText: incoming.statusMessage,
    headers: upstreamHeaders(incoming.rawHeaders, embeddable),
  });
}

// 只对 WebApp 自身的页面注入：上游给它的 CSP 含 script-src 'self'，交接页（nonce 策略）
// 和非 HTML 响应不动。压缩过的响应体也不动，上游目前不压缩 HTML。
function patchableHtml(incoming, method) {
  if (method !== "GET" || incoming.statusCode !== 200) return false;
  const type = String(incoming.headers["content-type"] || "").toLowerCase();
  if (!type.startsWith("text/html")) return false;
  const encoding = String(incoming.headers["content-encoding"] || "identity").toLowerCase();
  if (encoding !== "identity") return false;
  if (Number(incoming.headers["content-length"] || 0) > MAX_PATCHED_HTML_BYTES) return false;
  const policy = String(incoming.headers["content-security-policy"] || "");
  return /script-src[^;]*'self'/i.test(policy);
}

// 补丁脚本插在页面首个 module 脚本之前：defer 脚本与 module 脚本按文档顺序在解析完成后执行，
// 这样补丁能在上游读取 localStorage 布局状态之前先行写入。
function injectPatchTags(html, prefix) {
  const css = `<link rel="stylesheet" href="${prefix}${PATCH_ROUTE}patch.css">`;
  const js = `<script src="${prefix}${PATCH_ROUTE}patch.js" defer></script>`;
  let out = html;
  const head = out.search(/<\/head\s*>/i);
  out = head >= 0 ? out.slice(0, head) + css + out.slice(head) : css + out;
  const module = out.search(/<script\b[^>]*\btype\s*=\s*["']?module\b/i);
  if (module >= 0) return out.slice(0, module) + js + out.slice(module);
  const body = out.search(/<\/body\s*>/i);
  return body >= 0 ? out.slice(0, body) + js + out.slice(body) : out + js;
}

async function patchedResponse(incoming, prefix, embeddable) {
  const chunks = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > MAX_PATCHED_HTML_BYTES) throw new Error("WebApp page too large to patch");
    chunks.push(chunk);
  }
  const html = injectPatchTags(Buffer.concat(chunks).toString("utf8"), prefix);
  const headers = upstreamHeaders(incoming.rawHeaders, embeddable);
  headers.delete("content-length");
  return new Response(html, { status: 200, statusText: incoming.statusMessage, headers });
}

async function servePatchFile(dir, name) {
  const type = PATCH_FILES[name];
  if (!type) return failure(404);
  try {
    const body = await readFile(`${dir}/${name}`);
    return new Response(body, {
      status: 200,
      headers: { "content-type": type, "cache-control": "no-cache", "x-content-type-options": "nosniff" },
    });
  } catch {
    return failure(404);
  }
}

function closePeer(ws, code, reason) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.CONNECTING) { ws.terminate(); return; }
  if (ws.readyState !== WebSocket.OPEN) return;
  const valid = (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
    (code >= 3000 && code <= 4999);
  if (valid || code === 1005) ws.resume?.(); // 即使处于背压状态也要读到对端的关闭回复。
  if (valid) ws.close(code, reason);
  else if (code === 1005) ws.close();
  else ws.terminate(); // 保留码 1006/1015 绝不发到线路上。
}

/**
 * 只做官方 WebApp 的传输层。调用方在每一次 HTTP/WS 握手上都提供可信的 NAS 鉴权。
 * 上游是绑定回环地址、没有公网 URL 的 Hermes 界面，因此 Host/Origin 改写为回环地址，
 * 只额外加 X-Forwarded-Prefix。升级成功返回 undefined。拒绝时返回 Response，与 handleHttp 一致。
 * 不注入凭证、不发业务 RPC、不跟随上游重定向。
 * 传入 patchDir 时，WebApp 页面 HTML 会追加同源的 __fnos/patch.css 与 __fnos/patch.js 外链，
 * 这两个文件直接从 patchDir 提供，不经上游。用于在不改动上游前端的前提下修补界面问题。
 */
export function createWebappProxy({ port, basePath, authorize, surface = "webapp", patchDir = null }) {
  if (!["webapp", "dashboard"].includes(surface)) throw new TypeError("Invalid official web surface");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("Invalid WebApp port");
  if (typeof basePath !== "string" || (basePath && !basePath.startsWith("/")) ||
      /[?#\\%\s]/.test(basePath) || basePath.includes("//") ||
      basePath.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError("Invalid WebApp basePath");
  }
  if (typeof authorize !== "function") {
    throw new TypeError("WebApp authorization callback is required");
  }
  if (patchDir !== null && (typeof patchDir !== "string" || !patchDir)) {
    throw new TypeError("Invalid WebApp patchDir");
  }
  const authority = `127.0.0.1:${port}`;
  const prefix = `${basePath.replace(/\/$/, "")}/${surface}`;
  const embeddable = surface === "webapp";
  const patching = embeddable && patchDir !== null;
  const matches = (pathname) => typeof pathname === "string" &&
    (pathname === prefix || pathname.startsWith(`${prefix}/`));
  const agent = new http.Agent({ keepAlive: true });
  const requests = new Set();
  const sessions = new Set();
  // 正在关闭的连接也要跟踪：close() 不能留下存活的 WS 关闭握手定时器。
  const peers = new Set();
  let closed = false;

  async function prepare(req, websocket = false) {
    const url = new URL(req.url);
    if (!matches(url.pathname)) return failure(404);
    // 默认拒绝（fail-closed）：回调抛异常，或返回的不是布尔值 true（包括其他真值），都按拒绝处理。
    try { if (await authorize(req) !== true) return failure(401); }
    catch { return failure(401); }
    if (closed || req.signal.aborted) return failure(503);
    const headers = {};
    const hop = hopHeaders(req.headers);
    for (const [name, value] of req.headers) {
      if (hop.has(name) || name === "host" || name === "origin" || name === "forwarded" ||
          name.startsWith("x-forwarded-") || name === "x-monitor-token" ||
          name.startsWith("x-trim-") || (websocket && name.startsWith("sec-websocket-"))) continue;
      headers[name] = value;
    }
    headers.host = authority;
    // Hermes 要求票据交换和 WS 的 Origin 等于它自己的回环地址。
    if (req.headers.has("origin")) headers.origin = `http://${authority}`;
    headers["x-forwarded-prefix"] = prefix;
    // Cookie、Authorization 和 Hermes 自身的认证头保持不动。
    return { headers, path: (url.pathname.slice(prefix.length) || "/") + url.search };
  }

  async function handleHttp(req) {
    const prepared = await prepare(req);
    if (prepared instanceof Response) return prepared;
    if (patching && prepared.path.startsWith(PATCH_ROUTE)) {
      if (req.method !== "GET" && req.method !== "HEAD") return failure(405);
      const name = prepared.path.slice(PATCH_ROUTE.length).split("?")[0];
      return servePatchFile(patchDir, name);
    }
    return new Promise((resolve) => {
      let incoming;
      let upload;
      let timer;
      // 注入时整段读完响应体再 resolve。此时上游请求的 close 先于读取完成触发，不能当作失败。
      let buffering = false;
      const upstream = http.request({
        hostname: "127.0.0.1", port, path: prepared.path,
        method: req.method, headers: prepared.headers, agent,
      });
      requests.add(upstream);
      const abort = () => {
        incoming?.destroy();
        upstream.destroy();
        upload?.destroy();
        resolve(failure(502));
      };
      const cleanup = () => {
        clearTimeout(timer);
        requests.delete(upstream);
        req.signal.removeEventListener("abort", abort);
      };
      req.signal.addEventListener("abort", abort, { once: true });
      upstream.once("socket", (socket) => {
        if (!socket.connecting) return;
        // 只对 TCP 建连计时，不限制响应/SSE/文件传输时长。
        timer = setTimeout(() => upstream.destroy(new Error("WebApp connection timeout")), CONNECT_TIMEOUT);
        timer.unref();
        socket.once("connect", () => clearTimeout(timer));
      });
      upstream.once("response", (res) => {
        incoming = res;
        clearTimeout(timer);
        if (patching && patchableHtml(res, req.method)) {
          buffering = true;
          patchedResponse(res, prefix, embeddable).then(resolve, () => { res.destroy(); resolve(failure(502)); });
          return;
        }
        try { resolve(asResponse(res, req.method, embeddable)); }
        catch { res.destroy(); resolve(failure(502)); }
      });
      upstream.once("error", () => {
        upload?.destroy();
        incoming?.destroy(new Error("WebApp upstream stream failed"));
        resolve(failure(502));
      });
      upstream.once("close", () => {
        cleanup();
        // 无错误的 destroy()（proxy.close 或客户端中止）也必须结束尚未收到响应头的调用。
        if (!buffering) resolve(failure(502));
        if (upload && !upload.readableEnded) upload.destroy();
      });
      if (req.signal.aborted || closed) { abort(); return; }
      if (req.body) {
        upload = Readable.fromWeb(req.body);
        pipeline(upload, upstream, () => {});
      } else upstream.end();
    });
  }

  // 每个方向的计数都有上限（含正在发送的数据）。用 pause/resume 和 ws.send 回调施加传输背压，
  // 而不是无限堆积消息数组。
  function channel(state, source, target) {
    const queue = [];
    let bytes = 0;
    let count = 0;
    let sending = false;
    function clear() { queue.length = 0; bytes = 0; count = 0; }
    function pump() {
      if (state.dead || sending) return;
      const peer = target();
      if (!peer || peer.readyState !== WebSocket.OPEN) return;
      const item = queue.shift();
      if (!item) { source()?.resume(); return; }
      sending = true;
      try {
        peer.send(item.data, { binary: item.binary }, (err) => {
          sending = false;
          if (state.dead) return;
          bytes -= item.size;
          count--;
          if (err) state.fail();
          else pump();
        });
      } catch { sending = false; state.fail(); }
    }
    return {
      clear, pump,
      push(data, binary) {
        if (state.dead) return;
        const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
        if (++count > MAX_PENDING_MESSAGES || bytes + (target()?.bufferedAmount || 0) > MAX_PENDING_BYTES) {
          state.fail(1013, "WebApp backpressure limit");
          return;
        }
        bytes += size;
        queue.push({ data, binary, size });
        source()?.pause();
        pump();
      },
    };
  }

  async function upgrade(req, server) {
    const prepared = await prepare(req, true);
    if (prepared instanceof Response) return prepared;
    const protocols = (req.headers.get("sec-websocket-protocol") || "")
      .split(",").map((value) => value.trim()).filter(Boolean);
    return new Promise((resolve) => {
      let settled = false;
      const settle = (response) => { if (!settled) { settled = true; resolve(response); } };
      const state = { kind: "webapp", upstream: null, downstream: null, dead: false };
      let acceptTimer;
      let rejection;
      const detachAbort = () => req.signal.removeEventListener("abort", abort);
      const cleanup = () => {
        clearTimeout(acceptTimer);
        detachAbort();
        state.toClient.clear();
        state.toUpstream.clear();
        sessions.delete(state);
      };
      state.fail = (code, reason) => {
        if (state.dead) return;
        state.dead = true;
        cleanup();
        rejection?.destroy();
        closePeer(state.upstream, code, reason);
        closePeer(state.downstream, code, reason);
        settle(failure(502));
      };
      const abort = () => state.fail();
      state.toClient = channel(state, () => state.upstream, () => state.downstream);
      state.toUpstream = channel(state, () => state.downstream, () => state.upstream);
      state.open = (ws) => {
        state.downstream = ws;
        peers.add(ws);
        clearTimeout(acceptTimer);
        detachAbort(); // 接受之后 WS 生命周期由关闭帧管理，不再由请求中止管理。
        if (state.dead || state.upstream.readyState !== WebSocket.OPEN) {
          closePeer(ws, state.closeCode, state.closeReason);
          return;
        }
        state.toClient.pump();
      };
      state.onClose = (code, reason) => {
        peers.delete(state.downstream);
        state.closeCode = code;
        state.closeReason = reason;
        closePeer(state.upstream, code, reason);
        if (state.upstream.readyState === WebSocket.CLOSED) cleanup();
      };
      sessions.add(state);
      req.signal.addEventListener("abort", abort, { once: true });
      try {
        // 在固定的 authority 之后拼接。即使路径以 // 开头也改不了主机。
        state.upstream = new WebSocket(`ws://127.0.0.1:${port}${prepared.path}`, protocols, {
          headers: prepared.headers, followRedirects: false, perMessageDeflate: false,
          handshakeTimeout: CONNECT_TIMEOUT, maxPayload: MAX_MESSAGE_BYTES,
        });
      } catch { state.fail(); return; }
      const upstream = state.upstream;
      peers.add(upstream);
      let handshakeHeaders;
      upstream.on("upgrade", (res) => { handshakeHeaders = upstreamHeaders(res.rawHeaders); });
      upstream.on("unexpected-response", (client, res) => {
        rejection = res;
        client.setTimeout(0); // 拒绝响应的响应体本身也可能是流式的。
        res.once("close", () => state.fail());
        try { settle(asResponse(res, req.method, embeddable)); }
        catch { state.fail(); }
      });
      upstream.on("error", () => state.fail()); // 绝不记录 URL、请求头、令牌或库错误。
      upstream.on("message", (data, binary) => state.toClient.push(data, binary));
      upstream.on("close", (code, reason) => {
        peers.delete(upstream);
        state.closeCode = code;
        state.closeReason = reason;
        closePeer(state.downstream, code, reason);
        if (!state.downstream || state.downstream.readyState === WebSocket.CLOSED) cleanup();
        settle(failure(502));
      });
      upstream.on("open", () => {
        if (closed || req.signal.aborted || state.dead) { state.fail(); return; }
        try {
          if (!server.upgrade(req, { data: state, protocol: upstream.protocol, headers: handshakeHeaders })) {
            state.fail();
            return;
          }
          // 调用方注册了升级却始终不触发 websocket.open 时，限制这段空窗时间。
          acceptTimer = setTimeout(() => state.fail(), CONNECT_TIMEOUT);
          acceptTimer.unref();
          settle(undefined);
        } catch { state.fail(); }
      });
      if (closed || req.signal.aborted) state.fail();
    });
  }

  const websocket = {
    open(ws) { if (ws.data?.kind === "webapp") ws.data.open(ws); },
    message(ws, message) {
      if (ws.data?.kind === "webapp") ws.data.toUpstream.push(message, typeof message !== "string");
    },
    close(ws, code, reason) { if (ws.data?.kind === "webapp") ws.data.onClose(code, reason); },
    error(ws) { if (ws.data?.kind === "webapp") ws.data.fail(); },
  };

  function close() {
    closed = true;
    for (const request of requests) request.destroy();
    for (const state of sessions) state.fail();
    for (const peer of peers) peer.terminate();
    peers.clear();
    agent.destroy();
  }
  return { matches, handleHttp, upgrade, websocket, close };
}
