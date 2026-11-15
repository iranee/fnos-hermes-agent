import { createHash } from "node:crypto";
import { createWebappProxy } from "./webapp-proxy.js";

const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const ASSET_READ_TIMEOUT = 5_000;
const FULL_RESPONSE_HEADERS = [
  "range", "if-range", "if-match", "if-none-match", "if-modified-since", "if-unmodified-since",
];
const STALE_RESPONSE_HEADERS = [
  "content-encoding", "etag", "last-modified", "content-range", "accept-ranges",
];
const ASSETS = new Map([
  ["/assets/react-vendor-R7IuHd60.js", {
    sha256: "cdb332764bc3282c68acb0ee4585c25733cb3cf9823830eca52ef42e38253f6e",
    original: "rn=function(e){return`/`+e}",
    replacement: (prefix) => `rn=function(e){return ${JSON.stringify(`${prefix}/`)}+e}`,
  }],
  ["/assets/ModelsPage-NNlv7_nv.js", {
    sha256: "5ee3bd4fd785c9c17c91f72316e86b73469a0b690efabdb7d8c5e3f158b91cd7",
    original: "href:`/config`",
    replacement: (prefix) => `href:${JSON.stringify(`${prefix}/config`)}`,
  }],
  ["/assets/AnalyticsPage-BNIbhYms.js", {
    sha256: "bd665829cdc646f63dfa0c9d6e3b0f95082521891f63cb9fade53f24ed25a845",
    original: "href:`/config`",
    replacement: (prefix) => `href:${JSON.stringify(`${prefix}/config`)}`,
  }],
]);

// 上游未保存语言时默认英文；手机宽度下语言按钮的文字被 `hidden sm:inline` 隐藏，按钮变成空白。
// 只在用户没选过语言时写入中文，已保存的选择不动。
const UI_FIX_MARK = "data-fnos-dashboard-ui";
const UI_FIX = `<script ${UI_FIX_MARK}>try{if(!localStorage.getItem("hermes-locale"))` +
  `localStorage.setItem("hermes-locale","zh")}catch(e){}</script>` +
  `<style ${UI_FIX_MARK}>@media (max-width:639.98px){#app-sidebar button[aria-haspopup="listbox"]` +
  `:not(:has(svg)) .hidden{display:inline!important}}@supports not selector(:has(*)){` +
  `@media (max-width:639.98px){#app-sidebar button[aria-haspopup="listbox"] .hidden{display:inline!important}}}</style>`;

function injectUiFix(html) {
  if (html.includes(UI_FIX_MARK)) return html;
  let at = html.search(/<script\b[^>]*\btype\s*=\s*["']?module\b/i);
  if (at < 0) at = html.search(/<\/head\s*>/i);
  return at < 0 ? UI_FIX + html : html.slice(0, at) + UI_FIX + html.slice(at);
}

function failure(head) {
  const message = "Dashboard asset compatibility check failed";
  return new Response(head ? null : message, {
    status: 502,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(Buffer.byteLength(message)),
      "cache-control": "no-store",
    },
  });
}

async function readAsset(response, signal) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let timer;
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(new Error("Dashboard asset read aborted"));
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => reject(new Error("Dashboard asset read timeout")), ASSET_READ_TIMEOUT);
    timer.unref();
    if (signal.aborted) abort();
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), stopped]);
      if (signal.aborted) throw new Error("Dashboard asset read aborted");
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > MAX_ASSET_BYTES) throw new Error("Dashboard asset size limit");
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    // 取消时直接销毁传输流，绝不等待停滞的对端来取消。
    reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/**
 * 仅对三个固定的官方 Dashboard 资源做 URL 兼容。路由、鉴权和 WebSocket 行为
 * 仍完全由未改动的传输层负责。不改磁盘上的任何资源，也不引入根级资源别名。
 */
export function createDashboardProxy(options) {
  const proxy = createWebappProxy({ ...options, surface: "dashboard" });
  const prefix = `${options.basePath.replace(/\/$/, "")}/dashboard`;
  const assets = new Map([...ASSETS].map(([path, asset]) => [prefix + path, asset]));

  async function patchPage(req) {
    const response = await proxy.handleHttp(req);
    const type = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    const encoding = (response.headers.get("content-encoding") || "").trim().toLowerCase();
    if (response.status !== 200 || type !== "text/html" || !response.body ||
        (encoding && encoding !== "identity") || response.headers.has("content-security-policy") ||
        Number(response.headers.get("content-length")) > MAX_ASSET_BYTES) return response;
    let bytes;
    try { bytes = await readAsset(response, req.signal); }
    catch { return failure(false); }
    const patched = Buffer.from(injectUiFix(bytes.toString("utf8")));
    const headers = new Headers(response.headers);
    for (const name of STALE_RESPONSE_HEADERS) headers.delete(name);
    headers.set("content-length", String(patched.length));
    headers.set("cache-control", "no-store");
    return new Response(patched, { status: 200, statusText: response.statusText, headers });
  }

  async function handleHttp(req) {
    const asset = assets.get(new URL(req.url).pathname);
    if (!asset && req.method === "GET") return patchPage(req);
    if (!asset || !["GET", "HEAD"].includes(req.method)) return proxy.handleHttp(req);

    const head = req.method === "HEAD";
    const headers = new Headers(req.headers);
    headers.set("accept-encoding", "identity");
    for (const name of FULL_RESPONSE_HEADERS) headers.delete(name);
    // 克隆 Request 会保留已中止的信号和后续中止。
    // 传输层在向上游转发任何字节前仍会对该请求鉴权。
    const response = await proxy.handleHttp(new Request(req, {
      method: "GET", headers, signal: req.signal,
    }));
    if (response.status !== 200) {
      if (!head) return response;
      response.body?.cancel().catch(() => {});
      return new Response(null, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    }

    const type = (response.headers.get("content-type") || "").split(";", 1)[0].trim();
    const encoding = (response.headers.get("content-encoding") || "").trim().toLowerCase();
    if (!/^(?:application|text)\/(?:javascript|ecmascript|x-javascript)$/i.test(type) ||
        (encoding && encoding !== "identity") || !response.body ||
        Number(response.headers.get("content-length")) > MAX_ASSET_BYTES) {
      response.body?.cancel().catch(() => {});
      return failure(head);
    }

    let bytes;
    try { bytes = await readAsset(response, req.signal); }
    catch { return failure(head); }
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) return failure(head);
    const original = Buffer.from(asset.original);
    const index = bytes.indexOf(original);
    if (index < 0 || bytes.indexOf(original, index + 1) !== -1) return failure(head);
    // 按字节拼接，避免对无关的官方源码字节做解码/重编码。
    const patched = Buffer.concat([
      bytes.subarray(0, index), Buffer.from(asset.replacement(prefix)),
      bytes.subarray(index + original.length),
    ]);
    const patchedHeaders = new Headers(response.headers);
    for (const name of STALE_RESPONSE_HEADERS) patchedHeaders.delete(name);
    patchedHeaders.set("content-length", String(patched.length));
    patchedHeaders.set("cache-control", "no-store");
    return new Response(head ? null : patched, {
      status: response.status, statusText: response.statusText, headers: patchedHeaders,
    });
  }

  return { ...proxy, handleHttp };
}
