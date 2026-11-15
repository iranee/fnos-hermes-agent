// Job-owned transport. No global agents, environment mutation, logging or listeners on public interfaces.
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import dns from "node:dns/promises";
import { domainToASCII } from "node:url";
import { performance } from "node:perf_hooks";

export function proxyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
export function aborted() { return proxyError("ABORT_ERR", "Network proxy operation cancelled"); }
export function networkEvent(value) {
  if (!value || !["proxy", "direct", "direct-fallback"].includes(value.route)) return null;
  const event = { route: value.route, protocol: ["http", "https", "socks5", "socks5h"].includes(value.protocol) ? value.protocol : null };
  if (["enabled", "direct", "no-proxy", "NP_ECONNREFUSED", "NP_ENETUNREACH", "NP_EHOSTUNREACH", "NP_ENOTFOUND", "NP_EAI_AGAIN", "NP_ETIMEDOUT"].includes(value.reason)) event.reason = value.reason;
  try { if (value.hostname) event.hostname = validHost(value.hostname); } catch { /* Omit invalid observer data. */ }
  for (const key of ["latencyMs", "bytes", "durationMs", "bytesPerSecond"]) {
    if (typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0) event[key] = value[key];
  }
  if (typeof value.limited === "boolean") event.limited = value.limited;
  return Object.freeze(event);
}
function checkSignal(signal) { if (signal?.aborted) throw aborted(); }
function safeNetworkError(error) {
  if (/^(NP_|ABORT_ERR$)/.test(error?.code || "")) return error;
  const codes = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH",
    "ENETUNREACH", "EPIPE", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID"]);
  const code = codes.has(error?.code) ? error.code : "NETWORK_ERROR";
  // Never relay upstream text, URL, headers, credentials, error.cause or OpenSSL diagnostics.
  return proxyError(`NP_${code}`, `Network proxy transport failed (${code})`);
}

export function validPort(value) {
  if ((typeof value !== "number" && typeof value !== "string") || !/^\d+$/.test(String(value)) ||
      !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw proxyError("NP_INVALID_PORT", "Proxy port must be an integer between 1 and 65535");
  }
  return Number(value);
}
export function validHost(value) {
  if (typeof value !== "string" || !value || value.length > 253 || /[\s\x00-\x1f\x7f/@?#%\\]/.test(value)) {
    throw proxyError("NP_INVALID_HOST", "Invalid proxy or destination host");
  }
  const host = value.replace(/^\[([^\]]+)\]$/, "$1");
  if (net.isIP(host)) return host.toLowerCase();
  const ascii = domainToASCII(host).toLowerCase();
  if (!ascii || ascii.split(".").some((part, i, all) => !(part === "" && i === all.length - 1) &&
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) {
    throw proxyError("NP_INVALID_HOST", "Invalid proxy or destination host");
  }
  return ascii;
}
function authority(host, port) { return `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`; }
export function targetURL(value) {
  let url;
  try { url = new URL(value); } catch { throw proxyError("NP_INVALID_URL", "Expected an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw proxyError("NP_INVALID_URL", "Expected an HTTP(S) URL without embedded credentials");
  }
  validHost(url.hostname);
  return url;
}

export const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1";
function bypassRule(item) {
  if (item === "*") return { all: true };
  let host = item, port;
  if (item.startsWith("[")) {
    const match = item.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (!match) throw proxyError("NP_INVALID_NO_PROXY", "Invalid NO_PROXY entry");
    host = match[1]; port = match[2];
  } else if (item.split(":").length === 2) {
    [host, port] = item.split(":");
    if (!port) throw proxyError("NP_INVALID_NO_PROXY", "Invalid NO_PROXY port");
  }
  const subdomainsOnly = host.startsWith(".") || host.startsWith("*.");
  host = host.replace(/^\*?\./, "");
  return { host: validHost(host), port: port === undefined ? undefined : validPort(port), subdomainsOnly };
}
export function validateNoProxy(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw proxyError("NP_INVALID_NO_PROXY", "NO_PROXY must be a comma-separated host list");
  }
  for (const item of value.split(",").map(s => s.trim()).filter(Boolean)) bypassRule(item);
  return value;
}
export function isBypassed(host, port, noProxy = "") {
  host = validHost(host).replace(/\.$/, "");
  return noProxy.split(",").map(s => s.trim()).filter(Boolean).some(item => {
    const rule = bypassRule(item);
    if (rule.all) return true;
    if (rule.port && rule.port !== port) return false;
    const name = rule.host.replace(/\.$/, "");
    return (!rule.subdomainsOnly && host === name) || (!net.isIP(host) && host.endsWith(`.${name}`));
  });
}

function waitFor(socket, event, signal) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      socket.removeListener(event, ready); socket.removeListener("error", failed); socket.removeListener("close", closed); socket.removeListener("end", closed);
      signal?.removeEventListener("abort", cancelled);
      error ? reject(error) : resolve();
    };
    const ready = () => finish();
    const failed = error => finish(error);
    const closed = () => finish(proxyError("NP_CLOSED", "Connection closed before handshake completed"));
    const cancelled = () => finish(aborted());
    socket.once(event, ready); socket.once("error", failed); socket.once("close", closed); socket.once("end", closed);
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) cancelled();
  });
}

// Reads only during a handshake, with bounded buffering and exact preservation of tunneled bytes.
export class SocketReader {
  constructor(socket, signal) { this.socket = socket; this.signal = signal; this.buffer = Buffer.alloc(0); }
  async fill() {
    for (;;) {
      checkSignal(this.signal);
      const chunk = this.socket.read();
      if (chunk !== null) { this.buffer = Buffer.concat([this.buffer, chunk]); return; }
      if (this.socket.destroyed || this.socket.readableEnded) throw proxyError("NP_CLOSED", "Connection closed during handshake");
      await waitFor(this.socket, "readable", this.signal);
    }
  }
  async bytes(length) {
    while (this.buffer.length < length) await this.fill();
    const result = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return result;
  }
  async header() {
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end >= 0 && end <= 16384) return this.bytes(end + 4);
      if (this.buffer.length > 16384) throw proxyError("NP_HANDSHAKE", "Proxy response headers exceeded limit");
      await this.fill();
    }
  }
  release() {
    if (this.buffer.length) this.socket.unshift(this.buffer);
    this.buffer = Buffer.alloc(0);
  }
}
function interruptible(promise, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted());
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}
function ipv6Bytes(host) {
  if (host.includes(".")) {
    const index = host.lastIndexOf(":");
    const parts = host.slice(index + 1).split(".").map(Number);
    host = `${host.slice(0, index)}:${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = host.split("::"), left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  const result = Buffer.alloc(16);
  words.forEach((word, i) => result.writeUInt16BE(parseInt(word, 16), i * 2));
  return result;
}

/** Internal API; ca extends explicit test/private CA trust, never disables peer/hostname verification. */
export function createTransport(config, { signal, timeoutMs = 15000, ca, onEvent = () => {}, fallback = true } = {}) {
  const sockets = new Set(), routes = new WeakMap();
  let detectedProtocol = null;
  const emit = event => {
    try { Promise.resolve(onEvent(Object.freeze({ ...event }))).catch(() => {}); }
    catch { /* Observers cannot replay traffic. */ }
  };
  function sample(socket, bytes, durationMs, limited = false) {
    const route = routes.get(socket);
    if (route && bytes > 0 && durationMs > 0) emit({ ...route, bytes, durationMs,
      bytesPerSecond: bytes * 1000 / durationMs, limited });
  }
  const controller = new AbortController();
  let closed = false;
  const abortParent = () => close();
  signal?.addEventListener("abort", abortParent, { once: true });
  if (signal?.aborted) close();
  function close() {
    if (closed) return;
    closed = true;
    controller.abort();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    signal?.removeEventListener("abort", abortParent);
  }
  function own(socket) {
    socket.on("error", () => {});
    if (closed) { socket.destroy(); throw aborted(); }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  }
  async function operation(fn, outerSignal) {
    if (closed) throw aborted();
    const op = new AbortController();
    const active = new Set();
    let timedOut = false;
    const cancel = () => { op.abort(); for (const socket of active) socket.destroy(); };
    const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
    const globalSignal = controller.signal;
    globalSignal.addEventListener("abort", cancel, { once: true });
    outerSignal?.addEventListener("abort", cancel, { once: true });
    if (globalSignal.aborted || outerSignal?.aborted) cancel();
    const track = socket => {
      if (op.signal.aborted) { socket.destroy(); throw aborted(); }
      active.add(socket); return own(socket);
    };
    try {
      checkSignal(op.signal);
      return await fn(op.signal, track);
    } catch (error) {
      for (const socket of active) socket.destroy();
      if (timedOut) throw proxyError("NP_TIMEOUT", "Network proxy operation timed out");
      if (op.signal.aborted) throw aborted();
      throw safeNetworkError(error);
    } finally {
      clearTimeout(timer);
      globalSignal.removeEventListener("abort", cancel);
      outerSignal?.removeEventListener("abort", cancel);
    }
  }
  async function tcp(host, port, timings, opSignal, track) {
    const start = performance.now();
    const socket = track(net.connect({ host, port, allowHalfOpen: true }));
    // Reserve time for a direct connection within the operation's total deadline.
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error(), { code: "ETIMEDOUT" })), Math.min(3000, Math.max(1, timeoutMs / 3)));
    try { await waitFor(socket, "connect", opSignal); }
    finally { clearTimeout(timer); }
    socket.setNoDelay(true);
    timings.tcpMs = performance.now() - start; // Includes DNS, if any.
    return socket;
  }
  async function secure(socket, host, timings, key, opSignal, track) {
    const start = performance.now();
    const secureSocket = track(tls.connect({ socket, servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: true, ...(ca ? { ca } : {}),
      checkServerIdentity: (_name, cert) => tls.checkServerIdentity(host, cert) }));
    await waitFor(secureSocket, "secureConnect", opSignal);
    if (!secureSocket.authorized) throw proxyError("NP_TLS", "TLS certificate verification failed");
    // Explicit IP SAN verification also covers TLS-over-TLS and disabled global TLS defaults.
    const mismatch = tls.checkServerIdentity(host, secureSocket.getPeerCertificate());
    if (mismatch) throw mismatch;
    timings[key] = performance.now() - start;
    return secureSocket;
  }
  async function upstream(route, timings, opSignal, track) {
    let socket;
    try { socket = await tcp(route.host, route.port, timings, opSignal, track); }
    catch (error) {
      // Only failure of the upstream TCP/DNS connection is eligible. Never mark
      // TLS, proxy authentication, target DNS, CONNECT denials or business I/O.
      if (["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"].includes(error.code)) {
        const safe = safeNetworkError(error); safe.upstreamUnavailable = true; throw safe;
      }
      throw error;
    }
    if (route.protocol === "https") socket = await secure(socket, route.host, timings, "proxyTlsMs", opSignal, track);
    if (route.protocol.startsWith("socks")) {
      const reader = new SocketReader(socket, opSignal);
      const method = route.username ? 2 : 0;
      socket.write(Buffer.from([5, 1, method]));
      const answer = await reader.bytes(2);
      if (answer[0] !== 5) throw proxyError("NP_HANDSHAKE", "Not a SOCKS5 response");
      if (answer[1] !== method) throw proxyError("NP_PROXY_AUTH", "SOCKS authentication method rejected");
      if (method === 2) {
        const user = Buffer.from(route.username), password = Buffer.from(route.password);
        socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]));
        const auth = await reader.bytes(2);
        if (auth[0] !== 1 || auth[1] !== 0) throw proxyError("NP_PROXY_AUTH", "SOCKS authentication rejected");
      }
      reader.release();
    }
    return socket;
  }
  function routeFor(host, port, forceProxy = false) {
    return config && (forceProxy || !isBypassed(host, port, config.noProxy)) ? config : null;
  }
  async function tunnel(host, port, route, timings, opSignal, track) {
    if (!route) return tcp(host, port, timings, opSignal, track);
    const socket = await upstream(route, timings, opSignal, track);
    const start = performance.now(), reader = new SocketReader(socket, opSignal);
    if (route.protocol === "http" || route.protocol === "https") {
      const auth = route.username ? `Proxy-Authorization: Basic ${Buffer.from(`${route.username}:${route.password}`).toString("base64")}\r\n` : "";
      socket.write(`CONNECT ${authority(host, port)} HTTP/1.1\r\nHost: ${authority(host, port)}\r\n${auth}\r\n`);
      const response = (await reader.header()).toString("latin1").match(/^HTTP\/1\.[01] (\d{3})[ \r]/);
      if (!response || Number(response[1]) !== 200) {
        throw proxyError(response?.[1] === "407" ? "NP_PROXY_AUTH" : "NP_CONNECT", "Upstream proxy CONNECT rejected");
      }
    } else {
      let address = host;
      if (route.protocol === "socks5" && !net.isIP(address)) {
        address = (await interruptible(dns.lookup(address), opSignal)).address;
        checkSignal(opSignal);
      }
      let encoded;
      const family = net.isIP(address);
      if (family === 4) encoded = Buffer.from([1, ...address.split(".").map(Number)]);
      else if (family === 6) encoded = Buffer.concat([Buffer.from([4]), ipv6Bytes(address)]);
      else {
        const name = Buffer.from(address);
        encoded = Buffer.concat([Buffer.from([3, name.length]), name]);
      }
      const end = Buffer.alloc(2); end.writeUInt16BE(port);
      socket.write(Buffer.concat([Buffer.from([5, 1, 0]), encoded, end]));
      const response = await reader.bytes(4);
      if (response[0] !== 5 || response[1] !== 0 || response[2] !== 0) throw proxyError("NP_CONNECT", "SOCKS CONNECT rejected");
      const length = response[3] === 1 ? 4 : response[3] === 4 ? 16 : response[3] === 3 ? (await reader.bytes(1))[0] : 0;
      if (!length) throw proxyError("NP_HANDSHAKE", "Invalid SOCKS reply address");
      await reader.bytes(length + 2);
    }
    reader.release();
    timings.tunnelMs = performance.now() - start;
    return socket;
  }
  async function autoTunnel(host, port, timings, opSignal, track, handshake = tunnel) {
    if (detectedProtocol) return handshake(host, port, { ...config, protocol: detectedProtocol }, timings, opSignal, track);
    // Runtime candidates must complete a real CONNECT to this destination.
    // Save-time detection may instead prove SOCKS with greeting/authentication.
    for (const protocol of ["socks5h", "https", "http"]) {
      const candidate = new AbortController(), owned = new Set(), measured = {};
      let expired = false, connected = false;
      const cancel = () => { candidate.abort(); for (const socket of owned) socket.destroy(); };
      const timer = setTimeout(() => { expired = true; cancel(); }, Math.min(1500, Math.max(1, timeoutMs / 4)));
      opSignal.addEventListener("abort", cancel, { once: true });
      if (opSignal.aborted) cancel();
      try {
        const socket = await handshake(host, port, { ...config, protocol }, measured, candidate.signal,
          socket => { owned.add(socket); socket.once("connect", () => { connected = true; }); return track(socket); });
        detectedProtocol = protocol;
        Object.assign(timings, measured);
        return socket;
      } catch (error) {
        for (const socket of owned) socket.destroy();
        checkSignal(opSignal);
        if (expired && !connected) {
          const unavailable = proxyError("NP_ETIMEDOUT", "Upstream TCP connection timed out");
          unavailable.upstreamUnavailable = true; throw unavailable;
        }
        // Never try a weaker protocol after recognized authentication or TLS
        // trust/hostname failure. Only protocol mismatch/closed/stall may advance.
        if (error.upstreamUnavailable || /CERT|SELF_SIGNED|ISSUER/.test(error.code || "") ||
            ["NP_TLS", "NP_PROXY_AUTH", "NP_CONNECT"].includes(error.code)) throw error;
        const mismatch = expired || ["NP_HANDSHAKE", "NP_CLOSED", "ECONNRESET", "EPIPE",
          "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_PACKET_LENGTH_TOO_LONG", "ERR_SSL_UNEXPECTED_MESSAGE"].includes(error.code);
        if (!mismatch) throw error;
        if (protocol === "http") throw proxyError("NP_AUTO_PROTOCOL", "No supported proxy protocol completed a target handshake");
      } finally {
        clearTimeout(timer); opSignal.removeEventListener("abort", cancel);
      }
    }
    throw proxyError("NP_AUTO_PROTOCOL", "No supported proxy protocol completed a target handshake");
  }
  async function connectRoute(host, port, forceProxy, timings, opSignal, track, connect) {
    let route = routeFor(host, port, forceProxy), reason = route ? "enabled" : config ? "no-proxy" : "direct";
    const start = performance.now(), attempt = new Set();
    const tracked = socket => { attempt.add(socket); return track(socket); };
    let result;
    try { result = await connect(route, tracked); }
    catch (error) {
      for (const socket of attempt) socket.destroy();
      if (!route || forceProxy || !fallback || !error.upstreamUnavailable) throw error;
      checkSignal(opSignal);
      reason = error.code; route = null;
      for (const key of Object.keys(timings)) timings[key] = null;
      try { result = await connect(null, track); }
      catch (directError) {
        if (!opSignal.aborted) emit({ route: "direct-fallback", reason, protocol: null, hostname: host, latencyMs: performance.now() - start });
        throw directError;
      }
    }
    timings.connectMs = performance.now() - start;
    const event = { route: route ? "proxy" : reason.startsWith("NP_") ? "direct-fallback" : "direct",
      reason, protocol: route ? (detectedProtocol || route.protocol) : null, hostname: host, latencyMs: timings.connectMs };
    routes.set(result.socket, event); emit(event);
    return { ...result, proxied: Boolean(route), route: event.route, protocol: event.protocol };
  }
  async function openHttpInner(url, forceProxy, timings, opSignal, track) {
    const host = validHost(url.hostname), port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return connectRoute(host, port, forceProxy, timings, opSignal, track, async (route, tracked) => {
      let socket, requestPath = url.pathname + url.search, proxyAuthorization;
      if (url.protocol === "http:" && route && ["http", "https"].includes(route.protocol)) {
        socket = await upstream(route, timings, opSignal, tracked);
        requestPath = `${url.origin}${url.pathname}${url.search}`;
        if (route.username) proxyAuthorization = `Basic ${Buffer.from(`${route.username}:${route.password}`).toString("base64")}`;
      } else {
        socket = route?.protocol === "auto" ? await autoTunnel(host, port, timings, opSignal, tracked)
          : await tunnel(host, port, route, timings, opSignal, tracked);
        if (url.protocol === "https:") socket = await secure(socket, host, timings, "tlsMs", opSignal, tracked);
      }
      return { socket, requestPath, proxyAuthorization };
    });
  }
  async function openHttp(url, { signal: requestSignal, forceProxy = false } = {}) {
    url = targetURL(url);
    return operation((opSignal, track) => openHttpInner(url, forceProxy, {}, opSignal, track), requestSignal);
  }
  async function openTunnel(host, port, { signal: requestSignal, forceProxy = false } = {}) {
    host = validHost(host); port = validPort(port);
    return operation(async (opSignal, track) => {
      const timings = {};
      const result = await connectRoute(host, port, forceProxy, timings, opSignal, track, async (route, tracked) => ({
        socket: route?.protocol === "auto" ? await autoTunnel(host, port, timings, opSignal, tracked)
          : await tunnel(host, port, route, timings, opSignal, tracked)
      }));
      return result.socket;
    }, requestSignal);
  }
  async function detectProtocol({ signal: requestSignal } = {}) {
    return operation(async (opSignal, track) => {
      if (!config) throw proxyError("NP_NOT_CONFIGURED", "Configure a proxy before detecting its protocol");
      const owned = new Set();
      try {
        // SOCKS5 and SOCKS5h share the wire protocol; retain the remote-DNS default.
        // HTTP(S) needs a successful proxy CONNECT, not TCP-open or a GET returning 200.
        await autoTunnel("www.cloudflare.com", 443, {}, opSignal,
          socket => { owned.add(socket); return track(socket); },
          (host, port, route, timings, signal, tracked) => route.protocol === "socks5h"
            ? upstream(route, timings, signal, tracked) : tunnel(host, port, route, timings, signal, tracked));
        checkSignal(opSignal);
        return detectedProtocol;
      } finally { for (const socket of owned) socket.destroy(); }
    }, requestSignal);
  }
  async function probe() {
    // auto needs a real target; deferred to the first open/request, never guessed.
    if (!config || config.protocol === "auto") return;
    try { await operation(async (opSignal, track) => { (await upstream(config, {}, opSignal, track)).destroy(); }); }
    catch (error) { if (!fallback || !error.upstreamUnavailable) throw error; }
  }
  async function request(url, options = {}) {
    // Validate and snapshot all request data before DNS, a proxy handshake or any connection.
    const { method, body, headers: clean, signal: requestSignal, forceProxy,
      headersOnly, maxBytes, truncate } = normalizeRequestOptions(options);
    url = targetURL(url);
    clean.host = url.host; clean.connection = "close"; clean["accept-encoding"] = "identity";
    return operation(async (opSignal, track) => {
      const start = performance.now();
      const timings = { tcpMs: null, proxyTlsMs: null, tunnelMs: null, tlsMs: null, ttfbMs: null, totalMs: null };
      const opened = await openHttpInner(url, forceProxy, timings, opSignal, track);
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => opened.socket;
      if (opened.proxyAuthorization) clean["proxy-authorization"] = opened.proxyAuthorization;
      try {
        return await new Promise((resolve, reject) => {
          let settled = false, response;
          let bytes = 0;
          const chunks = [];
          const finish = (error, limited = false) => {
            if (settled) return;
            settled = true;
            opSignal.removeEventListener("abort", cancel);
            timings.totalMs = performance.now() - start;
            if (error) reject(error);
            else {
              sample(opened.socket, bytes, Math.max(0, timings.totalMs - timings.ttfbMs), limited);
              resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks),
                bytes, limited, timings, proxied: opened.proxied, route: opened.route, protocol: opened.protocol });
            }
            response?.destroy(); req.destroy();
          };
          const cancel = () => finish(aborted());
          const req = http.request({ method, host: validHost(url.hostname), port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: opened.requestPath, agent, headers: clean }, res => {
            response = res;
            timings.ttfbMs = performance.now() - start;
            res.on("error", finish);
            res.on("aborted", () => finish(proxyError("NP_RESPONSE", "HTTP response was interrupted")));
            if (res.statusCode === 407 && opened.proxied) return finish(proxyError("NP_PROXY_AUTH", "Upstream proxy authentication rejected"));
            if (headersOnly) return finish();
            res.on("data", chunk => {
              const remaining = maxBytes - bytes;
              if (chunk.length > remaining && !truncate) return finish(proxyError("NP_BODY_LIMIT", "HTTP response exceeded size limit"));
              const part = chunk.subarray(0, remaining);
              bytes += part.length;
              chunks.push(part);
              if (chunk.length > remaining || (truncate && bytes === maxBytes)) finish(null, true);
            });
            res.on("end", () => finish());
          });
          req.on("error", finish);
          opSignal.addEventListener("abort", cancel, { once: true });
          if (opSignal.aborted) cancel(); else req.end(body);
        });
      } finally { agent.destroy(); opened.socket.destroy(); }
    }, requestSignal);
  }
  return { openHttp, openTunnel, request, detectProtocol, probe, close, sample, get detectedProtocol() { return detectedProtocol; } };
}

/** Shared request/requestJson contract. Bodies are bytes, never implicitly JSON-stringified. */
export function normalizeRequestOptions(options = {}) {
  try {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error();
    const { method = "GET", body, headers = {}, signal, forceProxy = false,
      headersOnly = false, maxBytes = 2097152, truncate = false } = options;
    if (method !== "GET" && method !== "POST") throw new Error();
    if (body !== undefined && (method === "GET" || (typeof body !== "string" && !Buffer.isBuffer(body)))) throw new Error();
    const length = body === undefined ? 0 : typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.length;
    if (length > 64 * 1024) throw new Error();
    if (typeof forceProxy !== "boolean" || typeof headersOnly !== "boolean" || typeof truncate !== "boolean" ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error();
    if (signal != null && (typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" ||
        typeof signal.removeEventListener !== "function")) throw new Error();
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error();
    const validated = Object.create(null);
    const headerValue = value => {
      if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) throw new Error();
      return String(value);
    };
    for (const [name, value] of Object.entries(headers)) {
      http.validateHeaderName(name);
      const key = name.toLowerCase();
      // A bounded, fully buffered body always uses Content-Length, never chunked framing.
      if (key === "transfer-encoding" || Object.hasOwn(validated, key)) throw new Error();
      if (key === "content-length") {
        const declared = headerValue(value);
        if (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) !== length) throw new Error();
        validated[key] = String(length);
      } else {
        if (Array.isArray(value) && !value.length) throw new Error();
        const copy = Array.isArray(value) ? value.map(headerValue) : headerValue(value);
        http.validateHeaderValue(name, copy);
        validated[key] = copy;
      }
    }
    const clean = cleanHeaders(validated);
    // Restore canonical framing even if a Connection token tried to remove it.
    if (method === "POST" || Object.hasOwn(validated, "content-length")) clean["content-length"] = String(length);
    return { method, body: body === undefined ? undefined : Buffer.from(body), headers: clean,
      signal, forceProxy, headersOnly, maxBytes, truncate };
  } catch {
    // Native header/type errors can quote caller-supplied secrets. Never propagate their text/cause.
    throw proxyError("NP_OPTIONS", "Invalid network request options");
  }
}

function cleanHeaders(headers) {
  const result = {};
  const blocked = new Set(["connection", "proxy-connection", "proxy-authorization", "proxy-authenticate", "keep-alive",
    "te", "trailer", "transfer-encoding", "upgrade"]);
  const connection = Object.entries(headers).find(([key]) => key.toLowerCase() === "connection")?.[1];
  if (typeof connection === "string") for (const name of connection.split(",")) blocked.add(name.trim().toLowerCase());
  for (const [key, value] of Object.entries(headers)) if (!blocked.has(key.toLowerCase())) result[key.toLowerCase()] = value;
  return result;
}

/** HTTP forward + CONNECT bridge for clients without SOCKS support. Each instance owns all its sockets. */
export async function createBridge(transport, { signal, timeoutMs = 15000 } = {}) {
  checkSignal(signal);
  const clients = new Set(), pending = new Set();
  let closing = false, closePromise;
  const server = http.createServer({ maxHeaderSize: 32768 }, (incoming, outgoing) => {
    const controller = new AbortController();
    pending.add(controller);
    let request, socket;
    const cancel = () => { controller.abort(); request?.destroy(); socket?.destroy(); };
    incoming.on("aborted", cancel);
    outgoing.on("close", cancel);
    (async () => {
      try {
        const url = targetURL(incoming.url);
        const opened = await transport.openHttp(url, { signal: controller.signal });
        socket = opened.socket;
        if (controller.signal.aborted || closing) { socket.destroy(); return; }
        const agent = new http.Agent({ keepAlive: false });
        agent.createConnection = () => socket;
        const headers = cleanHeaders(incoming.headers);
        headers.host = url.host; headers.connection = "close";
        if (opened.proxyAuthorization) headers["proxy-authorization"] = opened.proxyAuthorization;
        request = http.request({ method: incoming.method, host: validHost(url.hostname),
          port: url.port || (url.protocol === "https:" ? 443 : 80), path: opened.requestPath, headers, agent }, response => {
          // Do not expose upstream challenges (which may contain identifying text) to children/logs.
          if (response.statusCode === 407) { response.destroy(); outgoing.writeHead(502); outgoing.end("Upstream proxy authentication failed\n"); return; }
          outgoing.writeHead(response.statusCode, cleanHeaders(response.headers));
          response.on("error", () => outgoing.destroy());
          let bytes = 0;
          const start = performance.now();
          response.on("data", chunk => { bytes += chunk.length; });
          response.on("end", () => transport.sample(socket, bytes, performance.now() - start));
          response.pipe(outgoing);
        });
        request.on("error", () => {
          if (!outgoing.headersSent && !outgoing.destroyed) { outgoing.writeHead(502); outgoing.end("Upstream proxy request failed\n"); }
          else outgoing.destroy();
        });
        request.on("close", () => agent.destroy());
        request.setTimeout(timeoutMs, () => request.destroy());
        incoming.pipe(request);
      } catch {
        if (!outgoing.headersSent && !outgoing.destroyed) { outgoing.writeHead(502); outgoing.end("Upstream proxy connection failed\n"); }
        else outgoing.destroy();
      } finally { pending.delete(controller); }
    })();
  });
  server.on("connect", (request, client, head) => {
    const controller = new AbortController();
    pending.add(controller);
    let upstream;
    const cancel = () => { controller.abort(); upstream?.destroy(); };
    client.on("close", cancel);
    (async () => {
      try {
        const match = request.url.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
        if (!match) throw proxyError("NP_INVALID_URL", "Invalid CONNECT destination");
        upstream = await transport.openTunnel(match[1], match[2], { signal: controller.signal });
        if (client.destroyed || closing) { upstream.destroy(); return; }
        upstream.on("error", () => client.destroy());
        upstream.on("close", () => { if (upstream.readableEnded) client.end(); else client.destroy(); });
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      } catch {
        if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      } finally { pending.delete(controller); }
    })();
  });
  server.on("connection", socket => {
    clients.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => clients.delete(socket));
    if (closing) socket.destroy();
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 1000;
  server.on("error", () => {});
  const abort = () => { void close(); };
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    signal?.removeEventListener("abort", abort);
    for (const controller of pending) controller.abort();
    for (const socket of clients) socket.destroy();
    transport.close();
    closePromise = new Promise(resolve => server.close(() => resolve()));
    return closePromise;
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { await close(); throw aborted(); }
    return { url: `http://127.0.0.1:${server.address().port}`, close };
  } catch (error) { await close(); throw safeNetworkError(error); }
}
