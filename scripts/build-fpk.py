#!/usr/bin/env python3
"""离线、带回执的 fnOS 打包（仅标准库，Python >=3.11）。

只运行显式指定的 fnpack 可执行文件；--stage-only 不会运行它。
可选的 HTTPS 运行时输入用于手动 CI，其 SHA256 必须单独提供。
回执只是完整性证据，不是签名，也不能替代信任。
Windows 版 fnpack 1.2.3 会丢失 Unix 权限位；这里归一化归档头并更新 FPK 载荷 MD5，
然后重新校验字节内容和可执行位。
不执行前端（渲染器）构建代码，也不改写任何官方构建记录（回执）。
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
MARKER = ".fnos-output.json"
BUILD_OWNER = "fnos-hermes-build-v1"
MAX_ARCHIVE = 2 * 1024**3
MAX_UNPACKED = 8 * 1024**3
MAX_MEMBERS = 150000
PRODUCTION = ("manifest", "ICON.PNG", "ICON_256.PNG", "LICENSE", "cmd", "wizard",
              "config/privilege", "config/resource", "config/bootstrap", "config/prompts",
              "app/bin", "app/ui", "app/server")
MAINTENANCE = ("scripts/prepare-runtime.py", "scripts/build-fpk.py",
               "scripts/export-project.py", "scripts/update-hermes.py")
CACHE = {".git", ".hermes", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache",
         ".ruff_cache", ".cache", "cache", ".venv", "venv", "dist", "delivery"}


def load_script(name: str):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prepare = load_script("prepare-runtime")
Error = prepare.PrepareError


def no_link_entry(path: Path) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise Error(f"Link/reparse point is not allowed: {path}")


def no_links(path: Path) -> None:
    for part in (path, *path.parents):
        no_link_entry(part)


def absolute(path: Path) -> Path:
    path = path.absolute()
    no_links(path)
    return path.resolve()


def disk(path: Path) -> Path:
    return prepare.long_path(path)


def safe_name(name: str) -> PurePosixPath:
    path = prepare.safe_name(name)
    for part in path.parts:
        if (part.endswith((".", " ")) or any(c in part for c in '<>"|?*')
                or re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])", part.split(".")[0])):
            raise Error(f"Non-portable archive path: {name!r}")
    return path


def walk_files(root: Path):
    root = disk(root)
    no_links(root)
    for current, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        for name in dirs + files:
            path = Path(current) / name
            # 自顶向下遍历时父目录已全部检查过。避免对约 2.4 万个官方运行时文件各做 O(depth) 次文件系统调用。
            no_link_entry(path)
            safe_name(path.relative_to(root).as_posix())
        for name in sorted(files):
            path = Path(current) / name
            if not stat.S_ISREG(path.stat().st_mode):
                raise Error(f"Not a regular file: {path}")
            yield path.relative_to(root).as_posix(), path


def file_sha(path: Path) -> str:
    # 调用方必须已经检查过父目录（如 walk_files 或 copy_file）。
    no_link_entry(disk(path))
    if not stat.S_ISREG(disk(path).stat().st_mode):
        raise Error(f"Not a regular file: {path}")
    with disk(path).open("rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise Error(f"Not a regular file: {path}")
        return hashlib.file_digest(stream, "sha256").hexdigest()


def sha(path: Path) -> str:
    no_links(path)
    return file_sha(path)


def inventory(root: Path) -> dict[str, str]:
    return {name: file_sha(path) for name, path in walk_files(root)}


def json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Error(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def read_json(path: Path):
    no_links(path)
    if not disk(path).is_file():
        raise Error(f"Missing regular JSON file: {path}")
    return json.loads(disk(path).read_text(encoding="utf-8"), object_pairs_hook=json_object)


def write_json(path: Path, value) -> None:
    disk(path).write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
                          encoding="utf-8", newline="\n")


def assignments(text: str) -> dict[str, str]:
    result = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise Error("Invalid key=value metadata")
        key, value = (s.strip() for s in line.split("=", 1))
        if key in result:
            raise Error(f"Duplicate metadata key: {key}")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        result[key] = value
    return result


def read_assignments(path: Path) -> dict[str, str]:
    no_links(path)
    if not disk(path).is_file():
        raise Error(f"Missing regular metadata file: {path}")
    return assignments(disk(path).read_text(encoding="utf-8"))


def validate_pins(root: Path) -> dict:
    manifest = read_assignments(root / "manifest")
    version = read_assignments(root / "config/bootstrap/app-version.env")
    core = read_assignments(root / "config/bootstrap/hermes-version.env")
    if manifest.get("appname") != "hermes-agent":
        raise Error("Expected manifest appname=hermes-agent")
    app_version = manifest.get("version", "")
    if not re.fullmatch(r"\d+\.\d+\.\d+-\d+", app_version) or version.get("APP_VERSION") != app_version:
        raise Error("manifest and app-version.env must carry the same x.y.z-N version")
    if (core.get("HERMES_VERSION") != prepare.TAG or core.get("HERMES_COMMIT") != prepare.COMMIT
            or prepare.TAG != "v" + app_version.split("-")[0]):
        raise Error("manifest/core pins disagree with prepare-runtime constants")
    return {"version": app_version, "tag": prepare.TAG, "commit": prepare.COMMIT}


def validate_hashes(files) -> None:
    if not isinstance(files, dict) or not files:
        raise Error("Missing receipt file inventory")
    seen = set()
    for name, digest in files.items():
        safe_name(name)
        if name.casefold() in seen or not isinstance(digest, str) or not re.fullmatch("[0-9a-f]{64}", digest):
            raise Error(f"Invalid or case-colliding receipt entry: {name}")
        seen.add(name.casefold())


def verify_runtime(root: Path) -> dict:
    root = absolute(root)
    receipt = read_json(root / prepare.RECEIPT)
    if not isinstance(receipt, dict):
        raise Error("Runtime receipt must be a JSON object")
    if (receipt.get("schema") != 1 or receipt.get("owner") != prepare.OWNER
            or receipt.get("commit") != prepare.COMMIT or receipt.get("tag") != prepare.TAG):
        raise Error("Unsupported runtime receipt owner/schema/core pin")
    files = receipt["files"]
    validate_hashes(files)
    actual = inventory(root)
    actual.pop(prepare.RECEIPT, None)
    if actual != files:
        raise Error("Runtime full file inventory/hash mismatch (missing, extra or changed file)")
    if receipt["runtime"] != prepare.runtime_metadata(disk(root)):
        raise Error("Runtime metadata/lock mismatch")
    for section, product, dist in (("renderer", "webapp", prepare.DIST),
                                   ("dashboard", "web", prepare.DASHBOARD_DIST)):
        if not isinstance(receipt.get(section), dict):
            raise Error(f"Missing {section} preparation receipt; complete packages require both frontends")
        verify_frontend(root, actual, receipt[section], section, product, dist)
    for name in ("LICENSE", "pyproject.toml", "uv.lock", ".python-version"):
        if name not in files:
            raise Error(f"Missing required runtime file: {name}")
    return receipt


def verify_frontend(root: Path, actual: dict, saved: dict, section: str, product: str, dist: Path) -> None:
    prefix = dist.as_posix() + "/"
    files = {k[len(prefix):]: v for k, v in actual.items() if k.startswith(prefix)}
    validate_hashes(saved["files"])
    if saved["files"] != files or ".hermes-stale" in files:
        raise Error(f"{section} inventory mismatch or stale marker")
    official = read_json(root / dist / "hermes-build.json")
    report = saved["verification"]
    inputs = official["inputs"]
    builder = {key: official[key] for key in ("platform", "arch", "node")}
    source_hash = report["sourceHash"]
    if (not re.fullmatch("[0-9a-f]{64}", source_hash)
            or report["outputIntact"] is not True or report["productCurrent"] is not True
            or report["receiptSourceHash"] != source_hash or inputs["sourceHash"] != source_hash
            or report["builder"] != builder or report["host"] != builder
            or official["schema"] != 1 or official["product"] != product
            or not re.fullmatch("[0-9a-f]{64}", official["outputHash"])
            or saved["official_receipt_sha256"] != files.get("hermes-build.json")
            or "index.html" not in files):
        raise Error(f"Official {section} receipt disagrees with saved preparation verification")
    if product == "webapp":
        if inputs["prepared"] != [] or inputs["env"] != [["NODE_ENV", "production"]]:
            raise Error("Unsupported official renderer inputs")
    else:
        # 离线传输只校验保存下来的证据，不校验接收机器的 Node 或本地路径，
        # 官方的新鲜度检查只由 prepare-runtime 执行。
        prepared = inputs.get("prepared")
        if (set(inputs) != {"sourceHash", "prepared"} or not isinstance(prepared, list)
                or len(prepared) != 1 or not isinstance(prepared[0], dict)
                or set(prepared[0]) != {"name", "path", "hash"}
                or prepared[0]["name"] != "icons" or prepared != report.get("prepared")
                or not isinstance(prepared[0]["path"], str)
                or not isinstance(prepared[0]["hash"], str)
                or not re.fullmatch("[0-9a-f]{64}", prepared[0]["hash"])):
            raise Error("Official dashboard prepared icon hash/path disagrees with verification")
        path_type = PureWindowsPath if builder["platform"] == "win32" else PurePosixPath
        if not path_type(prepared[0]["path"]).is_absolute():
            raise Error("Dashboard prepared icons must record an absolute builder path")
        if not any(n.startswith("assets/") and n.endswith(".js") for n in files):
            raise Error("Missing Dashboard JavaScript assets")


def project_test(name: str) -> bool:
    parts = PurePosixPath(name).parts
    leaf = parts[-1].lower()
    return (any(p.lower() in {"test", "tests", "__tests__", "fixtures", "test-fixtures"} for p in parts)
            or any(parts[i] == "scripts" and parts[i + 1].lower().startswith("test")
                   for i in range(len(parts) - 1))
            or leaf.startswith(("test_", "test-")) or ".test." in leaf or ".spec." in leaf)


def excluded_project(name: str) -> bool:
    parts = PurePosixPath(name).parts
    return (any(p.lower() in CACHE for p in parts)
            or any(p == ".env" or p.startswith(".env.") for p in parts)
            or parts[-1].lower().endswith((".pyc", ".pyo", ".fpk", ".log", ".tmp"))
            or name == "app/hermes-web-dist" or name.startswith("app/hermes-web-dist/")
            or name == "app/server/vendor/agent-bridge" or name.startswith("app/server/vendor/agent-bridge/"))


def selected_files(root: Path, selections):
    for selection in selections:
        source = root / selection
        no_links(source)
        if not source.exists():
            raise Error(f"Missing production input: {selection}")
        entries = walk_files(source) if source.is_dir() else [("", source)]
        for relative, path in entries:
            name = selection + ("/" + relative if relative else "")
            # 这是 vendor 包白名单，不是整个 vendor 目录。
            if name.startswith("app/server/vendor/") and name.split("/")[3] not in {"ws", "whatsapp-bridge"}:
                continue
            if not excluded_project(name) and not project_test(name):
                yield name, path


def executable(name: str, path: Path) -> bool:
    parts = PurePosixPath(name).parts
    if (parts[0] == "cmd" or name.startswith(("app/bin/", "bin/"))
            or "/trim-cli/bin/" in name or PurePosixPath(name).suffix in {".sh", ".bash"}):
        return True
    with disk(path).open("rb") as stream:
        return stream.read(2) == b"#!"


def copy_file(source: Path, target: Path, name: str) -> None:
    no_links(source)
    target = disk(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    before = file_sha(source)
    shutil.copyfile(disk(source), target)
    target.chmod(0o755 if executable(name, source) else 0o644)
    if file_sha(target) != before or file_sha(source) != before:
        raise Error(f"Input changed during copy: {name}")


def make_stage(root: Path, runtime: Path, stage: Path) -> dict:
    pins = validate_pins(root)
    receipt = verify_runtime(runtime)
    stage.mkdir()
    for name, path in selected_files(root, PRODUCTION):
        dest = "app/" + name if name == "LICENSE" or name.startswith(("config/bootstrap/", "config/prompts/")) else name
        copy_file(path, stage / dest, dest)
    copy_file(root / "manifest", stage / "app/manifest", "app/manifest")
    for name, path in walk_files(runtime):
        copy_file(path, stage / "app/hermes-src" / name, "app/hermes-src/" + name)
    if verify_runtime(stage / "app/hermes-src") != receipt:
        raise Error("Runtime changed during staging")
    if validate_pins(root) != pins:
        raise Error("Pins changed during staging")
    validate_stage(stage)
    return pins


def validate_stage(stage: Path) -> None:
    validate_pins(stage / "app")
    files = inventory(stage)
    for name in files:
        if name.startswith("app/hermes-src/"):
            continue  # 官方源码（含其测试）必须逐字节保持原样。
        if excluded_project(name) or project_test(name):
            raise Error(f"Forbidden project payload: {name}")
        if name.startswith("config/") and name not in {"config/privilege", "config/resource"}:
            raise Error("FPK top-level config may contain only privilege/resource")
    if "LICENSE" in files:
        raise Error("Installer LICENSE must be packaged inside app/LICENSE only")
    required = {"manifest", "app/manifest", "app/LICENSE", "cmd/main",
                "app/server/boot.js", "app/server/monitor.js", "app/server/package.json",
                "app/bin/hermes", "app/bin/monitor-api", "app/ui/index.html", "app/ui/config",
                "config/privilege", "config/resource", "app/config/prompts/AGENTS.md",
                "app/config/prompts/SOUL.md", "app/config/bootstrap/install-runtime.sh",
                "app/config/bootstrap/app-version.env", "app/config/bootstrap/hermes-version.env",
                "app/hermes-src/LICENSE", "app/hermes-src/" + prepare.RECEIPT,
                "app/hermes-src/apps/desktop/dist-webapp/index.html",
                "app/hermes-src/hermes_cli/web_dist/index.html"}
    if not required.issubset(files):
        raise Error("Stage missing required files: " + ", ".join(sorted(required - files.keys())))
    if files["manifest"] != files["app/manifest"]:
        raise Error("Deployed manifest differs from package manifest")
    boot = (stage / "cmd/main").read_text(encoding="utf-8")
    if not re.search(r'BOOT_SCRIPT=["\']?\$\{?APP_DIR\}?/server/boot\.js', boot):
        raise Error("cmd/main must launch APP_DIR/server/boot.js")
    # 不运行尚未安装的应用，直接捕获缺失或已废弃的 JS 直接导入。
    for name in files:
        if name.startswith("app/server/") and "/vendor/" not in name and name.endswith((".js", ".mjs")):
            text = (stage / name).read_text(encoding="utf-8")
            for relative in re.findall(r'(?:from\s*|import\s*\(?\s*)["\'](\.[^"\']+)["\']', text):
                target = (stage / name).parent / relative
                if not target.is_file() or not target.resolve().is_relative_to(stage.resolve()):
                    raise Error(f"Unpackaged relative import in {name}: {relative}")


def check_output_path(target: Path, root: Path, runtime: Path | None = None) -> Path:
    target = absolute(target)
    root = absolute(root)
    if root.is_relative_to(target):
        raise Error("Output must not contain or replace the project")
    if target.is_relative_to(root):
        first = target.relative_to(root).parts[0]
        if first in {"app", "cmd", "config", "scripts", "wizard", "preview", ".github"}:
            raise Error("Output must not be inside project source inputs")
    if runtime is not None:
        runtime = absolute(runtime)
        if target.is_relative_to(runtime) or runtime.is_relative_to(target):
            raise Error("Output and runtime must not overlap")
    return target


def output_state(root: Path) -> dict:
    files = inventory(root)
    files.pop(MARKER, None)
    dirs = []
    for current, children, _ in os.walk(disk(root)):
        dirs.extend((Path(current) / name).relative_to(disk(root)).as_posix() for name in children)
    return {"files": files, "directories": sorted(dirs)}


def require_owned(target: Path, owner: str, reject_fpk: bool = False) -> None:
    no_links(target)
    if not target.exists():
        return
    if not target.is_dir() or not (target / MARKER).is_file():
        raise Error(f"Refusing unowned output (even an empty directory): {target}")
    saved = read_json(target / MARKER)
    state = output_state(target)
    if saved != {"schema": 1, "owner": owner, **state}:
        raise Error(f"Refusing modified/unowned output: {target}")
    if reject_fpk and any(n.lower().endswith(".fpk") for n in state["files"]):
        raise Error("Refusing to overwrite an existing FPK; choose a new --output-dir")


@contextmanager
def output_transaction(target: Path, owner: str, reject_fpk: bool = False):
    require_owned(target, owner, reject_fpk)
    disk(target.parent).mkdir(parents=True, exist_ok=True)
    lock = target.parent / ("." + target.name + ".publish.lock")
    with lock.open("x", encoding="utf-8") as handle:
        try:
            with tempfile.TemporaryDirectory(prefix=".fnos-stage-", dir=disk(target.parent)) as tmp:
                scratch = Path(tmp)
                generated = scratch / "output"
                generated.mkdir()
                yield generated, scratch
                write_json(generated / MARKER, {"schema": 1, "owner": owner, **output_state(generated)})
                require_owned(target, owner, reject_fpk)
                backup_root = None
                if target.exists():
                    # 旧版本绝不放进会自动清理的目录：即使回滚失败也要保留以便手工恢复。
                    backup_root = Path(tempfile.mkdtemp(prefix=".fnos-previous-", dir=disk(target.parent)))
                    backup = backup_root / target.name
                    try:
                        prepare.rename_held(disk(target), backup)
                    except BaseException:
                        backup_root.rmdir()
                        raise
                try:
                    prepare.rename_held(generated, disk(target))
                except BaseException as error:
                    if backup_root:
                        try:
                            prepare.rename_held(backup, disk(target))
                        except OSError as rollback:
                            raise Error(f"Publication failed; previous output retained at {backup}: {rollback}") from error
                        backup_root.rmdir()
                    raise
                if backup_root:
                    try:
                        shutil.rmtree(backup_root)
                    except OSError:
                        print(f"Warning: previous owned output retained at {backup}", file=sys.stderr)
        finally:
            handle.close()
            lock.unlink()


def isolated_env(home: Path) -> dict[str, str]:
    home.mkdir(parents=True, exist_ok=True)
    env = {key: value for key, value in os.environ.items()
           if key.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMP", "TEMP", "TMPDIR"}}
    env.update({"HOME": str(home), "USERPROFILE": str(home), "APPDATA": str(home / "roaming"),
                "LOCALAPPDATA": str(home / "local"), "XDG_CONFIG_HOME": str(home / "config"),
                "XDG_CACHE_HOME": str(home / "cache"), "HERMES_HOME": str(home / "hermes"),
                "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_TERMINAL_PROMPT": "0", "PYTHONDONTWRITEBYTECODE": "1"})
    return env


def archive_name(member: tarfile.TarInfo) -> str | None:
    name = member.name
    while name.startswith("./"):
        name = name[2:]
    name = name.rstrip("/")
    if name in {"", "."} and member.isdir():
        return None
    safe_name(name)
    if not member.isdir() and not member.isfile():
        raise Error(f"Archive link/special file forbidden: {name}")
    if getattr(member, "sparse", None):
        raise Error(f"Sparse archive member forbidden: {name}")
    return name


def archive_index(archive: tarfile.TarFile) -> dict[str, tarfile.TarInfo]:
    entries = {}
    seen = {}
    total = 0
    for count, member in enumerate(archive, 1):
        if count > MAX_MEMBERS:
            raise Error("Archive has too many members")
        name = archive_name(member)
        if name is None:
            continue
        key = name.casefold()
        if key in seen:
            prior_name, prior = seen[key]
            # fnpack 注入 resource/privilege 时会把 config 目录输出两次。
            if prior_name == name and prior.isdir() and member.isdir():
                continue
            raise Error(f"Duplicate/case-colliding archive path: {name}")
        total += member.size
        if member.size < 0 or total > MAX_UNPACKED:
            raise Error("Archive exceeds uncompressed size limit")
        seen[key] = (name, member)
        entries[name] = member
    for name in entries:
        for parent in PurePosixPath(name).parents:
            if parent.as_posix() in entries and not entries[parent.as_posix()].isdir():
                raise Error(f"Archive file/directory conflict: {name}")
    return entries


def expected_archives(stage: Path):
    outer, payload = {}, {}
    for name, path in walk_files(stage):
        if name.startswith("app/"):
            payload[name[4:]] = path
        else:
            outer[name] = path
            if name.startswith("config/"):
                payload[name] = path  # fnpack 1.2.3 的实际行为。
    return outer, payload


def compare_archive(archive, entries, expected, check_modes=False, exceptions=(), stage_modes=False):
    regular = {name for name, member in entries.items() if member.isfile()}
    if regular != set(expected) | set(exceptions):
        raise Error("Archive file allowlist mismatch: " + repr(sorted(regular ^ (set(expected) | set(exceptions)))[:12]))
    allowed_dirs = {p.as_posix() for name in regular for p in PurePosixPath(name).parents}
    if any(m.isdir() and n not in allowed_dirs for n, m in entries.items()):
        raise Error("Archive contains an unexpected directory")
    # archive_index 保留成员的物理顺序。按该顺序读取可避免在 stage 遍历顺序不同时反复回绕解压 gzip。
    for name, member in entries.items():
        if name not in expected:
            continue  # 例外载荷由 verify_fpk 单独检查。
        path = expected[name]
        with archive.extractfile(member) as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != sha(path):
            raise Error(f"Archive bytes differ from verified stage: {name}")
        if check_modes:
            desired = path.stat().st_mode & 0o7777 if stage_modes else (0o755 if executable(name, path) else 0o644)
            if desired not in (0o644, 0o755) or member.mode & 0o7777 != desired:
                raise Error(f"Archive Unix mode mismatch: {name}")
    if check_modes and any(m.isdir() and m.mode & 0o7777 != 0o755 for m in entries.values()):
        raise Error("Archive directory Unix mode mismatch")


def verify_fpk(fpk: Path, stage: Path, scratch: Path, check_modes: bool = True, stage_modes: bool = False) -> dict:
    outer_expected, payload_expected = expected_archives(stage)
    original_manifest = read_assignments(stage / "manifest")
    outer_expected.pop("manifest")
    with tarfile.open(disk(fpk), "r:*") as archive:
        entries = archive_index(archive)
        compare_archive(archive, entries, outer_expected, check_modes, ("manifest", "app.tgz"), stage_modes=stage_modes)
        manifest_member = entries["manifest"]
        if manifest_member.size > 1024 * 1024:
            raise Error("Oversized FPK manifest")
        manifest = assignments(archive.extractfile(manifest_member).read().decode("utf-8"))
        for key, value in original_manifest.items():
            if key != "checksum" and manifest.get(key) != value:
                raise Error(f"fnpack changed manifest field: {key}")
        if set(manifest) - set(original_manifest) - {"checksum", "desktop_uidir", "desktop_applaunchname"}:
            raise Error("fnpack added unsupported manifest fields")
        if check_modes and any(entries[n].mode & 0o7777 != 0o644 for n in ("manifest", "app.tgz")):
            raise Error("FPK metadata Unix mode mismatch")
        payload = scratch / "verify-app.tgz"
        with archive.extractfile(entries["app.tgz"]) as src, payload.open("wb") as out:
            shutil.copyfileobj(src, out)
        with payload.open("rb") as stream:
            checksum = hashlib.file_digest(stream, "md5").hexdigest()
        if manifest.get("checksum") != checksum:
            raise Error("FPK manifest payload checksum mismatch")
        with tarfile.open(payload, "r:*") as inner:
            compare_archive(inner, archive_index(inner), payload_expected, check_modes, stage_modes=stage_modes)
    return {"payload_files": len(payload_expected), "payload_md5": checksum,
            "unix_modes_verified": check_modes, "runtime_bytes_verified": True}


def write_tar_entry(out, member, stream=None, mode=0o644):
    member = copy.copy(member)
    member.mode = mode
    member.uid = member.gid = 0
    member.uname = member.gname = "root"
    member.pax_headers = {}  # 让 tarfile 重新生成长文件名，而不是沿用过期的头覆盖。
    out.addfile(member, stream)


def normalize_fpk(raw: Path, target: Path, stage: Path, scratch: Path) -> dict:
    verify_fpk(raw, stage, scratch, check_modes=False)
    outer_expected, payload_expected = expected_archives(stage)
    payload = scratch / "normalized-app.tgz"
    with tarfile.open(scratch / "verify-app.tgz", "r:*") as inner, tarfile.open(payload, "w:gz") as out:
        for name, member in archive_index(inner).items():
            stream = inner.extractfile(member) if member.isfile() else None
            try:
                mode = 0o755 if member.isdir() or executable(name, payload_expected[name]) else 0o644
                write_tar_entry(out, member, stream, mode)
            finally:
                if stream:
                    stream.close()
    with payload.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "md5").hexdigest()
    with tarfile.open(disk(raw), "r:*") as archive, tarfile.open(disk(target), "w:gz") as out:
        for name, member in archive_index(archive).items():
            mode = 0o644
            if name == "app.tgz":
                member = copy.copy(member)
                member.size = payload.stat().st_size
                with payload.open("rb") as stream:
                    write_tar_entry(out, member, stream)
            elif name == "manifest":
                text = archive.extractfile(member).read().decode("utf-8")
                text, count = re.subn(r"(?m)^checksum\s*=.*$", f"checksum              = {checksum}", text)
                if count != 1:
                    raise Error("Expected exactly one fnpack manifest checksum")
                data = text.encode("utf-8")
                member = copy.copy(member)
                member.size = len(data)
                write_tar_entry(out, member, io.BytesIO(data))
            else:
                if member.isdir() or executable(name, outer_expected[name]):
                    mode = 0o755
                stream = archive.extractfile(member) if member.isfile() else None
                try:
                    write_tar_entry(out, member, stream, mode)
                finally:
                    if stream:
                        stream.close()
    return verify_fpk(target, stage, scratch)


def build(root: Path, runtime: Path, output: Path, fnpack: Path | None, stage_only=False) -> dict:
    root, runtime = absolute(root), absolute(runtime)
    output = check_output_path(output, root, runtime)
    if not stage_only:
        if fnpack is None:
            raise Error("--fnpack EXPLICIT_PATH is required unless --stage-only")
        fnpack = absolute(fnpack)
        if not fnpack.is_file():
            raise Error("--fnpack must name an existing executable file, not a PATH command")
    with output_transaction(output, BUILD_OWNER, reject_fpk=True) as (generated, scratch):
        stage = generated / "stage" if stage_only else scratch / "stage"
        pins = make_stage(root, runtime, stage)
        result = {"status": "staged" if stage_only else "built", **pins, "output": str(output),
                  "signature_verified": False, "renderer_rebuilt": False}
        if stage_only:
            hashes = inventory(stage)
            summary = generated / "stage-files.sha256"
            summary.write_text("".join(f"{digest}  {name}\n" for name, digest in sorted(hashes.items())),
                               encoding="utf-8", newline="\n")
            result.update({"stage": str(output / "stage"), "unix_modes_verified": False,
                           "stage_files": len(hashes), "stage_inventory_sha256": sha(summary),
                           "note": "Stage only; final FPK archive permissions still require verification."})
        else:
            expected = inventory(stage)
            cwd = scratch / "fnpack-cwd"
            cwd.mkdir()
            completed = subprocess.run([str(fnpack), "build", "--directory", str(stage)], cwd=cwd,
                                       env=isolated_env(scratch / "home"), capture_output=True,
                                       text=True, encoding="utf-8", errors="replace")
            if completed.returncode:
                raise Error(f"fnpack failed ({completed.returncode}): {completed.stdout}\n{completed.stderr}")
            # fnpack 失败时也可能返回 0，不能只信退出码。
            candidates = list(cwd.glob("*.fpk"))
            if len(candidates) != 1:
                raise Error(f"fnpack must produce exactly one FPK in isolated cwd: {completed.stdout}\n{completed.stderr}")
            if inventory(stage) != expected:
                raise Error("fnpack modified the verified stage")
            filename = f"fnos-hermes-agent_v{pins['version']}.fpk"
            report = normalize_fpk(candidates[0], generated / filename, stage, scratch)
            digest = sha(generated / filename)
            (generated / (filename + ".sha256")).write_text(f"{digest}  {filename}\n", encoding="ascii")
            result.update({"fpk": str(output / filename), "sha256": digest, "verification": report,
                           "fnpack_sha256": sha(fnpack), "archive_modes_normalized": True})
        write_json(generated / "build-result.json", result)
    return result


def https_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.fragment or any(ord(c) < 33 for c in url)):
        raise Error("Runtime asset URL must be HTTPS without credentials, fragments or whitespace")
    return url


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, https_url(newurl))


def extract_runtime(archive_path: Path, target: Path) -> Path:
    if target.exists():
        raise Error("Runtime extraction requires a new directory")
    if archive_path.stat().st_size > MAX_ARCHIVE:
        raise Error("Runtime archive too large")
    try:
        with tarfile.open(disk(archive_path), "r:*") as archive:
            entries = archive_index(archive)
            if not entries or any(n != "hermes-src" and not n.startswith("hermes-src/") for n in entries):
                raise Error("Runtime archive must contain only a single hermes-src/ tree")
            target.mkdir(parents=True)
            for name, member in entries.items():
                dest = disk(target / safe_name(name))
                if member.isdir():
                    dest.mkdir(parents=True, exist_ok=True)
                else:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as src, dest.open("xb") as out:
                        shutil.copyfileobj(src, out)
                    dest.chmod(member.mode & 0o777)
        verify_runtime(target / "hermes-src")
        return target / "hermes-src"
    except BaseException:
        if target.exists():
            shutil.rmtree(disk(target))
        raise


def fetch_runtime(url: str, digest: str, scratch: Path) -> Path:
    https_url(url)
    if not re.fullmatch("[0-9a-fA-F]{64}", digest):
        raise Error("--runtime-sha256 must be the trusted asset's 64-digit SHA256")
    archive = scratch / "runtime.tar.gz"
    # 不读取代理凭据、.netrc、浏览器配置或 HOME 下的配置。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), HTTPSRedirect())
    with opener.open(url, timeout=60) as response, archive.open("xb") as out:
        https_url(response.url)
        size = 0
        while block := response.read(1024 * 1024):
            size += len(block)
            if size > MAX_ARCHIVE:
                raise Error("Runtime download exceeds size limit")
            out.write(block)
    if sha(archive) != digest.lower():
        raise Error("Runtime asset SHA256 mismatch; not extracted")
    return extract_runtime(archive, scratch / "extracted")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fnpack", type=Path, help="explicit fnpack executable path")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--runtime-dir", type=Path, help="verified hermes-src tree (default: app/hermes-src)")
    group.add_argument("--runtime-archive", type=Path, help="local hermes-src tar.gz; SHA256-verified, extracted to a temp dir")
    group.add_argument("--runtime-url", help="manual CI only: trusted HTTPS hermes-src tar.gz asset")
    parser.add_argument("--runtime-sha256", help="out-of-band SHA256 of --runtime-archive or --runtime-url asset")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist")
    parser.add_argument("--stage-only", action="store_true")
    args = parser.parse_args()
    try:
        if args.runtime_url:
            if not args.runtime_sha256:
                raise Error("--runtime-url and --runtime-sha256 must be supplied together")
            # TemporaryDirectory 不会枚举或读取用户 HOME。
            with tempfile.TemporaryDirectory(prefix="fnos-runtime-download-") as tmp:
                runtime = fetch_runtime(args.runtime_url, args.runtime_sha256, Path(tmp))
                result = build(ROOT, runtime, args.output_dir, args.fnpack, args.stage_only)
        elif args.runtime_archive:
            if not args.runtime_sha256:
                raise Error("--runtime-archive and --runtime-sha256 must be supplied together")
            if not re.fullmatch("[0-9a-fA-F]{64}", args.runtime_sha256):
                raise Error("--runtime-sha256 must be the trusted asset's 64-digit SHA256")
            archive = absolute(args.runtime_archive)
            if sha(archive) != args.runtime_sha256.lower():
                raise Error("Runtime archive SHA256 mismatch; not extracted")
            # 解压到自动清理的临时目录，项目内不留下 hermes-src 目录树。
            with tempfile.TemporaryDirectory(prefix="fnos-runtime-archive-") as tmp:
                runtime = extract_runtime(archive, Path(tmp) / "extracted")
                result = build(ROOT, runtime, args.output_dir, args.fnpack, args.stage_only)
        else:
            if args.runtime_sha256:
                raise Error("--runtime-sha256 is only valid with --runtime-archive or --runtime-url")
            result = build(ROOT, args.runtime_dir or ROOT / "app/hermes-src", args.output_dir,
                           args.fnpack, args.stage_only)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (Error, OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        print(f"build-fpk: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
