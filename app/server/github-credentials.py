"""Private execFile channel only. Never expose this helper's stdout through an API."""

import argparse
import contextlib
import importlib.util
import json
from pathlib import Path
import sys


SCHEMA = 1
CODES = {
    "GHC_ARGUMENTS": "GitHub credential helper arguments are invalid.",
    "GHC_PATH": "Hermes data directory could not be accessed.",
    "GHC_PROFILE": "GitHub token could not be read from the profile .env.",
}


class CredentialError(ValueError):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise CredentialError("GHC_ARGUMENTS")


class Discard:
    def write(self, text):
        return len(text)

    def flush(self):
        pass


def resolve_directory(value):
    try:
        path = Path(value)
        if not path.is_absolute():
            raise ValueError
        resolved = path.resolve(strict=True)
        if not resolved.is_dir():
            raise ValueError
        return resolved
    except Exception:
        raise CredentialError("GHC_PATH") from None


def read_profile(home):
    try:
        reader = Path(__file__).resolve().with_name("source-check.py")
        if reader.is_symlink() or not reader.is_file():
            raise ValueError
        spec = importlib.util.spec_from_file_location("_github_profile_reader", reader)
        module = importlib.util.module_from_spec(spec)
        # Reuse the bounded no-follow .env reader and non-interpolating DotEnv parser.
        # It checks file identity, not permission bits: fnOS may rewrite modes.
        with contextlib.redirect_stdout(Discard()), contextlib.redirect_stderr(Discard()):
            spec.loader.exec_module(module)
            return module._token_callback(home)()
    except Exception:
        raise CredentialError("GHC_PROFILE") from None


def load(home_text):
    return {"schema": SCHEMA, "token": read_profile(resolve_directory(home_text))}


def main():
    sys.dont_write_bytecode = True
    try:
        parser = Parser(add_help=False, allow_abbrev=False)
        parser.add_argument("--home", required=True)
        args = parser.parse_args()
        with contextlib.redirect_stdout(Discard()), contextlib.redirect_stderr(Discard()):
            result = load(args.home)
    except (Exception, SystemExit) as exc:
        code = str(exc) if isinstance(exc, CredentialError) and str(exc) in CODES else "GHC_PROFILE"
        result = {"code": code, "message": CODES[code]}
    # The success payload contains the token. Its only consumer is the private
    # execFile capture in github-credentials.js, never a process logger or a file.
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
