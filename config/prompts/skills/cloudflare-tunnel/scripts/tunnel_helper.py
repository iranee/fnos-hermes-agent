#!/usr/bin/env python3
"""Cloudflare Tunnel helper for the fnOS Hermes Agent skill.

Everything lives inside the skill directory:
  <skill>/bin/cloudflared   binary (downloaded by `install` or placed manually)
  <skill>/state/            pid / url / log files for quick and named tunnels
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen


SCRIPT_PATH = Path(__file__).resolve()
SKILL_DIR = SCRIPT_PATH.parent.parent
BIN_DIR = SKILL_DIR / "bin"
STATE_DIR = SKILL_DIR / "state"
CLOUDFLARED_BIN = BIN_DIR / "cloudflared"
EMPTY_CONFIG = STATE_DIR / "cloudflared-empty.yml"
DEFAULT_TIMEOUT = 120
START_ATTEMPTS = 3
URL_PATTERN = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")
DOH_URL = "https://1.1.1.1/dns-query"
IS_WINDOWS = os.name == "nt"
RELEASE_BASE = "https://github.com/cloudflare/cloudflared/releases"
TOKEN_ENV = "CLOUDFLARE_TUNNEL_TOKEN"

TRANSIENT_MARKERS = (
    "failed to request quick Tunnel",
    "context deadline exceeded",
    "Client.Timeout exceeded",
)


class Mode:
    def __init__(self, name: str) -> None:
        self.name = name
        self.pid_file = STATE_DIR / f"{name}.pid"
        self.log_file = STATE_DIR / f"{name}.log"
        self.local_url_file = STATE_DIR / f"{name}-local-url.txt"
        self.public_url_file = STATE_DIR / f"{name}-url.txt"


QUICK = Mode("quick")
NAMED = Mode("named")
MODES = {"quick": QUICK, "named": NAMED}


def fail(message: str, code: int = 1) -> int:
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    return code


def print_json(data: dict[str, object]) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2))


def stop_command_hint(mode: str) -> str:
    return f"{sys.executable} {SCRIPT_PATH} stop --mode {mode}"


def require_cloudflared() -> str:
    if CLOUDFLARED_BIN.is_file() and os.access(CLOUDFLARED_BIN, os.X_OK):
        return str(CLOUDFLARED_BIN)
    path = shutil.which("cloudflared")
    if path:
        return path
    raise RuntimeError(
        f"cloudflared not found. Run `{sys.executable} {SCRIPT_PATH} install` "
        f"or place the binary at {CLOUDFLARED_BIN} with mode 755."
    )


def normalize_url(args: argparse.Namespace) -> str:
    if getattr(args, "url", None):
        return args.url
    if getattr(args, "port", None):
        return f"http://127.0.0.1:{args.port}"
    raise RuntimeError("provide --url or --port")


def run_curl(url: str, timeout: int, extra_args: tuple[str, ...] = ()) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["curl", "--noproxy", "*", "-sS", "-L", "--max-time", str(timeout), *extra_args, "-w", "\n%{http_code}", url],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def fetch(url: str, timeout: int = 15) -> tuple[int | None, str]:
    if shutil.which("curl"):
        result = run_curl(url, timeout)
        if result.returncode == 6:
            doh_result = run_curl(url, timeout, ("--doh-url", DOH_URL))
            if doh_result.returncode == 0:
                result = doh_result
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or f"curl exited {result.returncode}")
        body, _, status_text = result.stdout.rpartition("\n")
        try:
            status = int(status_text)
        except ValueError:
            status = None
        return status, body

    req = Request(url, headers={"User-Agent": "cloudflare-tunnel-skill/fnos"})
    try:
        with urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except URLError as exc:
        raise RuntimeError(str(exc)) from exc


def verify_local(url: str) -> None:
    status, _ = fetch(url, timeout=10)
    if status is None or 200 <= status < 500:
        return
    raise RuntimeError(f"local service returned HTTP {status}")


def is_pid_running(pid: int) -> bool:
    if IS_WINDOWS:
        result = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False,
        )
        return re.search(rf"\s{pid}\s", result.stdout) is not None
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def send_terminate(pid: int, force: bool = False) -> None:
    if IS_WINDOWS:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        return
    sig = signal.SIGKILL if force else signal.SIGTERM
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass
    except PermissionError:
        os.kill(pid, sig)


def stop_pid(pid: int) -> None:
    send_terminate(pid)
    deadline = time.time() + 8
    while time.time() < deadline:
        if not is_pid_running(pid):
            return
        time.sleep(0.2)
    if is_pid_running(pid):
        send_terminate(pid, force=True)


def read_pid(mode: Mode) -> int | None:
    if not mode.pid_file.exists():
        return None
    try:
        return int(mode.pid_file.read_text(encoding="utf-8").strip())
    except ValueError:
        return None


def read_state_file(path: Path) -> str | None:
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8").strip() or None


def popen_kwargs() -> dict[str, object]:
    if IS_WINDOWS:
        flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        return {"creationflags": flags}
    return {"start_new_session": True}


def release_asset() -> str:
    machine = platform.machine().lower()
    arch = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
    if not arch or not sys.platform.startswith("linux"):
        raise RuntimeError(f"unsupported platform for auto install: {sys.platform}/{machine}")
    return f"cloudflared-linux-{arch}"


def cmd_install(args: argparse.Namespace) -> int:
    try:
        if CLOUDFLARED_BIN.exists() and not args.force:
            version = subprocess.run([str(CLOUDFLARED_BIN), "--version"], text=True,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False).stdout.strip()
            print_json({"ok": True, "installed": False, "cloudflared": str(CLOUDFLARED_BIN), "version": version,
                        "message": "already present; use --force to re-download"})
            return 0
        asset = release_asset()
        url = (f"{RELEASE_BASE}/download/{args.version}/{asset}" if args.version
               else f"{RELEASE_BASE}/latest/download/{asset}")
        BIN_DIR.mkdir(parents=True, exist_ok=True)
        tmp = BIN_DIR / "cloudflared.download"
        if not shutil.which("curl"):
            raise RuntimeError("curl is required to download cloudflared")
        result = subprocess.run(
            ["curl", "-fL", "--retry", "3", "--max-time", str(args.timeout), "-o", str(tmp), url],
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        if result.returncode != 0:
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"download failed ({url}): {result.stderr.strip() or result.returncode}")
        size = tmp.stat().st_size
        if size < 10_000_000:
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"downloaded file too small ({size} bytes); likely an error page")
        tmp.chmod(0o755)
        probe = subprocess.run([str(tmp), "--version"], text=True, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, check=False)
        if probe.returncode != 0 or "cloudflared" not in probe.stdout:
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"downloaded binary failed to run: {probe.stdout.strip()}")
        tmp.replace(CLOUDFLARED_BIN)
        print_json({"ok": True, "installed": True, "cloudflared": str(CLOUDFLARED_BIN),
                    "version": probe.stdout.strip(), "bytes": size, "source": url})
        return 0
    except Exception as exc:  # noqa: BLE001
        return fail(str(exc))


def cmd_check(_: argparse.Namespace) -> int:
    try:
        path = require_cloudflared()
        result = subprocess.run([path, "--version"], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        print_json({"ok": True, "cloudflared": path, "version": result.stdout.strip(), "state_dir": str(STATE_DIR)})
        return 0
    except Exception as exc:  # noqa: BLE001
        return fail(str(exc))


def launch_and_wait(cmd: list[str], mode: Mode, timeout: int, want_url: bool) -> tuple[str | None, str | None, bool]:
    """Start cloudflared once. Returns (public_url, error, transient)."""
    log = mode.log_file.open("w", encoding="utf-8")
    try:
        proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, text=True, **popen_kwargs())
        mode.pid_file.write_text(str(proc.pid), encoding="utf-8")
        public_url = None
        registered = False
        deadline = time.time() + timeout
        while time.time() < deadline:
            content = mode.log_file.read_text(encoding="utf-8", errors="replace") if mode.log_file.exists() else ""
            if proc.poll() is not None:
                transient = any(marker in content for marker in TRANSIENT_MARKERS)
                return None, f"cloudflared exited early with code {proc.returncode}. See {mode.log_file}", transient
            match = URL_PATTERN.search(content)
            if match:
                public_url = match.group(0)
            if "Registered tunnel connection" in content:
                registered = True
            if registered and (public_url or not want_url):
                return public_url or "", None, False
            time.sleep(0.5)
    finally:
        log.close()

    stop_pid(proc.pid)
    if public_url or not want_url:
        return None, f"cloudflared did not register an edge connection in time. See {mode.log_file}", True
    return None, f"did not find trycloudflare.com URL in {mode.log_file}", False


def stop_other_mode(current: Mode) -> None:
    for other in MODES.values():
        if other is current:
            continue
        pid = read_pid(other)
        if pid and is_pid_running(pid):
            stop_pid(pid)


def cmd_quick(args: argparse.Namespace) -> int:
    try:
        cloudflared = require_cloudflared()
        local_url = normalize_url(args)
        verify_local(local_url)

        existing_pid = read_pid(QUICK)
        if existing_pid and is_pid_running(existing_pid) and QUICK.public_url_file.exists():
            if read_state_file(QUICK.local_url_file) == local_url:
                print_json({
                    "ok": True, "mode": "quick", "reused": True, "pid": existing_pid,
                    "local_url": local_url, "public_url": read_state_file(QUICK.public_url_file),
                    "log_file": str(QUICK.log_file), "stop_command": stop_command_hint("quick"),
                })
                return 0
            stop_pid(existing_pid)

        STATE_DIR.mkdir(parents=True, exist_ok=True)
        EMPTY_CONFIG.write_text("", encoding="utf-8")
        cmd = [cloudflared, "--config", str(EMPTY_CONFIG), "tunnel", "--no-autoupdate", "--protocol", args.protocol]
        if args.no_tls_verify:
            cmd.append("--no-tls-verify")
        cmd.extend(["--url", local_url])

        last_error = "quick tunnel failed"
        for attempt in range(1, START_ATTEMPTS + 1):
            public_url, error, transient = launch_and_wait(cmd, QUICK, args.timeout, want_url=True)
            if public_url:
                QUICK.public_url_file.write_text(public_url + "\n", encoding="utf-8")
                QUICK.local_url_file.write_text(local_url + "\n", encoding="utf-8")
                print_json({
                    "ok": True, "mode": "quick", "pid": read_pid(QUICK), "attempt": attempt,
                    "local_url": local_url, "public_url": public_url,
                    "log_file": str(QUICK.log_file), "stop_command": stop_command_hint("quick"),
                })
                return 0
            last_error = error or last_error
            if not transient or attempt == START_ATTEMPTS:
                break
            time.sleep(2)
        return fail(last_error)
    except Exception as exc:  # noqa: BLE001
        return fail(str(exc))


def read_env_file_token(path: Path) -> str | None:
    if not path.is_file():
        return None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if line.startswith(f"{TOKEN_ENV}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'") or None
    return None


def resolve_token(args: argparse.Namespace) -> str:
    if args.token:
        return args.token
    token = os.environ.get(TOKEN_ENV, "").strip()
    if token:
        return token
    home = os.environ.get("HERMES_HOME") or os.environ.get("TRIM_PKGHOME", "")
    for candidate in (Path(home) / ".env" if home else None, Path(home) / "data" / ".env" if home else None):
        if candidate:
            token = read_env_file_token(candidate)
            if token:
                return token
    raise RuntimeError(f"no tunnel token: pass --token or set {TOKEN_ENV} in $HERMES_HOME/.env")


def cmd_named(args: argparse.Namespace) -> int:
    try:
        cloudflared = require_cloudflared()
        token = resolve_token(args)
        existing_pid = read_pid(NAMED)
        if existing_pid and is_pid_running(existing_pid):
            print_json({"ok": True, "mode": "named", "reused": True, "pid": existing_pid,
                        "public_url": read_state_file(NAMED.public_url_file),
                        "log_file": str(NAMED.log_file), "stop_command": stop_command_hint("named")})
            return 0
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        cmd = [cloudflared, "tunnel", "--no-autoupdate", "--protocol", args.protocol, "run", "--token", token]
        public_url, error, _ = launch_and_wait(cmd, NAMED, args.timeout, want_url=False)
        if error:
            return fail(error)
        if args.hostname:
            NAMED.public_url_file.write_text(f"https://{args.hostname}\n", encoding="utf-8")
        print_json({
            "ok": True, "mode": "named", "pid": read_pid(NAMED),
            "public_url": read_state_file(NAMED.public_url_file),
            "note": "ingress (hostname -> local service) is configured in the Cloudflare Zero Trust dashboard for token tunnels",
            "log_file": str(NAMED.log_file), "stop_command": stop_command_hint("named"),
        })
        return 0
    except Exception as exc:  # noqa: BLE001
        return fail(str(exc))


def cmd_status(_: argparse.Namespace) -> int:
    tunnels = {}
    for name, mode in MODES.items():
        pid = read_pid(mode)
        tunnels[name] = {
            "running": bool(pid and is_pid_running(pid)),
            "pid": pid,
            "local_url": read_state_file(mode.local_url_file),
            "public_url": read_state_file(mode.public_url_file),
            "log_file": str(mode.log_file),
        }
    print_json({"ok": True, "cloudflared": str(CLOUDFLARED_BIN) if CLOUDFLARED_BIN.exists() else None,
                "tunnels": tunnels})
    return 0


def cmd_stop(args: argparse.Namespace) -> int:
    targets = [MODES[args.mode]] if args.mode else list(MODES.values())
    result = {}
    for mode in targets:
        pid = read_pid(mode)
        if not pid:
            result[mode.name] = {"stopped": False, "message": "no pid file"}
            continue
        if not is_pid_running(pid):
            result[mode.name] = {"stopped": False, "message": "not running", "pid": pid}
            continue
        stop_pid(pid)
        result[mode.name] = {"stopped": True, "pid": pid}
    print_json({"ok": True, "result": result})
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    try:
        status, body = fetch(args.url, timeout=args.timeout)
        contains = args.contains in body if args.contains else None
        ok = status is not None and 200 <= status < 500
        if args.contains:
            ok = ok and bool(contains)
        print_json({"ok": ok, "url": args.url, "status": status, "contains": contains})
        return 0 if ok else 1
    except Exception as exc:  # noqa: BLE001
        return fail(str(exc))


def cmd_logs(args: argparse.Namespace) -> int:
    mode = MODES[args.mode]
    if not mode.log_file.exists():
        return fail(f"no log file: {mode.log_file}")
    lines = mode.log_file.read_text(encoding="utf-8", errors="replace").splitlines()
    print("\n".join(lines[-args.lines:]))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Cloudflare Tunnel skill helper (fnOS Hermes Agent)")
    sub = parser.add_subparsers(dest="command", required=True)

    install = sub.add_parser("install", help="download cloudflared into <skill>/bin")
    install.add_argument("--version", help="release tag, e.g. 2025.8.1 (default: latest)")
    install.add_argument("--force", action="store_true")
    install.add_argument("--timeout", type=int, default=600)
    install.set_defaults(func=cmd_install)

    check = sub.add_parser("check", help="check cloudflared")
    check.set_defaults(func=cmd_check)

    quick = sub.add_parser("quick", help="start a quick tunnel in the background")
    quick.add_argument("--url", help="local URL, for example http://127.0.0.1:9120")
    quick.add_argument("--port", type=int, help="local HTTP port")
    quick.add_argument("--protocol", default="http2", choices=["http2", "quic"])
    quick.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    quick.add_argument("--no-tls-verify", action="store_true", help="allow self-signed local HTTPS")
    quick.set_defaults(func=cmd_quick)

    named = sub.add_parser("named", help="run a token-based named tunnel in the background")
    named.add_argument("--token", help=f"tunnel token (default: ${TOKEN_ENV} or $HERMES_HOME/.env)")
    named.add_argument("--hostname", help="public hostname, recorded for status output")
    named.add_argument("--protocol", default="http2", choices=["http2", "quic"])
    named.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    named.set_defaults(func=cmd_named)

    status = sub.add_parser("status", help="show tunnel status")
    status.set_defaults(func=cmd_status)

    stop = sub.add_parser("stop", help="stop helper-started tunnels")
    stop.add_argument("--mode", choices=list(MODES))
    stop.set_defaults(func=cmd_stop)

    verify = sub.add_parser("verify", help="verify a public URL")
    verify.add_argument("--url", required=True)
    verify.add_argument("--contains", help="optional response substring to require")
    verify.add_argument("--timeout", type=int, default=20)
    verify.set_defaults(func=cmd_verify)

    logs = sub.add_parser("logs", help="print the tail of a tunnel log")
    logs.add_argument("--mode", default="quick", choices=list(MODES))
    logs.add_argument("--lines", type=int, default=40)
    logs.set_defaults(func=cmd_logs)

    return parser


def main() -> int:
    args = build_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
