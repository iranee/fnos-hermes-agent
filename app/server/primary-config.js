// primary-config.js — 主模型配置读写模块（整合版）
// 职责：providers-state.yaml 解析 / 序列化写入、config.yaml 的 model 段 + providers 段
// 构建与写入、.env.providers 保存与旧格式迁移、active provider key 同步到 Hermes .env、
// 已删除服务商的 key 清理，以及真实 API key 解析（resolveRealApiKey）。
// 
// 本文件整合了以下模块的功能：
// - provider-config.js (PROVIDER_PRESETS, PROVIDER_MODELS, PROVIDER_API_KEYS, etc.)
// - fallback-config.js (parseFallback, syncFallbackKeysToHermesEnv)
// - api-format.js (detectApiFormat, probeApiFormat, apiModeForFormat, normalizeApiFormat)
// - config-utils.js (customEnvKey, legacyCustomEnvKey, yamlScalar)
// - tool-names.js (TOOL_NAME_ZH, TOOL_EMOJI, toolDisplayName, toolEmoji)
// - chat-hardening.js (createCheckpointer, resumeStreamingMessages)
//
// 路径 / 日志 / 本机令牌等共用设施由 monitor.js 经 initPrimaryConfig 注入，本模块不重复定义。
import { readFileSync, writeFileSync, existsSync, lstatSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { resolve } from "path";
import { randomUUID } from "crypto";

// ─── 注入的运行时依赖 ─────────────────────────────────────────────────────
let P = {
  varDir: "",           // VAR_DIR（providers-state.yaml / .env.providers 所在目录）
  dataDir: "",          // DATA_DIR（config.yaml / Hermes .env 所在目录）
  log: () => {},        // monitor.js 的日志函数
  monitorToken: "",     // 本机监控令牌（LOCAL / hermes provider 直接用它鉴权）
  pythonBin: "",        // 默认 dataDir/venv/bin/python。必须能 import 官方 hermes_cli
  env: {},              // 子进程环境补充，例如只读官方源码的 PYTHONPATH
  networkProxy: null,    // 面板统一网络组件，在线请求必须注入，不回退原生 fetch
};

const NETWORK_PROXY_REQUIRED = "网络组件未初始化，请检查统一代理配置";
const NETWORK_REQUEST_FAILED = "网络组件请求失败，请检查统一代理配置";

export function initPrimaryConfig(deps) {
  P = { ...P, ...deps, networkProxy: deps.networkProxy || null };
}

// ─── 真实 API key 解析 ────────────────────────────────────────────────────
// 临时测试明文优先，持久凭证只通过 Hermes resolver + DATA/.env 解析。
// 不从进程旧 export、VAR/.env.providers 或 providers-state 回灌。
export function resolveRealApiKey(provider) {
  if (!provider || typeof provider !== "object") return null;
  if (!provider.source && (provider.base_url === "LOCAL" || provider.id === "hermes")) return P.monitorToken;
  const temporary = [provider._raw_api_key, provider.api_key].find(value =>
    typeof value === "string" && value && !value.includes("****") && !value.includes("${") &&
    !value.startsWith("<redacted") && !/[\r\n\0]/.test(value));
  if (temporary) return temporary;
  try {
    // New snapshot IDs are already Hermes IDs. Only old callers without source need the
    // panel's historical openai -> openai-api adapter.
    const id = provider.source ? provider.id : (PROVIDER_HERMES_IDS[provider.id] || provider.id);
    return runModelConfig({ action: "resolve-key", id, source: provider.source }).api_key || null;
  } catch { return null; }
}

// ─── providers-state.yaml 解析（GET/POST 共用） ─────────────────────────
// 解析格式: providers:\n  id:\n    model: xxx\n    base_url: yyy\n    name: "zzz"
export function parseProvidersState(stateYaml) {
  const map = {};
  const blockMatch = String(stateYaml || "").replace(/\r\n/g, "\n").match(/^providers:\n([\s\S]*)$/m);
  const scalar = text => {
    const value = text.trim();
    if (value.startsWith('"')) return JSON.parse(value);
    return value; // 旧版面板 state 中 model / base_url 不带引号。
  };
  if (!blockMatch) return map;
  const lines = blockMatch[1].split("\n");
  let curId = null, curModel = "", curBase = "", curName = "", curTemp = null, curMax = null, curFmt = "";
  const flush = () => {
    if (curId && curModel) {
      map[curId] = { model: curModel, base_url: curBase || "", name: curName || "", temperature: curTemp, max_tokens: curMax, api_format: curFmt };
    }
  };
  lines.forEach(line => {
    const keyMatch = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
    if (keyMatch) {
      // 保存上一个
      flush();
      curId = keyMatch[1]; curModel = ""; curBase = ""; curName = ""; curTemp = null; curMax = null; curFmt = "";
      return;
    }
    const m = line.match(/^    model:\s*(.+)\s*$/);
    if (m && curId) { curModel = scalar(m[1]); return; }
    const b = line.match(/^    base_url:\s*(.+)\s*$/);
    if (b && curId) { curBase = scalar(b[1]); return; }
    const n = line.match(/^    name:\s*(.+)\s*$/);
    if (n && curId) { try { curName = JSON.parse(n[1].trim()); } catch { curName = n[1].trim(); } }
    const t = line.match(/^    temperature:\s*(.+)\s*$/);
    if (t && curId) { const tv = parseFloat(t[1].trim()); if (!isNaN(tv)) curTemp = tv; }
    const x = line.match(/^    max_tokens:\s*(.+)\s*$/);
    if (x && curId) { const xv = parseInt(x[1].trim(), 10); if (!isNaN(xv)) curMax = xv; }
    const f = line.match(/^    api_format:\s*(.+)\s*$/);
    if (f && curId) { curFmt = normalizeApiFormat(scalar(f[1])); }
  });
  flush();
  return map;
}

// 读取并解析 providers-state.yaml。文件不存在返回空映射，读取异常向上抛出由调用方决定处置
export function loadProvidersState() {
  const statePath = `${P.varDir}/providers-state.yaml`;
  if (!existsSync(statePath)) return {};
  return parseProvidersState(readFileSync(statePath, "utf8"));
}

// ─── 模型保存的验证、前置准备与逐文件提交 ───────────────────────────────
function validateId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) ||
      ["constructor", "prototype", "__proto__"].includes(id)) {
    throw new TypeError("invalid provider id");
  }
  return id;
}

function singleLine(value, field) {
  if (typeof value !== "string" || /[\r\n\0]/.test(value)) {
    throw new TypeError(`${field} must be a string without newline/NUL`);
  }
  return value;
}

function validateConfigs(configs, active, fallbackIds) {
  if (!configs || typeof configs !== "object" || Array.isArray(configs)) throw new TypeError("invalid allProvConfig");
  validateId(active);
  if (!Object.hasOwn(configs, active)) throw new TypeError("active provider is not configured");
  const envOwners = new Map();
  for (const [id, cfg] of Object.entries(configs)) {
    validateId(id);
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new TypeError("invalid provider config");
    if (!singleLine(cfg.model, "model").trim()) throw new TypeError("model is required");
    for (const field of ["base_url", "name", "api_format"]) {
      if (cfg[field] != null) singleLine(cfg[field], field);
    }
    if (cfg.api_format && !["openai", "anthropic", "anthropic_messages", "chat_completions"].includes(cfg.api_format)) {
      throw new TypeError("invalid api_format");
    }
    if (cfg.temperature != null && (typeof cfg.temperature !== "number" || !Number.isFinite(cfg.temperature))) throw new TypeError("invalid temperature");
    if (cfg.max_tokens != null && (!Number.isSafeInteger(cfg.max_tokens) || cfg.max_tokens < 1)) throw new TypeError("invalid max_tokens");
    const key = providerEnvKey(id);
    if (envOwners.has(key)) throw new TypeError("provider ids collide on an environment variable");
    envOwners.set(key, id);
  }
  if (fallbackIds != null) {
    if (!Array.isArray(fallbackIds)) throw new TypeError("invalid fallbackIds");
    const seen = new Set();
    for (const id of fallbackIds) {
      validateId(id);
      if (!Object.hasOwn(configs, id) || id === active || seen.has(id)) throw new TypeError("invalid fallback provider");
      seen.add(id);
    }
  }
}

function providerEnvKey(id) {
  validateId(id);
  return Object.hasOwn(PROVIDER_API_KEYS, id) ? PROVIDER_API_KEYS[id] : customEnvKey(id);
}

// 只有 ENOENT 表示文件不存在。不掩盖权限错误，不跟随符号链接。
function snapshot(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`not a regular file: ${path}`);
    return { path, content: readFileSync(path, "utf8"), mode: stat.mode & 0o777 };
  } catch (e) {
    if (e.code === "ENOENT") return { path, content: null, mode: 0o600 };
    throw e;
  }
}

function stageFile(before, content) {
  const staged = { ...before, next: content, temp: `${before.path}.${randomUUID()}.tmp` };
  try {
    const fd = openSync(staged.temp, "wx", before.mode);
    try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  } catch (e) {
    try { unlinkSync(staged.temp); } catch (cleanup) { if (cleanup.code !== "ENOENT") e.cleanupError = cleanup.message; }
    throw e;
  }
  return staged;
}

function commitFile(staged) {
  if (snapshot(staged.path).content !== staged.content) throw new Error(`file changed during save: ${staged.path}`);
  renameSync(staged.temp, staged.path);
  staged.temp = null;
}

function discardStages(stages) {
  const errors = [];
  for (const staged of stages) {
    if (!staged.temp) continue;
    try { unlinkSync(staged.temp); } catch (e) { if (e.code !== "ENOENT") errors.push(`${staged.temp}: ${e.message}`); }
  }
  return errors;
}

function atomicTextWrite(path, content) {
  const staged = stageFile(snapshot(path), content);
  try { commitFile(staged); } catch (e) { e.cleanupErrors = discardStages([staged]); throw e; }
}

function serializeProvidersState(allProvConfig, activeProviderId) {
  validateConfigs(allProvConfig, activeProviderId, null);
  const entries = Object.entries(allProvConfig).sort(([a], [b]) =>
    a === activeProviderId ? -1 : b === activeProviderId ? 1 : a.localeCompare(b));
  return `providers:\n${entries.map(([id, cfg]) => {
    const fields = ["model", "base_url", "name", "temperature", "max_tokens", "api_format"];
    return `  ${id}:\n` + fields.filter(f => cfg[f] != null && cfg[f] !== "")
      .map(f => `    ${f}: ${JSON.stringify(cfg[f])}`).join("\n");
  }).join("\n")}\n`;
}

export function writeProvidersState(allProvConfig, activeProviderId) {
  atomicTextWrite(`${P.varDir}/providers-state.yaml`, serializeProvidersState(allProvConfig, activeProviderId));
}

function modelPayload({ allProvConfig, providerId, fallbackIds }, oldIds) {
  validateConfigs(allProvConfig, providerId, fallbackIds);
  return {
    providerId, fallbackIds: fallbackIds ?? null, oldIds,
    providers: Object.entries(allProvConfig).map(([id, cfg]) => ({
      id, ...Object.fromEntries(["model", "base_url", "temperature", "max_tokens", "api_format"]
        .filter(k => cfg[k] != null).map(k => [k, cfg[k]])),
      hermesId: Object.hasOwn(PROVIDER_HERMES_IDS, id) ? PROVIDER_HERMES_IDS[id] : id,
      custom: !Object.hasOwn(PROVIDER_PRESETS, id) || PROVIDER_CLASSES[id] === "B",
      envKey: id.startsWith("local-") ? "" : providerEnvKey(id),
      apiMode: ["anthropic", "anthropic_messages"].includes(cfg.api_format || detectApiFormat(cfg.base_url, "").format)
        ? "anthropic_messages" : "chat_completions",
    })),
  };
}

function runModelConfig(payload) {
  if (!P.dataDir) throw new Error("dataDir is required");
  const command = P.runtime ? P.runtime.command(["--home", resolve(P.dataDir)], { helper: "model-config" }) : {
    executable: P.pythonBin || `${P.dataDir}/venv/bin/python`,
    args: ["-B", fileURLToPath(new URL("./model-config.py", import.meta.url)), "--home", resolve(P.dataDir)],
    env: { ...process.env, ...P.env, HERMES_HOME: resolve(P.dataDir), PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" },
  };
  const child = spawnSync(command.executable, command.args, {
    input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30000,
    env: command.env, cwd: command.cwd,
  });
  const uncertain = payload.action === "patch";
  const transportError = message => Object.assign(new Error(message), {
    status: 500, phase: "subprocess", committed: [],
    configWriteUncertain: uncertain, envWriteUncertain: uncertain,
  });
  if (child.error) throw transportError(`model-config subprocess failed: ${child.error.code || "unknown"}`);
  let result;
  try { result = JSON.parse(child.stdout); } catch { throw transportError(`model-config.py failed (exit ${child.status}); no valid JSON response`); }
  if (child.status !== 0 || !result.ok) {
    const error = new Error(result.error || `model-config.py failed (exit ${child.status})`);
    for (const key of ["status", "phase", "committed", "configWriteUncertain", "envWriteUncertain"]) {
      if (Object.hasOwn(result, key)) error[key] = result[key];
    }
    throw error;
  }
  return result;
}

/** Real DATA/config.yaml + DATA/.env snapshot; no migration, defaults or VAR reads. */
export function readModelConfiguration() {
  return runModelConfig({ action: "snapshot" });
}

/** Resolve an explicit source/id against the real snapshot, never panel aliases or VAR state.
 * A draft may override routing, but stored credentials must not follow an edited URL.
 * An omitted key resolves from DATA; an explicit empty key tests without credentials.
 */
export function resolveModelTestProvider(input) {
  const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
  if (input != null && (typeof input !== "object" || Array.isArray(input))) fail("invalid provider");
  const snapshot = readModelConfiguration();
  let stored;
  if (input == null) {
    const active = snapshot.providers.filter(p => p.is_current);
    if (active.length !== 1) fail("当前模型路由不唯一或未配置，请先选择服务", 409);
    stored = active[0];
  } else if (Object.hasOwn(input, "id")) {
    if (typeof input.id !== "string" || typeof input.source !== "string") fail("provider id and source are required");
    const matches = snapshot.providers.filter(p => p.id === input.id && p.source === input.source);
    if (matches.length !== 1) fail("服务已变更或身份不唯一，请重新读取配置", 409);
    stored = matches[0];
  } else if (input.source && input.source !== "providers") fail("invalid draft source");
  const draft = input || {};
  const provider = { ...(stored || {}) };
  for (const field of ["base_url", "api_mode", "model"]) {
    if (Object.hasOwn(draft, field)) {
      if (typeof draft[field] !== "string" || /[\r\n\0]/.test(draft[field])) fail(`invalid ${field}`);
      provider[field] = draft[field];
    }
  }
  let route;
  try { route = new URL(provider.base_url); } catch { fail("此服务没有可用的模型列表地址，可使用配置列表或手动输入"); }
  if (!["http:", "https:"].includes(route.protocol) || route.username || route.password || route.hash) fail("模型列表地址必须是无内嵌凭证的 HTTP(S) 地址");
  if (stored?.extra_headers_configured || stored?.key_cmd_configured || (stored?.is_current &&
      (snapshot.model.extra_headers_configured || snapshot.model.key_cmd_configured))) {
    fail("此路由使用附加请求头或动态凭证，面板不执行这些认证方式；请使用配置列表或手动输入");
  }
  if (Object.hasOwn(draft, "api_key")) {
    singleLine(draft.api_key, "api_key");
    if (/[^\x21-\x7e]/.test(draft.api_key) || draft.api_key.includes("****") || draft.api_key.includes("${") || draft.api_key.startsWith("<redacted")) fail("不能使用掩码或无效凭证测试");
    provider.api_key = draft.api_key;
  } else {
    if (stored && new URL(stored.base_url).href !== route.href) fail("地址已修改，请显式输入用于新地址的 API Key；不会转发原凭证");
    provider.api_key = stored ? runModelConfig({ action: "resolve-key", id: stored.id, source: stored.source }).api_key || "" : "";
    if (stored && readModelConfiguration().revision !== snapshot.revision) fail("读取凭证期间配置已变更，请重新读取后测试", 409);
  }
  if (stored?.auth_type && stored.auth_type !== "api_key" && !provider.api_key) fail("此服务使用交互式认证，面板不刷新认证；可使用官方内置目录或手动输入");
  return provider;
}

/** Only explicit remote responses count as a successful discovery. No catalogue fallbacks. */
export async function fetchGatewayModels(provider, userAgent = "Hermes-Panel") {
  const started = Date.now();
  try {
    const base = new URL(provider.base_url);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("不支持此模型列表地址");
    if (provider.api_mode && !["chat_completions", "codex_responses", "anthropic_messages"].includes(provider.api_mode)) throw new Error("此协议未提供面板可读取的模型列表，请使用配置列表或手动输入");
    const anthropic = provider.api_mode === "anthropic_messages";
    let pathname = base.pathname.replace(/\/+$/, "").replace(/\/(messages|chat\/completions|responses)$/, "");
    if (anthropic && !pathname.endsWith("/v1")) pathname += "/v1";
    base.pathname = pathname + "/models";
    const headers = { Accept: "application/json", "User-Agent": userAgent };
    if (anthropic) headers["anthropic-version"] = "2023-06-01";
    if (provider.api_key) headers[anthropic ? "x-api-key" : "Authorization"] = anthropic ? provider.api_key : `Bearer ${provider.api_key}`;
    // Never forward credentials through an upstream redirect or bypass the injected proxy.
    if (typeof P.networkProxy?.fetch !== "function") throw new Error(NETWORK_PROXY_REQUIRED);
    let response;
    try {
      response = await P.networkProxy.fetch(base, { method: "GET", headers, redirect: "error",
        timeoutMs: 10000, signal: AbortSignal.timeout(10000) });
    } catch { throw new Error(NETWORK_REQUEST_FAILED); }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json().catch(() => { throw new Error("远程响应不是模型列表"); });
    const entries = data.data ?? data.models;
    if (!Array.isArray(entries)) throw new Error("远程响应不是模型列表");
    const ids = entries.map(m => typeof m === "string" ? m : m?.id || m?.name);
    if (ids.some(id => typeof id !== "string" || !id.trim())) throw new Error("远程模型列表包含无效条目");
    return { ok: true, source: "remote", models: [...new Set(ids)].map(id => ({ id, name: id })),
      partial: data.has_more === true || !!data.next_page_token, latency: Date.now() - started };
  } catch (error) {
    return { ok: false, source: "remote", models: [], error: error.message, latency: Date.now() - started };
  }
}

/** Precise optional-field patch. expectedRevision from GET is mandatory (409 on mismatch).
 * providers: [{id, source?, changes?, api_key?}], removeProviderIds: [id],
 * model: {provider?, default?, temperature?, max_tokens?, context_length?, reasoning_effort?},
 * fallback_providers: complete raw object list. Omission preserves; api_key:"" clears.
 * Success: {ok, revision, committed, configWriteUncertain, envWriteUncertain}.
 * Errors carry status/phase/committed/uncertainty; never retry automatically or roll back.
 */
export function patchModelConfiguration(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw Object.assign(new TypeError("patch payload must be an object"), { status: 400, committed: [], configWriteUncertain: false, envWriteUncertain: false });
  }
  return runModelConfig({ ...payload, action: "patch" });
}

/** 同步执行，返回 {ok:true, committed}，或抛出带 phase/committed/cleanupErrors 的错误。
 * 所有内容先准备好，再按 keys -> Hermes .env -> config -> state 的顺序发布。
 * 每次替换是原子的，但整组不是：崩溃或靠后的错误可能让前面的文件已经提交。
 * 绝不通过回滚去覆盖其他程序的写入。只提交了一部分时，会在错误的 phase/committed 中明确报告。
 */
export function saveModelConfiguration({ providers, allProvConfig, providerId, fallbackIds }) {
  const committed = [], staged = [];
  let phase = "validate";
  try {
    if (!P.dataDir || !P.varDir) throw new Error("dataDir and varDir are required");
    validateConfigs(allProvConfig, providerId, fallbackIds);
    validateKeyProviders(providers);
    const ids = Object.keys(allProvConfig);
    if (providers.length !== ids.length || providers.some(p => !Object.hasOwn(allProvConfig, p.id))) throw new TypeError("providers and allProvConfig must contain the same ids");
    const oldIds = Object.keys(loadProvidersState());
    const payload = modelPayload({ allProvConfig, providerId, fallbackIds }, oldIds);
    const stateContent = serializeProvidersState(allProvConfig, providerId);
    phase = "prepare";
    const panel = snapshot(`${P.varDir}/.env.providers`), hermes = snapshot(`${P.dataDir}/.env`);
    const state = snapshot(`${P.varDir}/providers-state.yaml`);
    const panelContent = prepareProviderKeys(providers, panel.content || "", oldIds);
    const hermesContent = prepareHermesKeys(ids, panelContent, hermes.content || "");
    const plan = runModelConfig({ ...payload, action: "prepare" });
    for (const [before, content] of [[panel, panelContent], [hermes, hermesContent], [state, stateContent]]) {
      staged.push(stageFile(before, content));
    }
    for (const entry of staged.slice(0, 2)) {
      phase = entry.path; commitFile(entry); committed.push(entry.path);
    }
    phase = "config.yaml";
    runModelConfig({ ...payload, action: "commit", expectedRevision: plan.revision });
    committed.push(`${P.dataDir}/config.yaml`);
    phase = state.path; commitFile(staged[2]); committed.push(state.path);
    return { ok: true, committed };
  } catch (cause) {
    const cleanupErrors = discardStages(staged);
    const configWriteUncertain = phase === "config.yaml";
    const error = new Error(`model configuration save failed at ${phase}: ${cause.message}; committed: ${committed.join(", ") || "none"}. Cross-file atomicity is not guaranteed.${configWriteUncertain ? " The config subprocess may have written before failing; inspect config.yaml before retrying." : ""}`, { cause });
    Object.assign(error, { phase, committed, cleanupErrors, configWriteUncertain });
    throw error;
  }
}

// ─── config.yaml 的 model 段 + providers 段 + fallback 段构建与写入 ────────
// 返回 { ok: true } 或 { ok: false, error }（写失败属致命，由调用方返回 500）。
export function writeConfigYaml({ allProvConfig, providerId, fallbackIds }) {
  try {
    const payload = modelPayload({ allProvConfig, providerId, fallbackIds }, Object.keys(loadProvidersState()));
    const plan = runModelConfig({ ...payload, action: "prepare" });
    runModelConfig({ ...payload, action: "commit", expectedRevision: plan.revision });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "write config.yaml: " + e.message };
  }
}

function validateKeyProviders(providers) {
  if (!Array.isArray(providers)) throw new TypeError("providers must be an array");
  const seen = new Set();
  for (const p of providers) {
    validateId(p?.id);
    const envKey = providerEnvKey(p.id);
    if (seen.has(envKey)) throw new TypeError("duplicate provider or environment variable");
    seen.add(envKey);
    for (const field of ["api_key", "_raw_api_key"]) {
      if (p[field] != null) singleLine(p[field], field);
    }
  }
}

function envLineRegex(key, flags = "m") {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new TypeError("invalid environment variable");
  return new RegExp(`^(?:export[ \t]+)?${key}[ \t]*=[^\r\n]*`, flags);
}

function envValue(content, key) {
  const matches = [...content.matchAll(envLineRegex(key, "gm"))];
  if (!matches.length) return null;
  const value = matches.at(-1)[0].slice(matches.at(-1)[0].indexOf("=") + 1);
  singleLine(value, "stored API key");
  // 不静默截断多行 dotenv 值（无论合法还是畸形）。
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') || trimmed.startsWith("'")) &&
      (trimmed.length < 2 || !trimmed.endsWith(trimmed[0]))) throw new Error(`multiline or unterminated key: ${key}`);
  return value;
}

function finalNewline(content) {
  return content && !content.endsWith("\n") ? content + "\n" : content;
}

function putEnv(content, key, value) {
  singleLine(value, "API key");
  const re = envLineRegex(key, "gm");
  if (re.test(content)) return finalNewline(content.replace(re, () => `${key}=${value}`));
  return finalNewline(content) + `${key}=${value}\n`;
}

function removeEnv(content, key) {
  const re = envLineRegex(key);
  return content.split(/\r?\n/).filter(line => !re.test(line)).join("\n");
}

function prepareProviderKeys(providers, content, oldIds = []) {
  validateKeyProviders(providers);
  for (const p of providers) {
    if (p.id.startsWith("local-")) continue;
    const key = providerEnvKey(p.id);
    const raw = [p._raw_api_key, p.api_key].find(v => v && v !== "none" && !v.startsWith("****"));
    if (raw) content = putEnv(content, key, raw);
    if (!Object.hasOwn(PROVIDER_API_KEYS, p.id)) {
      const legacy = legacyCustomEnvKey(p.id);
      const oldValue = envValue(content, legacy);
      if (!envValue(content, key) && oldValue) content = putEnv(content, key, oldValue);
      content = removeEnv(content, legacy);
    }
  }
  const keep = new Set(providers.map(p => providerEnvKey(p.id)));
  for (const id of oldIds) {
    const key = providerEnvKey(id);
    if (!keep.has(key)) {
      content = removeEnv(content, key);
      if (!Object.hasOwn(PROVIDER_API_KEYS, id)) content = removeEnv(content, legacyCustomEnvKey(id));
    }
  }
  return finalNewline(content);
}

function prepareHermesKeys(ids, panelContent, content) {
  for (const id of ids) {
    validateId(id);
    if (id.startsWith("local-")) continue;
    const key = providerEnvKey(id);
    const legacy = Object.hasOwn(PROVIDER_API_KEYS, id) ? null : legacyCustomEnvKey(id);
    const value = envValue(panelContent, key) || (legacy && envValue(panelContent, legacy)) ||
      envValue(content, key) || (legacy && envValue(content, legacy));
    if (value && !value.trim().startsWith("****")) content = putEnv(content, key, value);
    // 只迁移已配置的服务商，其他凭证不归面板管理。
    if (legacy && value) content = removeEnv(content, legacy);
  }
  return finalNewline(content);
}

export function saveProviderKeysToEnv(providers) {
  const path = `${P.varDir}/.env.providers`;
  const before = snapshot(path);
  const content = prepareProviderKeys(providers, before.content || "");
  if (content !== (before.content || "")) atomicTextWrite(path, content);
}

export function syncActiveKeyToHermesEnv(providerId) {
  validateId(providerId);
  const path = `${P.dataDir}/.env`;
  const before = snapshot(path);
  const panel = snapshot(`${P.varDir}/.env.providers`);
  const content = prepareHermesKeys([providerId], panel.content || "", before.content || "");
  if (content !== (before.content || "")) atomicTextWrite(path, content);
}

// ─── bridge 对话主模型解析 ─────────────────────────────────────
// 将面板 active provider 解析为 bridge chat 请求的 {model, provider} 字段：
// provider 经 PROVIDER_HERMES_IDS 映射，与 writeConfigYaml 写 config.yaml model 段
// 同源（即与网关/微信链路一致），base_url/api_key 由 hermes 侧 runtime_provider
// 自行从 config.yaml providers 段 + .env 解析，无需随请求传递。
// LOCAL/hermes（本地引擎默认）或解析失败返回 null，调用方不传字段，
// bridge 回落 config.yaml 默认模型（现状行为）。
export function resolveBridgePrimary(provider) {
  try {
    if (!provider || typeof provider !== "object") return null;
    if (provider.base_url === "LOCAL" || provider.id === "hermes") return null;
    const model = String(provider.model || "").trim();
    const id = String(provider.id || "").trim();
    if (!model || !id) return null;
    return { model, provider: PROVIDER_HERMES_IDS[id] || id };
  } catch { return null; }
}

// 只删除旧面板 state 拥有的 key，无关的工具凭证保留。
export function cleanupRemovedProviderKeys(providers) {
  const path = `${P.varDir}/.env.providers`;
  const before = snapshot(path);
  const content = prepareProviderKeys(providers, before.content || "", Object.keys(loadProvidersState()));
  if (content !== (before.content || "")) atomicTextWrite(path, content);
}

// ============================================================================
// SECTION 2: PROVIDER CONFIGURATION DATA（来自 provider-config.js）
// ============================================================================

// ── 供应商预设 ──────────────────────────────────────────────
export const PROVIDER_PRESETS = {
  "openai":          { name: "OpenAI",        base_url: "https://api.openai.com/v1" },
  "deepseek":        { name: "DeepSeek",       base_url: "https://api.deepseek.com" },
  "anthropic":       { name: "Anthropic",      base_url: "https://api.anthropic.com/v1" },
  "gemini":          { name: "Google AI",     base_url: "https://generativelanguage.googleapis.com/v1beta/openai" },
  "kimi-coding":     { name: "Moonshot/Kimi",  base_url: "https://api.moonshot.ai/v1" },
  "kimi-coding-cn":  { name: "MoonshotCN",     base_url: "https://api.moonshot.cn/v1" },
  "zai":             { name: "智谱 AI",          base_url: "https://open.bigmodel.cn/api/paas/v4" },
  "minimax-cn":      { name: "MiniMax (国内)", base_url: "https://api.minimaxi.com/v1" },
  "minimax":         { name: "MiniMax (国际)", base_url: "https://api.minimax.io/v1" },
  "siliconflow":     { name: "SiliconFlow",    base_url: "https://api.siliconflow.cn/v1" },
  "openrouter":      { name: "OpenRouter",     base_url: "https://openrouter.ai/api/v1" },
  "xai":             { name: "xAI",            base_url: "https://api.x.ai/v1" },
  "mistral":         { name: "Mistral",        base_url: "https://api.mistral.ai/v1" },
  "nvidia":          { name: "NVIDIA",         base_url: "https://integrate.api.nvidia.com/v1" },
  "huggingface":     { name: "HuggingFace",    base_url: "https://api-inference.huggingface.co/v1" },
  "ollama-cloud":    { name: "Ollama Cloud",   base_url: "https://ollama.com/v1" },
  "lmstudio":        { name: "LM Studio",      base_url: "http://localhost:1234/v1" },
  "alibaba":         { name: "通义千问",        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  // ── Hermes 内置 api_key 类供应商（权威值取自 auth.py PROVIDER_REGISTRY） ──
  "stepfun":             { name: "StepFun Step Plan",          base_url: "https://api.stepfun.ai/step_plan/v1" },
  "arcee":               { name: "Arcee AI",                   base_url: "https://api.arcee.ai/api/v1" },
  "gmi":                 { name: "GMI Cloud",                  base_url: "https://api.gmi-serving.com/v1" },
  "kilocode":            { name: "Kilo Code",                  base_url: "https://api.kilo.ai/api/gateway" },
  "alibaba-coding-plan": { name: "Alibaba Cloud (Coding Plan)", base_url: "https://coding-intl.dashscope.aliyuncs.com/v1" },
  "xiaomi":              { name: "Xiaomi MiMo",                base_url: "https://api.xiaomimimo.com/v1" },
  "tencent-tokenhub":    { name: "Tencent TokenHub",           base_url: "https://tokenhub.tencentmaas.com/v1" },
};

// ── 每个供应商的可用模型列表（只保留当前主力型号） ────────────────────────
export const PROVIDER_MODELS = {
  "openai": [
    "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
    "gpt-5.3-codex", "o4-mini", "o3",
  ],
  "deepseek": [
    "deepseek-v4-flash", "deepseek-v4-pro",
  ],
  "anthropic": [
    "claude-fable-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5-20251001",
  ],
  "gemini": [
    "gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite",
  ],
  "kimi-coding": [
    "kimi-k2.7-code", "kimi-k2.6", "moonshot-v1-128k",
  ],
  "kimi-coding-cn": [
    "kimi-k2.7-code", "kimi-k2.6", "moonshot-v1-128k",
  ],
  "zai": [
    "glm-5.1", "glm-5", "glm-4.7", "glm-4.6v",
  ],
  "minimax-cn": [
    "MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5",
  ],
  "minimax": [
    "MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5",
  ],
  "siliconflow": [
    "deepseek-ai/DeepSeek-V3.2", "Qwen/Qwen3.6-235B-A22B", "zai-org/GLM-5.1",
  ],
  "openrouter": [
    "openai/gpt-5.5", "anthropic/claude-sonnet-5",
    "google/gemini-3.1-pro-preview", "deepseek/deepseek-v4-pro",
  ],
  "xai": [
    // grok-4.1-fast 家族已于 2026-05-15 下线，此处仅保留当前在售型号
    "grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning",
  ],
  "mistral": [
    "mistral-large-latest", "mistral-medium-latest", "mistral-small-latest", "codestral-latest",
  ],
  "nvidia":          ["meta/llama-3.1-70b-instruct", "minimaxai/minimax-m2.7"],
  "huggingface":     ["meta-llama/Meta-Llama-3-70B-Instruct"],
  "ollama-cloud":    ["gpt-oss:120b", "qwen3-coder:480b-cloud", "glm-4.6:cloud"],
  "ollama-local":    ["llama3.2", "qwen2.5-coder:7b", "gemma2:9b", "mistral:7b", "phi3:mini"],
  "lmstudio":        ["local-model", "custom-model"],
  "alibaba": [
    "qwen-plus", "qwen-max", "qwen3.5-plus", "qwen3-max-2026-01-23", "qwen3-coder-next",
  ],
  // ── Hermes 内置 api_key 类供应商（模型取自 hermes_cli/models.py） ──
  "stepfun": [
    "step-3.5-flash", "step-3.5-flash-2603",
  ],
  "arcee": [
    "trinity-large-thinking", "trinity-large-preview", "trinity-mini",
  ],
  "gmi": [
    "zai-org/GLM-5.1-FP8", "deepseek-ai/DeepSeek-V3.2", "moonshotai/Kimi-K2.5", "google/gemini-3.1-flash-lite-preview",
  ],
  "kilocode": [
    "anthropic/claude-opus-4.6", "anthropic/claude-sonnet-4.6", "openai/gpt-5.4", "google/gemini-3-pro-preview",
  ],
  "alibaba-coding-plan": [
    "qwen3.7-max", "qwen3.6-plus", "qwen3.5-plus", "qwen3-coder-plus",
  ],
  "xiaomi": [
    "mimo-v2.5-pro", "mimo-v2.5", "mimo-v2-pro", "mimo-v2-omni",
  ],
  "tencent-tokenhub": [
    "hy3-preview",
  ],
};

// ── 供应商 → 环境变量名映射 ─────────────────────────────────────────
export const PROVIDER_API_KEYS = {
  "openai": "OPENAI_API_KEY",       "deepseek": "DEEPSEEK_API_KEY",
  "anthropic": "ANTHROPIC_API_KEY",  "gemini": "GOOGLE_API_KEY",
  "kimi-coding": "KIMI_API_KEY",    "kimi-coding-cn": "KIMI_CN_API_KEY",
  "zai": "ZAI_API_KEY",             "minimax-cn": "MINIMAX_CN_API_KEY",
  "minimax": "MINIMAX_API_KEY",     "siliconflow": "SILICONFLOW_API_KEY",
  "openrouter": "OPENROUTER_API_KEY","xai": "XAI_API_KEY",
  "mistral": "MISTRAL_API_KEY",     "nvidia": "NVIDIA_API_KEY",
  "huggingface": "HF_TOKEN",        "ollama-cloud": "OLLAMA_API_KEY",
  "ollama-local": "OLLAMA_LOCAL_API_KEY", "lmstudio": "LMSTUDIO_API_KEY", "alibaba": "DASHSCOPE_API_KEY",
  // ── Hermes 内置 api_key 类供应商（主环境变量名取自 auth.py api_key_env_vars） ──
  "stepfun": "STEPFUN_API_KEY",     "arcee": "ARCEEAI_API_KEY",
  "gmi": "GMI_API_KEY",             "kilocode": "KILOCODE_API_KEY",
  "alibaba-coding-plan": "ALIBABA_CODING_PLAN_API_KEY",
  "xiaomi": "XIAOMI_API_KEY",       "tencent-tokenhub": "TOKENHUB_API_KEY",
};

// ── A/B 分类 ─────────────────────────────────────
// A 类：仅写 model 段，端点与原生协议交给 Hermes 内置 PROVIDER_REGISTRY 处理，
// B 类：必须写 providers 段（base_url + api_key + default_model）。
// 注：动态 id 约定如下。custom-*（第三方自定义服务商，写 providers 段含 api_key）、
//     local-*（本地 OpenAI 兼容端点，写 providers 段仅 base_url + default_model，省略 api_key），
//     二者均不在此表中，按"非预设"走 providers 段逻辑（详见 monitor.js customEntries）。
export const PROVIDER_CLASSES = {
  "openai": "A",         "openrouter": "A",     "anthropic": "A",
  "deepseek": "A",       "gemini": "A",         "kimi-coding": "A",
  "kimi-coding-cn": "A", "zai": "A",            "minimax": "A",
  "minimax-cn": "A",     "xai": "A",            "nvidia": "A",
  "huggingface": "A",    "lmstudio": "B",       "alibaba": "A",
  "siliconflow": "B",    "mistral": "B",        "ollama-cloud": "B",
  "ollama-local": "B",
  // ── 以下供应商均为 Hermes 内置（A 类：只写 model 段、base_url 编辑框只读） ──
  "stepfun": "A",        "arcee": "A",          "gmi": "A",
  "kilocode": "A",       "alibaba-coding-plan": "A",  "xiaomi": "A",
  "tencent-tokenhub": "A",
};

// ── provider id → Hermes 内部 provider id 映射 ───────────────────────
// 仅列出与自身 id 不同的项。未列出者默认使用自身 id。
export const PROVIDER_HERMES_IDS = {
  "openai": "openai-api",
};

// ============================================================================
// SECTION 3: CONFIG UTILITIES（来自 config-utils.js）
// ============================================================================

// 自定义 provider 环境变量名：剥离 id 中 "custom-" 前缀后规范化大写
export function customEnvKey(id) {
  const bare = String(id).replace(/^custom-/i, '');
  return `CUSTOM_${bare.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_API_KEY`;
}
// 兼容旧格式（CUSTOM_PROVIDER_*_API_KEY）用于读取迁移
export function legacyCustomEnvKey(id) {
  const bare = String(id).replace(/^custom-/i, '');
  return `CUSTOM_PROVIDER_${bare.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}_API_KEY`;
}

// YAML 标量安全序列化：含 YAML 特殊字符时加引号，否则保持 plain
export function yamlScalar(val) {
  const s = String(val == null ? "" : val);
  const risky = s === "" ||
    /^[\s>|@`"'"%#&*!?\[\]{},-]/.test(s) ||   // 危险起始字符
    /\s$/.test(s) ||                          // 结尾空白
    /:(\s|$)/.test(s) ||                      // 冒号后接空格/行尾
    /\s#/.test(s);                            // 空格 + 井号（YAML 行内注释）
  return risky ? JSON.stringify(s) : s;
}

// ============================================================================
// SECTION 4: API FORMAT DETECTION（来自 api-format.js）
// ============================================================================

// 从 base_url 提取主机名（小写），解析失败返回空串
function hostnameOf(baseUrl) {
  try {
    return new URL(String(baseUrl || "").trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// 从 base_url 提取路径（小写、去尾斜杠），解析失败返回空串
function pathOf(baseUrl) {
  try {
    return new URL(String(baseUrl || "").trim()).pathname.toLowerCase().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

// ── 启发式识别 ──────────────────────────────────────────────────────────
// 返回 { format: "openai"|"anthropic", source: 命中的规则标识 }。
// 规则优先级：URL 主机 > URL 路径 > key 前缀 > 默认 OpenAI 兼容。
export function detectApiFormat(baseUrl, apiKey) {
  const host = hostnameOf(baseUrl);
  const path = pathOf(baseUrl);
  // 官方 Anthropic / Claude 主机（精确匹配主机名，防子域名仿冒）
  if (host === "api.anthropic.com" || host.endsWith(".anthropic.com") || host.endsWith(".claude.com")) {
    return { format: "anthropic", source: "url-host" };
  }
  // 第三方 Anthropic 兼容网关惯例：/anthropic 或 /anthropic/v1 路径后缀
  if (path.endsWith("/anthropic") || path.endsWith("/anthropic/v1")) {
    return { format: "anthropic", source: "url-path" };
  }
  // 用户直接把 /v1/messages 端点填进 base_url 的情况
  if (path.endsWith("/v1/messages") || path.endsWith("/messages")) {
    return { format: "anthropic", source: "url-path" };
  }
  // Anthropic 官方 key 前缀
  const key = String(apiKey || "").trim();
  if (key.startsWith("sk-ant-")) {
    return { format: "anthropic", source: "key-prefix" };
  }
  // 其余（含 /v1 惯例路径）默认 OpenAI 兼容
  return { format: "openai", source: "default" };
}

// ── 在线探测（可选增强，由面板“检测”按钮触发）────────────────────────────
// 先 GET {base}/models 判 OpenAI 兼容，失败再 POST {base}/messages 判 Anthropic，
// 每步 5s 超时。由后端代理发起，规避前端跨域限制。
export async function probeApiFormat(baseUrl, apiKey, timeoutMs = 5000) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, error: "base_url 必须以 http(s):// 开头" };
  }
  if (typeof P.networkProxy?.fetch !== "function") return { ok: false, error: NETWORK_PROXY_REQUIRED };
  const key = String(apiKey || "").trim();
  // 第一步：OpenAI 兼容端点惯例暴露 GET /models（base 通常已含 /v1）
  try {
    const headers = key ? { "Authorization": `Bearer ${key}` } : {};
    const r = await P.networkProxy.fetch(`${base}/models`, { method: "GET", headers, redirect: "error",
      timeoutMs, signal: AbortSignal.timeout(timeoutMs) });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      if (j && (Array.isArray(j.data) || Array.isArray(j.models))) {
        return { ok: true, format: "openai", method: "GET /models" };
      }
    }
  } catch { /* 超时/网络错误：继续下一种探测 */ }
  // 第二步：Anthropic Messages 端点。无论成功还是鉴权失败，
  // 响应体都携带 type 字段（"message" 或 "error"），以此识别协议
  try {
    const headers = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
    if (key) headers["x-api-key"] = key;
    const r2 = await P.networkProxy.fetch(`${base}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      redirect: "error",
      timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j2 = await r2.json().catch(() => null);
    if (j2 && (j2.type === "message" || (j2.type === "error" && j2.error))) {
      return { ok: true, format: "anthropic", method: "POST /messages" };
    }
  } catch { /* 超时/网络错误：落入未识别分支 */ }
  return { ok: false, error: "两种协议探测均未命中，请检查地址或手动选择格式" };
}

// ── config.yaml providers 条目的格式化辅助 ─────────────────────────────
// 显式声明为 anthropic 时返回网关认识的 api_mode 值。OpenAI 兼容维持缺省（返回空串，不写字段）
export function apiModeForFormat(format) {
  return format === "anthropic" ? "anthropic_messages" : "";
}

// 规范化面板传入的 api_format 值：仅接受 openai / anthropic，其余视为未指定（自动识别）
export function normalizeApiFormat(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "anthropic_messages") return "anthropic";
  if (v === "chat_completions") return "openai";
  return (v === "openai" || v === "anthropic") ? v : "";
}

// ============================================================================
// SECTION 5: TOOL DISPLAY NAMES & EMOJIS（来自 tool-names.js）
// ============================================================================

// Hermes 工具徽章显示名/图标 — 唯一数据源（bridge IPC 链路与 SSE 降级链路共用）
//
// 工具名来源（均为磁盘上可查证的事实）：
// 1) 本项目 gateway hermes.tool.progress 实际上报名与上游 KNOWN 工具集名单：
//    execute_code / code_execution / terminal / file / web / browser / vision /
//    memory / todo / skills / clarify / delegation 等
// 2) 写门控（write-gate）相关工具：
//    patch / write_file / remove_file
// 3) bridge 运行/群聊链路工具：
//    delegate_task / workspace_diff
// 4) Agent 工具定义：
//    terminal_exec / browser_navigate 等 browser_* 十项 / skill_list / skill_view / skill_manage
// 5) MCP 动态工具：支持 mcp__server__tool 双下划线新格式，兼容 mcp_ 旧格式，
//    数量不定，不逐一收录，由 toolDisplayName 前缀规则兜底
//
// 维护说明：Hermes 官方升级新增/改名工具时，只需在下方 TOOL_NAME_ZH / TOOL_EMOJI
// 各加一行（key 为工具英文名，译名保持简短动宾式，如“执行代码”），未收录的工具名
// 会自动回退显示英文原名，不影响使用。

// 工具英文名 → 中文显示名
export const TOOL_NAME_ZH = {
  // 代码/终端
  execute_code: "执行代码",
  code_execution: "执行代码",
  terminal: "终端命令",
  terminal_exec: "终端命令",
  // 文件
  read_file: "读取文件",
  write_file: "写入文件",
  patch: "修改文件",
  remove_file: "删除文件",
  search_files: "搜索文件",
  file: "文件操作",
  workspace_diff: "工作区变更",
  // 网络/浏览器
  web: "网页搜索",
  web_search: "联网搜索",
  browser: "浏览器自动化",
  browser_navigate: "打开网页",
  browser_snapshot: "页面快照",
  browser_click: "点击页面",
  browser_type: "页面输入",
  browser_scroll: "滚动页面",
  browser_back: "页面后退",
  browser_press: "按键操作",
  browser_get_images: "提取页面图片",
  browser_vision: "识图分析",
  browser_console: "页面控制台",
  vision: "视觉分析",
  // 任务/会话
  delegate_task: "委派任务",
  delegation: "委派任务",
  session_search: "会话搜索",
  clarify: "追问澄清",
  // 记忆/技能/待办
  memory: "记忆管理",
  todo: "待办事项",
  skills: "技能调用",
  skills_list: "列出技能",
  skill_list: "列出技能",
  skill_view: "查看技能",
  skill_manage: "管理技能",
  // 终端/进程
  process: "进程管理",
  read_terminal: "读取终端",
  close_terminal: "关闭终端",
  open_preview: "打开预览",
  focus_pane: "聚焦面板",
  // 网络
  web_extract: "提取网页",
  x_search: "搜索 X",
  // 视觉/媒体
  vision_analyze: "视觉分析",
  image_generate: "生成图像",
  video_analyze: "分析视频",
  video_generate: "生成视频",
  xai_video_edit: "编辑视频",
  xai_video_extend: "延长视频",
  text_to_speech: "文字转语音",
  // 调度/桌面/项目
  cronjob: "定时任务",
  computer_use: "电脑操作",
  project_create: "创建项目",
  project_list: "项目列表",
  project_switch: "切换项目",
  // 浏览器（CDP）
  browser_cdp: "浏览器调试协议",
  browser_dialog: "处理浏览器弹窗",
  // 智能家居（Home Assistant）
  ha_call_service: "调用家居服务",
  ha_get_state: "查询设备状态",
  ha_list_entities: "列出家居设备",
  ha_list_services: "列出家居服务",
  // 看板（Kanban）
  kanban_show: "查看看板任务",
  kanban_list: "看板任务列表",
  kanban_complete: "完成看板任务",
  kanban_block: "阻塞看板任务",
  kanban_heartbeat: "看板心跳",
  kanban_comment: "看板评论",
  kanban_create: "创建看板任务",
  kanban_link: "关联看板任务",
  kanban_unblock: "解除看板阻塞",
  kanban_attach: "看板附件上传",
  kanban_attach_url: "看板附件链接",
  kanban_attachments: "看板附件列表",
  // 飞书（Feishu）
  feishu_doc_read: "读取飞书文档",
  feishu_drive_add_comment: "飞书添加评论",
  feishu_drive_list_comments: "飞书评论列表",
  feishu_drive_list_comment_replies: "飞书评论回复列表",
  feishu_drive_reply_comment: "飞书回复评论",
  // Discord
  discord: "Discord 操作",
  discord_admin: "Discord 管理",
  // Spotify
  spotify_playback: "Spotify 播放",
  spotify_devices: "Spotify 设备",
  spotify_queue: "Spotify 队列",
  spotify_search: "Spotify 搜索",
  spotify_playlists: "Spotify 歌单",
  spotify_albums: "Spotify 专辑",
  spotify_library: "Spotify 音乐库",
  // 元宝（Yuanbao）
  yb_query_group_info: "查询群信息",
  yb_query_group_members: "查询群成员",
  yb_send_dm: "发送私信",
  yb_search_sticker: "搜索表情",
  yb_send_sticker: "发送表情",
};

// 工具英文名 → 徽章图标（未命中兜底 🔧，mcp_ 前缀回退 🔌）
export const TOOL_EMOJI = {
  execute_code: "🧮",
  code_execution: "🧮",
  terminal: "💻",
  terminal_exec: "💻",
  read_file: "📄",
  write_file: "📝",
  patch: "🩹",
  remove_file: "🗑️",
  search_files: "🔎",
  file: "📁",
  workspace_diff: "📋",
  web: "🌐",
  web_search: "🌐",
  browser: "🧭",
  browser_navigate: "🧭",
  browser_snapshot: "📸",
  browser_click: "🖱️",
  browser_type: "⌨️",
  browser_scroll: "📜",
  browser_back: "↩️",
  browser_press: "⌨️",
  browser_get_images: "🖼️",
  browser_vision: "👁️",
  browser_console: "🖥️",
  vision: "👁️",
  delegate_task: "🤝",
  delegation: "🤝",
  session_search: "🗂️",
  clarify: "❓",
  memory: "🧠",
  todo: "✅",
  skills: "🎯",
  skills_list: "🎯",
  skill_list: "🎯",
  skill_view: "🎯",
  skill_manage: "🎯",
  // 终端/进程
  process: "⚙️",
  read_terminal: "💻",
  close_terminal: "💻",
  open_preview: "🖥️",
  focus_pane: "🖥️",
  // 网络
  web_extract: "📄",
  x_search: "🐦",
  // 视觉/媒体
  vision_analyze: "👁️",
  image_generate: "🎨",
  video_analyze: "🎬",
  video_generate: "🎬",
  xai_video_edit: "🎬",
  xai_video_extend: "🎬",
  text_to_speech: "🔊",
  // 调度/桌面/项目
  cronjob: "⏰",
  computer_use: "🖥️",
  project_create: "📂",
  project_list: "📂",
  project_switch: "📂",
  // 浏览器（CDP）
  browser_cdp: "🧭",
  browser_dialog: "🧭",
  // 智能家居（Home Assistant）
  ha_call_service: "🏠",
  ha_get_state: "🏠",
  ha_list_entities: "🏠",
  ha_list_services: "🏠",
  // 看板（Kanban）
  kanban_show: "📋",
  kanban_list: "📋",
  kanban_complete: "📋",
  kanban_block: "📋",
  kanban_heartbeat: "📋",
  kanban_comment: "📋",
  kanban_create: "📋",
  kanban_link: "📋",
  kanban_unblock: "📋",
  kanban_attach: "📋",
  kanban_attach_url: "📋",
  kanban_attachments: "📋",
  // 飞书（Feishu）
  feishu_doc_read: "📄",
  feishu_drive_add_comment: "💬",
  feishu_drive_list_comments: "💬",
  feishu_drive_list_comment_replies: "💬",
  feishu_drive_reply_comment: "💬",
  // Discord
  discord: "💬",
  discord_admin: "💬",
  // Spotify
  spotify_playback: "🎵",
  spotify_devices: "🎵",
  spotify_queue: "🎵",
  spotify_search: "🎵",
  spotify_playlists: "🎵",
  spotify_albums: "🎵",
  spotify_library: "🎵",
  // 元宝（Yuanbao）
  yb_query_group_info: "💬",
  yb_query_group_members: "💬",
  yb_send_dm: "💬",
  yb_search_sticker: "💬",
  yb_send_sticker: "💬",
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// 取工具中文显示名，未命中兜底：mcp__server__tool 新格式 → "MCP·<tool>"（取末段工具名），
// mcp_ 旧格式 → "MCP·原名"，其余显示英文原名，空值显示“工具调用”，
// 保证任何情况下不出现 undefined/空白徽章
export function toolDisplayName(tool) {
  const name = String(tool || "").trim();
  if (!name) return "工具调用";
  if (hasOwn(TOOL_NAME_ZH, name)) return TOOL_NAME_ZH[name];
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const tail = parts[parts.length - 1];
    return tail ? `MCP·${tail}` : `MCP·${name}`;
  }
  if (name.startsWith("mcp_")) return `MCP·${name.slice(4)}`;
  return name;
}

// 取工具徽章图标（未命中兜底 🔧 / MCP 🔌，mcp__ 与 mcp_ 两种前缀均回退 🔌）
export function toolEmoji(tool) {
  const name = String(tool || "").trim();
  if (hasOwn(TOOL_EMOJI, name)) return TOOL_EMOJI[name];
  if (name.startsWith("mcp__") || name.startsWith("mcp_")) return "🔌";
  return "🔧";
}

// ============================================================================
// SECTION 6: FALLBACK CONFIGURATION（来自 fallback-config.js）
// ============================================================================

// 可直接作为网关内置回退服务商的面板 provider id 白名单：
// 这些 id 网关原生认识，条目直接写 provider: <hermes_id> + model，
// 其余（B 类 / custom-* / 不在名单的 A 类 / local-*）一律降级为 custom 形态
// （provider: custom + model + base_url + key_env），保守策略保证条目可用。
const FALLBACK_NATIVE_IDS = new Set([
  "zai", "kimi-coding", "kimi-coding-cn", "minimax", "minimax-cn", "openrouter",
]);

// 回退服务商环境变量名：内置服务商查 PROVIDER_API_KEYS，非内置走 custom 规则，local-* 无鉴权返回空
function fallbackEnvKey(id) {
  if (String(id).indexOf("local-") === 0) return "";
  return PROVIDER_API_KEYS[id] || customEnvKey(id);
}

// ── 解析 config.yaml 顶层 fallback_providers 块 → 面板 provider id 数组 ─────
// 兼容两种形态：单行空列表 `fallback_providers: []` 与多行列表块。
// 面板 id 优先取写入时附带的 `# panel:<id>` 注释，无注释时若 provider 值
// 恰好是白名单内置服务商 id 则直接采用，否则该条目无法反查、跳过。
export function parseFallback(yamlContent) {
  const lines = String(yamlContent || "").split(/\r?\n/);
  const ids = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^fallback_providers:/.test(lines[i])) continue;
    // 单行形态：fallback_providers: []（含尾随空白/注释）
    if (/^fallback_providers:\s*\[\s*\]\s*(#.*)?$/.test(lines[i])) return [];
    // 多行块形态：连同后续缩进行与顶格 "- " 列表项行一起取出
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j];
      if (!(/^[ \t]/.test(ln) || /^- /.test(ln))) break;
      const provM = ln.match(/^[-\s]*provider:\s*["']?([A-Za-z0-9_-]+)["']?\s*(?:#.*)?$/);
      if (provM && !["custom", "auto"].includes(provM[1])) {
        const id = provM[1] === "openai-api" ? "openai" : provM[1];
        if (!ids.includes(id)) ids.push(id);
        continue; // 命名路由优先于 ruamel 保留下来的过期注释。
      }
      const pm = ln.match(/#\s*panel:([A-Za-z0-9_-]+)/);
      if (pm && !ids.includes(pm[1])) ids.push(pm[1]);
    }
    break;
  }
  return ids;
}

// ── 生成 fallback_providers YAML 块 ────────────────────────────────────────
// entries: 面板 provider id 数组（首期单选，调用方已截断为最多 1 项），
// provState: { <id>: { model, base_url, ... } }（monitor.js 的 allProvConfig 形态）。
// 每个条目末尾附 `# panel:<id>` 注释供 parseFallback 回读反查。
export function buildFallbackBlock(entries, provState) {
  const items = (entries || [])
    .map((id) => {
      const cfg = (provState && provState[id]) || {};
      const model = cfg.model || "auto";
      if (FALLBACK_NATIVE_IDS.has(id)) {
        const hermesId = PROVIDER_HERMES_IDS[id] || id;
        return `- provider: ${yamlScalar(hermesId)}  # panel:${id}\n` +
               `  model: ${yamlScalar(model)}`;
      }
      // custom 形态：base_url 取面板保存值，缺省回落到内置预设默认地址
      const baseUrl = String(cfg.base_url || (PROVIDER_PRESETS[id] ? PROVIDER_PRESETS[id].base_url : "") || "").trim();
      if (!baseUrl) return null;   // 无法构造有效端点，跳过该条目
      let entry = `- provider: custom  # panel:${id}\n` +
                  `  model: ${yamlScalar(model)}\n` +
                  `  base_url: ${yamlScalar(baseUrl)}`;
      const envKey = fallbackEnvKey(id);   // local-* 本地端点无鉴权，省略 key_env
      if (envKey) entry += `\n  key_env: ${envKey}`;
      return entry;
    })
    .filter(Boolean);
  if (items.length === 0) return "fallback_providers: []\n";
  return `fallback_providers:\n${items.join("\n")}\n`;
}

// ── 把 fallback_providers 块替换 / 插入到 config.yaml 文本 ─────────────────
// 手法与 monitor.js providers 段一致：定位顶层键 → 取出块内各行 → 整块替换，
// 键不存在时插到 model / providers 段之后。写入前后做正则自检，异常时
// 原样返回旧内容，绝不写出格式损坏的 config.yaml。
export function applyFallbackToYaml(ymlContent, block) {
  const src = String(ymlContent == null ? "" : ymlContent);
  const blk = String(block || "fallback_providers: []\n");
  const lines = src.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf("fallback_providers:") === 0) { start = i; break; }
  }
  let out;
  if (start >= 0) {
    // 取出块内各行：缩进行 + 顶格 "- " 列表项行（兼容 [] 单行形态，此时块内行数为 0）
    let end = start + 1;
    while (end < lines.length && (/^[ \t]/.test(lines[end]) || /^- /.test(lines[end]))) end++;
    const before = lines.slice(0, start).join("\n");
    const after = lines.slice(end).join("\n");
    out = (before ? before + "\n" : "") + blk + after;
  } else {
    // 键不存在：优先插到 providers 段之后，其次 model 段之后，最后追加文件末尾
    const anchorRe = /(^providers:[\t ]*\n(?:(?:[\t ]+[^\n]*|)\n)*)/m;
    const modelRe = /(^model:[\t ]*\n(?:[\t ]+[^\n]*\n)*)/m;
    const m = src.match(anchorRe) || src.match(modelRe);
    if (m) {
      const pos = m.index + m[1].length;
      out = src.slice(0, pos) + blk + src.slice(pos);
    } else {
      out = src + (src.endsWith("\n") || src === "" ? "" : "\n") + blk;
    }
  }
  // 自检：顶层 fallback_providers 键必须恰好 1 个，且 model 顶层键数量不变
  const count = (s, re) => (s.match(re) || []).length;
  const fbRe = /^fallback_providers:/gm;
  const mdRe = /^model:/gm;
  if (count(out, fbRe) !== 1 || count(out, mdRe) !== count(src, mdRe)) {
    return src;   // 自检失败：放弃改动，保持原内容
  }
  return out;
}

// ── 同步回退服务商 API key 到网关 .env ────────────────────────────────────────
// 现有逻辑只同步 active provider 的 key。回退触发时网关按环境变量取回退服务商 key，
// 缺失会导致 401，故保存回退配置时必须把回退服务商 key 一并写入 hermesEnvPath。
export function syncFallbackKeysToHermesEnv(fallbackIds, envProvidersPath, hermesEnvPath) {
  const before = snapshot(hermesEnvPath);
  const panel = snapshot(envProvidersPath);
  const content = prepareHermesKeys(fallbackIds || [], panel.content || "", before.content || "");
  const dirty = content !== (before.content || "");
  if (dirty) atomicTextWrite(hermesEnvPath, content);
  return dirty;
}

// ============================================================================
// SECTION 7: CHAT HARDENING（来自 chat-hardening.js）
// ============================================================================

// 聊天加固模块（增量 checkpoint / finalize / resume）
// ESM，与 monitor.js 一致。无外部依赖。
//
// 设计意图：流式回复期间周期性持久化半成品（带 _streaming 标记），
// 正常完成或出错时转为正式消息，避免断电/崩溃丢内容。
// 与多会话 liveRuns 运行表互不干扰（各管各的关切）。

const CHECKPOINT_INTERVAL_MS = 1000;   // 定时器检查周期
const CHECKPOINT_MIN_CHARS = 1000;     // 距上次 checkpoint 的字符增量阈值
const CHECKPOINT_MIN_TIME_MS = 5000;   // 距上次 checkpoint 的时间间隔阈值（ms）
const DEDUP_WINDOW_MS = 60000;         // WS→XHR 回退去重窗口（与 monitor.js 现有逻辑一致）

/**
 * 创建流式 checkpoint 工厂。
 *
 * @param {string} sessionId — 会话 ID（仅用于日志）
 * @param {object} session  — 调用方已加载的 in-memory session 对象引用，
 *   checkpoint 和 finalize 直接操作其 messages 数组然后调 saveSession。
 * @param {{ saveSession: (s: any) => void, log?: (msg: string) => void }} deps
 * @returns {{ onDelta: (text: string) => void, getReply: () => string,
 *             finalize: (content?: string) => void, dispose: () => void }}
 */
export function createCheckpointer(sessionId, session, { saveSession, log }) {
  let fullReply = "";
  let lastCkptLen = 0;
  let lastCkptTs = Date.now();
  let timer = null;
  let disposed = false;

  function doCheckpoint() {
    if (disposed || fullReply.length === 0) return;
    const charDelta = fullReply.length - lastCkptLen;
    const timeDelta = Date.now() - lastCkptTs;
    if (charDelta < CHECKPOINT_MIN_CHARS && timeDelta < CHECKPOINT_MIN_TIME_MS) return;
    try {
      const last = session.messages[session.messages.length - 1];
      if (last && last.role === "assistant" && last._streaming) {
        // 已有 checkpoint 消息 → 原地更新
        last.content = fullReply;
        last.ts = Date.now();
      } else if (last && last.role === "assistant" && (Date.now() - last.ts) < DEDUP_WINDOW_MS) {
        // WS→XHR 回退去重：最近一条 assistant 在窗口内 → 替换为 streaming
        last.content = fullReply;
        last.ts = Date.now();
        last._streaming = true;
      } else {
        // 首次 checkpoint → 追加新的 _streaming 消息
        session.messages.push({ role: "assistant", content: fullReply, ts: Date.now(), _streaming: true });
      }
      saveSession(session);
      lastCkptLen = fullReply.length;
      lastCkptTs = Date.now();
    } catch (e) {
      if (log) log(`[checkpoint] ${sessionId}: ${e?.message || e}`);
    }
  }

  timer = setInterval(doCheckpoint, CHECKPOINT_INTERVAL_MS);

  return {
    /** 追加增量文本（每次 onDelta 回调时调用） */
    onDelta(text) {
      if (text) fullReply += text;
    },

    /** 当前 checkpointer 内部累积全文（调试/备用） */
    getReply() { return fullReply; },

    /**
     * 流结束时把 _streaming 消息转为正式消息（移除标记）。
     * 若尚无 _streaming 消息则追加正式消息。
     *
     * @param {string} [content] — 最终内容。缺省时用 checkpointer 累积文本
     */
    finalize(content) {
      if (disposed) return;
      disposed = true;
      if (timer) { clearInterval(timer); timer = null; }
      const finalContent = (content != null && content !== "") ? String(content) : fullReply;
      if (!finalContent) {
        // 没有任何内容：若之前有 _streaming 消息也转为正式消息（保留 checkpoint 内容）
        const last = session.messages[session.messages.length - 1];
        if (last && last.role === "assistant" && last._streaming) {
          delete last._streaming;
          last.ts = Date.now();
          try { saveSession(session); } catch {}
        }
        return;
      }
      try {
        const last = session.messages[session.messages.length - 1];
        if (last && last.role === "assistant" && last._streaming) {
          last.content = finalContent;
          last.ts = Date.now();
          delete last._streaming;
        } else if (last && last.role === "assistant" && (Date.now() - last.ts) < DEDUP_WINDOW_MS) {
          // WS→XHR 回退去重：最近 assistant 在窗口内 → 原地替换
          last.content = finalContent;
          last.ts = Date.now();
          if (last._streaming) delete last._streaming;
        } else {
          session.messages.push({ role: "assistant", content: finalContent, ts: Date.now() });
        }
        saveSession(session);
      } catch (e) {
        if (log) log(`[finalize] ${sessionId}: ${e?.message || e}`);
      }
    },

    /** 仅释放定时器，不做持久化（异常出口用，先前 checkpoint 保留给 resume 处理） */
    dispose() {
      disposed = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

/**
 * 会话 resume：把残留的 _streaming 消息转为正式消息（去掉标记，保留内容）。
 * 适用于加载/切换会话时调用，用来覆盖上次崩溃/断电留下的半成品状态。
 *
 * @param {object} session — 完整 session 对象
 * @param {(s: any) => void} saveSession
 * @returns {boolean} 是否执行了 resume
 */
export function resumeStreamingMessages(session, saveSession) {
  if (!session || !Array.isArray(session.messages) || session.messages.length === 0) return false;
  const last = session.messages[session.messages.length - 1];
  if (last && last.role === "assistant" && last._streaming) {
    delete last._streaming;
    last.ts = Date.now();
    saveSession(session);
    return true;
  }
  return false;
}
