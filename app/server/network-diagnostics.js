import net from "node:net";
import { createTransport, targetURL, aborted, proxyError, validHost } from "./network-proxy-transport.js";

// Domestic/overseas describe the target service, NOT a claim about exit-IP geography.
// Small HTTPS samples avoid GitHub API quotas. A trace response is a sample, not line capacity.
const POINTS = Object.freeze({
  domestic: Object.freeze({ url: "https://myip.ipip.net/", ipFormat: "ipip" }),
  overseas: Object.freeze({ url: "https://www.cloudflare.com/cdn-cgi/trace", ipFormat: "trace" })
});
const CODES = new Set(["ABORT_ERR", "NP_TIMEOUT", "NP_PROXY_AUTH", "NP_CONNECT", "NP_TLS", "NP_AUTO_PROTOCOL",
  "NP_HTTP_STATUS", "NP_HANDSHAKE", "NP_CLOSED", "NP_RESPONSE", "NP_BODY_LIMIT", "NP_NETWORK_ERROR",
  ...["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE",
    "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID"].map(code => `NP_${code}`)]);
export function diagnosticError(error) {
  return { code: CODES.has(error?.code) ? error.code : "NP_NETWORK_ERROR" };
}
function exitAddress(body, format) {
  const text = body.toString("utf8");
  const matches = format === "trace" ? [...text.matchAll(/^ip=([^\r\n]+)$/gm)].map(m => m[1])
    : format === "ipip" ? [...text.matchAll(/当前\s*IP[：:]\s*([\da-fA-F:.]+)/g)].map(m => m[1]) : [];
  return matches.length === 1 && net.isIP(matches[0]) ? matches[0] : null;
}

/** Module-only fixture injection; never accept targets, CA or limits from the HTTP API. */
export function createNetworkDiagnostics({ points = POINTS, timeoutMs = 8000, maxBytes = 256 * 1024,
  transportFactory = createTransport } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000 ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw proxyError("NP_OPTIONS", "Invalid diagnostic limits");
  const targets = Object.fromEntries(["domestic", "overseas"].map(name => {
    const url = targetURL(points[name]?.url);
    if (url.protocol !== "https:") throw proxyError("NP_OPTIONS", "Diagnostic targets require HTTPS");
    return [name, { url, ipFormat: points[name].ipFormat }];
  }));
  return async function diagnose(config, { signal, onEvent = () => {} } = {}) {
    if (signal?.aborted) throw aborted();
    const checkedAt = new Date().toISOString(), route = config ? "proxy" : "direct";
    async function measure(name) {
      const { url, ipFormat } = targets[name], controller = new AbortController();
      let timedOut = false;
      const cancel = () => controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
      const transport = transportFactory(config, { signal: controller.signal, timeoutMs, fallback: false, onEvent });
      const point = { ok: false, route, source: url.hostname, detectedProtocol: null,
        timings: { connectMs: null, tcpMs: null, proxyTlsMs: null, tunnelMs: null, tlsMs: null, ttfbMs: null, totalMs: null },
        download: null, exitIp: null, exitIpReason: "measurement-failed", error: null };
      try {
        const result = await transport.request(url, { forceProxy: Boolean(config), truncate: true, maxBytes });
        point.detectedProtocol = result.protocol;
        point.timings = result.timings;
        if (result.statusCode < 200 || result.statusCode >= 300) {
          point.error = { code: "NP_HTTP_STATUS", statusCode: result.statusCode };
          return point;
        }
        const durationMs = Math.max(0, result.timings.totalMs - result.timings.ttfbMs);
        point.download = { bytes: result.bytes, durationMs,
          bytesPerSecond: durationMs > 0 ? result.bytes * 1000 / durationMs : 0, limited: result.limited };
        point.exitIp = result.limited ? null : exitAddress(result.body, ipFormat);
        point.exitIpReason = point.exitIp ? null : result.limited ? "response-limited" : "no-reliable-ip-in-response";
        point.ok = true;
      } catch (error) {
        if (signal?.aborted) throw aborted();
        point.detectedProtocol = transport.detectedProtocol;
        point.error = diagnosticError(timedOut ? { code: "NP_TIMEOUT" } : error);
      } finally {
        clearTimeout(timer); signal?.removeEventListener("abort", cancel); transport.close();
      }
      return point;
    }
    const [domestic, overseas] = await Promise.all([measure("domestic"), measure("overseas")]);
    if (signal?.aborted) throw aborted();
    const detected = [...new Set([domestic.detectedProtocol, overseas.detectedProtocol].filter(Boolean))];
    return { ok: domestic.ok && overseas.ok, protocol: config?.protocol || null,
      detectedProtocol: detected.length === 1 ? detected[0] : null, route, checkedAt,
      sampleThroughput: true, domestic, overseas };
  };
}
// Defence in depth for API/job consumers of an injected implementation.
export function publicDiagnosis(value = {}) {
  const protocol = value => ["auto", "http", "https", "socks5", "socks5h"].includes(value) ? value : null;
  const route = value => ["proxy", "direct", "direct-fallback"].includes(value) ? value : null;
  const numbers = (value, fields) => Object.fromEntries(fields.map(key => [key,
    typeof value?.[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0 ? value[key] : null]));
  const point = (value = {}) => {
    let source = null;
    try { source = validHost(value.source); } catch { /* Do not relay URLs/paths. */ }
    return { ok: value.ok === true, route: route(value.route), source, detectedProtocol: protocol(value.detectedProtocol),
      timings: numbers(value.timings, ["connectMs", "tcpMs", "proxyTlsMs", "tunnelMs", "tlsMs", "ttfbMs", "totalMs"]),
      download: value.download ? { ...numbers(value.download, ["bytes", "durationMs", "bytesPerSecond"]), limited: value.download.limited === true } : null,
      exitIp: typeof value.exitIp === "string" && net.isIP(value.exitIp) ? value.exitIp : null,
      exitIpReason: ["measurement-failed", "response-limited", "no-reliable-ip-in-response"].includes(value.exitIpReason) ? value.exitIpReason : null,
      error: value.error ? { ...diagnosticError(value.error),
        ...(Number.isInteger(value.error.statusCode) && value.error.statusCode >= 100 && value.error.statusCode <= 599 ? { statusCode: value.error.statusCode } : {}) } : null };
  };
  const domestic = point(value.domestic), overseas = point(value.overseas);
  return { ok: domestic.ok && overseas.ok, protocol: protocol(value.protocol), detectedProtocol: protocol(value.detectedProtocol),
    route: route(value.route), checkedAt: typeof value.checkedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.checkedAt) ? value.checkedAt : null,
    sampleThroughput: true, domestic, overseas };
}
export const diagnoseNetwork = createNetworkDiagnostics();
