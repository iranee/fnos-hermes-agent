"""Dispatch app helpers after the official launcher's --run-module bootstrap."""

import os
from pathlib import Path
import runpy
import sys


HELPERS = {
    "webapp-control": "webapp-control.py",
    "model-config": "model-config.py",
    "source-check": "source-check.py",
}


def _helper_path(name):
    if name not in HELPERS:
        raise ValueError("expected helper: webapp-control, model-config or source-check")

    directories = {}
    for key in ("APP_DIR", "DATA_DIR", "HOME", "HERMES_HOME"):
        value = os.environ.get(key, "")
        path = Path(value)
        if not value or not path.is_absolute():
            raise ValueError(f"{key} must be an absolute directory path")
        path = path.resolve(strict=True)
        if not path.is_dir():
            raise ValueError(f"{key} must be a directory")
        directories[key] = path

    for key in ("HOME", "HERMES_HOME"):
        if directories[key] != directories["DATA_DIR"]:
            raise ValueError(f"{key} must resolve to DATA_DIR")

    source = Path(__file__).resolve(strict=True)
    expected = directories["APP_DIR"] / "server" / "fnos-runtime.py"
    if source != expected or not source.is_file():
        raise ValueError("adapter must resolve to APP_DIR/server/fnos-runtime.py")

    helper = source.with_name(HELPERS[name])
    if helper.resolve(strict=True) != helper or not helper.is_file():
        raise ValueError("helper must be a regular file in APP_DIR/server")
    return helper


def main():
    try:
        helper = _helper_path(sys.argv[1] if len(sys.argv) > 1 else "")
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"fnos-runtime: {exc}", file=sys.stderr)
        return 2

    original_argv = sys.argv
    # Only consume the selector; helper options, input and launcher state are untouched.
    sys.argv = [str(helper), *original_argv[2:]]
    try:
        runpy.run_path(str(helper), run_name="__main__")
    finally:
        sys.argv = original_argv
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
