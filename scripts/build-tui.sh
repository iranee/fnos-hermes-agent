#!/bin/bash
# =============================================================================
# build-tui.sh — 从 runtime/hermes-src-*.tar.gz 预编译 Hermes TUI，产出
#   runtime/tui/hermes-tui-v<ver>-<commit>.tar.gz(.sha256)
# Dashboard「对话」页通过 hermes --tui 启动它。包内预编译后 NAS 上无需 npm/联网。
#
# 要求: PATH 中为 Node 26（上游 package.json engines），npm 版本满足其 engines 约束。
#       npm 下载依赖时遵守 https_proxy。
# 用法: scripts/build-tui.sh            # 自动匹配 runtime/ 下唯一的源码包
# =============================================================================
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
RUNTIME_DIR="$ROOT/runtime"
info() { printf '\033[0;32m[INFO]\033[0m %s\n' "$*"; }
die()  { printf '\033[0;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

shopt -s nullglob
ARCHIVES=("$RUNTIME_DIR"/hermes-src-*.tar.gz)
shopt -u nullglob
[[ ${#ARCHIVES[@]} -eq 1 ]] || die "runtime/ 下应恰有一个 hermes-src-*.tar.gz（当前 ${#ARCHIVES[@]} 个）"
ARCHIVE="${ARCHIVES[0]}"
SRC_TAG=$(basename -- "$ARCHIVE" .tar.gz); SRC_TAG="${SRC_TAG#hermes-src-}"
OUT_DIR="$RUNTIME_DIR/tui"
OUT="$OUT_DIR/hermes-tui-$SRC_TAG.tar.gz"

command -v node >/dev/null || die "PATH 中没有 node"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[[ "$NODE_MAJOR" -ge 26 ]] || die "需要 Node >= 26（当前 $(node --version)）"

WORK=$(mktemp -d)
trap 'rm -rf -- "$WORK"' EXIT
tar -xzf "$ARCHIVE" -C "$WORK"
SRC="$WORK/hermes-src"
[[ -f "$SRC/scripts/build/tui.mjs" && -f "$SRC/ui-tui/src/entry.tsx" ]] || die "源码包内缺少 TUI 构建脚本或源码"

info "安装 ui-tui 依赖（npm ci）"
(cd -- "$SRC" && node scripts/build/node-deps.mjs --source "$SRC" --workspace ui-tui)
info "编译 TUI"
(cd -- "$SRC" && node scripts/build/tui.mjs --source "$SRC" --out "$WORK/product")
[[ -f "$WORK/product/dist/entry.js" && -f "$WORK/product/dist/scripts/gateway_bootstrap.py" ]] || die "TUI 编译产物不完整"

mv -- "$WORK/product" "$WORK/tui"
rm -f -- "$WORK/tui/.hermes-product"
mkdir -p -- "$OUT_DIR"
tar -C "$WORK" --owner=0 --group=0 --numeric-owner --sort=name --mtime='2026-11-09 00:00:00' -czf "$OUT" tui
(cd -- "$OUT_DIR" && sha256sum "$(basename -- "$OUT")" > "$(basename -- "$OUT").sha256")
info "已生成: $OUT"
info "SHA256: $(cut -d ' ' -f 1 -- "$OUT.sha256")"
