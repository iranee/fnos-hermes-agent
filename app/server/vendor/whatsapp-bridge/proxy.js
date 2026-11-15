// Explicit per-process proxy snapshot. No global fetch/dispatcher or environment override.
export function validateBridgeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.href;
  } catch {
    throw new Error('WhatsApp 本地代理地址无效');
  }
}

export async function createWhatsAppProxy(env = process.env, { required = false } = {}) {
  const mode = env.WHATSAPP_NETWORK_MODE;
  if (!env.WHATSAPP_PROXY_URL && (mode === 'direct' || (!required && !mode))) {
    return { socketOptions: {}, fetchOptions: {}, mediaOptions: {}, close: async () => {} };
  }
  if (mode !== 'proxy') throw new Error('WhatsApp 网络组件未初始化');
  const url = validateBridgeUrl(env.WHATSAPP_PROXY_URL);
  const [{ HttpsProxyAgent }, { ProxyAgent, Dispatcher1Wrapper }] = await Promise.all([
    import('https-proxy-agent'), import('undici'),
  ]);
  const agent = new HttpsProxyAgent(url);
  // Undici 8 uses the v2 handler API; Node 22/24 native fetch still sends v1 handlers.
  // Its public compatibility wrapper supports both, without replacing global fetch.
  const dispatcher = new Dispatcher1Wrapper(new ProxyAgent(url));
  return {
    socketOptions: { agent, fetchAgent: agent, options: { dispatcher } },
    fetchOptions: { dispatcher },
    // Baileys downloadMediaMessage -> downloadContentFromMessage -> options.
    mediaOptions: { options: { dispatcher } },
    async close() { agent.destroy(); await dispatcher.destroy(); },
  };
}
