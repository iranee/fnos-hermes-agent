import { accessSync, constants, statSync } from "node:fs";
import { createKernelRuntime } from "./kernel-runtime.js";

// Official main.py strips --profile/-p before argparse. Its top-level parser also
// accepts value flags, abbreviations and short-option bundles before a command.
// Inspect only that prefix: "chat -q update" and "--model update chat" are NOT
// update commands. Never rewrite argv or apply a profile to the service socket.
const valueFlags = new Set(["--profile", "-p", "-z", "--oneshot", "-m", "--model", "--provider",
  "--reasoning", "-t", "--toolsets", "-r", "--resume", "-s", "--skills", "--usage-file", "--in", "--cpu-profile"]);
const optionalFlags = new Set(["-c", "--continue"]);
const switches = ["--help", "--version", "--no-restore-cwd", "--worktree", "--accept-hooks", "--yolo",
  "--pass-session-id", "--checkpoints", "--ignore-user-config", "--ignore-rules", "--safe-mode",
  "--tui", "--native", "--tui-native", "--cli", "--dev"];
const longFlags = [...valueFlags, ...optionalFlags, ...switches].filter(flag => flag.startsWith("--") && flag !== "--profile");
// main._coalesce_session_name_args joins unquoted names before these commands.
const sessionCommands = new Set(("chat model gateway setup whatsapp whatsapp-cloud login logout auth status cron doctor config pairing skills tools mcp " +
  "sessions insights update uninstall profile dashboard serve webapp desktop gui claw plugins security acp webhook peer memory dump debug backup import completion logs usage").split(" "));
function prefixedUpdate(args) {
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--") return args[i + 1] === "update";
    if (!token.startsWith("-")) return token === "update";
    if (token.startsWith("--profile=")) continue;
    let flag = token.split("=", 1)[0];
    let attached = token.includes("=");
    if (flag.startsWith("--") && !valueFlags.has(flag) && !optionalFlags.has(flag) && !switches.includes(flag)) {
      const matches = longFlags.filter(candidate => candidate.startsWith(flag));
      if (matches.length === 1) flag = matches[0];
    } else if (!flag.startsWith("--") && token.length > 2) {
      for (let j = 1; j < token.length; j++) {
        const short = `-${token[j]}`;
        if (valueFlags.has(short) || optionalFlags.has(short)) {
          flag = short; attached = j + 1 < token.length; break;
        }
        if (!["w", "V", "h"].includes(token[j])) break;
      }
    }
    if (attached) continue;
    if (["-r", "--resume", "-c", "--continue"].includes(token)) {
      let end = i + 1;
      while (end < args.length && !args[end].startsWith("-") && !sessionCommands.has(args[end])) end++;
      if (end > i + 1) { i = end - 1; continue; }
    }
    if (valueFlags.has(flag) || (optionalFlags.has(flag) && args[i + 1] !== undefined && !args[i + 1].startsWith("-"))) i++;
  }
  return false;
}

const args = process.argv.slice(2);
try {
  // fnos-proxy is application-scoped, not a native/profile command. It needs
  // only the private service socket, including when the selected kernel is broken.
  const runtime = args[0] === "fnos-proxy" ? null : createKernelRuntime({
    appDir: process.env.APP_DIR, dataDir: process.env.DATA_DIR, varDir: process.env.VAR_DIR,
  });
  if (args[0] !== "update" && prefixedUpdate(args)) {
    throw new Error("fnOS managed update does not support global/profile options before update; use hermes update directly through service coordination");
  }
  const informationalUpdate = args.length === 2 && ["--help", "-h", "--plan"].includes(args[1]);
  if (args[0] === "fnos-proxy") {
    const { runKernelProxyCli } = await import("./kernel-proxy-cli.js");
    process.exitCode = await runKernelProxyCli(args.slice(1), { varDir: process.env.VAR_DIR });
  } else if (args[0] === "update" && !informationalUpdate) {
    runtime.resolve();
    const { runKernelUpdateCli } = await import("./kernel-update-cli.js");
    process.exitCode = await runKernelUpdateCli(args.slice(1), { varDir: process.env.VAR_DIR });
  } else {
    if (args[0] === "update" && ["--help", "-h"].includes(args[1])) {
      console.error("fnOS: update --check | --initialize --yes | --yes | --status; add --wait to follow a submitted task. Updates run through application service coordination.");
    }
    const command = runtime.command(args);
    if (typeof process.execve !== "function") {
      throw new Error("Application Node runtime must support process.execve; no proxy process was started");
    }
    if (!statSync(command.executable).isFile()) throw new Error(`Not a runtime executable: ${command.executable}`);
    accessSync(command.executable, constants.X_OK);
    process.chdir(command.cwd);
    // argv[0] preserves native PID, descriptors and termination for non-update commands.
    process.execve(command.executable, [command.executable, ...command.args], command.env);
  }
} catch (error) {
  // A failed proxy module load must not expose paths/argv via the outer handler.
  console.error(args[0] === "fnos-proxy" ? "hermes fnos-proxy: 代理 CLI 无法运行，请检查应用安装。" : `hermes: ${error.message}`);
  process.exitCode = args[0] === "fnos-proxy" ? 1 : error.code === "ENOENT" ? 127 : error.code === "EACCES" ? 126 : 1;
}
