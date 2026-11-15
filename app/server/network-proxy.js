import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { createTransport, createBridge, proxyError, aborted, validHost, validPort, targetURL,
  validateNoProxy, DEFAULT_NO_PROXY, normalizeRequestOptions, networkEvent } from "./network-proxy-transport.js";
import { diagnoseNetwork } from "./network-diagnostics.js";

const CONFIG_NAME = "fnos-network-proxy.json";
const OWNER = "fnos-hermes-network-proxy";
const FIELDS = ["protocol", "host", "port", "username", "password", "noProxy"];
const PROXY_ENV = /^(?:https?_proxy|all_proxy|no_proxy|npm_config_(?:proxy|https_proxy|no_proxy|noproxy)|git_proxy_command)$/i;
const PROTECTED_DOTENV = /^(?:https?_proxy|all_proxy|no_proxy|npm_config_.*|git_config(?:_.*)?|git_allow_protocol|git_proxy_command|git_ssl_no_verify|node_tls_reject_unauthorized|hermes_home|hermes_managed_dir)$/i;
const GIT_PROXY_KEY = /^(?:http(?:\..+)?\.proxy|remote\..+\.proxy)$/i;

function optionalStat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) === path.parse(value).root) {
    throw proxyError("NP_PATH", `${label} must be an explicit absolute directory`);
  }
  return path.resolve(value);
}
// Check every component, not just the leaf. Never chmod, follow a symlink, or silently recover corrupt state.
function safePath(file, { optional = false, directory = false } = {}) {
  const root = path.parse(file).root;
  let current = root;
  const parts = file.slice(root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const info = optionalStat(current);
    if (!info) {
      if (optional) return null;
      throw proxyError("NP_PATH", "Proxy data directory or file is missing");
    }
    if (info.isSymbolicLink()) throw proxyError("NP_SYMLINK", "Proxy boundary contains a symlink; refusing access");
    const isDirectory = i < parts.length - 1 || directory;
    if (isDirectory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) {
      throw proxyError("NP_PATH", "Expected a real directory or an unlinked regular file");
    }
    if (i === parts.length - 1) return info;
  }
  throw proxyError("NP_PATH", "Invalid proxy storage path");
}
function sameFile(a, b) { return a && b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs; }
// Mode bits are not checked: fnOS ACL/chown may rewrite them, and only the package user can open DATA anyway.
function safeRead(file, { maxBytes = 1048576 } = {}) {
  const before = safePath(file, { optional: true });
  if (!before) return null;
  if (before.size > maxBytes) throw proxyError("NP_FILE_LIMIT", "Proxy configuration or environment file exceeded size limit");
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!sameFile(before, fs.fstatSync(fd))) throw proxyError("NP_PATH_CHANGED", "Proxy file changed during access");
    const value = fs.readFileSync(fd);
    if (!sameFile(before, safePath(file))) throw proxyError("NP_PATH_CHANGED", "Proxy file changed during access");
    return value;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function credentials(value, label) {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > 255) {
    throw proxyError("NP_CREDENTIALS", `${label} must be text without control characters, at most 255 UTF-8 bytes`);
  }
  return value;
}
function normalize(input, previous = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !FIELDS.includes(key))) {
    throw proxyError("NP_CONFIG", "Expected proxy fields only; enable/disable is a separate operation");
  }
  const value = { protocol: "http", username: "", password: "", noProxy: DEFAULT_NO_PROXY, ...previous, ...input };
  if (typeof value.protocol !== "string" || !["auto", "http", "https", "socks5", "socks5h"].includes(value.protocol.toLowerCase().replace(/:$/, ""))) {
    throw proxyError("NP_PROTOCOL", "Proxy protocol must be auto, http, https, socks5 or socks5h");
  }
  value.protocol = value.protocol.toLowerCase().replace(/:$/, "");
  value.host = validHost(value.host); value.port = validPort(value.port);
  value.username = credentials(value.username, "Proxy username"); value.password = credentials(value.password, "Proxy password");
  if (value.username.includes(":")) throw proxyError("NP_CREDENTIALS", "Proxy username cannot contain a colon");
  if (value.password && !value.username) throw proxyError("NP_CREDENTIALS", "A proxy password requires a username");
  value.noProxy = validateNoProxy(value.noProxy);
  return Object.fromEntries(FIELDS.map(key => [key, value[key]]));
}
function publicState(state) {
  return { configured: Boolean(state), enabled: Boolean(state?.enabled), protocol: state?.protocol || null,
    host: state?.host || "", port: state?.port || null, username: state?.username || "",
    passwordConfigured: Boolean(state?.password), noProxy: state?.noProxy ?? DEFAULT_NO_PROXY };
}
function safeFsError(error) {
  if (error?.code?.startsWith("NP_")) return error;
  // JSON parse errors can quote secret-bearing source. Do not propagate them or attach a cause.
  return proxyError("NP_STORAGE", "Cannot safely read or persist the application proxy configuration");
}
function readDotenv(buffer) {
  if (buffer.length >= 4 && (buffer.readUInt32LE(0) === 0x0000feff || buffer.readUInt32LE(0) === 0xfffe0000)) {
    throw proxyError("NP_DOTENV_ENCODING", "Cannot safely inspect UTF-32 dotenv; refusing an enabled proxy job");
  }
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le").replace(/\0/g, "");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const copy = Buffer.from(buffer.subarray(2));
    if (copy.length % 2) throw proxyError("NP_DOTENV_ENCODING", "Invalid dotenv encoding");
    return copy.swap16().toString("utf16le").replace(/\0/g, "");
  }
  // The official sanitizer removes NULs and the parser strips a UTF-8 BOM / falls back to latin-1.
  return buffer.toString("utf8").replace(/^\ufeff/, "").replace(/\0/g, "");
}

/**
 * Update/initialization boundary only, NOT a sandbox for arbitrary model/browser traffic.
 * withEnvironment(baseEnv, async (effectiveEnv, metadata) => result, {scope, signal})
 * The callback MUST await its entire job/process tree and honour metadata.signal (no detached children).
 * Pass the actual child cwd as baseEnv.PWD. For a new checkout/changed per-step environment, call
 * metadata.prepareEnvironment({...childBaseEnv, PWD: childCwd}) immediately before spawning it.
 * save() merges omitted fields/password and preserves the current enabled bit; it never enables by input.
 * test() probes the saved proxy even when disabled, deliberately ignoring NO_PROXY for the probe URL.
 * requestJson() honours enabled/NO_PROXY; only pre-request upstream connection unavailability falls back.
 * diagnose() tests the saved proxy (including when disabled); metadata.diagnose() tests the job snapshot.
 * diagnostics is a module-only fixture dependency, never an API option.
 */
export function createNetworkProxy({ appDir, dataDir, env = process.env, onEvent = () => {}, diagnostics }) {
  appDir = absolute(appDir, "appDir"); dataDir = absolute(dataDir, "dataDir");
  const defaults = { ...env };
  const configFile = path.join(dataDir, CONFIG_NAME);
  let recentRoute = null;
  const events = local => value => {
    const event = networkEvent(value);
    if (!event) return;
    recentRoute = event;
    for (const observer of new Set([onEvent, local])) {
      try { if (typeof observer === "function") Promise.resolve(observer(event)).catch(() => {}); }
      catch { /* An observer cannot replay a request. */ }
    }
  };
  function diagnostic(state, options = {}) {
    return (diagnostics || diagnoseNetwork)(state, { signal: options.signal, onEvent: events(options.onEvent) });
  }
  async function diagnose({ signal } = {}) { return diagnostic(load(), { signal }); }

  function load() {
    try {
      safePath(dataDir, { directory: true });
      const bytes = safeRead(configFile, { maxBytes: 16384 });
      if (bytes === null) return null;
      const state = JSON.parse(bytes.toString("utf8"));
      if (!state || state.owner !== OWNER || state.schema !== 1 || typeof state.enabled !== "boolean" ||
          Object.keys(state).some(key => !["owner", "schema", "enabled", ...FIELDS].includes(key)) ||
          FIELDS.some(key => !Object.hasOwn(state, key))) {
        throw proxyError("NP_CONFIG", "Proxy configuration is not a valid application-owned record");
      }
      return { ...normalize(Object.fromEntries(FIELDS.map(key => [key, state[key]]))), enabled: state.enabled };
    } catch (error) { throw safeFsError(error); }
  }
  function persist(state) {
    let fd, temp, published = false;
    try {
      const parent = safePath(dataDir, { directory: true });
      const before = safePath(configFile, { optional: true });
      // Refuse an unrelated/pre-existing file or corrupt state instead of adopting it.
      if (before) load();
      temp = path.join(dataDir, `.${CONFIG_NAME}.${randomUUID()}.tmp`);
      fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      if (process.platform !== "win32") {
        // fnOS can inherit the directory mode despite open(0600); best effort only, never a save failure.
        try { if ((fs.fstatSync(fd).mode & 0o777) !== 0o600) fs.fchmodSync(fd, 0o600); } catch {}
      }
      fs.writeFileSync(fd, JSON.stringify({ owner: OWNER, schema: 1, ...state }) + "\n");
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      const now = safePath(dataDir, { directory: true });
      if (parent.dev !== now.dev || parent.ino !== now.ino) throw proxyError("NP_PATH_CHANGED", "Proxy data directory changed during save");
      if (before) {
        if (!sameFile(before, safePath(configFile))) throw proxyError("NP_PATH_CHANGED", "Proxy configuration changed during save");
        fs.renameSync(temp, configFile);
        published = true;
      } else {
        // Atomic no-clobber creation, including a symlink appearing after the initial check.
        fs.linkSync(temp, configFile);
        published = true;
        fs.unlinkSync(temp);
      }
      temp = undefined;
      if (process.platform !== "win32") {
        const dirFd = fs.openSync(dataDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | (fs.constants.O_NOFOLLOW || 0));
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      }
    } catch (error) {
      const failure = safeFsError(error);
      // Publication is irreversible here: cleanup/durability failure must not invite a replay.
      if (published) failure.committed = true;
      else delete failure.committed;
      throw failure;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Preserve the safe persistence error. */ } }
      if (temp) { try { fs.unlinkSync(temp); } catch { /* Never touch another file to recover a failed save. */ } }
    }
  }
  function status() { return { ...publicState(load()), recentRoute }; }
  async function save(input, { signal } = {}) {
    if (signal?.aborted) throw aborted();
    const current = load();
    const state = { ...normalize(input, current ? Object.fromEntries(FIELDS.map(key => [key, current[key]])) : {}),
      enabled: current?.enabled || false };
    if (state.protocol === "auto") {
      const transport = createTransport(state, { timeoutMs: 8000, fallback: false });
      try { state.protocol = await transport.detectProtocol({ signal }); }
      finally { transport.close(); }
      if (signal?.aborted) throw aborted();
      // Detection yields; never overwrite a save/toggle performed outside the control lock.
      if (JSON.stringify(load()) !== JSON.stringify(current)) {
        throw proxyError("NP_PATH_CHANGED", "Proxy configuration changed during protocol detection");
      }
    }
    persist(state);
    recentRoute = null;
    return publicState(state);
  }
  async function setEnabled(enabled) {
    if (typeof enabled !== "boolean") throw proxyError("NP_CONFIG", "enabled must be a boolean");
    const state = load();
    if (!state) {
      if (enabled) throw proxyError("NP_NOT_CONFIGURED", "Configure a proxy before enabling it");
      return publicState(null);
    }
    if (enabled) inspectEnvironment(defaults, { telegram: true });
    persist({ ...state, enabled });
    recentRoute = null;
    return publicState({ ...state, enabled });
  }

  function inspectEnvironment(baseEnv, { telegram = false } = {}) {
    if (telegram) {
      for (const name of ["NO_PROXY", "no_proxy"]) {
        if (baseEnv[name]) validateNoProxy(baseEnv[name]);
      }
    }
    // env_loader.py _load_user_dotenv and _apply_managed_env use override=True, including for update.
    // PYTHON_DOTENV_DISABLED does NOT guard Hermes' custom parser. Refuse definitions, even empty ones;
    // conservatively refuse interpolation/self-references too, rather than claiming an unsafe override.
    const roots = new Set([appDir, path.join(appDir, "hermes-src"), dataDir]);
    for (const key of ["HERMES_HOME", "FNOS_KERNEL_ROOT", "HERMES_PYTHON_SRC_ROOT", "PWD"]) {
      // fnOS may start the monitor at the filesystem root, outside application dotenv directories.
      if (key === "PWD" && typeof baseEnv[key] === "string" && path.isAbsolute(baseEnv[key]) &&
          path.resolve(baseEnv[key]) === path.parse(baseEnv[key]).root) continue;
      if (baseEnv[key]) roots.add(absolute(baseEnv[key], key));
    }
    if (baseEnv.PYTHONPATH) for (const entry of baseEnv.PYTHONPATH.split(path.delimiter).filter(Boolean)) {
      roots.add(absolute(entry, "PYTHONPATH entry"));
    }
    // Include staging/source generations even when the job has not selected its kernel environment yet.
    const kernels = path.join(dataDir, "kernels");
    if (safePath(kernels, { optional: true, directory: true })) {
      for (const entry of fs.readdirSync(kernels, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw proxyError("NP_SYMLINK", "Kernel environment boundary contains a symlink");
        if (entry.isDirectory()) roots.add(path.join(kernels, entry.name, "src"));
      }
    }
    const files = new Set();
    for (const root of roots) for (const name of [".env", ".op.env"]) files.add(path.join(root, name));
    const managed = baseEnv.HERMES_MANAGED_DIR?.trim() || (process.platform === "win32" ? null : "/etc/hermes");
    if (managed) files.add(path.join(absolute(managed, "HERMES_MANAGED_DIR"), ".env"));
    for (const file of files) {
      const bytes = safeRead(file);
      if (bytes === null) continue;
      const text = readDotenv(bytes);
      // Quoted keys and whitespace/newlines before '=' are valid python-dotenv syntax.
      const assignments = /(?:^|\n)[ \t]*(?:export\s+)?(?:'([^'\r\n]+)'|([^\s=#'"\r\n]+))\s*=/g;
      for (const match of text.matchAll(assignments)) {
        const key = match[1] || match[2];
        if (telegram && /^(?:telegram_proxy|hermes_telegram_disable_fallback_ips)$/i.test(key)) {
          throw proxyError("NP_TELEGRAM_ENV", "A Telegram environment definition conflicts with the application proxy");
        }
        if (PROTECTED_DOTENV.test(key)) {
          // File path/key only, never the assigned value or surrounding line.
          throw proxyError("NP_DOTENV_CONFLICT", `Official dotenv may override the enabled proxy: ${key} in ${file}`);
        }
      }
    }
    // Git URL/remote-specific settings can outrank plain http.proxy/http.version. Refuse those in known
    // job repositories; environment disables global/system config *only for this job*, not on disk.
    // An integration adding a new working directory must pass its absolute PWD in baseEnv.
    for (const root of roots) {
      const git = path.join(root, ".git");
      const info = safePath(git, { optional: true, directory: true });
      if (!info) continue;
      const config = safeRead(path.join(git, "config"))?.toString("utf8") || "";
      if (/(?:^|\n)\s*(?:\[include(?:if)?\b|(?:proxy|sslverify|proxysslverify)\s*=)/i.test(config)) {
        throw proxyError("NP_GIT_CONFIG_CONFLICT", "Repository proxy/TLS/include settings may override the job proxy; refusing this job");
      }
      let urlHttpSection = false;
      for (const line of config.split(/\r?\n/)) {
        // Quoted (including IPv6) and legacy dotted subsections; allow same-line assignments.
        const section = line.match(/^\s*\[([a-z0-9-]+)(\.[^\]\r\n]+|[ \t]+"(?:\\.|[^"\\])*")?[ \t]*\]/i);
        if (section) urlHttpSection = /^http$/i.test(section[1]) && Boolean(section[2]);
        if (urlHttpSection && /^\s*version\s*(?:=|[;#]|$)/i.test(section ? line.slice(section[0].length) : line)) {
          throw proxyError("NP_GIT_CONFIG_CONFLICT", "Repository URL-specific HTTP version may override the job HTTP/1.1 setting; refusing this job");
        }
      }
    }
  }

  function environment(baseEnv, state, bridgeUrl) {
    const effective = { ...baseEnv };
    for (const key of Object.keys(effective)) if (PROXY_ENV.test(key) || /^git_config_(?:count|key_\d+|value_\d+|parameters)$/i.test(key)) delete effective[key];
    effective.HERMES_HOME ||= dataDir;
    const noProxy = [...new Set([state?.noProxy ?? DEFAULT_NO_PROXY, baseEnv.NO_PROXY, baseEnv.no_proxy]
      .filter(value => value !== undefined && value !== "").map(validateNoProxy))].join(",");
    effective.NO_PROXY = effective.no_proxy = noProxy;
    const gitEntries = [];
    const count = baseEnv.GIT_CONFIG_COUNT ?? "0";
    if (!/^\d+$/.test(String(count)) || Number(count) > 1024) throw proxyError("NP_GIT_ENV", "Invalid inherited Git configuration environment");
    for (let i = 0; i < Number(count); i++) {
      const key = baseEnv[`GIT_CONFIG_KEY_${i}`], value = baseEnv[`GIT_CONFIG_VALUE_${i}`];
      if (typeof key !== "string" || typeof value !== "string") throw proxyError("NP_GIT_ENV", "Incomplete inherited Git configuration environment");
      if (/^include(?:if)?\./i.test(key)) throw proxyError("NP_GIT_ENV", "Inherited Git includes cannot be verified for a proxy job");
      if (!GIT_PROXY_KEY.test(key) && !/^http(?:\..+)?\.(?:sslverify|proxysslverify)$/i.test(key) &&
          !(bridgeUrl && /^http(?:\..+)?\.version$/i.test(key))) gitEntries.push([key, value]);
    }
    gitEntries.push(["http.proxy", bridgeUrl || ""], ["http.sslVerify", "true"], ["http.proxySSLVerify", "true"]);
    // Avoid HTTP/2 truncation on proxied Git transfers; never change direct jobs or config files.
    if (bridgeUrl) gitEntries.push(["http.version", "HTTP/1.1"]);
    effective.GIT_CONFIG_COUNT = String(gitEntries.length);
    gitEntries.forEach(([key, value], i) => { effective[`GIT_CONFIG_KEY_${i}`] = key; effective[`GIT_CONFIG_VALUE_${i}`] = value; });
    delete effective.GIT_CONFIG_PARAMETERS; delete effective.GIT_SSL_NO_VERIFY;
    if (bridgeUrl) {
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
        "npm_config_proxy", "npm_config_https_proxy", "NPM_CONFIG_PROXY", "NPM_CONFIG_HTTPS_PROXY"]) effective[key] = bridgeUrl;
      for (const key of ["npm_config_noproxy", "NPM_CONFIG_NOPROXY", "npm_config_no_proxy", "NPM_CONFIG_NO_PROXY"]) effective[key] = noProxy;
      effective.npm_config_strict_ssl = effective.NPM_CONFIG_STRICT_SSL = "true";
      effective.NODE_TLS_REJECT_UNAUTHORIZED = "1";
      effective.GIT_CONFIG_NOSYSTEM = "1";
      effective.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
      effective.GIT_ALLOW_PROTOCOL = "http:https:file"; // SSH/git:// do not obey HTTP proxy environment.
    }
    return effective;
  }

  async function withEnvironment(baseEnv, callback, { scope = "updates", signal, onEvent: localEvent } = {}) {
    if (!["updates", "initialization"].includes(scope)) throw proxyError("NP_SCOPE", "Proxy contexts support updates/initialization only");
    if (typeof callback !== "function") throw proxyError("NP_CALLBACK", "A job callback is required");
    if (signal?.aborted) throw aborted();
    const state = load();
    baseEnv = { ...(baseEnv ?? defaults) };
    let bridge, transport;
    try {
      if (state?.enabled) {
        inspectEnvironment(baseEnv);
        transport = createTransport({ ...state, noProxy: environment(baseEnv, state, null).NO_PROXY }, { signal, onEvent: events(localEvent) });
        await transport.probe(); // Unreachable upstream is nonfatal; authentication/TLS still fail closed.
        bridge = await createBridge(transport, { signal });
      }
      if (signal?.aborted) throw aborted();
      let active = true;
      const prepareEnvironment = nextBaseEnv => {
        if (!active || signal?.aborted) throw aborted();
        const next = { ...nextBaseEnv };
        if (bridge) inspectEnvironment(next);
        return environment(next, state, bridge?.url);
      };
      const effectiveEnv = prepareEnvironment(baseEnv); // Recheck after potentially slow upstream preflight.
      const metadata = Object.freeze({ scope, mode: bridge ? "proxy" : "direct",
        reason: bridge ? "enabled" : state ? "disabled" : "not-configured", proxy: Object.freeze(publicState(state)),
        bridgeUrl: bridge?.url || null, configFile, dotenvPolicy: bridge ? "reject-proxy-definitions" : "not-applied", signal,
        prepareEnvironment, diagnose: ({ signal: diagnosticSignal } = {}) => {
          if (!active || signal?.aborted) throw aborted();
          return diagnostic(state?.enabled ? state : null, {
            signal: signal && diagnosticSignal ? AbortSignal.any([signal, diagnosticSignal]) : signal || diagnosticSignal,
            onEvent: localEvent });
        } });
      try {
        const result = await callback(effectiveEnv, metadata);
        if (signal?.aborted) throw aborted();
        return result;
      } finally { active = false; }
    } finally {
      if (bridge) await bridge.close();
      transport?.close();
    }
  }

  async function openTelegramProxy(baseEnv, { signal } = {}) {
    if (signal?.aborted) throw aborted();
    const state = load();
    let effective = { ...baseEnv };
    if (!state?.enabled) return { env: effective, mode: "direct", close: async () => {} };
    inspectEnvironment(effective, { telegram: true });
    const transport = createTransport({ ...state, noProxy: environment(effective, state, null).NO_PROXY }, { signal, onEvent: events() });
    let bridge, closing;
    const close = () => closing ||= (async () => {
      try { await bridge?.close(); } finally { transport.close(); }
    })();
    try {
      bridge = await createBridge(transport, { signal });
      inspectEnvironment(effective, { telegram: true });
      effective = environment(effective, state, bridge.url);
      effective.TELEGRAM_PROXY = bridge.url;
      effective.HERMES_TELEGRAM_DISABLE_FALLBACK_IPS = "1";
      return { env: effective, mode: "proxy", close };
    } catch (error) { await close(); throw error; }
  }

  function bounded(value, fallback, max) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 1 || value > max) throw proxyError("NP_OPTIONS", "Invalid network time/size limit");
    return value;
  }
  async function runRequest(state, options, callback) {
    const timeoutMs = bounded(options.timeoutMs, 15000, 60000);
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const transport = createTransport(state, { signal: controller.signal, timeoutMs, onEvent: events() });
    try { return await callback(transport, controller.signal); }
    catch (error) {
      if (timedOut) throw proxyError("NP_TIMEOUT", "Network proxy operation timed out");
      if (controller.signal.aborted) throw aborted();
      throw error;
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); transport.close();
    }
  }
  async function test({ url, download = false, timeoutMs } = {}, { signal } = {}) {
    if (typeof download !== "boolean") throw proxyError("NP_OPTIONS", "download must be a boolean");
    const target = targetURL(url), state = load();
    if (!state) throw proxyError("NP_NOT_CONFIGURED", "Configure a proxy before testing it");
    return runRequest(state, { signal, timeoutMs }, async transport => {
      const result = await transport.request(target, { forceProxy: true, headers: { "user-agent": "fnos-hermes-network-proxy" },
        headersOnly: !download, truncate: true, maxBytes: 8 * 1024 * 1024 });
      if (result.statusCode < 200 || result.statusCode >= 300) throw proxyError("NP_HTTP_STATUS", `Proxy test target returned HTTP ${result.statusCode}; redirects are not followed by test()`);
      const durationMs = Math.max(0, result.timings.totalMs - result.timings.ttfbMs);
      return { ok: true, protocol: state.protocol, detectedProtocol: result.protocol, route: result.route,
        statusCode: result.statusCode, timings: result.timings,
        download: download ? { bytes: result.bytes, durationMs, bytesPerSecond: durationMs > 0 ? result.bytes * 1000 / durationMs : 0, limited: result.limited } : null };
    });
  }
  async function requestJson(url, options = {}) {
    const request = normalizeRequestOptions(options);
    const { method, body } = request;
    let target = targetURL(url);
    const state = load();
    const maxBytes = bounded(request.maxBytes, 2097152, 16 * 1024 * 1024);
    const maxRedirects = options.maxRedirects ?? (method === "POST" ? 0 : 5);
    if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) throw proxyError("NP_OPTIONS", "Invalid redirect limit");
    let headers = { accept: "application/json", "user-agent": "fnos-hermes-network-proxy", ...request.headers };
    return runRequest(state?.enabled ? state : null, options, async transport => {
      const start = performance.now();
      for (let redirect = 0; ; redirect++) {
        const result = await transport.request(target, { method, body, headers, maxBytes });
        if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
          // Never replay a POST (or silently rewrite it to GET), even with an explicit redirect budget.
          if (method === "POST") throw proxyError("NP_REDIRECT", "POST redirects are not followed");
          if (redirect >= maxRedirects || !result.headers.location) throw proxyError("NP_REDIRECT", "JSON request redirect limit or missing location");
          let next;
          try { next = targetURL(new URL(result.headers.location, target)); }
          catch { throw proxyError("NP_REDIRECT", "Invalid JSON request redirect destination"); }
          if (target.protocol === "https:" && next.protocol !== "https:") throw proxyError("NP_REDIRECT", "HTTPS downgrade redirect refused");
          if (next.origin !== target.origin) headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !/^(authorization|cookie|host)$/i.test(key)));
          target = next;
          continue;
        }
        if (result.statusCode < 200 || result.statusCode >= 300) throw proxyError("NP_HTTP_STATUS", `JSON request returned HTTP ${result.statusCode}`);
        try { return JSON.parse(result.body.toString("utf8")); }
        catch { throw proxyError("NP_JSON", `Response was not valid JSON (after ${Math.round(performance.now() - start)}ms)`); }
      }
    });
  }
  async function fetchResponse(url, options = {}) {
    const request = normalizeRequestOptions(options);
    let target = targetURL(url);
    const state = load();
    const maxBytes = bounded(options.maxBytes, 2 * 1024 * 1024, 16 * 1024 * 1024);
    const redirectMode = options.redirect ?? "follow";
    if (!["follow", "error", "manual"].includes(redirectMode)) throw proxyError("NP_OPTIONS", "Invalid redirect mode");
    const maxRedirects = options.maxRedirects ?? 5;
    if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) throw proxyError("NP_OPTIONS", "Invalid redirect limit");
    let headers = { "user-agent": "fnos-hermes-network-proxy", ...request.headers };
    return runRequest(state?.enabled ? state : null, options, async transport => {
      for (let redirect = 0; ; redirect++) {
        const result = await transport.request(target, { method: request.method, body: request.body, headers, maxBytes });
        if ([301, 302, 303, 307, 308].includes(result.statusCode) && redirectMode !== "manual") {
          if (redirectMode === "error" || request.method === "POST" || redirect >= maxRedirects || !result.headers.location) {
            throw proxyError("NP_REDIRECT", "Panel request redirect refused");
          }
          let next;
          try { next = targetURL(new URL(result.headers.location, target)); }
          catch { throw proxyError("NP_REDIRECT", "Invalid panel redirect destination"); }
          if (target.protocol === "https:" && next.protocol !== "https:") throw proxyError("NP_REDIRECT", "HTTPS downgrade redirect refused");
          if (next.origin !== target.origin) headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !/^(authorization|cookie|host|x-api-key)$/i.test(key)));
          target = next;
          continue;
        }
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(result.headers)) {
          if (/^(connection|transfer-encoding|proxy-authenticate|proxy-authorization)$/i.test(key)) continue;
          for (const entry of Array.isArray(value) ? value : [value]) if (entry !== undefined) responseHeaders.append(key, entry);
        }
        let body = result.body;
        const encoding = responseHeaders.get("content-encoding")?.toLowerCase();
        const decode = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[encoding];
        if (encoding && encoding !== "identity") {
          if (!decode) throw proxyError("NP_RESPONSE", "Unsupported response encoding");
          try { body = decode(body, { maxOutputLength: maxBytes }); }
          catch { throw proxyError("NP_BODY_LIMIT", "Compressed response is invalid or exceeds size limit"); }
          responseHeaders.delete("content-encoding");
          responseHeaders.delete("content-length");
        }
        return new Response([204, 205, 304].includes(result.statusCode) ? null : body,
          { status: result.statusCode, headers: responseHeaders });
      }
    });
  }
  return Object.freeze({ status, save, setEnabled, test, diagnose, withEnvironment, requestJson, fetch: fetchResponse, openTelegramProxy });
}
