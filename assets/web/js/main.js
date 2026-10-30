// Entry point: connects to Homey, picks the dashboard and keeps it live.

import { APP_ID, loadConfig, servedByHomey, writeStoredConfig } from './config.js';
import { isSaving, loadKeyScopes } from './dashboard-save.js';
import { initEditMode, setEditing } from './edit-mode.js';
import { embedded, notifyEmbedded } from './embedded.js';
import { initFit, isFit, setFit } from './fit.js';
import { $, darkQuery, el } from './dom.js';
import { DASHBOARD_ICON } from './icons.js';
import { createClient } from './homey-api.js';
import { fetchHighlight, isHighlightOpen, showHighlight, watchHighlight } from './highlight.js';
import { initKiosk, isKiosk, kioskHome, resetIdle, screenState, setKiosk, settleKioskHome } from './kiosk.js';
import { createPairing } from './pairing.js';
import { createRealtime, loadScript } from './realtime.js';
import { redrawWidgets, renderDashboard, updateBoard } from './render.js';
import { adoptScreenId, registerScreen, screenId, watchScreen } from './screen.js';
import { STORAGE_KEY, params, state } from './state.js';
import { checkForUpdate, watchUpdates } from './updates.js';
import { loadWidgetModes, watchWidgetModes } from './widget-modes.js';

let connectionGeneration = 0;
const currentConnection = (client, generation) => generation === connectionGeneration && state.client === client;

// The dashboard name is the switch: it lists the dashboards, the shown one highlighted. Not in kiosk mode.
function populateDashboardMenu() {
  const dashboards = Object.values(state.dashboards).sort((a, b) => a.name.localeCompare(b.name));
  $('dashboard-menu').replaceChildren(...dashboards.map((dashboard) => {
    const item = el('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.innerHTML = DASHBOARD_ICON;
    item.append(el('span', null, dashboard.name));
    if (dashboard.id === state.dashboardId) item.setAttribute('aria-current', 'true');
    item.addEventListener('click', () => {
      toggleDashboardMenu(false);
      showDashboard(dashboard.id);
    });
    return item;
  }));
  $('dashboard-switch').toggleAttribute('data-single', dashboards.length < 2);
  populateDashboardNavigation(dashboards);
}

// Desktop navigation shares the same dashboard list and switch path as the title picker. Rebuilding the list after
// a live rename or edit keeps keyboard focus on its dashboard, without touching the board's widgets.
function populateDashboardNavigation(dashboards) {
  const navigation = $('dashboard-navigation');
  const focusedId = navigation.contains(document.activeElement) ? document.activeElement.dataset.dashboardId : null;
  navigation.replaceChildren(...dashboards.map((dashboard) => {
    const item = el('button', 'dashboard-navigation-item');
    item.type = 'button';
    item.dataset.dashboardId = dashboard.id;
    item.title = dashboard.name;
    item.innerHTML = DASHBOARD_ICON;
    item.querySelector('svg')?.setAttribute('aria-hidden', 'true');
    item.append(el('span', null, dashboard.name));
    if (dashboard.id === state.dashboardId) item.setAttribute('aria-current', 'page');
    item.addEventListener('click', () => {
      toggleDashboardMenu(false);
      if (dashboard.id !== state.dashboardId) showDashboard(dashboard.id);
    });
    return item;
  }));
  $('dashboard-sidebar').hidden = dashboards.length === 0;
  document.body.classList.toggle('has-dashboard-navigation', dashboards.length > 0);
  if (focusedId) [...navigation.children].find((item) => item.dataset.dashboardId === focusedId)?.focus({ preventScroll: true });
}

function toggleDashboardMenu(open = $('dashboard-menu').hidden) {
  const menu = $('dashboard-menu');
  const anchor = $('dashboard-switch').getBoundingClientRect();
  menu.style.top = `${anchor.bottom + 8}px`;
  menu.style.left = `${Math.max(16, anchor.left)}px`;
  menu.hidden = !open;
  $('dashboard-switch').setAttribute('aria-expanded', String(open));
  if (open) (menu.querySelector('[aria-current="true"]') ?? menu.firstElementChild)?.focus();
}

function chooseDashboard() {
  const requested = params.get('dashboard');
  const dashboards = Object.values(state.dashboards);
  const match = (value) => dashboards.find((dashboard) => dashboard.id === value || dashboard.name === value);
  let remembered = null;
  try {
    remembered = localStorage.getItem(`${STORAGE_KEY}:dashboard`);
  } catch {
    // Ignore unavailable storage.
  }
  // The one showing stays (a reload of the dashboards after a reconnect must not switch); a kiosk tablet starts on its
  // own dashboard and only returns to it when left alone.
  state.dashboardId = (match(requested) ?? match(state.dashboardId) ?? match(kioskHome()) ?? match(remembered) ?? dashboards[0])?.id ?? null;
}

async function refreshAll(client = state.client, generation = connectionGeneration) {
  if (!currentConnection(client, generation) || client == null) return false;
  let dashboards;
  let me;
  try {
    [dashboards, me] = await Promise.all([
      client.api('GET', '/api/manager/dashboards/dashboard'),
      client.api('GET', '/api/manager/users/user/me').catch(() => null),
    ]);
  } catch (error) {
    if (!currentConnection(client, generation)) return false;
    throw error;
  }
  if (!currentConnection(client, generation)) return false;
  state.dashboards = dashboards ?? {};
  state.me = me;
  chooseDashboard();
  populateDashboardMenu();
  await renderDashboard();
  if (!currentConnection(client, generation)) return false;
  showHighlight();
  return true;
}

function setStatus(stateName, text) {
  const status = $('status');
  status.dataset.state = stateName;
  status.textContent = text;
}

// Re-render when the shown dashboard changes, or one it has a shortcut to (its name may have changed).
const isShownOrLinked = (id) => id === state.dashboardId
  || (state.dashboards[state.dashboardId]?.columns ?? []).some((column) => column.widgets
    .some((widget) => widget.type === 'dashboards_shortcuts' && widget.data?.dashboardIds?.includes(id)));

// From Homey, or saved here (edit mode), which Homey then announces too. Only what changed is drawn again.
function onDashboardChange(dashboard) {
  if (dashboard?.id == null) return;
  state.dashboards[dashboard.id] = dashboard;
  chooseDashboard();
  populateDashboardMenu();
  if (dashboard.id === state.dashboardId) updateBoard();
  else if (isShownOrLinked(dashboard.id)) renderDashboard();
  showHighlight();
}
document.addEventListener('dashboard-saved', (event) => {
  if (state.client && state.config?.token) onDashboardChange(event.detail);
});

function watchHomey(client, generation) {
  const realtime = state.realtime;
  const current = () => currentConnection(client, generation);
  realtime.on('homey:manager:dashboards', 'dashboard.create', (dashboard) => {
    if (current()) onDashboardChange(dashboard);
  });
  realtime.on('homey:manager:dashboards', 'dashboard.update', (dashboard) => {
    if (current() && !isSaving(dashboard?.id)) onDashboardChange(dashboard);
  });
  realtime.on('homey:manager:dashboards', 'dashboard.delete', ({ id }) => {
    if (!current()) return;
    delete state.dashboards[id];
    const wasShownOrLinked = isShownOrLinked(id);
    chooseDashboard();
    populateDashboardMenu();
    if (wasShownOrLinked) renderDashboard();
    showHighlight();
  });
  // The "Show a dashboard" flow card, for every screen or this one. A kiosk tablet counts it as a touch, so it stays
  // two minutes before going home.
  if (servedByHomey) {
    realtime.on(`homey:app:${APP_ID}`, 'show-dashboard', (data) => {
      if (!current()) return;
      if (data?.screenId !== 'all' && data?.screenId !== screenId()) return;
      resetIdle();
      showDashboard(data?.dashboardId);
    });
  }
  // A widget on this dashboard that is to run another way (sandboxed, with storage or trusted) is loaded again.
  watchWidgetModes(redrawWidgets);
  // Favorites live on the user, so re-render when they change in the mobile app.
  realtime.on('homey:manager:users', 'user.update', async (user) => {
    if (!current() || user?.id !== state.me?.id) return;
    const me = await client.api('GET', '/api/manager/users/user/me').catch(() => null);
    if (!current()) return;
    state.me = me ?? state.me;
    renderDashboard();
  });
}

const pairing = createPairing({
  async onApproved(token, purpose, result) {
    if (purpose === 'unlock') {
      resetIdle();
      openSetup();
      return;
    }
    const generation = connectionGeneration;
    const connection = { token, ...(result.transport ? { transport: result.transport } : {}), ...(result.screenId ? { screenId: result.screenId } : {}) };
    await writeStoredConfig(connection);
    if (generation !== connectionGeneration) return;
    $('setup').close();
    await boot({ ...connection, homeyUrl: location.origin });
  },
});

// The setup dialog shows one of: 'pairing' (served by the Homey app, a browser without a key shows a code that you
// approve in the app's settings), 'unlock' (a kiosk tablet asking the same way to open its settings) or 'key'.
let setupMode = 'key';
function showSetupMode(mode) {
  setupMode = mode;
  const asking = mode === 'pairing' || mode === 'unlock';
  $('setup-pairing').hidden = !asking;
  $('setup-key').hidden = asking;
  $('pairing-intro').hidden = mode !== 'pairing';
  $('unlock-intro').hidden = mode !== 'unlock';
  // Unlocking must not offer a way around the approval.
  $('pairing-use-key').hidden = mode !== 'pairing';
  $('pairing-cancel').hidden = mode !== 'unlock';
  if (asking) pairing.start({ purpose: mode === 'unlock' ? 'unlock' : 'pair' });
  else pairing.stop();
}

// A kiosk tablet opens its settings only after someone approves a code in the Homey app. Served from elsewhere
// (developing) there is no app to ask, so holding the name opens them directly.
function openUnlock() {
  if (!servedByHomey) return openSetup();
  $('setup-title').textContent = 'Unlock';
  $('setup-error').hidden = true;
  showSetupMode('unlock');
  if (!$('setup').open) $('setup').showModal();
}

// A kiosk tablet left alone: close sheets and settings (not a pairing in progress, it is needed to get going) and go
// back to its dashboard. Not while a flow highlights a widget, which it put there for this tablet to show: the tablet
// goes back at the next idle check after that closes.
function kioskIdle() {
  for (const dialog of document.querySelectorAll('dialog[open]')) {
    if (dialog.id !== 'setup' || setupMode !== 'pairing') dialog.close();
  }
  const home = kioskHome();
  if (home && home !== state.dashboardId && state.dashboards[home] && !isHighlightOpen()) showDashboard(home);
}

function openSetup(errorText) {
  const config = state.config ?? {};
  if (embedded && !config.token) return showEmbeddedFailure(errorText ?? 'Use Retry in the Homey dashboard view to reconnect.');
  showSetupMode(servedByHomey && !config.token ? 'pairing' : 'key');
  // Once dashboards are showing, this is the browser's settings rather than a connection form.
  const connected = state.client != null && Boolean(config.token);
  const brokered = config.transport === 'broker';
  $('setup-title').textContent = connected ? 'Settings' : 'Connect to Homey';
  $('setup-layout').hidden = !connected;
  $('setup-screen').hidden = !connected || !state.screenName;
  $('screen-name').textContent = state.screenName ?? '';
  $('setup-kiosk').hidden = !connected;
  $('setup-done').hidden = !connected;
  $('fit-toggle').checked = isFit();
  $('kiosk-toggle').checked = isKiosk();
  $('kiosk-screen').hidden = !isKiosk();
  $('kiosk-screen').textContent = {
    on: 'The screen is being kept on.',
    off: "The browser isn't keeping the screen on right now (it may need a tap first, or power saving refuses it).",
    insecure: "Opened over plain HTTP, the browser can't keep the screen on; use the https address.",
    unsupported: "This browser can't keep the screen on.",
  }[screenState()];
  const dashboards = Object.values(state.dashboards).sort((a, b) => a.name.localeCompare(b.name));
  $('kiosk-dashboard').replaceChildren(...dashboards.map((dashboard) => {
    const option = el('option', null, dashboard.name);
    option.value = dashboard.id;
    return option;
  }));
  $('kiosk-dashboard').value = kioskHome() ?? state.dashboardId ?? '';
  $('setup-url').value = config.homeyUrl ?? '';
  // Served by the Homey app, the address is known; only the API key is asked for.
  $('setup-url-group').hidden = servedByHomey;
  $('setup-url').required = !servedByHomey;
  $('setup-token').value = brokered ? '' : config.token ?? '';
  $('setup-token').hidden = brokered;
  $('setup-token').required = !brokered;
  $('setup-token-label').hidden = brokered;
  // The existing #setup label rule sets display:block and overrides the user
  // agent's hidden rule, so hide this label explicitly for broker connections.
  $('setup-token-label').style.display = brokered ? 'none' : '';
  $('setup-token').nextElementSibling.hidden = brokered;
  document.querySelector('#setup-form button[type="submit"]').hidden = brokered;
  $('setup-forget').hidden = embedded;
  $('setup-forget').textContent = brokered ? 'Disconnect' : 'Forget';
  $('setup-error').hidden = !errorText;
  $('setup-error').textContent = errorText ?? '';
  if (location.protocol === 'https:' && config.homeyUrl?.startsWith('http:')) {
    $('setup-error').hidden = false;
    $('setup-error').textContent = 'This page is served over HTTPS, so the Homey address must use HTTPS too.';
  }
  if (!$('setup').open) $('setup').showModal();
}

$('setup').addEventListener('close', () => pairing.stop());
$('setup-done').addEventListener('click', () => $('setup').close());
$('fit-toggle').addEventListener('change', (event) => setFit(event.target.checked));
// Kiosk mode: this browser always shows the chosen dashboard. Turning it on shows the result straight away;
// holding the dashboard name brings Settings back.
$('kiosk-toggle').addEventListener('change', (event) => {
  const home = $('kiosk-dashboard').value;
  setKiosk(event.target.checked, home);
  if (!event.target.checked) return;
  showDashboard(home);
  $('setup').close();
});
$('kiosk-dashboard').addEventListener('change', (event) => {
  if (!isKiosk()) return;
  setKiosk(true, event.target.value);
  showDashboard(event.target.value);
});
$('pairing-retry').addEventListener('click', () => pairing.start());
$('pairing-cancel').addEventListener('click', () => $('setup').close());
$('pairing-use-key').addEventListener('click', () => {
  $('setup-error').hidden = true;
  showSetupMode('key');
});

$('setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const generation = connectionGeneration;
  const token = $('setup-token').value.trim();
  const connection = servedByHomey ? { token } : { homeyUrl: $('setup-url').value.trim(), token };
  await writeStoredConfig(connection);
  if (generation !== connectionGeneration) return;
  $('setup').close();
  await boot({ ...connection, homeyUrl: servedByHomey ? location.origin : connection.homeyUrl });
});

$('setup-forget').addEventListener('click', async () => {
  if (!await clearConnection()) return;
  openSetup();
});

$('settings-button').addEventListener('click', () => openSetup());

// From the dashboard menu under the title or a dashboard shortcut widget. Each browser remembers its choice; an address that names a
// dashboard is updated too, so a reload or a later dashboard edit doesn't jump back to it.
function showDashboard(id) {
  if (state.dashboards[id] == null) return;
  state.dashboardId = id;
  try {
    localStorage.setItem(`${STORAGE_KEY}:dashboard`, id);
  } catch {
    // Ignore unavailable storage.
  }
  if (params.has('dashboard')) {
    params.set('dashboard', id);
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }
  populateDashboardMenu();
  renderDashboard();
  window.scrollTo({ top: 0 });
  $('board').scrollLeft = 0;
}

$('dashboard-switch').addEventListener('click', () => {
  if (isKiosk() || Object.keys(state.dashboards).length < 2) return;
  toggleDashboardMenu();
});
document.addEventListener('click', (event) => {
  if (!$('dashboard-menu').hidden && !event.target.closest('#dashboard-menu, #dashboard-switch')) toggleDashboardMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('dashboard-menu').hidden) toggleDashboardMenu(false);
});
document.addEventListener('show-dashboard', (event) => showDashboard(event.detail));

darkQuery.addEventListener('change', () => renderDashboard());

// A revoked browser connection must reconnect through Homey rather than falling
// back to an owner key.
function isRevokedKey(error) {
  return (servedByHomey || state.config?.transport === 'broker') && error.status === 401;
}

async function clearConnection() {
  const generation = ++connectionGeneration;
  state.realtime?.close?.();
  state.realtime = null;
  state.client = null;
  state.config = { ...state.config, token: undefined };
  state.dashboardId = null;
  state.dashboards = {};
  state.data = {};
  state.dataErrors = {};
  state.me = null;
  state.system = {};
  state.screenName = null;
  setEditing(false);
  $('edit-button').hidden = true;
  for (const dialog of document.querySelectorAll('dialog[open]')) {
    if (dialog.id !== 'setup') dialog.close();
  }
  populateDashboardMenu();
  const stored = writeStoredConfig({});
  await showHighlight();
  if (generation !== connectionGeneration) return false;
  await renderDashboard();
  await stored;
  return generation === connectionGeneration;
}

function showEmbeddedFailure(message) {
  setStatus('offline', 'Not connected');
  notifyEmbedded('error', { message });
  $('setup-title').textContent = 'Connection unavailable';
  $('setup-error').textContent = message;
  $('setup-error').hidden = false;
  $('setup-pairing').hidden = true;
  $('setup-key').hidden = true;
  if (!$('setup').open) $('setup').showModal();
}

async function pairAgain(client = state.client, generation = connectionGeneration) {
  if (!currentConnection(client, generation)) return;
  if (!await clearConnection()) return;
  setStatus('offline', 'Not connected');
  if (embedded) showEmbeddedFailure('This connection has ended. Use Retry in the Homey dashboard view.');
  else openSetup('This connection has ended. Approve a new browser code in Homey to reconnect.');
}

async function boot(connection) {
  const generation = ++connectionGeneration;
  state.realtime?.close?.();
  state.realtime = null;
  state.client = null;
  try {
    const config = connection ?? await loadConfig();
    if (generation !== connectionGeneration) return;
    state.config = config;
  } catch (error) {
    if (generation !== connectionGeneration) return;
    if (embedded) showEmbeddedFailure(error.message);
    else openSetup(error.message);
    return;
  }
  if (state.config.screenId) adoptScreenId(state.config.screenId);
  if (!state.config.homeyUrl || !state.config.token) {
    setStatus('offline', 'Not connected');
    openSetup();
    return;
  }

  try {
    state.client = createClient(state.config);
  } catch (error) {
    if (embedded) showEmbeddedFailure(error.message);
    else openSetup(`Invalid Homey address: ${error.message}`);
    return;
  }
  const client = state.client;
  const current = () => currentConnection(client, generation);

  try {
    // Broker connections use the app's event relay; legacy direct connections
    // still use Homey's socket client.
    if (client.transport !== 'broker') await loadScript(`${client.base}/socket.io/socket.io.js`);
    if (!current()) return;
    const onReconnect = () => {
      if (!current()) return;
      // Homey may have restarted with an updated app while the connection was down.
      checkForUpdate('reconnected');
      registerScreen();
      fetchHighlight();
      loadWidgetModes().then(() => current() && refreshAll(client, generation)).catch((error) => {
        if (!current()) return;
        if (isRevokedKey(error)) pairAgain(client, generation);
        else console.error(error);
      });
    };
    // Once pairAgain() dropped the key, the old connection's handshake errors are only noise.
    const onStatus = (name, text) => {
      if (current() && state.config.token) setStatus(name, text);
    };
    const realtime = createRealtime(client, { onStatus, onReconnect, onUnauthorized: () => pairAgain(client, generation) });
    if (!current()) { realtime.close?.(); return; }
    state.realtime = realtime;
    watchHomey(client, generation);
    watchUpdates();
    watchScreen();
    watchHighlight();
  } catch (error) {
    if (!current()) return;
    setStatus('error', 'No live updates');
    console.error(error);
  }

  try {
    const [system] = await Promise.all([
      client.api('GET', '/api/manager/system/').catch(() => ({})),
      loadKeyScopes(),
      loadWidgetModes(),
    ]);
    if (!current()) return;
    state.system = system;
    if (!await refreshAll(client, generation) || !current()) return;
    settleKioskHome();
    $('edit-button').hidden = false;
    notifyEmbedded('connected');
  } catch (error) {
    if (!current()) return;
    if (isRevokedKey(error)) return pairAgain(client, generation);
    setStatus('error', 'Not connected');
    if (embedded) showEmbeddedFailure(`Could not reach Homey: ${error.message}`);
    else openSetup(`Could not reach Homey: ${error.message}`);
  }
}

initKiosk({ onHold: openUnlock, onIdle: kioskIdle });
initFit();
initEditMode();
// A page restored from the browser's back/forward cache has already closed its
// event relay on pagehide. Reconnect through normal startup rather than showing
// a frozen dashboard.
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
boot();
