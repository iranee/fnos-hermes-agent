/* fnOS 面板注入内置 Hermes WebApp 的界面补丁（由 webapp-proxy 注入，不改动 hermes-src）。
   处理界面，并在 browser 宿主停用后端更新检查与升级。不拦其他 API，不改变鉴权。
   每条修补标注上游版本与依赖的 DOM 结构，上游更新后逐条核对。
   对应样式在 patch.css。window.__fnosWebappPatch.diag() 可在控制台查看布局诊断。 */
(function () {
  'use strict';
  if (window.__fnosWebappPatch) return;

  const VERSION = '8';
  const TAG = '[fnos-webapp-patch]';
  const touchQuery = window.matchMedia ? window.matchMedia('(hover: none), (pointer: coarse)') : null;
  const narrowQuery = window.matchMedia ? window.matchMedia('(max-width: 639.98px)') : null;
  const browserHost = () => document.documentElement.getAttribute('data-hermes-desktop-host') === 'browser';
  const touchLayout = () => browserHost() && Boolean(touchQuery && touchQuery.matches);

  function syncVoiceEntries() {
    const available = window.parent === window && touchQuery && narrowQuery && !touchQuery.matches && !narrowQuery.matches;
    document.documentElement.setAttribute('data-fnos-voice-entries', available ? 'available' : 'hidden');
  }
  touchQuery?.addEventListener?.('change', syncVoiceEntries);
  narrowQuery?.addEventListener?.('change', syncVoiceEntries);
  syncVoiceEntries();

  function readStorage(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  // 上游先读取已保存的 display.language。只有未选语言时才使用这个界面默认值，不写配置。
  function patchBrowserLocale(bridge) {
    if (!browserHost() || !bridge || !['object', 'function'].includes(typeof bridge) ||
        typeof bridge.api !== 'function' || 'getMachineProfile' in bridge || !Object.isExtensible(bridge)) return;
    bridge.getMachineProfile = async () => ({ locale: browserHost() ? 'zh' : null });
  }
  /* ---- 修补 4：v0.23.1 browser 宿主停用后端更新检查与升级 ----
     WebApp 右下角后端面板与设置「关于」里的 backend UpdateStatusCard 会请求
     GET /api/hermes/update/check（每次都会访问 GitHub），更新按钮会 POST /api/hermes/update。
     browser 宿主下这两个精确路径一律直接拒绝，不发网络请求；升级只走管理面板「更新」页。
     状态、回执和其他 API 原样放行；服务端 monitor 也会拒绝 /webapp 下这两个路由。 */
  const UPDATE_CHECK_PATH = '/api/hermes/update/check';
  const UPDATE_APPLY_PATH = '/api/hermes/update';
  const DISABLED_MESSAGE = '后端更新已停用，请在 Hermes 管理面板的「更新」页面检查和升级 Hermes。';
  const DISABLED_CODE = 'FNOS_UPDATE_DISABLED';
  const updateBridges = new WeakMap();

  function blockedUpdateRequest(request) {
    if (!request || typeof request.path !== 'string') return false;
    const path = request.path.split('?')[0];
    const method = request.method === undefined ? 'GET' : String(request.method).toUpperCase();
    return (path === UPDATE_CHECK_PATH && method === 'GET') || (path === UPDATE_APPLY_PATH && method === 'POST');
  }
  function patchBrowserUpdateChecks(bridge) {
    if (!browserHost() || !bridge || !['object', 'function'].includes(typeof bridge) ||
        typeof bridge.api !== 'function' || updateBridges.get(bridge) === bridge.api) return;
    const original = bridge.api;
    const wrapped = function (...args) {
      if (!browserHost() || !blockedUpdateRequest(args[0])) return original.apply(this, args);
      const error = new Error(DISABLED_MESSAGE);
      error.code = DISABLED_CODE;
      return Promise.reject(error);
    };
    try {
      bridge.api = wrapped;
      if (bridge.api === wrapped) updateBridges.set(bridge, wrapped);
    } catch { /* 不可写的 native bridge 不改动。 */ }
  }
  const clientUpdateBridges = new WeakMap();
  function patchBrowserClientUpdates(bridge) {
    const updates = bridge?.updates;
    if (!browserHost() || !updates || !['object', 'function'].includes(typeof updates) ||
        typeof updates.check !== 'function' || clientUpdateBridges.get(updates) === updates.check) return;
    const original = updates.check;
    const wrapped = function (...args) {
      const result = original.apply(this, args);
      if (!browserHost()) return result;
      return Promise.resolve(result).then(status => browserHost() && status?.reason === 'browser-hosted'
        ? { ...status, message: '请在 Hermes 管理面板的「更新」页面升级 Hermes。' } : status);
    };
    try {
      updates.check = wrapped;
      if (updates.check === wrapped) clientUpdateBridges.set(updates, wrapped);
    } catch { /* 不可写的 bridge 保持原样。 */ }
  }
  function patchBrowserBridge(bridge) {
    patchBrowserLocale(bridge);
    patchBrowserUpdateChecks(bridge);
    patchBrowserClientUpdates(bridge);
  }
  const desktopProperty = Object.getOwnPropertyDescriptor(window, 'hermesDesktop');
  if ((!desktopProperty && !('hermesDesktop' in window)) ||
      (desktopProperty && desktopProperty.configurable && 'value' in desktopProperty && desktopProperty.writable)) {
    let bridge = desktopProperty?.value;
    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      enumerable: desktopProperty ? desktopProperty.enumerable : true,
      get() {
        patchBrowserBridge(bridge);
        return bridge;
      },
      set(value) {
        bridge = value;
        patchBrowserBridge(bridge);
      },
    });
  }
  patchBrowserBridge(window.hermesDesktop);
  // bridge 与宿主标记的到达顺序不固定。只在确认 browser 后补方法。
  new MutationObserver(() => patchBrowserBridge(window.hermesDesktop)).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-hermes-desktop-host'],
  });

  // backend 卡片结构：首行 + 含「立即检查」(textStrong + refresh 图标) 的操作区。client 卡片没有操作区，不受影响。
  // 原内容与按钮由 CSS 隐藏（不删除 React 节点），只追加一行当前后端版本。
  function backendUpdateCard(card) {
    const row = card.firstElementChild;
    const actions = card.querySelector(':scope > div.mt-3.flex.flex-wrap.items-center.gap-4');
    return Boolean(row?.matches('div.flex.items-start.gap-2') && row !== actions &&
      row.querySelector(':scope > div.min-w-0 > p.font-medium') &&
      actions?.querySelector(':scope > button[data-slot="button"][data-variant="textStrong"] > svg.tabler-icon-refresh'));
  }
  // browser 宿主的 getVersion 读健康接口的 displayVersion，与设置「关于」里的后端版本同源；不经过被拒绝的更新检查。
  let backendVersion = null, backendVersionRequest = null, backendVersionAt = 0;
  function backendVersionText() {
    if (backendVersion) return '当前版本 v' + backendVersion.replace(/^v/i, '');
    return backendVersion === null ? '当前版本' : '当前版本未知';
  }
  function requestBackendVersion() {
    const bridge = window.hermesDesktop;
    if (backendVersion || backendVersionRequest || !bridge || typeof bridge.getVersion !== 'function' ||
        Date.now() - backendVersionAt < 10000) return;
    backendVersionAt = Date.now();
    backendVersionRequest = Promise.resolve().then(() => bridge.getVersion()).then(info => {
      const value = info && typeof info === 'object' ? (info.backendVersion || info.appVersion) : '';
      backendVersion = typeof value === 'string' ? value.trim() : '';
    }, () => { backendVersion = ''; }).then(() => {
      backendVersionRequest = null;
      syncUpdateCards();
    });
  }
  function syncUpdateCards() {
    for (const card of document.querySelectorAll('div.rounded-xl.border.px-4.py-3.text-sm, [data-fnos-update-disabled]')) {
      const existing = card.querySelector(':scope > [data-fnos-update-view]');
      if (!browserHost() || !backendUpdateCard(card)) {
        existing?.remove();
        card.removeAttribute('data-fnos-update-disabled');
        continue;
      }
      if (!card.hasAttribute('data-fnos-update-disabled')) card.setAttribute('data-fnos-update-disabled', '');
      if (!backendVersion) requestBackendVersion();
      const text = backendVersionText();
      if (existing) {
        if (existing.firstElementChild && existing.firstElementChild.textContent !== text) existing.firstElementChild.textContent = text;
        continue;
      }
      const view = document.createElement('div');
      view.setAttribute('data-fnos-update-view', '');
      view.setAttribute('role', 'status');
      const line = document.createElement('p');
      line.className = 'font-medium';
      line.textContent = text;
      view.appendChild(line);
      card.appendChild(view);
    }
  }
  new MutationObserver(syncUpdateCards).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['data-hermes-desktop-host', 'class'],
  });
  syncUpdateCards();

  /* ---- 修补 5：v0.23.1 compact ModelPill + 关联菜单的手机搜索 ----
     tile 没有 data-tour，故在 composer-root 内核对 aria-label 模板、trigger 和 ChevronDown。
     当前名字只来自每个 pill 自己的 aria-label；不读取 session globals 或 React 内部。 */
  // 宽屏 pill 外层包了 Tip，asChild 合并后 data-slot 变成 tooltip-trigger。
  const MODEL_TRIGGER = '[data-slot="composer-root"] button:is([data-slot="dropdown-menu-trigger"], [data-slot="tooltip-trigger"])[aria-haspopup="menu"][aria-label]';
  const PIN_SUFFIX = / — (?:已由你固定；新对话将使用此模型而非“设置”中的默认模型|pinned by you; new chats use this instead of the Settings default)$/;
  function modelName(pill) {
    if (!pill?.matches(MODEL_TRIGGER) || !pill.querySelector(':scope > svg.tabler-icon-chevron-down')) return null;
    const title = (pill.getAttribute('aria-label') || '').replace(PIN_SUFFIX, '');
    return /^(?:模型|Model) · [\s\S]+: ([\s\S]+)$/.exec(title)?.[1]?.trim() || null;
  }
  function linkedModelMenu(input) {
    if (!(input instanceof HTMLInputElement) || !input.matches('[data-slot="dropdown-menu-search"] > input[type="text"]')) return null;
    const menu = input.closest('[data-slot="dropdown-menu-content"][role="menu"]');
    if (!menu) return null;
    const labels = (menu.getAttribute('aria-labelledby') || '').split(/\s+/);
    for (const pill of document.querySelectorAll(MODEL_TRIGGER)) {
      if (!modelName(pill)) continue;
      const controls = pill.getAttribute('aria-controls');
      if (controls && menu.id !== controls) continue;
      if ((controls && menu.id === controls) || (pill.id && labels.includes(pill.id))) return menu;
    }
    return null;
  }
  // 浏览器宿主下打开模型菜单不自动聚焦搜索框（桌面与手机一致）。只拦挂载那一次 autoFocus：
  // 「添加自定义模型」复用同一 input 并在 setTimeout 里 focus()，挂载之后的 focus 必须放行。
  const mobileModelInput = input => browserHost() && linkedModelMenu(input);
  // React commitMount 的 autoFocus 早于 MutationObserver 给 input 打标记，未打标记即挂载期。
  // 仅为精确关联 input 返回实例 guard，其他 input 的 focus 仍是原函数。
  const inputFocusDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'focus');
  const originalInputFocus = HTMLInputElement.prototype.focus;
  const inputFocusGuards = new WeakMap();
  if (!inputFocusDescriptor || inputFocusDescriptor.configurable) {
    Object.defineProperty(HTMLInputElement.prototype, 'focus', {
      configurable: true,
      enumerable: inputFocusDescriptor?.enumerable || false,
      get() {
        if (!mobileModelInput(this)) return originalInputFocus;
        let guard = inputFocusGuards.get(this);
        if (!guard) {
          const input = this;
          guard = function (...args) {
            if (this === input && !input.hasAttribute('data-fnos-model-search') && mobileModelInput(input)) return;
            return originalInputFocus.apply(this, args);
          };
          inputFocusGuards.set(input, guard);
        }
        return guard;
      },
      set(value) { Object.defineProperty(this, 'focus', { configurable: true, writable: true, value }); },
    });
  }
  function syncModelPills() {
    for (const pill of document.querySelectorAll(MODEL_TRIGGER + ', [data-fnos-model-pill]')) {
      const name = browserHost() && modelName(pill);
      let label = pill.querySelector(':scope > [data-fnos-model-name]');
      // 非 compact 已有原生 span。只扩展原 compact square，不重复原标签。
      const compact = ![...pill.children].some(child => child !== label && child.tagName !== 'svg');
      if (!name || !compact) {
        label?.remove();
        pill.removeAttribute('data-fnos-model-pill');
        continue;
      }
      if (!pill.hasAttribute('data-fnos-model-pill')) pill.setAttribute('data-fnos-model-pill', '');
      if (!label) {
        label = document.createElement('span');
        label.setAttribute('data-fnos-model-name', '');
        label.setAttribute('aria-hidden', 'true');
        pill.prepend(label);
      }
      if (label.textContent !== name) label.textContent = name;
    }
    const menus = new Set();
    for (const input of document.querySelectorAll('[data-slot="dropdown-menu-search"] > input, [data-fnos-model-search]')) {
      const matched = browserHost() && linkedModelMenu(input);
      if (matched && !input.hasAttribute('data-fnos-model-search')) input.setAttribute('data-fnos-model-search', '');
      else if (!matched) input.removeAttribute('data-fnos-model-search');
      if (matched) menus.add(matched);
    }
    for (const menu of document.querySelectorAll('[data-fnos-model-menu]')) {
      if (!menus.has(menu)) menu.removeAttribute('data-fnos-model-menu');
    }
    for (const menu of menus) if (!menu.hasAttribute('data-fnos-model-menu')) menu.setAttribute('data-fnos-model-menu', '');
    // 长按模型行弹出的二级菜单是独立 portal，按 aria-labelledby 找回所属模型菜单一起放大。
    for (const sub of document.querySelectorAll('[data-slot="dropdown-menu-sub-content"][role="menu"]')) {
      const trigger = document.getElementById(sub.getAttribute('aria-labelledby') || '');
      const owned = browserHost() && !!trigger?.closest('[data-fnos-model-menu], [data-fnos-model-submenu]');
      if (owned && !sub.hasAttribute('data-fnos-model-submenu')) sub.setAttribute('data-fnos-model-submenu', '');
      else if (!owned) sub.removeAttribute('data-fnos-model-submenu');
    }
    for (const button of document.querySelectorAll('[data-fnos-model-close]')) {
      if (!button.parentElement?.querySelector(':scope > input[data-fnos-model-search]')) button.remove();
    }
    for (const input of document.querySelectorAll('input[data-fnos-model-search]')) {
      const box = input.parentElement;
      if (box.querySelector(':scope > [data-fnos-model-close]')) continue;
      const zh = /^搜索|^输入/.test(input.placeholder || '') || document.documentElement.lang?.startsWith('zh');
      const close = document.createElement('button');
      close.type = 'button';
      close.tabIndex = -1;
      close.setAttribute('data-fnos-model-close', '');
      close.setAttribute('aria-label', zh ? '关闭' : 'Close');
      close.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
      // Radix 在 document 上监听 Escape 关闭菜单并把焦点还给模型按钮，与键盘关闭同路径。
      close.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      });
      box.appendChild(close);
    }
  }
  narrowQuery?.addEventListener?.('change', syncModelPills);
  new MutationObserver(syncModelPills).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['data-hermes-desktop-host', 'data-slot', 'data-tour', 'aria-label', 'aria-controls', 'aria-labelledby', 'id'],
  });
  syncModelPills();
  // iPhone Safari 会丢掉模型菜单里单次点按的合成 click（长按仍可用），上游只给对话输入框补了 touchend 聚焦。
  // 菜单内的短点按改在 touchend 里直接激活，并取消浏览器随后的合成鼠标事件，安卓上不会重复触发。
  const MODEL_MENUS = '[data-fnos-model-menu], [data-fnos-model-submenu]';
  const TAP_MOVE_PX = 10;
  let menuTap = null;
  const tapMoved = (from, touch) => Math.hypot(touch.clientX - from.x, touch.clientY - from.y) > TAP_MOVE_PX;
  document.addEventListener('touchstart', event => {
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    const target = event.target instanceof Element ? event.target : null;
    menuTap = touch && target?.closest(MODEL_MENUS) && touchLayout()
      ? { at: event.timeStamp, x: touch.clientX, y: touch.clientY, target } : null;
  }, { capture: true, passive: true });
  document.addEventListener('touchmove', event => {
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    if (menuTap && (!touch || tapMoved(menuTap, touch))) menuTap = null;
  }, { capture: true, passive: true });
  document.addEventListener('touchcancel', () => { menuTap = null; }, true);
  document.addEventListener('touchend', event => {
    const began = menuTap;
    menuTap = null;
    const touch = event.changedTouches[0];
    if (!began || !touch || event.touches.length || event.defaultPrevented) return;
    if (tapMoved(began, touch) || event.timeStamp - began.at > 500) return;
    const menu = began.target.closest(MODEL_MENUS);
    const input = began.target.closest('input');
    const control = input || began.target.closest('button, [role^="menuitem"]');
    if (!menu?.isConnected || !control || !menu.contains(control)) return;
    if (control.matches(':disabled, [aria-disabled="true"], [data-disabled]')) return;
    // 已聚焦的输入框交给浏览器移动光标。
    if (input && document.activeElement === input) return;
    const hit = document.elementFromPoint(touch.clientX, touch.clientY);
    if (!hit || !control.contains(hit)) return;
    event.preventDefault();
    if (input) { input.focus(); return; }
    control.click();
    // 「添加自定义模型」把搜索框换成模型 ID 输入。iOS 只在手势内 focus() 才弹键盘，上游 setTimeout 里的聚焦不算。
    if (control.matches('[role="menuitem"]') && control.querySelector('.codicon-add')) {
      menu.querySelector('input[data-fnos-model-search]')?.focus();
    }
  }, { capture: true, passive: false });
  // 安卓长按菜单行会触发 contextmenu，上游在 window 捕获阶段据此弹出桌面尺寸的应用菜单。
  // 补丁脚本先于上游模块执行，同阶段先注册先触发，在这里截住；输入框保留浏览器自己的粘贴菜单。
  window.addEventListener('contextmenu', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!touchLayout() || !target?.closest(MODEL_MENUS) || target.closest('input')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  // 外层面板的 Radix 右键菜单给触摸按下起 700ms 长按计时，React 事件穿过 portal 冒泡，模型菜单里长按也会弹出它。
  // React 处理完按下后补发 pointercancel 清掉计时器；菜单项本身不监听 pointercancel。
  window.addEventListener('pointerdown', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (!event.isTrusted || event.pointerType === 'mouse' || !touchLayout() || !target?.closest(MODEL_MENUS)) return;
    target.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true, pointerId: event.pointerId, pointerType: event.pointerType, isPrimary: event.isPrimary,
    }));
  });

  /* ---- 轻量提示条：标题栏下方居中，不遮输入框，自动消失，点一下关闭 ---- */
  let toastEl = null;
  let toastTimer = 0;
  function toast(text, ms) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('data-fnos-patch-toast', '');
      toastEl.setAttribute('role', 'status');
      toastEl.style.cssText =
        'position:fixed;left:50%;top:calc(64px + env(safe-area-inset-top,0px));transform:translateX(-50%);' +
        'z-index:2147483000;max-width:min(92vw,520px);padding:10px 14px;border-radius:10px;' +
        'background:rgba(20,22,28,.94);color:#f2f2f2;font:12px/1.5 system-ui,sans-serif;white-space:pre-wrap;' +
        'overflow-wrap:anywhere;box-shadow:0 8px 28px rgba(0,0,0,.45);cursor:pointer';
      toastEl.addEventListener('click', hideToast);
    }
    toastEl.textContent = text;
    if (!toastEl.isConnected) document.body.appendChild(toastEl);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, ms || 9000);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    if (toastEl && toastEl.isConnected) toastEl.remove();
  }

  /* ---- 修补 1：触屏布局下用户消息的编辑 / 展开 / 恢复按钮，点气泡后才显示 ----
     上游 v0.23.0 user-message.tsx：触屏时按钮常驻。隐藏规则在 patch.css，
     这里只负责在消息根（data-slot="aui_user-message-root"）上切换 data-fnos-reveal。 */
  const MESSAGE_ROOT = '[data-slot="aui_user-message-root"]';
  const REVEAL_ATTR = 'data-fnos-reveal';
  const INTERACTIVE = 'button, a[href], input, textarea, select, [role="button"], [role="menuitem"], [contenteditable]';

  function hasTextSelection() {
    const selection = window.getSelection();
    return Boolean(selection && selection.type === 'Range' && String(selection).length > 0);
  }
  function clearReveal(except) {
    for (const el of document.querySelectorAll(MESSAGE_ROOT + '[' + REVEAL_ATTR + ']')) {
      if (el !== except) el.removeAttribute(REVEAL_ATTR);
    }
  }
  document.addEventListener('click', event => {
    if (!touchLayout() || event.defaultPrevented) return;
    const target = event.target instanceof Element ? event.target : null;
    const message = target && target.closest(MESSAGE_ROOT);
    if (!message) {
      if (!(target && target.closest('[data-fnos-patch-toast]'))) clearReveal(null);
      return;
    }
    if (target.closest(INTERACTIVE) || hasTextSelection()) return;
    const open = message.hasAttribute(REVEAL_ATTR);
    clearReveal(message);
    if (open) message.removeAttribute(REVEAL_ATTR);
    else message.setAttribute(REVEAL_ATTR, '');
  }, true);

  /* ---- 修补 2：窄屏下标题栏「显示右侧栏」按钮打不开文件栏 ----
     上游 v0.23.0：titlebar-controls.tsx 在窄视口 + browser 宿主时只派发 hermes:pane-toggle-reveal，
     narrow-overlays.tsx 会丢弃被隐藏面板的事件。而 contrib/controller.tsx 把 files 面板的可见性
     绑在「会话有工作目录 且 文件栏开关（file-browser.open）为真」上，开关默认 false，窄屏上的
     任何路径（按钮、⌘J）都只派发 reveal、从不写这个开关，所以在窄屏上文件栏永远打不开。
     处理：本脚本先于上游 module 脚本执行（由 webapp-proxy 插在它前面），窄屏加载时把
     localStorage 里 hermes.desktop.paneStates.v1 的 file-browser.open 记为 true（上游
     lib/layout-persistence.ts 只在模块初始化时读取一次）。宽屏加载不改动。 */
  const PANE_STATES_KEY = 'hermes.desktop.paneStates.v1';
  const FILE_BROWSER_PANE = 'file-browser';

  function seedFileBrowserOpen() {
    if (!(narrowQuery && narrowQuery.matches)) return;
    let states;
    try { states = JSON.parse(readStorage(PANE_STATES_KEY) || '{}'); } catch { states = null; }
    if (!states || typeof states !== 'object' || Array.isArray(states)) states = {};
    const record = states[FILE_BROWSER_PANE];
    if (record && typeof record === 'object' && record.open === true) return;
    states[FILE_BROWSER_PANE] = Object.assign({}, record && typeof record === 'object' ? record : {}, { open: true });
    try { localStorage.setItem(PANE_STATES_KEY, JSON.stringify(states)); } catch { return; }
    console.info(TAG + ' narrow viewport: file-browser pane marked open');
  }
  seedFileBrowserOpen();

  /* 按钮点击后若 450ms 内布局（各 data-tree-group 的位置尺寸、窄屏浮层）毫无变化，
     就提示原因（如会话没有工作目录），并把诊断打印到控制台。 */
  const RIGHT_TOGGLE = '[data-tour="right-pane-toggle"]';

  function zoneSnapshot() {
    const zones = [];
    for (const el of document.querySelectorAll('[data-tree-group]')) {
      const rect = el.getBoundingClientRect();
      zones.push(el.getAttribute('data-tree-group') + ':' +
        Math.round(rect.left) + ',' + Math.round(rect.width) + 'x' + Math.round(rect.height));
    }
    const overlays = [];
    for (const el of document.querySelectorAll('[data-narrow-overlay]')) overlays.push(el.getAttribute('data-narrow-overlay'));
    return { zones, overlays, key: zones.join('|') + '#' + overlays.join('|') };
  }

  function treePaneIds() {
    const raw = readStorage('hermes.desktop.layoutTree.v2');
    if (!raw) return null;
    const ids = new Set();
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node.panes)) for (const id of node.panes) if (typeof id === 'string') ids.add(id);
      if (Array.isArray(node.children)) for (const child of node.children) walk(child);
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object' && key !== 'panes' && key !== 'children') walk(value);
      }
    };
    try { walk(JSON.parse(raw)); } catch { return null; }
    return [...ids];
  }

  function diag() {
    const snapshot = zoneSnapshot();
    const button = document.querySelector(RIGHT_TOGGLE);
    return {
      patch: VERSION,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      narrow: Boolean(narrowQuery && narrowQuery.matches),
      touch: touchLayout(),
      host: document.documentElement.getAttribute('data-hermes-desktop-host'),
      preset: readStorage('hermes.desktop.layoutPreset.active'),
      treePanes: treePaneIds(),
      zones: snapshot.zones,
      overlays: snapshot.overlays,
      paneHosts: [...document.querySelectorAll('[data-pane-host]')].map(el =>
        el.getAttribute('data-pane-host') + (el.hasAttribute('inert') ? '(hidden)' : '')),
      rightToggle: button ? { label: button.getAttribute('aria-label'), expanded: button.getAttribute('aria-expanded') } : null,
    };
  }

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target && target.closest(RIGHT_TOGGLE);
    if (!button) return;
    const before = zoneSnapshot().key;
    setTimeout(() => {
      if (zoneSnapshot().key !== before) return;
      const info = diag();
      console.warn(TAG + ' right pane toggle had no visible effect', info);
      toast('右侧栏暂未展开，请检查工作目录或布局设置。');
    }, 450);
  }, true);

  /* ---- 修补 3：WebApp 不提供应用本体卸载导航（上游 v0.23.1） ----
     settings/index.tsx 的 about:uninstall 侧栏行由 CSS 精确隐藏。
     OverlayNav 的窄屏栏紧邻 aside，首个子容器里是 TabDropdown 触发器，菜单 portal
     用 Radix aria-controls / aria-labelledby 关联。TabDropdown 不输出条目 id，所以只
     匹配该菜单末尾 About / Updates / Uninstall 三行与侧栏的本地化标签，避免误伤
     插件同名行、技能卸载及其他菜单。结构不符时不猜测，留待升级核对。
     命令面板 paletteValue = label + U+0001 + id，id 不依赖翻译或高亮文字。
     卸载修补本身不改桥/网络，只有修补 4 拒绝后端更新检查与升级，官方 browser uninstall stub 不变。 */
  const SETTINGS_NAV = 'aside[data-tour="overlay-nav"]';
  const UNINSTALL_NAV = 'button[data-tour="nav-about:uninstall"]';
  const PALETTE_ROWS = '[role="dialog"] [data-slot="command"] [data-slot="command-list"] ' +
    '[data-slot="command-item"][cmdk-item][data-value]';
  const PALETTE_UNINSTALL = 'sp-settings-page:about:uninstall';
  const HIDDEN_NAV_ATTR = 'data-fnos-uninstall-nav';
  const disabledRows = new Map();
  const disabledAttrs = { 'aria-disabled': 'true', 'data-disabled': 'true', tabindex: '-1', inert: '' };
  const rowLabel = el => el && el.querySelector(':scope > span')?.textContent.trim();

  function isUninstallCommand(el) {
    if (!el || !el.matches(PALETTE_ROWS)) return false;
    const value = el.getAttribute('data-value') || '';
    return value.slice(value.lastIndexOf('\u0001')) === '\u0001' + PALETTE_UNINSTALL;
  }

  function syncUninstallNavigation() {
    const targets = new Set();
    if (browserHost()) {
      for (const nav of document.querySelectorAll(SETTINGS_NAV)) {
        const uninstall = nav.querySelector(UNINSTALL_NAV);
        const updates = nav.querySelector('button[data-tour="nav-about:updates"]');
        const about = nav.querySelector('button[data-tour="nav-about"]');
        if (!uninstall || !updates || !about || !nav.querySelector('button[data-tour="nav-config:model"]')) continue;
        targets.add(uninstall);
        const trigger = nav.nextElementSibling?.firstElementChild?.querySelector(
          'button[data-slot="dropdown-menu-trigger"][aria-haspopup="menu"]');
        if (!trigger) continue;
        const controls = trigger.getAttribute('aria-controls');
        for (const menu of document.querySelectorAll('[data-slot="dropdown-menu-content"][role="menu"]')) {
          const labelledBy = (menu.getAttribute('aria-labelledby') || '').split(/\s+/);
          const linked = (controls && menu.id === controls) || (trigger.id && labelledBy.includes(trigger.id));
          if (!linked || (controls && menu.id !== controls)) continue;
          const rows = [...menu.querySelectorAll(':scope > [data-slot="dropdown-menu-item"][role="menuitem"]')];
          const last = rows.slice(-3);
          if (last.length === 3 && [about, updates, uninstall].every((row, i) =>
            rowLabel(row) && rowLabel(row) === rowLabel(last[i]))) targets.add(last[2]);
        }
      }
      for (const row of document.querySelectorAll(PALETTE_ROWS)) {
        if (isUninstallCommand(row)) targets.add(row);
      }
    }
    // 不删除 React 拥有的节点。恢复复用/改名的行，且不反复写属性触发 observer。
    for (const [row, saved] of disabledRows) {
      if (targets.has(row)) continue;
      row.removeAttribute(HIDDEN_NAV_ATTR);
      for (const [name, value] of Object.entries(saved)) {
        if (row.getAttribute(name) !== disabledAttrs[name]) continue;
        if (value === null) row.removeAttribute(name);
        else row.setAttribute(name, value);
      }
      disabledRows.delete(row);
    }
    for (const row of targets) {
      if (!disabledRows.has(row)) disabledRows.set(row, Object.fromEntries(
        Object.keys(disabledAttrs).map(name => [name, row.getAttribute(name)])));
      if (!row.hasAttribute(HIDDEN_NAV_ATTR)) row.setAttribute(HIDDEN_NAV_ATTR, '');
      for (const [name, value] of Object.entries(disabledAttrs)) {
        if (row.getAttribute(name) !== value) row.setAttribute(name, value);
      }
    }
    redirectUninstallRoute();
  }

  // main.tsx 使用 HashRouter。只替换 hash 内的目标 page。代理 base、外层 query、
  // hash 内其他 query（包括重复项/原编码）、history.state/idx/key 与栈长度均保留。
  // replaceState 本身不通知 React Router，故显式派发 popstate，不能仅改 URL。
  const originalReplaceState = history.replaceState;
  function redirectUninstallRoute() {
    if (!browserHost()) return;
    const match = /^(#\/?settings\/?\?)([^#]*)(#.*)?$/.exec(location.hash);
    if (!match) return;
    const params = new URLSearchParams(match[2]);
    if (params.get('tab') !== 'about' || params.get('page') !== 'uninstall') return;
    const query = match[2].split('&').map(part =>
      new URLSearchParams(part).has('page') ? 'page=updates' : part).join('&');
    const next = location.pathname + location.search + match[1] + query + (match[3] || '');
    originalReplaceState.call(history, history.state, '', next);
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }
  // React Router 的 push/replace 不会产生原生 popstate。等调用者完成本轮导航后纠正，
  // 避免在其同步状态更新中插入嵌套导航。原方法的返回值、参数和异常原样保留。
  let routeCheckQueued = false;
  function queueRouteCheck() {
    if (routeCheckQueued) return;
    routeCheckQueued = true;
    queueMicrotask(() => { routeCheckQueued = false; redirectUninstallRoute(); });
  }
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      queueRouteCheck();
      return result;
    };
  }
  window.addEventListener('popstate', queueRouteCheck);
  window.addEventListener('hashchange', queueRouteCheck);

  // CSS 隐藏 + aria-disabled 让 cmdk 跳过该行。若它已经选中，拦下其 Enter，
  // 不拦其他命令/菜单。程序性点击同样不能执行被隐藏的入口。
  function blockUninstallSelection(event) {
    if (!browserHost()) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    let row = target.closest('[' + HIDDEN_NAV_ATTR + ']') || target.closest(SETTINGS_NAV + ' ' + UNINSTALL_NAV);
    if (!row && event.type === 'keydown' && event.key === 'Enter') {
      row = target.closest('[data-slot="command"]')?.querySelector(
        '[data-slot="command-item"][aria-selected="true"]');
    }
    if (!row) row = target.closest('[data-slot="command-item"]');
    if (!(row && (row.hasAttribute(HIDDEN_NAV_ATTR) || row.matches(SETTINGS_NAV + ' ' + UNINSTALL_NAV) || isUninstallCommand(row)))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  document.addEventListener('click', blockUninstallSelection, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') blockUninstallSelection(event);
  }, true);
  new MutationObserver(syncUninstallNavigation).observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['data-hermes-desktop-host', 'data-tour', 'data-slot', 'data-value',
      'aria-controls', 'aria-labelledby', 'aria-disabled', 'id'],
  });
  syncUninstallNavigation();

  // v0.23.0 根错误页由 React 管理。恢复出口仅挂在 body，不按翻译文本匹配。
  const RECOVERY_ATTR = 'data-fnos-crash-recovery';
  let recoveryEl = null;
  function rootCrashFallback() {
    if (!browserHost()) return null;
    return [...document.querySelectorAll('div[data-glass-opaque].fixed.inset-0')].find(el =>
      el.classList.contains('z-(--z-crash)')) || null;
  }
  function panelBaseUrl() {
    // 只接受已核实的代理入口末尾。绝不使用 referrer、<base>、外部 query 或猜测端口。
    if (!/^https?:$/.test(location.protocol) || location.origin === 'null' ||
        !/\/(?:webapp|dashboard)\/$/.test(location.pathname)) return null;
    const url = new URL(location.href);
    url.pathname = location.pathname.replace(/\/(?:webapp|dashboard)\/$/, '/');
    // 面板已支持 view 深链，覆盖可能记住的 webapp 视图，但不写 hermes_view 存储。
    url.search = '?view=overview';
    url.hash = '';
    return url.origin === location.origin ? url.href : null;
  }
  function createCrashRecovery() {
    const region = document.createElement('section');
    region.setAttribute(RECOVERY_ATTR, '');
    region.setAttribute('aria-label', 'WebApp 界面恢复');
    const text = document.createElement('p');
    text.textContent = '已保存的会话和设置会保留；重载可能丢失未发送的内容。';
    const actions = document.createElement('div');
    const embedded = window.parent !== window;
    const panelUrl = embedded ? null : panelBaseUrl();
    const back = document.createElement(panelUrl ? 'a' : 'button');
    back.textContent = '返回管理面板';
    if (panelUrl) back.href = panelUrl;
    else back.type = 'button';
    back.addEventListener('click', event => {
      if (!rootCrashFallback()) { event.preventDefault(); return; }
      if (panelUrl) return; // 同源绝对链接，在当前标签页返回面板。
      event.preventDefault();
      if (!embedded || location.origin === 'null') {
        toast('无法确认管理面板地址，请从 fnOS 应用入口返回。');
        return;
      }
      try {
        window.parent.postMessage({ type: 'fnos-webapp-recovery', action: 'return-to-panel' }, location.origin);
      } catch {
        toast('无法通知管理面板，请退出全屏后从面板导航返回。');
      }
    });
    const home = document.createElement('button');
    home.type = 'button';
    home.textContent = '返回对话首页并重载';
    home.addEventListener('click', () => {
      if (!rootCrashFallback()) return;
      try {
        // main.tsx: HashRouter。绕过本补丁的路由 hook，不派发路由事件，直接重载本页。
        originalReplaceState.call(history, history.state, '', location.pathname + location.search + '#/');
        location.reload();
      } catch {
        toast('无法重载对话首页，请使用浏览器刷新后重试。');
      }
    });
    actions.append(back, home);
    region.append(text, actions);
    return region;
  }
  function syncCrashRecovery() {
    if (!document.body || !rootCrashFallback()) {
      if (recoveryEl) recoveryEl.remove();
      recoveryEl = null;
      return;
    }
    if (!recoveryEl) recoveryEl = createCrashRecovery();
    // React 根反复挂载不产生副本。宿主节点被移除时重新挂回同一个补丁节点。
    if (recoveryEl.parentNode !== document.body) document.body.appendChild(recoveryEl);
  }
  new MutationObserver(syncCrashRecovery).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['data-hermes-desktop-host', 'data-glass-opaque', 'class'],
  });
  syncCrashRecovery();

  window.__fnosWebappPatch = Object.freeze({ version: VERSION, diag, toast });
  console.info(TAG + ' v' + VERSION + ' loaded');
}());
