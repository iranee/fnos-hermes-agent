#!/usr/bin/env python3
"""刷新安装包当前支持的固定 Hermes 快照，不操作 NAS。

需要 prepare-runtime 所固定 TAG/COMMIT 的干净官方 Git checkout，
以及与其官方渲染器回执匹配的现有 Node。不下载、不编译、不重写回执、
不改固定版本、不安装依赖、不支持任意 tag。
Python >=3.11，仅标准库。--check 不会发布快照。
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("build_fpk", ROOT / "scripts/build-fpk.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
prepare = build.prepare


@contextmanager
def private_environment(home: Path):
    saved = dict(os.environ)
    try:
        env = build.isolated_env(home)
        os.environ.clear()
        os.environ.update(env)
        yield
    finally:
        os.environ.clear()
        os.environ.update(saved)


def update(root: Path, source: Path, node: str, output: Path | None = None, check=False, *,
           dashboard_dist: Path | None = None, prepared_icons: Path | None = None) -> dict:
    root = build.absolute(root)
    pins = build.validate_pins(root)
    source = build.absolute(source)
    output = build.absolute(output or root / "app/hermes-src")
    # 不放宽 prepare 的任何检查：目录所有权、工作树是否干净、输出目录是否与源码重叠、
    # 锁、构建回执、主机/Node 兼容性，以及事务式发布。
    if not node or node.isspace():
        raise build.Error("--node must identify the existing receipt-compatible Node executable")
    with tempfile.TemporaryDirectory(prefix="fnos-hermes-update-") as tmp:
        with private_environment(Path(tmp) / "home"):
            result = prepare.prepare(source, output, node, check_only=check,
                                     dashboard_dist=dashboard_dist, prepared_icons=prepared_icons)
    return {"status": "checked" if check else "prepared", **pins, "target": str(output),
            "commit": result["commit"], "tag": result["tag"], "signature_verified": False,
            "renderer_rebuilt": False, "nas_updated": False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="clean official Git worktree root")
    parser.add_argument("--node", required=True, help="existing Node compatible with the official build receipt")
    parser.add_argument("--check", action="store_true", help="read-only checks, no snapshot publication")
    parser.add_argument("--output", type=Path, help="prepared snapshot target (default: app/hermes-src)")
    parser.add_argument("--dashboard-dist", type=Path, help="existing official web product (default: SOURCE/hermes_cli/web_dist)")
    parser.add_argument("--prepared-icons", type=Path, help="trusted prepared web/public directory (default: SOURCE/web/public)")
    args = parser.parse_args()
    try:
        result = update(ROOT, args.source, args.node, args.output, args.check,
                        dashboard_dist=args.dashboard_dist, prepared_icons=args.prepared_icons)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (build.Error, OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        print(f"update-hermes: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
