import { createServer, request } from "node:http";
import { connect } from "node:net";
import { Readable } from "node:stream";
import { lstatSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import path from "node:path";

export function kernelControlPath(varDir) {
  if (typeof varDir !== "string" || !path.isAbsolute(varDir) || path.resolve(varDir) === path.parse(varDir).root) {
    throw new Error("VAR_DIR must be an explicit absolute directory");
  }
  return path.join(varDir, "kernel-control", "control.sock");
}
function privateDirectory(directory, create = false) {
  if (process.platform !== "linux") throw new Error("Kernel control socket requires Linux");
  if (create) {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) {
    throw new Error("Kernel control directory must be owned by the application user");
  }
}
function socketStat(socketPath) {
  const stat = lstatSync(socketPath);
  if (!stat.isSocket() || stat.uid !== process.getuid()) {
    throw new Error("Kernel control socket has an unexpected identity");
  }
  return stat;
}
function alive(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.setTimeout(2000, () => socket.destroy(new Error("Cannot determine whether kernel control is running")));
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", error => {
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

export function createKernelControlSocket({ varDir, handle }) {
  const socketPath = kernelControlPath(varDir);
  let server;
  let identity;
  let starting;
  const connections = new Set();
  async function start() {
    if (server || starting) throw new Error("Kernel control is already running or starting");
    starting = open();
    try { await starting; } finally { starting = undefined; }
  }
  async function open() {
    privateDirectory(path.dirname(socketPath), true);
    let existing;
    try { existing = socketStat(socketPath); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing) {
      if (await alive(socketPath)) throw new Error("Kernel control is already running");
      const current = socketStat(socketPath);
      if (current.ino !== existing.ino || current.dev !== existing.dev) throw new Error("Kernel control socket changed during inspection");
      unlinkSync(socketPath);
    }
    server = createServer(async (incoming, outgoing) => {
      try {
        if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//")) {
          outgoing.writeHead(400).end(); return;
        }
        const controller = new AbortController();
        incoming.once("aborted", () => controller.abort());
        const req = new Request(`http://localhost${incoming.url}`, { method: incoming.method,
          headers: incoming.headers, signal: controller.signal,
          ...(!["GET", "HEAD"].includes(incoming.method) ? { body: Readable.toWeb(incoming), duplex: "half" } : {}) });
        const response = await handle(req) || new Response("Not Found", { status: 404 });
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        if (!outgoing.headersSent) outgoing.writeHead(503, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ ok: false, error: "Kernel control request failed" }));
      }
    });
    server.on("connection", socket => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
    });
    server.on("error", () => {});
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); });
      });
      // Only the socket just bound by this server may have its mode set; best effort,
      // fnOS may rewrite modes later and the directory owner check still applies.
      identity = lstatSync(socketPath);
      if (!identity.isSocket() || identity.uid !== process.getuid()) throw new Error("Kernel control socket changed during startup");
      try { chmodSync(socketPath, 0o600); } catch {}
      const current = socketStat(socketPath);
      if (current.ino !== identity.ino || current.dev !== identity.dev) throw new Error("Kernel control socket changed during startup");
    } catch (error) {
      try { await stop(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], `Kernel control start failed: ${error.message}; cleanup failed: ${cleanup.message}`); }
      throw error;
    }
  }
  async function stop() {
    if (!server) return;
    const ownedServer = server;
    try {
      // Includes raw probes and incomplete HTTP requests, not just HTTP clients.
      const closed = new Promise(resolve => ownedServer.close(resolve));
      for (const socket of connections) socket.destroy();
      ownedServer.closeAllConnections();
      await closed;
      if (identity) {
        try {
          const current = lstatSync(socketPath);
          if (current.ino === identity.ino && current.dev === identity.dev) unlinkSync(socketPath);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    } finally {
      server = undefined;
      identity = undefined;
      connections.clear();
    }
  }
  async function close() {
    if (starting) await starting.catch(() => {});
    await stop();
  }
  return { start, close, socketPath };
}

export function requestKernelControl({ varDir, pathname, body, method = body === undefined ? "GET" : "POST", timeoutMs = 100000 }) {
  const socketPath = kernelControlPath(varDir);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error("Invalid kernel control timeout");
  // This JSON client supports only the control API methods, with explicit bodies
  // for mutations. Omitted method retains the original GET/POST convention.
  if (!["GET", "POST", "PATCH"].includes(method) || (method === "GET" ? body !== undefined : body === undefined)) {
    throw new Error("Invalid kernel control method/body combination");
  }
  let text;
  if (body !== undefined) {
    try { text = JSON.stringify(body); } catch { throw new Error("Invalid kernel control JSON body"); }
    if (text === undefined) throw new Error("Invalid kernel control JSON body");
  }
  privateDirectory(path.dirname(socketPath));
  socketStat(socketPath);
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error, value) => {
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const req = request({ socketPath, path: pathname, method,
      headers: text === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(text) } }, response => {
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { finish(new Error("Kernel control response exceeded its limit")); response.destroy(); }
        else chunks.push(chunk);
      });
      response.on("error", () => finish(new Error("Kernel control response was interrupted; inspect update status before retrying")));
      response.on("end", () => {
        let value;
        try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { finish(new Error("Kernel control returned an invalid response")); return; }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const detail = typeof value?.error === "string" ? value.error : value?.error?.message;
          finish(Object.assign(new Error(typeof detail === "string" && detail ? detail : "Kernel control rejected the request"),
            { statusCode: response.statusCode })); return;
        }
        finish(null, value);
      });
    });
    // Bound the entire exchange, including connect and trickling responses.
    // A timeout must remain distinguishable from an unavailable application.
    timer = setTimeout(() => {
      finish(Object.assign(new Error("Kernel control timed out; inspect update status before retrying"), { code: "ETIMEDOUT" }));
      req.destroy();
    }, timeoutMs);
    req.on("error", error => finish(new Error("Cannot reach application kernel control; start the fnOS application and inspect update status before retrying", { cause: error })));
    req.end(text);
  });
}
