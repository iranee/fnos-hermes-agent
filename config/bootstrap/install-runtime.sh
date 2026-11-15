#!/bin/bash
# 安装/升级共用的运行时 helper 约定：
#   输入：APP_DIR、DATA_DIR（= TRIM_PKGHOME/data）、VENV_DIR（= DATA_DIR/venv）、
#         UV（绝对路径的可执行文件）、LOG_FILE、HERMES_VERSION、HERMES_COMMIT。
#   调用方提供 log_msg/toast_err，并负责执行 ensure_uv/ensure_node。
#   任何校验、同步或健康检查失败都返回非零。
#   不改写配置、prompts、密钥或全局 Python 设置。归属修复保留每项原 mode。
#
# 目录布局：
#   APP_DIR/hermes-src   打包的核心源码，每次升级由 fnOS 整体替换
#   DATA_DIR/venv        真实目录，Python 3.14，核心以 editable 方式安装
#   DATA_DIR/python      uv 托管的 CPython 3.14（在线安装版：从镜像下载）
#   DATA_DIR/*           用户数据（config.yaml、.env、sessions、memories 等），
#                        本 helper 绝不移动或删除。
#
# 在线安装版：包内不带 Python、uv 和 wheel，安装/升级时按下面的来源联网获取。
#   HERMES_PYPI_INDEX    依赖 wheel 的 PyPI simple 索引（默认阿里云镜像，设为空则
#                        直接用 uv.lock 里的 files.pythonhosted.org 地址）。
#   HERMES_PBS_MIRROR    CPython 归档的 python-build-standalone 镜像（默认 npmmirror，
#                        设为空则直接用 GitHub）。uv 按内置 SHA256 校验下载结果。
#   已经装好且健康的运行时会被复用，不重复下载。

# ---------------------------------------------------------------------------
# 架构守卫（在本文件被 source 时执行，早于 ensure_uv/ensure_node）。
# 只有 x86_64 与 aarch64 有对应的 uv、私有库和 Node 处理，其他架构尽早失败并给 fnOS 一条中文提示。
# ---------------------------------------------------------------------------
_hermes_arch_guard() {
    local arch msg
    arch=$(uname -m 2>/dev/null) || arch=unknown
    case "$arch" in x86_64|aarch64) return 0 ;; esac
    msg="Hermes Agent 安装失败：当前设备架构为 ${arch}，本应用只支持 x86_64（Intel/AMD）和 ARM（aarch64）设备。"
    if [[ -n "${TRIM_TEMP_LOGFILE:-}" && ! -L "${TRIM_TEMP_LOGFILE}" && ( ! -e "${TRIM_TEMP_LOGFILE}" || -f "${TRIM_TEMP_LOGFILE}" ) ]]; then
        { if [[ -s "${TRIM_TEMP_LOGFILE}" ]]; then printf '\n'; fi; printf '%s\n' "$msg"; } >> "${TRIM_TEMP_LOGFILE}" 2>/dev/null || true
    fi
    if declare -F log_msg >/dev/null 2>&1; then log_msg "[arch] ERROR: $msg"; else printf '%s\n' "$msg" >&2; fi
    return 1
}
_hermes_arch_guard || exit 1

# 本 helper 的 Python 部分在显式的隔离健康探测之前只使用标准库。
_hermes_runtime_python() {
    "${RUNTIME_PYTHON}" -I -S - "$@" <<'PY'
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import stat
import subprocess
import sys
import tempfile
import tomllib

RECEIPT = '.fnos-runtime.json'
# 上游 version_info 只读这个 stamp（不读 git），缺少它时各界面都显示 "vunknown"，
# `hermes update` 也无法识别源码树由安装包托管。
STAMP = 'install-stamp.json'
OWNER = 'fnos-hermes-prepare-runtime-v1'
INSTALL_OWNER = 'fnos-hermes-install-runtime-v1'
MODULES = ('hermes_cli.main', 'hermes_cli.gateway_client', 'gateway.webapp_listener',
           'hermes_cli.dashboard_auth', 'tools.registry', 'tools.file_tools', 'tools.terminal_tool')
MAX_FILES = 100000


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def no_links(path):
    for part in (path, *path.parents):
        if part.is_symlink():
            raise RuntimeError(f'Unexpected symlink: {part}')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'Duplicate JSON key: {key}')
        result[key] = value
    return result


def read_json(path):
    no_links(path)
    if not path.is_file() or path.stat().st_size > 32 * 1024 * 1024:
        raise RuntimeError(f'Invalid receipt: {path}')
    return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=unique_object)


def version(tag):
    # 只接受官方语义化版本 tag。打包后缀或 PEP440 猜测值都不算 tag。
    match = re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
                         r'(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?', tag or '')
    if not match:
        raise RuntimeError(f'Unknown official semantic version: {tag!r}')
    return match


def safe_name(name):
    if (not isinstance(name, str) or not name or len(name) > 1024
            or any(p in ('', '.', '..') for p in name.split('/'))
            or '\\' in name or ':' in name or any(ord(c) < 32 or ord(c) == 127 for c in name)
            or any(p.endswith((' ', '.')) for p in name.split('/'))):
        raise RuntimeError(f'Unsafe archive/manifest path: {name!r}')
    return PurePosixPath(name)


def generated_file(name):
    path = PurePosixPath(name)
    return (name == STAMP or ('__pycache__' in path.parts and path.suffix == '.pyc')
            or (path.parts[0] == 'hermes_agent.egg-info' and len(path.parts) == 2
                and path.name in {'PKG-INFO', 'SOURCES.txt', 'dependency_links.txt',
                                  'entry_points.txt', 'requires.txt', 'top_level.txt'}))


def inventory(source):
    result = {}
    for parent, dirs, names in os.walk(source, followlinks=False):
        for name in dirs + names:
            path = Path(parent) / name
            no_links(path)
            if not (path.is_dir() or stat.S_ISREG(path.stat().st_mode)):
                raise RuntimeError(f'Special source file: {path}')
        for name in names:
            path = Path(parent) / name
            result[path.relative_to(source).as_posix()] = digest(path)
    return result


def verify(source, commit=None, tag=None):
    no_links(source)
    saved = read_json(source / RECEIPT)
    version(saved['tag'])
    if (type(saved['schema']) is not int or saved['schema'] != 1 or saved['owner'] != OWNER
            or not re.fullmatch('[0-9a-f]{40}', saved['commit'])
            or (commit is not None and saved['commit'] != commit)
            or (tag is not None and saved['tag'] != tag)):
        raise RuntimeError('Packaged source receipt identity mismatch')
    if saved['source'] != {'repository': 'https://github.com/NousResearch/hermes-agent',
                           'collection': 'git archive', 'signature_verified': False}:
        raise RuntimeError('Unrecognized official source provenance')
    files = saved['files']
    if not isinstance(files, dict) or not files or len(files) > MAX_FILES:
        raise RuntimeError('Invalid source inventory')
    required = {'pyproject.toml', 'uv.lock', '.python-version', 'LICENSE'}
    if not required.issubset(files) or RECEIPT in files:
        raise RuntimeError('Incomplete source inventory')
    folded = set()
    for name, expected in files.items():
        path = safe_name(name)
        if name.casefold() in folded or not re.fullmatch('[0-9a-f]{64}', expected):
            raise RuntimeError('Invalid source inventory hash or case collision')
        folded.add(name.casefold())
        file = source / path
        no_links(file)
        if not file.is_file() or not stat.S_ISREG(file.stat().st_mode) or digest(file) != expected:
            raise RuntimeError(f'Packaged file missing or changed: {name}')
    # 构建可能新增 egg-info 和字节码，但包内源码里绝不能出现会被健康探测读到的本地配置。
    for name in ('.env', 'config.yaml', 'config.yml'):
        if (source / name).exists():
            raise RuntimeError(f'Unexpected local configuration in packaged source: {name}')
    runtime = saved['runtime']
    project = tomllib.loads((source / 'pyproject.toml').read_text(encoding='utf-8'))
    lock = tomllib.loads((source / 'uv.lock').read_text(encoding='utf-8'))
    python = (source / '.python-version').read_text(encoding='utf-8').strip()
    if python != '3.14' or runtime['python'] != python or sys.version_info[:2] != (3, 14):
        raise RuntimeError('Pinned runtime requires Python 3.14, not the updater bridge interpreter')
    if (project['project']['requires-python'] != runtime['requires_python']
            or project['project']['requires-python'] != '>=3.11,<3.15'
            or project['tool']['uv']['environments'] != ["python_version >= '3.14'"]
            or lock.get('supported-markers') != ["python_full_version >= '3.14'"]
            or not any(p.get('name') == 'hermes-agent' and p.get('source') == {'editable': '.'}
                       for p in lock.get('package', []))):
        raise RuntimeError('Source/lock Python or local-core requirements mismatch')
    if digest(source / 'uv.lock') != runtime['lock_sha256'] or digest(source / 'pyproject.toml') != runtime['pyproject_sha256']:
        raise RuntimeError('Runtime metadata hash mismatch')
    for key, product, relative in (('renderer', 'webapp', 'apps/desktop/dist-webapp'),
                                   ('dashboard', 'web', 'hermes_cli/web_dist')):
        dist = source / relative
        no_links(dist)
        surface = saved[key]
        receipt = dist / 'hermes-build.json'
        no_links(receipt)
        official = json.loads(receipt.read_text(encoding='utf-8'))
        check = surface['verification']
        if (check['productCurrent'] is not True or check['outputIntact'] is not True
                or not check['sourceHash'] or check['sourceHash'] != official['inputs']['sourceHash']
                or check['receiptSourceHash'] != check['sourceHash']
                or type(official['schema']) is not int or official['schema'] != 1 or official['product'] != product
                or digest(receipt) != surface['official_receipt_sha256']
                or not (dist / 'index.html').is_file() or (dist / '.hermes-stale').exists()):
            raise RuntimeError(f'Packaged official {key} receipt mismatch')
        actual = {}
        for parent, dirs, names in os.walk(dist, followlinks=False):
            for name in dirs + names:
                no_links(Path(parent) / name)
            for name in names:
                path = Path(parent) / name
                actual[path.relative_to(dist).as_posix()] = digest(path)
        prefix = relative + '/'
        source_files = {name[len(prefix):]: value for name, value in files.items() if name.startswith(prefix)}
        if actual != surface['files'] or actual != source_files:
            raise RuntimeError(f'{key.title()} SHA256 inventory mismatch')
    actual = inventory(source)
    actual.pop(RECEIPT)
    unexpected = set(actual) - set(files)
    if any(not generated_file(name) for name in unexpected):
        raise RuntimeError('Source SHA256 inventory mismatch (unexpected files)')
    return saved


def identity(source, commit, tag):
    return {'schema': 1, 'owner': INSTALL_OWNER,
            'commit': commit, 'tag': tag, 'source': str(source),
            'package_receipt_sha256': digest(source / RECEIPT),
            'lock_sha256': digest(source / 'uv.lock'), 'python': platform.python_version(),
            'platform': sys.platform, 'machine': platform.machine(), 'extras': ['all'],
            'modules': list(MODULES)}


def runtime_layout(venv):
    """Only interpreter links (and an internal lib64 alias) belong in a standard venv."""
    no_links(venv)
    for name in ('bin', 'lib'):
        path = venv / name
        no_links(path)
        if not path.is_dir():
            raise RuntimeError(f'Runtime directory missing: {path}')
    for name in ('pyvenv.cfg',):
        no_links(venv / name)
        if not (venv / name).is_file():
            raise RuntimeError(f'Runtime file missing: {name}')
    for parent, dirs, files in os.walk(venv, followlinks=False):
        for name in dirs + files:
            path = Path(parent) / name
            relative = path.relative_to(venv).as_posix()
            if path.is_symlink():
                if (relative in ('bin/python', 'bin/python3', 'bin/python3.14')
                        and path.is_file()):
                    continue
                if relative == 'lib64' and path.resolve() == venv / 'lib':
                    continue
                if relative == 'bin/uv':
                    target = venv.parent / 'bin/uv'
                    no_links(target)
                    if path.resolve() == target and target.is_file() and os.access(target, os.X_OK):
                        continue
            no_links(path)
            if not (path.is_dir() or stat.S_ISREG(path.stat().st_mode)):
                raise RuntimeError(f'Special runtime file: {path}')


def healthy(source, venv, sandbox, tag):
    runtime_layout(venv)
    python = venv / 'bin/python3'
    cli = venv / 'bin/hermes'
    if not python.is_file() or not cli.is_file():
        raise RuntimeError('Runtime Python or Hermes CLI missing')
    # 白名单环境变量加空 home，防止读取配置/密钥、惰性下载、从用户路径发现插件以及写入真实 HOME。
    env = {'PATH': str(venv / 'bin') + os.pathsep + os.defpath,
           'HOME': str(sandbox), 'HERMES_HOME': str(sandbox),
           'XDG_CONFIG_HOME': str(sandbox / 'config'), 'XDG_DATA_HOME': str(sandbox / 'data'),
           'XDG_CACHE_HOME': str(sandbox / 'cache'), 'HERMES_INSTALL_ROOT': str(source),
           'HERMES_WEBAPP_DIST': str(source / 'apps/desktop/dist-webapp'),
           'HERMES_WEB_DIST': str(source / 'hermes_cli/web_dist'),
           'HERMES_DISABLE_LAZY_INSTALLS': '1', 'HERMES_IGNORE_USER_CONFIG': '1',
           'HERMES_SAFE_MODE': '1', 'PYTHONDONTWRITEBYTECODE': '1', 'UV_OFFLINE': '1',
           'NO_COLOR': '1', 'TERM': 'dumb'}
    code = '''
import importlib, json, sys
from pathlib import Path
source, venv = map(Path, sys.argv[1:3])
assert sys.version_info[:2] == (3, 14), 'wrong runtime Python'
assert Path(sys.prefix).resolve() == venv.resolve(), 'wrong venv'
for name in json.loads(sys.argv[3]):
    module = importlib.import_module(name)
    assert Path(module.__file__).resolve().is_relative_to(source.resolve()), (name, module.__file__)
'''
    subprocess.run([str(python), '-I', '-B', '-c', code, str(source), str(venv), json.dumps(MODULES)],
                   cwd=sandbox, env=env, check=True, timeout=180)
    output = subprocess.run([str(cli), '--version'], cwd=sandbox, env=env, check=True, timeout=60,
                            capture_output=True, text=True).stdout.strip()
    print(f'hermes --version: {output}')
    # 只有首行带版本号，后续行对安装包托管的源码树会正常显示 "Install method: unknown"。
    headline = output.splitlines()[0] if output else ''
    if 'vunknown' in headline or tag not in headline:
        raise RuntimeError(f'Installed CLI does not report the packaged version {tag}: {headline!r}')


def atomic_json(path, value):
    fd, name = tempfile.mkstemp(prefix='.receipt-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            json.dump(value, out, sort_keys=True, indent=2)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.chmod(name, 0o644)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def stamp(source, commit, tag):
    """写入 install-stamp.json，字段按上游 version_info 读取的格式填充。"""
    base = tag[1:]
    atomic_json(source / STAMP, {
        'schemaVersion': 2, 'commit': commit, 'commitDate': None, 'branch': None,
        'builtAt': datetime.datetime.now(datetime.UTC).isoformat(), 'dirty': False,
        'source': 'build', 'distribution': None, 'updateMechanism': 'external',
        'baseVersion': base, 'displayVersion': base, 'distance': 0,
        'payload': 'bootstrap', 'tag': None})


def reusable(source, venv, commit, tag, sandbox):
    """Receipt identity, link-free write paths and isolated health must all match."""
    try:
        runtime_layout(venv)
        saved = read_json(venv / RECEIPT)
        if saved != identity(source, commit, tag):
            return False
        healthy(source, venv, sandbox, tag)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        return False
    return True


def record(source, venv, sandbox, commit, tag, reverify):
    no_links(venv)
    for name in ('bin/python3', 'bin/hermes', 'pyvenv.cfg'):
        if not (venv / name).is_file():
            raise RuntimeError(f'Installed runtime missing {name}')
    healthy(source, venv, sandbox, tag)
    # 依赖同步后再次校验，证明它没有改动任何官方源码或前端产物。
    if reverify:
        verify(source, commit, tag)
    atomic_json(venv / RECEIPT, identity(source, commit, tag))


mode, *args = sys.argv[1:]
try:
    if mode == 'verify':
        verify(Path(args[0]), args[1], args[2])
    elif mode == 'stamp':
        stamp(Path(args[0]), args[1], args[2])
    elif mode == 'reusable':
        sys.exit(0 if reusable(Path(args[0]), Path(args[1]), args[2], args[3], Path(args[4])) else 3)
    elif mode == 'layout':
        runtime_layout(Path(args[0]))
    elif mode == 'record':
        source, venv, sandbox = map(Path, args[:3])
        record(source, venv, sandbox, args[3], args[4], args[5] == 'reverify')
    else:
        raise RuntimeError(f'Unknown helper mode: {mode}')
except Exception as error:
    print(f'install-runtime [{mode}]: {error}', file=sys.stderr)
    sys.exit(1)
PY
}

_runtime_no_links() {
    local path="$1"
    while [[ "$path" != / && -n "$path" ]]; do
        [[ ! -L "$path" ]] || return 1
        path="${path%/*}"
    done
}

_venv_python_ok() {
    _runtime_no_links "$1/bin" && _runtime_no_links "$1/lib" &&
        _runtime_no_links "$1/pyvenv.cfg" || return 1
    [[ -d "$1" && -d "$1/bin" && -d "$1/lib" && -f "$1/pyvenv.cfg" && -x "$1/bin/python3" ]] || return 1
    env -i PATH="$PATH" HOME="$RUNTIME_WORK/home" HERMES_HOME="$RUNTIME_WORK/home" \
        "$1/bin/python3" -I -S -c 'import sys; sys.exit(sys.version_info[:2] != (3,14))' 2>/dev/null
}

install_runtime() (
    set -e
    : "${APP_DIR:?}" "${DATA_DIR:?}" "${VENV_DIR:?}" "${UV:?}" "${LOG_FILE:?}"
    : "${TRIM_PKGHOME:?}" "${HERMES_VERSION:?}" "${HERMES_COMMIT:?}"
    local RUNTIME_PYTHON="" RUNTIME_WORK="" RUNTIME_LOCK="" PREVIOUS_VENV="" NEW_VENV_ATTEMPT=0 DONE=0
    local SOURCE VENV_PY PYTHON_REQUEST=3.14 candidate physical_home
    # uv 0.13.5 为 3.14 解析出的精确版本（python-build-standalone 20261021），仅用于日志。
    local PYTHON_BUILD=3.14.9
    if [[ "$DATA_DIR" != "$TRIM_PKGHOME/data" || "$VENV_DIR" != "$DATA_DIR/venv" ]]; then
        log_msg 'ERROR: runtime must live in TRIM_PKGHOME/data'; exit 1
    fi
    if [[ ! "$HERMES_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ || ! "$HERMES_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
        log_msg 'ERROR: unsupported core identity'; exit 1
    fi
    # 只解析 fnOS 有意设置的根目录别名。关键路径内不允许符号链接。
    APP_DIR=$(cd -P -- "$APP_DIR" && pwd -P) || exit 1
    physical_home=$(cd -P -- "$TRIM_PKGHOME" && pwd -P) || exit 1
    DATA_DIR="$physical_home/data"
    VENV_DIR="$DATA_DIR/venv"
    VENV_PY="$VENV_DIR/bin/python3"
    SOURCE="$APP_DIR/hermes-src"
    if [[ ! -d "$SOURCE" || -L "$SOURCE" ]]; then
        log_msg "[core] ERROR: packaged source missing or not a plain directory: $SOURCE"; exit 1
    fi
    [[ ! -L "$DATA_DIR" && ( ! -e "$DATA_DIR" || -d "$DATA_DIR" ) ]] || {
        log_msg '[core] ERROR: unknown data path'; exit 1;
    }
    mkdir -p -- "$DATA_DIR" || exit 1
    RUNTIME_LOCK="$DATA_DIR/.hermes-runtime-install.lock"
    mkdir -- "$RUNTIME_LOCK" || {
        log_msg 'ERROR: another runtime install is active (or left a lock)'; exit 1;
    }
    _runtime_cleanup() {
        local status=$? failed="" old_saved=0
        trap - EXIT
        set +e
        if [[ -n "$PREVIOUS_VENV" && ( -e "$PREVIOUS_VENV/venv" || -L "$PREVIOUS_VENV/venv" ) ]]; then
            old_saved=1
        fi
        # 从移动旧对象起即具备回滚能力，不依赖 uv venv 是否成功返回。
        # 即使本次创建只完成了一半，也隔离保留，绝不 rm 用户可能写入的文件。
        if [[ "$DONE" == 0 && ( "$NEW_VENV_ATTEMPT" == 1 || "$old_saved" == 1 ) ]]; then
            if [[ -e "$VENV_DIR" || -L "$VENV_DIR" ]]; then
                failed=$(mktemp -d "$DATA_DIR/.hermes-venv-failed-XXXXXXXX")
                if [[ -n "$failed" ]] && mv -T -- "$VENV_DIR" "$failed/venv"; then
                    log_msg "[venv] Failed runtime and all its files retained at $failed/venv"
                else
                    log_msg "[venv] ERROR: cannot isolate failed runtime; files retained at $VENV_DIR"
                fi
            fi
            if [[ "$old_saved" == 1 ]]; then
                if [[ ! -e "$VENV_DIR" && ! -L "$VENV_DIR" ]] && mv -T -- "$PREVIOUS_VENV/venv" "$VENV_DIR"; then
                    rmdir -- "$PREVIOUS_VENV" || true
                    log_msg "[venv] Restored previous venv (including original link, if any) at $VENV_DIR"
                else
                    log_msg "[venv] ERROR: restore manually from preserved path $PREVIOUS_VENV/venv"
                fi
            fi
        fi
        [[ -z "$RUNTIME_WORK" ]] || rm -rf -- "$RUNTIME_WORK"
        rmdir -- "$RUNTIME_LOCK" || true
        exit "$status"
    }
    trap _runtime_cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    RUNTIME_WORK=$(mktemp -d "$DATA_DIR/.hermes-runtime-check-XXXXXXXX") || exit 1
    mkdir -- "$RUNTIME_WORK/home" || exit 1
    export UV_PYTHON_INSTALL_DIR="$DATA_DIR/python"
    export UV_CACHE_DIR="$DATA_DIR/.uv-cache"
    export UV_PYTHON_BIN_DIR="$DATA_DIR/bin"
    for candidate in "$UV_PYTHON_INSTALL_DIR" "$UV_CACHE_DIR" "$UV_PYTHON_BIN_DIR"; do
        [[ ! -L "$candidate" && ( ! -e "$candidate" || -d "$candidate" ) ]] || {
            log_msg "[python] ERROR: unknown private runtime directory: $candidate"; exit 1;
        }
    done
    local -a RUNTIME_UV_ENV=()
    _runtime_uv() {
        # 每次依赖写入前检查新环境的各层路径，拒绝 bin/lib 或其子项通过链接指向环境目录之外。
        if [[ "$1" == sync || "$1" == pip ]]; then
            _hermes_runtime_python layout "$VENV_DIR" || return 1
        fi
        env -i PATH="$PATH" HOME="$RUNTIME_WORK/home" \
            XDG_CONFIG_HOME="$RUNTIME_WORK/home/config" \
            UV_PYTHON_INSTALL_DIR="$UV_PYTHON_INSTALL_DIR" \
            UV_PYTHON_BIN_DIR="$UV_PYTHON_BIN_DIR" UV_CACHE_DIR="$UV_CACHE_DIR" \
            UV_PROJECT_ENVIRONMENT="$VENV_DIR" \
            HERMES_HOME="$RUNTIME_WORK/home" HERMES_DISABLE_LAZY_INSTALLS=1 \
            PYTHONDONTWRITEBYTECODE=1 ${RUNTIME_UV_ENV[@]+"${RUNTIME_UV_ENV[@]}"} "$UV" "$@"
    }

    # 先准备解释器并校验包，此阶段不移动、同步或删除旧 venv/软链。
    # 只借用位于 venv 外的基础解释器，避免移动后解释器路径失效。
    if _venv_python_ok "$VENV_DIR"; then
        candidate=$(readlink -e -- "$VENV_PY") || candidate=""
        case "$candidate" in
            "$VENV_DIR"/*|'') ;;
            *) RUNTIME_PYTHON="$candidate" ;;
        esac
    fi
    if [[ -z "$RUNTIME_PYTHON" ]]; then
        # 先看 uv 托管目录里是否已有可用的 3.14（上次安装留下的），有就不下载。
        if ! RUNTIME_PYTHON=$(_runtime_uv python find --no-config --managed-python "$PYTHON_REQUEST" 2>/dev/null); then
            # python-build-standalone 不在任何 PyPI 镜像上。npmmirror 的二进制镜像提供同一批
            # 发布文件，uv 仍按内置 SHA256 校验，被篡改的下载会被拒绝。
            # HERMES_PBS_MIRROR 为空表示直接用 GitHub。
            local pbs_mirror="${HERMES_PBS_MIRROR-https://registry.npmmirror.com/-/binary/python-build-standalone}"
            log_msg "[python] Downloading private Python $PYTHON_BUILD ($(uname -m)) via ${pbs_mirror:-github.com}"
            RUNTIME_UV_ENV=()
            [[ -z "$pbs_mirror" ]] || RUNTIME_UV_ENV=(UV_PYTHON_INSTALL_MIRROR="$pbs_mirror")
            if ! _runtime_uv python install --no-config --no-bin --no-registry "$PYTHON_REQUEST"; then
                RUNTIME_UV_ENV=()
                if [[ -n "$pbs_mirror" ]]; then
                    log_msg '[python] WARNING: mirror download failed; retrying from github.com'
                    _runtime_uv python install --no-config --no-bin --no-registry "$PYTHON_REQUEST" || {
                        log_msg '[python] ERROR: private Python installation failed; existing runtime retained'; exit 1; }
                else
                    log_msg '[python] ERROR: private Python installation failed; existing runtime retained'; exit 1
                fi
            fi
            RUNTIME_UV_ENV=()
            if ! RUNTIME_PYTHON=$(_runtime_uv python find --no-config --managed-python "$PYTHON_REQUEST"); then
                log_msg '[python] ERROR: uv could not locate private Python 3.14'; exit 1
            fi
        else
            log_msg '[python] Reusing uv-managed private Python 3.14 already present'
        fi
    fi
    log_msg "[python] Interpreter: $RUNTIME_PYTHON"
    log_msg '[core] Verifying packaged source integrity and official version'
    if ! _hermes_runtime_python verify "$SOURCE" "$HERMES_COMMIT" "$HERMES_VERSION"; then
        log_msg '[core] ERROR: packaged source failed verification; venv untouched'; exit 1
    fi
    if ! _hermes_runtime_python stamp "$SOURCE" "$HERMES_COMMIT" "$HERMES_VERSION"; then
        log_msg '[core] ERROR: could not write install-stamp.json; venv untouched'; exit 1
    fi
    # 只有安装记录（回执）完全匹配、路径没有链接到外部、且隔离健康检查通过的旧环境，才能只读复用。
    local deps_installed=0
    if [[ -d "$VENV_DIR" && ! -L "$VENV_DIR" ]] &&
        _hermes_runtime_python reusable "$SOURCE" "$VENV_DIR" "$HERMES_COMMIT" "$HERMES_VERSION" "$RUNTIME_WORK/home"; then
        log_msg '[dependencies] Existing venv receipt and isolated health match; skipping dependency sync'
        DONE=1
        log_msg "Runtime ready: $VENV_DIR (reused) running $SOURCE"
        exit 0
    fi
    # 无法识别的文件、检查不通过的旧环境、旧的符号链接都整体原样保留，永不删除，也不会在旧环境上直接执行 uv sync。
    if [[ -e "$VENV_DIR" || -L "$VENV_DIR" ]]; then
        PREVIOUS_VENV=$(mktemp -d "$DATA_DIR/.hermes-venv-previous-XXXXXXXX") || exit 1
        mv -T -- "$VENV_DIR" "$PREVIOUS_VENV/venv" || { log_msg '[venv] ERROR: cannot preserve old venv'; exit 1; }
        log_msg "[venv] Previous venv/link and all its files permanently retained at $PREVIOUS_VENV/venv; link targets and legacy .hermes-* paths untouched" || exit 1
    fi
    # 必须直接创建在固定路径，console script 的绝对 shebang 不可在之后搬迁。
    NEW_VENV_ATTEMPT=1
    [[ ! -e "$VENV_DIR" && ! -L "$VENV_DIR" ]] || { log_msg '[venv] ERROR: venv path is occupied'; exit 1; }
    log_msg "[venv] Creating CPython 3.14 venv: $VENV_DIR" || exit 1
    if ! _runtime_uv venv --no-config --python "$RUNTIME_PYTHON" "$VENV_DIR"; then
        log_msg '[venv] ERROR: venv creation failed'; exit 1
    fi
    if [[ "$deps_installed" != 1 ]]; then
        # `uv sync --frozen` 会直接从 uv.lock 里固定的 files.pythonhosted.org 绝对 URL 下载，
        # wheel 下载不走 UV_DEFAULT_INDEX。要用大陆镜像，先离线把 uv.lock 导出为带哈希的
        # requirements.txt，再用 `uv pip sync --require-hashes` 从镜像索引安装。
        # 哈希来自 uv.lock，镜像无法替换包内容。
        # HERMES_PYPI_INDEX= 设为空时跳过镜像，直接用 lock 里的 URL。
        local pypi_index="${HERMES_PYPI_INDEX-https://mirrors.aliyun.com/pypi/simple}"
        local exported="$RUNTIME_WORK/requirements.txt"
        if [[ -n "$pypi_index" ]]; then
            log_msg "[dependencies] Installing wheels from PyPI mirror $pypi_index (hash-pinned from uv.lock). No npm build."
            RUNTIME_UV_ENV=(UV_OFFLINE=1)
            if (cd -- "$SOURCE" && _runtime_uv export --no-config --quiet --frozen --no-default-groups --extra all \
                    --no-emit-project --project "$SOURCE" --format requirements.txt -o "$exported") &&
                grep -q -- '--hash=sha256:' "$exported"; then
                RUNTIME_UV_ENV=(UV_DEFAULT_INDEX="$pypi_index")
                if _runtime_uv pip sync --no-config --python "$VENV_PY" --require-hashes "$exported" &&
                    (cd -- "$SOURCE" && _runtime_uv pip install --no-config --python "$VENV_PY" --no-deps -e "$SOURCE"); then
                    deps_installed=1
                else
                    log_msg '[dependencies] WARNING: mirror sync failed; falling back to frozen sync from lock URLs'
                fi
            else
                log_msg '[dependencies] WARNING: uv export from uv.lock failed; falling back to frozen sync from lock URLs'
            fi
            RUNTIME_UV_ENV=()
        fi
    fi
    if [[ "$deps_installed" != 1 ]]; then
        log_msg '[dependencies] Frozen sync from uv.lock into data/venv; uncached dependencies may download (files.pythonhosted.org). No npm build.'
        # --frozen 按 uv.lock 固定内容安装，不重新解析。--locked 会重新验证 lock，
        # 并为我们从不安装的 direct-URL/git 条目访问 GitHub。
        if ! (cd -- "$SOURCE" && _runtime_uv sync --project "$SOURCE" --frozen \
            --python "$VENV_PY" --no-default-groups --extra all); then
            log_msg '[dependencies] ERROR: frozen dependency sync failed'; exit 1
        fi
    fi
    log_msg '[health] Checking isolated CLI/module health'
    if ! _hermes_runtime_python record "$SOURCE" "$VENV_DIR" "$RUNTIME_WORK/home" "$HERMES_COMMIT" "$HERMES_VERSION" reverify; then
        log_msg '[health] ERROR: runtime failed health/integrity check'; exit 1
    fi
    DONE=1
    log_msg "Runtime ready: $VENV_DIR (in place) running $SOURCE"
)

# 仅在运行时健康检查成功后调用。fnOS chown 可能重设 mode，不能用递归 chmod
# 猜测权限；配置/密钥的 0600、自定义目录权限和 runtime 的执行位均须原样保留。
repair_data_ownership() {
    [[ "$DATA_DIR" == "$TRIM_PKGHOME/data" && "$VENV_DIR" == "$DATA_DIR/venv" ]] || return 1
    "${VENV_DIR}/bin/python3" -I -S - "$TRIM_PKGHOME" "$TRIM_USERNAME" <<'PY'
import collections
import grp
import os
import pwd
import stat
import sys

DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
PATH_FLAGS = os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC


def identity(info):
    return info.st_dev, info.st_ino


def open_home(path):
    # 仅解析 fnOS 的 home 根别名。解析后逐层 no-follow 打开，不接受 data 软链。
    physical = os.path.realpath(path, strict=True)
    # Ancestors require search permission, not permission to list their contents.
    fd = os.open('/', PATH_FLAGS)
    try:
        for part in physical.split('/'):
            if part:
                child = os.open(part, PATH_FLAGS, dir_fd=fd)
                os.close(fd)
                fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def repair(root, uid, gid):
    links = collections.Counter()
    device = os.fstat(root).st_dev
    changed = 0

    def fix(fd, label):
        nonlocal changed
        before = os.fstat(fd)
        # uv 的同归属硬链接（包括缓存）不需要任何写操作。
        if (before.st_uid, before.st_gid) == (uid, gid):
            return
        if stat.S_ISREG(before.st_mode) and links[identity(before)] != before.st_nlink:
            raise RuntimeError(f'hardlink outside DATA_DIR or changed during scan: {label!r}')
        mode = stat.S_IMODE(before.st_mode)
        try:
            os.fchown(fd, uid, gid)
        finally:
            # 即使 chown 部分生效后报错，也尝试恢复原 mode，再将错误传给 callback。
            if stat.S_IMODE(os.fstat(fd).st_mode) != mode:
                os.fchmod(fd, mode)
        after = os.fstat(fd)
        if (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)) != (uid, gid, mode):
            raise RuntimeError(f'ownership/mode verification failed: {label!r}')
        changed += 1

    def walk(fd, label, apply):
        with os.scandir(fd) as entries:
            for entry in entries:
                info = entry.stat(follow_symlinks=False)
                # 链接本身及 socket/FIFO/device 不作权限清理，更不打开其目标。
                if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                    continue
                child_label = label + '/' + entry.name
                if info.st_dev != device:
                    raise RuntimeError(f'mount outside DATA_DIR filesystem: {child_label!r}')
                directory = stat.S_ISDIR(info.st_mode)
                if not directory:
                    if not apply:
                        links[identity(info)] += 1
                        continue
                    if (info.st_uid, info.st_gid) == (uid, gid):
                        continue
                child = os.open(entry.name, DIR_FLAGS if directory else FILE_FLAGS, dir_fd=fd)
                try:
                    opened = os.fstat(child)
                    if (identity(opened), opened.st_mode) != (identity(info), info.st_mode):
                        raise RuntimeError(f'entry changed while opening: {child_label!r}')
                    if directory:
                        walk(child, child_label, apply)
                    elif apply:
                        fix(child, child_label)
                finally:
                    os.close(child)
        # 后序处理目录：不让 chown 对父目录 mode 的重设干扰子项遍历。
        if apply:
            fix(fd, label)

    # 先只读统计，允许 DATA 内 uv 硬链接一起修复，绝不连带修改 DATA 外 inode。
    walk(root, 'data', False)
    walk(root, 'data', True)
    print(f'[permissions] DATA ownership repaired; original modes preserved ({changed} inodes)')


# Ownership repair entry point.
try:
    home, username = sys.argv[1:]
    uid, gid = pwd.getpwnam(username).pw_uid, grp.getgrnam(username).gr_gid
    home_fd = open_home(home)
    try:
        root_fd = os.open('data', DIR_FLAGS, dir_fd=home_fd)
        try:
            repair(root_fd, uid, gid)
        finally:
            os.close(root_fd)
    finally:
        os.close(home_fd)
except Exception as error:
    print(f'[permissions] DATA ownership repair failed: {error}', file=sys.stderr)
    sys.exit(1)
PY
}

# Node 是必需的运行时，不是可选增强。旧的可执行文件不能仅因存在就被信任，
# 也不使用 PATH 里无关的 node。
_node_usable() {
    local root="$1" version major
    [[ -x "$root/bin/node" && -f "$root/lib/node_modules/npm/bin/npm-cli.js" ]] || return 1
    version=$("$root/bin/node" --version 2>/dev/null) || return 1
    [[ "$version" =~ ^v([0-9]{1,3})\.[0-9]+\.[0-9]+$ ]] || return 1
    major="${BASH_REMATCH[1]}"
    (( 10#$major >= 26 )) || return 1
    "$root/bin/node" "$root/lib/node_modules/npm/bin/npm-cli.js" --version >/dev/null 2>&1
}

ensure_node() (
    set -e
    [[ "$DATA_DIR" == "$TRIM_PKGHOME/data" ]] || exit 1
    local NODE_ROOT="$DATA_DIR/node" WORK="" BACKUP="" cand NODE_SRC=""
    case "$(uname -m)" in x86_64) PRIVATE_LIB_ARCH=x64 ;; aarch64|arm64) PRIVATE_LIB_ARCH=arm64 ;; *) PRIVATE_LIB_ARCH="" ;; esac
    if [[ -n "${APP_DIR:-}" && -n "$PRIVATE_LIB_ARCH" && -f "$APP_DIR/lib/$PRIVATE_LIB_ARCH/libatomic.so.1" && ! -L "$APP_DIR/lib/$PRIVATE_LIB_ARCH/libatomic.so.1" ]]; then
        export LD_LIBRARY_PATH="$APP_DIR/lib/$PRIVATE_LIB_ARCH${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    fi
    if _node_usable "$NODE_ROOT"; then
        log_msg "[node] Verified persistent runtime: $("$NODE_ROOT/bin/node" --version)"
        exit 0
    fi
    case "$(uname -m)" in
        x86_64|aarch64|arm64) ;;
        *) log_msg '[node] ERROR: unsupported architecture'; exit 1 ;;
    esac
    mkdir -p -- "$DATA_DIR" || exit 1
    local NODE_LOCK="$DATA_DIR/.hermes-node-install.lock"
    mkdir -- "$NODE_LOCK" || { log_msg '[node] ERROR: another node install is active (or left a lock)'; exit 1; }
    _node_cleanup() {
        local status=$?
        trap - EXIT
        [[ -z "$WORK" ]] || rm -rf -- "$WORK"
        rmdir -- "$NODE_LOCK" || true
        exit "$status"
    }
    trap _node_cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    WORK=$(mktemp -d "$DATA_DIR/.hermes-node-XXXXXXXX") || exit 1
    # 只从 fnOS 的稳定 target 发现 Node 应用，不依赖版本目录或存储卷路径。
    # 按实际可用版本降序、同版本按路径排序。不改动其他应用或全局运行时。
    local FNOS_APPS=/var/apps
    local app version
    : > "$WORK/candidates" || exit 1
    for cand in "$FNOS_APPS"/nodejs*/target; do
        [[ -d "$cand" ]] || continue
        app="${cand%/target}"
        [[ "${app##*/}" =~ ^nodejs(_v[0-9]+)?$ ]] || continue
        log_msg "[node] Checking fnOS runtime: $cand (bin/node and lib/node_modules/npm/bin/npm-cli.js)"
        if _node_usable "$cand" && version=$("$cand/bin/node" --version 2>/dev/null); then
            printf '%s\t%s\0' "$version" "$cand" >> "$WORK/candidates" || exit 1
        else
            log_msg "[node] Runtime missing, unusable, incomplete, or older than 26: $cand"
        fi
    done
    LC_ALL=C sort -z -t $'\t' -k1,1Vr -k2 "$WORK/candidates" > "$WORK/sorted" || exit 1
    while IFS= read -r -d '' cand; do
        cand="${cand#*$'\t'}"
        log_msg "[node] Copying verified fnOS Node/npm from $cand"
        mkdir -- "$WORK/node" || exit 1
        if cp -a -- "$cand/." "$WORK/node/" && _node_usable "$WORK/node"; then
            NODE_SRC="$cand"
            break
        fi
        log_msg "[node] Copy or copied runtime validation failed: $cand"
        rm -rf -- "$WORK/node"
    done < "$WORK/sorted"
    if [[ -z "$NODE_SRC" ]]; then
        log_msg '[node] ERROR: 未找到可用的 fnOS Node.js 26 或更新版本，请在应用中心安装或修复；未下载 Node，原运行时保留'
        exit 1
    fi
    # 绝不合并进或删除旧目录（可能含用户文件）。整体保留旧目录树或符号链接，发布失败时回滚。
    if [[ -e "$NODE_ROOT" || -L "$NODE_ROOT" ]]; then
        BACKUP=$(mktemp -d "$DATA_DIR/.node-previous-XXXXXXXX") || exit 1
        mv -- "$NODE_ROOT" "$BACKUP/node" || exit 1
    fi
    if ! mv -- "$WORK/node" "$NODE_ROOT"; then
        if [[ -n "$BACKUP" ]]; then
            mv -- "$BACKUP/node" "$NODE_ROOT" || log_msg "[node] ERROR: restore manually from $BACKUP/node"
        fi
        exit 1
    fi
    log_msg "[node] Required runtime ready: $NODE_SRC; previous runtime retained at ${BACKUP:-none}"
)

