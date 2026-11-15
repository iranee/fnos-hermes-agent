import { requestKernelControl } from "./kernel-control-socket.js";
import { targetURL, validHost, validateNoProxy } from "./network-proxy-transport.js";

const ROOT = "/api/network-proxy";
const MAX_INPUT = 16 * 1024;
const INPUT_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 30000;
const APPLY_TIMEOUT_MS = 120000;
const protocols = ["http", "https", "socks5", "socks5h"];
const fields = ["protocol", "host", "port", "username", "password", "noProxy"];
const timingFields = ["tcpMs", "proxyTlsMs", "tunnelMs", "tlsMs", "ttfbMs", "totalMs"];
const HELP = `用法：
  hermes fnos-proxy status
  hermes fnos-proxy configure --stdin
  hermes fnos-proxy enable
  hermes fnos-proxy disable
  hermes fnos-proxy test <url> [--download]
  hermes fnos-proxy --help

configure 仅接受标准输入中的 JSON 对象（最多 16 KiB，15 秒内结束输入）。
字段：protocol (http/https/socks5/socks5h)、host、port (整数 1–65535)、username、password、noProxy。
不接受命令行密码；省略 password 保留旧密码，空字符串清除密码。
保存保留当前启用状态，不等于启用；启停单独操作。status 无写入。
代理用于面板渠道扫码、模型列表/连接检测、版本查询、内核初始化/更新及 Telegram Bot；不改写模型配置和密钥。
保存或启停可能重启正在运行的网关，最多等待 120 秒；配置保存后重启失败会单独报告。
测试地址须为无凭据的 HTTP(S) URL；测试已保存代理，即使尚未启用。
--download 返回该 URL 的实际下载统计，不代表整网速度；请求最多等待 30 秒。
所有操作经运行中的应用私有 socket 协调，409 时等待任务完成，不自动重试。
本命令不是系统 VPN，也不替代官方 hermes proxy（OAuth 反向代理）。
`;
class CliError extends Error {
  constructor(message, exitCode = 2) { super(message); this.exitCode = exitCode; }
}
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const port = value => Number.isInteger(value) && value >= 1 && value <= 65535;
const credential = value => typeof value === "string" && !/[\x00-\x1f\x7f]/.test(value) && Buffer.byteLength(value) <= 255;
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

function readInput(input, timeoutMs) {
  if (input.isTTY) throw new CliError("configure 必须通过管道或输入重定向提供 JSON；不要在终端回显密码。");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > INPUT_TIMEOUT_MS) throw new CliError("输入超时设置无效。");
  return new Promise((resolve, reject) => {
    let size = 0, done = false;
    const chunks = [];
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.pause();
      input.removeListener("data", data);
      input.removeListener("end", end);
      input.removeListener("error", failed);
      input.removeListener("close", closed);
      if (error) reject(error); else resolve(Buffer.concat(chunks));
    };
    const data = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_INPUT) finish(new CliError("输入 JSON 超过 16 KiB，未发送配置。"));
      else chunks.push(bytes);
    };
    const end = () => finish();
    const failed = () => finish(new CliError("无法读取标准输入，未发送配置。"));
    const closed = () => finish(new CliError("标准输入提前关闭，未发送配置。"));
    const timer = setTimeout(() => finish(new CliError("标准输入超时，未发送配置。")), timeoutMs);
    input.on("data", data).once("end", end).once("error", failed).once("close", closed);
    if (input.readableEnded) end();
    else if (input.destroyed) closed();
  });
}
function configuration(bytes) {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!object(value) || !Object.keys(value).length || Object.keys(value).some(key => !fields.includes(key))) throw new Error();
    if (Object.hasOwn(value, "protocol") && !protocols.includes(value.protocol)) throw new Error();
    if (Object.hasOwn(value, "host")) validHost(value.host);
    if (Object.hasOwn(value, "port") && !port(value.port)) throw new Error();
    for (const key of ["username", "password"]) if (Object.hasOwn(value, key) && !credential(value[key])) throw new Error();
    if (value.username?.includes(":")) throw new Error();
    if (Object.hasOwn(value, "noProxy")) validateNoProxy(value.noProxy);
    return value;
  } catch {
    // JSON.parse errors may contain the raw password. Never forward their text.
    throw new CliError("输入必须为有效 UTF-8 JSON 对象，且仅含合法代理配置字段；启停请单独操作。");
  }
}
function testBody(args) {
  try {
    const value = args[1];
    if (typeof value !== "string" || !/^https?:\/\//i.test(value) || /[\s\x00-\x1f\x7f\\]/.test(value) ||
        /^https?:\/\/([^/?#]*)/i.exec(value)[1].includes("@")) throw new Error();
    targetURL(value);
    const body = { url: value, ...(args.length === 3 ? { download: true } : {}) };
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_INPUT) throw new Error();
    return body;
  } catch { throw new CliError("测试地址必须为无用户名、密码及空白字符的有效 HTTP(S) URL，且请求体不超过 16 KiB。"); }
}
function publicResult(value, testing) {
  // Allowlist and type-check output: never print unknown fields, error messages,
  // URLs, nested objects masquerading as public strings, or upstream diagnostics.
  try {
    if (!object(value) || typeof value.ok !== "boolean") throw new Error();
    if (!value.ok) return { ok: false };
    if (testing) {
      if (!protocols.includes(value.protocol) || !Number.isInteger(value.statusCode) || value.statusCode < 200 || value.statusCode >= 300 || !object(value.timings)) throw new Error();
      const timings = {};
      for (const key of timingFields) if (Object.hasOwn(value.timings, key)) {
        if (value.timings[key] !== null && !finite(value.timings[key])) throw new Error();
        timings[key] = value.timings[key];
      }
      if (!finite(timings.totalMs) || !finite(timings.ttfbMs)) throw new Error();
      let download = null;
      if (value.download !== null) {
        const d = value.download;
        if (!object(d) || !Number.isSafeInteger(d.bytes) || d.bytes < 0 || !finite(d.durationMs) || !finite(d.bytesPerSecond) || typeof d.limited !== "boolean") throw new Error();
        download = { bytes: d.bytes, durationMs: d.durationMs, bytesPerSecond: d.bytesPerSecond, limited: d.limited };
      }
      return { ok: true, protocol: value.protocol, statusCode: value.statusCode, timings, download };
    }
    if (typeof value.configured !== "boolean" || typeof value.enabled !== "boolean" || typeof value.passwordConfigured !== "boolean" ||
        !credential(value.username) || value.username.includes(":")) throw new Error();
    if (value.configured) {
      if (!protocols.includes(value.protocol) || !port(value.port)) throw new Error();
      validHost(value.host);
    } else if (value.protocol !== null || value.port !== null || value.host !== "" || value.enabled || value.passwordConfigured || value.username !== "") throw new Error();
    validateNoProxy(value.noProxy);
    const applied = {};
    for (const key of ["gateway_restarted", "gateway_restart_failed", "committed"]) if (Object.hasOwn(value, key)) {
      if (typeof value[key] !== "boolean") throw new Error();
      applied[key] = value[key];
    }
    return { ok: true, configured: value.configured, enabled: value.enabled, protocol: value.protocol,
      host: value.host, port: value.port, username: value.username, passwordConfigured: value.passwordConfigured, noProxy: value.noProxy, ...applied };
  } catch { throw new CliError("应用返回的代理结果无效，未显示原始响应；请查询状态核实。", 1); }
}
function safeError(error) {
  if (error instanceof CliError) return error.message;
  if (error?.statusCode === 409) return "HTTP 409：内核任务或代理操作忙，或配置存在冲突；等待任务完成并检查代理状态，不自动重试。";
  if (error?.code === "ETIMEDOUT" || error?.statusCode === 504) return "代理请求超时；结果可能尚未返回，请先查询状态，不自动重试或改为直连。";
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) {
    return `HTTP ${error.statusCode}：应用拒绝代理请求，请检查配置、应用状态或目标资源；未自动重试。`;
  }
  return "无法完成私有 socket 代理请求；请确认 fnOS 应用及监控器已启动、当前为应用用户，并查询状态核实；不会直接改文件或自动重试。";
}

export async function runKernelProxyCli(args, { varDir, input = process.stdin, output = process.stdout,
  errorOutput = process.stderr, request = requestKernelControl, inputTimeoutMs = INPUT_TIMEOUT_MS } = {}) {
  try {
    if (args.length === 1 && args[0] === "--help") { output.write(HELP); return 0; }
    let pathname = ROOT, method = "GET", body;
    if (args.length === 1 && args[0] === "status") {
      // Deliberately no stdin read, no local configuration access and no write.
    } else if (args.length === 2 && args[0] === "configure" && args[1] === "--stdin") {
      body = configuration(await readInput(input, inputTimeoutMs)); method = "PATCH";
    } else if (args.length === 1 && ["enable", "disable"].includes(args[0])) {
      pathname += "/enabled"; method = "POST"; body = { enabled: args[0] === "enable" };
    } else if (args[0] === "test" && (args.length === 2 || (args.length === 3 && args[2] === "--download"))) {
      pathname += "/test"; method = "POST"; body = testBody(args);
    } else throw new CliError("参数无效；请运行 hermes fnos-proxy --help。配置只接受 configure --stdin，密码不得放入命令行。");
    const timeoutMs = method !== "GET" && args[0] !== "test" ? APPLY_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    const value = publicResult(await request({ varDir, pathname, method, body, timeoutMs }), args[0] === "test");
    output.write(`${JSON.stringify(value, null, 2)}\n`);
    if (value.gateway_restart_failed) {
      errorOutput.write("hermes fnos-proxy: 代理配置已保存，但网关尚未应用；请查询状态并手动重启网关，不自动重试配置。\n");
      return 1;
    }
    if (!value.ok) { errorOutput.write("hermes fnos-proxy: 代理操作失败，请检查状态；未自动重试或改为直连。\n"); return 1; }
    return 0;
  } catch (error) {
    errorOutput.write(`hermes fnos-proxy: ${safeError(error)}\n`);
    return error instanceof CliError ? error.exitCode : 1;
  }
}
