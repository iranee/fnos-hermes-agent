/**
 * Node.js 运行时适配层 — fnOS Hermes Agent
 *
 * 提供 Web API 风格的 serve / file / spawn / spawnSync / WebSocketClient。
 */

import { Readable, pipeline } from "stream";
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import { WebSocket as WsClient, WebSocketServer } from "./vendor/ws/wrapper.mjs";

// ──────────────────────────────────────────────────────────────────────────
// spawn / spawnSync
// ──────────────────────────────────────────────────────────────────────────

function optsOrEnv(env) {
  if (env === undefined) return process.env;
  if (env === "inherit") return process.env;
  return { ...process.env, ...env };
}

/**
 * 兼容 Bun.spawn 调用约定的进程启动器。
 * 支持数组式 spawn(["cmd","arg"]) 和对象式 spawn({cmd:[],env,...})。
 */
function spawn(optsOrCmd) {
  let cmd, env, stdout, stderr, stdin;

  if (Array.isArray(optsOrCmd)) {
    const [executable, ...args] = optsOrCmd;
    const proc = nodeSpawn(executable, args);
    return {
      pid: proc.pid,
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      // error 事件（如可执行文件不存在）也要收尾 exited，否则未监听的 error 会直接崩进程
      exited: new Promise((resolve) => { proc.on("exit", (code) => resolve(code)); proc.on("error", () => resolve(-1)); }),
      kill: (sig) => proc.kill(sig),
      unref: () => proc.unref(),
    };
  }

  cmd = optsOrCmd.cmd;
  env = optsOrEnv(optsOrCmd.env);
  stdout = optsOrCmd.stdout;
  stderr = optsOrCmd.stderr;
  stdin = optsOrCmd.stdin || "pipe";

  const options = { encoding: null, env };

  // file() 返回 ReadStream（带 isFileRef+path），用作 stdout/stderr 时转为可写 fd
  if (stdout === "pipe") stdout = "pipe";
  else if (stdout && stdout.isFileRef && stdout.path) stdout = fs.openSync(stdout.path, "a");
  else if (typeof stdout === "string" && fs.existsSync(stdout)) stdout = fs.openSync(stdout, "a");

  if (stderr === "pipe") stderr = "pipe";
  else if (stderr && stderr.isFileRef && stderr.path) stderr = fs.openSync(stderr.path, "a");
  else if (typeof stderr === "string" && fs.existsSync(stderr)) stderr = fs.openSync(stderr, "a");

  const proc = nodeSpawn(cmd[0], cmd.slice(1), { ...options, stdio: [stdin, stdout, stderr] });

  return {
    pid: proc.pid,
    stdin: proc.stdin,
    stdout: proc.stdout ? Readable.toWeb(proc.stdout) : null,
    stderr: proc.stderr ? Readable.toWeb(proc.stderr) : null,
    // error 事件（如可执行文件不存在）也要收尾 exited，否则未监听的 error 会直接崩进程
    exited: new Promise((resolve) => { proc.on("exit", (code) => resolve(code)); proc.on("error", () => resolve(-1)); }),
    kill: (sig) => proc.kill(sig),
    unref: () => proc.unref(),
  };
}

/**
 * 兼容 Bun.spawnSync 调用约定的同步进程启动器。
 */
function spawnSync(cmd, opts = {}) {
  const out = opts.stdout === "pipe" ? "buffer" : opts.stdout;
  const err = opts.stderr === "pipe" ? "buffer" : opts.stderr;
  const res = nodeSpawnSync(cmd[0], cmd.slice(1), {
    encoding: "buffer",
    stdio: ["ignore", out, err],
    ...(opts.env ? { env: opts.env } : {}),
  });
  return {
    stdout: res.stdout,
    stderr: res.stderr,
    status: res.status,
    signal: res.signal,
    pid: res.pid,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// file — 返回带 isFileRef+path 标记的 ReadStream
// ──────────────────────────────────────────────────────────────────────────

function file(path) {
  const rs = fs.createReadStream(path);
  return Object.assign(rs, { isFileRef: true, path });
}

// ──────────────────────────────────────────────────────────────────────────
// serve — http.createServer + Unix socket + WebSocket upgrade + Web API 桥接
// ──────────────────────────────────────────────────────────────────────────

// 直接遍历 Headers 会把 Set-Cookie 折叠成一条。绝不能按逗号拆分 cookie（Expires 含逗号）。
function responseHeaders(headers) {
  const pairs = [];
  for (const [name, value] of headers) {
    if (name !== "set-cookie") pairs.push(name, value);
  }
  for (const value of headers.getSetCookie()) pairs.push("set-cookie", value);
  return pairs;
}

function sendResponse(req, res, response, report) {
  if (res.destroyed) {
    response?.body?.cancel().catch(() => {});
    return;
  }
  if (!response) { res.end(); return; }
  res.writeHead(response.status, response.statusText || http.STATUS_CODES[response.status],
    responseHeaders(response.headers));
  if (!response.body || req.method === "HEAD") {
    response.body?.cancel().catch(() => {});
    res.end();
    return;
  }
  // 立即刷出 SSE 响应头，pipeline 会同时传播源错误和断连。
  res.flushHeaders();
  pipeline(Readable.fromWeb(response.body), res, (err) => {
    if (err && err.code !== "ERR_STREAM_PREMATURE_CLOSE") report(err);
  });
}

/**
 * 默认监听 Unix socket。隔离的 TCP 测试必须显式传 hostname: "127.0.0.1"。
 * 返回 { fetch, upgrade, ready, address(), stop() }，stop 幂等并关闭所有连接。
 */
function serve(config) {
  const tcp = config.port !== undefined || config.hostname !== undefined;
  if (tcp && (config.unix || config.hostname !== "127.0.0.1" ||
      !Number.isInteger(config.port) || config.port < 0 || config.port > 65535)) {
    throw new TypeError("TCP serve requires hostname=127.0.0.1 and a valid port, without unix");
  }
  if (!tcp && !config.unix) throw new TypeError("serve requires a unix socket");
  const httpServer = http.createServer({
    keepAlive: true, keepAliveTimeout: (config.idleTimeout ?? 60) * 1000,
    requestTimeout: 0, // 不限制整个上传/长流的时长。请求头仍沿用 Node 默认超时。
  });
  const handshake = Symbol("upgrade options");
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols(protocols, req) {
      const options = req[handshake];
      return options?.data?.kind === "webapp"
        ? options.protocol || false : protocols.values().next().value;
    },
  });
  wss.on("headers", (headers, req) => {
    const options = req[handshake];
    if (options?.data?.kind !== "webapp" || !options.headers) return;
    const pairs = responseHeaders(new Headers(options.headers));
    for (let i = 0; i < pairs.length; i += 2) {
      // WS 实现自己负责握手和帧相关的响应头。
      if (!/^(connection|upgrade|sec-websocket-.*|content-length|transfer-encoding)$/i.test(pairs[i])) {
        headers.push(`${pairs[i]}: ${pairs[i + 1]}`);
      }
    }
  });
  const pendingData = new WeakMap();
  const upgrading = new WeakSet();
  const sockets = new Set();
  let stopping = false;
  let stopPromise;
  const report = (err) => {
    try { config.error?.(err); } catch {}
  };
  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  function makeRequest(req, peer, hasBody) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() !== "cookie") headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    }
    // 多个 Cookie 头由 Node 用分号拼接，而不是 Headers 的逗号。
    if (req.headers.cookie !== undefined) headers.set("cookie", req.headers.cookie);
    req.once("aborted", abort);
    peer.once("close", abort);
    if (req.aborted || peer.destroyed) abort();
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method, headers, signal: controller.signal,
      body: hasBody ? Readable.toWeb(req, {
        strategy: { highWaterMark: 64 * 1024, size: (chunk) => chunk.length },
      }) : undefined,
      duplex: hasBody ? "half" : undefined,
    });
    const cleanup = () => {
      req.off("aborted", abort);
      peer.off("close", abort);
    };
    peer.once("close", cleanup);
    if (peer instanceof http.ServerResponse) peer.once("finish", cleanup);
    return request;
  }

  wss.on("connection", (ws, req) => {
    const handler = config.websocket || {};
    ws.on("message", (data, isBinary) => {
      if (handler.message) handler.message(ws, isBinary ? data : data.toString());
    });
    ws.on("close", (code, reason) => {
      if (handler.close) handler.close(ws, code, reason);
    });
    ws.on("error", (err) => {
      if (handler.error) handler.error(ws, err);
      else report(err);
    });
    // 在 open 之前注册监听器：open 时可能立即转发已排队的上游帧。
    if (handler.open) handler.open(ws);
  });

  httpServer.on("upgrade", async (req, socket, head) => {
    // 升级阶段的 socket 还没有 ServerResponse 来吸收传输错误。
    const onError = () => socket.destroy();
    // handleUpgrade 之前，Node 收到 FIN 后会让升级 TCP socket 保持半开。
    // 主动销毁它，这样即使 fetch 还在等上游握手，Request.signal 也能中止。
    const onEnd = () => socket.destroy();
    socket.on("error", onError);
    socket.once("end", onEnd);
    let request;
    let response;
    try {
      request = makeRequest(req, socket, false);
      upgrading.add(request);
      response = await config.fetch(request, serveInstance);
      const options = pendingData.get(request);
      const pathname = new URL(request.url).pathname.replace(/^\/app\/[^/]+/, "") || "/";
      const legacy = pathname === "/api/chat/ws" ||
        ["/proxy/dashboard/api/ws", "/proxy/dashboard/api/events", "/proxy/dashboard/api/pty"]
          .some((prefix) => pathname.startsWith(prefix));
      if (socket.destroyed || stopping) {
        response?.body?.cancel().catch(() => {});
        return;
      }
      // fetch 显式拒绝始终优先于待处理的升级数据。
      if (!response && options?.data && (legacy || options.data.kind === "webapp")) {
        req[handshake] = options;
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.data = options.data;
          socket.off("error", onError);
          socket.off("end", onEnd);
          wss.emit("connection", ws, req);
        });
        return;
      }
      response ||= new Response("Upgrade rejected", { status: 400 });
    } catch (err) {
      report(err);
      response = new Response("Internal Server Error", { status: 500 });
    } finally {
      if (request) { pendingData.delete(request); upgrading.delete(request); }
    }
    if (socket.destroyed) { response?.body?.cancel().catch(() => {}); return; }
    // 用 ServerResponse 回复，不自行拼 HTTP 状态行，也不缓冲响应体。
    const res = new http.ServerResponse(req);
    res.shouldKeepAlive = false;
    res.assignSocket(socket);
    try { sendResponse(req, res, response, report); }
    catch (err) { response?.body?.cancel().catch(() => {}); report(err); socket.destroy(); }
  });

  httpServer.on("request", async (req, res) => {
    let response;
    try {
      const request = makeRequest(req, res, req.method !== "GET" && req.method !== "HEAD");
      response = await config.fetch(request, serveInstance);
      sendResponse(req, res, response, report);
    } catch (err) {
      response?.body?.cancel().catch(() => {});
      report(err);
      if (res.destroyed) return;
      if (!res.headersSent) { res.writeHead(500); res.end("Internal Server Error"); }
      else res.destroy();
    }
  });

  const ready = new Promise((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });
  ready.catch(() => {}); // 调用方可以 await ready。在此之前不产生未处理的 rejection。
  httpServer.on("error", report);
  const serveInstance = {
    fetch: config.fetch,
    ready,
    address: () => httpServer.address(),
    upgrade(req, options) {
      if (stopping || req.signal.aborted || !upgrading.has(req)) return false;
      pendingData.set(req, options || {});
      return true;
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      stopPromise = (async () => {
        await ready.catch(() => {});
        const closed = new Promise((resolve) => httpServer.close(() => resolve()));
        for (const ws of wss.clients) ws.terminate();
        for (const socket of sockets) socket.destroy();
        await Promise.all([closed, new Promise((resolve) => wss.close(() => resolve()))]);
      })();
      return stopPromise;
    },
  };
  if (config.unix) {
    try { fs.unlinkSync(config.unix); } catch {}
    httpServer.listen(config.unix);
  } else {
    httpServer.listen(config.port, config.hostname);
  }
  return serveInstance;
}

// ──────────────────────────────────────────────────────────────────────────
// WebSocketClient — ws 库的 WebSocket 客户端
// ──────────────────────────────────────────────────────────────────────────

const WebSocketClient = WsClient;

// ──────────────────────────────────────────────────────────────────────────
// 导出
// ──────────────────────────────────────────────────────────────────────────

export { serve, file, spawn, spawnSync, WebSocketClient };
