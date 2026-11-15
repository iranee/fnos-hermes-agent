"""Process-local credentials/transport adapter for the selected official source checker."""

import argparse
import contextlib
import importlib
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import stat
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request


MAX_ENV_BYTES = 1024 * 1024
# A compare across thousands of commits is ~2.5 MB (250 commits + 300 file patches);
# a truncated body parses as invalid JSON and silently loses the behind count.
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
API_ORIGIN = "https://api.github.com"
RAW_ORIGIN = "https://raw.githubusercontent.com"


class CheckError(ValueError):
    """Only fixed, credential-free diagnostics may cross the adapter boundary."""


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise CheckError("source-check-arguments-invalid")


def _directory(value):
    path = Path(value)
    if not value or not path.is_absolute():
        raise CheckError("source-check-context-invalid")
    path = path.resolve(strict=True)
    if not path.is_dir():
        raise CheckError("source-check-context-invalid")
    return path


def _context(args):
    dirs = {key: _directory(os.environ.get(key, ""))
            for key in ("APP_DIR", "DATA_DIR", "HOME", "HERMES_HOME", "FNOS_KERNEL_ROOT")}
    home = dirs["DATA_DIR"]
    root = dirs["FNOS_KERNEL_ROOT"]
    if (dirs["HOME"] != home or dirs["HERMES_HOME"] != home or
            _directory(args.home) != home or _directory(args.install_root) != root):
        raise CheckError("source-check-context-invalid")
    expected = dirs["APP_DIR"] / "server" / "source-check.py"
    if Path(__file__).resolve(strict=True) != expected or expected.is_symlink() or not expected.is_file():
        raise CheckError("source-check-context-invalid")
    return root, home


def _identity(info):
    # Python 3.14 Windows lstat uses birth time for ctime, while fstat uses
    # change time. Compare birth time across APIs, and change time on the same
    # open handle separately below. POSIX ctime remains part of every comparison.
    change = getattr(info, "st_birthtime_ns", None) if os.name == "nt" else info.st_ctime_ns
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, change)


def _regular(info):
    return (stat.S_ISREG(info.st_mode) and
            not (getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)))


def _read_env(home):
    """Bounded, no-follow snapshot. Never search parents or another profile."""
    path = home / ".env"
    directory_before = home.lstat()
    if not stat.S_ISDIR(directory_before.st_mode):
        raise CheckError("source-check-credential-error")
    # Pin the directory on POSIX; Windows additionally uses path/handle identity checks.
    directory_fd = None
    try:
        if os.open in os.supports_dir_fd:
            directory_fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            if (os.fstat(directory_fd).st_dev, os.fstat(directory_fd).st_ino) != (
                    directory_before.st_dev, directory_before.st_ino):
                raise CheckError("source-check-credential-error")
        try:
            before = path.lstat()
        except FileNotFoundError:
            if _identity(home.lstat()) != _identity(directory_before):
                raise CheckError("source-check-credential-error")
            return b""
        if not _regular(before) or before.st_size > MAX_ENV_BYTES:
            raise CheckError("source-check-credential-error")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
        fd = os.open(".env" if directory_fd is not None else path, flags,
                     **({"dir_fd": directory_fd} if directory_fd is not None else {}))
        with os.fdopen(fd, "rb") as stream:
            opened = os.fstat(stream.fileno())
            if not _regular(opened) or _identity(opened) != _identity(before):
                raise CheckError("source-check-credential-error")
            raw = stream.read(MAX_ENV_BYTES + 1)
            after = os.fstat(stream.fileno())
        if (len(raw) > MAX_ENV_BYTES or len(raw) != before.st_size or after.st_ctime_ns != opened.st_ctime_ns or
                _identity(after) != _identity(before) or _identity(path.lstat()) != _identity(before) or
                _identity(home.lstat()) != _identity(directory_before)):
            raise CheckError("source-check-credential-error")
        return raw
    finally:
        if directory_fd is not None:
            os.close(directory_fd)


def _token_callback(home):
    """Retain only GITHUB_TOKEN in a closure, not a dotenv dictionary or environment."""
    try:
        from dotenv.main import DotEnv

        raw = _read_env(home)
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = raw.removeprefix(b"\xef\xbb\xbf").decode("latin-1")
        token = None
        for name, value in DotEnv(dotenv_path=None, stream=io.StringIO(text), interpolate=False).parse():
            if name == "GITHUB_TOKEN":
                # Last assignment wins. Empty means no NEW profile token; callers
                # retain the manager cache / original official credential fallback.
                token = (value or "").strip() or None
        if token is not None and (len(token) > 4096 or any(not 33 <= ord(c) <= 126 for c in token)):
            raise CheckError("source-check-credential-error")
    except Exception:
        raise CheckError("source-check-credential-error") from None
    return lambda: token


def _url_text(url):
    if not isinstance(url, str) or any(ord(c) <= 32 or ord(c) == 127 for c in url) or "\\" in url:
        raise CheckError("source-check-origin-rejected")
    return url


def _require_origin(url, origin):
    try:
        host = urllib.parse.urlsplit(origin).hostname
        parsed = urllib.parse.urlsplit(_url_text(url))
        if (parsed.scheme != "https" or parsed.netloc.lower() not in (host, host + ":443") or
                parsed.hostname != host or parsed.port not in (None, 443) or
                parsed.username is not None or parsed.password is not None):
            raise ValueError
    except (ValueError, TypeError):
        raise CheckError("source-check-origin-rejected") from None


class _SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, origin):
        self.origin = origin

    def http_error_302(self, req, fp, code, msg, headers):
        try:
            _require_origin(req.full_url, self.origin)
            location = headers.get("location", headers.get("uri"))
            if location is not None:
                # Validate before urllib quotes/normalizes the raw Location header.
                _require_origin(urllib.parse.urljoin(req.full_url, _url_text(location)), self.origin)
        except CheckError:
            fp.close()
            raise
        return super().http_error_302(req, fp, code, msg, headers)

    http_error_301 = http_error_303 = http_error_307 = http_error_308 = http_error_302

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _require_origin(req.full_url, self.origin)
        _require_origin(newurl, self.origin)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class GitHubQuota:
    """Bounded response-header snapshots, not guessed budgets or request bodies.

    Each entry has status, authSubmitted and authenticated (only a token-bearing
    2xx confirms authentication). Valid numeric limit/used/remaining/reset fields
    and a known resource are optional: absent fields are unknown, never defaults.
    """
    def __init__(self):
        self._entries = []
        self._lock = threading.Lock()

    def record(self, headers, status, submitted):
        if type(status) is not int or not 100 <= status <= 599:
            return
        entry = {}
        for field in ("limit", "used", "remaining", "reset"):
            value = headers.get("x-ratelimit-" + field, "")
            if (isinstance(value, str) and value.isascii() and value.isdigit() and len(value) <= 16 and
                    int(value) <= 9007199254740991):
                entry[field] = int(value)
        if not entry:
            return
        resource = headers.get("x-ratelimit-resource", "")
        if resource in {"core", "search", "code_search", "graphql", "integration_manifest", "source_import",
                        "code_scanning_upload", "actions_runner_registration", "scim", "dependency_snapshots",
                        "audit_log", "audit_log_streaming"}:
            entry["resource"] = resource
        entry.update(status=status, authSubmitted=bool(submitted), authenticated=bool(submitted) and 200 <= status < 300)
        with self._lock:
            self._entries.append(entry)
            del self._entries[:-8]

    def snapshot(self):
        with self._lock:
            return [dict(entry) for entry in self._entries]


class _QuotaResponse(urllib.request.BaseHandler):
    # Run before HTTPErrorProcessor and redirects so 403/401 and every hop count.
    def __init__(self, quota):
        self.quota = quota

    def http_response(self, request, response):
        try:
            _require_origin(request.full_url, API_ORIGIN)
        except CheckError:
            return response
        self.quota.record(response.headers, response.code, bool(request.get_header("Authorization")))
        return response

    https_response = http_response


def _request_callback(quota=None):
    # Default ProxyHandler deliberately preserves the launcher's proxy environment.
    # Never install this opener globally: official channel/assets downloads are unrelated.
    quota = quota if quota is not None else GitHubQuota()
    openers = {origin: urllib.request.build_opener(_SameOriginRedirect(origin), _QuotaResponse(quota))
               for origin in (API_ORIGIN, RAW_ORIGIN)}

    def request_with(url, accept, token):
        origin = API_ORIGIN
        # Upstream's downgrade/held guard reads schema blobs anonymously. Keeping
        # that exact public origin avoids changing its verdict; it NEVER gets a token.
        if token is None:
            try:
                _require_origin(url, RAW_ORIGIN)
                origin = RAW_ORIGIN
            except CheckError:
                pass
        _require_origin(url, origin)
        try:
            headers = {"Accept": accept, "User-Agent": "hermes-update-check"}
            if token:
                headers["Authorization"] = f"Bearer {token}"
            request = urllib.request.Request(url, headers=headers)
            with openers[origin].open(request, timeout=10) as response:
                return response.read(MAX_RESPONSE_BYTES).decode("utf-8-sig").strip()
        except urllib.error.HTTPError as exc:
            # Keep the official 401/non-rate-limited-403 anonymous retry policy, but
            # never let response bodies, URLs, arbitrary headers or exception text escape.
            safe_headers = {}
            for key in ("x-ratelimit-remaining", "x-ratelimit-reset"):
                value = (exc.headers or {}).get(key, "")
                if isinstance(value, str) and value.isascii() and value.isdigit() and len(value) <= 20:
                    safe_headers[key] = value
            status = exc.code
            exc.close()
            safe_error = urllib.error.HTTPError(API_ORIGIN, status, "GitHub API request failed", safe_headers, None)
            safe_error.close()
            raise safe_error from None
        except TimeoutError:
            raise TimeoutError("GitHub API request timed out") from None
        except urllib.error.URLError as exc:
            reason = TimeoutError("GitHub API request timed out") if isinstance(exc.reason, TimeoutError) else "network request failed"
            raise urllib.error.URLError(reason) from None
        except CheckError:
            raise
        except Exception:
            raise CheckError("source-check-request-failed") from None

    return request_with


def _module_origin(name, spec, root):
    if spec is None or not spec.origin:
        raise CheckError("source-check-module-invalid")
    expected = root.joinpath(*name.split("."))
    expected = expected / "__init__.py" if spec.submodule_search_locations is not None else expected.with_suffix(".py")
    if Path(spec.origin).resolve(strict=True) != expected or expected.resolve(strict=True) != expected:
        raise CheckError("source-check-module-invalid")
    if spec.submodule_search_locations is not None and [Path(p).resolve(strict=True) for p in spec.submodule_search_locations] != [expected.parent]:
        raise CheckError("source-check-module-invalid")


def _loaded_origins(root):
    for name, module in list(sys.modules.items()):
        if name == "hermes_constants" or name in ("hermes_cli", "pm") or name.startswith(("hermes_cli.", "pm.")):
            _module_origin(name, getattr(module, "__spec__", None), root)
            if Path(module.__file__).resolve(strict=True) != Path(module.__spec__.origin).resolve(strict=True):
                raise CheckError("source-check-module-invalid")
            if hasattr(module, "__path__") and list(module.__path__) != list(module.__spec__.submodule_search_locations):
                raise CheckError("source-check-module-invalid")


def _official_modules(root):
    _loaded_origins(root)
    # Check package resolution before importing anything from another checkout.
    for name in ("hermes_constants", "pm", "hermes_cli", "hermes_cli.github_api", "hermes_cli.source_check"):
        _module_origin(name, importlib.util.find_spec(name), root)
        importlib.import_module(name)
    _loaded_origins(root)
    source = sys.modules["hermes_cli.source_check"]
    github = sys.modules["hermes_cli.github_api"]
    for module, name, arguments in ((source, "main", ()), (source, "_request_with", ("", "", None)),
                                    (source, "_checked_out_branch", (None, None)), (github, "github_token", ())):
        function = getattr(module, name)
        function = getattr(function, "__wrapped__", function) if name == "_checked_out_branch" else function
        if Path(function.__code__.co_filename).resolve(strict=True) != Path(module.__file__).resolve(strict=True):
            raise CheckError("source-check-module-invalid")
        inspect.signature(function).bind(*arguments)
    return source, github


def _commit_times(source, root, result):
    """Add currentAt/targetAt (ms commit time); unknown dates stay absent, never fail the check."""
    from datetime import datetime

    try:
        git = source._installed_git("git")
    except Exception:
        return
    for sha_key, at_key in (("currentSha", "currentAt"), ("targetSha", "targetAt")):
        sha = result.get(sha_key)
        if not source._is_full_sha(sha):
            continue
        try:
            at = next((c["at"] for c in result.get("commits") or [] if isinstance(c, dict) and c.get("sha") == sha
                       and type(c.get("at")) is int and c["at"] > 0), None)
            if at is None:
                # No lazy fetch: an upstream tip the clone lacks falls through to the API below.
                out = source._git_stdout(["show", "-s", "--format=%ct", sha + "^{commit}"], cwd=root, git=git)
                at = int(out) * 1000 if out and out.isdigit() else None
            if at is None and sha_key == "targetSha":
                match = source._GITHUB_ORIGIN.fullmatch(source._git_stdout(["remote", "get-url", "origin"], cwd=root, git=git) or "")
                repository = match[1] if match else source.OFFICIAL_REPOSITORY
                payload = json.loads(source._request(f"{API_ORIGIN}/repos/{repository}/commits/{sha}"))
                when = payload["commit"]["committer"]["date"]
                at = int(datetime.fromisoformat(when.replace("Z", "+00:00")).timestamp() * 1000)
            if type(at) is int and at > 0:
                result[at_key] = at
        except Exception:
            pass


def _hold_rollback(result):
    """Never offer a move back: an installed kernel only goes forward, on any channel."""
    current, target = result.get("currentAt"), result.get("targetAt")
    older = type(current) is int and type(target) is int and target < current
    if result.get("updateAvailable") and (result.get("rollback") is True or older):
        result.update(updateAvailable=False, behind=0, held="rollback", rollback=False, commits=[])


BOOTSTRAP_BRANCH = "release"


def _channel_branch(original):
    """The bootstrap pins the release tag on a local-only branch; it must not be followed upstream."""
    original = getattr(original, "__wrapped__", original)

    def checked_out_branch(current_branch, fallback):
        if current_branch == BOOTSTRAP_BRANCH and fallback:
            return fallback
        return original(current_branch, fallback)

    checked_out_branch.__wrapped__ = original
    return checked_out_branch


class _Discard:
    def write(self, text):
        return len(text)

    def flush(self):
        pass


def main():
    root_text = ""
    quota = GitHubQuota()
    try:
        parser = _Parser(add_help=False, allow_abbrev=False)
        parser.add_argument("--install-root", required=True)
        parser.add_argument("--home", required=True)
        parser.add_argument("--force", action="store_true")
        # Upstream main() reads the same argv and persists the install's channel itself.
        parser.add_argument("--set-channel", choices=("main", "stable"))
        args = parser.parse_args()
        root_text = args.install_root
        root, home = _context(args)
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(_Discard()):
            source, github = _official_modules(root)
            callback = _token_callback(home)
            # Only a new nonempty profile token takes precedence. When absent,
            # preserve the original official getter: manager-injected GITHUB_TOKEN,
            # inherited GITHUB_TOKEN/GH_TOKEN, gh cache, then anonymous.
            if callback() is not None:
                github.github_token = callback
            source._request_with = _request_callback(quota)
            source._checked_out_branch = _channel_branch(source._checked_out_branch)
            # Keep process-local bindings for any late upstream daemon threads.
            # main() consumes sys.argv; run_module/__main__ would lose the patches.
            source.main()
        result = json.loads(output.getvalue())
        if not isinstance(result, dict):
            raise CheckError("source-check-contract-invalid")
        if result.get("supported") is True and not result.get("error"):
            with contextlib.redirect_stdout(_Discard()), contextlib.redirect_stderr(_Discard()):
                _commit_times(source, root, result)
            _hold_rollback(result)
        result["githubQuota"] = quota.snapshot()
    except (Exception, SystemExit) as exc:
        allowed = {"source-check-arguments-invalid", "source-check-context-invalid", "source-check-module-invalid",
                   "source-check-credential-error", "source-check-origin-rejected", "source-check-request-failed",
                   "source-check-contract-invalid"}
        error = str(exc) if isinstance(exc, CheckError) and str(exc) in allowed else "source-check-adapter-failed"
        print(json.dumps({"supported": False, "hermesRoot": root_text, "error": error,
                          "message": "Source check adapter could not complete safely.", "updateAvailable": None,
                          "githubQuota": quota.snapshot()}))
        return 0
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
