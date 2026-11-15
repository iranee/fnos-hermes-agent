#!/bin/bash
# =============================================================================
# build-hermes.sh — 选择 Hermes 官方正式版，在本机构建运行时资产并写入 runtime/hermes-version.env
# =============================================================================
#
# 用法:  bash scripts/build-hermes.sh                 # 列出官方正式版，选择后构建
#        bash scripts/build-hermes.sh --list          # 只列出官方正式版
#        bash scripts/build-hermes.sh --ref latest    # 构建 GitHub 标为 Latest 的正式版
#        bash scripts/build-hermes.sh --ref v0.23.1   # 构建指定正式版
#        bash scripts/build-hermes.sh --record        # runtime/ 已有资产时只补写 runtime/hermes-version.env
#        --force        runtime/ 已是所选版本时也重新构建
#        --allow-older  允许选择比 config/bootstrap 固定版本更旧的内核
#
# 只接受 GitHub Releases 中非草稿、非预发布、tag 为 vX.Y.Z 的正式版，并核对官方仓库的
# tag 对象与提交；不接受分支、提交、预发布，也排除 v2026.x.y 这类旧日期 tag。
#
# 构建在 $HOME 下的临时目录进行（调用 scripts/ci-runtime.sh），产物的 SHA256 和源码包回执
# 校验通过后才替换 runtime/。旧资产移到 runtime-backup-<旧版本>/，替换失败时自动还原。
# 之后 ./build.sh 按 runtime/hermes-version.env 校验并打包，换内核时用 --version <内核>-<序号>。
#
# 构建工具只在本机使用，不进安装包（安装包的 Node 由 fnOS 的 Node.js 26 应用提供）:
#   HERMES_BUILD_NODE  Node 26 或更新版本的 node 路径，默认找 PATH 和 ~/.nvm
#   HERMES_BUILD_UV    uv 路径，默认找 PATH
#   HERMES_BUILD_TMP   临时构建目录的上级目录，默认 $HOME，不能放在 /mnt/ 下
#   GITHUB_TOKEN       可选，读取 GitHub Releases 时避免匿名限流
# 另需 git、curl、python3、tar、sha256sum，并能访问 GitHub。
# =============================================================================
set -euo pipefail
umask 022

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
RUNTIME_DIR="$ROOT/runtime"
RUNTIME_PIN="$RUNTIME_DIR/hermes-version.env"
CONFIG_PIN="$ROOT/config/bootstrap/hermes-version.env"
UPSTREAM_GIT=https://github.com/NousResearch/hermes-agent.git
UPSTREAM_API=https://api.github.com/repos/NousResearch/hermes-agent

info() { printf '\033[0;32m[INFO]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[0;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

MODE=build REF="" FORCE=0 ALLOW_OLDER=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --list) MODE=list; shift ;;
        --record) MODE=record; shift ;;
        --ref) [[ $# -ge 2 && -n "$2" ]] || die "--ref 需要版本号，例如 --ref v0.23.1 或 --ref latest"; REF="$2"; shift 2 ;;
        --force) FORCE=1; shift ;;
        --allow-older) ALLOW_OLDER=1; shift ;;
        -h|--help) awk 'NR > 3 && /^# =+$/ {exit} NR > 3 {sub(/^# ?/, ""); print}' "$0"; exit 0 ;;
        *) die "未知参数: $1（用 --help 查看用法）" ;;
    esac
done
[[ "$MODE" != record || ( -z "$REF" && "$FORCE" == 0 ) ]] || die "--record 不能和 --ref、--force 一起用"
[[ "$(uname -s)" == Linux ]] || die "请在 Linux 或 WSL 中运行"
for tool in git curl python3 tar sha256sum; do
    command -v "$tool" >/dev/null || die "缺少命令: $tool"
done
export GIT_TERMINAL_PROMPT=0

WORK="" PUBLISHING=0 BACKUP=""
PLACED=() MOVED=()

pin_get() { [[ -f "$2" ]] || return 0; sed -n "s/^$1=//p" "$2" | head -1 | tr -d '\r'; }
sha_of() { sha256sum -- "$1" | cut -d ' ' -f 1; }
version_lt() { [[ "$1" != "$2" && "$(printf '%s\n%s\n' "${1#v}" "${2#v}" | sort -V | head -1)" == "${1#v}" ]]; }

rollback() {
    warn "替换 runtime/ 未完成，正在还原旧资产"
    local f
    for f in "${PLACED[@]}"; do rm -f -- "$RUNTIME_DIR/$f"; done
    rm -f -- "$RUNTIME_DIR"/*.part "$RUNTIME_DIR"/tui/*.part
    for f in "${MOVED[@]}"; do mv -f -- "$BACKUP/$f" "$RUNTIME_DIR/$f" || warn "还原失败，请手动从 $BACKUP 取回: $f"; done
    [[ -z "$BACKUP" ]] || rmdir -- "$BACKUP/tui" "$BACKUP" 2>/dev/null
    PUBLISHING=0
}
cleanup() {
    local status=$?
    set +e
    [[ "$PUBLISHING" != 1 ]] || rollback
    if [[ -n "$WORK" && -d "$WORK" ]]; then
        chmod -R u+w -- "$WORK" 2>/dev/null
        rm -rf -- "$WORK"
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

CONFIG_CORE=$(pin_get HERMES_VERSION "$CONFIG_PIN")
CONFIG_COMMIT=$(pin_get HERMES_COMMIT "$CONFIG_PIN")
CONFIG_TAG=$(pin_get HERMES_TAG "$CONFIG_PIN")
RUNTIME_CORE=$(pin_get HERMES_VERSION "$RUNTIME_PIN")
RUNTIME_COMMIT=$(pin_get HERMES_COMMIT "$RUNTIME_PIN")

TMP_PARENT="${HERMES_BUILD_TMP:-$HOME}"
[[ -d "$TMP_PARENT" ]] || die "临时目录的上级目录不存在: $TMP_PARENT"
TMP_PARENT=$(cd -- "$TMP_PARENT" && pwd -P)
[[ "$TMP_PARENT" != /mnt/* ]] || die "临时构建目录不能放在 /mnt/ 下（Windows 盘上 npm/uv 很慢且权限不对），请设置 HERMES_BUILD_TMP"
WORK=$(mktemp -d "$TMP_PARENT/.hermes-build.XXXXXX")

# ---- 官方正式版列表 --------------------------------------------------------------
gh_api() {
    local -a auth=()
    [[ -z "${GITHUB_TOKEN:-}" ]] || auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
    curl --proto =https --proto-redir =https --fail --silent --show-error --location --retry 2 \
        --connect-timeout 20 --max-time 120 -H 'Accept: application/vnd.github+json' "${auth[@]}" \
        --output "$2" "$1"
}
fetch_releases() {
    local dir="$WORK/releases"
    mkdir -p -- "$dir"
    git ls-remote --tags "$UPSTREAM_GIT" > "$dir/refs.txt" || die "无法读取官方仓库 tag: $UPSTREAM_GIT"
    gh_api "$UPSTREAM_API/releases?per_page=100" "$dir/releases.json" ||
        die "无法读取官方 GitHub Releases 列表（网络不通或被限流，可设置 GITHUB_TOKEN 后重试）"
    gh_api "$UPSTREAM_API/releases/latest" "$dir/latest.json" || printf '{}' > "$dir/latest.json"
    python3 -B - "$dir" > "$dir/official.tsv" <<'PY'
import json, re, sys
from pathlib import Path
d = Path(sys.argv[1])
refs = {}
for line in (d / 'refs.txt').read_text().splitlines():
    sha, _, ref = line.partition('\t')
    if ref.startswith('refs/tags/'):
        refs[ref[len('refs/tags/'):]] = sha
releases = json.loads((d / 'releases.json').read_text())
latest = json.loads((d / 'latest.json').read_text())
latest = latest.get('tag_name', '') if isinstance(latest, dict) else ''
if not isinstance(releases, list):
    raise SystemExit('GitHub Releases 返回格式异常')
rows = []
for release in releases:
    tag = release.get('tag_name') or ''
    match = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)', tag)
    # v2026.x.y 是上游早期按日期命名的旧版本，按语义版本排序会排到最前，必须排除。
    if not match or release.get('draft') or release.get('prerelease') or int(match[1]) >= 2000:
        continue
    tag_object, commit = refs.get(tag), refs.get(tag + '^{}')
    if not (tag_object and commit and re.fullmatch(r'[0-9a-f]{40}', tag_object) and re.fullmatch(r'[0-9a-f]{40}', commit)):
        continue
    rows.append((tuple(map(int, match.groups())), tag, commit, tag_object,
                 (release.get('published_at') or '-')[:10], '1' if tag == latest else '0'))
for row in sorted(rows, reverse=True):
    print('\t'.join(row[1:]))
PY
    mapfile -t ROWS < "$dir/official.tsv"
    [[ ${#ROWS[@]} -gt 0 ]] || die "没有找到可用的官方正式版"
}
row_marks() {
    local tag commit _tagobj _date latest marks=()
    IFS=$'\t' read -r tag commit _tagobj _date latest <<< "$1"
    [[ "$latest" != 1 ]] || marks+=("GitHub 最新正式版")
    [[ "$tag" != "$CONFIG_CORE" || "$commit" != "$CONFIG_COMMIT" ]] || marks+=("当前固定版本")
    [[ "$tag" != "$RUNTIME_CORE" || "$commit" != "$RUNTIME_COMMIT" ]] || marks+=("runtime/ 现有")
    local IFS='，'
    printf '%s' "${marks[*]}"
}
show_table() {
    local limit=$1 i tag commit _tagobj date _latest
    printf '  序号 版本       发布日期     提交           说明\n'
    for ((i = 0; i < ${#ROWS[@]} && i < limit; i++)); do
        IFS=$'\t' read -r tag commit _tagobj date _latest <<< "${ROWS[i]}"
        printf '  %-4s %-10s %-12s %-14s %s\n' "$((i + 1))" "$tag" "$date" "${commit:0:12}" "$(row_marks "${ROWS[i]}")"
    done
    [[ ${#ROWS[@]} -le limit ]] || printf '  …… 另有 %d 个更早的正式版，可用 --ref vX.Y.Z 指定\n' "$((${#ROWS[@]} - limit))"
}
select_tag() {
    local want=$1 row tag _rest latest
    for row in "${ROWS[@]}"; do
        IFS=$'\t' read -r tag _rest <<< "$row"
        latest="${row##*$'\t'}"
        if [[ "$tag" == "$want" || ( "$want" == latest && "$latest" == 1 ) ]]; then
            IFS=$'\t' read -r SEL_TAG SEL_COMMIT SEL_TAGOBJ SEL_DATE _rest <<< "$row"
            return 0
        fi
    done
    if [[ "$want" == latest ]]; then
        # 读不到 Latest 标记时，取版本号最高的正式版。
        IFS=$'\t' read -r SEL_TAG SEL_COMMIT SEL_TAGOBJ SEL_DATE _rest <<< "${ROWS[0]}"
        return 0
    fi
    die "$want 不是 Hermes 官方正式版。只接受 GitHub Releases 中的 vX.Y.Z 正式版，不接受分支、提交、预发布或 v2026.x.y 旧日期 tag（用 --list 查看）"
}

# ---- 资产校验 --------------------------------------------------------------------
# verify_assets <目录> <记录文件> <版本> <提交> <tag 对象>：身份、文件名、.sha256 与实际 SHA256 一致
verify_assets() {
    local dir=$1 pin=$2 tag=$3 commit=$4 tagobj=$5 key file digest
    [[ "$(pin_get HERMES_VERSION "$pin")" == "$tag" && "$(pin_get HERMES_COMMIT "$pin")" == "$commit"
       && "$(pin_get HERMES_TAG "$pin")" == "$tagobj" ]] || { warn "$pin 记录的内核身份与 $tag 不一致"; return 1; }
    [[ "$(pin_get HERMES_SRC_ARCHIVE "$pin")" == "hermes-src-$tag-${commit:0:12}.tar.gz"
       && "$(pin_get HERMES_TUI_ARCHIVE "$pin")" == "tui/hermes-tui-$tag-${commit:0:12}.tar.gz" ]] ||
        { warn "$pin 记录的文件名不符合 $tag-${commit:0:12}"; return 1; }
    for key in SRC TUI; do
        file="$dir/$(pin_get "HERMES_${key}_ARCHIVE" "$pin")"
        digest=$(pin_get "HERMES_${key}_SHA256" "$pin")
        [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || { warn "$pin 中 HERMES_${key}_SHA256 格式错误"; return 1; }
        [[ -f "$file" && ! -L "$file" && -f "$file.sha256" && ! -L "$file.sha256" ]] || { warn "缺少 $file 或其 .sha256"; return 1; }
        [[ "$(cut -d ' ' -f 1 -- "$file.sha256")" == "$digest" ]] || { warn "$file.sha256 与记录不一致"; return 1; }
        [[ "$(sha_of "$file")" == "$digest" ]] || { warn "SHA256 不匹配: $file"; return 1; }
    done
}
# verify_contents <目录> <记录文件>：用本项目的 build-fpk.py 解包核对源码包回执，并检查 TUI 包内容
verify_contents() {
    local dir=$1 pin=$2 target status=0
    target=$(mktemp -d "$WORK/verify.XXXXXX")
    HERMES_VERSION_FILE="$pin" python3 -B - "$ROOT" "$dir/$(pin_get HERMES_SRC_ARCHIVE "$pin")" "$target/src" \
        "$dir/$(pin_get HERMES_TUI_ARCHIVE "$pin")" <<'PY'
import importlib.util, sys, tarfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('build_fpk', Path(sys.argv[1]) / 'scripts/build-fpk.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
build.extract_runtime(Path(sys.argv[2]), Path(sys.argv[3]))
with tarfile.open(sys.argv[4], 'r:gz') as archive:
    names = set()
    for member in archive.getmembers():
        name = member.name.rstrip('/')
        if name in names or not (name == 'tui' or name.startswith('tui/')) or not (member.isfile() or member.isdir()):
            raise SystemExit('Invalid TUI archive entry: ' + member.name)
        names.add(name)
missing = {'tui/dist/entry.js', 'tui/dist/scripts/gateway_bootstrap.py'} - names
if missing:
    raise SystemExit('TUI archive missing: ' + ', '.join(sorted(missing)))
PY
    status=$?
    rm -rf -- "$target"
    return "$status"
}
write_pin() {
    local out=$1 tag=$2 commit=$3 tagobj=$4 dir=$5
    local src="hermes-src-$tag-${commit:0:12}.tar.gz" tui="tui/hermes-tui-$tag-${commit:0:12}.tar.gz"
    printf 'HERMES_VERSION=%s\nHERMES_COMMIT=%s\nHERMES_TAG=%s\nHERMES_SRC_ARCHIVE=%s\nHERMES_SRC_SHA256=%s\nHERMES_TUI_ARCHIVE=%s\nHERMES_TUI_SHA256=%s\n' \
        "$tag" "$commit" "$tagobj" "$src" "$(sha_of "$dir/$src")" "$tui" "$(sha_of "$dir/$tui")" > "$out"
}
next_step() {
    local current core
    current=$(sed -n 's/^version[[:space:]]*=[[:space:]]*//p' "$ROOT/manifest" | head -1 | tr -d '\r"')
    core="${1#v}"
    if [[ "${current%%-*}" == "$core" ]]; then
        info "下一步: ./build.sh（当前 manifest 版本 $current）"
    else
        info "下一步: ./build.sh --version $core-<序号>（当前 manifest 版本 $current，内核已变，需要指定新版本号）"
        info "打包时 config/bootstrap/hermes-version.env 会改写为 $1"
    fi
}

[[ ! -L "$RUNTIME_DIR" ]] || die "runtime/ 必须为真实目录"

# ---- --record：给已有资产补写记录 ------------------------------------------------
if [[ "$MODE" == record ]]; then
    [[ "$CONFIG_CORE" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$CONFIG_COMMIT" =~ ^[0-9a-f]{40}$ && "$CONFIG_TAG" =~ ^[0-9a-f]{40}$ ]] ||
        die "config/bootstrap/hermes-version.env 内容不完整或格式错误"
    info "按 config/bootstrap 固定版本补写: $CONFIG_CORE (${CONFIG_COMMIT:0:12})"
    fetch_releases
    select_tag "$CONFIG_CORE"
    [[ "$SEL_COMMIT" == "$CONFIG_COMMIT" && "$SEL_TAGOBJ" == "$CONFIG_TAG" ]] ||
        die "config/bootstrap 固定的提交或 tag 对象与官方 $CONFIG_CORE 不一致"
    for f in "hermes-src-$CONFIG_CORE-${CONFIG_COMMIT:0:12}.tar.gz" "tui/hermes-tui-$CONFIG_CORE-${CONFIG_COMMIT:0:12}.tar.gz"; do
        [[ -f "$RUNTIME_DIR/$f" && ! -L "$RUNTIME_DIR/$f" ]] || die "runtime/ 缺少 $f，请直接运行 scripts/build-hermes.sh 构建"
        [[ -f "$RUNTIME_DIR/$f.sha256" && "$(cut -d ' ' -f 1 -- "$RUNTIME_DIR/$f.sha256")" == "$(sha_of "$RUNTIME_DIR/$f")" ]] ||
            die "runtime/$f 与其 .sha256 不一致"
    done
    write_pin "$WORK/hermes-version.env" "$CONFIG_CORE" "$CONFIG_COMMIT" "$CONFIG_TAG" "$RUNTIME_DIR"
    if [[ -e "$RUNTIME_PIN" || -L "$RUNTIME_PIN" ]]; then
        [[ -f "$RUNTIME_PIN" && ! -L "$RUNTIME_PIN" ]] && cmp -s -- "$WORK/hermes-version.env" "$RUNTIME_PIN" ||
            die "runtime/hermes-version.env 已存在且内容不同，不覆盖；请检查后移走再重试"
        info "runtime/hermes-version.env 已存在且一致"
    fi
    verify_contents "$RUNTIME_DIR" "$WORK/hermes-version.env"
    if [[ ! -e "$RUNTIME_PIN" ]]; then
        cp -- "$WORK/hermes-version.env" "$RUNTIME_PIN.part"
        mv -- "$RUNTIME_PIN.part" "$RUNTIME_PIN"
        info "已写入 runtime/hermes-version.env"
    fi
    sed 's/^/    /' "$RUNTIME_PIN"
    next_step "$CONFIG_CORE"
    exit 0
fi

# ---- --list / 构建 ---------------------------------------------------------------
info "读取 Hermes 官方正式版"
fetch_releases
info "config/bootstrap 固定版本: ${CONFIG_CORE:-无} ${CONFIG_COMMIT:+(${CONFIG_COMMIT:0:12})}；runtime/ 现有: ${RUNTIME_CORE:-无}"
if [[ "$MODE" == list ]]; then
    show_table "${#ROWS[@]}"
    exit 0
fi

if [[ -z "$REF" ]]; then
    [[ -t 0 ]] || die "非交互运行时请用 --ref latest 或 --ref vX.Y.Z 指定版本"
    show_table 10
    read -r -p "请选择要构建的版本（序号或版本号，回车选 1，q 退出）: " answer
    answer="${answer:-1}"
    [[ "$answer" != q && "$answer" != Q ]] || { info "已取消"; exit 0; }
    if [[ "$answer" =~ ^[0-9]+$ ]]; then
        (( answer >= 1 && answer <= ${#ROWS[@]} )) || die "序号超出范围: $answer"
        REF="${ROWS[answer - 1]%%$'\t'*}"
    else
        REF="$answer"
    fi
fi
select_tag "$REF"
info "已选择: $SEL_TAG（发布于 $SEL_DATE，提交 ${SEL_COMMIT:0:12}，tag 对象 ${SEL_TAGOBJ:0:12}）"
if [[ -n "$CONFIG_CORE" ]] && version_lt "$SEL_TAG" "$CONFIG_CORE" && [[ "$ALLOW_OLDER" != 1 ]]; then
    die "$SEL_TAG 比当前固定版本 $CONFIG_CORE 旧。设备上的内核只升不降，确需回退构建请加 --allow-older"
fi
if [[ "$FORCE" != 1 && -f "$RUNTIME_PIN" ]] && verify_assets "$RUNTIME_DIR" "$RUNTIME_PIN" "$SEL_TAG" "$SEL_COMMIT" "$SEL_TAGOBJ" 2>/dev/null; then
    info "runtime/ 已是 $SEL_TAG，SHA256 校验通过，无需重新构建（需要重建请加 --force）"
    next_step "$SEL_TAG"
    exit 0
fi

# 构建工具：只在本机使用，不进安装包。
NODE=""
for candidate in "${HERMES_BUILD_NODE:-}" "$(command -v node || true)" "$HOME"/.nvm/versions/node/v*/bin/node; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    major=$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
    if [[ "$major" =~ ^[0-9]+$ && "$major" -ge 26 ]]; then NODE="$candidate"; break; fi
    [[ "$candidate" != "${HERMES_BUILD_NODE:-}" ]] || die "HERMES_BUILD_NODE 指向的 Node 版本低于 26: $candidate"
done
[[ -n "$NODE" ]] || die "没有找到 Node 26 或更新版本（只用于本机编译 WebApp 和 TUI）。请用 HERMES_BUILD_NODE=/路径/bin/node 指定"
[[ -x "$(dirname -- "$NODE")/npm" ]] || die "$(dirname -- "$NODE") 下没有 npm"
UV="${HERMES_BUILD_UV:-$(command -v uv || true)}"
[[ -n "$UV" && -x "$UV" ]] || die "没有找到 uv。请用 HERMES_BUILD_UV=/路径/uv 指定"
info "构建工具: Node $("$NODE" --version)（$NODE），$("$UV" --version)（$UV）"

PROJECT="$WORK/project"
mkdir -p -- "$PROJECT/scripts" "$PROJECT/config/bootstrap"
cp -- "$ROOT/scripts/ci-runtime.sh" "$ROOT/scripts/prepare-runtime.py" "$ROOT/scripts/build-tui.sh" "$PROJECT/scripts/"
printf 'HERMES_VERSION=%s\nHERMES_COMMIT=%s\nHERMES_TAG=%s\n' "$SEL_TAG" "$SEL_COMMIT" "$SEL_TAGOBJ" \
    > "$PROJECT/config/bootstrap/hermes-version.env"
LOG="$TMP_PARENT/hermes-build-$SEL_TAG-$(date +%Y%m%d-%H%M%S).log"
info "开始构建 $SEL_TAG，日志: $LOG"
if ! (unset HERMES_VERSION_FILE GITHUB_ENV
      export PATH="$(dirname -- "$NODE"):$(dirname -- "$UV"):$PATH"
      HERMES_BUILD_WORK="$WORK/build" HERMES_SKIP_TEST_ENV=1 bash "$PROJECT/scripts/ci-runtime.sh") 2>&1 | tee "$LOG"; then
    die "构建失败，runtime/ 未改动。日志: $LOG"
fi

NEW="$PROJECT/runtime"
verify_assets "$NEW" "$NEW/hermes-version.env" "$SEL_TAG" "$SEL_COMMIT" "$SEL_TAGOBJ" || die "新构建的资产校验失败，runtime/ 未改动"
verify_contents "$NEW" "$NEW/hermes-version.env" || die "新构建的源码包回执或 TUI 内容校验失败，runtime/ 未改动"
info "新资产校验通过"

# ---- 替换 runtime/ ---------------------------------------------------------------
mkdir -p -- "$RUNTIME_DIR/tui"
[[ -d "$RUNTIME_DIR/tui" && ! -L "$RUNTIME_DIR/tui" ]] || die "runtime/tui 必须为真实目录"
shopt -s nullglob
OLD=()
for f in "$RUNTIME_DIR"/hermes-src-*.tar.gz "$RUNTIME_DIR"/hermes-src-*.tar.gz.sha256 \
         "$RUNTIME_DIR"/tui/hermes-tui-*.tar.gz "$RUNTIME_DIR"/tui/hermes-tui-*.tar.gz.sha256 "$RUNTIME_PIN"; do
    [[ -e "$f" || -L "$f" ]] && OLD+=("${f#"$RUNTIME_DIR/"}")
done
shopt -u nullglob
PUBLISHING=1
if [[ ${#OLD[@]} -gt 0 ]]; then
    old_version="$RUNTIME_CORE"
    if [[ -z "$old_version" ]]; then
        old_version=$(printf '%s\n' "${OLD[@]}" | sed -n 's/^hermes-src-\(v[0-9.]*\)-.*/\1/p' | head -1)
    fi
    BACKUP="$ROOT/runtime-backup-${old_version:-unknown}"
    [[ ! -e "$BACKUP" ]] || BACKUP="$BACKUP-$(date +%Y%m%d-%H%M%S)"
    mkdir -p -- "$BACKUP/tui"
    for f in "${OLD[@]}"; do
        mv -- "$RUNTIME_DIR/$f" "$BACKUP/$f"
        MOVED+=("$f")
    done
    info "旧资产已移到 ${BACKUP#"$ROOT/"}/"
fi
SRC_NAME=$(pin_get HERMES_SRC_ARCHIVE "$NEW/hermes-version.env")
TUI_NAME=$(pin_get HERMES_TUI_ARCHIVE "$NEW/hermes-version.env")
for f in "$SRC_NAME" "$SRC_NAME.sha256" "$TUI_NAME" "$TUI_NAME.sha256" hermes-version.env; do
    cp -- "$NEW/$f" "$RUNTIME_DIR/$f.part"
    mv -- "$RUNTIME_DIR/$f.part" "$RUNTIME_DIR/$f"
    PLACED+=("$f")
done
verify_assets "$RUNTIME_DIR" "$RUNTIME_PIN" "$SEL_TAG" "$SEL_COMMIT" "$SEL_TAGOBJ" || die "写入 runtime/ 后复核失败"
PUBLISHING=0
rm -f -- "$LOG"

info "runtime/ 已更新为 $SEL_TAG:"
sed 's/^/    /' "$RUNTIME_PIN"
next_step "$SEL_TAG"
