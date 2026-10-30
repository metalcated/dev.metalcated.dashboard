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
    frame.contentWindow.postMessage({ type, ...extra }, new URL(address).origin);
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
    clearTimeout(loadTimer);
    showStatus('Opening your dashboards…');
    const url = new URL(address);
    url.searchParams.set('embedded', '1');
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
    loadTimer = setTimeout(() => {
      if (currentAttempt !== attempt) return;
      attempt += 1;
      showStatus('Homey has not answered yet. Reload the dashboard to try again.', true);
    }, 12000);
    // Homey signs this request with the existing app session. The response contains only a restricted dashboard
    // connection, never Homey's owner API token; the frame keeps it in memory for this visit.
    const requestConnection = (screenId) => Homey.api('POST', '/workspace/connect', screenId ? { screenId } : {}, (error, connection) => {
      if (currentAttempt !== attempt) return;
      clearTimeout(loadTimer);
      if (error || !connection?.token || connection.transport !== 'broker') {
        showStatus(error?.message || 'Automatic connection could not start. Reload the dashboard to try again.', true);
        return;
      }
      post('dashboard:connect', { config: {
        token: connection.token,
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
    if (!address || event.source !== frame.contentWindow || event.origin !== new URL(address).origin) return;
    if (event.data?.type === 'dashboard:ready') connect();
    if (event.data?.type === 'dashboard:error') {
      clearTimeout(loadTimer);
      attempt += 1;
      showStatus(event.data.message || 'The connection was lost. Reload to connect again.', true);
    }
  });
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
