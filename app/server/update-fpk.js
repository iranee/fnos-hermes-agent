// FPK 版本信息查询模块（手动下载模式）
//
// 历史说明：本模块曾提供 FPK 小版本自动升级全链路
// （downloadFPK → stopServices → installFPK → restartServices 的 doUpgrade）。
// 该自动升级链路已整体移除，应用更新改为"用户手动下载 FPK + fnOS 应用中心安装"。
// 本模块现在只负责：
//   1. compareVersions        —— 版本号比较
//   2. checkLatestVersion     —— 查询 GitHub Releases 最新版本（含 html_url / assets）
//   3. pickFpkDownloadUrl     —— 从 release assets 中提取 .fpk 下载直链
//   4. createUpdateChecker    —— 带缓存的版本检查器（/api/update/check 使用）
// 不再执行下载到磁盘、解压覆盖、停服/重启等任何操作。

/**
 * 逐段数字比较版本号，"." 与 "-" 均视为段分隔（支持 0.20.27-3 后缀段）。
 * 返回 1（a>b）/ -1（a<b）/ 0（相等），缺段按 0 补齐，非数字段按字符串比较。
 */
export function compareVersions(a, b) {
  const segs = (v) => String(v || "").trim().replace(/^v/i, "").split(/[.\-]/);
  const sa = segs(a), sb = segs(b);
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const x = sa[i] ?? "0", y = sb[i] ?? "0";
    const nx = Number(x), ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx > ny ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/**
 * 从 GitHub release 的 assets 列表中提取 .fpk 安装包下载直链。
 * 优先本机架构的 _x86_64/_arm64 包（也认旧发布的 _amd64）。其次不带架构后缀的旧包（no_trimcli 优先），
 * 只有其他架构的包时返回 ""，避免把不可安装的包当作下载链接。
 * @param {Array} assets GitHub release assets
 * @param {string} arch Node process.arch
 * @returns {string} browser_download_url，找不到时返回 ""
 */
export function pickFpkDownloadUrl(assets, arch = process.arch) {
  if (!Array.isArray(assets)) return "";
  const fpks = assets.filter(a => /\.fpk$/i.test(a?.name || "") && a.browser_download_url);
  const archOf = a => {
    const suffix = /_(x86_64|amd64|arm64)\.fpk$/i.exec(a.name)?.[1].toLowerCase() || "";
    return suffix === "amd64" ? "x86_64" : suffix;
  };
  const wanted = { x64: "x86_64", arm64: "arm64" }[arch];
  const native = wanted && fpks.find(a => archOf(a) === wanted);
  if (native) return native.browser_download_url;
  const generic = fpks.filter(a => !archOf(a));
  const pick = generic.find(a => /[_-]no[-_]trimcli\.fpk$/i.test(a.name)) || generic[0];
  return pick?.browser_download_url || "";
}

function githubResponseError(response) {
  const numericHeader = name => {
    const value = response.headers.get(name);
    return value !== null && /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  };
  const rateLimit = {};
  for (const name of ["limit", "remaining", "reset"]) {
    const value = numericHeader(`x-ratelimit-${name}`);
    if (value !== null) rateLimit[name] = value;
  }
  const retryAfter = numericHeader("retry-after");
  const rateLimited = response.status === 429 || response.status === 403 && (rateLimit.remaining === 0 || retryAfter !== null);
  const reason = rateLimited ? "请求受限" : response.status === 401 ? "认证未通过"
    : response.status === 403 ? "请求被拒绝，不能仅凭 403 判定限流" : "请求失败";
  let message = `GitHub API ${response.status}：${reason}`;
  if (rateLimit.limit !== undefined) message += `；额度上限：${rateLimit.limit}`;
  if (rateLimit.remaining !== undefined) message += `；剩余：${rateLimit.remaining}`;
  if (retryAfter !== null) message += `；请在 ${retryAfter} 秒后重试`;
  return Object.assign(new Error(message), {
    upstreamStatus: response.status,
    rateLimited,
    ...(Object.keys(rateLimit).length ? { rateLimit } : {}),
    ...(retryAfter !== null ? { retryAfterSeconds: retryAfter } : {}),
  });
}

/**
 * 检查最新可用版本（只读查询，不触发任何下载/安装）
 */
async function githubToken(credentials) {
  if (!credentials) return null;
  let env = null;
  try { env = await credentials.environment({}, { signal: AbortSignal.timeout(15000) }); }
  catch { try { env = credentials.cachedEnvironment({}); } catch { env = null; } }
  const value = typeof env?.GITHUB_TOKEN === "string" ? env.GITHUB_TOKEN.trim() : "";
  return /^[\x21-\x7e]{1,4096}$/.test(value) ? value : null;
}

export async function checkLatestVersion(networkProxy, { credentials } = {}) {
  // 固定 stable 渠道（原 VERSION_MAP 渠道映射无实际消费方，已移除，
  // 响应中的 channel 字段保留以维持契约不变）
  const channel = "stable";
  let authenticated = false;

  try {
    if (typeof networkProxy?.fetch !== "function") throw new Error("网络组件未初始化，请检查统一代理配置");
    // 应用包发布仓库，可用 GITHUB_REPO 环境变量覆盖
    const GITHUB_REPO = process.env.GITHUB_REPO || "iranee/fnos-hermes-agent";
    const token = await githubToken(credentials);
    authenticated = token !== null;
    const GH_HEADERS = {
      "Accept": "application/vnd.github+json",
      "User-Agent": "fnos-hermes-agent"
    };
    // 只处理传输异常，不改写 HTTP 状态。两个端点始终使用同一实例。
    // 令牌失效（401）时匿名重试一次，不因 WebApp 中的旧令牌阻断查询。
    async function fetchRelease(url, options) {
      const send = headers => networkProxy.fetch(url, { ...options, headers });
      try {
        if (!authenticated) return await send(GH_HEADERS);
        const response = await send({ ...GH_HEADERS, Authorization: `Bearer ${token}` });
        if (response.status !== 401) return response;
        authenticated = false;
        return await send(GH_HEADERS);
      } catch { throw new Error("网络组件请求失败，请检查统一代理配置"); }
    }

    // 端点 1：releases 列表（按 published_at 取最新已发布）
    let latestRelease = null;
    let listError = null;
    try {
      const url = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`;
      const response = await fetchRelease(url, {
        method: "GET", timeoutMs: 15000,
        signal: AbortSignal.timeout(15000),
        headers: GH_HEADERS
      });

      if (!response.ok) {
        throw githubResponseError(response);
      }

      const releases = await response.json().catch(() => { throw new Error("GitHub API 返回格式异常"); });
      if (!Array.isArray(releases)) {
        throw new Error("GitHub API 返回格式异常");
      }

      // 按 published_at 排序，获取最新已发布的 release
      const published = releases.filter(r => !r.draft && r.published_at);
      published.sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
      latestRelease = published[0] || null;
    } catch (e) {
      if ([401, 403, 429].includes(e.upstreamStatus)) throw e;
      listError = e;
    }

    // 端点 2（兜底）：列表端点失败或无已发布 release 时，降级到 /releases/latest
    // （这一步查询也失败时，继续显示降级后的结果，不直接报错中断）
    if (!latestRelease) {
      try {
        const r2 = await fetchRelease(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
          method: "GET", timeoutMs: 15000,
          signal: AbortSignal.timeout(15000),
          headers: GH_HEADERS
        });
        if (r2.ok) {
          const data = await r2.json().catch(() => { throw new Error("GitHub API 返回格式异常"); });
          if (data && data.tag_name) latestRelease = data;
        } else if (r2.status !== 404) {
          throw githubResponseError(r2);
        }
      } catch (e2) {
        if (listError) throw listError; // 两个端点都失败，报首个错误
        throw e2;
      }
    }

    if (!latestRelease) {
      throw listError || new Error("没有找到已发布的版本");
    }

    const latestVersion = latestRelease.tag_name ? latestRelease.tag_name.replace(/^fnos-hermes-agent_v|^v/, "").trim() : "unknown";
    const assets = latestRelease.assets || [];

    return {
      ok: true,
      channel: channel,
      latest: latestVersion,
      tag_name: latestRelease.tag_name || "",
      html_url: latestRelease.html_url || "",
      download_url: pickFpkDownloadUrl(assets),
      body: latestRelease.body || "",
      published_at: latestRelease.published_at || "",
      assets: assets,
      fetched_at: new Date().toISOString(),
      authenticated
    };
  } catch (e) {
    return {
      ok: false,
      error: e.rateLimited && !authenticated ? `${e.message}（匿名查询；在 WebApp 设置 GitHub Token 后可提高额度）` : e.message,
      channel: channel,
      ...(e.upstreamStatus ? { authenticated } : {}),
      ...(e.upstreamStatus ? { upstreamStatus: e.upstreamStatus, rateLimited: e.rateLimited } : {}),
      ...(e.rateLimit ? { rateLimit: e.rateLimit } : {}),
      ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}),
    };
  }
}

/**
 * 创建应用包版本更新检查器（带缓存）
 * 缓存语义：仅成功结果缓存 5 分钟，失败结果不写缓存，
 * 下次请求立即重新查询（避免失败态被缓存 5 分钟导致前端持续拿到错误）。
 */
export function createUpdateChecker({ appDir, log, cacheFile, networkProxy, credentials, now = Date.now }) {
  let lastResult = null;
  let lastError = null;
  let cachedAt = 0;
  const CACHE_TTL = 5 * 60 * 1000; // 5 分钟（仅作用于成功结果）
  // 主动检测（force）每小时最多 5 次，防止反复点击耗尽 GitHub 匿名配额。只记在内存，Monitor 重启后重新计数。
  const FORCE_LIMIT = 5;
  const FORCE_WINDOW = 60 * 60 * 1000;
  const forcedAt = [];

  function forceQuota() {
    const cutoff = now() - FORCE_WINDOW;
    while (forcedAt.length && forcedAt[0] <= cutoff) forcedAt.shift();
    return { limit: FORCE_LIMIT, remaining: FORCE_LIMIT - forcedAt.length, resetAt: forcedAt.length ? forcedAt[0] + FORCE_WINDOW : null };
  }

  async function check({ force = false } = {}) {
    try {
      // Check cache：仅命中成功结果缓存，失败态不缓存、直接重新查询
      if (!force && cachedAt > 0 && (now() - cachedAt) < CACHE_TTL && lastResult && lastResult.ok) {
        return { ...lastResult, cached: true };
      }

      if (force) {
        if (forceQuota().remaining <= 0) {
          log(`[版本检查] 主动检测已达上限（每小时 ${FORCE_LIMIT} 次），本次不查询 GitHub`);
          if (lastResult && lastResult.ok) return { ...lastResult, cached: true, limited: true };
          return { ok: false, error: `主动检测已达上限（每小时 ${FORCE_LIMIT} 次），请稍后再试`, limited: true, cached: false };
        }
        forcedAt.push(now());
      }

      const result = await checkLatestVersion(networkProxy, { credentials });

      if (result.ok) {
        // 只有成功结果才写入缓存（lastResult/cachedAt）
        lastResult = result;
        lastError = null;
        cachedAt = now();
        log(`[版本检查] 应用包最新版本：v${result.latest}（${result.authenticated ? "认证" : "匿名"}查询）`);
      } else {
        lastError = result.error;
        log(`[版本检查] 失败：${result.error}`);
      }

      return { ...result, cached: false };
    } catch (e) {
      lastError = e.message;
      log(`[版本检查] 异常：${e.message}`);
      return { ok: false, error: e.message, cached: false };
    }
  }

  return { check, forceQuota, getLastResult: () => lastResult, getLastError: () => lastError, getLastCheckedAt: () => cachedAt || null };
}

// CLI mode：仅保留只读的版本检查（自动升级命令已移除）
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--check") {
    (async () => {
      // CLI 无 monitor 注入，必须明确指定现有目录。只读加载，绝不保存或启用代理。
      const { APP_DIR: appDir, DATA_DIR: dataDir } = process.env;
      const { isAbsolute } = await import("node:path");
      const { statSync } = await import("node:fs");
      try {
        if (!appDir || !dataDir || !isAbsolute(appDir) || !isAbsolute(dataDir)
            || !statSync(appDir).isDirectory() || !statSync(dataDir).isDirectory()) throw new Error();
      } catch {
        return { ok: false, error: "CLI 版本检查需要配置有效的 APP_DIR 和 DATA_DIR 绝对目录" };
      }
      try {
        const { createNetworkProxy } = await import("./network-proxy.js");
        const networkProxy = createNetworkProxy({ appDir, dataDir });
        const state = networkProxy.status();
        if (!state.configured || !state.enabled) return { ok: false, error: "CLI 版本检查需要已启用的统一代理" };
        return await checkLatestVersion(networkProxy);
      } catch {
        return { ok: false, error: "CLI 网络组件初始化失败，请检查统一代理配置" };
      }
    })().then(result => {
      if (result.ok) {
        console.log(`最新版本：v${result.latest}`);
        if (result.html_url) console.log(`发布页：${result.html_url}`);
        if (result.download_url) console.log(`FPK 下载：${result.download_url}`);
      } else {
        console.log("检查失败:", result.error);
      }
      process.exit(result.ok ? 0 : 1);
    });
  } else {
    console.log("用法:");
    console.log("  node update-fpk.js --check   # 检查最新版本（只读，不执行升级）");
    console.log("");
    console.log("说明：FPK 自动升级已移除，请从 GitHub Releases 手动下载 .fpk");
    console.log("      并在 fnOS 应用中心手动安装。");
  }
}
