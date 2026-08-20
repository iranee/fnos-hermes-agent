// primary-config.js — 主模型配置读写模块（ consolidated）
// 职责：providers-state.yaml 解析 / 序列化写入、config.yaml 的 model 段 + providers 段
// 构建与写入、.env.providers 保存与旧格式迁移、active provider key 同步到 Hermes .env、
// 已删除服务商的 key 清理，以及真实 API key 解析（resolveRealApiKey）。
// 
// CONSOLIDATION: 此文件整合了以下模块的功能：
// - provider-config.js (PROVIDER_PRESETS, PROVIDER_MODELS, PROVIDER_API_KEYS, etc.)
// - fallback-config.js (parseFallback, syncFallbackKeysToHermesEnv)
// - api-format.js (detectApiFormat, probeApiFormat, apiModeForFormat, normalizeApiFormat)
// - config-utils.js (customEnvKey, legacyCustomEnvKey, yamlScalar)
// - tool-names.js (TOOL_NAME_ZH, TOOL_EMOJI, toolDisplayName, toolEmoji)
// - chat-hardening.js (createCheckpointer, resumeStreamingMessages)
//
// 路径 / 日志 / 本机令牌等共用设施由 monitor.js 经 initPrimaryConfig 注入，本模块不重复定义。
import { readFileSync, writeFileSync, existsSync } from "fs";

// ─── 注入的运行时依赖 ─────────────────────────────────────────────────────
let P = {
  varDir: "",           // VAR_DIR（providers-state.yaml / .env.providers 所在目录）
  dataDir: "",          // DATA_DIR（config.yaml / Hermes .env 所在目录）
  log: () => {},        // monitor.js 的日志函数
  monitorToken: "",     // 本机监控令牌（LOCAL / hermes provider 直接用它鉴权）
};

export function initPrimaryConfig(deps) {
  P = { ...P, ...deps };
}

// ─── 真实 API key 解析 ────────────────────────────────────────────────────
// 优先级：LOCAL/hermes → 明文 api_key → 进程环境变量 → .env.providers（含旧名兜底）
// → Hermes .env（含旧名兜底）；任何读取异常一律返回 null（非致命）。
export function resolveRealApiKey(provider) {
  if (provider.base_url === "LOCAL" || provider.id === "hermes") {
    return P.monitorToken;
  }
  if (provider.api_key && !provider.api_key.startsWith("****")) {
    return provider.api_key;
  }
  const envKey = PROVIDER_API_KEYS[provider.id] || PROVIDER_API_KEYS[provider.name] || customEnvKey(provider.id);
  try {
    const fromEnv = process.env[envKey];
    if (fromEnv) return fromEnv;
    const envProvPath = `${P.varDir}/.env.providers`;
    if (existsSync(envProvPath)) {
      const provEnv = readFileSync(envProvPath, "utf8");
      const m = provEnv.match(new RegExp(`^${envKey}=(.*)$`, "m"));
      if (m && m[1]) return m[1].trim();
      // 兼容旧名 CUSTOM_PROVIDER_*
      if (!PROVIDER_API_KEYS[provider.id] && !PROVIDER_API_KEYS[provider.name]) {
        const legKey = legacyCustomEnvKey(provider.id);
        const m2 = provEnv.match(new RegExp(`^${legKey}=(.*)$`, "m"));
        if (m2 && m2[1]) return m2[1].trim();
      }
    }
    // 兜底：DATA_DIR/.env
    const hermesEnvPath = `${P.dataDir}/.env`;
    if (existsSync(hermesEnvPath)) {
      const hEnv = readFileSync(hermesEnvPath, "utf8");
      const mh = hEnv.match(new RegExp(`^${envKey}=(.*)$`, "m"));
      if (mh && mh[1]) return mh[1].trim();
      if (!PROVIDER_API_KEYS[provider.id] && !PROVIDER_API_KEYS[provider.name]) {
        const legKey = legacyCustomEnvKey(provider.id);
        const m2 = hEnv.match(new RegExp(`^${legKey}=(.*)$`, "m"));
        if (m2 && m2[1]) return m2[1].trim();
      }
    }
    return null;
  } catch { return null; }
}

// ─── providers-state.yaml 解析（GET/POST 共用） ─────────────────────────
// 解析格式: providers:\n  id:\n    model: xxx\n    base_url: yyy\n    name: "zzz"
export function parseProvidersState(stateYaml) {
  const map = {};
  const blockMatch = String(stateYaml || "").match(/^providers:\n([\s\S]*)$/m);
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
    if (m && curId) { curModel = m[1].trim(); return; }
    const b = line.match(/^    base_url:\s*(.+)\s*$/);
    if (b && curId) { curBase = b[1].trim(); return; }
    const n = line.match(/^    name:\s*(.+)\s*$/);
    if (n && curId) { try { curName = JSON.parse(n[1].trim()); } catch { curName = n[1].trim(); } }
    const t = line.match(/^    temperature:\s*(.+)\s*$/);
    if (t && curId) { const tv = parseFloat(t[1].trim()); if (!isNaN(tv)) curTemp = tv; }
    const x = line.match(/^    max_tokens:\s*(.+)\s*$/);
    if (x && curId) { const xv = parseInt(x[1].trim(), 10); if (!isNaN(xv)) curMax = xv; }
    const f = line.match(/^    api_format:\s*(.+)\s*$/);
    if (f && curId) { curFmt = normalizeApiFormat(f[1]); }
  });
  flush();
  return map;
}

// 读取并解析 providers-state.yaml；文件不存在返回空映射，读取异常向上抛出由调用方决定处置
export function loadProvidersState() {
  const statePath = `${P.varDir}/providers-state.yaml`;
  if (!existsSync(statePath)) return {};
  return parseProvidersState(readFileSync(statePath, "utf8"));
}

// ─── providers-state.yaml 序列化写入（写失败为非致命，静默忽略） ──────────
export function writeProvidersState(allProvConfig, activeProviderId) {
  try {
    const stateLines = Object.entries(allProvConfig)
      .sort(([a], [b]) => {
        // active provider 排第一，其余按 id 字母排序
        if (a === activeProviderId) return -1;
        if (b === activeProviderId) return 1;
        return a.localeCompare(b);
      })
      .map(([id, cfg]) => {
        let entry = `  ${id}:\n    model: ${cfg.model}`;
        if (cfg.base_url) entry += `\n    base_url: ${cfg.base_url}`;
        if (cfg.name) entry += `\n    name: ${JSON.stringify(cfg.name)}`;
        if (cfg.temperature != null) entry += `\n    temperature: ${cfg.temperature}`;
        if (cfg.max_tokens != null) entry += `\n    max_tokens: ${cfg.max_tokens}`;
        if (cfg.api_format) entry += `\n    api_format: ${cfg.api_format}`;
        return entry;
      })
      .join("\n");
    const stateContent = `providers:\n${stateLines}\n`;
    writeFileSync(`${P.varDir}/providers-state.yaml`, stateContent);
  } catch (e) {}
}

// ─── config.yaml 的 model 段 + providers 段 + fallback 段构建与写入 ────────
// 返回 { ok: true } 或 { ok: false, error }（写失败属致命，由调用方返回 500）。
export function writeConfigYaml({ allProvConfig, providerId, fallbackIds }) {
  const resolvedModel = allProvConfig[providerId]?.model || "auto";
  const yamlPath = `${P.dataDir}/config.yaml`;

  // ── 构建 providers: 段（A/B 分类，详见 provider-config.js 的 PROVIDER_CLASSES） ──
  //   A 类内置服务商仅写 model 段，端点与原生协议交给 Hermes 内置 PROVIDER_REGISTRY；
  //   B 类内置服务商（siliconflow / mistral / ollama-cloud）与所有非预设 custom-* 必须写 providers 段。
  const customEntries = Object.entries(allProvConfig)
    .sort(([a], [b]) => {
      if (a === providerId) return -1;
      if (b === providerId) return 1;
      return a.localeCompare(b);
    })
    .filter(([id]) => !PROVIDER_PRESETS[id] || PROVIDER_CLASSES[id] === "B")
    .map(([id, pcfg]) => {
      const baseUrl = String(pcfg.base_url || "").trim();
      if (!baseUrl) {
        P.log(`跳过 provider "${id}"：缺少 base_url，未写入 config.yaml providers 段`);
        return null;
      }
      // 本地模型（local-* 动态 id）：本地 OpenAI 兼容服务无需鉴权，
      // 仅写 base_url + default_model，完全省略 api_key（Hermes config.py 支持缺省，
      // runtime_provider.py 会自动兜底 "no-key-required" 占位）。
      if (String(id).indexOf("local-") === 0) {
        return `  ${id}:\n` +
               `    base_url: ${yamlScalar(baseUrl)}\n` +
               `    default_model: ${yamlScalar(pcfg.model || "auto")}`;
      }
      // env 名：B 类预设用 PROVIDER_API_KEYS[id]，custom-* 用 customEnvKey(id)
      const envVar = PROVIDER_API_KEYS[id] || customEnvKey(id);
      // API 格式：显式选择优先，未选时按 URL 启发式自动识别；
      // Anthropic 形态追加 api_mode: anthropic_messages（网关运行时支持的字段），
      // OpenAI 兼容形态维持现状不写 api_mode，保证存量配置行为不变。
      const effFormat = pcfg.api_format || detectApiFormat(baseUrl, "").format;
      const modeVal = apiModeForFormat(effFormat);
      // 实机验证格式：base_url + api_key（${ENV} 插值）+ default_model
      return `  ${id}:\n` +
             `    base_url: ${yamlScalar(baseUrl)}\n` +
             `    api_key: \${${envVar}}\n` +
             `    default_model: ${yamlScalar(pcfg.model || "auto")}` +
             (modeVal ? `\n    api_mode: ${modeVal}` : "");
    })
    .filter(Boolean);
  const providersBlock = customEntries.length > 0 ? `providers:\n${customEntries.join("\n")}\n` : "";

  try {
    let ymlContent = existsSync(yamlPath) ? readFileSync(yamlPath, "utf8") : "";
    // model.provider 经 PROVIDER_HERMES_IDS 映射（openai → openai-api，其余用自身 id）
    const hermesProvider = PROVIDER_HERMES_IDS[providerId] || providerId;
    const newModel = `model:\n  provider: ${hermesProvider}\n  default: ${resolvedModel}\n`;
    const modelRegex = /^model:[\t ]*\n(?:[\t ]+[^\n]*\n)*/m;
    if (ymlContent.match(modelRegex)) {
      ymlContent = ymlContent.replace(modelRegex, newModel);
    } else {
      ymlContent = newModel + "\n" + ymlContent;
    }

    // 同步 providers: 段——兼容模板里的 `providers: {}` 空映射与已存在的多行块两种形态，
    // 避免产生重复的 providers 顶层键。无 B/custom 条目时整段省略 providers 节，
    // A 类 active 且无自定义服务商时 config.yaml 只保留 model 段（贴合实机验证格式）。
    const _NL = String.fromCharCode(10);
    const _TAB = String.fromCharCode(9);
    const _yl = ymlContent.split(_NL);
    let _ps = -1;
    for (let _i = 0; _i < _yl.length; _i++) {
      if (_yl[_i].indexOf("providers:") === 0) { _ps = _i; break; }
    }
    if (_ps >= 0) {
      let _pe = _ps + 1;
      while (_pe < _yl.length && (_yl[_pe].startsWith(" ") || _yl[_pe].startsWith(_TAB))) _pe++;
      const _before = _yl.slice(0, _ps).join(_NL);
      const _after = _yl.slice(_pe).join(_NL);
      if (providersBlock) {
        ymlContent = (_before ? _before + _NL : "") + providersBlock + _after;
      } else {
        // 无 B/custom 条目：纯删除原 providers 段，仅拼接 _before + _after
        ymlContent = _before + (_after ? _NL + _after : _NL);
      }
    } else if (providersBlock) {
      // 将 providers 段插入 model 段正下方（而非追加到文件末尾）
      const _modelBlockRe = /(^model:[\t ]*\n(?:[\t ]+[^\n]*\n)*)/m;
      const _modelMatch = ymlContent.match(_modelBlockRe);
      if (_modelMatch) {
        const _insertPos = _modelMatch.index + _modelMatch[0].length;
        ymlContent = ymlContent.slice(0, _insertPos) + providersBlock + ymlContent.slice(_insertPos);
      } else {
        // model 段也不存在时，退化为插到文件开头
        ymlContent = providersBlock + ymlContent;
      }
    }

    // 同步顶层 fallback_providers 段（外接模块处理：兼容 [] 单行与多行块两种形态，
    // 内含写入自检，异常时保持原内容不变，防止写坏 config.yaml）
    if (fallbackIds) {
      ymlContent = applyFallbackToYaml(ymlContent, buildFallbackBlock(fallbackIds, allProvConfig));
    }

    writeFileSync(yamlPath, ymlContent);
  } catch (e) {
    return { ok: false, error: "write config.yaml: " + e.message };
  }
  return { ok: true };
}

// ─── 保存 API key 到控制面板专属 .env.providers（含旧格式一次性迁移） ─────
export function saveProviderKeysToEnv(providers) {
  const envUpdates = [];
  (providers || []).forEach(p => {
    if (!p.id) return;
    // 本地模型（local-*）无需 API Key，跳过任何环境变量写入
    if (String(p.id).indexOf("local-") === 0) return;
    let envKey = PROVIDER_API_KEYS[p.id];
    if (!envKey) {
      envKey = customEnvKey(p.id);
    }
    let rawKey = null;
    if (p._raw_api_key && !String(p._raw_api_key).startsWith('****')) {
      rawKey = p._raw_api_key;
    } else if (p.api_key && !String(p.api_key).startsWith('****') && p.api_key !== 'none') {
      rawKey = p.api_key;
    }
    if (rawKey && rawKey.length > 0) {
      envUpdates.push({ key: envKey, value: rawKey });
    }
  });
  if (envUpdates.length > 0) {
    try {
      const envProvPath = `${P.varDir}/.env.providers`;
      let envContent = existsSync(envProvPath) ? readFileSync(envProvPath, "utf8") : "";
      envUpdates.forEach(({ key, value }) => {
        const envRegex = new RegExp(`^${key}=.*$`, "m");
        if (envRegex.test(envContent)) {
          envContent = envContent.replace(envRegex, `${key}=${value}`);
        } else {
          envContent += `${key}=${value}\n`;
        }
      });
      writeFileSync(envProvPath, envContent);
    } catch (e) {}
  }

  // ── 一次性迁移 .env.providers 旧格式 CUSTOM_PROVIDER_* → CUSTOM_* ──
  try {
    const _migPath = `${P.varDir}/.env.providers`;
    if (existsSync(_migPath)) {
      let _migContent = readFileSync(_migPath, "utf8");
      const _migRe = /^CUSTOM_PROVIDER_([A-Z0-9_]+_API_KEY)=(.+)$/gm;
      let _migM;
      let _migDirty = false;
      while ((_migM = _migRe.exec(_migContent)) !== null) {
        const _nk = `CUSTOM_${_migM[1]}`;
        if (!new RegExp(`^${_nk}=`, "m").test(_migContent)) {
          _migContent += `${_nk}=${_migM[2]}\n`;
        }
        _migDirty = true;
      }
      if (_migDirty) {
        _migContent = _migContent.split("\n").filter(l => !/^CUSTOM_PROVIDER_[A-Z0-9_]+_API_KEY=/.test(l)).join("\n");
        writeFileSync(_migPath, _migContent);
      }
    }
  } catch {}
}

// ─── 设为默认时，同步 active provider 的 key 到 Hermes .env（非致命） ─────
export function syncActiveKeyToHermesEnv(providerId) {
  try {
    const hermesEnvPath = `${P.dataDir}/.env`;
    let hermesEnv = existsSync(hermesEnvPath) ? readFileSync(hermesEnvPath, "utf8") : "";
    // 从已有的 .env.providers 中找到 active provider 的 key
    Object.keys(PROVIDER_API_KEYS).forEach(id => {
      if (id !== providerId) return;
      const envKey = PROVIDER_API_KEYS[id];
      // 从 .env.providers 读取真实 key
      const envProvPath = `${P.varDir}/.env.providers`;
      if (existsSync(envProvPath)) {
        const provEnv = readFileSync(envProvPath, "utf8");
        const m = provEnv.match(new RegExp(`^${envKey}=(.*)$`, "m"));
        if (m && m[1].length > 0) {
          const hermesRegex = new RegExp(`^${envKey}=.*$`, "m");
          if (hermesRegex.test(hermesEnv)) {
            hermesEnv = hermesEnv.replace(hermesRegex, `${envKey}=${m[1]}`);
          } else {
            hermesEnv += `\n${envKey}=${m[1]}\n`;
          }
        }
      }
    });
    // 同时检查自定义 provider
    const _cKey = customEnvKey(providerId);
    if (!PROVIDER_API_KEYS[providerId]) {
      const envProvPath2 = `${P.varDir}/.env.providers`;
      if (existsSync(envProvPath2)) {
        const provEnv2 = readFileSync(envProvPath2, "utf8");
        let m2 = provEnv2.match(new RegExp(`^${_cKey}=(.*)$`, "m"));
        // 兼容旧名
        if (!m2) m2 = provEnv2.match(new RegExp(`^${legacyCustomEnvKey(providerId)}=(.*)$`, "m"));
        if (m2 && m2[1].length > 0) {
          const hermesRegex2 = new RegExp(`^${_cKey}=.*$`, "m");
          if (hermesRegex2.test(hermesEnv)) {
            hermesEnv = hermesEnv.replace(hermesRegex2, `${_cKey}=${m2[1]}`);
          } else {
            hermesEnv += `\n${_cKey}=${m2[1]}\n`;
          }
        }
      }
    }
    // 清理 Hermes .env 中旧格式 CUSTOM_PROVIDER_* 行
    hermesEnv = hermesEnv.split("\n").filter(l => !/^CUSTOM_PROVIDER_[A-Z0-9_]+_API_KEY=/.test(l)).join("\n");
    writeFileSync(hermesEnvPath, hermesEnv);
  } catch (e) {}
}

// ─── bridge 对话主模型解析 ─────────────────────────────────────
// 将面板 active provider 解析为 bridge chat 请求的 {model, provider} 字段：
// provider 经 PROVIDER_HERMES_IDS 映射，与 writeConfigYaml 写 config.yaml model 段
// 同源（即与网关/微信链路一致）；base_url/api_key 由 hermes 侧 runtime_provider
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

// ─── 删除已移除 provider 的 .env.providers key（非致命） ──────────────────
export function cleanupRemovedProviderKeys(providers) {
  try {
    const envProvPath = `${P.varDir}/.env.providers`;
    if (existsSync(envProvPath)) {
      const envContent = readFileSync(envProvPath, "utf8");
      const keepKeys = new Set();
      (providers || []).forEach(p => {
        if (!p.id) return;
        const k = PROVIDER_API_KEYS[p.id] || customEnvKey(p.id);
        keepKeys.add(k);
      });
      const lines = envContent.split("\n");
      const filtered = lines.filter(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*API_KEY|.+_API_KEY)=/);
        if (!m) return true;
        return keepKeys.has(m[1]);
      });
      if (filtered.join("\n") !== envContent) {
        writeFileSync(envProvPath, filtered.join("\n"));
      }
    }
  } catch (e) {}
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
// A 类：仅写 model 段，端点与原生协议交给 Hermes 内置 PROVIDER_REGISTRY 处理；
// B 类：必须写 providers 段（base_url + api_key + default_model）。
// 注：动态 id 约定 —— custom-*（第三方自定义服务商，写 providers 段含 api_key）、
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
// 仅列出与自身 id 不同的项；未列出者默认使用自身 id。
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

// 从 base_url 提取主机名（小写）；解析失败返回空串
function hostnameOf(baseUrl) {
  try {
    return new URL(String(baseUrl || "").trim()).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// 从 base_url 提取路径（小写、去尾斜杠）；解析失败返回空串
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
// 先 GET {base}/models 判 OpenAI 兼容，失败再 POST {base}/messages 判 Anthropic；
// 每步 5s 超时。由后端代理发起，规避前端跨域限制。
export async function probeApiFormat(baseUrl, apiKey, timeoutMs = 5000) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, error: "base_url 必须以 http(s):// 开头" };
  }
  const key = String(apiKey || "").trim();
  // 第一步：OpenAI 兼容端点惯例暴露 GET /models（base 通常已含 /v1）
  try {
    const headers = key ? { "Authorization": `Bearer ${key}` } : {};
    const r = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      if (j && (Array.isArray(j.data) || Array.isArray(j.models))) {
        return { ok: true, format: "openai", method: "GET /models" };
      }
    }
  } catch { /* 超时/网络错误：继续下一种探测 */ }
  // 第二步：Anthropic Messages 端点——无论成功还是鉴权失败，
  // 响应体都携带 type 字段（"message" 或 "error"），以此识别协议
  try {
    const headers = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
    if (key) headers["x-api-key"] = key;
    const r2 = await fetch(`${base}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
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
// 显式声明为 anthropic 时返回网关认识的 api_mode 值；OpenAI 兼容维持缺省（返回空串，不写字段）
export function apiModeForFormat(format) {
  return format === "anthropic" ? "anthropic_messages" : "";
}

// 规范化面板传入的 api_format 值：仅接受 openai / anthropic，其余视为未指定（自动识别）
export function normalizeApiFormat(value) {
  const v = String(value || "").trim().toLowerCase();
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
// 各加一行（key 为工具英文名，译名保持简短动宾式，如“执行代码”）；未收录的工具名
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

// 取工具中文显示名；未命中兜底：mcp__server__tool 新格式 → "MCP·<tool>"（取末段工具名），
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
// 这些 id 网关原生认识，条目直接写 provider: <hermes_id> + model；
// 其余（B 类 / custom-* / 不在名单的 A 类 / local-*）一律降级为 custom 形态
// （provider: custom + model + base_url + key_env），保守策略保证条目可用。
const FALLBACK_NATIVE_IDS = new Set([
  "zai", "kimi-coding", "kimi-coding-cn", "minimax", "minimax-cn", "openrouter",
]);

// 回退服务商环境变量名：内置服务商查 PROVIDER_API_KEYS，非内置走 custom 规则；local-* 无鉴权返回空
function fallbackEnvKey(id) {
  if (String(id).indexOf("local-") === 0) return "";
  return PROVIDER_API_KEYS[id] || customEnvKey(id);
}

// ── 解析 config.yaml 顶层 fallback_providers 块 → 面板 provider id 数组 ─────
// 兼容两种形态：单行空列表 `fallback_providers: []` 与多行列表块。
// 面板 id 优先取写入时附带的 `# panel:<id>` 注释；无注释时若 provider 值
// 恰好是白名单内置服务商 id 则直接采用，否则该条目无法反查、跳过。
export function parseFallback(yamlContent) {
  const lines = String(yamlContent || "").split("\n");
  const ids = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^fallback_providers:/.test(lines[i])) continue;
    // 单行形态：fallback_providers: []（含尾随空白/注释）
    if (/^fallback_providers:\s*\[\s*\]\s*(#.*)?$/.test(lines[i])) return [];
    // 多行块形态：吃掉后续缩进行与顶格 "- " 列表项行
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j];
      if (!(/^[ \t]/.test(ln) || /^- /.test(ln))) break;
      const pm = ln.match(/#\s*panel:([A-Za-z0-9_-]+)/);
      if (pm) {
        if (ids.indexOf(pm[1]) === -1) ids.push(pm[1]);
        continue;
      }
      const provM = ln.match(/^[-\s]*provider:\s*([A-Za-z0-9._-]+)\s*$/);
      if (provM && FALLBACK_NATIVE_IDS.has(provM[1]) && ids.indexOf(provM[1]) === -1) {
        ids.push(provM[1]);
      }
    }
    break;
  }
  return ids;
}

// ── 生成 fallback_providers YAML 块 ────────────────────────────────────────
// entries: 面板 provider id 数组（首期单选，调用方已截断为最多 1 项）；
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
// 手法与 monitor.js providers 段一致：定位顶层键 → 吃掉块内行 → 整块替换；
// 键不存在时插到 model / providers 段之后。写入前后做正则自检，异常时
// 原样返回旧内容，绝不写坏 config.yaml。
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
    // 吃掉块内行：缩进行 + 顶格 "- " 列表项行（兼容 [] 单行形态——此时块内行数为 0）
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
// 现有逻辑只同步 active provider 的 key；回退触发时网关按环境变量取回退服务商 key，
// 缺失会导致 401，故保存回退配置时必须把回退服务商 key 一并写入 hermesEnvPath。
export function syncFallbackKeysToHermesEnv(fallbackIds, envProvidersPath, hermesEnvPath) {
  const ids = (fallbackIds || []).filter((id) => String(id).indexOf("local-") !== 0);
  if (ids.length === 0) return false;
  if (!existsSync(envProvidersPath)) return false;
  const provEnv = readFileSync(envProvidersPath, "utf8");
  let hermesEnv = existsSync(hermesEnvPath) ? readFileSync(hermesEnvPath, "utf8") : "";
  let dirty = false;
  ids.forEach((id) => {
    const envKey = fallbackEnvKey(id);
    if (!envKey) return;
    let m = provEnv.match(new RegExp(`^${envKey}=(.*)$`, "m"));
    // 非内置服务商兜底读取旧格式变量名
    if (!m && !PROVIDER_API_KEYS[id]) {
      m = provEnv.match(new RegExp(`^${legacyCustomEnvKey(id)}=(.*)$`, "m"));
    }
    if (!m || m[1].length === 0) return;
    const lineRe = new RegExp(`^${envKey}=.*$`, "m");
    const newLine = `${envKey}=${m[1]}`;
    if (lineRe.test(hermesEnv)) {
      if (hermesEnv.match(lineRe)[0] !== newLine) {
        hermesEnv = hermesEnv.replace(lineRe, newLine);
        dirty = true;
      }
    } else {
      hermesEnv += (hermesEnv.endsWith("\n") || hermesEnv === "" ? "" : "\n") + newLine + "\n";
      dirty = true;
    }
  });
  if (dirty) writeFileSync(hermesEnvPath, hermesEnv);
  return dirty;
}

// ============================================================================
// SECTION 7: CHAT HARDENING（来自 chat-hardening.js）
// ============================================================================

// 聊天加固模块（增量 checkpoint / finalize / resume）
// 移植自 veenyi-fnos-hermes-agent 项目
// ESM，与项目 monitor.js 一致。无外部依赖。
//
// 设计意图：流式回复期间周期性持久化半成品（带 _streaming 标记），
// 正常完成或出错时转正，避免断电/崩溃丢内容。
// 与多会话 liveRuns 运行表互不干扰（各管各的关切）。

const CHECKPOINT_INTERVAL_MS = 1000;   // 定时器检查周期
const CHECKPOINT_MIN_CHARS = 1000;     // 距上次 checkpoint 的字符增量阈值
const CHECKPOINT_MIN_TIME_MS = 5000;   // 距上次 checkpoint 的时间间隔阈值（ms）
const DEDUP_WINDOW_MS = 60000;         // WS→XHR 回退去重窗口（与 monitor.js 现有逻辑一致）

/**
 * 创建流式 checkpoint 工厂。
 *
 * @param {string} sessionId — 会话 ID（仅用于日志）
 * @param {object} session  — 调用方已加载的 in-memory session 对象引用；
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
     * 流结束时转正 _streaming 消息（移除标记）。
     * 若尚无 _streaming 消息则追加正式消息。
     *
     * @param {string} [content] — 最终内容；缺省时用 checkpointer 累积文本
     */
    finalize(content) {
      if (disposed) return;
      disposed = true;
      if (timer) { clearInterval(timer); timer = null; }
      const finalContent = (content != null && content !== "") ? String(content) : fullReply;
      if (!finalContent) {
        // 没有任何内容：若之前有 _streaming 消息也转正（保留 checkpoint 内容）
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

    /** 仅释放定时器，不做持久化（异常出口用；先前 checkpoint 保留给 resume 处理） */
    dispose() {
      disposed = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

/**
 * 会话 resume：把残留的 _streaming 消息转正（去掉标记，保留内容）。
 * 适用于加载/切换会话时调用——覆盖上次崩溃/断电留下的半成品状态。
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
