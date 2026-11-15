import { lstatSync, statSync, readFileSync, realpathSync, mkdirSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { formatKernelVersion } from "./kernel-version.js";

const ORIGIN = "https://github.com/NousResearch/hermes-agent.git";
const IDENTITY = { HERMES_VERSION: /^v\d+\.\d+\.\d+$/, HERMES_COMMIT: /^[a-f0-9]{40}$/, HERMES_TAG: /^[a-f0-9]{40}$/ };
const PINS = ["PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "HERMES_RUNTIME_DIR", "HERMES_INSTALL_ROOT",
  "HERMES_PYTHON", "HERMES_PYTHON_SRC_ROOT", "HERMES_NODE", "HERMES_TUI_DIR", "HERMES_WEBAPP_DIST",
  "HERMES_WEB_DIST", "HERMES_DISABLE_LAZY_INSTALLS", "FNOS_LAUNCH_TOKEN", "FNOS_LAUNCH_ROLE",
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES"];
const SOURCE_FILES = ["pm/cli.py", "pm/install.py", "pm/lock.json", "uv.lock", "pyproject.toml",
  "hermes_bootstrap.py", "hermes_cli/source_completion.py", "hermes_cli/_launchers.py",
  "hermes_cli/source_build.py", "scripts/build/freshness.mjs", "ui-tui/package.json", "web/package.json",
  "apps/desktop/scripts/build-webapp.mjs"];
const PRODUCTS = [["tui", "ui-tui/dist", "entry.js"], ["web", "hermes_cli/web_dist", "index.html"],
  ["webapp", "apps/desktop/dist-webapp", "index.html"]];
const PYTHON_HEALTH = String.raw`# fnos-bootstrap-python-health
import json, os, sqlite3, ssl, sys
if sys.version_info < (3, 11):
    raise RuntimeError("Bootstrap Python must be >= 3.11")
with sqlite3.connect(":memory:") as db:
    if db.execute("select json_valid('{}')").fetchone() != (1,):
        raise RuntimeError("Bootstrap SQLite JSON support is unavailable")
print(json.dumps({"python": os.path.realpath(sys.executable)}))
`;
// run intentionally has no stdin API. This stdlib bridge supplies a read-only prepare
// request to the FULL launcher using an argv list, never a shell or a config write.
const MODEL_PREPARE = String.raw`# fnos-bootstrap-model-prepare
import json, os, subprocess, sys
payload = {"action": "prepare", "providers": [{"id": "openai", "hermesId": "openai-api",
           "model": "fnos-bootstrap-validation", "custom": False, "envKey": "",
           "apiMode": "chat_completions"}], "providerId": "openai", "oldIds": [], "fallbackIds": None}
result = subprocess.run(sys.argv[1:], input=json.dumps(payload), text=True, encoding="utf-8",
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=dict(os.environ), timeout=90)
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
raise SystemExit(result.returncode)
`;
// Read-only probes run BEFORE any launcher can silently repair a missing PM environment.
// Use the checkout's own lock/stamp/receipt implementation; never manufacture receipts.
const PROBE = String.raw`# fnos-bootstrap-acceptance
import json, os, shlex, sys
from pathlib import Path
root = Path(sys.argv[1]).resolve(strict=True)
phase = sys.argv[2]
sys.path.insert(0, str(root))
from pm import paths
from pm.install import _installed_location, _lockfile, venv_is_current
from pm.registry import get_package
from pm.store import current_target
from pm.environments import project_python, selected_venv
from hermes_cli._launchers import resolve_store_python, _launcher_script

def require(value, message):
    if not value:
        raise RuntimeError(message)

require(paths.repo_root().resolve() == root, "PM source root mismatch")
require(paths.facts_path().is_file(), "PM facts are missing")
lock = _lockfile()
target = current_target()
required = {"python", "uv", "node", "npm"}
for name in lock.names():
    package = get_package(name)
    if not package.optional and not package.internal and package.missing_reason(target) is None:
        required.add(name)
for name in sorted(required):
    require(_installed_location(get_package(name), lock, target, verify=True, heal=False) is not None,
            "PM package missing, corrupt or not matched to lock: " + name)
require(venv_is_current(project_root=root), "PM venv receipt does not match source inputs")
require((selected_venv(root) / "pyvenv.cfg").is_file(), "PM selected venv is missing")
require(project_python(root).is_file(), "PM selected Python is missing")
python = resolve_store_python(root)
require(python is not None and python.is_file(), "PM launcher Python is missing")
launcher = root / ".hermes/bin/hermes"
expected = '#!/bin/sh\nexec ' + shlex.join([str(python), '-I', '-c', _launcher_script('hermes', root, None)]) + ' "$@"\n'
require(not launcher.is_symlink() and launcher.read_bytes() == expected.encode("utf-8"),
        "Source launcher does not match this revision and permanent source path")
require(os.access(launcher, os.X_OK), "Source launcher is not executable")
if phase == "complete":
    from hermes_cli.source_build import source_product_current
    for product, relative in (("tui", "ui-tui/dist"), ("web", "hermes_cli/web_dist"),
                              ("webapp", "apps/desktop/dist-webapp")):
        require(source_product_current(root, product, root / relative),
                "Frontend receipt missing, stale or mismatched: " + product)
print(json.dumps({"schema": 1, "phase": phase, "root": str(root), "python": str(python)}))
`;

function absolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) === path.parse(value).root) {
    throw new Error(`${name} must be an explicit absolute directory`);
  }
  return path.resolve(value);
}
function optional(file) {
  try { return lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function directory(file) {
  if (!lstatSync(file).isDirectory()) throw new Error(`Not a real directory: ${file}`);
}
function regular(file, executable = false) {
  const info = lstatSync(file);
  if (!info.isFile() || !info.size || (executable && !(info.mode & 0o111))) {
    throw new Error(`Missing or invalid runtime file: ${file}`);
  }
}
function json(text, label) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
    return value;
  } catch (error) { throw new Error(`Invalid ${label}: ${error.message}`, { cause: error }); }
}
function same(a, b) {
  return a && b && Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(key => a[key] === b[key]);
}

/** Requires an injected, argv-based run implementation. The caller owns serialization,
 * the maintenance window, proxy lifetime and publication. Failed generations are never removed.
 * complete() runs official config/skills migrations: source fallback is NOT a data rollback.
 */
export function createKernelBootstrap({ appDir, dataDir, varDir, runtime, run }) {
  appDir = absolute(appDir, "APP_DIR");
  dataDir = absolute(dataDir, "DATA_DIR");
  varDir = absolute(varDir, "VAR_DIR");
  if (typeof run !== "function") throw new TypeError("Kernel bootstrap requires an injected run function");
  for (const name of ["resolve", "generation", "environment", "command", "prepareAdapter"]) {
    if (typeof runtime?.[name] !== "function") throw new TypeError(`Kernel runtime requires ${name}()`);
  }
  const kernels = path.join(dataDir, "kernels"), activeFile = path.join(kernels, "active.json");
  const bootstrapPython = path.join(dataDir, "venv", "bin", "python");

  function selection() {
    const selected = runtime.resolve(); // Invalid JSON and symlinks must propagate, never fall back.
    const info = optional(activeFile);
    if (info && !info.isFile()) throw new Error("Kernel selection is not a regular file");
    return { selected, identity: info ? `${info.ino}:${info.mtimeMs}:${readFileSync(activeFile, "utf8")}` : null };
  }
  function guard(initial) {
    const current = selection();
    if (current.identity !== initial.identity || !same(current.selected, initial.selected)) {
      throw new Error("Active kernel selection changed during bootstrap/verification");
    }
  }
  function source(selected) {
    if (selected?.kind !== "source") throw new Error("Expected a source generation");
    const actual = runtime.generation(selected.id);
    const root = path.join(kernels, selected.id, "src");
    if (!same(actual, selected) || actual.root !== root || actual.launcher !== path.join(root, ".hermes", "bin", "hermes")) {
      throw new Error("Source selection does not exactly match its permanent generation");
    }
    return actual;
  }
  function environment(selected, supplied) {
    // Merge first, then let the runtime restore required paths (including private ELF libraries).
    const base = runtime.environment(selected, supplied);
    const result = { ...base };
    for (const key of PINS) delete result[key];
    result.PATH = (result.PATH || "").split(path.delimiter).filter(dir => dir &&
      dir !== path.join(dataDir, "venv", "bin") && !dir.startsWith(kernels + path.sep)).join(path.delimiter);
    for (const key of ["APP_DIR", "DATA_DIR", "VAR_DIR", "HOME", "USERPROFILE", "HERMES_HOME",
      "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) result[key] = base[key];
    Object.assign(result, { GIT_TERMINAL_PROMPT: "0", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
      PYTHONIOENCODING: "utf-8", FNOS_KERNEL_ID: selected.id, FNOS_KERNEL_ROOT: selected.root });
    return result;
  }
  function job(initial, selected, { env, signal, prepareEnvironment, log = () => {} } = {}) {
    if (typeof log !== "function") throw new TypeError("log must be a function");
    const preparedEnv = environment(selected, env);
    const check = () => {
      signal?.throwIfAborted();
      guard(initial);
      for (const dir of [dataDir, kernels, path.dirname(selected.root), selected.root]) directory(dir);
      for (const name of [".git", ".hermes"]) {
        const dir = path.join(selected.root, name);
        if (optional(dir)) directory(dir);
      }
    };
    async function exec(executable, args, timeoutMs = 120000) {
      check();
      const childEnv = { ...preparedEnv, PWD: selected.root };
      const result = await run(executable, args, { cwd: selected.root,
        env: environment(selected, prepareEnvironment ? prepareEnvironment(childEnv) : childEnv), signal,
        timeoutMs, onLine: log, maxBuffer: 8 * 1024 * 1024 });
      check();
      if (!result || result.code !== 0 || typeof result.stdout !== "string" || typeof result.stderr !== "string") {
        throw new Error(`Invalid/failed subprocess result: ${executable} (code ${result?.code})`);
      }
      return result.stdout;
    }
    const git = async args => {
      const operation = args[0];
      const timeoutMs = operation === "fetch" ? 15 * 60 * 1000 : 120000;
      log(`Git ${operation} started (timeout ${timeoutMs / 1000}s)`);
      const result = await exec("git", ["--no-optional-locks", "-C", selected.root, ...args], timeoutMs);
      log(`Git ${operation} completed`);
      return result;
    };
    return { check, exec, git, log };
  }
  function baseline() {
    const file = path.join(appDir, "config", "bootstrap", "hermes-version.env");
    regular(file);
    const values = {};
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const match = /^([A-Z_]+)=(.*)$/.exec(line);
      if (!match || !Object.hasOwn(IDENTITY, match[1]) || Object.hasOwn(values, match[1]) || !IDENTITY[match[1]].test(match[2])) {
        throw new Error("Invalid bootstrap version identity");
      }
      values[match[1]] = match[2];
    }
    if (Object.keys(values).length !== Object.keys(IDENTITY).length) throw new Error("Incomplete bootstrap version identity");
    // 标签对象 ID 也要核对：同一提交上重打的标签会换对象 ID，提交 ID 不变。
    return { version: values.HERMES_VERSION, commit: values.HERMES_COMMIT, tag: values.HERMES_TAG };
  }
  function sourceFiles(root) {
    for (const relative of SOURCE_FILES) {
      let parent = root;
      for (const part of relative.split("/").slice(0, -1)) { parent = path.join(parent, part); directory(parent); }
      regular(path.join(root, relative));
    }
  }
  async function health(ctx) {
    const info = statSync(bootstrapPython); // A normal venv Python may itself be a symlink.
    if (!info.isFile() || !(info.mode & 0o111)) throw new Error("Bootstrap Python is not executable");
    const result = json(await ctx.exec(bootstrapPython, ["-I", "-B", "-c", PYTHON_HEALTH], 30000), "Python health response");
    if (result.python !== realpathSync(bootstrapPython)) throw new Error("Bootstrap Python identity mismatch");
  }
  async function identity(ctx, selected, expected) {
    directory(path.join(selected.root, ".git"));
    if ((await ctx.git(["rev-parse", "--is-inside-work-tree"])).trim() !== "true" ||
        realpathSync((await ctx.git(["rev-parse", "--show-toplevel"])).trim()) !== realpathSync(selected.root) ||
        realpathSync((await ctx.git(["rev-parse", "--absolute-git-dir"])).trim()) !== realpathSync(path.join(selected.root, ".git"))) {
      throw new Error("Git worktree does not belong to the permanent source directory");
    }
    const commit = (await ctx.git(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    const tree = (await ctx.git(["rev-parse", "--verify", "HEAD^{tree}"])).trim();
    if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree) || (expected && commit !== expected)) {
      throw new Error("Git revision/tree identity mismatch");
    }
    const branchName = (await ctx.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    // Release updates checkout --detach at the tag; the main channel checks out an untracked local main.
    const branch = branchName === "HEAD" ? null : branchName;
    if ((await ctx.git(["remote", "get-url", "origin"])).trim() !== ORIGIN ||
        !["release", "main", null].includes(branch) ||
        (await ctx.git(["config", "--local", "--get", "branch.release.remote"])).trim() !== "origin" ||
        (await ctx.git(["config", "--local", "--get", "branch.release.merge"])).trim() !== "refs/heads/release") {
      throw new Error("Source must track the official origin release branch");
    }
    if ((await ctx.git(["status", "--porcelain=v1", "--untracked-files=all"])).trim()) throw new Error("Git source worktree is not clean");
    sourceFiles(selected.root);
    return { commit, tree, branch };
  }
  async function probe(ctx, selected, phase) {
    const answer = json(await ctx.exec(bootstrapPython, ["-I", "-B", "-c", PROBE, selected.root, phase], 300000), "PM acceptance response");
    if (answer.schema !== 1 || answer.phase !== phase || answer.root !== realpathSync(selected.root) ||
        typeof answer.python !== "string" || !path.isAbsolute(answer.python)) throw new Error("PM acceptance identity mismatch");
  }
  function products(root) {
    function walk(dir) {
      directory(dir);
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name), info = lstatSync(file);
        if (info.isDirectory()) walk(file);
        else if (!info.isFile()) throw new Error(`Frontend must not contain links or special files: ${file}`);
      }
    }
    for (const [product, relative, entry] of PRODUCTS) {
      let dir = root;
      for (const part of relative.split("/")) { dir = path.join(dir, part); directory(dir); }
      if (optional(path.join(dir, ".hermes-stale"))) throw new Error(`Stale frontend: ${product}`);
      regular(path.join(dir, entry));
      regular(path.join(dir, "hermes-build.json"));
      walk(dir);
    }
  }
  function stamp(root, { commit, branch }) {
    const file = path.join(root, "install-stamp.json");
    regular(file);
    const value = json(readFileSync(file, "utf8"), "source completion stamp");
    if (value.schemaVersion !== 2 || value.commit !== commit || value.source !== "git" || value.dirty !== false ||
        value.updateMechanism !== "self" || value.branch !== branch || !value.builtAt || value.adoptedAt) {
      throw new Error("Source completion receipt does not match the Git revision");
    }
    const receipt = path.join(root, ".hermes-bootstrap-complete");
    if (optional(receipt)) {
      regular(receipt);
      const saved = json(readFileSync(receipt, "utf8").replace(/^\uFEFF/, ""), "bootstrap receipt");
      // A detached update keeps the previous pinnedBranch, which may be main after a channel switch.
      if (saved.schemaVersion !== 1 || saved.pinnedCommit !== commit || !["release", "main"].includes(saved.pinnedBranch) ||
          (branch !== null && saved.pinnedBranch !== branch) || !saved.completedAt) {
        throw new Error("Bootstrap receipt does not match the Git revision");
      }
    }
  }
  async function acceptance(ctx, selected) {
    const before = await identity(ctx, selected);
    stamp(selected.root, before);
    products(selected.root);
    await probe(ctx, selected, "complete");
    ctx.check();
    await runtime.prepareAdapter(selected);
    ctx.check();
    // This is deliberately the full launcher, including bootstrap/recovery and selected deps.
    const commandFor = (args, helper) => {
      const command = runtime.command(args, { helper, selected });
      const expected = helper ? ["--run-module", "fnos_app_runtime", helper, ...args] : args;
      if (command.executable !== selected.launcher || command.cwd !== selected.root ||
          JSON.stringify(command.args) !== JSON.stringify(expected)) throw new Error("Runtime did not select the full source launcher");
      return command;
    };
    const invoke = (args, helper) => {
      const command = commandFor(args, helper);
      return ctx.exec(command.executable, command.args);
    };
    const version = json(await invoke(["--home", dataDir, "version"], "webapp-control"), "local version response");
    if (version.ok !== true || version.result?.root !== selected.root ||
        version.result?.commit !== before.commit || !formatKernelVersion(version.result)) {
      throw new Error("Local version identity does not match the selected Git revision");
    }
    const help = await invoke(["--help"], "model-config");
    if (!help.includes("--home")) throw new Error("Model-config helper did not expose its CLI");
    const model = commandFor(["--home", dataDir], "model-config");
    const modelResult = json(await ctx.exec(bootstrapPython, ["-I", "-B", "-c", MODEL_PREPARE,
      model.executable, ...model.args]), "model-config prepare response");
    if (modelResult.ok !== true || !Object.hasOwn(modelResult, "revision")) throw new Error("Model-config helper acceptance failed");
    const web = json(await invoke(["--home", dataDir, "check"], "webapp-control"), "WebApp helper response");
    if (web.ok !== true || web.result?.ready !== true) throw new Error("WebApp helper acceptance failed");
    const dashboard = json(await invoke(["--home", dataDir, "dashboard-settings"], "webapp-control"), "Dashboard helper response");
    if (dashboard.ok !== true || dashboard.result?.assets_ready !== true) throw new Error("Dashboard helper acceptance failed");
    const after = await identity(ctx, selected, before.commit);
    if (after.tree !== before.tree || after.branch !== before.branch) throw new Error("Git tree/branch changed during acceptance");
    stamp(selected.root, before);
    products(selected.root);
    await probe(ctx, selected, "complete");
    return { ok: true, selected: source(selected) };
  }
  function candidate(selected) {
    const actual = source(selected), initial = selection();
    if (initial.selected.kind !== "package" && !same(initial.selected, actual)) throw new Error("A different source kernel is active");
    return { actual, initial };
  }

  async function prepare(options = {}) {
    options.signal?.throwIfAborted();
    const initial = selection();
    if (initial.selected.kind !== "package" || initial.identity !== null) throw new Error("Bootstrap requires the package selection with no active source");
    const pinned = baseline();
    directory(dataDir);
    if (!optional(kernels)) {
      try { mkdirSync(kernels); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    directory(kernels);
    guard(initial);
    const id = randomBytes(16).toString("hex"), generationDir = path.join(kernels, id);
    mkdirSync(generationDir); // Exclusive: even a colliding generation is never reused/overwritten.
    const root = path.join(generationDir, "src");
    mkdirSync(root);
    const selected = { kind: "source", id, root, launcher: path.join(root, ".hermes", "bin", "hermes") };
    const ctx = job(initial, selected, options);
    ctx.log(`Preparing permanent kernel generation ${id}; failures retain ${generationDir}`);
    await health(ctx);
    await ctx.git(["init", "--quiet", "."]);
    await ctx.git(["remote", "add", "origin", ORIGIN]);
    await ctx.git(["fetch", "--no-tags", "origin", `refs/tags/${pinned.version}:refs/tags/${pinned.version}`]);
    for (const [ref, expected] of [[`refs/tags/${pinned.version}`, pinned.tag], ["FETCH_HEAD", pinned.tag],
      ["FETCH_HEAD^{commit}", pinned.commit], [`refs/tags/${pinned.version}^{commit}`, pinned.commit]]) {
      if ((await ctx.git(["rev-parse", "--verify", ref])).trim() !== expected) throw new Error(`Official Git identity mismatch: ${ref}`);
    }
    const tree = (await ctx.git(["rev-parse", "--verify", "FETCH_HEAD^{tree}"])).trim();
    if (!/^[a-f0-9]{40}$/.test(tree)) throw new Error("Invalid fetched Git tree");
    await ctx.git(["checkout", "-b", "release", pinned.commit]);
    await ctx.git(["config", "--local", "branch.release.remote", "origin"]);
    await ctx.git(["config", "--local", "branch.release.merge", "refs/heads/release"]);
    const checked = await identity(ctx, selected, pinned.commit);
    if (checked.tree !== tree || checked.branch !== "release") throw new Error("Checked out release tree does not match FETCH_HEAD");
    await ctx.exec(bootstrapPython, ["-B", "-m", "pm.cli", "install"], 30 * 60 * 1000);
    const actual = source(selected);
    await probe(ctx, actual, "pm");
    await identity(ctx, actual, pinned.commit);
    return actual; // No completion, adapter, publication, or service operation here.
  }
  async function complete(selected, options = {}) {
    const { actual, initial } = candidate(selected), ctx = job(initial, actual, options);
    await health(ctx);
    const before = await identity(ctx, actual);
    await probe(ctx, actual, "pm");
    ctx.log("Running official source completion; caller must hold the maintenance window (config/skills migrations may occur)");
    await ctx.exec(bootstrapPython, ["-I", "-B", path.join(actual.root, "hermes_cli", "source_completion.py"), "--source", actual.root], 30 * 60 * 1000);
    await identity(ctx, actual, before.commit);
    return acceptance(ctx, actual);
  }
  async function verify(selected, options = {}) {
    const { actual, initial } = candidate(selected), ctx = job(initial, actual, options);
    await health(ctx);
    return acceptance(ctx, actual);
  }
  return { prepare, complete, verify };
}
