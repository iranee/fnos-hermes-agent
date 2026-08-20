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
// 不再执行任何下载落盘、解压覆盖、停服/重启操作。

/**
 * 逐段数字比较版本号，"." 与 "-" 均视为段分隔（支持 0.20.27-3 后缀段）。
 * 返回 1（a>b）/ -1（a<b）/ 0（相等）；缺段按 0 补齐；非数字段按字符串比较。
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
 * 优先匹配 no_trimcli 版本（兼容 _no_trimcli 与 _no-trimcli 两种产物命名），其次任意 .fpk 资产。
 * @param {Array} assets GitHub release assets
 * @returns {string} browser_download_url，找不到时返回 ""
 */
export function pickFpkDownloadUrl(assets) {
  if (!Array.isArray(assets)) return "";
  const noTrimCli = assets.find(a => /[_-]no[-_]trimcli\.fpk$/i.test(a.name || ""));
  if (noTrimCli && noTrimCli.browser_download_url) return noTrimCli.browser_download_url;
  const anyFpk = assets.find(a => /\.fpk$/i.test(a.name || ""));
  return (anyFpk && anyFpk.browser_download_url) || "";
}

/**
 * 检查最新可用版本（只读查询，不触发任何下载/安装）
 */
export async function checkLatestVersion() {
  // 固定 stable 渠道（原 VERSION_MAP 渠道映射无实际消费方，已移除；
  // 响应中的 channel 字段保留以维持契约不变）
  const channel = "stable";

  try {
    // 使用正确的仓库地址：iranee/fnos-hermes-agent（你的项目）
    const GITHUB_REPO = process.env.GITHUB_REPO || "iranee/fnos-hermes-agent";
    const GH_HEADERS = {
      "Accept": "application/vnd.github+json",
      "User-Agent": "fnos-hermes-agent"
    };

    // 端点 1：releases 列表（按 published_at 取最新已发布）
    let latestRelease = null;
    let listError = null;
    try {
      const url = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: GH_HEADERS
      });

      if (!response.ok) {
        throw new Error(`GitHub API ${response.status}`);
      }

      const releases = await response.json();
      if (!Array.isArray(releases)) {
        throw new Error("GitHub API 返回格式异常");
      }

      // 按 published_at 排序，获取最新已发布的 release
      const published = releases.filter(r => !r.draft && r.published_at);
      published.sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
      latestRelease = published[0] || null;
    } catch (e) {
      listError = e;
    }

    // 端点 2（兜底）：列表端点失败或无已发布 release 时，降级到 /releases/latest
    // （参考基线失败降级策略：保留降级展示，不硬失败）
    if (!latestRelease) {
      try {
        const r2 = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
          signal: AbortSignal.timeout(15000),
          headers: GH_HEADERS
        });
        if (r2.ok) {
          const data = await r2.json();
          if (data && data.tag_name) latestRelease = data;
        } else if (r2.status !== 404) {
          throw new Error(`GitHub API ${r2.status}`);
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
      fetched_at: new Date().toISOString()
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      channel: channel
    };
  }
}

/**
 * 创建应用包版本更新检查器（带缓存）
 * 缓存语义：仅成功结果缓存 5 分钟；失败结果不写缓存，
 * 下次请求立即重新查询（避免失败态被缓存 5 分钟导致前端持续拿到错误）。
 */
export function createUpdateChecker({ appDir, log, cacheFile }) {
  let lastResult = null;
  let lastError = null;
  let cachedAt = 0;
  const CACHE_TTL = 5 * 60 * 1000; // 5 分钟（仅作用于成功结果）

  async function check({ force = false } = {}) {
    try {
      // Check cache：仅命中成功结果缓存；失败态不缓存、直接重新查询
      if (!force && cachedAt > 0 && (Date.now() - cachedAt) < CACHE_TTL && lastResult && lastResult.ok) {
        return { ...lastResult, cached: true };
      }

      const result = await checkLatestVersion();

      if (result.ok) {
        // 只有成功结果才写入缓存（lastResult/cachedAt）
        lastResult = result;
        lastError = null;
        cachedAt = Date.now();
        log(`[版本检查] 最新版本：v${result.latest}`);
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

  return { check, getLastResult: () => lastResult, getLastError: () => lastError };
}

// CLI mode：仅保留只读的版本检查（自动升级命令已移除）
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--check") {
    checkLatestVersion().then(result => {
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
