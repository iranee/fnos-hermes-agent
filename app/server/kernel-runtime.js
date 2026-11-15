import { lstatSync, statSync, readFileSync, realpathSync, symlinkSync, appendFileSync,
  openSync, writeFileSync, fsyncSync, linkSync, unlinkSync, closeSync, fstatSync, fchmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

const GENERATION = /^[a-f0-9]{32}$/;
const ADAPTER = "fnos_app_runtime.py";
const CLEAN_ENV = ["PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "HERMES_RUNTIME_DIR", "HERMES_PYTHON",
  "HERMES_PYTHON_SRC_ROOT", "HERMES_NODE", "HERMES_TUI_DIR", "HERMES_WEBAPP_DIST", "HERMES_WEB_DIST",
  "HERMES_DISABLE_LAZY_INSTALLS", "FNOS_KERNEL_ID", "FNOS_KERNEL_ROOT", "FNOS_LAUNCH_TOKEN", "FNOS_LAUNCH_ROLE"];

function absolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) === path.parse(value).root) {
    throw new Error(`${name} must be an explicit absolute directory`);
  }
  return path.resolve(value);
}
function directory(value) {
  if (!lstatSync(value).isDirectory()) throw new Error(`Not a real directory: ${value}`);
}
function regular(value, executable = false) {
  const info = lstatSync(value);
  if (!info.isFile() || (executable && !(info.mode & 0o111))) throw new Error(`Invalid runtime file: ${value}`);
}
function optional(value) {
  try { return lstatSync(value); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function createKernelRuntime({ appDir, dataDir, varDir, env = process.env }) {
  appDir = absolute(appDir, "APP_DIR");
  dataDir = absolute(dataDir, "DATA_DIR");
  varDir = absolute(varDir, "VAR_DIR");
  const kernels = path.join(dataDir, "kernels");
  const activeFile = path.join(kernels, "active.json");
  const adapter = path.join(appDir, "server", "fnos-runtime.py");

  function generation(id) {
    if (typeof id !== "string" || !GENERATION.test(id)) throw new Error("Invalid kernel generation identifier");
    directory(dataDir);
    const generationDir = path.join(kernels, id);
    const root = path.join(generationDir, "src");
    for (const dir of [kernels, generationDir, root, path.join(root, ".git"),
      path.join(root, ".hermes"), path.join(root, ".hermes", "bin")]) directory(dir);
    const launcher = path.join(root, ".hermes", "bin", "hermes");
    regular(launcher, true);
    return { kind: "source", id, root, launcher };
  }
  function resolve() {
    directory(dataDir);
    const parent = optional(kernels);
    if (parent && !parent.isDirectory()) throw new Error("Kernel storage is not a real directory");
    const active = parent && optional(activeFile);
    if (!active) return { kind: "package", id: "package", root: path.join(appDir, "hermes-src"),
      launcher: path.join(dataDir, "venv", "bin", "hermes") };
    if (!active.isFile()) throw new Error("Kernel selection is not a regular file");
    let state;
    try { state = JSON.parse(readFileSync(activeFile, "utf8")); }
    catch (error) { throw new Error(`Cannot read active kernel selection: ${error.message}`); }
    if (!state || state.schema !== 1 || Object.keys(state).some(key => !["schema", "id"].includes(key))) {
      throw new Error("Invalid active kernel selection; refusing to load a different kernel");
    }
    return generation(state.id);
  }
  function prepareAdapter(selected) {
    if (selected.kind !== "source") return;
    const source = generation(selected.id);
    if (source.root !== selected.root) throw new Error("Kernel root changed");
    regular(adapter);
    const git = spawnSync("git", ["--no-optional-locks", "-C", source.root, "ls-files", "--error-unmatch", "--", ADAPTER], {
      encoding: "utf8", timeout: 10000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (git.error) throw git.error;
    if (git.status !== 1) throw new Error("Cannot reserve the fnOS adapter without changing tracked upstream files");
    const link = path.join(source.root, ADAPTER);
    const old = optional(link);
    if (old) {
      if (!old.isSymbolicLink() || realpathSync(link) !== realpathSync(adapter)) throw new Error("Kernel adapter path is already occupied");
    } else symlinkSync(adapter, link);
    const info = path.join(source.root, ".git", "info");
    directory(info);
    const exclude = path.join(info, "exclude");
    const existing = optional(exclude);
    if (existing && !existing.isFile()) throw new Error("Git exclusion list is not a regular file");
    const contents = existing ? readFileSync(exclude, "utf8") : "";
    if (!contents.split(/\r?\n/).includes(`/${ADAPTER}`)) appendFileSync(exclude, `${contents.endsWith("\n") || !contents ? "" : "\n"}/${ADAPTER}\n`);
  }
  // The caller owns build/health acceptance and the maintenance window, not this publisher.
  function publishInitial(selected) {
    if (!selected || selected.kind !== "source") throw new Error("Initial selection must be a source generation");
    const source = generation(selected.id);
    if (Object.keys(selected).length !== Object.keys(source).length ||
      Object.keys(source).some(key => selected[key] !== source[key])) {
      throw new Error("Initial selection must exactly match the source generation");
    }
    regular(adapter);
    command([], { helper: "model-config", selected: source }); // Validate only; never prepare or execute.
    const temporary = path.join(kernels, `.active-${randomUUID()}.tmp`);
    let fileFd, directoryFd, ownsTemporary = false, published = false;
    const errors = [];
    try {
      directoryFd = openSync(kernels, "r");
      fileFd = openSync(temporary, "wx", 0o600);
      ownsTemporary = true;
      if (process.platform !== "win32") {
        // fnOS may inherit directory permissions; correct only our new, empty descriptor.
        if ((fstatSync(fileFd).mode & 0o777) !== 0o600) fchmodSync(fileFd, 0o600);
        if ((fstatSync(fileFd).mode & 0o777) !== 0o600) throw new Error("Cannot create a private kernel selection");
      }
      writeFileSync(fileFd, JSON.stringify({ schema: 1, id: source.id }) + "\n", "utf8");
      fsyncSync(fileFd);
      // Unlike rename, link atomically refuses every existing destination, including symlinks.
      linkSync(temporary, activeFile);
      published = true;
      fsyncSync(directoryFd);
    } catch (error) {
      errors.push(error);
    } finally {
      if (ownsTemporary) {
        try { unlinkSync(temporary); } catch (error) { errors.push(error); }
      }
      for (const fd of [fileFd, directoryFd]) {
        if (fd !== undefined) {
          try { closeSync(fd); } catch (error) { errors.push(error); }
        }
      }
    }
    if (errors.length) {
      if (!published && errors.length === 1) throw errors[0];
      const status = published ? `Kernel selection is already published at ${activeFile}; persistence/cleanup failed; no rollback` :
        "Kernel selection was not published by this call; operation/cleanup failed";
      const error = new AggregateError(errors, `${status}: ${errors.map(item => item.message).join("; ")}`);
      error.selectionPublished = published;
      throw error;
    }
    return source;
  }
  function environment(selected = resolve(), supplied) {
    const result = { ...env, ...(supplied || {}) };
    // Private ELF dependencies belong to the application, never DATA or the host.
    // Validate on every invocation, including dangling links; old packages without lib remain valid.
    if (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) {
      const libRoot = path.join(appDir, "lib"), libDir = path.join(libRoot, process.arch);
      if (optional(libRoot)) {
        directory(libRoot);
        if (optional(libDir)) {
          directory(libDir);
          regular(path.join(libDir, "libatomic.so.1"));
          // ld.so uses ':' (and ';'), and an empty element searches the current directory.
          const inherited = (result.LD_LIBRARY_PATH || "").split(/[:;]/).filter(Boolean);
          result.LD_LIBRARY_PATH = [libDir, ...inherited.filter(dir => dir !== libDir)].join(":");
        }
      }
    }
    for (const name of CLEAN_ENV) delete result[name];
    Object.assign(result, { APP_DIR: appDir, DATA_DIR: dataDir, VAR_DIR: varDir, HOME: dataDir,
      USERPROFILE: dataDir, HERMES_HOME: dataDir, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
      PYTHONIOENCODING: "utf-8", XDG_CONFIG_HOME: path.join(dataDir, ".config"), XDG_CACHE_HOME: path.join(dataDir, ".cache"),
      XDG_DATA_HOME: path.join(dataDir, ".local", "share"), XDG_STATE_HOME: path.join(dataDir, ".local", "state") });
    const node = path.join(dataDir, "node", "bin", "node");
    const hasNode = optional(node) && statSync(node).isFile() && (statSync(node).mode & 0o111);
    const bins = [path.join(appDir, "bin")];
    if (selected.kind === "package") {
      bins.push(path.join(dataDir, "venv", "bin"));
      Object.assign(result, { PYTHONPATH: selected.root, HERMES_TUI_DIR: path.join(appDir, "tui"),
        HERMES_WEBAPP_DIST: path.join(selected.root, "apps", "desktop", "dist-webapp"),
        HERMES_WEB_DIST: path.join(selected.root, "hermes_cli", "web_dist") });
      if (hasNode) result.HERMES_NODE = node;
    } else {
      result.FNOS_KERNEL_ID = selected.id;
      result.FNOS_KERNEL_ROOT = selected.root;
    }
    if (hasNode) bins.push(path.dirname(node));
    const inherited = (result.PATH || "").split(path.delimiter).filter(dir => dir &&
      dir !== path.join(dataDir, "venv", "bin") && !dir.startsWith(kernels + path.sep));
    result.PATH = [...new Set([...bins, ...inherited])].join(path.delimiter);
    return result;
  }
  function command(args, { helper, selected = resolve() } = {}) {
    if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new Error("Invalid runtime arguments");
    if (helper && !["webapp-control", "model-config", "source-check"].includes(helper)) throw new Error("Unknown runtime helper");
    let executable = selected.launcher;
    let argv = [...args];
    if (selected.kind === "source" && helper) {
      const link = path.join(selected.root, ADAPTER);
      if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== realpathSync(adapter)) throw new Error("Kernel helper adapter is missing or changed");
      argv = ["--run-module", "fnos_app_runtime", helper, ...args];
    } else if (selected.kind === "package") {
      executable = path.join(dataDir, "venv", "bin", "python");
      argv = helper ? [path.join(appDir, "server", `${helper}.py`), ...args] : ["-m", "hermes_cli.main", ...args];
    }
    return { executable, args: argv, cwd: selected.kind === "source" ? selected.root : dataDir, env: environment(selected), selected };
  }
  return { resolve, generation, prepareAdapter, publishInitial, environment, command, activeFile };
}
