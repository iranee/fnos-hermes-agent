import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { requestKernelControl } from "./kernel-control-socket.js";

export async function runKernelUpdateCli(args, { varDir, input = process.stdin, output = process.stdout,
  errorOutput = process.stderr, request = requestKernelControl, pollMs = 1000 } = {}) {
  const flags = new Set(args);
  if (args.some(arg => !["--yes", "-y", "--check", "--initialize", "--status", "--wait"].includes(arg))) {
    throw new Error("fnOS managed update supports --check, --initialize, --status, --yes and --wait; other update modes cannot bypass service coordination");
  }
  const modes = ["--check", "--initialize", "--status"].filter(flag => flags.has(flag));
  if (modes.length > 1 || ((flags.has("--check") || flags.has("--status")) && flags.has("--wait"))) {
    throw new Error("Conflicting update options");
  }
  const call = (pathname, body) => request({ varDir, pathname, body });
  const show = value => output.write(`${JSON.stringify(value, null, 2)}\n`);
  if (flags.has("--status")) { show(await call("/api/hermes/update/status")); return 0; }
  if (flags.has("--check")) {
    const checked = await call("/api/hermes/update/check?force=true");
    show(checked);
    return checked.ok ? 0 : 1;
  }
  const kernel = await call("/api/hermes/kernel");
  const initialize = flags.has("--initialize") || kernel.kind === "package";
  if (flags.has("--initialize") && kernel.kind !== "package") throw new Error("A Git kernel is already initialized");
  let checked;
  if (!initialize) {
    checked = await call("/api/hermes/update/check?force=true");
    if (!checked.ok) throw new Error(checked.message || checked.error || "Official update check failed");
    if (!checked.updateAvailable) { show(checked); return 0; }
  }
  errorOutput.write(initialize
    ? "将准备官方 Git 内核并短暂停止应用服务；保留现有用户数据，初始化完成后可再次检查更新。\n"
    : "将由应用后台执行官方 Git 更新，短暂停止服务并按原状态恢复。\n");
  if (!flags.has("--yes") && !flags.has("-y")) {
    if (!input.isTTY || !output.isTTY) throw new Error("Use hermes update --yes to explicitly approve a managed background task");
    const prompt = createInterface({ input, output });
    let answer;
    try { answer = await prompt.question("继续？[y/N] "); } finally { prompt.close(); }
    if (!/^y(es)?$/i.test(answer.trim())) return 1;
  }
  const accepted = await call(initialize ? "/api/hermes/initialize" : "/api/hermes/update",
    initialize ? {} : { targetSha: checked.targetSha });
  if (!accepted.ok || !accepted.job?.id) throw new Error("Kernel control did not acknowledge a background task; inspect update status before retrying");
  show(accepted);
  errorOutput.write("任务已提交；可在面板更新页或 hermes update --status 查看。关闭此终端不会取消后台任务。\n");
  if (!flags.has("--wait")) return 0;
  let after = 0;
  for (;;) {
    const status = await call(`/api/hermes/update/status?after=${after}`);
    if (!status.ok || status.job?.id !== accepted.job.id) throw new Error("Background update identity changed; inspect the update page");
    for (const line of status.lines || []) output.write(`${line.time} ${line.text}\n`);
    after = status.next;
    if (status.job.state === "succeeded") return 0;
    if (["failed", "interrupted"].includes(status.job.state)) {
      const detail = status.job.error;
      const message = typeof detail === "string" ? detail : detail?.message;
      const code = typeof detail?.code === "string" ? detail.code : undefined;
      const error = new Error(`${code ? `${code}: ` : ""}${typeof message === "string" && message ? message : "Background update failed"}`);
      if (code) error.code = code;
      throw error;
    }
    await sleep(pollMs);
  }
}
