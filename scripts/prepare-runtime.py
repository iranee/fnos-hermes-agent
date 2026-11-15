#!/usr/bin/env python3
"""打包固定版本的干净 checkout 及其带编译器构建记录（回执）的 WebApp 和 Dashboard。

需要 Python >=3.11 和 hermes-build.json 指定的 Node 版本。
不执行构建、不安装依赖、不访问网络、不改动 Git。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import tomllib

WORKSPACE = Path(__file__).resolve().parent.parent


def pinned_identity() -> tuple[str, str]:
    # 默认取 config/bootstrap/hermes-version.env；build.sh 用 HERMES_VERSION_FILE 指向 runtime/hermes-version.env。
    path = Path(os.environ.get("HERMES_VERSION_FILE") or WORKSPACE / "config/bootstrap/hermes-version.env")
    values = dict(line.split("=", 1) for line in path.read_text(encoding="utf-8").splitlines()
                  if "=" in line and not line.startswith("#"))
    tag, commit = values.get("HERMES_VERSION", ""), values.get("HERMES_COMMIT", "")
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise SystemExit(f"Invalid {path}")
    return commit, tag


COMMIT, TAG = pinned_identity()
OWNER = "fnos-hermes-prepare-runtime-v1"
RECEIPT = ".fnos-runtime.json"
DIST = Path("apps/desktop/dist-webapp")
DASHBOARD_DIST = Path("hermes_cli/web_dist")
# 只归档已提交的源码，绝不复制本地运行时或配置目录。
EXCLUDED = {".git", "node_modules", "venv", ".venv", "__pycache__", ".hermes"}


class PrepareError(RuntimeError):
    pass


def run(args: list[str], **kwargs) -> str:
    result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", **kwargs)
    if result.returncode:
        raise PrepareError(f"Command failed ({result.returncode}): {args[0]}: {result.stderr.strip()}")
    return result.stdout.strip()


def git(source: Path, *args: str) -> str:
    return run(["git", "--no-optional-locks", "-C", str(source), *args])


def long_path(path: Path) -> Path:
    # 否则 Win32 MAX_PATH 会拒绝官方源码中合法的深层文件名。
    if os.name == "nt" and not str(path).startswith("\\\\?\\"):
        name = str(path.absolute())
        return Path("\\\\?\\UNC\\" + name[2:] if name.startswith("\\\\") else "\\\\?\\" + name)
    return path


def no_link_entry(path: Path) -> None:
    if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
        raise PrepareError(f"Symlink/junction is not allowed: {path}")


def no_links(path: Path) -> None:
    for part in (path, *path.parents):
        no_link_entry(part)


def clean_source(source: Path) -> None:
    no_links(source)
    if Path(git(source, "rev-parse", "--show-toplevel")).resolve() != source.resolve():
        raise PrepareError("--source must be the Git worktree root")
    head = git(source, "rev-parse", "HEAD")
    tag = git(source, "rev-parse", f"refs/tags/{TAG}^{{commit}}")
    if head != COMMIT or tag != COMMIT:
        raise PrepareError(f"Wrong version: HEAD={head}, {TAG}={tag}; expected {COMMIT}")
    if git(source, "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"):
        # 不打印任意用户文件名，也不读取未跟踪或被忽略的密钥。
        raise PrepareError("Dirty Git worktree (tracked or untracked changes); refusing to package")
    if git(source, "ls-files", "-v").splitlines() and any(
        line[0].islower() or line.startswith("S ") for line in git(source, "ls-files", "-v").splitlines()
    ):
        raise PrepareError("assume-unchanged/skip-worktree flags prevent a trustworthy dirty check")


def sha(path: Path) -> str:
    no_links(path)
    if not path.is_file():
        raise PrepareError(f"Missing regular file: {path}")
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inventory(root: Path) -> dict[str, str]:
    root = long_path(root)
    no_links(root)
    result = {}
    for current, dirs, files in os.walk(root, followlinks=False):
        # 自顶向下遍历时父目录已检查过。避免对约 2.4 万个文件各做 O(depth) 次重复文件系统查询。
        for name in dirs + files:
            no_link_entry(Path(current) / name)
        for name in sorted(files):
            path = Path(current) / name
            if not path.is_file():
                raise PrepareError(f"Not a regular file: {path}")
            with path.open("rb") as stream:
                result[path.relative_to(root).as_posix()] = hashlib.file_digest(stream, "sha256").hexdigest()
    return dict(sorted(result.items()))


def runtime_metadata(source: Path) -> dict:
    project = tomllib.loads((source / "pyproject.toml").read_text(encoding="utf-8"))
    lock = tomllib.loads((source / "uv.lock").read_text(encoding="utf-8"))
    python = (source / ".python-version").read_text(encoding="utf-8").strip()
    if python != "3.14" or project["project"]["requires-python"] != ">=3.11,<3.15":
        raise PrepareError("Unexpected pinned source Python requirements")
    if project["tool"]["uv"]["environments"] != ["python_version >= '3.14'"]:
        raise PrepareError("Unexpected source runtime environment")
    if lock.get("supported-markers") != ["python_full_version >= '3.14'"]:
        raise PrepareError("uv.lock does not cover the required Python runtime")
    if not any(p.get("name") == "hermes-agent" and p.get("source") == {"editable": "."}
               for p in lock.get("package", [])):
        raise PrepareError("uv.lock must install Hermes from the local editable project")
    return {"python": python, "requires_python": project["project"]["requires-python"],
            "pyproject_sha256": sha(source / "pyproject.toml"), "lock_sha256": sha(source / "uv.lock")}


# 只调用官方只读的编译器构建记录（回执）函数，绝不调用 recordProduct 或构建器。
VERIFY_JS = r"""
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const [source, out, verifier] = process.argv.slice(1);
const m = await import(pathToFileURL(verifier).href);
const saved = JSON.parse(readFileSync(out + '/hermes-build.json', 'utf8'));
if (saved.schema !== 1 || saved.product !== 'webapp' ||
    JSON.stringify(saved.inputs?.prepared) !== '[]' ||
    JSON.stringify(saved.inputs?.env) !== JSON.stringify([['NODE_ENV', 'production']]))
  throw Error('Unsupported WebApp receipt inputs (expected unprepared production renderer)');
const report = {sourceHash: m.sourceHash(source, 'webapp'),
  receiptSourceHash: saved.inputs.sourceHash,
  outputIntact: m.outputIntact(out, 'webapp'),
  productCurrent: m.productCurrent({source, product: 'webapp', out}),
  host: {platform:process.platform, arch:process.arch, node:process.versions.node},
  builder: {platform:saved.platform, arch:saved.arch, node:saved.node}};
console.log(JSON.stringify(report));
"""


def verify_renderer(source: Path, node: str, verifier: Path | None = None) -> dict:
    dist = source / DIST
    if not (dist / "index.html").is_file() or not (dist / "hermes-build.json").is_file():
        raise PrepareError("Missing dist-webapp/index.html or official hermes-build.json; no build is attempted")
    if (dist / ".hermes-stale").exists():
        raise PrepareError("Official WebApp is marked stale")
    files = inventory(dist)
    # 严格保留主机/Node 检查：换一个 Node 不能悄悄重新认证这次构建。
    env = {k: v for k, v in os.environ.items() if not k.startswith("VITE_") and k != "NODE_OPTIONS"}
    env["NODE_ENV"] = "production"
    report = json.loads(run([node, "--input-type=module", "-e", VERIFY_JS, str(source), str(dist),
                             str(verifier or source / "scripts/build/freshness.mjs")], env=env))
    if not report["productCurrent"] or not report["outputIntact"] or report["sourceHash"] != report["receiptSourceHash"]:
        raise PrepareError("Official compiler receipt mismatch (not rewritten): " + json.dumps(report))
    if report["host"] != report["builder"]:
        raise PrepareError("WebApp compiler host/Node mismatch")
    if inventory(dist) != files:
        raise PrepareError("Renderer changed during verification")
    return {"verification": report, "files": files,
            "official_receipt_sha256": files["hermes-build.json"]}


VERIFY_DASHBOARD_JS = r"""
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const [source, out, verifier, icons] = process.argv.slice(1);
const m = await import(pathToFileURL(verifier).href);
const saved = JSON.parse(readFileSync(out + '/hermes-build.json', 'utf8'));
// The path is selected by the caller, NEVER taken on trust from a candidate receipt.
const inputs = m.buildInputs(source, 'web', {icons});
if (saved.schema !== 1 || saved.product !== 'web' ||
    JSON.stringify(saved.inputs) !== JSON.stringify(inputs))
  throw Error('Unsupported Dashboard receipt inputs or prepared icon hash/path mismatch');
const report = {sourceHash: m.sourceHash(source, 'web'),
  receiptSourceHash: saved.inputs.sourceHash,
  prepared: inputs.prepared,
  outputIntact: m.outputIntact(out, 'web'),
  productCurrent: m.productCurrent({source, product: 'web', out, prepared: {icons}}),
  host: {platform:process.platform, arch:process.arch, node:process.versions.node},
  builder: {platform:saved.platform, arch:saved.arch, node:saved.node}};
console.log(JSON.stringify(report));
"""


def verify_dashboard(source: Path, node: str, dist: Path | None = None,
                     prepared_icons: Path | None = None, verifier: Path | None = None) -> dict:
    dist = dist if dist is not None else source / DASHBOARD_DIST
    icons = prepared_icons if prepared_icons is not None else source / "web/public"
    no_links(dist)
    no_links(icons)
    files = inventory(dist)
    if not {"index.html", "hermes-build.json"}.issubset(files):
        raise PrepareError("Missing Dashboard index.html or official hermes-build.json; no build is attempted")
    if ".hermes-stale" in files:
        raise PrepareError("Official Dashboard is marked stale")
    if not any(n.startswith("assets/") and n.endswith(".js") for n in files):
        raise PrepareError("Missing Dashboard JavaScript assets; refusing an incomplete product")
    icon_files = inventory(icons)
    if "favicon.ico" not in icon_files:
        raise PrepareError("Missing trusted prepared icons/favicon.ico; no icon generation is attempted")
    env = {k: v for k, v in os.environ.items() if not k.startswith("VITE_") and k != "NODE_OPTIONS"}
    env["NODE_ENV"] = "production"
    report = json.loads(run([node, "--input-type=module", "-e", VERIFY_DASHBOARD_JS,
                             str(source), str(dist), str(verifier or source / "scripts/build/freshness.mjs"),
                             str(icons)], env=env))
    if (report["productCurrent"] is not True or report["outputIntact"] is not True
            or report["sourceHash"] != report["receiptSourceHash"] or report["host"] != report["builder"]):
        raise PrepareError("Official Dashboard compiler receipt mismatch (not rewritten): " + json.dumps(report))
    if inventory(dist) != files or inventory(icons) != icon_files:
        raise PrepareError("Dashboard or prepared icons changed during verification")
    return {"verification": report, "files": files,
            "official_receipt_sha256": files["hermes-build.json"]}


def safe_name(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if (not name or path.is_absolute() or any(p in ("", ".", "..") for p in name.split("/"))
            or "\\" in name or ":" in name or any(ord(c) < 32 for c in name)):
        raise PrepareError(f"Unsafe archive/manifest path: {name!r}")
    return path


def excluded(path: PurePosixPath) -> bool:
    return (any(p in EXCLUDED for p in path.parts)
            or any(p == ".env" or p.startswith(".env.") for p in path.parts)
            or path.parts[0] in {"config", "config.yaml", "config.yml", "install-stamp.json"}
            or any(path.is_relative_to(PurePosixPath(dist.as_posix())) for dist in (DIST, DASHBOARD_DIST)))


def archive_source(source: Path, stage: Path, tar_path: Path) -> None:
    # 流式写入归档字节：Git for Windows 的 --output 不接受扩展 Win32 路径，Python 文件句柄可以。
    # 绝不把整个核心源码缓冲在内存里。
    with tar_path.open("wb") as output:
        result = subprocess.run(["git", "--no-optional-locks", "-C", str(source),
                                 "archive", "--format=tar", COMMIT], stdout=output, stderr=subprocess.PIPE)
    if result.returncode:
        raise PrepareError("git archive failed: " + result.stderr.decode("utf-8", errors="replace"))
    seen = set()
    with tarfile.open(tar_path, "r:") as archive:
        for member in archive:
            name = safe_name(member.name.rstrip("/"))
            if excluded(name):
                continue
            if not member.isdir() and not member.isfile():
                raise PrepareError(f"Archive contains a link/special file: {name}")
            dest = stage / name
            if member.isdir():
                dest.mkdir(parents=True, exist_ok=True)
                continue
            key = name.as_posix().casefold()
            if key in seen:
                raise PrepareError(f"Duplicate/case-colliding archive file: {name}")
            seen.add(key)
            dest.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as src, dest.open("xb") as out:
                shutil.copyfileobj(src, out)
            dest.chmod(0o755 if member.mode & 0o111 else 0o644)
            os.utime(dest, (member.mtime, member.mtime))


def require_owned(target: Path) -> None:
    no_links(target)
    if not target.exists():
        return
    try:
        saved = json.loads((target / RECEIPT).read_text(encoding="utf-8"))
        actual = inventory(target)
        actual.pop(RECEIPT)
        if saved["owner"] == OWNER and saved["schema"] == 1 and actual == saved["files"]:
            return
    except (OSError, ValueError, KeyError, TypeError):
        pass
    raise PrepareError(f"Refusing to replace unowned or modified output: {target}")


def rename_held(source: Path, target: Path) -> None:
    # Windows 扫描程序可能短暂占用刚解压的目录树。只对共享/访问冲突重试，
    # 不掩盖持续性的权限失败。
    for delay in (0.1, 0.2, 0.4, 0.8, 1.6, None):
        try:
            source.rename(target)
            return
        except OSError as error:
            if delay is None or getattr(error, "winerror", None) not in (5, 32, 33):
                raise
            time.sleep(delay)


def publish(stage: Path, target: Path) -> None:
    require_owned(target)
    if not target.exists():
        rename_held(stage, target)
        return
    backup_root = Path(tempfile.mkdtemp(prefix=".hermes-src-previous-", dir=target.parent))
    backup = backup_root / "hermes-src"
    try:
        rename_held(target, backup)
    except BaseException:
        backup_root.rmdir()
        raise
    try:
        rename_held(stage, target)
    except BaseException as error:
        try:
            rename_held(backup, target)
        except OSError as rollback:
            raise PrepareError(f"Publication failed; old output retained at {backup}: {rollback}") from error
        backup_root.rmdir()
        raise
    # 一旦提交完成，清理出错不能被报告成发布失败。
    try:
        shutil.rmtree(backup_root)
    except OSError:
        print(f"Warning: old generated output retained at {backup}", file=sys.stderr)


def prepare(source: Path, target: Path, node: str, check_only: bool = False, *,
            dashboard_dist: Path | None = None, prepared_icons: Path | None = None) -> dict:
    source = source.absolute()
    target = target.absolute()
    no_links(source)
    no_links(target)
    source, target = source.resolve(), target.resolve()
    if source == target or source.is_relative_to(target) or target.is_relative_to(source):
        raise PrepareError("Source and output must not overlap or nest")
    dashboard_dist = (dashboard_dist if dashboard_dist is not None else source / DASHBOARD_DIST).absolute()
    prepared_icons = (prepared_icons if prepared_icons is not None else source / "web/public").absolute()
    for path in (dashboard_dist, prepared_icons):
        no_links(path)
    dashboard_dist, prepared_icons = dashboard_dist.resolve(), prepared_icons.resolve()
    for path in (dashboard_dist, prepared_icons):
        if path == target or path.is_relative_to(target) or target.is_relative_to(path):
            raise PrepareError("Dashboard/prepared-icons inputs and output must not overlap or nest")
    require_owned(target)
    clean_source(source)
    metadata = runtime_metadata(source)
    renderer = verify_renderer(source, node)
    icon_files = inventory(prepared_icons)
    dashboard = verify_dashboard(source, node, dashboard_dist, prepared_icons)
    if check_only:
        clean_source(source)
        if (inventory(source / DIST) != renderer["files"] or inventory(dashboard_dist) != dashboard["files"]
                or inventory(prepared_icons) != icon_files):
            raise PrepareError("Frontend inputs changed during preparation")
        return {"commit": COMMIT, "tag": TAG, "runtime": metadata, "renderer": renderer["verification"],
                "dashboard": dashboard["verification"]}
    target = long_path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    # 按目标独占锁，绝不自动打破其他进程的锁。
    lock = target.parent / ".hermes-src-prepare.lock"
    with lock.open("x", encoding="utf-8") as lock_handle:
        try:
            with tempfile.TemporaryDirectory(prefix=".hermes-src-stage-", dir=target.parent) as scratch:
                scratch = Path(scratch)
                stage = scratch / "hermes-src"
                stage.mkdir()
                archive_source(source, stage, scratch / "source.tar")
                if not (stage / "LICENSE").is_file():
                    raise PrepareError("Official LICENSE missing from archive")
                shutil.copytree(source / DIST, stage / DIST)
                shutil.copytree(dashboard_dist, stage / DASHBOARD_DIST)
                copied = verify_renderer(stage, node, source / "scripts/build/freshness.mjs")
                if copied != renderer or inventory(source / DIST) != renderer["files"]:
                    raise PrepareError("Renderer changed during preparation")
                # 保留原始可信路径：编译器构建记录同时绑定图标的绝对路径和哈希。
                # 绝不为了适配新 stage 而重写回执。
                copied_dashboard = verify_dashboard(stage, node, stage / DASHBOARD_DIST, prepared_icons,
                                                    source / "scripts/build/freshness.mjs")
                if (copied_dashboard != dashboard or inventory(dashboard_dist) != dashboard["files"]
                        or inventory(prepared_icons) != icon_files):
                    raise PrepareError("Dashboard or prepared icons changed during preparation")
                if runtime_metadata(stage) != metadata:
                    raise PrepareError("Archived runtime requirements differ from checkout")
                clean_source(source)
                stage_files = inventory(stage)
                for dist, product in ((DIST, renderer), (DASHBOARD_DIST, dashboard)):
                    prefix = dist.as_posix() + "/"
                    if {k[len(prefix):]: v for k, v in stage_files.items() if k.startswith(prefix)} != product["files"]:
                        raise PrepareError("Frontend stage changed during preparation")
                if (inventory(source / DIST) != renderer["files"] or inventory(dashboard_dist) != dashboard["files"]
                        or inventory(prepared_icons) != icon_files):
                    raise PrepareError("Frontend inputs changed during preparation")
                receipt = {"schema": 1, "owner": OWNER, "commit": COMMIT, "tag": TAG,
                           "source": {"repository": "https://github.com/NousResearch/hermes-agent",
                                      "collection": "git archive", "signature_verified": False},
                           "runtime": metadata, "renderer": renderer, "dashboard": dashboard, "files": stage_files}
                (stage / RECEIPT).write_text(json.dumps(receipt, sort_keys=True, indent=2) + "\n", encoding="utf-8")
                for current, dirs, files in os.walk(stage, followlinks=False):
                    Path(current).chmod(0o755)
                    for name in dirs + files:
                        no_link_entry(Path(current) / name)
                    for name in files:
                        path = Path(current) / name
                        path.chmod(0o755 if path.stat().st_mode & 0o111 else 0o644)
                publish(stage, target)
                return receipt
        finally:
            # Windows 无法删除已打开的文件（WinError 32）。
            lock_handle.close()
            lock.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="clean official Git worktree root")
    parser.add_argument("--node", default="node", help="existing Node used by the official build receipt")
    parser.add_argument("--check", action="store_true", help="read-only identity/receipt checks; do not package")
    parser.add_argument("--dashboard-dist", type=Path, help="existing official web product (default: SOURCE/hermes_cli/web_dist)")
    parser.add_argument("--prepared-icons", type=Path, help="trusted prepared web/public directory (default: SOURCE/web/public)")
    args = parser.parse_args()
    try:
        result = prepare(args.source, WORKSPACE / "app/hermes-src", args.node, args.check,
                         dashboard_dist=args.dashboard_dist, prepared_icons=args.prepared_icons)
        print(json.dumps({"status": "checked" if args.check else "prepared", "commit": result["commit"],
                          "target": str(WORKSPACE / "app/hermes-src"), "signature_verified": False}))
        return 0
    except (PrepareError, OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        print(f"prepare-runtime: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
