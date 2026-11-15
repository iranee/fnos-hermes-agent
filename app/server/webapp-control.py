import argparse
import contextlib
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit


class ControlError(RuntimeError):
    def __init__(self, message, status=503):
        super().__init__(message)
        self.status = status


LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}


def query(home, verb):
    from hermes_cli.gateway_client import private_control_query

    request = json.dumps({"protocol": 1, "id": 1, "verb": verb, "params": {}}).encode() + b"\n"
    response = json.loads(private_control_query(home, request, timeout=4).split(b"\n", 1)[0])
    if response.get("ok") is not True:
        raise ControlError("Gateway refused WebApp control; check the installed core and gateway log")
    return response["result"]


def assert_idle(home):
    from gateway.status import get_running_pid

    if not get_running_pid(cleanup_stale=False):
        return
    work = query(home, "active-work")
    if not isinstance(work, dict) or not isinstance(work.get("active_work"), list):
        raise ControlError("Cannot verify whether the gateway is busy; no service was stopped")
    if work["active_work"] or work.get("active_agents", 0):
        raise ControlError("Gateway has active tasks; wait for them to finish before changing WebApp settings", 409)


def source_kernel_root():
    # Presence, not truthiness: a partial/empty source selection must not use package assets.
    if not any(name in os.environ for name in ("FNOS_KERNEL_ID", "FNOS_KERNEL_ROOT")):
        return None
    from hermes_cli.config import get_project_root

    try:
        kernel_id = os.environ.get("FNOS_KERNEL_ID", "")
        if not re.fullmatch(r"[a-f0-9]{32}", kernel_id):
            raise ValueError("FNOS_KERNEL_ID must be 32 lowercase hex characters")
        data = Path(os.environ.get("DATA_DIR", ""))
        selected = Path(os.environ.get("FNOS_KERNEL_ROOT", ""))
        if not data.is_absolute() or data == Path(data.anchor) or not selected.is_absolute():
            raise ValueError("DATA_DIR and FNOS_KERNEL_ROOT must be explicit absolute directories")
        expected = data / "kernels" / kernel_id / "src"
        for directory in (data, expected.parent.parent, expected.parent, expected):
            if directory.is_symlink() or not directory.is_dir():
                raise ValueError(f"Not a real source kernel directory: {directory}")
        # DATA's ancestors may be host mount aliases; nothing below DATA may redirect.
        real_root = data.resolve(strict=True) / "kernels" / kernel_id / "src"
        if expected.resolve(strict=True) != real_root:
            raise ValueError("Source kernel escapes DATA_DIR")
        for root in (selected, Path(get_project_root())):
            if (root not in (expected, real_root) or root.is_symlink() or not root.is_dir()
                    or root.resolve(strict=True) != real_root):
                raise ValueError("Project root and FNOS_KERNEL_ROOT must match DATA_DIR/kernels/FNOS_KERNEL_ID/src")
        return real_root
    except (OSError, ValueError, RuntimeError) as exc:
        raise ControlError(f"Invalid source kernel selection; refusing package fallback ({exc})") from exc


def source_assets_ready(root, product, dist):
    # The upstream hash walker follows links; do not let a product directory redirect it.
    directory = root
    for part in dist.relative_to(root).parts:
        directory /= part
        if directory.is_symlink():
            raise ControlError(f"Source {product} assets must use real directories: {directory}")
        if not directory.is_dir():
            return False
    if not (dist / "index.html").is_file() or os.path.lexists(dist / ".hermes-stale"):
        return False
    for entry in dist.rglob("*"):
        if entry.is_symlink():
            raise ControlError(f"Source {product} assets must not redirect outside their build: {entry}")
    from hermes_cli.source_build import source_product_current

    return source_product_current(root, product, dist)


def assets_ready():
    root = source_kernel_root()
    if root is not None:
        return source_assets_ready(root, "webapp", root / "apps" / "desktop" / "dist-webapp")
    from hermes_cli.config import get_project_root
    from hermes_cli.webapp import webapp_dist_dir, webapp_bundle_stale

    dist = webapp_dist_dir(get_project_root())
    return (dist / "index.html").is_file() and not webapp_bundle_stale(dist)


def webapp_version(ready):
    # Resolve selection outside the metadata error handler: invalid source
    # selections must remain fatal, never fall back to an older packaged build.
    root = source_kernel_root()
    source = root is not None
    if not source:
        from hermes_cli.config import get_project_root
        from hermes_cli.webapp import webapp_dist_dir

        root = get_project_root()
        dist = webapp_dist_dir(root)
    else:
        dist = root / "apps" / "desktop" / "dist-webapp"
    if not ready:
        return None
    try:
        path = dist / "hermes-build.json"
        if dist.is_symlink() or path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
            return None
        raw = path.read_bytes()
        receipt = json.loads(raw)
        if not isinstance(receipt, dict) or type(receipt.get("schema")) is not int or receipt["schema"] != 1:
            return None
        if receipt.get("product") != "webapp":
            return None
        # Official schema-1 receipts may omit version. Only an explicit product
        # semver is usable; build identity comes from the verified outputHash,
        # never node, sourceHash, the package tag or the gateway's core version.
        version = receipt.get("version")
        if "version" in receipt and (not isinstance(version, str) or len(version) > 128 or not re.fullmatch(
                r"v?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
                r"(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?"
                r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?", version)):
            return None
        inputs = receipt.get("inputs")
        if (not isinstance(inputs, dict) or not isinstance(inputs.get("prepared"), list)
                or not isinstance(inputs.get("env"), list)
                or not all(isinstance(receipt.get(key), str) and receipt[key] for key in ("platform", "arch", "node"))
                or not all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)
                           for value in (inputs.get("sourceHash"), receipt.get("outputHash")))):
            return None
        if not source:
            # Package readiness historically only checks index/stale markers.
            # Version attribution additionally needs the package's exact renderer
            # inventory and the original compiler receipt, not its core tag.
            package = json.loads((root / ".fnos-runtime.json").read_text(encoding="utf-8"))
            renderer = package["renderer"]
            files = renderer["files"]
            if (not isinstance(files, dict) or "index.html" not in files
                    or files.get("hermes-build.json") != hashlib.sha256(raw).hexdigest()
                    or renderer.get("official_receipt_sha256") != files["hermes-build.json"]):
                return None
            entries = list(dist.rglob("*"))
            if any(entry.is_symlink() for entry in entries):
                return None
            if {entry.relative_to(dist).as_posix() for entry in entries if entry.is_file()} != set(files):
                return None
            for name, expected in files.items():
                entry = dist / name
                if not entry.resolve().is_relative_to(dist.resolve()):
                    return None
                with entry.open("rb") as stream:
                    if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                        return None
        return {"version": version, "build": receipt["outputHash"][:12]}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def dashboard_assets_ready():
    root = source_kernel_root()
    if root is not None:
        return source_assets_ready(root, "web", root / "hermes_cli" / "web_dist")
    from hermes_cli.config import get_project_root

    root = get_project_root()
    dist = root / "hermes_cli" / "web_dist"
    try:
        receipt = json.loads((root / ".fnos-runtime.json").read_text(encoding="utf-8"))
        files = receipt["dashboard"]["files"]
        if "index.html" not in files or "hermes-build.json" not in files:
            return False
        if {p.relative_to(dist).as_posix() for p in dist.rglob("*") if p.is_file()} != set(files):
            return False
        for name, expected in files.items():
            path = dist / name
            if not path.resolve().is_relative_to(dist.resolve()) or path.is_symlink():
                return False
            with path.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
                    return False
        return True
    except (OSError, ValueError, KeyError, TypeError):
        return False


def gate_engaging_url(value):
    if not isinstance(value, str) or not value.strip():
        return ""
    host = (urlsplit(value.strip()).hostname or "").lower()
    return value.strip() if host and host not in LOOPBACK_HOSTS else ""


def environment_public_url(name):
    if gate_engaging_url(os.environ.get(name, "")):
        raise ControlError(f"{name} in the environment forces a separate sign-in; remove it from .env and restart", 409)


def drop_public_urls(config):
    changed = False
    for section in ("webapp", "dashboard"):
        value = config.get(section)
        if isinstance(value, dict) and "public_url" in value:
            value.pop("public_url")
            changed = True
    return changed


def runtime_version():
    import hermes_cli
    from hermes_cli.version_info import get_version_info

    source = source_kernel_root()
    expected = (Path(os.environ["FNOS_KERNEL_ROOT"]) if source is not None
                else Path(os.environ["APP_DIR"]) / "hermes-src")
    if Path(hermes_cli.__file__).resolve().parent.parent != expected.resolve(strict=True):
        raise ControlError("Version module does not belong to the selected Hermes runtime")
    info = get_version_info()
    if info.source == "git" and not (expected / ".git").exists():
        raise ControlError("Version identity refers to a different checkout")
    return {"version": info.display_version, "releaseDate": getattr(hermes_cli, "__release_date__", None),
            "commit": info.commit, "root": str(expected)}


def default_config_snapshot(home):
    from hermes_cli import managed_scope
    from hermes_cli.config import (FailedConfigRead, get_config_path, load_config_readonly,
                                   require_readable_config_before_write)

    path = home / "config.yaml"
    if Path(get_config_path()).resolve() != path.resolve():
        raise ControlError("Effective configuration does not belong to this Gateway home", 409)

    def read_bytes(source):
        try:
            return source.read_bytes()
        except FileNotFoundError:
            if source.is_symlink():
                raise ControlError("Configuration source is a dangling symlink; file preserved", 409)
            return None

    raw = read_bytes(path)
    config = require_readable_config_before_write(path)
    directory = managed_scope.get_managed_dir()
    if directory is None:
        # The official resolver uses is_dir(), which can hide access errors.
        # Probe its selected source strictly; only genuine absence is a default.
        override = os.environ.get("HERMES_MANAGED_DIR", "").strip()
        candidate = (Path(override) if override else
                     None if managed_scope._under_pytest() else managed_scope._DEFAULT_MANAGED_DIR)
        if candidate is not None:
            try:
                candidate.stat()
            except FileNotFoundError:
                if candidate.is_symlink():
                    raise ControlError("Managed scope is a dangling symlink", 409)
            else:
                raise ControlError("Managed scope cannot be resolved as a directory", 409)
    managed_raw = read_bytes(directory / "config.yaml") if directory is not None else None
    # Use the pinned core's parser, not its fail-open loader as proof of absence.
    managed = managed_scope.fast_safe_load(managed_raw.decode("utf-8-sig")) if managed_raw is not None else {}
    if managed is None:
        managed = {}
    if not isinstance(managed, dict):
        raise ControlError("Managed configuration must be a mapping; file preserved", 409)
    if managed_scope.load_managed_config() != managed:
        raise ControlError("Managed configuration could not be verified; file preserved", 409)
    effective = load_config_readonly()
    if isinstance(effective, FailedConfigRead):
        raise ControlError("Effective configuration could not be read; file preserved", 409)
    # Never modify the official read-only cache or materialize its defaults/overlay.
    documents = copy.deepcopy((config, managed, effective))
    for document in documents:
        if not isinstance(document, dict) or not isinstance(document.get("webapp", {}), dict):
            raise ControlError("WebApp configuration must be a mapping; file preserved", 409)
        block = document.get("webapp", {})
        if "enabled" in block and type(block["enabled"]) is not bool:
            raise ControlError("webapp.enabled must be boolean; file preserved", 409)
    return documents, (raw, directory, managed_raw)


def configure_default(home):
    from gateway.status import get_running_pid
    from hermes_cli.config import atomic_config_replace

    def require_stopped():
        if get_running_pid(cleanup_stale=False):
            raise ControlError("Gateway is already running; default settings were not changed", 409)

    require_stopped()
    snapshot = default_config_snapshot(home)
    documents, _ = snapshot
    config, managed, effective = documents
    blocks = [document.get("webapp", {}) for document in documents]
    if any("enabled" in block for block in blocks):
        return {"changed": False}
    address = effective.get("webapp", {})
    if (address.get("host", "127.0.0.1") != "127.0.0.1"
            or type(address.get("port", 9120)) is not int or address.get("port", 9120) != 9120
            or any("public_url" in block for block in blocks)
            or os.environ.get("HERMES_WEBAPP_PUBLIC_URL")):
        raise ControlError("Default WebApp requires 127.0.0.1:9120 without a public URL; existing settings preserved", 409)
    assert_idle(home)
    # Best-effort stale-snapshot detection, not a cross-process transaction lock.
    if default_config_snapshot(home) != snapshot:
        raise ControlError("Configuration changed before default WebApp setup; retry after edits finish", 409)
    require_stopped()
    updated = dict(config.get("webapp", {}))
    updated["enabled"] = True
    for key, value in (("host", "127.0.0.1"), ("port", 9120)):
        if key not in address:
            updated.setdefault(key, value)
    config["webapp"] = updated
    atomic_config_replace(home / "config.yaml", config)
    return {"changed": True}


def execute(home, action, payload):
    if action == "version":
        return runtime_version()
    # 配置写回：public_url 是有意删除的，atomic_config_write 会把“省略键”当成误删而拒绝写入
    from hermes_cli.config import require_readable_config_before_write, atomic_config_replace
    from gateway.webapp_listener import webapp_settings
    from gateway.status import get_running_pid

    if action == "dashboard-settings":
        from hermes_cli.dashboard_auth.prefix import resolve_public_url

        url = resolve_public_url() or ""
        error = ""
        if gate_engaging_url(url):
            error = "A Dashboard public URL is configured and would force a separate sign-in; start Dashboard again to reset it"
        ready = dashboard_assets_ready()
        if not ready and source_kernel_root() is not None:
            error = error or "Official source Dashboard assets are missing, stale or unverifiable; complete the official source build with PM-managed Node"
        metadata = {}
        if ready:
            try:
                identity = runtime_version()
                metadata["runtime_version"] = {key: identity[key] for key in ("version", "releaseDate", "commit")}
            except (ImportError, OSError, KeyError, ControlError):
                pass
        return {"host": "127.0.0.1", "port": 9119, "public_url": url, "error": error,
                "assets_ready": ready, **metadata}
    if action == "dashboard-prepare":
        if not dashboard_assets_ready():
            if source_kernel_root() is not None:
                raise ControlError("Official source Dashboard assets are missing, stale or unverifiable; complete the official source build with PM-managed Node")
            raise ControlError("Official Dashboard assets are missing or changed; install the complete application package")
        environment_public_url("HERMES_DASHBOARD_PUBLIC_URL")
        path = home / "config.yaml"
        config = require_readable_config_before_write(path)
        changed = drop_public_urls(config)
        if changed:
            atomic_config_replace(path, config)
        return {"ready": True, "changed": changed}
    if action == "check":
        if not assets_ready():
            if source_kernel_root() is not None:
                raise ControlError("Official source WebApp assets are missing, stale or unverifiable; complete the official source build with PM-managed Node")
            raise ControlError("Official WebApp assets are missing or stale; install a matching application package")
        return {"ready": True}
    if action == "idle":
        assert_idle(home)
        return {"idle": True}
    if action == "configure-default":
        if payload:
            raise ValueError("configure-default takes no parameters")
        return configure_default(home)
    if action == "configure":
        enabled = payload.get("enabled")
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be boolean")
        path = home / "config.yaml"
        config = require_readable_config_before_write(path)
        previous = config.get("webapp", {})
        if not isinstance(previous, dict):
            raise ValueError("webapp configuration must be a mapping")
        updated = dict(previous)
        updated["enabled"] = enabled
        if enabled:
            updated.pop("public_url", None)
            port = payload.get("port", 9120)
            if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
                raise ValueError("Invalid WebApp port")
            updated.update(host="127.0.0.1", port=port)
        dashboard = config.get("dashboard")
        dashboard_changed = enabled and isinstance(dashboard, dict) and "public_url" in dashboard
        changed = previous != updated or dashboard_changed
        if changed:
            # Check before writing, including enabled:false and false -> true.
            # Disabling only changes webapp.enabled; unrelated settings survive.
            assert_idle(home)
            config["webapp"] = updated
            if dashboard_changed:
                dashboard.pop("public_url")
            atomic_config_replace(path, config)
        return {"changed": changed}
    if action == "settings":
        try:
            config = require_readable_config_before_write(home / "config.yaml")
            if not isinstance(config.get("webapp", {}), dict):
                raise ValueError("webapp configuration must be a mapping")
        except Exception as exc:
            print(str(exc), file=sys.stderr)
            raise ControlError("Existing config.yaml is unreadable or invalid; file preserved", 409) from exc
        settings = webapp_settings(home)
        error = settings.reason or ""
        if gate_engaging_url(settings.public_url or ""):
            error = error or "A WebApp public URL is configured and would force a separate sign-in; restart Gateway to reset it"
        ready = assets_ready()
        if not ready and source_kernel_root() is not None:
            error = error or "Official source WebApp assets are missing, stale or unverifiable; complete the official source build with PM-managed Node"
        metadata = webapp_version(ready) or {"version": None, "build": None}
        if metadata["build"]:
            try:
                identity = runtime_version()
                metadata["runtime_version"] = {key: identity[key] for key in ("version", "releaseDate", "commit")}
            except (ImportError, OSError, KeyError, ControlError):
                pass
        return {"enabled": settings.enabled, "host": settings.host, "port": settings.port,
                "public_url": settings.public_url or "", "error": error, "assets_ready": ready,
                **metadata}
    if action == "status":
        # PID discovery and control readiness are independent. Never clean stale
        # files on a status/idle read, or mistake a diagnostic PID for a reply.
        pid = None
        phase = "pid-discovery"
        try:
            pid = get_running_pid(cleanup_stale=False)
            if not pid:
                return {"state": "off", "pid": None, "control_ready": False}
            phase = "control-connect"
            result = query(home, "webapp-status")
            return {**result, "pid": pid, "control_ready": True}
        except (FileNotFoundError, ConnectionRefusedError) as exc:
            return {"state": "starting", "pid": pid, "control_ready": False,
                    "phase": phase, "reason": type(exc).__name__}
    if action == "launch":
        return query(home, "webapp-launch")
    raise ValueError("Unknown action")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True)
    parser.add_argument("action", choices=["version", "check", "configure", "configure-default", "idle", "settings", "status", "launch",
                                            "dashboard-prepare", "dashboard-settings"])
    args = parser.parse_args()
    home = Path(args.home).resolve()
    os.environ["HERMES_HOME"] = str(home)
    try:
        from dotenv import load_dotenv
        load_dotenv(home / ".env", override=False)
        payload = json.load(sys.stdin) if args.action == "configure" else {}
        if not isinstance(payload, dict):
            raise ValueError("JSON body must be an object")
        with contextlib.redirect_stdout(sys.stderr):
            result = execute(home, args.action, payload)
        print(json.dumps({"ok": True, "result": result}))
    except (ControlError, ValueError) as exc:
        print(json.dumps({"ok": False, "error": str(exc), "status": getattr(exc, "status", 400)}))
        return 1
    except Exception as exc:
        import traceback
        traceback.print_exc(file=sys.stderr)
        detail = " ".join(str(exc).split())[:400]
        message = type(exc).__name__ + (": " + detail if detail else "")
        print(json.dumps({"ok": False, "error": "WebApp control unavailable (" + message + ")", "status": 503}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
