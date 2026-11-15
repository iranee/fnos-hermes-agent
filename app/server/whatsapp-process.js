import { spawn } from 'node:child_process';
import { validateBridgeUrl } from './vendor/whatsapp-bridge/proxy.js';

const owned = new WeakMap();
export const WHATSAPP_NETWORK_REQUIRED = '网络组件未初始化，请检查统一代理配置';
const failure = code => Object.assign(new Error({
  WA_TIMEOUT: 'WhatsApp 操作超时，已终止子进程',
  WA_CANCELLED: 'WhatsApp 操作已取消',
  WA_PROCESS: 'WhatsApp 子进程执行失败，请检查依赖与统一代理配置',
  WA_NETWORK: 'WhatsApp 网络组件请求失败，请检查统一代理配置',
}[code]), { code });

export function whatsappChildEnvironment(env, metadata) {
  if (!metadata || !['proxy', 'direct'].includes(metadata.mode)) throw failure('WA_NETWORK');
  const url = metadata.mode === 'proxy' ? validateBridgeUrl(metadata.bridgeUrl) : '';
  if (metadata.mode === 'direct' && metadata.bridgeUrl) throw failure('WA_NETWORK');
  const result = { ...env, WHATSAPP_NETWORK_MODE: metadata.mode, WHATSAPP_PROXY_URL: url };
  // Client-side bypasses must not outrank the bridge's NO_PROXY policy.
  for (const key of Object.keys(result)) {
    if (/^(?:(?:https?|all|no)_proxy|npm_config_(?:https?_proxy|proxy|noproxy|no_proxy))$/i.test(key)) delete result[key];
  }
  result.NO_PROXY = result.no_proxy = '';
  result.npm_config_noproxy = '';
  if (url) {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
      'npm_config_proxy', 'npm_config_https_proxy']) result[key] = url;
  }
  return result;
}

export function stopWhatsAppProcess(child) { owned.get(child)?.(); }

// Resolve startup with the child, but keep withEnvironment's callback alive until close.
// All failures are fixed messages; neither native stderr nor upstream exception text escapes.
export async function startWhatsAppProcess({ networkProxy, command, args, cwd, env,
  timeoutMs, signal, npm = false, spawnProcess = spawn }) {
  if (typeof networkProxy?.withEnvironment !== 'function') throw new Error(WHATSAPP_NETWORK_REQUIRED);
  const controller = new AbortController();
  let reason, child, killTimer, closed = false, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const stopChild = () => {
    if (!child || closed) return;
    // Never signal a PID after exit; close can lag exit while pipes are draining.
    if (child.exitCode != null || child.signalCode != null) return;
    try { child.kill('SIGTERM'); } catch {}
    killTimer ||= setTimeout(() => {
      if (!closed && child.exitCode == null && child.signalCode == null) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 1000);
    killTimer.unref?.();
  };
  const cancel = (code = 'WA_CANCELLED') => {
    reason ||= failure(code);
    controller.abort();
    stopChild();
  };
  const onAbort = () => cancel();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => cancel('WA_TIMEOUT'), timeoutMs);
  timer.unref?.();
  const done = (async () => {
    try {
      await networkProxy.withEnvironment({ ...env, PWD: cwd }, async (effectiveEnv, metadata) => {
        if (controller.signal.aborted) throw reason;
        const childEnv = whatsappChildEnvironment(effectiveEnv, metadata);
        const fullArgs = npm ? [...args, `--proxy=${childEnv.WHATSAPP_PROXY_URL}`,
          `--https-proxy=${childEnv.WHATSAPP_PROXY_URL}`, '--noproxy='] : args;
        await new Promise((resolve, reject) => {
          try {
            child = spawnProcess(command, fullArgs, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
          } catch { reject(failure('WA_PROCESS')); return; }
          owned.set(child, () => cancel());
          child.stderr?.on('data', () => {});
          if (npm) child.stdout?.on('data', () => {});
          child.once('spawn', () => resolveReady(child));
          child.once('error', () => { reason ||= failure('WA_PROCESS'); stopChild(); });
          child.once('close', code => {
            closed = true;
            clearTimeout(killTimer);
            owned.delete(child);
            if (reason || code !== 0) reject(reason || failure('WA_PROCESS'));
            else resolve();
          });
          if (controller.signal.aborted) stopChild();
        });
      }, { scope: 'initialization', signal: controller.signal });
    } catch (error) {
      throw reason || failure(error?.code === 'WA_PROCESS' ? 'WA_PROCESS' : 'WA_NETWORK');
    } finally {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
    }
  })();
  // Attach immediately: a preflight/spawn rejection must not become unhandled.
  done.catch(rejectReady);
  child = await ready;
  return { child, done, stop: () => cancel() };
}
