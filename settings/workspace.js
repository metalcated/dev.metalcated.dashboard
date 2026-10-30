/* Authenticated Homey app view. Connection credentials stay out of URLs and browser storage. */
function createDashboardWorkspace(Homey) {
  const appId = 'dev.schweiger.dashboard';
  // The app generates LAN/localhost addresses or Homey's certified LAN hostname. Never deliver a connection to
  // an arbitrary website if a stored address was accidentally changed.
  function isHomeyHost(hostname) {
    if (hostname === 'localhost') return true;
    const host = hostname.endsWith('.homey.homeylocal.com')
      ? hostname.slice(0, -'.homey.homeylocal.com'.length).replace(/-/g, '.') : hostname;
    const parts = host.split('.');
    if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
    const [a, b] = parts.map(Number);
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
      || (a === 169 && b === 254);
  }
  function workingSettingsOrigin() {
    try {
      const current = new URL(window.location.href);
      const settingsPath = `/app/${appId}/settings`;
      if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password
          || !isHomeyHost(current.hostname)
          || ![settingsPath, `${settingsPath}/`, `${settingsPath}/index.html`].includes(current.pathname)) return null;
      // This app's settings already loaded from this Homey origin. Reuse its working protocol, host and port rather
      // than introducing a generated hostname that the browser's DNS may not resolve. Cloud-hosted settings do not
      // qualify, so this never downgrades a cloud HTTPS view to a separate plain-HTTP LAN destination.
      return current.origin;
    } catch { return null; }
  }
  const frame = document.getElementById('workspace-frame');
  const status = document.getElementById('workspace-status');
  const tabs = ['dashboard', 'connection'].map((name) => document.getElementById(`${name}-tab`));
  const reload = document.getElementById('workspace-reload');
  const expand = document.getElementById('workspace-expand');
  const open = document.getElementById('workspace-open');
  let address = null;
  let active = 'dashboard';
  let loadTimer = null;
  let attempt = 0;
  let identity = null;
  let bridgeNonce = null;
  let bridgePort = null;
  let bridgeSession = null;
  const bridgeRequests = new Map();

  function closeBridge() {
    bridgePort?.close();
    bridgePort = null;
    bridgeSession = null;
    for (const timer of bridgeRequests.values()) clearTimeout(timer);
    bridgeRequests.clear();
    bridgeNonce = null;
  }

  function screenIdentity() {
    if (identity) return identity;
    // Only a screen identity is persisted here. Every connection credential is still held in memory, and each
    // Homey has its own identity so a browser cannot accidentally target a screen on another server.
    identity = new Promise((resolve) => {
      let database;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        database?.close();
        resolve(value);
      };
      const timer = setTimeout(() => finish(undefined), 1000);
      try {
        const request = window.indexedDB.open('homey-dashboard-workspace', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('screens');
        request.onerror = () => finish(undefined);
        request.onblocked = () => finish(undefined);
        request.onsuccess = () => {
          database = request.result;
          if (settled) { database.close(); return; }
          const transaction = database.transaction('screens', 'readwrite');
          const store = transaction.objectStore('screens');
          const key = `${appId}:${new URL(address).origin}`;
          const read = store.get(key);
          let id;
          read.onsuccess = () => {
            id = read.result;
            if (typeof id !== 'string' || !/^native-[a-z0-9-]{8,50}$/.test(id)) {
              id = `native-${Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
              store.put(id, key);
            }
          };
          transaction.oncomplete = () => finish(id);
          transaction.onerror = transaction.onabort = () => finish(undefined);
        };
      } catch { finish(undefined); }
    });
    return identity;
  }

  function showStatus(text, error = false) {
    status.textContent = text;
    status.dataset.error = String(error);
    status.hidden = !text;
  }

  function post(type, extra = {}) {
    if (!address || !frame.contentWindow || !frame.hasAttribute('src')) return;
    if (bridgePort) {
      bridgePort.postMessage({ type, ...extra });
      return;
    }
    frame.contentWindow.postMessage({ type, ...extra }, new URL(address).origin);
  }

  function dashboardMessage(data) {
    if (data?.type === 'dashboard:error') {
      clearTimeout(loadTimer);
      attempt += 1;
      bridgeSession = null;
      showStatus(data.message || 'The connection was lost. Reload to connect again.', true);
    }
  }

  function bridgeRequest(port, data) {
    if (!Number.isSafeInteger(data.id) || data.id < 1 || data.id > 2147483647) return;
    const reply = (value) => { if (port === bridgePort) port.postMessage({ type: 'dashboard:response', id: data.id, ...value }); };
    if (!bridgeSession) return reply({ ok: false, error: { message: 'Reload the dashboard to connect again.', status: 401 } });
    let size;
    try { size = JSON.stringify(data.body).length; } catch { size = Infinity; }
    if (!['request', 'events'].includes(data.route) || !data.body || typeof data.body !== 'object'
      || Array.isArray(data.body) || size > 1024 * 1024) {
      return reply({ ok: false, error: { message: 'Unsupported dashboard request.', status: 400 } });
    }
    if (bridgeRequests.has(data.id) || bridgeRequests.size >= 32) {
      return reply({ ok: false, error: { message: 'Too many dashboard requests. Try again.', status: 429 } });
    }
    const timer = setTimeout(() => {
      if (port !== bridgePort || !bridgeRequests.has(data.id)) return;
      bridgeRequests.delete(data.id);
      reply({ ok: false, error: { message: 'Homey has not answered yet. Check the device before trying again.', status: 504 } });
    }, 25000);
    bridgeRequests.set(data.id, timer);
    const session = bridgeSession;
    // Homey's web app deliberately gives app settings an opaque origin. Its signed-in SDK channel can still reach
    // our two constrained broker endpoints; the frame cannot choose an app-administration route or another token.
    Homey.api('POST', `/workspace/${data.route}`, { ...data.body, token: session.token }, (error, value) => {
      if (port !== bridgePort || session !== bridgeSession || !bridgeRequests.has(data.id)) return;
      clearTimeout(timer);
      bridgeRequests.delete(data.id);
      if (error) reply({ ok: false, error: { message: error.message || 'Homey could not complete the request.', status: error.statusCode ?? error.status } });
      else reply({ ok: true, value });
    });
  }

  function visibility() {
    post('dashboard:visibility', { visible: active === 'dashboard' && document.visibilityState !== 'hidden' });
  }

  function select(name, focus = false) {
    active = name;
    for (const tab of tabs) {
      const selected = tab.id === `${name}-tab`;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
      if (selected && focus) tab.focus();
    }
    visibility();
  }

  function load() {
    if (!address) return;
    attempt += 1;
    closeBridge();
    clearTimeout(loadTimer);
    showStatus('Opening your dashboards…');
    const url = new URL(address);
    url.searchParams.set('embedded', '1');
    // A fragment change alone is a same-document navigation. Rotate a noncredential visit counter in the query so
    // Reload actually creates a fresh document and MessageChannel; keep the private challenge in the fragment.
    url.searchParams.set('visit', String(attempt));
    bridgeNonce = Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    // This per-visit handshake value is not an API credential. The fragment stays out of HTTP requests/referrers.
    url.hash = `bridge=${bridgeNonce}`;
    frame.hidden = false;
    frame.src = url.href;
    loadTimer = setTimeout(() => {
      showStatus('The dashboard has not opened yet. Try Reload, or Open separately if this Homey view cannot display it.', true);
    }, 15000);
  }

  function connect() {
    const currentAttempt = ++attempt;
    clearTimeout(loadTimer);
    showStatus('Connecting to Homey…');
    const failed = (message) => {
      showStatus(message, true);
      // Stop the child waiting for configuration too. Otherwise its later generic timeout would replace Homey's
      // useful authorization error and leave the two views describing different failures.
      post('dashboard:error', { message });
    };
    loadTimer = setTimeout(() => {
      if (currentAttempt !== attempt) return;
      attempt += 1;
      failed('Homey has not answered yet. Reload the dashboard to try again.');
    }, 12000);
    // Homey signs this request with the existing app session. The response contains only a restricted dashboard
    // connection, never Homey's owner API token; the frame keeps it in memory for this visit.
    const requestConnection = (screenId) => Homey.api('POST', '/workspace/connect', screenId ? { screenId } : {}, (error, connection) => {
      if (currentAttempt !== attempt) return;
      clearTimeout(loadTimer);
      if (error || !connection?.token || connection.transport !== 'broker') {
        failed(error?.message || 'Automatic connection could not start. Reload the dashboard to try again.');
        return;
      }
      bridgeSession = connection;
      post('dashboard:connect', { config: {
        token: bridgePort ? 'embedded-channel' : connection.token,
        transport: 'broker',
        screenId: connection.screenId,
        homeyUrl: new URL(address).origin,
      } });
      visibility();
      showStatus('');
    });
    if (!window.indexedDB) requestConnection();
    else screenIdentity().then((screenId) => { if (currentAttempt === attempt) requestConnection(screenId); });
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => select(index === 0 ? 'dashboard' : 'connection'));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
      select(next === 0 ? 'dashboard' : 'connection', true);
    });
  }

  window.addEventListener('message', (event) => {
    if (!address || event.source !== frame.contentWindow) return;
    const expectedOrigin = new URL(address).origin;
    if (event.data?.type === 'dashboard:ready' && (event.data.nonce !== undefined || event.ports?.length)) {
      if (event.data.nonce !== bridgeNonce || !bridgeNonce || event.ports?.length !== 1) return;
      if (event.origin !== expectedOrigin && !(event.origin === 'null' && window.origin === 'null')) return;
      const port = event.ports[0];
      if (bridgePort) { port.close(); return; }
      bridgePort = port;
      port.onmessage = ({ data }) => {
        if (port !== bridgePort) return;
        if (data?.type === 'dashboard:request') bridgeRequest(port, data);
        else dashboardMessage(data);
      };
      port.start();
      connect();
      return;
    }
    if (bridgeNonce || event.origin !== expectedOrigin || bridgePort) return;
    if (event.data?.type === 'dashboard:ready') connect();
    dashboardMessage(event.data);
  });
  window.addEventListener('pagehide', closeBridge);
  document.addEventListener('visibilitychange', visibility);
  frame.addEventListener('load', visibility);
  reload.addEventListener('click', load);
  open.addEventListener('click', () => { if (address) Homey.openURL(address); });
  expand.addEventListener('click', () => {
    if (!frame.requestFullscreen) return;
    frame.requestFullscreen().catch(() => showStatus('Expand is unavailable in this Homey view. Use Open separately instead.', true));
  });

  return {
    address: () => address,
    showError: (message) => showStatus(message, true),
    keepConnectionsUpdated(refresh) {
      if (window.origin !== 'null') return;
      // Homey's web shell cannot attach app realtime listeners from its opaque settings frame. Refresh its small
      // connection lists only while visible; the native app retains the SDK's existing realtime subscriptions.
      let disposed = false;
      let timer;
      const poll = () => {
        if (disposed) return;
        if (active === 'connection' && document.visibilityState !== 'hidden') refresh();
        timer = setTimeout(poll, 3000);
      };
      poll();
      window.addEventListener('pagehide', () => { disposed = true; clearTimeout(timer); }, { once: true });
    },
    openDashboard() {
      select('dashboard');
      if (address && !frame.hasAttribute('src')) load();
    },
    setAddress(value) {
      try {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
          || !isHomeyHost(url.hostname) || url.pathname !== `/app/${appId}/assets/web/index.html`) throw new Error('Invalid address');
        const origin = workingSettingsOrigin();
        address = origin ? new URL(url.pathname, origin).href : url.href;
      } catch {
        showStatus('The dashboard address is unavailable. Restart the app, then reopen this view.', true);
        return;
      }
      reload.disabled = false;
      open.disabled = false;
      expand.disabled = !frame.requestFullscreen;
      load();
    },
  };
}
