#!/bin/bash
# Rebuild the pinned official runtime and TUI assets consumed by build.sh.
set -euo pipefail
umask 022
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$ROOT"
# 内核版本只取自 hermes-version.env，换版本只改这一个文件。
HERMES_VERSION=$(sed -n 's/^HERMES_VERSION=//p' config/bootstrap/hermes-version.env)
HERMES_COMMIT=$(sed -n 's/^HERMES_COMMIT=//p' config/bootstrap/hermes-version.env)
HERMES_TAG=$(sed -n 's/^HERMES_TAG=//p' config/bootstrap/hermes-version.env)
[[ "$HERMES_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$HERMES_COMMIT" =~ ^[0-9a-f]{40}$ && "$HERMES_TAG" =~ ^[0-9a-f]{40}$ ]] ||
    { printf '%s\n' 'Invalid config/bootstrap/hermes-version.env' >&2; exit 1; }
: "${HERMES_BUILD_WORK:?Set HERMES_BUILD_WORK to a new build directory}"
[[ ! -e "$HERMES_BUILD_WORK" ]] || { printf '%s\n' 'Build directory already exists' >&2; exit 1; }
[[ ! -e app/hermes-src && ! -e runtime ]] || { printf '%s\n' 'Runtime output already exists; use a clean checkout' >&2; exit 1; }
for tool in git node uv python3 tar sha256sum; do
    command -v "$tool" >/dev/null || { printf 'Missing command: %s\n' "$tool" >&2; exit 1; }
done
NODE=$(command -v node)
[[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 26 ]] || { printf '%s\n' 'Node >= 26 required' >&2; exit 1; }
mkdir -p -- "$HERMES_BUILD_WORK"
WORK=$(cd -- "$HERMES_BUILD_WORK" && pwd -P)
mkdir -p -- "$WORK/home" "$WORK/cache" "$WORK/tmp"
export HOME="$WORK/home" XDG_CACHE_HOME="$WORK/cache" UV_CACHE_DIR="$WORK/cache/uv" TMPDIR="$WORK/tmp"
export npm_config_cache="$WORK/cache/npm" PYTHONDONTWRITEBYTECODE=1
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 NODE_ENV=production
SRC="$WORK/upstream"
git clone --depth 1 --single-branch --branch "$HERMES_VERSION" https://github.com/NousResearch/hermes-agent.git "$SRC"
[[ "$(git -C "$SRC" rev-parse HEAD)" == "$HERMES_COMMIT" ]] || { printf '%s\n' 'Official source commit mismatch' >&2; exit 1; }
[[ "$(git -C "$SRC" rev-parse "refs/tags/$HERMES_VERSION")" == "$HERMES_TAG" ]] || { printf '%s\n' 'Official tag object mismatch' >&2; exit 1; }
# 0.23.1 起官方前端依赖改用 pnpm，版本和各平台 SHA256 固定在 pm/lock.json。
# 照上游 pm 的布局：原生可执行包 + 同版本 JS 包里的 dist/（内置 node-gyp）。
if python3 -c 'import json,sys; sys.exit(0 if "pnpm" in json.load(open(sys.argv[1]))["packages"] else 1)' "$SRC/pm/lock.json"; then
    PNPM_DIR="$WORK/pnpm"
    python3 - "$SRC/pm/lock.json" "$PNPM_DIR" "$(uname -m)" <<'PY'
import hashlib, json, shutil, subprocess, sys, tarfile
from pathlib import Path
lock, out, machine = sys.argv[1], Path(sys.argv[2]), sys.argv[3]
target = {"x86_64": "linux-x64", "aarch64": "linux-arm64"}[machine]
exe, launcher = json.load(open(lock))["packages"]["pnpm"]["artifacts"][target]
out.mkdir()
for index, artifact in enumerate((exe, launcher)):
    archive = out.parent / f"pnpm-{index}.tgz"
    subprocess.run(["curl", "--fail", "--silent", "--show-error", "--location", "--output", str(archive), artifact["url"]], check=True)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != artifact["sha256"]:
        raise SystemExit(f"pnpm artifact SHA256 mismatch: {artifact['url']}")
    stage = out.parent / f"pnpm-{index}"
    with tarfile.open(archive) as tar:
        tar.extractall(stage, filter="data")
    package = stage / "package"
    if index == 0:
        for item in package.iterdir():
            item.rename(out / item.name)
    else:
        (package / "dist").rename(out / "dist")
    shutil.rmtree(stage)
    archive.unlink()
PY
    export PATH="$PNPM_DIR:$PATH"
    pnpm --version
fi
uv venv --python "${HERMES_BUILD_PYTHON:-3.14}" "$WORK/icons-venv"
uv pip install --python "$WORK/icons-venv/bin/python" --no-deps Pillow==13.0.0 resvg-py==0.5.0
(cd -- "$SRC" && "$NODE" apps/desktop/scripts/build-webapp.mjs)
"$NODE" "$SRC/scripts/build/node-deps.mjs" --source "$SRC" --workspace web
"$WORK/icons-venv/bin/python" "$SRC/scripts/generate_icons.py" --source "$SRC" --out "$WORK/icons"
(cd -- "$SRC" && "$NODE" scripts/build/web.mjs --source "$SRC" --icons "$WORK/icons" --out "$SRC/hermes_cli/web_dist")
python3 -B scripts/prepare-runtime.py --source "$SRC" --node "$NODE" --prepared-icons "$WORK/icons/web/public"
mkdir -p runtime/tui
ARCHIVE="hermes-src-$HERMES_VERSION-${HERMES_COMMIT:0:12}.tar.gz"
tar -C app --sort=name --owner=0 --group=0 --numeric-owner --mtime='2026-11-09 00:00:00' -czf "runtime/$ARCHIVE" hermes-src
(cd runtime && sha256sum "$ARCHIVE" > "$ARCHIVE.sha256")
bash scripts/build-tui.sh
TUI="tui/hermes-tui-$HERMES_VERSION-${HERMES_COMMIT:0:12}.tar.gz"
# build.sh 以这份记录为准校验源码包、TUI，并写入安装包的内核版本。
printf 'HERMES_VERSION=%s\nHERMES_COMMIT=%s\nHERMES_TAG=%s\nHERMES_SRC_ARCHIVE=%s\nHERMES_SRC_SHA256=%s\nHERMES_TUI_ARCHIVE=%s\nHERMES_TUI_SHA256=%s\n' \
    "$HERMES_VERSION" "$HERMES_COMMIT" "$HERMES_TAG" "$ARCHIVE" "$(cut -d ' ' -f 1 "runtime/$ARCHIVE.sha256")" \
    "$TUI" "$(cut -d ' ' -f 1 "runtime/$TUI.sha256")" > runtime/hermes-version.env
if [[ "${HERMES_SKIP_TEST_ENV:-0}" != 1 ]]; then
    uv sync --locked --no-dev --project "$SRC" --python "${HERMES_BUILD_PYTHON:-3.14}"
    uv pip install --python "$SRC/.venv/bin/python" --no-deps PyYAML==6.0.3
fi
if [[ -n "${GITHUB_ENV:-}" ]]; then
    printf 'HERMES_TEST_SOURCE_ROOT=%s\nKERNEL_CLI_OFFICIAL_SOURCE=%s\nFRESHNESS_TEST_SOURCE=%s\nHERMES_TEST_NODE=%s\nFRESHNESS_TEST_NODE=%s\nHERMES_TEST_PYTHON=%s\n' \
        "$SRC" "$SRC" "$SRC" "$NODE" "$NODE" "$SRC/.venv/bin/python" >> "$GITHUB_ENV"
fi
printf 'Runtime assets ready: runtime/%s and runtime/tui/hermes-tui-%s-%s.tar.gz\n' "$ARCHIVE" "$HERMES_VERSION" "${HERMES_COMMIT:0:12}"
