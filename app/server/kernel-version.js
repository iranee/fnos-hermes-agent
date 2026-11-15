import { execFile } from "node:child_process";
import { promisify } from "node:util";

const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const KEYS = ["kind", "id", "root", "launcher"];

export function formatKernelVersion(value) {
  if (!value || typeof value.version !== "string" || value.version.length > 128
    || value.version.trim() !== value.version || !SEMVER.test(value.version) || /^\d{4}\./.test(value.version) || value.version === "0.0.0"
    || typeof value.commit !== "string" || value.commit.length !== 40 || !/^[a-f0-9]{40}$/i.test(value.commit)) return null;
  let date = null;
  const match = typeof value.releaseDate === "string" && value.releaseDate.match(/^(\d{4})[.-](\d{1,2})[.-](\d{1,2})$/);
  if (match) {
    const [year, month, day] = match.slice(1).map(Number);
    const checked = new Date(Date.UTC(year, month - 1, day));
    if (checked.getUTCFullYear() === year && checked.getUTCMonth() === month - 1 && checked.getUTCDate() === day) {
      date = `${year}.${month}.${day}`;
    }
  }
  const short = `v${value.version}${date ? ` (${date})` : ""}`;
  return { version: value.version, releaseDate: date, commit: value.commit,
    short, full: `${short} · upstream ${value.commit.slice(0, 8)}` };
}

export function createKernelVersion({ runtime, execute = promisify(execFile), now = Date.now }) {
  let cached;
  let request = 0;
  async function read({ fresh = false } = {}) {
    const sequence = ++request;
    try {
      const selected = { ...runtime.resolve() };
      const same = other => other && KEYS.every(key => other[key] === selected[key]);
      if (!fresh && cached && same(cached.selected) && now() - cached.at < 15000) return cached.value;
      const home = runtime.environment(selected).HERMES_HOME;
      const command = runtime.command(["--home", home, "version"], { helper: "webapp-control", selected });
      const { stdout } = await execute(command.executable, command.args, {
        cwd: command.cwd, env: { ...command.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        timeout: 12000, maxBuffer: 65536, encoding: "utf8", shell: false,
      });
      const result = JSON.parse(stdout);
      if (result.ok !== true || result.result?.root !== selected.root || !same(runtime.resolve())) return null;
      const value = formatKernelVersion(result.result);
      if (sequence === request) cached = value ? { selected, at: now(), value } : null;
      return value;
    } catch {
      if (sequence === request) cached = null;
      return null;
    }
  }
  return { read };
}
