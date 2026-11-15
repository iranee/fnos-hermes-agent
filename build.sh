#!/bin/bash
# =============================================================================
# build.sh — 在 Linux（含 WSL）上打包 fnOS Hermes Agent 在线安装版的 .fpk
# =============================================================================
#
# 用法:  ./build.sh                 # 版本号自动 +1 后打包
#        ./build.sh --no-bump       # 沿用 manifest 当前版本号
#        ./build.sh --version 0.23.1-022   # 换内核版本时必须指定
#        ./build.sh --check-only    # 校验源码/TUI、私有库/许可与 fnos-cli Skill，不写版本、不打包
#        ./build.sh --arch x86_64,aarch64   # 同时出 x86 与 ARM 两个包（GitHub 发布用），本地默认只打 x86_64
#
# 输出: dist/fnos-<app>_v<版本>_x86_64.fpk（platform=x86），带 aarch64 时另出 dist/fnos-<app>_v<版本>_arm64.fpk（platform=arm），
#   各带对应架构的私有 libatomic。不出 platform=all 混合包。
#
# 版本号规则: <内核版本>-<序号>，从 102 起每次打包 +1，不按日期重置。
#   例: 0.23.0-122 → 0.23.0-123；换内核到 0.23.1 后手动指定 0.23.1-022，再往后自动 +1。
#
# 在线安装版：包内不带 Python、uv 和依赖 wheel，这些由安装/升级钩子在设备上
#   从国内镜像下载（CPython: npmmirror，uv: 阿里云/清华 PyPI，依赖: 阿里云 PyPI，
#   哈希来自 uv.lock），面板 Node/npm 从 fnOS 官方 Node.js 26 或更新版本应用复制，不联网下载。
#   包内带固定 Debian bookworm libatomic1（amd64 / arm64）私有库，仅供应用子进程使用，不安装到系统。
#
# 打包前按 runtime/hermes-version.env 校验 runtime/ 下的本地资产（都由 scripts/build-hermes.sh 构建，无法自动下载）:
#   runtime/hermes-version.env  内核版本、提交、标签对象，以及下面两个文件名和 SHA256
#   runtime/hermes-src-v<ver>-<commit>.tar.gz(.sha256)  Hermes 内核源码
#   runtime/tui/hermes-tui-v<ver>-<commit>.tar.gz(.sha256)  预编译 TUI
# 打包时把该内核版本写回 config/bootstrap/hermes-version.env，安装包与源码固定版本保持一致。
# 私有库与版权包固定 URL/SHA256/大小，缺失时下载到 runtime/，缓存损坏时中止且不覆盖。GPL 正文使用 config/licenses/ 本地文件。
# 另外每次都联网核对 config/prompts/skills/fnos 是否为 fnnas-labs/fnos-cli-skill 最新 Release 且内容一致。
#
# 环境变量（可选）:
#   FPK_ARCHES      逗号分隔的目标架构，默认 x86_64（同 --arch，amd64/arm64 为别名）
#   SKIP_SKILL_CHECK=1  GitHub 不可达时跳过 fnos-cli Skill 最新性校验（版本落后/内容不符仍会中止）
# =============================================================================
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
RUNTIME_DIR="$ROOT/runtime"
DIST_DIR="$ROOT/dist"

FNPACK_VERSION=1.2.3
# 每个包只含一种架构的私有 ELF，所以按架构分别出包，不标为 platform=all。
ARCH_SPEC="${FPK_ARCHES:-x86_64}"
ARCHES=()

info()  { printf '\033[0;32m[INFO]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
die()   { printf '\033[0;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }
step()  { printf '\n\033[1;34m== %s ==\033[0m\n' "$*"; }

BUMP=1
VERSION_OVERRIDE=""
CHECK_ONLY=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-bump) BUMP=0; shift ;;
        --version) VERSION_OVERRIDE="${2:?--version 需要参数}"; BUMP=0; shift 2 ;;
        --version=*) VERSION_OVERRIDE="${1#*=}"; BUMP=0; shift ;;
        --check-only) CHECK_ONLY=1; shift ;;
        --arch) ARCH_SPEC="${2:?--arch 需要参数：x86_64 或 aarch64}"; shift 2 ;;
        --arch=*) ARCH_SPEC="${1#*=}"; shift ;;
        -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
        *) die "未知参数: $1" ;;
    esac
done

# 在下载、版本写入之前拒绝不支持的目标，包括 all/both 混合包。
IFS=', ' read -r -a _arch_in <<< "$ARCH_SPEC"
for a in "${_arch_in[@]}"; do
    [[ -n "$a" ]] || continue
    case "$a" in
        x86_64|amd64) a=x86_64 ;;
        aarch64|arm64) a=aarch64 ;;
        *) die "不支持的目标架构: $a；只支持 x86_64(amd64) 与 aarch64(arm64)，不出 platform=all 混合包" ;;
    esac
    [[ " ${ARCHES[*]} " == *" $a "* ]] || ARCHES+=("$a")
done
[[ ${#ARCHES[@]} -gt 0 ]] || die "--arch / FPK_ARCHES 未给出任何有效架构"

[[ "$(uname -s)" == Linux ]] || die "本脚本只能在 Linux（或 WSL）里运行，不要在 Windows 下打包"
for tool in curl tar sha256sum cut sed date mktemp cmp find diff dpkg-deb stat od tr ln python3; do
    command -v "$tool" >/dev/null || die "缺少命令: $tool"
done
HOST_ARCH=$(uname -m)
case "$HOST_ARCH" in x86_64|aarch64) ;; *) die "不支持的构建主机架构: $HOST_ARCH" ;; esac
info "目标架构: ${ARCHES[*]}（每个架构单独出包，各带对应架构私有 libatomic）"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/hermes-fpk-build.XXXXXX")
CACHE_WORK=""
cleanup() { rm -rf -- "$WORK"; if [[ -n "$CACHE_WORK" ]]; then rm -rf -- "$CACHE_WORK"; fi; }
trap cleanup EXIT

sha256_of() { sha256sum -- "$1" | cut -d ' ' -f 1; }

# verify_sha256 <文件> <期望哈希>。文件不存在或不匹配返回 1
verify_sha256() {
    [[ -f "$1" ]] || return 1
    [[ "$(sha256_of "$1")" == "$2" ]]
}

# download <URL> <目标文件>
download() {
    local url="$1" dest="$2" tmp="$2.part"
    info "下载 $url"
    if curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
        --connect-timeout 15 --max-time 900 --retry 3 --retry-delay 2 --output "$tmp" "$url"; then
        mv -f -- "$tmp" "$dest"
        return 0
    fi
    rm -f -- "$tmp"
    return 1
}

# Fixed hashes/sizes from Debian bookworm main/binary-{amd64,arm64}/Packages.xz,
# checked against the official HTTPS InRelease index; no apt install or maintainer scripts.
NATIVE_VERSION=12.2.0-14+deb12u1
NATIVE_BASE=https://deb.debian.org/debian/pool/main/g/gcc-12
GPL3_SHA256=3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986

# arch_vars <x86_64|aarch64>：设置该架构的 deb、ELF 机器码、包内库目录（与 Node process.arch 同名）和 manifest platform。
arch_vars() {
    case "$1" in
        x86_64)
            DEB_ARCH=amd64; LIB_TRIPLET=x86_64-linux-gnu; ELF_MACHINE=3e00; LIB_SUBDIR=x64; MANIFEST_PLATFORM=x86
            LIBATOMIC_SHA256=fbd4e154a6b444229ea002cc209df099209c0adc09102e5fd21239a3d2b55e2d; LIBATOMIC_SIZE=9376
            GCC_BASE_SHA256=1896a2aacf4ad681ff5eacc24a5b0ca4d5d9c9b9c9e4b6de5197bc1e116ea619; GCC_BASE_SIZE=37596 ;;
        aarch64)
            DEB_ARCH=arm64; LIB_TRIPLET=aarch64-linux-gnu; ELF_MACHINE=b700; LIB_SUBDIR=arm64; MANIFEST_PLATFORM=arm
            LIBATOMIC_SHA256=1693aa13ce2b30d061a519fc28b77b9bab8c8e45804ced5969d99821e1bc2159; LIBATOMIC_SIZE=9568
            GCC_BASE_SHA256=674cf6cba6d432bd200c45fe866c1652c7a53523cc2e7a613e05bc4abf7b5440; GCC_BASE_SIZE=37624 ;;
        *) die "内部错误：未知架构 $1" ;;
    esac
    LIBATOMIC_DEB="libatomic1_${NATIVE_VERSION}_${DEB_ARCH}.deb"
    GCC_BASE_DEB="gcc-12-base_${NATIVE_VERSION}_${DEB_ARCH}.deb"
}
# 文件名后缀：x86 包用 _x86_64，ARM 包用 _arm64。
# 120–122 的客户端只认 _amd64/_arm64，会把 _x86_64 当作无后缀通用包，x86 设备仍拿到正确的包。
fpk_name() {
    arch_vars "$1"
    local suffix=$DEB_ARCH
    [[ "$suffix" != amd64 ]] || suffix=x86_64
    printf 'fnos-%s_v%s_%s.fpk' "$APP_NAME" "$VERSION" "$suffix"
}

verify_native_asset() {
    [[ ! -L "$1" && -f "$1" ]] && [[ "$(stat -c %s -- "$1")" == "$3" ]] && verify_sha256 "$1" "$2"
}
cache_native_asset() {
    local name="$1" url="$2" digest="$3" size="$4" dest="$RUNTIME_DIR/$1"
    [[ -d "$RUNTIME_DIR" && ! -L "$RUNTIME_DIR" ]] || die "runtime/ 必须为真实目录"
    if [[ -e "$dest" || -L "$dest" ]]; then
        verify_native_asset "$dest" "$digest" "$size" || die "私有库/许可缓存校验失败，不覆盖现有文件，请检查并移走后重试: $dest"
    else
        [[ -n "$CACHE_WORK" ]] || CACHE_WORK=$(mktemp -d "$RUNTIME_DIR/.native-cache.XXXXXX")
        download "$url" "$CACHE_WORK/$name" || die "私有库/许可下载失败: $url"
        verify_native_asset "$CACHE_WORK/$name" "$digest" "$size" || die "私有库/许可下载 SHA256 或大小不匹配: $name"
        # Same-filesystem atomic publication, refusing files/links created by another writer.
        ln -T -- "$CACHE_WORK/$name" "$dest" || die "缓存路径已被占用，不覆盖: $dest"
    fi
    info "私有库/许可缓存校验通过: $name"
}
# prepare_private_libatomic <arch>：产出 $WORK/private-lib-<arch>/{<LIB_SUBDIR>/libatomic.so.1,licenses/libatomic1/*}
prepare_private_libatomic() {
    arch_vars "$1"
    local gpl="$ROOT/config/licenses/GPL-3.0.txt"
    verify_native_asset "$gpl" "$GPL3_SHA256" 35149 || die "缺少或损坏的 GPL 许可正文: $gpl"
    cache_native_asset "$LIBATOMIC_DEB" "$NATIVE_BASE/$LIBATOMIC_DEB" "$LIBATOMIC_SHA256" "$LIBATOMIC_SIZE"
    cache_native_asset "$GCC_BASE_DEB" "$NATIVE_BASE/$GCC_BASE_DEB" "$GCC_BASE_SHA256" "$GCC_BASE_SIZE"
    local unpack="$WORK/libatomic-deb-$1" base="$WORK/gcc-base-deb-$1" out="$WORK/private-lib-$1"
    local copyright="$base/usr/share/doc/gcc-12-base/copyright"
    dpkg-deb --extract "$RUNTIME_DIR/$LIBATOMIC_DEB" "$unpack"
    dpkg-deb --extract "$RUNTIME_DIR/$GCC_BASE_DEB" "$base"
    local library="$unpack/usr/lib/$LIB_TRIPLET/libatomic.so.1.2.0" dir header
    for dir in "$unpack/usr" "$unpack/usr/lib" "$unpack/usr/lib/$LIB_TRIPLET"; do
        [[ -d "$dir" && ! -L "$dir" ]] || die "私有库目录不合法: $dir"
    done
    [[ -f "$library" && ! -L "$library" ]] || die "私有库必须为 regular ELF 文件"
    header=$(od -An -tx1 -N20 -- "$library" | tr -d ' \n')
    [[ "${header:0:14}" == 7f454c46020101 && "${header:32:8}" == "0300$ELF_MACHINE" ]] || die "私有库不是 Linux $1 ELF shared object"
    [[ -f "$copyright" && ! -L "$copyright" ]] || die "缺少 gcc-12-base 版权正文"
    grep -qF 'GCC RUNTIME LIBRARY EXCEPTION' "$copyright" || die "缺少 GCC Runtime Library Exception"
    grep -qF 'Version 3.1, 31 March 2009' "$copyright" || die "GCC runtime exception 版本不符"
    mkdir -p -- "$out/$LIB_SUBDIR" "$out/licenses/libatomic1"
    # Deliberately copy the real ELF, not Debian's libatomic.so.1 symlink.
    cp -- "$library" "$out/$LIB_SUBDIR/libatomic.so.1"
    cp -- "$copyright" "$out/licenses/libatomic1/copyright"
    cp -- "$gpl" "$out/licenses/libatomic1/GPL-3.0.txt"
    printf 'libatomic1 / gcc-12-base %s %s\n%s/%s\nSHA256: %s\n%s/%s\nSHA256: %s\n' \
        "$NATIVE_VERSION" "$DEB_ARCH" "$NATIVE_BASE" "$LIBATOMIC_DEB" "$LIBATOMIC_SHA256" \
        "$NATIVE_BASE" "$GCC_BASE_DEB" "$GCC_BASE_SHA256" > "$out/licenses/libatomic1/origin.txt"
}

manifest_get() { sed -n "s/^$1[[:space:]]*=[[:space:]]*//p" "$ROOT/manifest" | head -1 | tr -d '\r"'; }

# -----------------------------------------------------------------------------
step "1. 读取 manifest 与内核版本"
# -----------------------------------------------------------------------------
APP_NAME=$(manifest_get appname)
CURRENT_VERSION=$(manifest_get version)
[[ -n "$APP_NAME" && -n "$CURRENT_VERSION" ]] || die "manifest 缺少 appname 或 version"
# 内核版本以 runtime/hermes-version.env 为准（scripts/build-hermes.sh 或 ci-runtime.sh 生成），
# 打包时再写回 config/bootstrap/hermes-version.env。
RUNTIME_PIN="$RUNTIME_DIR/hermes-version.env"
CONFIG_PIN="$ROOT/config/bootstrap/hermes-version.env"
[[ -f "$RUNTIME_PIN" && ! -L "$RUNTIME_PIN" ]] || die "缺少 runtime/hermes-version.env。
       请先运行 scripts/build-hermes.sh 构建 Hermes 运行时；runtime/ 里已有校验过的资产时可用 scripts/build-hermes.sh --record 补写。"
pin_get() { sed -n "s/^$1=//p" "$2" | head -1 | tr -d '\r'; }
HERMES_VERSION=$(pin_get HERMES_VERSION "$RUNTIME_PIN")
HERMES_COMMIT=$(pin_get HERMES_COMMIT "$RUNTIME_PIN")
HERMES_TAG=$(pin_get HERMES_TAG "$RUNTIME_PIN")
HERMES_SRC_ARCHIVE=$(pin_get HERMES_SRC_ARCHIVE "$RUNTIME_PIN")
HERMES_SRC_SHA256=$(pin_get HERMES_SRC_SHA256 "$RUNTIME_PIN")
HERMES_TUI_ARCHIVE=$(pin_get HERMES_TUI_ARCHIVE "$RUNTIME_PIN")
HERMES_TUI_SHA256=$(pin_get HERMES_TUI_SHA256 "$RUNTIME_PIN")
[[ "$HERMES_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$HERMES_COMMIT" =~ ^[0-9a-f]{40}$ && "$HERMES_TAG" =~ ^[0-9a-f]{40}$
   && "$HERMES_SRC_SHA256" =~ ^[0-9a-f]{64}$ && "$HERMES_TUI_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
    die "runtime/hermes-version.env 内容不完整或格式错误"
SRC_TAG="${HERMES_SRC_ARCHIVE#hermes-src-}"; SRC_TAG="${SRC_TAG%.tar.gz}"
[[ "$HERMES_SRC_ARCHIVE" == "hermes-src-$HERMES_VERSION-"*.tar.gz && "$SRC_TAG" =~ ^v[0-9.]+-[A-Za-z0-9]+$
   && "$HERMES_TUI_ARCHIVE" == "tui/hermes-tui-$SRC_TAG.tar.gz" ]] ||
    die "runtime/hermes-version.env 记录的源码包或 TUI 文件名不合法"
# prepare-runtime.py 据此确定内核身份，build-fpk.py 校验源码包回执时与之比对。
export HERMES_VERSION_FILE="$RUNTIME_PIN"
CORE_VERSION="${HERMES_VERSION#v}"
CONFIG_CORE=$(pin_get HERMES_VERSION "$CONFIG_PIN" 2>/dev/null || true)
CONFIG_COMMIT=$(pin_get HERMES_COMMIT "$CONFIG_PIN" 2>/dev/null || true)
if [[ "$CONFIG_CORE" != "$HERMES_VERSION" || "$CONFIG_COMMIT" != "$HERMES_COMMIT" ]]; then
    warn "内核切换：config/bootstrap 固定为 ${CONFIG_CORE:-无} (${CONFIG_COMMIT:0:12})，runtime/ 为 $HERMES_VERSION (${HERMES_COMMIT:0:12})；打包时会改写 config/bootstrap/hermes-version.env"
fi
[[ -n "$VERSION_OVERRIDE" || "${CURRENT_VERSION%%-*}" == "$CORE_VERSION" ]] ||
    die "manifest 版本 $CURRENT_VERSION 与内核 $HERMES_VERSION 不一致（换内核时请用 --version 指定新版本号）"
info "应用: $APP_NAME  当前版本: $CURRENT_VERSION  内核: $HERMES_VERSION (${HERMES_COMMIT:0:12})"

# -----------------------------------------------------------------------------
step "2. 计算本次打包版本号"
# -----------------------------------------------------------------------------
TODAY_ISO=$(date +%F)
if [[ -n "$VERSION_OVERRIDE" ]]; then
    VERSION="$VERSION_OVERRIDE"
    [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[0-9]+$ ]] || die "版本号格式应为 x.y.z-N: $VERSION"
    [[ "${VERSION%%-*}" == "$CORE_VERSION" ]] || die "指定版本 $VERSION 与内核 $HERMES_VERSION 不一致"
elif [[ "$BUMP" == 1 ]]; then
    [[ "$CURRENT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[0-9]+$ ]] || die "版本号格式应为 x.y.z-N: $CURRENT_VERSION"
    SUFFIX="${CURRENT_VERSION##*-}"
    SERIAL=$(printf '%0*d' "${#SUFFIX}" $(( 10#$SUFFIX + 1 )))
    VERSION="$CORE_VERSION-$SERIAL"
else
    VERSION="$CURRENT_VERSION"
fi
info "本次版本: $VERSION"
if [[ "$CHECK_ONLY" != 1 ]]; then
    for a in "${ARCHES[@]}"; do
        name=$(fpk_name "$a")
        [[ ! -e "$DIST_DIR/$name" && ! -e "$DIST_DIR/$name.sha256" ]] || die "安装包已存在，不覆盖旧包：$name"
    done
fi

# -----------------------------------------------------------------------------
step "3. 准备 fnpack $FNPACK_VERSION"
# -----------------------------------------------------------------------------
FNPACK="${FNPACK_BIN:-$ROOT/fnpack}"
if [[ "$CHECK_ONLY" != 1 ]]; then
    case "$HOST_ARCH" in
        x86_64) FNPACK_ARCH=amd64; FNPACK_DIGEST=54b97fa7b70968c4d05c79840f5daeff508957d0bb2062fdb0376d00d9615c93 ;;
        aarch64) FNPACK_ARCH=arm64; FNPACK_DIGEST="${FNPACK_SHA256:?ARM 构建主机需要可信 FNPACK_SHA256}" ;;
    esac
    [[ "$FNPACK_DIGEST" =~ ^[a-f0-9]{64}$ ]] || die "fnpack SHA256 格式错误"
    if [[ ! -e "$FNPACK" && ! -L "$FNPACK" ]]; then
        [[ -z "${FNPACK_BIN:-}" ]] || die "FNPACK_BIN 必须指向已有工具"
        download "https://static2.fnnas.com/fnpack/fnpack-$FNPACK_VERSION-linux-$FNPACK_ARCH" "$WORK/fnpack" || die "fnpack 下载失败"
        verify_sha256 "$WORK/fnpack" "$FNPACK_DIGEST" || die "fnpack SHA256 不匹配"
        chmod 755 -- "$WORK/fnpack"
        FNPACK="$WORK/fnpack"
    fi
    [[ -f "$FNPACK" && ! -L "$FNPACK" ]] && verify_sha256 "$FNPACK" "$FNPACK_DIGEST" || die "fnpack SHA256 不匹配或路径不合法"
    [[ -x "$FNPACK" ]] || die "fnpack 不可执行"
    info "fnpack: $FNPACK（$FNPACK_VERSION，SHA256 已校验）"
else
    info "仅校验模式：不下载或执行 fnpack"
fi

# -----------------------------------------------------------------------------
step "4. 校验 Hermes 源码压缩包"
# -----------------------------------------------------------------------------
# check_recorded <文件> <记录的 SHA256>：文件、.sha256 与 runtime/hermes-version.env 三者一致
check_recorded() {
    [[ -f "$1" && ! -L "$1" ]] || die "缺少 $1（由 scripts/build-hermes.sh 构建，无法自动下载）"
    [[ -f "$1.sha256" ]] || die "缺少 $1.sha256"
    [[ "$(cut -d ' ' -f 1 -- "$1.sha256")" == "$2" ]] || die "$1.sha256 与 runtime/hermes-version.env 记录不一致"
    verify_sha256 "$1" "$2" || die "SHA256 不匹配: $1"
}
ARCHIVE="$RUNTIME_DIR/$HERMES_SRC_ARCHIVE"
check_recorded "$ARCHIVE" "$HERMES_SRC_SHA256"
info "源码包校验通过: $HERMES_SRC_ARCHIVE"
python3 -B - "$ROOT" "$ARCHIVE" "$WORK/src" <<'PY'
import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('build_fpk', Path(sys.argv[1]) / 'scripts/build-fpk.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
build.extract_runtime(Path(sys.argv[2]), Path(sys.argv[3]))
PY
SRC="$WORK/src/hermes-src"
[[ -f "$SRC/pyproject.toml" && -f "$SRC/uv.lock" && -f "$SRC/.fnos-runtime.json" ]] ||
    die "压缩包内缺少 hermes-src/pyproject.toml、uv.lock 或 .fnos-runtime.json"
LOCK_SHA256=$(sha256_of "$SRC/uv.lock")
info "uv.lock SHA256: $LOCK_SHA256"

# -----------------------------------------------------------------------------
step "4b. 校验预编译 TUI（与源码包同一提交）"
# -----------------------------------------------------------------------------
TUI_ARCHIVE="$RUNTIME_DIR/$HERMES_TUI_ARCHIVE"
check_recorded "$TUI_ARCHIVE" "$HERMES_TUI_SHA256"
mkdir -p -- "$WORK/tui"
python3 -B - "$TUI_ARCHIVE" "$WORK/tui" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    seen = set()
    for member in archive.getmembers():
        name = member.name.rstrip('/')
        if (name in seen or not (name == 'tui' or name.startswith('tui/'))
                or not (member.isfile() or member.isdir())):
            raise SystemExit('Invalid TUI archive entry')
        seen.add(name)
    archive.extractall(sys.argv[2], filter='data')
PY
[[ -f "$WORK/tui/tui/dist/entry.js" && -f "$WORK/tui/tui/dist/scripts/gateway_bootstrap.py" ]] ||
    die "TUI 压缩包内缺少 tui/dist/entry.js 或 tui/dist/scripts/gateway_bootstrap.py"
info "TUI 校验通过: $(basename -- "$TUI_ARCHIVE")"

# -----------------------------------------------------------------------------
step "4c. 校验各目标架构私有 libatomic 与许可资产"
# -----------------------------------------------------------------------------
for a in "${ARCHES[@]}"; do prepare_private_libatomic "$a"; done

# -----------------------------------------------------------------------------
step "4d. 校验 fnos-cli Skill 是否为上游最新 Release"
# -----------------------------------------------------------------------------
# config/prompts/skills/fnos 来自 fnnas-labs/fnos-cli-skill 的 Release 资产 fnos-skill.zip（其中的 fnos/ 目录）。
# 每次打包都取上游最新 tag 的 fnos-skill.zip 与本地目录逐文件比对，版本落后或内容不一致则中止。
SKILL_DIR="$ROOT/config/prompts/skills/fnos"
SKILL_REPO="fnnas-labs/fnos-cli-skill"
[[ -f "$SKILL_DIR/manifest.json" && -f "$SKILL_DIR/SKILL.md" ]] || die "缺少 $SKILL_DIR/manifest.json 或 SKILL.md"
SKILL_LOCAL_VERSION=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$SKILL_DIR/manifest.json" | head -1)
[[ -n "$SKILL_LOCAL_VERSION" ]] || die "无法从 $SKILL_DIR/manifest.json 读取 version"
SKILL_LATEST_URL=$(curl --silent --location --head --output /dev/null --write-out '%{url_effective}' \
    --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 60 \
    "https://github.com/$SKILL_REPO/releases/latest" || true)
SKILL_LATEST_TAG="${SKILL_LATEST_URL##*/releases/tag/}"
if [[ "$SKILL_LATEST_URL" != *"/releases/tag/"* || ! "$SKILL_LATEST_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]]; then
    if [[ "${SKIP_SKILL_CHECK:-0}" == 1 ]]; then
        warn "无法访问 GitHub 获取 $SKILL_REPO 最新 Release；SKIP_SKILL_CHECK=1，跳过校验（本地 Skill 为 $SKILL_LOCAL_VERSION）"
        SKILL_STATUS="fnos-cli Skill 未校验（GitHub 不可达，已按 SKIP_SKILL_CHECK=1 跳过）"
    else
        die "无法从 GitHub 获取 $SKILL_REPO 最新 Release（返回: ${SKILL_LATEST_URL:-空}）。
       请检查网络后重试；确需跳过可设 SKIP_SKILL_CHECK=1"
    fi
else
    [[ "v$SKILL_LOCAL_VERSION" == "$SKILL_LATEST_TAG" ]] ||
        die "config/prompts/skills/fnos 为 $SKILL_LOCAL_VERSION，上游最新 Release 为 $SKILL_LATEST_TAG。
       请下载 https://github.com/$SKILL_REPO/releases/download/$SKILL_LATEST_TAG/fnos-skill.zip，
       用其中的 fnos/ 目录整体替换 config/prompts/skills/fnos 后重新打包。"
    SKILL_ZIP="$WORK/fnos-skill.zip"
    download "https://github.com/$SKILL_REPO/releases/download/$SKILL_LATEST_TAG/fnos-skill.zip" "$SKILL_ZIP" ||
        die "下载 $SKILL_LATEST_TAG 的 fnos-skill.zip 失败"
    mkdir -p -- "$WORK/skill-upstream"
    if command -v unzip >/dev/null; then
        unzip -q -- "$SKILL_ZIP" -d "$WORK/skill-upstream"
    elif command -v python3 >/dev/null; then
        python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$SKILL_ZIP" "$WORK/skill-upstream"
    else
        die "解压 fnos-skill.zip 需要 unzip 或 python3"
    fi
    [[ -d "$WORK/skill-upstream/fnos" ]] || die "fnos-skill.zip 内没有 fnos/ 目录"
    if ! SKILL_DIFF=$(diff -rq -- "$WORK/skill-upstream/fnos" "$SKILL_DIR"); then
        die "config/prompts/skills/fnos 与上游 $SKILL_LATEST_TAG 的 fnos-skill.zip 内容不一致：
$SKILL_DIFF"
    fi
    info "fnos-cli Skill $SKILL_LOCAL_VERSION 为上游最新 Release（$SKILL_LATEST_TAG），内容与 fnos-skill.zip 逐文件一致"
    SKILL_STATUS="fnos-cli Skill $SKILL_LOCAL_VERSION 为上游最新"
fi

if [[ "$CHECK_ONLY" == 1 ]]; then
    info "仅校验模式：源码包、TUI、私有 libatomic 与许可校验通过，${SKILL_STATUS}，未写版本、未打包"
    exit 0
fi

# -----------------------------------------------------------------------------
step "5. 脚本静态检查"
# -----------------------------------------------------------------------------
for f in "$ROOT"/cmd/* "$ROOT"/config/bootstrap/install-runtime.sh; do
    [[ -f "$f" ]] || continue
    bash -n "$f" || die "语法错误: $f"
done
cmp -s "$ROOT/cmd/install_init" "$ROOT/cmd/upgrade_init" || die "cmd/install_init 与 cmd/upgrade_init 必须完全一致"
for f in "$ROOT/cmd/install_init" "$ROOT/cmd/upgrade_init"; do
    for token in 'pkill ' 'pgrep ' 'fuser ' 'rm -f ' '/vol1/' '"$APP_DIR/cmd/main"'; do
        ! grep -qF -- "$token" "$f" || die "$f 含禁止写法: $token"
    done
done
info "cmd/* 与 install-runtime.sh 语法检查通过；install_init/upgrade_init 一致且无禁止写法"

# -----------------------------------------------------------------------------
step "6. 写入版本号"
# -----------------------------------------------------------------------------
if [[ "$VERSION" != "$CURRENT_VERSION" ]]; then
    sed -i "s/^version[[:space:]]*=.*/version               = $VERSION/" "$ROOT/manifest"
fi
SERIAL_OUT="${VERSION##*-}"
[[ "$SERIAL_OUT" =~ ^[0-9]+$ ]] || SERIAL_OUT=0
# 构建时间保留用于与旧日期编号及 GitHub Release 比较新旧。
printf 'APP_VERSION=%s\nAPP_BUILD_DATE=%s\nAPP_BUILD_SERIAL=%s\nAPP_BUILD_TIME=%s\n' "$VERSION" "$TODAY_ISO" "$SERIAL_OUT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$ROOT/config/bootstrap/app-version.env"
[[ "$(manifest_get version)" == "$VERSION" ]] || die "manifest 版本写入失败"
info "manifest 与 app-version.env 已写为 $VERSION"
CONFIG_PIN_TEXT=$(printf 'HERMES_VERSION=%s\nHERMES_COMMIT=%s\nHERMES_TAG=%s' "$HERMES_VERSION" "$HERMES_COMMIT" "$HERMES_TAG")
if [[ "$(cat -- "$CONFIG_PIN" 2>/dev/null || true)" != "$CONFIG_PIN_TEXT" ]]; then
    printf '%s\n' "$CONFIG_PIN_TEXT" > "$CONFIG_PIN.new"
    mv -f -- "$CONFIG_PIN.new" "$CONFIG_PIN"
    info "config/bootstrap/hermes-version.env 已写为 $HERMES_VERSION (${HERMES_COMMIT:0:12})"
fi

# -----------------------------------------------------------------------------
step "7. 组装打包目录"
# -----------------------------------------------------------------------------
STAGE="$WORK/stage"
mkdir -p -- "$STAGE/app/config" "$STAGE/config"
copy_dir() {
    [[ -d "$1" ]] || die "缺少目录: $1"
    mkdir -p -- "$2"
    tar -C "$1" --exclude=node_modules --exclude=__pycache__ --exclude=.pytest_cache --exclude='*.pyc' \
        --exclude='*.test.js' --exclude='*.test.mjs' --exclude='*.test.py' --exclude='test_*.py' --exclude='tests' --exclude='*.bak' \
        --exclude='kernel-bootstrap-fixture.py' --exclude='*.new' --exclude='*.orig' --exclude='.DS_Store' \
        --exclude=.git --exclude=.env --exclude='.env.*' --exclude='.venv' --exclude='venv' --exclude='*.log' \
        -cf - . | tar -C "$2" -xf -
}
for f in manifest ICON.PNG ICON_256.PNG; do cp -- "$ROOT/$f" "$STAGE/$f"; done
for f in privilege resource; do cp -- "$ROOT/config/$f" "$STAGE/config/$f"; done
copy_dir "$ROOT/cmd"              "$STAGE/cmd"
copy_dir "$ROOT/wizard"           "$STAGE/wizard"
copy_dir "$ROOT/app/bin"          "$STAGE/app/bin"
copy_dir "$ROOT/app/ui"           "$STAGE/app/ui"
copy_dir "$ROOT/app/server"       "$STAGE/app/server"
copy_dir "$ROOT/config/bootstrap" "$STAGE/app/config/bootstrap"
copy_dir "$ROOT/config/prompts"   "$STAGE/app/config/prompts"
cp -- "$ROOT/manifest" "$STAGE/app/manifest"
cp -- "$ROOT/LICENSE"  "$STAGE/app/LICENSE"
python3 -B - "$ROOT" "$STAGE" <<'PY'
import importlib.util, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('build_fpk', Path(sys.argv[1]) / 'scripts/build-fpk.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
stage = Path(sys.argv[2])
for name, path in build.walk_files(stage):
    path.chmod(0o755 if build.executable(name, path) else 0o644)
PY
mv -- "$SRC" "$STAGE/app/hermes-src"
mv -- "$WORK/tui/tui" "$STAGE/app/tui"

# 在线安装版不放 python/uv/wheels。若本地 config/bootstrap 下残留这些目录，也不能带进包里。
BOOT="$STAGE/app/config/bootstrap"
for leftover in python uv wheels; do
    [[ ! -e "$BOOT/$leftover" ]] || die "config/bootstrap/$leftover 不应出现在在线安装版中，请移走后重试"
done

chmod 755 -- "$STAGE"/cmd/* "$STAGE"/app/bin/*
grep -qx "APP_VERSION=$VERSION" "$BOOT/app-version.env" || die "打包目录内 app-version.env 版本不符"

# -----------------------------------------------------------------------------
step "8. 按架构 fnpack build 并输出到 dist/"
# -----------------------------------------------------------------------------
mkdir -p -- "$DIST_DIR"
BUILT=()
for a in "${ARCHES[@]}"; do
    arch_vars "$a"
    ARCH_STAGE="$WORK/stage-$a"
    cp -a -- "$STAGE" "$ARCH_STAGE"
    mv -- "$WORK/private-lib-$a" "$ARCH_STAGE/app/lib"
    # platform 跟随该包的私有 ELF 架构（fnOS 合法值 x86 / arm），源码 manifest 不改。
    for m in "$ARCH_STAGE/manifest" "$ARCH_STAGE/app/manifest"; do
        sed -i "s/^platform[[:space:]]*=.*/platform              = $MANIFEST_PLATFORM/" "$m"
        grep -qE "^platform[[:space:]]*=[[:space:]]*$MANIFEST_PLATFORM\$" "$m" || die "manifest platform 写入失败: $m"
    done
    find "$ARCH_STAGE" -type d -exec chmod 755 {} +
    if [[ -n "$(find "$ARCH_STAGE" -perm /022 -print -quit)" ]]; then
        die "临时打包文件系统未保留 Unix 权限；请将 TMPDIR 指向 Linux 文件系统"
    fi
    info "[$a] 打包目录大小: $(du -sh -- "$ARCH_STAGE" | cut -f1)（platform=$MANIFEST_PLATFORM，lib/$LIB_SUBDIR）"
    OUT="$WORK/out-$a"
    mkdir -p -- "$OUT"
    (cd -- "$OUT" && "$FNPACK" build --directory "$ARCH_STAGE") || die "[$a] fnpack 构建失败"
    RAW_FPK=$(find "$OUT" -maxdepth 1 -name '*.fpk' -print -quit)
    [[ -n "$RAW_FPK" ]] || die "[$a] fnpack 没有生成 .fpk"
    python3 -B - "$ROOT" "$RAW_FPK" "$ARCH_STAGE" "$WORK" <<'PY'
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('build_fpk', Path(sys.argv[1]) / 'scripts/build-fpk.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
print(json.dumps(build.verify_fpk(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]), stage_modes=True)))
PY
    FPK_NAME=$(fpk_name "$a")
    [[ ! -e "$DIST_DIR/$FPK_NAME" && ! -e "$DIST_DIR/$FPK_NAME.sha256" ]] || die "安装包或 SHA256 文件已存在，不覆盖：$FPK_NAME"
    ln -T -- "$RAW_FPK" "$DIST_DIR/$FPK_NAME" 2>/dev/null || {
        python3 -B - "$RAW_FPK" "$DIST_DIR/$FPK_NAME" <<'PY'
import shutil, sys
with open(sys.argv[1], 'rb') as source, open(sys.argv[2], 'xb') as target:
    shutil.copyfileobj(source, target)
PY
    }
    FPK_SHA=$(sha256_of "$DIST_DIR/$FPK_NAME")
    ( set -o noclobber; printf '%s  %s\n' "$FPK_SHA" "$FPK_NAME" > "$DIST_DIR/$FPK_NAME.sha256" )
    BUILT+=("$FPK_NAME|$MANIFEST_PLATFORM|$FPK_SHA")
    rm -rf -- "$ARCH_STAGE" "$OUT"
done

echo
info "=========================================="
info "  构建完成（版本 $VERSION，下次打包自动 +1）"
for entry in "${BUILT[@]}"; do
    IFS='|' read -r name platform digest <<< "$entry"
    info "  文件:   $DIST_DIR/$name（platform=$platform，$(du -h -- "$DIST_DIR/$name" | cut -f1)）"
    info "  SHA256: $digest"
done
info "=========================================="
