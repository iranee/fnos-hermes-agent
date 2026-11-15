"""基于 Hermes 原生、保留注释的配置 API 的精简模型写入器。

stdin: {action: prepare|commit, providers: [...], providerId, oldIds,
        fallbackIds: list|null, expectedRevision?: str|null}；--home 必填。
prepare 只读。commit 重新检查 revision，然后有意整体替换原始文档。
不应用默认值、迁移、env 展开或策略编辑。
revision 检查只能发现读取之后、写入之前被别人插入的修改，它既不是跨进程锁，也不是原子的“比较并交换”（CAS）。
"""
from __future__ import annotations

import argparse
import ast
import copy
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit


ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]*\Z")
ENV_KEY = re.compile(r"[A-Z_][A-Z0-9_]*\Z")


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value) or value in {"constructor", "prototype", "__proto__"}:
        raise ValueError("invalid provider id")
    return value


def line(value, label):
    if not isinstance(value, str) or any(c in value for c in "\r\n\0"):
        raise ValueError(f"{label} must be a string without newline/NUL")
    return value


def validate(payload):
    if not isinstance(payload, dict) or payload.get("action") not in {"prepare", "commit"}:
        raise ValueError("invalid action")
    rows, old_ids = payload.get("providers"), payload.get("oldIds", [])
    if not isinstance(rows, list) or not isinstance(old_ids, list):
        raise ValueError("providers and oldIds must be lists")
    for old in old_ids:
        identifier(old)
    providers, keys = {}, set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("invalid provider")
        pid = identifier(row.get("id"))
        if pid in providers:
            raise ValueError("duplicate provider id")
        expected = "openai-api" if pid == "openai" else pid
        if row.get("hermesId") != expected:
            raise ValueError("invalid Hermes provider mapping")
        if not line(row.get("model"), "model").strip():
            raise ValueError("model is required")
        if not isinstance(row.get("custom"), bool):
            raise ValueError("custom must be a boolean")
        key = line(row.get("envKey", ""), "envKey")
        if key and (not ENV_KEY.fullmatch(key) or not (key.endswith("_API_KEY") or key == "HF_TOKEN")):
            raise ValueError("invalid provider environment variable")
        if key and key in keys:
            raise ValueError("provider environment variables collide")
        keys.add(key)
        if row.get("apiMode") not in {"chat_completions", "anthropic_messages"}:
            raise ValueError("invalid apiMode")
        if row["custom"]:
            url = line(row.get("base_url", ""), "base_url")
            parsed = urlsplit(url)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError("custom base_url must be an http(s) URL without credentials")
        for field in ("temperature", "max_tokens"):
            value = row.get(field)
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"invalid {field}")
            if field == "max_tokens" and (not isinstance(value, int) or value < 1):
                raise ValueError("invalid max_tokens")
        providers[pid] = row
    active = identifier(payload.get("providerId"))
    if active not in providers:
        raise ValueError("active provider is not configured")
    fallbacks = payload.get("fallbackIds")
    if fallbacks is not None:
        if not isinstance(fallbacks, list):
            raise ValueError("fallbackIds must be a list or null")
        seen = set()
        for pid in fallbacks:
            identifier(pid)
            if pid not in providers or pid == active or pid in seen:
                raise ValueError("invalid fallback provider")
            seen.add(pid)
    return providers


def revision(path):
    if path.is_symlink():
        raise ValueError("config.yaml must not be a symlink")
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except FileNotFoundError:
        return None


def panel_fallback_id(entry, old_ids):
    if not isinstance(entry, dict):
        return None
    # 命名路由是权威来源。官方的逐元素列表合并在条目换位时可能保留旧的面板行内注释。
    pid = entry.get("provider")
    if pid != "custom":
        pid = "openai" if pid == "openai-api" else pid
        return pid if pid in old_ids else None
    # 旧版面板把自定义服务商存成通用 'custom' 条目并带 panel:<id> 注释。
    comments = getattr(entry, "ca", None)
    if comments:
        for tokens in comments.items.values():
            for token in tokens:
                if token is not None and hasattr(token, "value"):
                    match = re.search(r"#\s*panel:([A-Za-z0-9_-]+)", token.value)
                    if match and match[1] in old_ids:
                        return match[1]
    return None


def reject_shared_aliases(raw):
    # 官方的 round-trip 写入器会原地修改现有节点。与未托管配置共享的别名直接拒绝，
    # 而不是改动它的另一个目标。
    seen = {}

    def visit(value, managed):
        if not isinstance(value, (dict, list)):
            return
        if id(value) in seen:
            if managed or seen[id(value)]:
                raise ValueError("model/provider fields share YAML aliases; detach aliases before saving")
            return
        seen[id(value)] = managed
        for child in value.values() if isinstance(value, dict) else value:
            visit(child, managed)

    for key, value in raw.items():
        visit(value, key in {"model", "providers", "fallback_providers"})


def build_document(raw, roundtrip, payload, providers):
    reject_shared_aliases(roundtrip)
    # 在内存中的原始文档里把被编辑的段落与别名解除关联。
    result = copy.deepcopy(raw)
    model = raw.get("model")
    if model is not None and not isinstance(model, (str, dict)):
        raise ValueError("model must be a mapping or a legacy string")
    model = copy.deepcopy(model) if isinstance(model, dict) else {}
    active = providers[payload["providerId"]]
    # 这些端点/凭证字段属于模型选择。留下来会覆盖新选服务商的 registry/命名路由。
    for field in ("base_url", "api_base", "api_key", "api", "key_env", "api_key_env", "api_mode"):
        model.pop(field, None)
    model.update(provider=active["hermesId"], default=active["model"])
    for field in ("temperature", "max_tokens"):
        if active.get(field) is not None:
            model[field] = active[field]
    result["model"] = model

    entries = raw.get("providers", {})
    if not isinstance(entries, dict):
        raise ValueError("providers must be a mapping")
    entries = copy.deepcopy(entries)
    old_ids = set(payload.get("oldIds", []))
    for pid in old_ids:
        if pid not in providers or not providers[pid]["custom"]:
            entries.pop(pid, None)
    for pid, row in providers.items():
        if not row["custom"]:
            continue
        if pid in entries and pid not in old_ids:
            raise ValueError(f"provider id already belongs to non-panel config: {pid}")
        entry = entries.get(pid, {})
        if not isinstance(entry, dict):
            raise ValueError("panel provider must be a mapping")
        entry = copy.deepcopy(entry)
        entry.update(base_url=row["base_url"], default_model=row["model"], api_mode=row["apiMode"])
        # 否则凭证指针别名在命名服务商解析时优先于 api_key，可能路由到旧账号。
        for field in ("key_env", "api_key_env"):
            entry.pop(field, None)
        if row["envKey"]:
            entry["api_key"] = "${" + row["envKey"] + "}"
        else:
            entry.pop("api_key", None)
        entries[pid] = entry
    if entries or "providers" in raw:
        result["providers"] = entries

    fallbacks = roundtrip.get("fallback_providers", [])
    if not isinstance(fallbacks, list):
        raise ValueError("fallback_providers must be a list")
    selected = payload.get("fallbackIds")
    removed = old_ids - providers.keys()
    kept = []
    for entry in fallbacks:
        owner = panel_fallback_id(entry, old_ids)
        if owner in removed or (selected is not None and owner is not None):
            continue
        kept.append(copy.deepcopy(entry))
    if selected is not None:
        for pid in selected:
            row = providers[pid]
            # 命名的自定义路由保留各自的传输方式和所用凭证。内置服务商使用原生 registry，
            # 而不是通用的 custom URL。
            kept.append({"provider": row["hermesId"], "model": row["model"]})
    if selected is not None or len(kept) != len(fallbacks):
        result["fallback_providers"] = kept
    return result


def run(payload, home):
    if isinstance(payload, dict) and payload.get("action") in {"snapshot", "patch", "resolve-key"}:
        return run_real(payload, home)
    providers = validate(payload)
    # 导入 Hermes 之前先设置 home。绝不调用 load_config/save_config：
    # 它们会应用默认值、迁移和托管策略，超出本模块的职责范围。
    os.environ["HERMES_HOME"] = str(home)
    if os.environ.get("HERMES_CONFIG_BACKEND", "file").strip() not in {"", "file"}:
        raise ValueError("model panel requires the local file config backend")
    from hermes_cli.config import require_readable_config_before_write, atomic_config_replace
    from hermes_yaml import roundtrip_yaml

    path = home / "config.yaml"
    before = revision(path)
    if payload["action"] == "commit" and ("expectedRevision" not in payload or payload["expectedRevision"] != before):
        raise ValueError("config.yaml changed after preparation; retry save")
    raw = require_readable_config_before_write(path)
    yaml = roundtrip_yaml()
    rt = yaml.load(path.read_text(encoding="utf-8")) if before is not None else {}
    if rt is None:
        rt = {}
    if not isinstance(rt, dict):
        raise ValueError("config.yaml must be a mapping")
    document = build_document(raw, rt, payload, providers)
    # 在 prepare 阶段先走一遍序列化，早于 Node 发布任何 key 文件。
    yaml.dump(document, io.StringIO())
    if revision(path) != before:
        raise ValueError("config.yaml changed during preparation; retry save")
    if payload["action"] == "commit":
        atomic_config_replace(path, document)
    return {"ok": True, "revision": before}


# Real-file contract. Legacy prepare/commit above is deliberately independent.
# A revision is an optimistic read check, NOT a lock shared with WebApp writers.
class ConfigurationError(ValueError):
    def __init__(self, message, status=400, **details):
        super().__init__(message)
        self.details = {"status": status, "committed": [], "configWriteUncertain": False,
                        "envWriteUncertain": False, **details}


MODEL_FIELDS = {"provider", "default", "temperature", "max_tokens", "context_length", "reasoning_effort"}
PROVIDER_FIELDS = {"name", "model", "base_url", "api_mode", "temperature", "max_tokens",
                   "context_length", "discover_models", "enabled"}
KEY_FIELDS = ("key_env", "api_key_env", "api_key", "keyEnv", "apiKeyEnv", "apiKey", "key_cmd")
ROUTE_FIELDS = ("base_url", "api_base", "api", "api_key", "key_env", "api_key_env", "api_mode",
                "transport", "baseUrl", "apiKey", "keyEnv", "apiKeyEnv", "apiMode", "key_cmd")
ENV_REF = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def real_id(value):
    # Hermes accepts literal names including dots, colons, spaces and numeric YAML keys.
    if not line(value, "provider id").strip() or value != value.strip():
        raise ConfigurationError("provider id must be nonempty without surrounding whitespace")
    return value


def file_bytes(path):
    if path.is_symlink():
        raise ConfigurationError("configuration files must not be symlinks")
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def real_files(home):
    return (file_bytes(home / "config.yaml"), file_bytes(home / ".env"))


def files_revision(files):
    digest = hashlib.sha256(b"hermes-model-files-v1\0")
    for value in files:
        digest.update(b"missing\0" if value is None else b"present\0" + len(value).to_bytes(8, "big") + value)
    return digest.hexdigest()


def check_files(home, expected):
    if real_files(home) != expected:
        raise ConfigurationError("config.yaml or .env changed; reload before saving", 409)


def disk_env(content):
    from agent.secret_scope import _parse_env_text, _decode_env_bytes
    return _parse_env_text(_decode_env_bytes(content or b""))


def real_document(home, files):
    from hermes_cli.config import require_readable_config_before_write
    from hermes_yaml import roundtrip_yaml
    # Strict official read before constructing any write; never load_config/defaults/migrations.
    raw = require_readable_config_before_write(home / "config.yaml")
    rt = roundtrip_yaml().load((files[0] or b"").decode("utf-8"))
    rt = {} if rt is None else rt
    if not isinstance(rt, dict):
        raise ConfigurationError("config.yaml must be a mapping")
    for key, kind in (("providers", dict), ("custom_providers", list), ("fallback_providers", list)):
        if key in raw and not isinstance(raw[key], kind):
            raise ConfigurationError(f"{key} has an invalid structure")
    if "model" in raw and not isinstance(raw["model"], (str, dict)):
        raise ConfigurationError("model must be a mapping or legacy string")
    check_files(home, files)
    return raw, rt


def model_block(raw):
    value = raw.get("model", {})
    return {"default": value} if isinstance(value, str) else value


def provider_records(raw):
    from hermes_cli.auth import PROVIDER_REGISTRY
    from hermes_cli.config_providers import _normalize_custom_provider_entry
    from hermes_cli.providers import custom_provider_aliases, HERMES_OVERLAYS
    records = []
    model = model_block(raw)
    active = str(model.get("provider") or "")
    for key, entry in raw.get("providers", {}).items():
        if isinstance(entry, dict):
            pid = str(key)
            normalized = _normalize_custom_provider_entry(entry, provider_key=pid) or entry
            aliases = custom_provider_aliases(str(entry.get("name") or pid), pid)
            current = active.lower() in aliases
            records.append({"id": pid, "source": "providers", "path": ("providers", key),
                            "entry": entry, "normalized": normalized, "is_current": current})
    for index, entry in enumerate(raw.get("custom_providers", [])):
        normalized = _normalize_custom_provider_entry(entry)
        if normalized is None:
            continue
        pid = str(entry.get("name") or normalized["name"])
        aliases = custom_provider_aliases(pid, str(entry.get("provider_key") or ""))
        current = active.lower() in aliases or (active == "custom" and
            str(model.get("base_url") or "").rstrip("/") == normalized["base_url"].rstrip("/"))
        records.append({"id": pid, "source": "custom_providers", "path": ("custom_providers", index),
                        "entry": entry, "normalized": normalized, "is_current": current})
    # The static official registry is available offline. Avoid lazy registry discovery, which can
    # load plugins/catalogues, consult auth pools or write cache files during a GET.
    for pid, spec in dict.items(PROVIDER_REGISTRY):
        records.append({"id": pid, "source": "registry", "path": None, "entry": {},
                        "normalized": {}, "spec": spec, "is_current": active == pid})
    if not dict.__contains__(PROVIDER_REGISTRY, "openrouter"):
        # Official model_setup_flows._model_flow_openrouter uses a separate ProviderConfig;
        # auth.PROVIDER_REGISTRY deliberately excludes this built-in. Do not mutate the registry.
        from hermes_cli.auth import ProviderConfig, OPENROUTER_BASE_URL
        overlay = HERMES_OVERLAYS.get("openrouter")
        spec = ProviderConfig(id="openrouter", name="OpenRouter", auth_type="api_key",
                              api_key_env_vars=("OPENROUTER_API_KEY",), inference_base_url=OPENROUTER_BASE_URL,
                              base_url_env_var=overlay.base_url_env_var if overlay else "")
        records.append({"id": "openrouter", "source": "registry", "path": None, "entry": {},
                        "normalized": {}, "spec": spec, "is_current": active == "openrouter"})
    if active and not any(r["is_current"] for r in records):
        records.append({"id": active, "source": "direct-config", "path": ("model",),
                        "entry": model, "normalized": model, "is_current": True})
    return records


def entry_key(entry):
    from agent.secret_scope import get_secret_str
    pointer = entry.get("key_env") or entry.get("api_key_env") or entry.get("keyEnv") or entry.get("apiKeyEnv")
    if pointer:
        value = get_secret_str(str(pointer), "").strip()
        if value:
            return value
    value = entry.get("api_key") or entry.get("apiKey") or ""
    if not isinstance(value, str):
        return ""
    return ENV_REF.sub(lambda m: get_secret_str(m[1], ""), value).strip()


def record_key(record, raw):
    # Use Hermes' scoped credential resolver over ONLY the captured DATA/.env. No inherited
    # monitor env, VAR key store, OAuth refresh, command execution or credential-pool mutation.
    from agent.secret_scope import get_secret_str
    if record["is_current"]:
        key = entry_key(model_block(raw))
        if key:
            return key
    key = entry_key(record["normalized"])
    if key:
        return key
    spec = record.get("spec")
    if spec:
        from hermes_cli.auth import _usable_declared_secret
        for name in spec.api_key_env_vars:
            key = _usable_declared_secret(record["id"], get_secret_str(name, ""), name)
            if key:
                return key
    return ""


def public_fields(entry, fields):
    # Allowlist: unknown objects, extra_headers and request_overrides may contain credentials.
    return {key: copy.deepcopy(entry[key]) for key in fields if key in entry}


def key_flags(entry):
    flags = {key: entry[key] for key in ("key_env", "api_key_env", "keyEnv", "apiKeyEnv")
             if isinstance(entry.get(key), str)}
    value = entry.get("api_key", entry.get("apiKey"))
    if isinstance(value, str) and ENV_REF.fullmatch(value):
        flags["api_key_env_ref"] = value
    flags["extra_headers_configured"] = bool(entry.get("extra_headers"))
    flags["key_cmd_configured"] = bool(entry.get("key_cmd"))
    return flags


def static_catalog_data(filename):
    """Read installed catalogue data, never import/exec its plugin sync or lazy caches.

    Only literal containers and the data-only expressions used by the official tables are
    understood. New executable expressions fail closed to unavailable, not guessed models.
    """
    import hermes_cli
    try:
        source = (Path(hermes_cli.__file__).parent / filename).read_text(encoding="utf-8")
        tree = ast.parse(source)
    except (OSError, SyntaxError, UnicodeError):
        return {}
    values = {}

    def data(node, scope, depth=0):
        if depth > 40:
            raise ValueError("catalogue expression nesting")
        def read(child, local=scope):
            return data(child, local, depth + 1)
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            return scope[node.id]
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            items = [read(item) for item in node.elts]
            return tuple(items) if isinstance(node, ast.Tuple) else set(items) if isinstance(node, ast.Set) else items
        if isinstance(node, ast.Dict):
            result = {}
            for key, value in zip(node.keys, node.values):
                try:
                    result[read(key)] = read(value)
                except (ValueError, KeyError, TypeError):
                    continue  # One dynamically computed provider must not hide literal rows.
            return result
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return read(node.left) + read(node.right)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return not read(node.operand)
        if isinstance(node, ast.BoolOp):
            parts = [read(part) for part in node.values]
            return all(parts) if isinstance(node.op, ast.And) else any(parts)
        if isinstance(node, ast.Compare) and len(node.ops) == 1:
            left, right = read(node.left), read(node.comparators[0])
            if isinstance(node.ops[0], ast.In):
                return left in right
            if isinstance(node.ops[0], ast.NotIn):
                return left not in right
        if isinstance(node, ast.IfExp):
            return read(node.body if read(node.test) else node.orelse)
        if isinstance(node, ast.Call) and not node.keywords:
            args = [read(arg) for arg in node.args]
            if isinstance(node.func, ast.Name) and len(args) == 1:
                if node.func.id == "list":
                    return list(args[0])
                if node.func.id == "_CuratedCatalog" and isinstance(args[0], dict):
                    return args[0]  # Data wrapper only; never construct the lazy class.
            if isinstance(node.func, ast.Attribute):
                owner = read(node.func.value)
                if node.func.attr == "get" and isinstance(owner, dict):
                    return owner.get(*args)
                if node.func.attr == "endswith" and isinstance(owner, str):
                    return owner.endswith(*args)
        if isinstance(node, ast.ListComp) and len(node.generators) == 1:
            gen = node.generators[0]
            targets = gen.target.elts if isinstance(gen.target, ast.Tuple) else [gen.target]
            if gen.is_async or not all(isinstance(t, ast.Name) for t in targets):
                raise ValueError("unsupported catalogue comprehension")
            result = []
            for item in read(gen.iter):
                parts = item if isinstance(gen.target, ast.Tuple) else [item]
                if len(parts) != len(targets):
                    raise ValueError("invalid catalogue tuple")
                local = {**scope, **{t.id: value for t, value in zip(targets, parts)}}
                if all(read(condition, local) for condition in gen.ifs):
                    result.append(read(node.elt, local))
            return result
        raise ValueError("non-static catalogue expression")

    for statement in tree.body:
        targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target] if isinstance(statement, ast.AnnAssign) else []
        for target in targets:
            if isinstance(target, ast.Name):
                try:
                    values[target.id] = data(statement.value, values)
                except (ValueError, KeyError, TypeError):
                    values.pop(target.id, None)
    return values


def official_model_catalog():
    data = static_catalog_data("models_catalog_static.py")
    table = data.get("_PROVIDER_MODELS", {})
    table = dict(table) if isinstance(table, dict) else {}
    for pid, name in (("openrouter", "OPENROUTER_MODELS"), ("ai-gateway", "VERCEL_AI_GATEWAY_MODELS")):
        if isinstance(data.get(name), list):
            table[pid] = [row[0] for row in data[name] if isinstance(row, (list, tuple)) and row]
    # Executable catalogue finalizers are intentionally not run. Their literal input is useful,
    # but mark it as partial: no generated forward-compat IDs, cache entries or plugin models.
    partial = set()
    for pid, items in (("xai", data.get("_XAI_STATIC_FALLBACK")),
                       ("xai-oauth", data.get("_XAI_STATIC_FALLBACK")),
                       ("openai-codex", static_catalog_data("codex_models.py").get("DEFAULT_CODEX_MODELS"))):
        if pid not in table and isinstance(items, list):
            table[pid] = items
            partial.add(pid)
    return {pid: {"ids": list(dict.fromkeys(v for v in items if isinstance(v, str) and v)),
                  "partial": pid in partial}
            for pid, items in table.items() if isinstance(pid, str) and isinstance(items, list)}


def make_snapshot(raw, files):
    from agent.secret_scope import get_secret_str
    from hermes_cli.config_providers import _canonical_api_mode
    from hermes_cli.providers import HERMES_OVERLAYS, TRANSPORT_TO_API_MODE
    model = model_block(raw)
    records = provider_records(raw)
    official_catalog = official_model_catalog()
    rows = []
    for record in records:
        entry, norm = record["entry"], record["normalized"]
        spec = record.get("spec")
        current = record["is_current"]
        fields = public_fields(entry, PROVIDER_FIELDS | {"default_model", "transport", "protocol"})
        base = norm.get("base_url") or norm.get("url") or norm.get("api") or ""
        mode = _canonical_api_mode(str(norm.get("api_mode") or norm.get("transport") or ""))
        if spec:
            base = get_secret_str(spec.base_url_env_var, "") if spec.base_url_env_var else ""
            base = base or spec.inference_base_url
            overlay = HERMES_OVERLAYS.get(record["id"])
            mode = TRANSPORT_TO_API_MODE.get(overlay.transport, overlay.transport) if overlay else ""
            fields["auth_type"] = spec.auth_type
            fields["api_key_env_vars"] = list(spec.api_key_env_vars)
        if current:
            base = model.get("base_url") or model.get("api_base") or base
            mode = model.get("api_mode") or model.get("transport") or mode
        fields.update(id=record["id"], source=record["source"], is_current=current,
                      name=norm.get("name") or (spec.name if spec else record["id"]),
                      model=(model.get("default", model.get("name", "")) if current else
                             norm.get("model") or norm.get("default_model") or ""),
                      base_url=base, api_mode=mode,
                      temperature=model.get("temperature", entry.get("temperature")) if current else entry.get("temperature"),
                      max_tokens=model.get("max_tokens", entry.get("max_tokens")) if current else entry.get("max_tokens"),
                      api_key_configured=bool(record_key(record, raw)), **key_flags(entry))
        # Return catalogue IDs only; preserve arbitrary metadata on disk rather than expose secrets
        # nested inside model route overrides.
        catalog = norm.get("models", {})
        fields["models"] = list(catalog) if isinstance(catalog, dict) else []
        official = official_catalog.get(record["id"]) if spec else None
        fields["official_models"] = official["ids"] if official else []
        fields["official_models_source"] = "installed-kernel-static" if official else ""
        fields["official_models_partial"] = official["partial"] if official else False
        rows.append(fields)
    active = next((r for r in records if r["is_current"]), None)
    visible_model = public_fields(model, MODEL_FIELDS | {"base_url", "api_base", "api_mode", "transport", "name"})
    visible_model.update(key_flags(model))
    visible_model["api_key_configured"] = bool(record_key(active, raw)) if active else bool(entry_key(model))
    # Raw fallbacks may contain inline credentials, headers and arbitrary nested secrets.
    # This deliberately non-list summary cannot be submitted as a complete patch list.
    # Only callers with the original document can explicitly replace fallbacks; omission keeps it.
    return {"ok": True, "revision": files_revision(files), "model": visible_model,
            "providers": rows, "fallback_providers": {
                "read_only": True, "patch_input": False,
                "count": len(raw.get("fallback_providers", []))}}


def validate_changes(changes, allowed):
    if not isinstance(changes, dict) or changes.keys() - allowed:
        raise ConfigurationError("unsupported patch fields")
    for key, value in changes.items():
        if key in {"temperature", "max_tokens", "context_length"}:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ConfigurationError(f"invalid {key}")
            if key != "temperature" and (not isinstance(value, int) or value < 1):
                raise ConfigurationError(f"invalid {key}")
        elif key in {"enabled", "discover_models"}:
            if not isinstance(value, bool):
                raise ConfigurationError(f"invalid {key}")
        else:
            line(value, key)
            if key in {"provider", "default", "model", "name"} and not value.strip():
                raise ConfigurationError(f"{key} must not be empty")
            if key == "api_mode" and value not in {"", "chat_completions", "codex_responses", "anthropic_messages", "bedrock_converse"}:
                raise ConfigurationError("invalid api_mode")
            if key == "base_url":
                url = urlsplit(value)
                if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password:
                    raise ConfigurationError("base_url must be an http(s) URL without credentials")


def validate_secret(value):
    line(value, "api_key")
    if value != value.strip() or not value.isascii() or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ConfigurationError("api_key must be ASCII without surrounding whitespace or control characters")
    if "****" in value or "${" in value or value.startswith("<redacted"):
        raise ConfigurationError("display-only credentials cannot be saved")


def reject_edited_aliases(rt, paths):
    occurrences = {}
    def visit(value, path, ancestors):
        container = isinstance(value, (dict, list))
        if not container and not getattr(getattr(value, "anchor", None), "value", None):
            return
        occurrences.setdefault(id(value), []).append(path)
        if not container:
            return
        if id(value) in ancestors:
            raise ConfigurationError("recursive YAML aliases are not editable")
        # Record children at every alias location, but do not expand cycles.
        for key, child in value.items() if isinstance(value, dict) else enumerate(value):
            visit(child, (*path, key), ancestors | {id(value)})
        for merged in getattr(value, "merge", ()):
            # A merge's inherited fields live at the mapping's effective path, not under a
            # literal '<<' child. Otherwise edits to model.temperature miss a shared template.
            visit(merged, path, ancestors | {id(value)})
    visit(rt, (), set())
    for aliases in occurrences.values():
        if len(aliases) < 2:
            continue
        if any(a[:len(p)] == p or p[:len(a)] == a for a in aliases for p in paths):
            raise ConfigurationError("edited fields share YAML aliases; detach aliases before saving")


def choose_record(records, pid, source=None):
    if source is not None and (not isinstance(source, str) or source not in {
            "providers", "custom_providers", "registry", "direct-config"}):
        raise ConfigurationError("invalid provider source")
    matches = [r for r in records if r["id"] == pid and (source is None or source == r["source"])]
    if len(matches) > 1:
        raise ConfigurationError("ambiguous provider id; supply source")
    return matches[0] if matches else None


def at_path(document, path):
    for key in path:
        document = document[key]
    return document


def credential_references(raw):
    """Index even unknown/fallback references so explicit edits never commandeer shared slots."""
    references = {}
    def visit(value, path, ancestors):
        if isinstance(value, str):
            names = {match[1] for match in ENV_REF.finditer(value)}
            if path and path[-1] in {"key_env", "api_key_env", "keyEnv", "apiKeyEnv"}:
                names.add(value)
            for name in names:
                references.setdefault(name, set()).add(path)
        elif isinstance(value, (dict, list)) and id(value) not in ancestors:
            for key, child in value.items() if isinstance(value, dict) else enumerate(value):
                visit(child, (*path, key), ancestors | {id(value)})
    visit(raw, (), set())
    return references


def custom_key_slot(record, records, references, env, reserved, clearing=False):
    from hermes_cli.config import custom_endpoint_key_env
    canonical = custom_endpoint_key_env(record["id"])
    identity = json.dumps([record["source"], record["id"]], ensure_ascii=True)
    qualified = custom_endpoint_key_env("slot_" + hashlib.sha256(identity.encode()).hexdigest())
    owned = {(*record["path"], field) for field in KEY_FIELDS}
    if record["is_current"]:
        owned.update(("model", field) for field in KEY_FIELDS)

    def available(name):
        uses = references.get(name, set())
        return (name not in reserved and not uses - owned and
                (name not in env or bool(uses & owned)))

    # Retain our previous unshared slot, including a qualified collision suffix. Never reuse an
    # arbitrary user pointer: another service may consume it even without a YAML reference.
    for field in KEY_FIELDS:
        pointer = record["entry"].get(field)
        if not isinstance(pointer, str):
            continue
        match = ENV_REF.fullmatch(pointer)
        pointer = match[1] if match else pointer
        if (pointer == canonical or pointer == qualified or re.fullmatch(
                re.escape(qualified) + r"_[1-9][0-9]*", pointer)) and available(pointer):
            return pointer
    if clearing:
        return None  # detach shared/unowned references, do not delete their .env value
    collides = any(r is not record and custom_endpoint_key_env(r["id"]) == canonical for r in records)
    if not collides and available(canonical):
        return canonical
    candidate, index = qualified, 0
    while not available(candidate):
        index += 1
        candidate = f"{qualified}_{index}"
    return candidate


def build_real_patch(raw, rt, payload, env):
    if payload.keys() - {"action", "expectedRevision", "model", "providers", "removeProviderIds", "fallback_providers"}:
        raise ConfigurationError("unsupported patch fields")
    changes = payload.get("model", {})
    validate_changes(changes, MODEL_FIELDS)
    rows, removals = payload.get("providers", []), payload.get("removeProviderIds", [])
    if not isinstance(rows, list) or not isinstance(removals, list):
        raise ConfigurationError("providers and removeProviderIds must be lists")
    # Keep the original round-trip nodes (comments, quoting, flow style and anchors).
    result = copy.deepcopy(rt)
    records = provider_records(result)
    references = credential_references(raw)
    touched, secrets, seen = [], [], set()
    for row in rows:
        if not isinstance(row, dict) or row.keys() - {"id", "source", "changes", "api_key"}:
            raise ConfigurationError("invalid provider patch")
        pid = real_id(row.get("id"))
        source = row.get("source")
        edits = row.get("changes", {})
        validate_changes(edits, PROVIDER_FIELDS)
        record = choose_record(records, pid, source)
        if record is None:
            if source not in {None, "providers"} or not edits.get("base_url") or not edits.get("model"):
                raise ConfigurationError("new providers require base_url and model")
            entries = result.setdefault("providers", {})
            if pid in entries:
                raise ConfigurationError("provider entry is not editable")
            entries[pid] = {}
            record = {"id": pid, "source": "providers", "path": ("providers", pid), "entry": entries[pid], "is_current": False}
            records.append(record)
        identity = (record["source"], record["path"] or record["id"])
        if identity in seen:
            raise ConfigurationError("duplicate provider patch")
        seen.add(identity)
        path = record["path"]
        if path is None:
            # Built-in route metadata is owned by the official registry, not a synthesized
            # providers entry. Current tuning belongs to model; inactive tuning requires activation.
            if edits:
                raise ConfigurationError("registry metadata is read-only; use model patch for active tuning")
            entry = model_block(result) if record["is_current"] else {}
        else:
            entry = at_path(result, path)
            if isinstance(entry, str):
                entry = {"default": entry}
                result["model"] = entry
            for field, value in edits.items():
                target = "default" if field == "model" and path == ("model",) else field
                # Official normalization prefers model, then default_model (snake spelling
                # wins over defaultModel). Update existing spellings without adding a catalogue.
                targets = [target]
                if field == "model" and path != ("model",):
                    targets = [k for k in ("model", "default_model", "defaultModel") if k in entry] or ["model"]
                if field == "api_mode":
                    for alias in ("transport", "apiMode"):
                        entry.pop(alias, None)
                        touched.append((*path, alias))
                    if not value:
                        entry.pop("api_mode", None)
                        touched.append((*path, "api_mode"))
                        continue
                for target in targets:
                    entry[target] = value
                    touched.append((*path, target))
        if "api_key" in row:
            value = row["api_key"]
            validate_secret(value)
            spec = record.get("spec")
            if spec and not spec.api_key_env_vars:
                raise ConfigurationError("this registry provider does not use an editable API key")
            env_key = spec.api_key_env_vars[0] if spec else custom_key_slot(
                record, records, references, env, {key for key, _ in secrets}, clearing=not value)
            # Write registry credentials to the declared canonical slot, never a custom pointer
            # that is about to be removed. For custom routes also clear the current model override,
            # but only on an explicit api_key submission, never on metadata-only patches.
            if path is not None:
                for field in KEY_FIELDS:
                    entry.pop(field, None)
                    touched.append((*path, field))
            if record["is_current"]:
                for field in KEY_FIELDS:
                    model_block(result).pop(field, None)
                    touched.append(("model", field))
            if value and not spec:
                entry["key_env"] = env_key
            if env_key:
                secrets.append((env_key, value))
            if spec and not value:
                # Removing just the first declaration would resurrect a secondary API key.
                owned = {("model", field) for field in KEY_FIELDS} if record["is_current"] else set()
                for name in spec.api_key_env_vars[1:]:
                    if references.get(name, set()) - owned:
                        raise ConfigurationError("secondary registry credential is shared; detach references before clearing")
                    secrets.append((name, ""))
    for pid in removals:
        real_id(pid)
        record = choose_record(records, pid)
        if record is None or record["source"] not in {"providers", "custom_providers"}:
            raise ConfigurationError("only stored providers can be removed")
        identity = (record["source"], record["path"])
        if identity in seen:
            raise ConfigurationError("provider cannot be patched and removed together")
        seen.add(identity)
        if record["is_current"] and (not changes.get("provider") or changes["provider"] == model_block(raw).get("provider")):
            raise ConfigurationError("select another provider before removing the current provider")
        path = record["path"]
        if path[0] == "providers":
            del result["providers"][path[1]]
        else:
            # Delete by original entry identity; indices shift after a preceding removal.
            result["custom_providers"].remove(record["entry"])
        touched.append(path)
        # No env deletion: credentials may be shared by surviving providers/fallbacks.
    if changes:
        old = model_block(result)
        model = copy.deepcopy(old)
        if "provider" in changes and changes["provider"] != old.get("provider"):
            selected = changes["provider"]
            from hermes_cli.providers import custom_provider_aliases
            candidates = provider_records(result)
            if not any(selected == r["id"] or selected.lower() in custom_provider_aliases(
                    str(r["entry"].get("name") or r["id"]), r["id"]) for r in candidates):
                raise ConfigurationError("selected provider is not configured")
            if "default" not in changes:
                raise ConfigurationError("activating a provider requires model.default")
            # Same route-change cleanup as official model_selection_config_updates, without
            # model catalogue/network probing or copying another endpoint's plaintext key.
            for field in (*ROUTE_FIELDS, "context_length"):
                model.pop(field, None)
            touched.append(("model",))
        model.update(changes)
        result["model"] = model
        touched.extend(("model", key) for key in changes)
    if "fallback_providers" in payload:
        fallbacks = payload["fallback_providers"]
        if not isinstance(fallbacks, list) or any(not isinstance(e, dict) for e in fallbacks):
            raise ConfigurationError("fallback_providers must be a complete list of objects")
        # JSON object lists are copied exactly, including unknown fields and order.
        result["fallback_providers"] = copy.deepcopy(fallbacks)
        touched.append(("fallback_providers",))
    if len({key for key, _ in secrets}) != len(secrets):
        raise ConfigurationError("submitted credentials collide on an environment variable")
    reject_edited_aliases(rt, touched)
    return result, secrets


def plan_env_writes(home, before, secrets):
    from hermes_cli import config
    plans = []
    content = before
    for key, value in secrets:
        config.validate_env_var_name_for_write(key)
        config.require_env_writable(key, "set" if value else "remove")
        # Simulate the official serializer before the first write. This also rejects malformed
        # duplicate assignments that save_env_value would leave shadowing the submitted key.
        text = (content or b"").decode("utf-8-sig")
        lines = config._sanitize_env_lines(io.StringIO(text, newline=None).readlines())
        matches = [i for i, ln in enumerate(lines) if config._env_line_defines_key(ln, key)]
        if value:
            if len(matches) > 1:
                raise ConfigurationError("duplicate credential assignments in .env; resolve them before saving")
            line_value = f"{key}={config._quote_env_value(value)}\n"
            if matches:
                lines[matches[0]] = line_value
            else:
                if lines and not lines[-1].endswith("\n"):
                    lines[-1] += "\n"
                lines.append(line_value)
            after = "".join(lines).encode("utf-8")
        elif matches:
            after = "".join(ln for ln in lines if not config._env_line_defines_key(ln, key)).encode("utf-8")
        else:
            after = content
        parsed = disk_env(after)
        if (value and parsed.get(key) != value) or (not value and key in parsed):
            raise ConfigurationError("credential cannot round-trip through official .env serialization")
        plans.append((key, value, after))
        content = after
    return plans


def minimal_temperature_bytes(raw, rt, document, content):
    # The official emitter reindents sequences; replace a verified scalar token to preserve other bytes.
    from hermes_yaml import roundtrip_yaml, safe_load
    from ruamel.yaml.tokens import ScalarToken
    old, new = model_block(raw), model_block(document)
    if not content or not isinstance(raw.get("model"), dict) or "temperature" not in new:
        return None
    previous, value = old.get("temperature"), new["temperature"]
    if (isinstance(previous, bool) or not isinstance(previous, (int, float)) or
            isinstance(value, bool) or not isinstance(value, (int, float)) or previous == value):
        return None
    expected = copy.deepcopy(raw)
    expected["model"]["temperature"] = value
    if expected != document:
        return None
    if "temperature" not in (rt["model"].lc.data or {}):
        return None  # inherited merge values do not have a local scalar token
    position = rt["model"].lc.value("temperature")
    text = content.decode("utf-8")
    for token in roundtrip_yaml().scan(text):
        if isinstance(token, ScalarToken) and (token.start_mark.line, token.start_mark.column) == position:
            replacement = repr(float(value)) if isinstance(value, float) else str(int(value))
            updated = (text[:token.start_mark.index] + replacement + text[token.end_mark.index:]).encode("utf-8")
            if safe_load(updated) != document:
                raise ConfigurationError("minimal temperature edit cannot round-trip safely")
            return updated
    return None


def run_real(payload, home):
    from contextlib import ExitStack
    os.environ["HERMES_HOME"] = str(home)
    if os.environ.get("HERMES_CONFIG_BACKEND", "file").strip() not in {"", "file"}:
        raise ConfigurationError("model configuration requires the local file backend")
    from hermes_cli import config
    from agent import secret_scope
    from hermes_yaml import roundtrip_yaml
    files = real_files(home)
    if payload["action"] == "patch" and payload.get("expectedRevision") != files_revision(files):
        raise ConfigurationError("expectedRevision is required and must match config.yaml and .env", 409)
    raw, rt = real_document(home, files)
    # Scope excludes stale inherited process credentials; neither this scope nor a GET writes env.
    with ExitStack() as stack:
        token = secret_scope.set_secret_scope(disk_env(files[1]), profile_home=str(home))
        stack.callback(secret_scope.reset_secret_scope, token)
        token = secret_scope.set_multiplex_context(True)
        stack.callback(secret_scope.reset_multiplex_context, token)
        if payload["action"] == "snapshot":
            result = make_snapshot(raw, files)
            check_files(home, files)
            return result
        if payload["action"] == "resolve-key":
            record = choose_record(provider_records(raw), real_id(payload.get("id")), payload.get("source"))
            key = record_key(record, raw) if record else ""
            check_files(home, files)
            return {"ok": True, "api_key": key or None}
        document, secrets = build_real_patch(raw, rt, payload, disk_env(files[1]))
        roundtrip_yaml().dump(document, io.StringIO())
        minimal = minimal_temperature_bytes(raw, rt, document, files[0])
        json.dumps(payload.get("fallback_providers", []), allow_nan=False)  # validate explicit list only
        if secrets and Path(config.get_env_path()) != home / ".env":
            raise ConfigurationError("official env writer is not scoped to the requested home")
        plans = plan_env_writes(home, files[1], secrets)
        committed, phase, config_uncertain, env_uncertain = [], "validate", False, False
        expected = files
        try:
            check_files(home, expected)
            for key, value, after in plans:
                phase = ".env"
                check_files(home, expected)
                env_uncertain = True
                if value:
                    config.save_env_value(key, value)
                else:
                    config.remove_env_value(key)
                env_uncertain = False
                if after != expected[1] and ".env" not in committed:
                    committed.append(".env")
                expected = (expected[0], after)
                check_files(home, expected)
            if document != raw:
                phase = "config.yaml"
                check_files(home, expected)
                config_uncertain = True
                if minimal is None:
                    config.atomic_config_replace(home / "config.yaml", document)
                else:
                    from utils import _atomic_write, _preserve_file_mode
                    path = home / "config.yaml"
                    config.require_readable_config_before_write(path)
                    check_files(home, expected)
                    _atomic_write(path, lambda stream: stream.write(minimal), prefix=".config_",
                                  binary=True, mode=_preserve_file_mode(path))
                config_uncertain = False
                committed.append("config.yaml")
            phase = "readback"
            after_files = real_files(home)
            if after_files[1] != expected[1]:
                raise ConfigurationError(".env changed during commit; reload before retrying", 409)
            saved, _ = real_document(home, after_files)
            if saved != document:
                raise ConfigurationError("config changed during commit; reload before retrying", 409)
            return {"ok": True, "revision": files_revision(after_files), "committed": committed,
                    "configWriteUncertain": False, "envWriteUncertain": False}
        except Exception as exc:
            status = exc.details["status"] if isinstance(exc, ConfigurationError) else 500
            raise ConfigurationError("model configuration patch failed; reload files before retrying", status,
                                     phase=phase, committed=committed, configWriteUncertain=config_uncertain,
                                     envWriteUncertain=env_uncertain) from exc


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True)
    args = parser.parse_args()
    try:
        home = Path(args.home)
        if not home.is_absolute() or not home.is_dir():
            raise ValueError("--home must be an existing absolute directory")
        result = run(json.load(sys.stdin), home)
    except Exception as exc:
        # HTTP 错误中不回显 YAML 片段或 API key。
        if isinstance(exc, (ValueError, TypeError)):
            message = str(exc)
        else:
            message = f"{type(exc).__name__}: config read/prepare/write failed"
        details = getattr(exc, "details", {"status": 400 if isinstance(exc, (ValueError, TypeError)) else 500,
                                          "committed": [], "configWriteUncertain": False, "envWriteUncertain": False})
        if not isinstance(exc, ConfigurationError):
            message = f"{type(exc).__name__}: config read/prepare/write failed"
        print(json.dumps({"ok": False, "error": message, **details}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
