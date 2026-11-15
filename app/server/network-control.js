import { validHost, validateNoProxy, targetURL, networkEvent } from "./network-proxy-transport.js";
import { publicDiagnosis } from "./network-diagnostics.js";

const ROOT = "/api/network-proxy";
const routes = new Map([[ROOT, ["GET", "PATCH"]], [`${ROOT}/enabled`, ["POST"]], [`${ROOT}/test`, ["POST"]], [`${ROOT}/diagnose`, ["POST"]]]);
const fields = ["protocol", "host", "port", "username", "password", "noProxy"];
const statusFields = ["configured", "enabled", "protocol", "host", "port", "username", "passwordConfigured", "noProxy"];
const timingFields = ["connectMs", "tcpMs", "proxyTlsMs", "tunnelMs", "tlsMs", "ttfbMs", "totalMs"];
const MAX_BODY = 16 * 1024;
const errors = new Map([
  ["NP_CONFIG", [400, "代理配置无效，请检查字段；启停须单独操作"]],
  ["NP_PROTOCOL", [400, "代理协议仅支持 auto、HTTP、HTTPS、SOCKS5、SOCKS5h"]],
  ["NP_AUTO_PROTOCOL", [502, "未能通过目标握手识别代理协议，请检查代理地址和协议"]],
  ["NP_INVALID_HOST", [400, "代理地址无效，请填写主机名或 IP，不含协议和路径"]],
  ["NP_INVALID_PORT", [400, "代理端口必须为 1–65535 的整数"]],
  ["NP_CREDENTIALS", [400, "用户名或密码无效：不允许控制字符，最多 255 字节；密码需要用户名"]],
  ["NP_INVALID_NO_PROXY", [400, "NO_PROXY 无效，请使用逗号分隔的主机列表"]],
  ["NP_INVALID_URL", [400, "测试地址必须为不含用户名和密码的 HTTP(S) URL"]],
  ["NP_NOT_CONFIGURED", [409, "请先保存代理配置"]],
  ["NP_OPTIONS", [400, "测速参数无效"]],
  ["NP_DOTENV_CONFLICT", [409, "环境文件存在代理覆盖配置，请检查后再启用"]],
  ["NP_GIT_CONFIG_CONFLICT", [409, "Git 配置存在代理或 TLS 覆盖，请检查后再启用"]],
  ["NP_TELEGRAM_ENV", [409, "Telegram 独立代理或 NO_PROXY 与统一代理冲突，请检查环境配置；原文件未改动"]],
  ["NP_SYMLINK", [503, "代理存储路径包含符号链接，已拒绝访问"]],
  ["NP_PATH", [503, "代理存储路径不可安全访问"]],
  ["NP_PATH_CHANGED", [503, "代理存储路径发生变化，请检查后重试"]],
  ["NP_STORAGE", [503, "无法安全读取或保存代理配置"]],
  ["NP_TIMEOUT", [504, "代理测试超时，请检查代理和目标资源"]],
  ["ABORT_ERR", [408, "代理测试请求已中断，未中断内核任务"]],
  ["NP_PROXY_AUTH", [502, "代理认证失败，请检查用户名和密码"]],
  ["NP_HTTP_STATUS", [502, "测试目标返回非 2xx 状态；测试不会跟随重定向"]],
  ["NP_CONNECT", [502, "代理拒绝建立目标连接"]],
  ["NP_TLS", [502, "TLS 证书验证失败"]],
]);
for (const code of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH",
  "ENETUNREACH", "EPIPE", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID",
  "NETWORK_ERROR", "CLOSED", "HANDSHAKE", "RESPONSE"]) {
  errors.set(`NP_${code}`, [502, `代理连接失败（${code}），请检查代理和目标资源`]);
}
function normalizePath(path) { return path.replace(/^\/app\/[^/]+(?=\/|$)/, "").replace(/\/+$/, "") || "/"; }
function pick(value, keys) { return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])); }
function invalid(code = "NP_CONFIG") { throw Object.assign(new Error("Invalid network request"), { code }); }
function validate(body, path) {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid();
  const keys = Object.keys(body);
  if (path === ROOT) {
    if (!keys.length || keys.some(key => !fields.includes(key))) invalid();
    if (Object.hasOwn(body, "protocol") && !["auto", "http", "https", "socks5", "socks5h"].includes(body.protocol)) invalid("NP_PROTOCOL");
    if (Object.hasOwn(body, "host")) validHost(body.host);
    if (Object.hasOwn(body, "port") && (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535)) invalid("NP_INVALID_PORT");
    for (const key of ["username", "password"]) if (Object.hasOwn(body, key)) {
      if (typeof body[key] !== "string" || /[\x00-\x1f\x7f]/.test(body[key]) || Buffer.byteLength(body[key]) > 255 ||
          (key === "username" && body[key].includes(":"))) invalid("NP_CREDENTIALS");
    }
    if (Object.hasOwn(body, "noProxy")) validateNoProxy(body.noProxy);
  } else if (path.endsWith("/enabled")) {
    if (keys.length !== 1 || typeof body.enabled !== "boolean") invalid();
  } else if (path.endsWith("/diagnose")) {
    if (keys.length) invalid("NP_OPTIONS");
  } else {
    if (keys.some(key => !["url", "download"].includes(key)) || typeof body.url !== "string" || !body.url.trim()) invalid("NP_OPTIONS");
    targetURL(body.url);
    if (Object.hasOwn(body, "download") && typeof body.download !== "boolean") invalid("NP_OPTIONS");
  }
}

// Authentication/admin checks remain the monitor's responsibility. This module never changes a running job.
export function createNetworkControl({ networkProxy, busy, onChanged }) {
  const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
  const conflict = () => json({ ok: false, error: "内核任务或代理操作正在进行，请等待完成后重试", code: "NP_BUSY" }, 409);
  let operating = false;
  async function handle(req) {
    const path = normalizePath(new URL(req.url).pathname), methods = routes.get(path);
    if (!methods) return null;
    if (!methods.includes(req.method)) return json({ ok: false, error: "不支持此请求方法" }, 405, { allow: methods.join(", ") });
    try {
      if (req.method === "GET") {
        if (req.body) return json({ ok: false, error: "状态查询不接受请求体" }, 400);
        const status = await networkProxy.status();
        return json({ ok: true, ...pick(status, statusFields),
          ...(Object.hasOwn(status, "recentRoute") ? { recentRoute: networkEvent(status.recentRoute) } : {}) });
      }
      if (busy() || operating) return conflict();
      const length = req.headers.get("content-length");
      if (length !== null && !/^\d+$/.test(length)) return json({ ok: false, error: "请求体长度无效" }, 400);
      if (length !== null && Number(length) > MAX_BODY) return json({ ok: false, error: "请求体不能超过 16 KiB" }, 413);
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers.get("content-type") || "")) return json({ ok: false, error: "请使用 application/json 请求体" }, 415);
      const reader = req.body?.getReader(), chunks = [];
      let size = 0;
      if (reader) {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY) {
              await reader.cancel();
              return json({ ok: false, error: "请求体不能超过 16 KiB" }, 413);
            }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
      }
      let body;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { return json({ ok: false, error: "请求体必须为有效 JSON 对象" }, 400); }
      validate(body, path);
      // Body streaming yields: recheck immediately before invoking any side effect.
      if (busy() || operating) return conflict();
      if (req.signal?.aborted) invalid("ABORT_ERR");
      operating = true;
      try {
        if (path.endsWith("/diagnose")) {
          return json(publicDiagnosis(await networkProxy.diagnose({ signal: req.signal })));
        }
        if (path.endsWith("/test")) {
          const result = await networkProxy.test(body, { signal: req.signal });
          return json({ ...pick(result, ["ok", "protocol", "detectedProtocol", "route", "statusCode"]), timings: pick(result.timings, timingFields),
            download: result.download ? pick(result.download, ["bytes", "durationMs", "bytesPerSecond", "limited"]) : null });
        }
        const status = path === ROOT ? await networkProxy.save(body, { signal: req.signal }) : await networkProxy.setEnabled(body.enabled);
        let gateway = {};
        if (onChanged) {
          try { gateway = pick(await onChanged(status), ["gateway_restarted"]); }
          catch { gateway = { gateway_restart_failed: true, committed: true,
            warning: "代理配置已保存，面板请求已应用；网关重启失败，请检查服务状态后手动重启网关" }; }
        }
        return json({ ok: true, ...pick(status, statusFields), ...gateway });
      } finally { operating = false; }
    } catch (error) {
      // Never relay exception messages, JSON source, URLs, paths, causes or credentials.
      const known = errors.get(error?.code);
      return json({ ok: false, code: known ? error.code : "NP_CONTROL", error: known ? known[1] : "代理操作失败，请检查配置或连接后重试",
        ...(error?.committed === true ? { committed: true } : {}) }, error?.committed === true ? 503 : known ? known[0] : 503);
    }
  }
  return { handle, matches: path => routes.has(normalizePath(path)) };
}
