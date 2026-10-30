/* The companion owns one navigation entry and one panel. It never reads Homey authentication or application state. */
(() => {
  'use strict';

  if (typeof HOMEY_DASHBOARD_COMPANION !== 'object' || HOMEY_DASHBOARD_COMPANION === null) return;
  const config = HOMEY_DASHBOARD_COMPANION;
  let origin;
  try {
    const url = new URL(config.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== config.origin || url.username || url.password
      || !/^[a-f0-9]{24}$/.test(config.homeyId) || !/^[a-z0-9][a-z0-9._-]{1,127}$/.test(config.appId)) return;
    origin = url.origin;
  } catch { return; }
  if (location.origin !== origin || window.top !== window) return;

  const prefix = `/web/homeys/${config.homeyId}`;
  const allowed = () => location.origin === origin && (location.pathname === prefix || location.pathname.startsWith(`${prefix}/`));
  if (!allowed()) return;
  const cleanUrl = new URL(`/app/${encodeURIComponent(config.appId)}/assets/web/index.html`, origin).href;
  const frameUrl = `${cleanUrl}?shell=1`;
  const settingsUrl = `${origin}${prefix}/settings/apps/${encodeURIComponent(config.appId)}`;
  const ID = 'metalcated-dashboard-companion';
  const hiddenSecondary = 'data-metalcated-dashboard-companion-hidden';
  const nativeLayout = 'main, [class*="MainNav-header-"], [class*="MainNav-subNavWrapper-"], [class*="MainNav-root-"], [class*="MainNav-container-"], [class*="MainNav-logoWrapper-"]';
  if (document.getElementById(`${ID}-nav`)) return;

  let nav = null;
  let entry = null;
  let panel = null;
  let frame = null;
  let opened = false;
  let selected = [];
  let previousFocus = null;
  let openedAt = null;
  let lastUrl = location.href;
  let scheduled = false;
  let stopped = false;
  const isolated = new Map();

  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;

  function svg() {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    icon.classList.add('mdc-nav-icon');
    for (const [x, y] of [[3, 3], [14, 3], [3, 14], [14, 14]]) {
      const tile = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      for (const [key, value] of Object.entries({ x, y, width: 7, height: 7, rx: 1.5 })) tile.setAttribute(key, String(value));
      icon.appendChild(tile);
    }
    return icon;
  }

  function urlOf(anchor) {
    try { return new URL(anchor.getAttribute('href'), location.href); } catch { return null; }
  }

  function isNative(anchor) {
    const url = urlOf(anchor);
    return url?.origin === origin && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
  }

  function visibility() {
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage({ type: 'dashboard:visibility', visible: opened && document.visibilityState !== 'hidden' }, origin);
  }

  function setEntryActive(on) {
    if (!entry) return;
    entry.setAttribute('data-is-active', String(on));
    if (on) entry.setAttribute('aria-current', 'page');
    else entry.removeAttribute('aria-current');
  }

  function coveredNativeContent() {
    const container = nav?.parentElement;
    const root = container?.parentElement;
    // These are the observed sibling boundaries. Never disable the whole
    // navigation container: it also owns the primary rail and Homey logo.
    if (!nav?.matches('nav[class*="MainNav-navLinkItems-"]')
      || !container?.matches('div[class*="MainNav-container-"]')
      || !root?.matches('[class*="MainNav-root-"]')) return null;
    const children = [...container.children];
    const logos = children.filter((node) => node.matches('div[class*="MainNav-logoWrapper-"]'));
    const secondary = children.filter((node) => node.matches('header[class*="MainNav-header-"], div[class*="MainNav-subNavWrapper-"]'));
    const mains = [...(root.parentElement?.children ?? [])].filter((node) => node.tagName === 'MAIN');
    if (logos.length !== 1 || mains.length !== 1
      || children.some((node) => node !== nav && node !== logos[0] && !secondary.includes(node))) return null;
    const targets = [mains[0], ...secondary];
    if (targets.some((node) => node.contains(nav) || node.contains(logos[0]) || node.contains(panel))) return null;
    return targets;
  }

  function restoreNativeContent(node, before) {
    node.inert = before.inert;
    if (before.attribute === null) node.removeAttribute('inert');
    else node.setAttribute('inert', before.attribute);
    if (before.secondary) {
      if (before.hiddenAttribute === null) node.removeAttribute(hiddenSecondary);
      else node.setAttribute(hiddenSecondary, before.hiddenAttribute);
    }
  }

  function isolateNativeContent(targets) {
    for (const [node, before] of isolated) {
      if (targets.includes(node)) continue;
      restoreNativeContent(node, before);
      isolated.delete(node);
    }
    for (const node of targets) {
      if (!isolated.has(node)) isolated.set(node, {
        inert: node.inert, attribute: node.getAttribute('inert'),
        secondary: node !== targets[0], hiddenAttribute: node.getAttribute(hiddenSecondary),
      });
      node.inert = true;
      // The secondary sidebar starts inside the rail's 16px gutter. Preserve
      // its layout but suppress that exposed edge without touching host styles.
      if (isolated.get(node).secondary) node.setAttribute(hiddenSecondary, 'true');
    }
  }

  function restoreAllNativeContent() {
    for (const [node, before] of isolated) restoreNativeContent(node, before);
    isolated.clear();
  }

  function close({ focus = true } = {}) {
    if (!opened) return;
    opened = false;
    if (panel) panel.hidden = true;
    visibility();
    setEntryActive(false);
    // Restore keyboard/click access before focus returns to native content.
    restoreAllNativeContent();
    // Native navigation remains authoritative after a route change. For a
    // simple close, put back only attributes that this companion suppressed.
    if (location.href === openedAt) {
      for (const item of selected) {
        if (!item.node.isConnected) continue;
        if (item.active !== null && item.node.getAttribute('data-is-active') === 'false') item.node.setAttribute('data-is-active', item.active);
        if (item.current !== null && !item.node.hasAttribute('aria-current')) item.node.setAttribute('aria-current', item.current);
      }
    }
    selected = [];
    if (focus) {
      const target = previousFocus?.isConnected && !panel?.contains(previousFocus) ? previousFocus : entry;
      target?.focus({ preventScroll: true });
    }
    previousFocus = null;
  }

  function position() {
    if (!panel || !nav?.isConnected) return;
    const rect = nav.getBoundingClientRect();
    // The native primary rail is 72px; its settings sibling is a separate
    // sidebar. Cover that sibling, leaving the actual rail and logo in place.
    const left = Math.max(0, Math.min(window.innerWidth, rect.right + 16));
    panel.style.setProperty('--mdc-left', `${left}px`);
    syncTheme();
  }

  function syncTheme() {
    if (!frame) return;
    const classes = document.documentElement?.classList;
    frame.style.colorScheme = classes?.contains('darkTheme') ? 'dark' : classes?.contains('lightTheme') ? 'light' : 'normal';
  }

  function createPanel() {
    panel = document.createElement('section');
    panel.id = `${ID}-panel`;
    panel.className = 'mdc-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Homey dashboards');
    const header = document.createElement('header');
    header.className = 'mdc-header';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'mdc-back';
    back.setAttribute('aria-label', 'Back to Homey');
    back.textContent = '‹';
    back.addEventListener('click', () => close());
    const title = document.createElement('h1');
    title.className = 'mdc-title';
    title.textContent = 'Dashboards';
    const links = document.createElement('div');
    links.className = 'mdc-actions';
    const connection = document.createElement('a');
    connection.className = 'mdc-action';
    connection.href = settingsUrl;
    connection.target = '_blank';
    connection.rel = 'noopener noreferrer';
    connection.setAttribute('aria-label', 'Connection (opens a new tab)');
    connection.textContent = 'Connection';
    const separate = document.createElement('a');
    separate.className = 'mdc-action';
    separate.href = cleanUrl;
    separate.target = '_blank';
    separate.rel = 'noopener noreferrer';
    separate.textContent = 'Open separately';
    links.append(connection, separate);
    header.append(back, title, links);
    frame = document.createElement('iframe');
    frame.id = `${ID}-frame`;
    frame.className = 'mdc-frame';
    frame.title = 'Homey dashboards';
    frame.allow = 'autoplay; fullscreen';
    frame.referrerPolicy = 'origin';
    syncTheme();
    // This normal-origin renderer performs its own one-time browser pairing.
    // Its app widgets retain their existing inner sandboxes.
    frame.addEventListener('load', visibility);
    panel.append(header, frame);
    document.body.appendChild(panel);
    frame.src = frameUrl;
  }

  function open() {
    if (!allowed() || !nav?.isConnected || !entry?.isConnected) return false;
    const targets = coveredNativeContent();
    if (!targets) return false;
    if (!panel) createPanel();
    if (opened) return true;
    opened = true;
    openedAt = location.href;
    previousFocus = document.activeElement;
    if (previousFocus === entry) previousFocus = null;
    selected = [...nav.querySelectorAll('a[href]')].filter((anchor) => anchor !== entry && isNative(anchor)
      && (anchor.getAttribute('data-is-active') === 'true' || anchor.hasAttribute('aria-current')))
      .map((node) => ({ node, active: node.getAttribute('data-is-active'), current: node.getAttribute('aria-current') }));
    for (const item of selected) {
      if (item.active !== null) item.node.setAttribute('data-is-active', 'false');
      item.node.removeAttribute('aria-current');
    }
    setEntryActive(true);
    isolateNativeContent(targets);
    panel.hidden = false;
    position();
    visibility();
    panel.querySelector('.mdc-back')?.focus({ preventScroll: true });
    return true;
  }

  function unmount() {
    close({ focus: false });
    resize?.disconnect();
    entry?.remove();
    panel?.remove();
    nav = null;
    entry = null;
    panel = null;
    frame = null;
  }

  function mount() {
    if (stopped) return;
    const changed = location.href !== lastUrl;
    lastUrl = location.href;
    if (!allowed()) { unmount(); return; }
    if (changed) close({ focus: false });
    if (entry?.isConnected && nav?.isConnected) {
      if (opened) {
        const targets = coveredNativeContent();
        if (targets) isolateNativeContent(targets);
        else close({ focus: false });
      }
      position();
      return;
    }
    if (nav || entry) unmount();
    const devices = [...document.querySelectorAll('nav a[href]')].find((anchor) => {
      const url = urlOf(anchor);
      return url?.origin === origin && url.pathname === `${prefix}/devices`;
    });
    const candidate = devices?.closest('nav');
    // Only use the observed primary rail shape. Missing or changed markup must
    // not hide, replace, or break the vendor interface.
    if (!candidate || devices.parentElement !== candidate) return;
    nav = candidate;
    const home = [...nav.querySelectorAll('a[href]')].find((anchor) => anchor.parentElement === nav
      && anchor.getAttribute('aria-label') === 'Home' && isNative(anchor));
    entry = (home ?? devices).cloneNode(true);
    entry.id = `${ID}-nav`;
    entry.classList.add('mdc-nav-entry');
    entry.href = cleanUrl;
    entry.setAttribute('aria-label', 'Dashboards');
    entry.title = 'Dashboards';
    for (const node of [entry, ...entry.querySelectorAll('*')]) {
      for (const attr of ['data-react-aria-pressable', 'data-pressed', 'data-hovered', 'data-focus-visible', 'aria-current',
        'aria-selected', 'aria-controls', 'aria-describedby', 'aria-labelledby', 'tabindex']) node.removeAttribute(attr);
      for (const attr of node.getAttributeNames?.() ?? []) if (/^on/i.test(attr)) node.removeAttribute(attr);
      if (node !== entry) node.removeAttribute('id');
    }
    const label = entry.querySelector('[class*="MainNavItem-label"]');
    const wrapper = entry.querySelector('[class*="MainNavItem-iconWrapper"]');
    if (!label || !wrapper) { entry = null; nav = null; return; }
    label.textContent = 'Dashboards';
    label.classList.add('mdc-nav-label');
    wrapper.replaceChildren(svg());
    setEntryActive(false);
    entry.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
      if (!open()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
    nav.insertBefore(entry, home ? home.nextSibling : devices);
    resize?.observe(nav);
  }

  function schedule() {
    if (scheduled || stopped) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; mount(); });
  }

  const observer = new MutationObserver((records) => {
    const layoutChanges = records.filter((record) => {
      if (record.type !== 'attributes') return true;
      if (record.target === document.documentElement) syncTheme();
      return false;
    });
    if (!layoutChanges.length) return;
    if (location.href !== lastUrl || (entry && !entry.isConnected) || (nav && !nav.isConnected)) { schedule(); return; }
    if (layoutChanges.some((record) => {
      if (panel?.contains(record.target) || entry?.contains(record.target)) return false;
      if (record.target.closest?.('nav')) return true;
      if (opened && [nav?.parentElement, nav?.parentElement?.parentElement,
        nav?.parentElement?.parentElement?.parentElement].includes(record.target)) return true;
      return [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === 1
        && (node.matches?.('nav') || node.querySelector?.('nav')
          || (opened && (node.matches?.(nativeLayout) || node.querySelector?.(nativeLayout)))));
    })) schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  if (document.documentElement) observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('click', (event) => {
    const anchor = event.target.closest?.('a[href]');
    if (!opened || !anchor || anchor === entry || !anchor.closest('nav') || !isNative(anchor)) return;
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) close({ focus: false });
  }, { capture: true });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && opened && !frame?.contains(document.activeElement)) close();
  });
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('resize', schedule);
  window.addEventListener('popstate', () => { close({ focus: false }); schedule(); });
  window.addEventListener('hashchange', () => { close({ focus: false }); schedule(); });
  // Observe SPA URL changes without replacing vendor history functions or
  // inspecting router state. DOM and resize work remain coalesced per frame.
  const watchRoute = () => setInterval(() => { if (location.href !== lastUrl) schedule(); }, 500);
  let routeTimer = watchRoute();
  window.addEventListener('pagehide', () => {
    stopped = true;
    clearInterval(routeTimer);
    observer.disconnect();
    unmount();
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || !stopped) return;
    stopped = false;
    scheduled = false;
    lastUrl = location.href;
    observer.observe(document.body, { childList: true, subtree: true });
    if (document.documentElement) observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    routeTimer = watchRoute();
    mount();
  });
  mount();
})();
