#!/usr/bin/env python3
"""导出干净的 GitHub 源码树、独立的项目测试和运行时资源。

Python >=3.11，仅标准库。不访问 Git、网络、渲染器构建或用户 HOME。
交付根目录必须是新目录，或本脚本自己生成且完好的输出；
已有的未知或被修改的文件（含空目录）绝不删除。
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tarfile

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("build_fpk", ROOT / "scripts/build-fpk.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
OWNER = "fnos-hermes-export-v1"
EXTRA_SOURCE = ("README.md", "preview", *build.MAINTENANCE,
                ".github/workflows/Build_fnos-hermes-agent.yml")


def test_files(root: Path, excluded_roots):
    # 不遍历官方运行时、输出目录、依赖和任意开发者状态。测试保留原来的项目相对路径。
    for folder in ("app/bin", "app/server", "app/ui", "cmd", "config", "wizard", "scripts", "tests"):
        base = root / folder
        if not base.exists():
            continue
        build.no_links(base)
        for current, dirs, files in os.walk(build.disk(base), followlinks=False):
            current = Path(current)
            kept = []
            for name in sorted(dirs):
                child = current / name
                relative = child.relative_to(build.disk(root)).as_posix()
                if (name.startswith((".fnos-", ".hermes-src-", "tmp")) or build.excluded_project(relative)
                        or any(child.resolve().is_relative_to(p.resolve()) for p in excluded_roots)):
                    continue
                build.no_links(child)
                kept.append(name)
            dirs[:] = kept
            for name in sorted(files):
                path = current / name
                relative = path.relative_to(build.disk(root)).as_posix()
                if build.project_test(relative) and not build.excluded_project(relative):
                    build.safe_name(relative)
                    build.no_links(path)
                    yield relative, path


def runtime_asset(runtime: Path, destination: Path) -> dict:
    receipt = build.verify_runtime(runtime)
    before = build.inventory(runtime)
    with tarfile.open(build.disk(destination), "w:gz") as archive:
        directory = tarfile.TarInfo("hermes-src")
        directory.type = tarfile.DIRTYPE
        directory.mode = 0o755
        archive.addfile(directory)
        for name, path in build.walk_files(runtime):
            member = archive.gettarinfo(str(path), arcname="hermes-src/" + name)
            mode = 0o755 if build.executable(name, path) else 0o644
            with path.open("rb") as stream:
                build.write_tar_entry(archive, member, stream, mode)
    if build.inventory(runtime) != before:
        raise build.Error("Runtime changed while exporting archive")
    # 校验实际生成的归档，而不只是它的来源目录。
    with tarfile.open(build.disk(destination), "r:*") as archive:
        expected = {"hermes-src/" + name: build.disk(runtime / name) for name in before}
        build.compare_archive(archive, build.archive_index(archive), expected)
    return {"sha256": build.sha(destination), "files": len(before),
            "tag": receipt["tag"], "commit": receipt["commit"], "signature_verified": False}


def export(root: Path, output: Path, runtime: Path | None = None) -> dict:
    root = build.absolute(root)
    runtime = build.absolute(runtime or root / "app/hermes-src")
    output = build.check_output_path(output, root, runtime)
    pins = build.validate_pins(root)
    build.verify_runtime(runtime)
    with build.output_transaction(output, OWNER) as (generated, scratch):
        clean = generated / "fnos-hermes-agent"
        clean.mkdir()
        for name, source in build.selected_files(root, (*build.PRODUCTION, *EXTRA_SOURCE)):
            build.copy_file(source, clean / name, name)
        if build.validate_pins(clean) != pins:
            raise build.Error("Exported pins differ from source")
        tests = generated / "tests"
        tests.mkdir()
        count = 0
        for name, source in test_files(root, (output, scratch, runtime)):
            build.copy_file(source, tests / name, name)
            count += 1
        for name, _ in build.walk_files(clean):
            if (build.project_test(name) or name.startswith("app/hermes-src/")
                    or name == "DEVELOPMENT.md" or build.excluded_project(name)):
                raise build.Error(f"Forbidden clean source entry: {name}")
        assets = generated / "runtime"
        assets.mkdir()
        filename = f"hermes-src-{pins['tag']}-{pins['commit'][:12]}.tar.gz"
        report = runtime_asset(runtime, assets / filename)
        (assets / (filename + ".sha256")).write_text(f"{report['sha256']}  {filename}\n", encoding="ascii")
        # 参数数组在 Windows 和 Linux 上都无歧义。解压会先校验并验证回执，再提供为构建输入。
        project = output / "fnos-hermes-agent"
        extracted = output.parent / (output.name + "-runtime")
        result = {"status": "exported", **pins, "output": str(output), "github_project": str(project),
                  "tests": str(output / "tests"), "test_files": count,
                  "runtime_asset": str(output / "runtime" / filename), "runtime": report,
                  "commands": {
                      "extract_runtime_argv": ["python", str(project / "scripts/export-project.py"),
                                               "--extract-runtime", str(output / "runtime" / filename),
                                               "--sha256", report["sha256"], "--output", str(extracted)],
                      "stage_argv": ["python", str(project / "scripts/build-fpk.py"), "--runtime-dir",
                                     str(extracted / "hermes-src"), "--stage-only", "--output-dir",
                                     str(output.parent / (output.name + "-stage"))],
                      "build_argv": ["python", str(project / "scripts/build-fpk.py"), "--runtime-dir",
                                     str(extracted / "hermes-src"), "--output-dir",
                                     str(output.parent / (output.name + "-dist"))]},
                  "build_instruction": "Append --fnpack followed by the absolute path to fnpack 1.2.3.",
                  "tests_instruction": "Tests are not in the GitHub project. To run them, copy the clean project "
                                       "to a separate test workspace and overlay delivery/tests/ preserving paths.",
                  "runtime_instruction": "Upload only fnos-hermes-agent/ as GitHub source. Keep runtime/ separately; "
                                         "the archive includes unchanged official tests required by the renderer hash."}
        build.write_json(generated / "export-result.json", result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "delivery")
    parser.add_argument("--runtime-dir", type=Path, help="prepared runtime (default: app/hermes-src)")
    parser.add_argument("--extract-runtime", type=Path, help="extract a transferred runtime archive, not a project export")
    parser.add_argument("--sha256", help="required trusted SHA256 when extracting an archive")
    args = parser.parse_args()
    try:
        if args.extract_runtime:
            if args.runtime_dir or not args.sha256:
                raise build.Error("--extract-runtime requires --sha256 and cannot use --runtime-dir")
            import re
            if not re.fullmatch("[0-9a-fA-F]{64}", args.sha256):
                raise build.Error("Expected a 64-digit SHA256")
            source = build.absolute(args.extract_runtime)
            output = build.check_output_path(args.output, ROOT)
            if source.is_relative_to(output):
                raise build.Error("Extraction output must not contain the input archive")
            if build.sha(source) != args.sha256.lower():
                raise build.Error("Runtime archive SHA256 mismatch; not extracted")
            with build.output_transaction(output, "fnos-hermes-runtime-transfer-v1") as (generated, scratch):
                extracted = build.extract_runtime(source, scratch / "extract")
                build.prepare.rename_held(extracted, generated / "hermes-src")
            result = {"status": "extracted", "runtime_dir": str(output / "hermes-src")}
        else:
            if args.sha256:
                raise build.Error("--sha256 is only valid with --extract-runtime")
            result = export(ROOT, args.output, args.runtime_dir)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (build.Error, OSError, ValueError, KeyError, TypeError, tarfile.TarError) as error:
        print(f"export-project: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
