// channels.js — 通讯平台（bot）配置模块（完整版：含三套扫码流程）
// ESM，外接于 monitor.js。
// 职责：平台元数据、env/.yaml 配置读写、GET/POST 路由处理、三套扫码流程路由。
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync } from "fs";
import { createRequire } from "node:module";
import { startWhatsAppProcess, stopWhatsAppProcess, WHATSAPP_NETWORK_REQUIRED } from "./whatsapp-process.js";
import { randomBytes, createDecipheriv } from "crypto";
import { Readable } from "stream";
import { resolve as resolvePath, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── 平台元数据（10 平台）─────────────────────────────────────
export const CHANNEL_DEFS = {
  weixin: {
    name: "微信", icon: "💬", qrLogin: true,
    fields: [],
    toggles: [{ path: "require_mention", label: "需 @提及 才回复" }],
    behavior: [],
    note: "通过腾讯 iLink 官方接口扫码登录。",
  },
  qqbot: {
    name: "QQ 机器人", icon: "🐧", qrLogin: true,
    note: "可用手机 QQ 扫码自动获取 App ID / AppSecret，也可手动填写。",
    fields: [
      { env: "QQ_APP_ID", path: "extra.app_id", label: "App ID", placeholder: "..." },
      { env: "QQ_CLIENT_SECRET", path: "extra.client_secret", label: "AppSecret", placeholder: "...", secret: true },
    ],
    toggles: [{ path: "allow_all_users", label: "允许所有用户" }, { path: "qq_markdown", label: "使用 Markdown 消息" }],
    behavior: [{ path: "allowed_users", label: "允许的用户 (留空=仅创建者)", placeholder: "openid1,openid2" }],
  },
  feishu: {
    name: "飞书", icon: "🪽",
    fields: [
      { env: "FEISHU_APP_ID", path: "extra.app_id", label: "App ID", placeholder: "cli_..." },
      { env: "FEISHU_APP_SECRET", path: "extra.app_secret", label: "App Secret", placeholder: "...", secret: true },
      { env: "FEISHU_ENCRYPT_KEY", path: "extra.encrypt_key", label: "Encrypt Key (可选)", placeholder: "..." },
      { env: "FEISHU_VERIFICATION_TOKEN", path: "extra.verification_token", label: "Verification Token (可选)", placeholder: "..." },
    ],
    toggles: [{ path: "require_mention", label: "需 @提及 才回复" }],
    behavior: [{ path: "free_response_chats", label: "自由回复的会话", placeholder: "chat_id1,chat_id2" }],
  },
  dingtalk: {
    name: "钉钉", icon: "🔔",
    fields: [
      { env: "DINGTALK_CLIENT_ID", path: "extra.client_id", label: "Client ID (AppKey)", placeholder: "ding..." },
      { env: "DINGTALK_CLIENT_SECRET", path: "extra.client_secret", label: "Client Secret", placeholder: "...", secret: true },
    ],
    toggles: [{ path: "require_mention", label: "需 @提及 才回复" }, { path: "allow_all_users", label: "允许所有用户" }],
    behavior: [
      { path: "allowed_users", label: "允许的用户 (留空=仅创建者)", placeholder: "user_id1,user_id2" },
      { path: "free_response_chats", label: "自由回复的会话", placeholder: "chat_id1,chat_id2" },
    ],
  },
  wecom: {
    name: "企业微信", icon: "💼", qrLogin: true,
    note: "可用企业微信扫码自动获取 Bot ID / Secret，也可手动填写。",
    fields: [
      { env: "WECOM_BOT_ID", path: "extra.bot_id", label: "Bot ID", placeholder: "..." },
      { env: "WECOM_SECRET", path: "extra.secret", label: "Secret", placeholder: "...", secret: true },
    ],
    // 上游 wecom 默认拒绝所有用户，白名单只认 .env 的 WECOM_ALLOWED_USERS / WECOM_ALLOW_ALL_USERS，故这两项带 env 同步写入
    toggles: [
      { path: "require_mention", label: "需 @提及 才回复" },
      { path: "allow_all_users", env: "WECOM_ALLOW_ALL_USERS", label: "允许所有用户" },
    ],
    behavior: [
      { path: "allowed_users", env: "WECOM_ALLOWED_USERS", label: "允许的用户 ID（逗号分隔；留空=配对模式，陌生人需批准后才能对话）", placeholder: "ZhangSan,LiSi" },
    ],
  },
  telegram: {
    name: "Telegram", icon: "✈️", qrLogin: true,
    fields: [
      { env: "TELEGRAM_BOT_TOKEN", path: "token", label: "Bot Token", placeholder: "BotFather Token", secret: true },
      { env: "TELEGRAM_PROXY", path: "proxy", label: "代理 (可选)", placeholder: "socks5://127.0.0.1:7890" },
    ],
    toggles: [{ path: "require_mention", label: "需 @提及 才回复" }, { path: "reactions", label: "启用消息反应" }],
    behavior: [
      { path: "free_response_chats", label: "自由回复的会话 (多个用逗号分隔)", placeholder: "chat_id1,chat_id2" },
      { path: "mention_patterns", label: "提及匹配规则 (正则，多个用逗号分隔)", placeholder: "@hermes,hermes" },
    ],
  },
  whatsapp: {
    name: "WhatsApp", icon: "💬", qrLogin: true,
    fields: [],
    toggles: [{ path: "require_mention", label: "需 @提及 才回复" }],
    behavior: [{ path: "free_response_chats", label: "自由回复的会话", placeholder: "chat_id1,chat_id2" }],
    note: "通过本地 Baileys 桥接扫码配对，消息在本机处理。",
  },
  discord: {
    name: "Discord", icon: "🎮",
    fields: [
      { env: "DISCORD_BOT_TOKEN", path: "token", label: "Bot Token", placeholder: "Bot token...", secret: true },
      { env: "DISCORD_PROXY", path: "proxy", label: "代理 (可选)", placeholder: "socks5://127.0.0.1:7890" },
    ],
    toggles: [{ path: "require_mention", label: "需 @提及 才回复" }, { path: "auto_thread", label: "自动线程" }, { path: "reactions", label: "启用反应" }],
    behavior: [
      { path: "free_response_channels", label: "自由回复的频道 (多个用逗号分隔)", placeholder: "channel_id1,channel_id2" },
      { path: "allowed_channels", label: "仅允许的频道 (留空=全部)", placeholder: "channel_id1,channel_id2" },
      { path: "ignored_channels", label: "忽略的频道", placeholder: "channel_id1,channel_id2" },
    ],
  },
  slack: {
    name: "Slack", icon: "💼",
    fields: [{ env: "SLACK_BOT_TOKEN", path: "token", label: "Bot Token", placeholder: "xoxb-...", secret: true }],
    toggles: [{ path: "require_mention", label: "需 @提及 才回复" }, { path: "allow_bots", label: "允许机器人消息" }],
    behavior: [{ path: "free_response_channels", label: "自由回复的频道", placeholder: "channel_id1,channel_id2" }],
  },
  matrix: {
    name: "Matrix", icon: "🔷",
    fields: [
      { env: "MATRIX_ACCESS_TOKEN", path: "token", label: "Access Token", placeholder: "syt_...", secret: true },
      { env: "MATRIX_PROXY", path: "proxy", label: "代理 (可选)", placeholder: "socks5://127.0.0.1:7890" },
      { env: "MATRIX_HOMESERVER", path: "extra.homeserver", label: "Homeserver", placeholder: "https://matrix.org" },
      { env: "MATRIX_USER_ID", path: "extra.user_id", label: "User ID (可选)", placeholder: "@user:matrix.org" },
    ],
    toggles: [{ path: "require_mention", label: "需 @提及 才回复" }, { path: "auto_thread", label: "自动线程" }],
    behavior: [{ path: "free_response_rooms", label: "自由回复的房间", placeholder: "room_id1,room_id2" }],
  },
};

// ─── 初始化：由 monitor.js 传入共享路径与回调 ─────────────────────────────
let DATA_DIR = "";
let logFn = () => {};
let restartGatewayFn = null;
let resolvedNodeBin = null;
let resolvedNodeDir = null;
let telegramNetworkProxy = null;

/**
 * 初始化模块（monitor.js 启动时调用一次）
 * @param {{ dataDir: string, log: Function, restartGateway: Function, nodeBin?: string, nodeDir?: string, networkProxy?: { requestJson: Function, fetch: Function } }} opts
 */
export function initChannels({ dataDir, log, restartGateway, nodeBin, nodeDir, networkProxy }) {
  DATA_DIR = dataDir;
  logFn = log || (() => {});
  restartGatewayFn = restartGateway || null;
  resolvedNodeBin = nodeBin || null;
  resolvedNodeDir = nodeDir || null;
  telegramNetworkProxy = networkProxy || null;
  _telegramPairings.clear(); // 重新初始化后，旧请求不得恢复会话或跨实例验证凭证。
}

// ─── 常量 ─────────────────────────────────────────────────────────────────
const WEIXIN_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"; // iLink 默认接入点，扫码响应缺 base_url 时兜底
const TELEGRAM_ONBOARDING_URL = (process.env.TELEGRAM_ONBOARDING_URL || "https://setup.hermes-agent.nousresearch.com").replace(/\/+$/, "");
const WHATSAPP_ONBOARDING_TTL = 600000; // 10 分钟
// QQ 开放平台扫码绑定（与上游 plugins/platforms/qqbot/onboard.py 同一接口）
const QQ_PORTAL_HOST = (process.env.QQ_PORTAL_HOST || "q.qq.com").trim() || "q.qq.com";
const QQ_ONBOARD_TTL = 600000; // 10 分钟
const QQ_ONBOARD_TIMEOUT = 10000;
// 企业微信智能机器人扫码（与上游 plugins/platforms/wecom/adapter.py qr_scan_for_bot_info 同一接口，
// ai/qc/* 为企微管理后台接口而非公开 API，上游注释已说明可能变更）
const WECOM_QR_HOST = (process.env.WECOM_QR_HOST || "work.weixin.qq.com").trim() || "work.weixin.qq.com";
const WECOM_QR_TTL = 600000;          // 会话保留 10 分钟（上游 CLI 轮询上限 5 分钟）
const WECOM_QR_TIMEOUT = 15000;
const WECOM_QR_STATUS_CACHE_MS = 3000; // 轮询结果缓存 3 秒，避免前端高频轮询直接打腾讯接口

// ─── 内存状态 ─────────────────────────────────────────────────────────────
const _telegramPairings = new Map(); // pairing_id（创建中为 Symbol）-> {poll_token, expires_at_ts, bot_token, bot_username, owner_user_id}
const _whatsappPairings = new Map(); // pairing_id -> {proc, status, qr_payload, mode, account_id, account_name, account_phone, error, expires_at_ts}
const _qqbotTasks = new Map();       // task_id -> {key, expires_at_ts, app_id, client_secret, user_openid, applied_at}
const _wecomQrSessions = new Map();  // scode -> {expires_at_ts, last_poll_ts, bot_id, secret, applied_at}

// ─── env 文件读写（DATA_DIR/.env）───────────────────────────────────────
function hermesEnvPath() { return `${DATA_DIR}/.env`; }
function hermesConfigPath() { return `${DATA_DIR}/config.yaml`; }

function readEnvFile() {
  try { if (existsSync(hermesEnvPath())) return readFileSync(hermesEnvPath(), "utf8"); } catch {}
  return "";
}
function writeEnvFile(content) {
  try { writeFileSync(hermesEnvPath(), content, { mode: 0o600 }); return true; } catch { return false; }
}
function getEnvValue(content, key) {
  const m = content.match(new RegExp("^" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*=\\s*(.+)$", "m"));
  return m ? m[1].trim() : "";
}
function setEnvValue(content, key, value) {
  const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = key + "=" + (value || "");
  if (content.match(new RegExp("^" + safeKey + "\\s*=", "m"))) {
    return content.replace(new RegExp("^" + safeKey + "\\s*=.*$", "m"), line);
  }
  return (content ? content.replace(/\n?$/, "\n") : "") + line + "\n";
}

// ─── 渠道停用：#_# 注释式凭证屏蔽 ─────────────────────────────────────────
// 停用 = 把凭证行整行加 #_# 前缀（形态 #_#KEY=value），启用 = 精确剥掉行首 #_#。
// #_# 为本面板专用停用标记，启用/停用只按渠道 env 键白名单精确匹配到 = 边界。
const ENV_DISABLED_PREFIX = "#_#";

function escapeEnvKey(key) {
  return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 读取键值：活跃行优先，其次 #_# 停用行（用于判定"已配置但停用"）
function getEnvValueAny(content, key) {
  const active = getEnvValue(content, key);
  if (active) return active;
  const m = content.match(new RegExp("^" + ENV_DISABLED_PREFIX + escapeEnvKey(key) + "\\s*=\\s*(.+)$", "m"));
  return m ? m[1].trim() : "";
}

/**
 * 停用一组 env 键：把活跃的 KEY=... 行整行前缀成 #_#KEY=...。
 * 若已存在同键的 #_# 旧标记行，先删除再打标记，保证同键最多一条停用行。
 * 其余行（用户注释、其它键）原样保留，无任何变化时不写文件。
 */
function disableEnvKeys(keys) {
  const content = readEnvFile();
  if (!content) return true;
  let lines = content.split("\n");
  let changed = false;
  for (const key of keys) {
    const activeRe = new RegExp("^" + escapeEnvKey(key) + "\\s*=");
    const disabledRe = new RegExp("^" + ENV_DISABLED_PREFIX + escapeEnvKey(key) + "\\s*=");
    if (!lines.some(l => activeRe.test(l))) continue;
    lines = lines.filter(l => { if (disabledRe.test(l)) { changed = true; return false; } return true; });
    lines = lines.map(l => { if (activeRe.test(l)) { changed = true; return ENV_DISABLED_PREFIX + l; } return l; });
  }
  return changed ? writeEnvFile(lines.join("\n")) : true;
}

/**
 * 启用一组 env 键：找 #_#KEY=... 行剥掉行首 #_# 还原为活跃行。
 * 若同键同时存在活跃行与 #_# 标记行，以活跃行为准并清掉标记行，
 * 同键多条标记行只还原第一条，其余清除。
 */
function enableEnvKeys(keys) {
  const content = readEnvFile();
  if (!content) return true;
  let lines = content.split("\n");
  let changed = false;
  for (const key of keys) {
    const activeRe = new RegExp("^" + escapeEnvKey(key) + "\\s*=");
    const disabledRe = new RegExp("^" + ENV_DISABLED_PREFIX + escapeEnvKey(key) + "\\s*=");
    const hasActive = lines.some(l => activeRe.test(l));
    let restored = false;
    lines = lines.reduce((acc, l) => {
      if (!disabledRe.test(l)) { acc.push(l); return acc; }
      changed = true;
      if (!hasActive && !restored) { acc.push(l.slice(ENV_DISABLED_PREFIX.length)); restored = true; }
      return acc; // 活跃行已存在或多余标记行：直接清除
    }, []);
  }
  return changed ? writeEnvFile(lines.join("\n")) : true;
}

// 判断 env 文本中是否存在指定键的 #_# 停用行
function hasDisabledEnvLines(content, keys) {
  return keys.some(k => new RegExp("^" + ENV_DISABLED_PREFIX + escapeEnvKey(k) + "\\s*=", "m").test(content));
}

// 从 env 文本中移除指定键的 #_# 停用行，返回处理后文本
function stripDisabledEnvLines(content, keys) {
  let lines = content.split("\n");
  for (const key of keys) {
    const disabledRe = new RegExp("^" + ENV_DISABLED_PREFIX + escapeEnvKey(key) + "\\s*=");
    lines = lines.filter(l => !disabledRe.test(l));
  }
  return lines.join("\n");
}

// ─── config.yaml 读写 ────────────────────────────────────────────────────
function readHermesConfig() {
  try { if (existsSync(hermesConfigPath())) return readFileSync(hermesConfigPath(), "utf8"); } catch {}
  return "";
}
function writeHermesConfig(content) {
  try { writeFileSync(hermesConfigPath(), content, { mode: 0o644 }); return true; } catch { return false; }
}

// ─── YAML 辅助（最小实现，仅用于 platforms 段）────────────────────────────
function yamlQuote(v) {
  if (v === true) return "true";
  if (v === false) return "false";
  if (v === null || v === undefined) return '""';
  const s = String(v);
  if (s === "") return '""';
  if (/[:#[\]{}&*!|>'"%@`,]/.test(s) || /^\s|\s$/.test(s) || /[\n\r\t]/.test(s)) {
    return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }
  return s;
}
function yamlUnquote(s) {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~" || s === "") return null;
  if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return s;
}
function objToYaml(obj, spaces) {
  const pad = " ".repeat(spaces);
  let out = "";
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      out += pad + k + ":\n" + objToYaml(v, spaces + 2);
    } else if (Array.isArray(v)) {
      out += pad + k + (v.length ? ":\n" + v.map(x => pad + "  - " + yamlQuote(x) + "\n").join("") : ": []\n");
    } else {
      out += pad + k + ": " + yamlQuote(v) + "\n";
    }
  }
  return out;
}

// ─── 嵌套 path 存取 ─────────────────────────────────────────────────────
function setValByPath(obj, path, val) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) { const p = parts[i]; cur[p] = (cur[p] && typeof cur[p] === "object") ? cur[p] : {}; cur = cur[p]; }
  cur[parts[parts.length - 1]] = val;
}
function getValByPath(obj, path) {
  const parts = path.split("."); let cur = obj;
  for (const p of parts) { if (cur == null || typeof cur !== "object") return undefined; cur = cur[p]; }
  return cur;
}
// 删除嵌套 path 对应字段，中间对象变空时一并删除
function deleteValByPath(obj, path) {
  const parts = path.split(".");
  const parents = [];
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return;
    parents.push(cur); cur = cur[parts[i]];
  }
  if (cur == null || typeof cur !== "object") return;
  delete cur[parts[parts.length - 1]];
  for (let i = parts.length - 2; i >= 0; i--) {
    const child = parents[i][parts[i]];
    if (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0) delete parents[i][parts[i]];
    else break;
  }
}

// ─── 读取 config.yaml 中 platforms.<id> 段 ───────────────────────────────
function readPlatformConfig(id) {
  const yml = readHermesConfig();
  const re = new RegExp("^  " + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":(?:\\n((?:    .*(?:\\n      .*)*\\n?)*))?", "m");
  const m = yml.match(re);
  if (!m || !m[1]) return {};
  const obj = {};
  let curObj = null;
  m[1].split("\n").forEach(l => {
    if (!l.trim()) return;
    const mm = l.match(/^    ([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (mm) {
      const key = mm[1], val = mm[2].trim();
      if (val === "") { obj[key] = {}; curObj = obj[key]; }
      else { obj[key] = yamlUnquote(val); curObj = null; }
    } else {
      const em = l.match(/^      ([a-zA-Z_][\w-]*):\s*(.*)$/);
      if (em && curObj && typeof curObj === "object") { curObj[em[1]] = yamlUnquote(em[2].trim()); }
    }
  });
  return obj;
}

// ─── 重建 platforms 段中的指定平台块 ─────────────────────────────────────
function setPlatformConfig(id, obj) {
  const block = "  " + id + ":\n" + objToYaml(obj, 4);
  let yml = readHermesConfig();
  if (!/^platforms:/m.test(yml)) {
    yml = (yml ? yml.replace(/\n?$/, "\n") : "") + "platforms:\n" + block;
    return yml;
  }
  const lines = yml.split("\n");
  let header = -1;
  for (let i = 0; i < lines.length; i++) { if (/^platforms:\s*$/.test(lines[i])) { header = i; break; } }
  if (header < 0) { yml = yml.replace(/\n?$/, "\n") + "platforms:\n" + block; return yml; }
  const order = [];
  const blocks = {};
  let curId = null, suffixStart = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^[a-zA-Z_]/.test(l)) {
      if (curId !== null) blocks[curId].e = i - 1;
      suffixStart = i; break;
    }
    const mm = l.match(/^  ([a-zA-Z_][\w-]*):/);
    if (mm) {
      if (curId !== null) blocks[curId].e = i - 1;
      curId = mm[1];
      if (!blocks[curId]) { blocks[curId] = { s: i, e: i }; if (order[order.length - 1] !== curId) order.push(curId); }
    } else if (curId !== null) { blocks[curId].e = i; }
  }
  if (curId !== null && suffixStart === lines.length) blocks[curId].e = lines.length - 1;
  const newLines = [];
  for (let i = 0; i <= header; i++) newLines.push(lines[i]);
  let wroteTarget = false;
  order.forEach(pid => {
    if (pid === id) { newLines.push(block.replace(/\n$/, "")); wroteTarget = true; }
    else { for (let i = blocks[pid].s; i <= blocks[pid].e; i++) newLines.push(lines[i]); }
  });
  if (!wroteTarget) newLines.push(block.replace(/\n$/, ""));
  for (let i = suffixStart; i < lines.length; i++) newLines.push(lines[i]);
  return newLines.join("\n") + "\n";
}

// ─── WhatsApp Bridge 辅助 ─────────────────────────────────────────────────
function _findWhatsAppBridgeDir() {
  // 使用项目内置的 vendor/whatsapp-bridge 目录
  const bundled = resolvePath(__dirname, "vendor", "whatsapp-bridge");
  if (existsSync(`${bundled}/bridge.js`)) return bundled;
  return null;
}

function _findNpmBin() {
  // 1) Hermes 自带 node 同目录下的 npm（nodeBin 由 initChannels 传入）
  if (resolvedNodeBin) {
    const nodeDir = resolvedNodeBin.replace(/[\\/][^\\/]+$/, "");
    for (const name of ["npm", "npm.cmd"]) {
      const sibling = `${nodeDir}/${name}`;
      if (existsSync(sibling)) return { npm: sibling, isScript: false, node: resolvedNodeBin };
    }
  }
  // 2) 系统安装：交给 PATH 解析（spawn 时不带路径）
  return { npm: "npm", isScript: false, node: resolvedNodeBin };
}

function _whatsAppDepsReady(bridgeDir) {
  try {
    const manifest = JSON.parse(readFileSync(`${bridgeDir}/package.json`, "utf8"));
    const require = createRequire(`${bridgeDir}/package.json`);
    return Object.entries(manifest.dependencies).every(([name, version]) => {
      // Check local packages as well as entry points; an old node_modules is not enough.
      const installed = JSON.parse(readFileSync(`${bridgeDir}/node_modules/${name}/package.json`, "utf8"));
      require.resolve(name);
      return /^[~^*]/.test(version) || installed.version === version;
    });
  } catch { return false; }
}

async function _ensureWhatsAppBridgeDeps(bridgeDir, signal) {
  if (typeof telegramNetworkProxy?.withEnvironment !== "function") throw new Error(WHATSAPP_NETWORK_REQUIRED);
  if (_whatsAppDepsReady(bridgeDir)) return true;
  if (!resolvedNodeBin) throw new Error("未找到 Node.js，无法启动 WhatsApp bridge");
  const npmInfo = _findNpmBin();
  const env = { ...process.env, PATH: (resolvedNodeDir ? resolvedNodeDir + ":" : "") + (process.env.PATH || "") };
  const args = ["install", "--silent", "--no-audit", "--no-fund", "--no-update-notifier"];
  const job = await startWhatsAppProcess({ networkProxy: telegramNetworkProxy,
    command: npmInfo.isScript ? npmInfo.node : npmInfo.npm,
    args: npmInfo.isScript ? [npmInfo.npm, ...args] : args,
    cwd: bridgeDir, env, timeoutMs: 300000, signal, npm: true });
  await job.done; // Includes child close AND proxy context cleanup, even on timeout/error.
  if (!_whatsAppDepsReady(bridgeDir)) throw new Error("WhatsApp bridge 依赖安装不完整");
  return true;
}

async function _spawnWhatsAppPairing(sessionDir, mode, signal) {
  const bridgeDir = _findWhatsAppBridgeDir();
  if (!bridgeDir) throw new Error("未找到 WhatsApp bridge 脚本，请确认 hermes-agent 已正确安装");
  if (!resolvedNodeBin) throw new Error("未找到 Node.js，无法启动 WhatsApp bridge");
  await _ensureWhatsAppBridgeDeps(bridgeDir, signal);
  mkdirSync(sessionDir, { recursive: true });
  const env = { ...process.env, WHATSAPP_MODE: mode || "self-chat", WHATSAPP_DM_POLICY: "pairing" };
  // This pairing keeps its startup proxy snapshot, not a hot-reloaded configuration.
  return startWhatsAppProcess({ networkProxy: telegramNetworkProxy, command: resolvedNodeBin,
    args: [`${bridgeDir}/bridge.js`, "--pair-only", "--pair-json", "--session", sessionDir],
    cwd: bridgeDir, env, timeoutMs: WHATSAPP_ONBOARDING_TTL, signal });
}

function _terminateProc(proc) { stopWhatsAppProcess(proc); }

function _watchWhatsAppPairing(pairingId, { child: proc, done }) {
  done.catch(error => {
    const rec = _whatsappPairings.get(pairingId);
    if (!rec || rec.proc !== proc || ["connected", "expired", "cancelled"].includes(rec.status)) return;
    if (rec.status === "error" && error.code === "WA_CANCELLED") return;
    rec.status = error.code === "WA_TIMEOUT" ? "expired" : error.code === "WA_CANCELLED" ? "cancelled" : "error";
    rec.error = error.code === "WA_TIMEOUT" ? "二维码已过期，请重新配对" : "WhatsApp 配对失败，请检查统一代理配置";
  });
  if (!proc || !proc.stdout) return;
  try {
    let buf = "";
    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      if (buf.length > 65536) { buf = ""; _terminateProc(proc); return; }
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const raw of lines) {
        const line = raw.trim(); if (!line) continue;
        try {
          const payload = JSON.parse(line);
          const event = String(payload.event || "").trim();
          const rec = _whatsappPairings.get(pairingId);
          if (!rec || rec.proc !== proc) return;
          if (event === "qr") {
            const qr = String(payload.qr || "").trim();
            if (qr) { rec.qr_payload = qr; rec.status = "waiting"; rec.error = null; }
          } else if (event === "connected") {
            const user = payload.user || {};
            rec.account_id = String(user.id || "").trim() || null;
            rec.account_name = String(user.name || "").trim() || null;
            rec.account_phone = rec.account_id ? rec.account_id.replace(/[^0-9]/g, "").replace(/^\d+?:(\d+)@s\.whatsapp\.net$/, "$1") : null;
            rec.status = "connected"; rec.error = null;
          } else if (event === "error") {
            rec.status = "error"; rec.error = "WhatsApp 配对失败，请检查统一代理配置";
            _terminateProc(proc);
          }
        } catch {}
      }
    });
    proc.on("exit", () => {
      const rec = _whatsappPairings.get(pairingId);
      if (!rec || rec.proc !== proc) return;
      if (!["connected", "error", "expired", "cancelled"].includes(rec.status)) {
        rec.status = "error"; rec.error = "WhatsApp 配对进程意外退出";
      }
    });
  } catch {}
}

// ─── Telegram / WhatsApp 辅助 ─────────────────────────────────────────────
function _pruneTelegramPairings() {
  const now = Date.now();
  for (const [id, rec] of _telegramPairings) { if (rec.expires_at_ts <= now) _telegramPairings.delete(id); }
}
function _pruneWhatsAppPairings() {
  const now = Date.now();
  const terminal = { connected: 1, error: 1, expired: 1, cancelled: 1 };
  for (const [id, rec] of _whatsappPairings) {
    if (!terminal[rec.status] && rec.expires_at_ts <= now) {
      rec.status = "expired"; rec.error = "二维码已过期，请重新配对";
      _terminateProc(rec.proc);
    }
    if (terminal[rec.status] && rec.expires_at_ts + 300000 <= now) _whatsappPairings.delete(id);
  }
}
function _normalizeTelegramUserId(value) {
  const s = String(value || "").trim();
  if (/^\d+$/.test(s)) return s;
  return null;
}
function _normalizeWhatsAppAllowedUsers(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  const parts = s.split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p === "*") { out.push("*"); continue; }
    const digits = p.replace(/\D/g, "");
    if (digits) out.push(digits);
  }
  return out.join(",");
}

// ─── 路由处理器 ──────────────────────────────────────────────────────────
/**
 * 判定平台是否已配置（凭证存在即视为已配置，与 enabled 开关无关）。
 * 凭证行为活跃形态（KEY=）或 #_# 停用形态（#_#KEY=）均计入。
 */
function isChannelConfigured(id, def, env, cfg) {
  let configured = false;
  (def.fields || []).forEach(f => { if (f.env && getEnvValueAny(env, f.env)) configured = true; });
  // WhatsApp/微信 特殊判定
  if (id === "whatsapp" && (getEnvValueAny(env, "WHATSAPP_ENABLED") || cfg.enabled === "true" || cfg.enabled === true)) configured = true;
  if (id === "weixin" && (getEnvValueAny(env, "WEIXIN_TOKEN") || cfg.token || (cfg._stash && cfg._stash.token))) configured = true;
  return configured;
}

// ─── 渠道 env 键集：toggle 停用/启用时屏蔽/恢复的全部凭证键 ───────────────
// 含 fields[].env 与扫码渠道 Apply 流程直写 .env 的固定键。
const CHANNEL_EXTRA_ENV_KEYS = {
  weixin: ["WEIXIN_TOKEN", "WEIXIN_ACCOUNT_ID", "WEIXIN_BASE_URL"],
  qqbot: ["QQ_ALLOWED_USERS"],
  wecom: ["WECOM_ALLOWED_USERS", "WECOM_ALLOW_ALL_USERS"],
  telegram: ["TELEGRAM_ALLOWED_USERS"],
  whatsapp: ["WHATSAPP_MODE", "WHATSAPP_DM_POLICY", "WHATSAPP_ALLOWED_USERS", "WHATSAPP_ENABLED"],
};
function channelEnvKeys(id, def) {
  const keys = (def.fields || []).map(f => f.env).filter(Boolean);
  for (const k of CHANNEL_EXTRA_ENV_KEYS[id] || []) { if (!keys.includes(k)) keys.push(k); }
  return keys;
}

// ─── config.yaml 凭证暂存/恢复（全渠道通用）───────────────────────────
// 停用时把 platforms.<id> 下的凭证字段移入 _stash 子字段并清空原字段，
// 启用时从 _stash 对称恢复并删除该字段。_stash 键为凭证 path，"." 以 "__" 编码。
function channelConfigCredPaths(id, def) {
  const paths = (def.fields || []).map(f => f.path).filter(Boolean);
  if (id === "weixin") {
    for (const p of ["token", "extra.account_id", "extra.base_url"]) { if (!paths.includes(p)) paths.push(p); }
  }
  return paths;
}
function stashConfigCreds(id, def, cfg) {
  const stash = (cfg._stash && typeof cfg._stash === "object") ? cfg._stash : {};
  for (const p of channelConfigCredPaths(id, def)) {
    const v = getValByPath(cfg, p);
    if (v !== undefined && v !== null && v !== "") stash[p.replace(/\./g, "__")] = v;
    deleteValByPath(cfg, p);
  }
  if (Object.keys(stash).length) cfg._stash = stash;
}
function restoreConfigCreds(id, cfg) {
  const stash = (cfg._stash && typeof cfg._stash === "object") ? cfg._stash : null;
  if (!stash) return;
  for (const key of Object.keys(stash)) {
    // weixin 的 account_id/base_url 键按 extra.<键> 路径恢复
    let path = key.replace(/__/g, ".");
    if (id === "weixin" && (key === "account_id" || key === "base_url")) path = "extra." + key;
    const cur = getValByPath(cfg, path);
    if (cur === undefined || cur === null || cur === "") setValByPath(cfg, path, stash[key]);
  }
  delete cfg._stash;
}

// ─── 网关重启请求：同步异常与异步 rejection 统一捕获，不中断请求处理 ───────
function _requestGatewayRestart(reason) {
  if (!restartGatewayFn) return { restarting: false, failed: false };
  try {
    const r = restartGatewayFn(reason);
    if (r && typeof r.catch === "function") r.catch(e => logFn(`[channels] 重启网关失败: ${e?.message || e}`));
    return { restarting: true, failed: false };
  } catch (e) {
    logFn(`[channels] 重启网关失败: ${e?.message || e}`);
    return { restarting: false, failed: true };
  }
}

/**
 * GET /api/channels — 列出所有平台及配置状态
 */
export function handleGetChannels() {
  const env = readEnvFile();
  const out = {};
  Object.keys(CHANNEL_DEFS).forEach(id => {
    const def = CHANNEL_DEFS[id];
    const cfg = readPlatformConfig(id);
    const configured = isChannelConfigured(id, def, env, cfg);
    delete cfg._stash; // 停用暂存的明文凭证不下发前端
    // 带 env 的开关/行为项以 .env 为准回填（扫码 Apply 只写 .env，config.yaml 可能没有）
    [].concat(def.toggles || [], def.behavior || []).forEach(item => {
      if (!item.env || cfg[item.path] != null) return;
      const v = getEnvValueAny(env, item.env);
      if (v) cfg[item.path] = v;
    });
    out[id] = {
      id, name: def.name, icon: def.icon, configured, qrLogin: !!def.qrLogin, note: def.note || "",
      // enabled 缺省视为 true（历史配置无该字段 = 已配置即启用）
      enabled: !(cfg.enabled === false || cfg.enabled === "false"),
      // 凭证展示用 getEnvValueAny：停用态（#_# 注释行）仍显示为已填写
      fields: (def.fields || []).map(f => ({
        env: f.env, path: f.path, label: f.label, placeholder: f.placeholder || "",
        secret: !!f.secret, has_value: !!getEnvValueAny(env, f.env),
        masked: f.secret && getEnvValueAny(env, f.env) ? "****" + getEnvValueAny(env, f.env).slice(-4) : "",
      })),
      toggles: def.toggles || [],
      behavior: def.behavior || [],
      config: cfg,
    };
  });
  return out;
}

/**
 * POST /api/channels/:id/toggle — 启用/停用平台（真停用语义）
 * body: { enabled: boolean }
 * 停用 = #_# 注释该渠道全部 env 凭证键，并把 config.yaml 凭证移入 _stash，
 * 启用 = 剥掉 #_# 并从 _stash 恢复。enabled 字段供面板显示，
 * 切换后不自动重启网关，由用户手动重启生效（响应 needs_restart 提示前端）。
 */
export function handleToggleChannel(id, body) {
  const def = CHANNEL_DEFS[id];
  if (!def) return { ok: false, error: "unknown channel" };
  const env = readEnvFile();
  const cfg = readPlatformConfig(id);
  if (!isChannelConfigured(id, def, env, cfg)) return { ok: false, error: "平台尚未配置，无法切换启用状态" };
  const enabled = body && body.enabled === true;
  const keys = channelEnvKeys(id, def);
  if (enabled) {
    if (!enableEnvKeys(keys)) return { ok: false, error: "写入 .env 失败，未变更启用状态" };
    restoreConfigCreds(id, cfg);
  } else {
    if (!disableEnvKeys(keys)) return { ok: false, error: "写入 .env 失败，未变更启用状态" };
    stashConfigCreds(id, def, cfg);
  }
  cfg.enabled = enabled;
  cfg.updated_at = Date.now();
  if (!writeHermesConfig(setPlatformConfig(id, cfg))) return { ok: false, error: "写入 config.yaml 失败" };
  return { ok: true, id, configured: true, enabled, needs_restart: true };
}

/**
 * POST /api/channels/:id — 保存平台配置
 */
export function handleSaveChannel(id, body) {
  const def = CHANNEL_DEFS[id];
  if (!def) return { ok: false, error: "unknown channel" };

  let env = readEnvFile();
  const cfg = readPlatformConfig(id);

  // 渠道处于 #_# 停用态时：先解除全键停用并恢复 config.yaml 凭证，保存后以完整凭证上线
  let reEnabled = false;
  const keys = channelEnvKeys(id, def);
  if (hasDisabledEnvLines(env, keys)) {
    if (!enableEnvKeys(keys)) return { ok: false, error: "写入 .env 失败，未变更配置" };
    env = readEnvFile();
    restoreConfigCreds(id, cfg);
    cfg.enabled = true;
    reEnabled = true;
  }

  // 凭证字段 → .env + config.yaml
  (def.fields || []).forEach(f => {
    if (!f.env) return;
    const v = (body.credentials && body.credentials[f.env] != null) ? body.credentials[f.env]
            : (body.config && getValByPath(body.config, f.path) != null ? getValByPath(body.config, f.path) : null);
    if (v == null || v === "****keep****") return;
    env = setEnvValue(env, f.env, v || "");
    if (f.path) setValByPath(cfg, f.path, v || "");
  });
  // 带 env 的开关/行为项同步写入 .env（上游部分平台只读 env 白名单）
  (def.toggles || []).forEach(t => {
    if (!t.env || !body.toggles || body.toggles[t.path] == null) return;
    env = setEnvValue(env, t.env, body.toggles[t.path] ? "true" : "false");
  });
  (def.behavior || []).forEach(b => {
    if (!b.env || !body.config || body.config[b.path] == null) return;
    env = setEnvValue(env, b.env, String(body.config[b.path]));
  });
  if (!writeEnvFile(env)) return { ok: false, error: "写入 .env 失败，未变更既有配置" };

  // 行为开关
  if (body.toggles && typeof body.toggles === "object") {
    Object.keys(body.toggles).forEach(p => { const v = body.toggles[p]; if (v != null) setValByPath(cfg, p, v); });
  }
  // 其余行为配置
  if (body.config && typeof body.config === "object") {
    Object.keys(body.config).forEach(p => {
      if ((def.fields || []).some(f => f.path === p)) return;
      const v = body.config[p]; if (v != null) setValByPath(cfg, p, v);
    });
  }

  cfg.updated_at = Date.now();
  if (!writeHermesConfig(setPlatformConfig(id, cfg))) return { ok: false, error: "写入 config.yaml 失败" };

  // 保存后重启网关使配置生效
  const restart = _requestGatewayRestart(`channel-${id}`);
  return { ok: true, re_enabled: reEnabled, gateway_restarting: restart.restarting, gateway_restart_failed: restart.failed };
}

// ═══════════════════════════════════════════════════════════════════════════
// 三套扫码流程路由处理器
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 统一 JSON 响应生成
 */
function jsonRes(data, status = 200) {
  return { status, body: data };
}

// 所有面板渠道 HTTP 请求共用注入实例。不按国内域名分流，不回退原生 fetch。
async function _channelFetch(url, options) {
  const proxy = telegramNetworkProxy;
  if (typeof proxy?.fetch !== "function") throw new Error("网络组件未初始化，请检查统一代理配置");
  try {
    return await proxy.fetch(url, options); // 保留实例 this。
  } catch {
    // 代理异常可能包含凭证、二维码参数或完整 URL，不向面板透传。
    throw new Error("网络组件请求失败，请检查统一代理配置");
  }
}

/**
 * 微信 iLink 扫码：获取二维码
 * GET /api/channels/weixin/qr
 */
export async function handleWeixinQr() {
  try {
    const res = await _channelFetch("https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3", { method: "GET", timeoutMs: 15000, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return jsonRes({ ok: false, error: `微信接口 HTTP ${res.status}` }, 502);
    const data = await res.json().catch(() => ({}));
    if (!data || !data.qrcode) return jsonRes({ ok: false, error: "无法获取微信二维码，请检查网络后重试" }, 502);
    const deepLink = data.qrcode_img_content || "";
    return jsonRes({ ok: true, qrcode: data.qrcode, qrcode_url: deepLink, qrcode_img: deepLink, use_render_qr: true });
  } catch (e) {
    return jsonRes({ ok: false, error: e.message || "网络请求失败" }, 502);
  }
}

/**
 * 微信 iLink 扫码：轮询状态
 * GET /api/channels/weixin/qr/status?qrcode=...
 */
export async function handleWeixinQrStatus(qrcode) {
  if (!qrcode) return jsonRes({ ok: false, error: "缺少 qrcode 参数" }, 400);
  try {
    const res = await _channelFetch("https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=" + encodeURIComponent(qrcode), { method: "GET", timeoutMs: 35000, signal: AbortSignal.timeout(35000) });
    if (!res.ok) return jsonRes({ ok: false, error: `微信接口 HTTP ${res.status}` }, 502);
    const data = await res.json().catch(() => ({}));
    const status = data?.status || "wait";
    if (status === "confirmed") {
      return jsonRes({ ok: true, status, account_id: data.ilink_bot_id, token: data.bot_token, base_url: data.baseurl });
    }
    return jsonRes({ ok: true, status });
  } catch (e) {
    return jsonRes({ ok: false, error: e.message || "网络请求失败" }, 502);
  }
}

/**
 * 清理网关账号缓存（DATA_DIR/weixin/accounts/ 下每账号三件套）：
 * - <account_id>.json：凭证备份，无条件用新 token/base_url 覆写，
 * - <account_id>.sync.json：长轮询游标，删除后网关会重建，
 * - <account_id>.context-tokens.json：会话 token 缓存。
 * 先成功写入新账号 <accountId>.json，再执行一切删除：同账号重扫且 token 变化时
 * 删除 .sync.json 重置游标，换绑时删除旧账号三件套。写入失败不触动任何缓存文件。
 * account_id 仅允许 [A-Za-z0-9._@-]，拒绝纯 "."/".." 与超长值，非法值跳过清理不参与路径拼接。
 * 文件/目录不存在时静默跳过，不抛错。
 * 返回 { wrote: boolean, error: string|null }：新账号 json 是否写入成功及失败信息。
 */
const WEIXIN_ACCOUNT_ID_RE = /^[A-Za-z0-9._@-]+$/;
const WEIXIN_ACCOUNT_ID_MAX = 128;
function _safeWeixinAccountId(id) {
  const s = String(id || "").trim();
  if (!s) return null;
  if (s === "." || s === ".." || s.length > WEIXIN_ACCOUNT_ID_MAX
      || !WEIXIN_ACCOUNT_ID_RE.test(s) || s.includes("..") || s.includes("/") || s.includes("\\")) {
    logFn(`[channels] 非法微信 account_id，跳过账号缓存清理: ${JSON.stringify(s.slice(0, 160))}`);
    return null;
  }
  return s;
}
function _cleanWeixinAccountCache(accountId, prevAccountId, token, baseUrl) {
  const accDir = `${DATA_DIR}/weixin/accounts`;
  const curId = _safeWeixinAccountId(accountId);
  if (!curId) return { wrote: false, error: "account_id 非法，已跳过账号缓存写入" };
  let wroteNew = false;
  let writeError = null;
  let tokenChanged = false;
  const curFile = `${accDir}/${curId}.json`;
  try {
    let old = {};
    try { if (existsSync(curFile)) old = JSON.parse(readFileSync(curFile, "utf8")) || {}; } catch {}
    tokenChanged = !!(old.token && old.token !== token);
    try { mkdirSync(accDir, { recursive: true }); } catch {}
    const payload = { ...old, token, base_url: baseUrl, saved_at: new Date().toISOString().replace(/\.\d+Z$/, "Z") };
    writeFileSync(curFile, JSON.stringify(payload), { mode: 0o600 });
    wroteNew = true;
    logFn(`[channels] 微信账号缓存已写入: ${curFile}`);
  } catch (e) {
    writeError = (e && e.code ? e.code + ": " : "") + (e && e.message ? e.message : String(e));
    logFn(`[channels] 微信账号缓存写入失败: ${curFile} (${writeError})`);
  }
  if (!wroteNew) return { wrote: false, error: writeError };
  if (tokenChanged) {
    try {
      const syncFile = `${accDir}/${curId}.sync.json`;
      if (existsSync(syncFile)) unlinkSync(syncFile);
    } catch {}
  }
  const prevId = _safeWeixinAccountId(prevAccountId);
  if (prevId && prevId !== curId) {
    for (const suffix of [".json", ".sync.json", ".context-tokens.json"]) {
      try {
        const oldFile = `${accDir}/${prevId}${suffix}`;
        if (existsSync(oldFile)) unlinkSync(oldFile);
      } catch {}
    }
  }
  return { wrote: true, error: null };
}

/**
 * 微信扫码确认后保存凭证
 * POST /api/channels/weixin  (body: { credentials: {WEIXIN_TOKEN, WEIXIN_ACCOUNT_ID, WEIXIN_BASE_URL} })
 */
export function handleWeixinSave(body) {
  try {
    const creds = body.credentials || body;
    const token = String(creds.WEIXIN_TOKEN || "").trim();
    const accountId = String(creds.WEIXIN_ACCOUNT_ID || "").trim();
    // token 或 accountId 缺失：拒绝保存，返回指引文案
    if (!token || !accountId) {
      return jsonRes({ ok: false, error: "该微信 bot 可能已绑定，iLink 未下发新凭证；请在微信侧解绑后重新扫码，或稍后重试" }, 502);
    }
    const baseUrl = String(creds.WEIXIN_BASE_URL || "").trim() || WEIXIN_DEFAULT_BASE_URL;
    let env = readEnvFile();
    const cfg = readPlatformConfig("weixin");
    // 旧账号 ID：活跃/停用行均可读，.env 缺失时回退 config.yaml extra/_stash
    const prevAccountId = getEnvValueAny(env, "WEIXIN_ACCOUNT_ID")
      || String((cfg.extra && cfg.extra.account_id) || "").trim()
      || String((cfg._stash && (cfg._stash.extra__account_id || cfg._stash.account_id)) || "").trim();
    // 清除本渠道遗留的 #_# 停用行后无条件覆盖写入
    env = stripDisabledEnvLines(env, channelEnvKeys("weixin", CHANNEL_DEFS.weixin));
    env = setEnvValue(env, "WEIXIN_TOKEN", token);
    env = setEnvValue(env, "WEIXIN_ACCOUNT_ID", accountId);
    env = setEnvValue(env, "WEIXIN_BASE_URL", baseUrl);
    if (!writeEnvFile(env)) return jsonRes({ ok: false, error: "写入 .env 失败，未变更既有配置" }, 500);
    // 同步写 config.yaml：双写覆盖旧凭证
    cfg.token = token;
    const extra = (cfg.extra && typeof cfg.extra === "object") ? cfg.extra : {};
    cfg.extra = { ...extra, account_id: accountId, base_url: baseUrl };
    delete cfg._stash;
    cfg.enabled = true;
    cfg.updated_at = Date.now();
    if (!writeHermesConfig(setPlatformConfig("weixin", cfg))) return jsonRes({ ok: false, error: "写入 config.yaml 失败" }, 500);
    // 凭证与双写均成功后才清理账号缓存，缓存写入结果随响应下发
    const cache = _cleanWeixinAccountCache(accountId, prevAccountId, token, baseUrl);
    const restart = _requestGatewayRestart("weixin-bind");
    return jsonRes({
      ok: true,
      cache_written: !!(cache && cache.wrote),
      cache_error: (cache && cache.error) || null,
      gateway_restarting: restart.restarting,
      gateway_restart_failed: restart.failed,
    });
  } catch (e) {
    return jsonRes({ ok: false, error: e.message }, 500);
  }
}

// Telegram 的错误只使用本地固定文案。上游异常可能包含 bearer、bot token 或完整 URL。
const TELEGRAM_ERRORS = Object.freeze({
  TELEGRAM_PROXY_REQUIRED: [503, "Telegram 安全网络组件未初始化"],
  TELEGRAM_INVALID_INPUT: [400, "Telegram 配对参数无效"],
  TELEGRAM_INVALID_RESPONSE: [502, "Telegram 配对服务响应格式无效"],
  TELEGRAM_CREATE_FAILED: [502, "无法创建 Telegram 配对，请稍后重试"],
  TELEGRAM_POLL_FAILED: [502, "查询 Telegram 配对失败，请稍后重试"],
  TELEGRAM_INVALID_TOKEN: [502, "Telegram 机器人凭证格式无效"],
  TELEGRAM_VERIFY_FAILED: [502, "Telegram 机器人身份验证失败，请稍后重试"],
  TELEGRAM_UNKNOWN_STATUS: [502, "Telegram 配对服务返回未知状态"],
  TELEGRAM_SESSION_MISSING: [404, "配对会话不存在或已过期"],
  TELEGRAM_SESSION_EXPIRED: [410, "配对已过期，请重新扫码"],
  TELEGRAM_SESSION_CLAIMED: [410, "配对已被领取，请重新扫码"],
  TELEGRAM_ABORTED: [499, "Telegram 配对请求已取消"],
  TELEGRAM_NOT_READY: [409, "机器人尚未完成验证，请稍后再试"],
  TELEGRAM_ALLOWED_USERS_REQUIRED: [400, "请至少填写一个允许的 Telegram 用户 ID（数字）"],
  TELEGRAM_ENV_WRITE_FAILED: [500, "写入 .env 失败，未变更既有配置"],
  TELEGRAM_CONFIG_WRITE_FAILED: [500, "写入 config.yaml 失败"],
  TELEGRAM_APPLY_FAILED: [500, "保存 Telegram 配对失败"],
});
function _telegramError(code) {
  const [status, error] = TELEGRAM_ERRORS[code];
  return jsonRes({ ok: false, error, code }, status);
}
function _telegramObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function _telegramText(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value) && value === value.trim();
}
function _telegramPairingId(value) {
  return _telegramText(value, 128) && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function _telegramUserId(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (_telegramText(value, 16) && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value))) return value;
  return null;
}
function _telegramToken(value) {
  // 上游 hermes_cli/telegram_managed_bot.py 规定的 token 格式为 \d+:[A-Za-z0-9_-]{30,}，长度不固定为 35。
  // 2048 是面板本地凭证资源上限，不是 Telegram 协议长度。仍须 getMe 验证安全数字 ID。
  return _telegramText(value, 2048) && /^[1-9][0-9]{0,15}:[A-Za-z0-9_-]{30,}$/.test(value)
    && _telegramUserId(value.split(":")[0]) !== null;
}
function _telegramUsername(value) {
  return _telegramText(value, 32) && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value);
}
function _telegramLink(value) {
  if (!_telegramText(value, 2048)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.port && !url.hash && (
      (url.protocol === "https:" && ["t.me", "telegram.me"].includes(url.hostname)) ||
      (url.protocol === "tg:" && url.hostname === "resolve")
    );
  } catch { return false; }
}
function _telegramRequestOptions(signal, options) {
  return { ...options, signal, timeoutMs: 15000, maxBytes: 64 * 1024, maxRedirects: 0 };
}
// 在每次 await（包括 rejection）后检查请求标识与期限，绝不重新插入旧记录。
function _telegramPairingError(pairingId, rec, signal) {
  if (_telegramPairings.get(pairingId) !== rec) return _telegramError("TELEGRAM_SESSION_MISSING");
  if (rec.expires_at_ts <= Date.now()) {
    _telegramPairings.delete(pairingId);
    return _telegramError("TELEGRAM_SESSION_EXPIRED");
  }
  if (signal?.aborted) return _telegramError("TELEGRAM_ABORTED");
  return null;
}
function _telegramReady(rec) {
  return jsonRes({ ok: true, status: "ready", bot_username: rec.bot_username, owner_user_id: rec.owner_user_id });
}
// 其它平台请求重启网关的方式和返回约定保持不变，只有 Telegram 不记录原始异常信息。
function _requestTelegramGatewayRestart() {
  if (!restartGatewayFn) return { restarting: false, failed: false };
  const report = () => {
    try { logFn("[channels] Telegram 网关重启失败（TELEGRAM_RESTART_FAILED）"); } catch {}
  };
  try {
    const result = restartGatewayFn("telegram-bind");
    if (result && typeof result.catch === "function") result.catch(report);
    return { restarting: true, failed: false };
  } catch {
    report();
    return { restarting: false, failed: true };
  }
}

/**
 * Telegram 扫码：创建配对
 * GET /api/channels/telegram/qr?bot_name=...
 */
export async function handleTelegramQr(botName, { signal } = {}) {
  const proxy = telegramNetworkProxy;
  if (!proxy || typeof proxy.requestJson !== "function") return _telegramError("TELEGRAM_PROXY_REQUIRED");
  if (botName != null && (typeof botName !== "string" || botName.length > 64
      || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(botName))) return _telegramError("TELEGRAM_INVALID_INPUT");
  if (signal?.aborted) return _telegramError("TELEGRAM_ABORTED");
  const name = botName?.trim() || "Hermes Agent";
  _pruneTelegramPairings();
  // 创建期间也登记请求标识，initChannels 或过期清理可使迟到响应失效。
  const pendingId = Symbol("telegram-create");
  const rec = { expires_at_ts: Date.now() + 600000, bot_token: null, bot_username: null, owner_user_id: null };
  _telegramPairings.set(pendingId, rec);
  try {
    const data = await proxy.requestJson(`${TELEGRAM_ONBOARDING_URL}/v1/telegram/pairings`, _telegramRequestOptions(signal, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ bot_name: name }),
    }));
    const stale = _telegramPairingError(pendingId, rec, signal);
    if (stale) return stale;
    if (!_telegramObject(data) || !_telegramPairingId(data.pairing_id)
        || !_telegramText(data.poll_token, 2048) || !/^[A-Za-z0-9._~+/-]+=*$/.test(data.poll_token)
        || !_telegramText(data.expires_at, 40)
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(data.expires_at)
        || !_telegramLink(data.deep_link)
        || (data.qr_payload !== undefined && !_telegramLink(data.qr_payload))) return _telegramError("TELEGRAM_INVALID_RESPONSE");
    const expiresTs = Date.parse(data.expires_at);
    if (!Number.isFinite(expiresTs)) return _telegramError("TELEGRAM_INVALID_RESPONSE");
    if (expiresTs <= Date.now()) return _telegramError("TELEGRAM_SESSION_EXPIRED");
    const qrPayload = data.qr_payload ?? data.deep_link;
    // 仅下发配对链接，拒绝把服务端误放进公开字段的轮询凭证回传。
    if ([data.pairing_id, data.deep_link, qrPayload, data.expires_at].some(value =>
      value.includes(data.poll_token) || value.includes(encodeURIComponent(data.poll_token)))) return _telegramError("TELEGRAM_INVALID_RESPONSE");
    _pruneTelegramPairings();
    if (_telegramPairings.has(data.pairing_id)) return _telegramError("TELEGRAM_INVALID_RESPONSE");
    rec.poll_token = data.poll_token;
    rec.expires_at_ts = expiresTs;
    _telegramPairings.set(data.pairing_id, rec);
    return jsonRes({ ok: true, pairing_id: data.pairing_id, qr_payload: qrPayload, deep_link: data.deep_link, expires_at: data.expires_at });
  } catch {
    return _telegramPairingError(pendingId, rec, signal) || _telegramError("TELEGRAM_CREATE_FAILED");
  } finally {
    _telegramPairings.delete(pendingId);
  }
}

/**
 * Telegram 扫码：轮询状态，只有 getMe 验证通过的凭证才能成为 ready。
 * GET /api/channels/telegram/qr/status?pairing_id=...
 */
export async function handleTelegramQrStatus(pairingId, { signal } = {}) {
  if (!_telegramPairingId(pairingId)) return _telegramError("TELEGRAM_INVALID_INPUT");
  const proxy = telegramNetworkProxy;
  if (!proxy || typeof proxy.requestJson !== "function") return _telegramError("TELEGRAM_PROXY_REQUIRED");
  _pruneTelegramPairings();
  const rec = _telegramPairings.get(pairingId);
  if (!rec) return _telegramError("TELEGRAM_SESSION_MISSING");
  const inactive = _telegramPairingError(pairingId, rec, signal);
  if (inactive) return inactive;
  if (rec.bot_token) return _telegramReady(rec);
  let failureCode = "TELEGRAM_POLL_FAILED";
  try {
    const data = await proxy.requestJson(`${TELEGRAM_ONBOARDING_URL}/v1/telegram/pairings/${encodeURIComponent(pairingId)}`, _telegramRequestOptions(signal, {
      method: "GET", headers: { "Authorization": `Bearer ${rec.poll_token}`, "Accept": "application/json" },
    }));
    const stale = _telegramPairingError(pairingId, rec, signal);
    if (stale) return stale;
    if (!_telegramObject(data) || typeof data.status !== "string") return _telegramError("TELEGRAM_INVALID_RESPONSE");
    if (data.status === "waiting") return jsonRes({ ok: true, status: "waiting" });
    if (data.status === "ready") {
      const token = data.token;
      if (!_telegramToken(token)) return _telegramError("TELEGRAM_INVALID_TOKEN");
      const ownerId = data.owner_user_id == null ? null : _telegramUserId(data.owner_user_id);
      if ((data.owner_user_id != null && ownerId === null)
          || (data.bot_username != null && !_telegramUsername(data.bot_username))) return _telegramError("TELEGRAM_INVALID_RESPONSE");
      failureCode = "TELEGRAM_VERIFY_FAILED";
      const me = await proxy.requestJson("https://api.telegram.org/bot" + token + "/getMe", _telegramRequestOptions(signal, {
        method: "GET", headers: { "Accept": "application/json" },
      }));
      const expired = _telegramPairingError(pairingId, rec, signal);
      if (expired) return expired;
      if (!_telegramObject(me) || me.ok !== true || !_telegramObject(me.result) || me.result.is_bot !== true
          || typeof me.result.id !== "number" || _telegramUserId(me.result.id) !== token.split(":")[0]
          || (me.result.username != null && !_telegramUsername(me.result.username))) return _telegramError("TELEGRAM_VERIFY_FAILED");
      // 并发成功时保留首次已验证的结果。失败的 getMe 不得借缓存变成成功。
      if (!rec.bot_token) {
        rec.bot_token = token;
        rec.bot_username = me.result.username ?? null;
        rec.owner_user_id = ownerId;
      }
      return _telegramReady(rec);
    }
    if (data.status === "expired" || data.status === "claimed") {
      _telegramPairings.delete(pairingId);
      return _telegramError(data.status === "expired" ? "TELEGRAM_SESSION_EXPIRED" : "TELEGRAM_SESSION_CLAIMED");
    }
    return _telegramError("TELEGRAM_UNKNOWN_STATUS");
  } catch {
    return _telegramPairingError(pairingId, rec, signal) || _telegramError(failureCode);
  }
}

/**
 * Telegram 扫码：应用已验证凭证，保持同步保存与网关重启，不在写入阶段请求网络。
 * POST /api/channels/telegram/qr/apply  body: {pairing_id, allowed_user_ids}
 */
export function handleTelegramQrApply(body) {
  try {
    if (!_telegramObject(body) || typeof body.pairing_id !== "string") return _telegramError("TELEGRAM_INVALID_INPUT");
    const pairingId = body.pairing_id.trim();
    const rawAllowed = Array.isArray(body.allowed_user_ids) ? body.allowed_user_ids : String(body.allowed_user_ids || "").split(/[,;\s]+/);
    const allowedUserIds = [];
    for (const v of rawAllowed) {
      const norm = _normalizeTelegramUserId(v);
      if (norm && !allowedUserIds.includes(norm)) allowedUserIds.push(norm);
    }
    if (!_telegramPairingId(pairingId)) return _telegramError("TELEGRAM_INVALID_INPUT");
    if (allowedUserIds.length === 0) return _telegramError("TELEGRAM_ALLOWED_USERS_REQUIRED");
    _pruneTelegramPairings();
    const rec = _telegramPairings.get(pairingId);
    if (!rec) return _telegramError("TELEGRAM_SESSION_MISSING");
    if (!_telegramToken(rec.bot_token)) return _telegramError("TELEGRAM_NOT_READY");
    let env = readEnvFile();
    // 只替换凭证和白名单，保留 TELEGRAM_PROXY（含停用行）及通用代理设置。
    env = stripDisabledEnvLines(env, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS"]);
    env = setEnvValue(env, "TELEGRAM_BOT_TOKEN", rec.bot_token);
    env = setEnvValue(env, "TELEGRAM_ALLOWED_USERS", allowedUserIds.join(","));
    if (!writeEnvFile(env)) return _telegramError("TELEGRAM_ENV_WRITE_FAILED");
    const cfg = readPlatformConfig("telegram");
    // 和原逻辑一样清除暂存的旧凭证，但保留暂存的平台代理设置。
    if (_telegramObject(cfg._stash) && Object.hasOwn(cfg._stash, "proxy")) cfg._stash = { proxy: cfg._stash.proxy };
    else delete cfg._stash;
    cfg.enabled = true;
    cfg.allow_from = allowedUserIds.join(",");
    cfg.updated_at = Date.now();
    if (!writeHermesConfig(setPlatformConfig("telegram", cfg))) return _telegramError("TELEGRAM_CONFIG_WRITE_FAILED");
    _telegramPairings.delete(pairingId);
    const restart = _requestTelegramGatewayRestart();
    return jsonRes({ ok: true, bot_username: rec.bot_username, gateway_restarting: restart.restarting, gateway_restart_failed: restart.failed });
  } catch {
    return _telegramError("TELEGRAM_APPLY_FAILED");
  }
}

// ═══ QQ 机器人扫码（q.qq.com 绑定任务，AES-256-GCM 密钥仅保存在面板内存）═══
function _pruneQqbotTasks() {
  const now = Date.now();
  for (const [id, rec] of _qqbotTasks) { if (rec.expires_at_ts <= now) _qqbotTasks.delete(id); }
}

async function _qqPortalPost(path, payload) {
  const res = await _channelFetch(`https://${QQ_PORTAL_HOST}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": `QQBotAdapter/1.1.0 (Node/${process.versions.node}; ${process.platform}; Hermes/fnos-panel)`,
    },
    body: JSON.stringify(payload),
    redirect: "error", // 遇到重定向时不重新发送携带绑定密钥的 POST。
    timeoutMs: QQ_ONBOARD_TIMEOUT,
    signal: AbortSignal.timeout(QQ_ONBOARD_TIMEOUT),
  });
  if (!res.ok) throw new Error(`q.qq.com HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== "object") throw new Error("q.qq.com 返回了非 JSON 内容");
  if (data.retcode !== 0) throw new Error("q.qq.com 返回业务错误");
  return data.data || {};
}

// bot_encrypt_secret = base64(IV(12) ‖ ciphertext ‖ tag(16))
function _qqDecryptSecret(encryptedB64, keyB64) {
  const raw = Buffer.from(String(encryptedB64 || ""), "base64");
  if (raw.length < 12 + 16 + 1) throw new Error("加密密文长度异常");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString("utf8");
}

/**
 * QQ 机器人扫码：创建绑定任务
 * GET /api/channels/qqbot/qr
 */
export async function handleQqbotQr() {
  try {
    const key = randomBytes(32).toString("base64");
    const d = await _qqPortalPost("/lite/create_bind_task", { key });
    const taskId = String(d.task_id || "").trim();
    if (!taskId) throw new Error("接口未返回 task_id");
    _pruneQqbotTasks();
    _qqbotTasks.set(taskId, { key, expires_at_ts: Date.now() + QQ_ONBOARD_TTL, app_id: null, client_secret: null, user_openid: "" });
    const qrPayload = `https://q.qq.com/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&_wv=2&source=hermes`;
    return jsonRes({ ok: true, task_id: taskId, qr_payload: qrPayload });
  } catch (e) {
    return jsonRes({ ok: false, error: "无法创建 QQ 绑定任务：" + (e.message || e) }, 502);
  }
}

/**
 * QQ 机器人扫码：轮询状态
 * GET /api/channels/qqbot/qr/status?task_id=...
 * 上游 status：0 NONE / 1 PENDING / 2 COMPLETED / 3 EXPIRED
 */
export async function handleQqbotQrStatus(taskId) {
  if (!taskId) return jsonRes({ ok: false, error: "缺少 task_id" }, 400);
  try {
    _pruneQqbotTasks();
    const rec = _qqbotTasks.get(taskId);
    if (!rec) return jsonRes({ ok: false, error: "绑定任务不存在或已过期，请重新获取二维码" }, 404);
    if (rec.app_id) return jsonRes({ ok: true, status: "ready", app_id: rec.app_id, user_openid: rec.user_openid });
    const d = await _qqPortalPost("/lite/poll_bind_result", { task_id: taskId });
    const status = Number(d.status || 0);
    if (status === 2) {
      const appId = String(d.bot_appid || "").trim();
      const secret = _qqDecryptSecret(d.bot_encrypt_secret, rec.key);
      if (!appId || !secret) throw new Error("绑定结果缺少 AppID 或 AppSecret");
      rec.app_id = appId; rec.client_secret = secret; rec.user_openid = String(d.user_openid || "").trim();
      return jsonRes({ ok: true, status: "ready", app_id: appId, user_openid: rec.user_openid });
    }
    if (status === 3) {
      _qqbotTasks.delete(taskId);
      return jsonRes({ ok: false, status: "expired", error: "二维码已过期，请重新获取" }, 410);
    }
    // 0/1 都是尚未完成（接口不区分“已扫码未确认”）
    return jsonRes({ ok: true, status: "waiting" });
  } catch (e) {
    return jsonRes({ ok: false, error: "轮询 QQ 绑定状态失败：" + (e.message || e) }, 502);
  }
}

/**
 * QQ 机器人扫码：应用凭证
 * POST /api/channels/qqbot/qr/apply  body: {task_id, allowed_users}
 * 幂等：同一 task_id 首次 apply 写文件并重启网关，记录 rec.applied_at，
 * 之后（前端自动保存与用户手点“完成”并发）直接返回 already_applied，不再写文件/重启。
 * 任务记录保留到 TTL 到期，由 _pruneQqbotTasks 清理。
 */
export function handleQqbotQrApply(body) {
  try {
    const taskId = String(body.task_id || "").trim();
    if (!taskId) return jsonRes({ ok: false, error: "缺少 task_id" }, 400);
    _pruneQqbotTasks();
    const rec = _qqbotTasks.get(taskId);
    if (!rec) return jsonRes({ ok: false, error: "绑定任务不存在或已过期" }, 404);
    if (!rec.app_id || !rec.client_secret) return jsonRes({ ok: false, error: "尚未完成扫码绑定，请稍后再试" }, 409);
    if (rec.applied_at) return jsonRes({ ok: true, app_id: rec.app_id, already_applied: true, gateway_restarting: false, gateway_restart_failed: false });
    const rawAllowed = Array.isArray(body.allowed_users) ? body.allowed_users : String(body.allowed_users || "").split(/[,;\s]+/);
    const allowed = [];
    for (const v of rawAllowed) { const s = String(v || "").trim(); if (s && !allowed.includes(s)) allowed.push(s); }
    const allowedCsv = allowed.join(",");
    let env = readEnvFile();
    env = stripDisabledEnvLines(env, channelEnvKeys("qqbot", CHANNEL_DEFS.qqbot));
    env = setEnvValue(env, "QQ_APP_ID", rec.app_id);
    env = setEnvValue(env, "QQ_CLIENT_SECRET", rec.client_secret);
    env = setEnvValue(env, "QQ_ALLOWED_USERS", allowedCsv);
    if (!writeEnvFile(env)) return jsonRes({ ok: false, error: "写入 .env 失败，未变更既有配置" }, 500);
    const cfg = readPlatformConfig("qqbot");
    delete cfg._stash;
    const extra = (cfg.extra && typeof cfg.extra === "object") ? cfg.extra : {};
    cfg.extra = { ...extra, app_id: rec.app_id, client_secret: rec.client_secret };
    cfg.allow_from = allowedCsv;
    cfg.allowed_users = allowedCsv;
    cfg.enabled = true;
    cfg.updated_at = Date.now();
    if (!writeHermesConfig(setPlatformConfig("qqbot", cfg))) return jsonRes({ ok: false, error: "写入 config.yaml 失败" }, 500);
    rec.applied_at = Date.now();
    const restart = _requestGatewayRestart("qqbot-bind");
    return jsonRes({ ok: true, app_id: rec.app_id, already_applied: false, gateway_restarting: restart.restarting, gateway_restart_failed: restart.failed });
  } catch (e) {
    return jsonRes({ ok: false, error: e.message }, 500);
  }
}

// ═══ 企业微信智能机器人扫码（work.weixin.qq.com/ai/qc 接口。凭证仅保存在面板内存直至 apply）═══
function _pruneWecomQrSessions() {
  const now = Date.now();
  for (const [scode, rec] of _wecomQrSessions) { if (rec.expires_at_ts <= now) _wecomQrSessions.delete(scode); }
}

async function _wecomQrGet(path) {
  const res = await _channelFetch(`https://${WECOM_QR_HOST}${path}`, {
    method: "GET",
    headers: { "Accept": "application/json", "User-Agent": "HermesAgent/1.0" },
    timeoutMs: WECOM_QR_TIMEOUT,
    signal: AbortSignal.timeout(WECOM_QR_TIMEOUT),
  });
  if (!res.ok) throw new Error(`work.weixin.qq.com HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== "object") throw new Error("work.weixin.qq.com 返回了非 JSON 内容");
  return (data.data && typeof data.data === "object") ? data.data : {};
}

/**
 * 企业微信扫码：生成二维码
 * GET /api/channels/wecom/qr
 * 二维码内容为 auth_url（与上游 qr.add_data(auth_url) 一致），page_url 为可直接在手机企微打开的备用链接
 */
export async function handleWecomQr() {
  try {
    const d = await _wecomQrGet("/ai/qc/generate?source=hermes&plat=3");
    const scode = String(d.scode || "").trim();
    const authUrl = String(d.auth_url || "").trim();
    if (!scode || !authUrl) throw new Error("接口响应缺少 scode/auth_url");
    _pruneWecomQrSessions();
    _wecomQrSessions.set(scode, { expires_at_ts: Date.now() + WECOM_QR_TTL, last_poll_ts: 0, bot_id: null, secret: null, applied_at: 0 });
    const pageUrl = `https://${WECOM_QR_HOST}/ai/qc/gen?source=hermes&scode=${encodeURIComponent(scode)}`;
    return jsonRes({ ok: true, scode, qr_payload: authUrl, auth_url: authUrl, page_url: pageUrl, expires_in: Math.floor(WECOM_QR_TTL / 1000) });
  } catch (e) {
    return jsonRes({ ok: false, error: "无法生成企业微信二维码：" + (e.message || e) }, 502);
  }
}

/**
 * 企业微信扫码：轮询状态
 * GET /api/channels/wecom/qr/status?scode=...
 * 上游语义：data.status 小写 === "success" 才算完成，其余一律视为等待。bot_info.botid|bot_id / secret
 */
export async function handleWecomQrStatus(scode) {
  scode = String(scode || "").trim();
  if (!scode) return jsonRes({ ok: false, error: "缺少 scode" }, 400);
  try {
    _pruneWecomQrSessions();
    const rec = _wecomQrSessions.get(scode);
    if (!rec) return jsonRes({ ok: false, error: "扫码会话不存在或已过期，请重新获取二维码" }, 404);
    if (rec.bot_id) return jsonRes({ ok: true, status: "ready", bot_id: rec.bot_id, applied: !!rec.applied_at });
    const now = Date.now();
    if (rec.last_poll_ts && now - rec.last_poll_ts < WECOM_QR_STATUS_CACHE_MS) return jsonRes({ ok: true, status: "waiting", cached: true });
    rec.last_poll_ts = now;
    const d = await _wecomQrGet("/ai/qc/query_result?scode=" + encodeURIComponent(scode));
    const status = String(d.status || "").trim().toLowerCase();
    if (status !== "success") return jsonRes({ ok: true, status: "waiting" });
    const botInfo = (d.bot_info && typeof d.bot_info === "object") ? d.bot_info : {};
    const botId = String(botInfo.botid || botInfo.bot_id || "").trim();
    const secret = String(botInfo.secret || "").trim();
    if (!botId || !secret) {
      // 上游同样场景：扫码报告成功但企微侧未真正创建机器人 → 回退手动填写
      return jsonRes({ ok: false, status: "incomplete", error: "扫码已成功，但企业微信未返回机器人凭证（可能未真正创建机器人），请改为手动填写 Bot ID / Secret" }, 502);
    }
    rec.bot_id = botId; rec.secret = secret;
    return jsonRes({ ok: true, status: "ready", bot_id: botId, applied: false });
  } catch (e) {
    return jsonRes({ ok: false, error: "轮询企业微信扫码状态失败：" + (e.message || e) }, 502);
  }
}

/**
 * 企业微信扫码：应用凭证
 * POST /api/channels/wecom/qr/apply  body: {scode, allowed_users?}
 * 写 .env（WECOM_BOT_ID / WECOM_SECRET，可选 WECOM_ALLOWED_USERS）与 config.yaml platforms.wecom
 * （enabled / extra.bot_id / extra.secret / updated_at）。
 * 不写 toolsets：上游 v0.23.0 中 wecom 为 bundled platform 插件，按 kind=platform 自动延迟注册
 * （hermes_cli/plugins_discovery.py gate_manifest），启用判据是 WECOM_BOT_ID+WECOM_SECRET 或
 * platforms.wecom 配置块（plugins/platforms/wecom/gateway_env.py EnvCred），顶层 toolsets 键无读取者。
 * 幂等：同一 scode 二次 apply 返回 already_applied，不再写文件/重启。
 */
export function handleWecomQrApply(body) {
  try {
    const scode = String((body && body.scode) || "").trim();
    if (!scode) return jsonRes({ ok: false, error: "缺少 scode" }, 400);
    _pruneWecomQrSessions();
    const rec = _wecomQrSessions.get(scode);
    if (!rec) return jsonRes({ ok: false, error: "扫码会话不存在或已过期" }, 404);
    if (!rec.bot_id || !rec.secret) return jsonRes({ ok: false, error: "尚未完成扫码授权，请稍后再试" }, 409);
    if (rec.applied_at) return jsonRes({ ok: true, bot_id: rec.bot_id, already_applied: true, gateway_restarting: false, gateway_restart_failed: false });
    const rawAllowed = Array.isArray(body.allowed_users) ? body.allowed_users : String(body.allowed_users || "").split(/[,;\s]+/);
    const allowed = [];
    for (const v of rawAllowed) { const s = String(v || "").trim(); if (s && !allowed.includes(s)) allowed.push(s); }
    let env = readEnvFile();
    env = stripDisabledEnvLines(env, channelEnvKeys("wecom", CHANNEL_DEFS.wecom));
    env = setEnvValue(env, "WECOM_BOT_ID", rec.bot_id);
    env = setEnvValue(env, "WECOM_SECRET", rec.secret);
    if (allowed.length) env = setEnvValue(env, "WECOM_ALLOWED_USERS", allowed.join(","));
    if (!writeEnvFile(env)) return jsonRes({ ok: false, error: "写入 .env 失败，未变更既有配置" }, 500);
    const cfg = readPlatformConfig("wecom");
    delete cfg._stash;
    const extra = (cfg.extra && typeof cfg.extra === "object") ? cfg.extra : {};
    cfg.extra = { ...extra, bot_id: rec.bot_id, secret: rec.secret };
    if (allowed.length) cfg.allowed_users = allowed.join(",");
    cfg.enabled = true;
    cfg.updated_at = Date.now();
    if (!writeHermesConfig(setPlatformConfig("wecom", cfg))) return jsonRes({ ok: false, error: "写入 config.yaml 失败" }, 500);
    rec.applied_at = Date.now();
    const restart = _requestGatewayRestart("wecom-bind");
    return jsonRes({ ok: true, bot_id: rec.bot_id, already_applied: false, gateway_restarting: restart.restarting, gateway_restart_failed: restart.failed });
  } catch (e) {
    return jsonRes({ ok: false, error: e.message }, 500);
  }
}

/**
 * WhatsApp 扫码：启动配对
 * GET /api/channels/whatsapp/qr?mode=bot|self-chat
 */
export async function handleWhatsAppQr(mode, { signal } = {}) {
  try {
    const validMode = ["bot", "self-chat"].includes(mode) ? mode : "self-chat";
    if (!resolvedNodeBin) return jsonRes({ ok: false, error: "未找到 Node.js，无法启动 WhatsApp bridge" }, 500);
    const pairingId = randomBytes(16).toString("hex");
    const sessionDir = `${DATA_DIR}/whatsapp/session/${pairingId}`;
    const expiresTs = Date.now() + WHATSAPP_ONBOARDING_TTL;
    // 如果已有 creds.json，视为已配对
    if (existsSync(`${sessionDir}/creds.json`)) {
      _pruneWhatsAppPairings();
      _whatsappPairings.set(pairingId, { proc: null, status: "connected", qr_payload: "", mode: validMode, account_id: null, account_name: null, account_phone: null, error: null, expires_at_ts: expiresTs });
      return jsonRes({ ok: true, pairing_id: pairingId, status: "connected" });
    }
    const job = await _spawnWhatsAppPairing(sessionDir, validMode, signal);
    const proc = job.child;
    _pruneWhatsAppPairings();
    _whatsappPairings.set(pairingId, { proc, status: "starting", qr_payload: "", mode: validMode, account_id: null, account_name: null, account_phone: null, error: null, expires_at_ts: Date.now() + WHATSAPP_ONBOARDING_TTL });
    _watchWhatsAppPairing(pairingId, job);
    // 等待一小段时间让 QR 出来
    let initialQr = "";
    for (let i = 0; i < 30 && !initialQr; i++) {
      await new Promise(r => setTimeout(r, 200));
      const rec = _whatsappPairings.get(pairingId);
      initialQr = rec?.qr_payload || "";
      if (!rec || ["connected", "error", "expired", "cancelled"].includes(rec.status)) break;
    }
    const rec = _whatsappPairings.get(pairingId);
    return jsonRes({ ok: true, pairing_id: pairingId, status: rec?.status || "cancelled", qr_payload: initialQr, error: rec?.error || null });
  } catch (e) {
    return jsonRes({ ok: false, error: e.message === WHATSAPP_NETWORK_REQUIRED ? WHATSAPP_NETWORK_REQUIRED : "无法启动 WhatsApp 配对，请检查依赖与统一代理配置" }, 500);
  }
}

/**
 * WhatsApp 扫码：轮询状态
 * GET /api/channels/whatsapp/qr/status?pairing_id=...
 */
export function handleWhatsAppQrStatus(pairingId) {
  if (!pairingId) return jsonRes({ ok: false, error: "缺少 pairing_id" }, 400);
  _pruneWhatsAppPairings();
  const rec = _whatsappPairings.get(pairingId);
  if (!rec) return jsonRes({ ok: false, error: "配对会话不存在或已过期" }, 404);
  if (rec.status === "expired") return jsonRes({ ok: false, error: rec.error || "二维码已过期" }, 410);
  return jsonRes({
    ok: true, status: rec.status, qr_payload: rec.qr_payload,
    account_id: rec.account_id, account_name: rec.account_name, account_phone: rec.account_phone,
    error: rec.error,
  });
}

/**
 * WhatsApp 扫码：应用凭证
 * POST /api/channels/whatsapp/qr/apply  body: {pairing_id, allowed_users?}
 */
export function handleWhatsAppQrApply(body) {
  try {
    const pairingId = String(body.pairing_id || "").trim();
    if (!pairingId) return jsonRes({ ok: false, error: "缺少 pairing_id" }, 400);
    _pruneWhatsAppPairings();
    const rec = _whatsappPairings.get(pairingId);
    if (!rec) return jsonRes({ ok: false, error: "配对会话不存在或已过期" }, 404);
    if (rec.status !== "connected") return jsonRes({ ok: false, error: "WhatsApp 尚未配对完成" }, 409);
    const allowedUsers = _normalizeWhatsAppAllowedUsers(body.allowed_users != null ? body.allowed_users : (rec.account_phone || ""));
    let env = readEnvFile();
    // 清除本渠道遗留的 #_# 停用行后写入新凭证
    env = stripDisabledEnvLines(env, channelEnvKeys("whatsapp", CHANNEL_DEFS.whatsapp));
    env = setEnvValue(env, "WHATSAPP_MODE", rec.mode || "self-chat");
    env = setEnvValue(env, "WHATSAPP_DM_POLICY", "pairing");
    if (allowedUsers) env = setEnvValue(env, "WHATSAPP_ALLOWED_USERS", allowedUsers);
    env = setEnvValue(env, "WHATSAPP_ENABLED", "true");
    if (!writeEnvFile(env)) return jsonRes({ ok: false, error: "写入 .env 失败，未变更既有配置" }, 500);
    const cfg = readPlatformConfig("whatsapp");
    delete cfg._stash;
    cfg.enabled = true;
    cfg.allow_from = allowedUsers || "";
    cfg.updated_at = Date.now();
    if (!writeHermesConfig(setPlatformConfig("whatsapp", cfg))) return jsonRes({ ok: false, error: "写入 config.yaml 失败" }, 500);
    _whatsappPairings.delete(pairingId);
    // 写入后重启网关，确保白名单生效
    const restart = _requestGatewayRestart("whatsapp-bind");
    return jsonRes({ ok: true, account_id: rec.account_id, account_name: rec.account_name, gateway_restarting: restart.restarting, gateway_restart_failed: restart.failed });
  } catch (e) {
    return jsonRes({ ok: false, error: e.message }, 500);
  }
}
