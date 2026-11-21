import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NAMES = ["SOUL.md", "AGENTS.md"];
const MAX_BYTES = 1024 * 1024;

function read(path, limit = MAX_BYTES) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > limit) return null;
    return readFileSync(path);
  } catch { return null; }
}

// 只读取 dataDir 下用户的 SOUL.md / AGENTS.md，所有写入都落在 varDir。
export function createPromptTemplates({ appDir, dataDir, varDir, log = () => {} }) {
  const templateDir = join(appDir, "config", "prompts");
  const baseDir = join(varDir, "prompt-templates-base");
  const stateFile = join(varDir, "prompt-templates.json");
  const ackFile = join(varDir, "prompt-templates.ack");
  let reported;

  function write(path, data) {
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, data, { mode: 0o644 });
      renameSync(tmp, path);
      return true;
    } catch (error) {
      try { unlinkSync(tmp); } catch {}
      log(`[规则模板] 写入 ${path} 失败：${error.message}`);
      return false;
    }
  }

  function inspect() {
    const templates = [];
    const hash = createHash("sha256");
    for (const name of NAMES) {
      const content = read(join(templateDir, name));
      if (!content) continue;
      hash.update(`${name}\0${content.length}\0`).update(content);
      templates.push({ name, content });
    }
    if (!templates.length) return null;
    const id = hash.digest("hex").slice(0, 12);
    const acked = (read(ackFile, 64)?.toString("utf8").trim() ?? "") === id;

    const files = [];
    for (const { name, content } of templates) {
      const basePath = join(baseDir, name);
      const local = read(join(dataDir, name));
      let base = read(basePath);
      const same = local !== null && local.equals(content);
      if ((acked || same) && !base?.equals(content)) {
        try { mkdirSync(baseDir, { recursive: true, mode: 0o755 }); } catch {}
        if (write(basePath, content)) base = content;
      }
      const settled = base?.equals(content) === true;
      files.push({
        name,
        changed: !acked && local !== null && !same && !settled,
        template: join(templateDir, name),
        previous: base && !settled ? basePath : null,
        local: join(dataDir, name),
      });
    }
    return { id, pending: files.some(file => file.changed), ack: ackFile, files };
  }

  function refresh() {
    try {
      const state = inspect();
      if (!state) return null;
      const text = `${JSON.stringify(state, null, 2)}\n`;
      if (read(stateFile)?.toString("utf8") !== text) write(stateFile, text);
      const mark = `${state.id}:${state.pending}`;
      if (mark !== reported) {
        reported = mark;
        const names = state.files.filter(file => file.changed).map(file => file.name).join("、");
        log(state.pending
          ? `[规则模板] 随包模板 ${state.id} 与本地 ${names} 不同，等 Hermes 在对话里询问用户是否合并`
          : `[规则模板] 随包模板 ${state.id} 无待处理更新`);
      }
      return state;
    } catch (error) {
      log(`[规则模板] 检查失败：${error.message}`);
      return null;
    }
  }

  return { refresh };
}
