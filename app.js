'use strict';

const crypto = require('crypto');
const Homey = require('homey');
const { DashboardAccess } = require('./lib/dashboard-access');

// What the dashboard needs, named as in my.homey.app's API key form (group → box); that form lacks the first and the
// energy one, so those are named by scope.
const NEEDED_SCOPES = [
  ['homey.dashboard.readonly', 'View dashboards (homey.dashboard.readonly; not offered in the my.homey.app form)'],
  ['homey.device.readonly', 'Devices → View devices'],
  ['homey.device.control', 'Devices → Control devices'],
  ['homey.flow.readonly', 'Flows → View Flows'],
  ['homey.flow.start', 'Flows → Start Flows'],
  ['homey.mood.readonly', 'Moods → View Moods'],
  ['homey.mood.set', 'Moods → Set Moods'],
  ['homey.logic.readonly', 'Variables → View Variables'],
  ['homey.zone.readonly', 'Zones → View Zones'],
  ['homey.notifications.readonly', 'Notifications → View Notifications'],
  ['homey.app.readonly', 'Apps → View Apps'],
  ['homey.user.readonly', 'Users → View Users'],
  ['homey.user.self', 'Users → Edit Self User'],
  ['homey.insights.readonly', 'Logs → View Logs'],
  ['homey.energy.readonly', 'View energy (homey.energy.readonly; not offered in the my.homey.app form)'],
  ['homey.presence.self', 'Presence → Edit Self Presence'],
  ['homey.system.readonly', 'System → View System'],
  ['homey.geolocation.readonly', 'Location → View Location'],
];

// Ticking a group's own box (or Homey) also allows deleting and changing things; every paired browser holds the key.
// Dashboards (homey.dashboard) isn't among them: it is what editing on the web dashboards needs.
const BROAD_SCOPES = {
  homey: 'Homey (everything)',
  'homey.app': 'Apps (installs and removes apps)',
  'homey.app.control': 'Apps → Control Apps (changes app settings, this one included)',
  'homey.user': 'Users (adds and removes users)',
  'homey.system': 'System (firmware, restarts)',
  'homey.updates': 'Updates',
  'homey.device': 'Devices (deletes and changes devices)',
  'homey.flow': 'Flows (edits and deletes Flows)',
  'homey.mood': 'Moods (edits and deletes moods)',
  'homey.logic': 'Variables (edits and deletes variables)',
  'homey.zone': 'Zones (edits and deletes zones)',
  'homey.energy': 'Energy (changes energy settings)',
  'homey.notifications': 'Notifications (deletes notifications)',
  'homey.insights': 'Logs (deletes logs)',
  'homey.presence': "Presence (sets other people's presence)",
  'homey.alarm': 'Alarms',
  'homey.geolocation': 'Location',
};

// A scope is granted by itself or by any parent (homey.device grants homey.device.readonly; homey grants all).
const grants = (scopes, scope) => scope.split('.').some((_, index, parts) => scopes.includes(parts.slice(0, index + 1).join('.')));

// How long a browser's code stays valid, and how many browsers may wait at once.
const PAIRING_TTL = 10 * 60 * 1000;
const MAX_WAITING = 10;

// What the highlight card calls a widget without a title (and without a device or zone to name it by).
const WIDGET_TYPES = {
  app_webview: 'App widget',
  dashboards_shortcuts: 'Dashboards',
  devices_favorites: 'Favorite devices',
  flows_favorites: 'Favorite flows',
  moods_favorites: 'Favorite moods',
  devices_custom: 'Devices',
  flows_custom: 'Flows',
  moods_custom: 'Moods',
  devices_zone: 'Zone devices',
  moods_zone: 'Zone moods',
  light_zones: 'Zone lights',
  insights_chart_line: 'Chart',
  light_device: 'Light',
  light_group: 'Lights',
  device_speaker_large: 'Speaker',
  device_speaker_small: 'Speaker',
  energy_usage: 'Energy',
  thermostat: 'Thermostat',
  notifications_timeline_large: 'Timeline',
  notifications_timeline_small: 'Timeline',
  device_camera_snapshot: 'Camera snapshot',
  device_camera_live: 'Live camera',
  web_frame: 'Web frame',
  energy_dynamic_prices: 'Electricity prices',
  logic_variables: 'Variables',
  note: 'Note',
  sensors_selection: 'Sensors',
  zone_controls: 'Zone controls',
  users_avatars: 'Users',
  batteries_devices: 'Batteries',
  batteries_device_low: 'Low batteries',
  weather_forecast: 'Weather forecast',
  weather: 'Weather',
};

const matches = (query, ...texts) => texts.some((text) => text?.toLowerCase().includes(query.trim().toLowerCase()));

// How an app widget runs on the web dashboards, chosen in its settings there; the first is the default. Sandboxed
// widgets can't read the API key the page keeps; 'storage' also gives them localStorage, kept by the page, and a
// trusted one runs unsandboxed, as in the Homey app, where it could read the key.
const WIDGET_MODES = ['sandboxed', 'storage', 'trusted'];
const validWidgetId = (id) => typeof id === 'string' && /^[\w-]{8,64}$/.test(id);

// Screens: browsers showing the dashboard, each with a lasting random id it keeps in its storage and a name you give
// it, so flow cards can aim at one of them. At most this many are kept; lastSeen is saved at most this often.
const MAX_SCREENS = 50;
const SEEN_EVERY = 60 * 60 * 1000;
const ALL_SCREENS = 'all';
const validScreenId = (id) => typeof id === 'string' && /^[\w-]{8,64}$/.test(id);
const cleanName = (name) => (typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 60) : null);

function ago(timestamp) {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 2) return 'now';
  if (minutes < 120) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`;
}

// The dashboard is static files in assets/web/, which Homey serves at /app/<app id>/assets/web/.
// The app works out that address for the settings page. New screens use opaque, revocable dashboard sessions;
// the SDK's automatic owner credential stays on the backend. Existing manually configured keys remain supported.
module.exports = class DashboardApp extends Homey.App {
  async onInit() {
    // Waiting browsers live in memory only; a restart simply asks them for a new code.
    this.pairings = new Map();
    this.getDashboardAccess();

    // e.g. "192.168.3.210:80"; a Homey Self-Hosted Server has its own http port, by default 4859.
    const address = await this.homey.cloud.getLocalAddress();
    const [ip, httpPort = '80'] = address.split(':');
    const path = `/app/${this.manifest.id}/assets/web/index.html`;
    this.homey.settings.set('dashboardLocalUrl', `http://${address}${path}`);
    await this.setSecureUrl(ip, Number(httpPort), path).catch(this.error);

    this.initHighlightCards();
    this.initShowDashboardCard();
  }

  getDashboardAccess() {
    this.dashboardAccess ??= new DashboardAccess({ homey: this.homey, app: this, appId: this.manifest.id });
    return this.dashboardAccess;
  }

  async connectWorkspace(body) { return this.getDashboardAccess().connect(body); }
  async requestWorkspace(body) { return this.getDashboardAccess().request(body); }
  async workspaceEvents(body) { return this.getDashboardAccess().events(body); }

  async onUninit() { await this.dashboardAccess?.close(); }

  // *.homey.homeylocal.com resolves to the Homey on the local network and has a valid HTTPS certificate. A Homey Pro
  // serves it on 443; a Homey Self-Hosted Server on a port of its own, by default the one after its http port (4860),
  // which no API names. The port that answers is used; until one does, and if none does, the default.
  async setSecureUrl(ip, httpPort, path) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      // Only an IPv4 address has a homeylocal.com name.
      this.homey.settings.set('dashboardUrl', this.homey.settings.get('dashboardLocalUrl'));
      return;
    }
    const host = `${ip.replace(/\./g, '-')}.homey.homeylocal.com`;
    const url = (port) => `https://${host}${port === 443 ? '' : `:${port}`}${path}`;
    const ports = httpPort === 80 ? [443] : [httpPort + 1, 443];
    this.homey.settings.set('dashboardUrl', url(ports[0]));
    if (ports.length > 1) {
      for (const port of ports) {
        const response = await fetch(url(port), { signal: AbortSignal.timeout(3000) }).catch(() => null);
        if (response?.ok) {
          this.homey.settings.set('dashboardUrl', url(port));
          break;
        }
      }
    }
    this.log(`Dashboard: ${this.homey.settings.get('dashboardUrl')}`);
  }

  // ----- Pairing (public routes: an unknown browser can only ask for a code and poll it) -----

  // purpose 'pair' hands an approved browser a limited dashboard connection. 'unlock' only lets a kiosk tablet open
  // its settings: approving it hands out nothing. An unknown browser cannot obtain an owner token by asking.
  requestPairing({ name, purpose, screenId }) {
    const unlock = purpose === 'unlock';
    this.prunePairings();

    const pairing = {
      // The id is the browser's secret for polling; the short code is what the user compares.
      id: crypto.randomBytes(16).toString('hex'),
      code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
      name: String(name || 'Browser').slice(0, 60),
      // The browser's lasting id (see Screens), so approving can name it.
      screenId: validScreenId(screenId) ? screenId : null,
      purpose: unlock ? 'unlock' : 'pair',
      createdAt: Date.now(),
      status: 'waiting',
    };
    this.pairings.set(pairing.id, pairing);

    // Keep the list short so a flood of requests can't bury a real one for long.
    const waiting = [...this.pairings.values()].filter((entry) => entry.status === 'waiting');
    for (const stale of waiting.slice(0, Math.max(0, waiting.length - MAX_WAITING))) this.pairings.delete(stale.id);

    this.announcePairings();
    return { id: pairing.id, code: pairing.code, expiresAt: pairing.createdAt + PAIRING_TTL };
  }

  // The browser polls with its secret id. Its opaque connection is handed over once, after approval.
  getPairing(id) {
    this.prunePairings();
    const pairing = this.pairings.get(id);
    if (pairing == null) return { status: 'expired' };
    if (pairing.status === 'waiting') return { status: 'waiting' };

    this.pairings.delete(id);
    if (pairing.status === 'declined') return { status: 'declined' };
    if (pairing.purpose === 'unlock') return { status: 'approved' };
    if (!pairing.connection) return { status: 'declined' };
    return { status: 'approved', ...pairing.connection };
  }

  // ----- Pairing (settings page) -----

  // screenName: what the browser is already called, if it was paired or named before.
  listPairings() {
    this.prunePairings();
    const screens = this.screens();
    return [...this.pairings.values()]
      .filter((pairing) => pairing.status === 'waiting')
      .map(({ id, code, name, screenId, purpose, createdAt }) => ({
        id, code, name, screenName: screens[screenId]?.name ?? null, purpose, createdAt,
      }));
  }

  // name: what to call the browser from now on (only when it connects, not for an unlock).
  approvePairing(id, { name } = {}) {
    const pairing = this.pairings.get(id);
    this.prunePairings();
    if (!this.pairings.has(id) || pairing?.status !== 'waiting') throw new Error('This browser is no longer waiting.');
    if (pairing.purpose === 'pair') {
      pairing.connection = this.getDashboardAccess().issue({ screenId: pairing.screenId, kind: 'paired' });
      pairing.screenId = pairing.connection.screenId;
      this.saveScreen(pairing.screenId, { name: cleanName(name) ?? this.screens()[pairing.screenId]?.name ?? pairing.name });
    }
    return this.decide(id, 'approved');
  }

  declinePairing(id) {
    return this.decide(id, 'declined');
  }

  decide(id, status) {
    this.prunePairings();
    const pairing = this.pairings.get(id);
    if (pairing == null || pairing.status !== 'waiting') throw new Error('This browser is no longer waiting.');
    pairing.status = status;
    this.log(`Pairing ${pairing.code} (${pairing.name}, ${pairing.purpose}) ${status}`);
    this.announcePairings();
    return { status };
  }

  prunePairings() {
    const now = Date.now();
    for (const [id, pairing] of this.pairings) {
      if (now - pairing.createdAt > PAIRING_TTL) this.pairings.delete(id);
    }
  }

  // Lets an open settings page update its list without polling.
  announcePairings() {
    this.homey.api.realtime('pairings', this.listPairings());
  }

  // ----- API key (settings page) -----

  // Also asks Homey what the saved key may do, so the settings page can name missing and too broad permissions.
  async getApiKeyStatus() {
    const savedKey = this.homey.settings.get('apiKey');
    const configured = typeof savedKey === 'string' && savedKey.trim() !== '';
    const status = { ...(this.homey.settings.get('apiKeyStatus') ?? {}), set: configured };
    if (!configured) {
      const token = await this.getDashboardAccess().getGeneratedOwnerToken().catch(() => null);
      const scopes = token ? await this.keyScopes(token).catch(() => null) : null;
      const automatic = Array.isArray(scopes) && grants(scopes, 'homey.dashboard.readonly');
      // Some Homey versions expose the API permission but omit dashboard access from the app session. Report the
      // effective grant rather than promising an automatic connection that the server will refuse.
      return { ...status, automatic, reason: automatic ? null
        : 'Homey’s built-in app connection does not grant native dashboard access. Authorize a dedicated dashboard key to finish setup.' };
    }
    const scopes = await this.keyScopes(savedKey).catch(() => null);
    if (scopes == null) return status;
    return {
      ...status,
      missing: NEEDED_SCOPES.filter(([scope]) => !grants(scopes, scope)).map(([, label]) => label),
      canEdit: grants(scopes, 'homey.dashboard'),
      // With "homey" everything else is implied, so that alone is named.
      broad: Object.entries(BROAD_SCOPES)
        .filter(([scope]) => scopes.includes(scope) && (scope === 'homey' || !scopes.includes('homey')))
        .map(([, label]) => label),
    };
  }

  // A request to this Homey's Web API with the given key (by default the saved one).
  async callHomey(path, token = this.homey.settings.get('apiKey')) {
    const localUrl = await this.homey.api.getLocalUrl();
    const homeyId = await this.homey.cloud.getHomeyId();
    return fetch(`${localUrl}${path}`, { redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, 'X-Homey-ID': homeyId } });
  }

  async getFromHomey(path) {
    if (!this.homey.settings.get('apiKey')) return this.getDashboardAccess().ownerRequest('GET', path);
    const response = await this.callHomey(path);
    if (!response.ok) throw new Error(`Homey refused ${path}: ${response.status}`);
    return response.json();
  }

  async keyScopes(token) {
    const response = await this.callHomey('/api/manager/sessions/session/me', token);
    if (!response.ok) return null;
    const session = await response.json();
    return session.intersectedScopes ?? session.scopes ?? null;
  }

  // Checks the key against this Homey before storing it, so a typo doesn't surface later on every tablet.
  async setApiKey(key, { onlyIfUnset = false } = {}) {
    const requireUnset = () => {
      const existing = this.homey.settings.get('apiKey');
      if (onlyIfUnset && typeof existing === 'string' && existing.trim()) {
        const error = new Error('A dashboard key is already configured. Nothing was replaced.');
        error.status = error.statusCode = 409;
        throw error;
      }
    };
    requireUnset();
    if (typeof key !== 'string' || key.trim() === '') {
      this.homey.settings.unset('apiKey');
      this.homey.settings.unset('apiKeyStatus');
      return { set: false };
    }
    const token = key.trim();
    const call = (path) => this.callHomey(path, token);

    const me = await call('/api/manager/users/user/me');
    if (me.status === 401) throw new Error('Homey doesn\'t accept this API key.');
    if (!me.ok) throw new Error(`The key can't read your user (homey.user.self): ${me.status}`);
    const dashboards = await call('/api/manager/dashboards/dashboard');
    if (!dashboards.ok) throw new Error(`The key can't read dashboards (homey.dashboard.readonly): ${dashboards.status}`);

    const user = await me.json();
    const status = { set: true, user: user.name, savedAt: new Date().toISOString() };
    // No await separates this final check and the write. A setup helper cannot replace a key saved while its
    // validation requests were in flight; ordinary explicitly requested manual key changes keep their behavior.
    requireUnset();
    this.homey.settings.set('apiKey', token);
    this.homey.settings.set('apiKeyStatus', status);
    this.log(`API key saved (user ${user.name})`);
    return this.getApiKeyStatus();
  }

  // Whether this Homey accepts a key a dashboard sent, and has the scope, if one is named. The public routes act only
  // for one it does.
  async checkKey(token, scope) {
    if (this.getDashboardAccess().isBrokerToken(token)) {
      this.getDashboardAccess().authorize(token);
      return;
    }
    const scopes = typeof token === 'string' && token !== '' ? await this.keyScopes(token).catch(() => null) : null;
    if (scopes == null) throw new Error('Homey doesn\'t accept this key.');
    if (scope != null && !grants(scopes, scope)) throw new Error(`This key may not do that (it needs ${scope}).`);
  }

  // ----- How app widgets run on the web dashboards (a widget's settings there) -----

  widgetModes() {
    return this.homey.settings.get('widgetModes') ?? {};
  }

  // Public route: choosing it needs a key that may change dashboards, like the widget's other settings. Widgets no
  // longer on a dashboard are dropped.
  async setWidgetMode(id, { token, mode } = {}) {
    await this.checkKey(token, 'homey.dashboard');
    if (!validWidgetId(id)) throw new Error('Invalid widget id.');
    if (!WIDGET_MODES.includes(mode)) throw new Error('Invalid mode.');
    const modes = this.widgetModes();
    if (mode === WIDGET_MODES[0]) delete modes[id];
    else modes[id] = mode;
    const dashboards = await this.getFromHomey('/api/manager/dashboards/dashboard').catch(() => null);
    if (dashboards != null) {
      const onBoard = new Set(Object.values(dashboards).flatMap((dashboard) => (dashboard.columns ?? [])
        .flatMap((column) => column.widgets.map((widget) => widget.id))));
      for (const stale of Object.keys(modes)) if (!onBoard.has(stale)) delete modes[stale];
    }
    this.homey.settings.set('widgetModes', modes);
    this.homey.api.realtime('widget-modes', modes);
    return modes;
  }

  // ----- Screens (named browsers flow cards can aim at) -----

  screens() {
    return this.homey.settings.get('screens') ?? {};
  }

  // Adds or changes a screen. A new one beyond the limit pushes out the one seen longest ago.
  saveScreen(id, changes) {
    const screens = this.screens();
    if (screens[id] == null) {
      const oldest = Object.entries(screens).sort(([, a], [, b]) => a.lastSeen - b.lastSeen);
      for (const [stale] of oldest.slice(0, Math.max(0, oldest.length - MAX_SCREENS + 1))) delete screens[stale];
    }
    const now = Date.now();
    screens[id] = { name: 'Browser', createdAt: now, lastSeen: now, ...screens[id], ...changes };
    this.homey.settings.set('screens', screens);
    this.announceScreens();
    return screens[id];
  }

  // Public route: a dashboard says hello on load and after reconnecting. One that isn't known yet (paired before
  // screens existed, or set up with a typed key) is added under its browser name.
  async screenHello({ token, id, name }) {
    await this.checkKey(token);
    if (this.getDashboardAccess().isBrokerToken(token) && this.getDashboardAccess().authorize(token).screenId !== id) {
      throw new Error('A screen can only register its own connection.');
    }
    if (!validScreenId(id)) throw new Error('Invalid screen id.');
    let screen = this.screens()[id];
    if (screen == null) screen = this.saveScreen(id, { name: cleanName(name) ?? 'Browser' });
    else if (Date.now() - screen.lastSeen > SEEN_EVERY) screen = this.saveScreen(id, { lastSeen: Date.now() });
    // A screen that comes along while every screen shows a highlight shows it too.
    const everywhere = this.highlights.get(ALL_SCREENS);
    if (everywhere != null && !this.highlights.has(id)) {
      this.highlights.set(id, everywhere);
      this.announceHighlights();
    }
    return { name: screen.name };
  }

  // Settings page.
  listScreens() {
    return Object.entries(this.screens())
      .map(([id, screen]) => ({ id, ...screen }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  renameScreen(id, { name } = {}) {
    if (this.screens()[id] == null) throw new Error('This screen is gone.');
    const clean = cleanName(name);
    if (clean == null) throw new Error('Give the screen a name.');
    this.saveScreen(id, { name: clean });
    return this.listScreens();
  }

  // The browser itself keeps its id; if it is still in use, it comes back under its browser name.
  async forgetScreen(id) {
    const screens = this.screens();
    delete screens[id];
    this.homey.settings.set('screens', screens);
    await this.getDashboardAccess().revokeScreen(id);
    this.announceScreens();
    if (this.highlights.delete(id)) this.announceHighlights();
    return this.listScreens();
  }

  announceScreens() {
    this.homey.api.realtime('screens', this.listScreens());
  }

  // The screen argument of the flow cards: every screen first, then the named ones.
  screenChoices(query, everyone) {
    return [
      { id: ALL_SCREENS, name: everyone },
      ...this.listScreens().map((screen) => ({ id: screen.id, name: screen.name, description: `Seen ${ago(screen.lastSeen)}` })),
    ].filter((choice) => matches(query, choice.name));
  }

  // The screen a card was set up with, or an error if it was forgotten since.
  screenArg(screen) {
    if (screen?.id == null || screen.id === ALL_SCREENS) return ALL_SCREENS;
    if (this.screens()[screen.id] == null) throw new Error(`${screen.name} is no longer a known screen. Pick the screen again.`);
    return screen.id;
  }

  screenLabel(target) {
    return target === ALL_SCREENS ? 'All screens' : this.screens()[target]?.name ?? 'A screen';
  }

  // ----- Show a dashboard (flow card) -----

  // A one-off nudge, not kept: a browser that isn't connected right now just doesn't switch.
  initShowDashboardCard() {
    const card = this.homey.flow.getActionCard('show_dashboard');
    card.registerArgumentAutocompleteListener('screen', (query) => this.screenChoices(query, 'All screens'));
    card.registerArgumentAutocompleteListener('dashboard', (query) => this.dashboardChoices(query));
    card.registerRunListener(async ({ screen, dashboard }) => {
      const screenId = this.screenArg(screen);
      const dashboards = await this.getFromHomey('/api/manager/dashboards/dashboard');
      if (dashboards[dashboard.id] == null) throw new Error(`${dashboard.name} no longer exists. Pick the dashboard again.`);
      this.log(`Show dashboard ${dashboards[dashboard.id].name} on ${this.screenLabel(screenId)}`);
      // The dashboards listen for this on homey:app:<app id>.
      this.homey.api.realtime('show-dashboard', { dashboardId: dashboard.id, screenId });
    });
  }

  // ----- Widget highlight (flow cards; the screens show it) -----

  // Each screen shows at most one highlight: screen id → { id, target, dashboardId, widgetId, name, dashboardName,
  // size }. One for all screens is the same object on every screen, and also kept under 'all' for browsers without a
  // lasting id. Closing a highlight closes it on every screen showing it. Kept in memory only; after a restart nothing
  // is highlighted, and the dashboards close it when they reconnect.
  initHighlightCards() {
    this.highlights = new Map();
    this.highlightTimers = new Map(); // highlight id → timer
    this.highlightClosed = this.homey.flow.getTriggerCard('highlight_closed');

    const highlightCard = this.homey.flow.getActionCard('highlight_widget');
    highlightCard.registerRunListener((args) => this.openHighlight(args));
    highlightCard.registerArgumentAutocompleteListener('screen', (query) => this.screenChoices(query, 'All screens'));
    highlightCard.registerArgumentAutocompleteListener('dashboard', (query) => this.dashboardChoices(query));
    // Homey hands over the card's other arguments, so the list holds the widgets of the dashboard picked first.
    highlightCard.registerArgumentAutocompleteListener('widget', (query, args) => this.widgetChoices(query, args?.dashboard?.id));

    const closeCard = this.homey.flow.getActionCard('close_highlight');
    closeCard.registerArgumentAutocompleteListener('screen', (query) => this.screenChoices(query, 'All screens'));
    closeCard.registerRunListener(({ screen }) => {
      const target = this.screenArg(screen);
      const ids = target === ALL_SCREENS ? [...this.highlights.values()].map((highlight) => highlight.id) : [this.highlights.get(target)?.id];
      for (const id of new Set(ids)) this.closeHighlight(id, 'flow');
    });

    const openCard = this.homey.flow.getConditionCard('highlight_open');
    openCard.registerArgumentAutocompleteListener('screen', (query) => this.screenChoices(query, 'Any screen'));
    openCard.registerRunListener(({ screen }) => {
      const target = this.screenArg(screen);
      return target === ALL_SCREENS ? this.highlights.size > 0 : this.highlights.has(target);
    });
  }

  async dashboardChoices(query) {
    const dashboards = Object.values(await this.getFromHomey('/api/manager/dashboards/dashboard'));
    return dashboards
      .filter((dashboard) => matches(query, dashboard.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((dashboard) => ({ id: dashboard.id, name: dashboard.name }));
  }

  // Named by its title, else the device or zone it shows, else its kind. Without a dashboard picked, all of them.
  async widgetChoices(query, dashboardId) {
    const [dashboards, devices, zones] = await Promise.all([
      this.getFromHomey('/api/manager/dashboards/dashboard'),
      this.getFromHomey('/api/manager/devices/device').catch(() => ({})),
      this.getFromHomey('/api/manager/zones/zone').catch(() => ({})),
    ]);
    const shown = dashboards[dashboardId] ? [dashboards[dashboardId]] : Object.values(dashboards);
    return shown
      .flatMap((dashboard) => (dashboard.columns ?? []).flatMap((column, index) => column.widgets.map((widget) => {
        const kind = WIDGET_TYPES[widget.type] ?? widget.type;
        const data = widget.data ?? {};
        const subject = devices[data.deviceId ?? data.cameraId ?? data.lightId ?? data.speakerId]?.name ?? zones[data.zoneId]?.name;
        const name = widget.title || subject || kind;
        const where = shown.length > 1 ? `${dashboard.name}, column ${index + 1}` : `Column ${index + 1}`;
        return {
          id: widget.id,
          dashboardId: dashboard.id,
          name,
          description: name === kind ? where : `${kind} · ${where}`,
        };
      })))
      .filter((choice) => matches(query, choice.name, choice.description));
  }

  async openHighlight({ screen, dashboard, widget, size, seconds }) {
    const target = this.screenArg(screen);
    if (dashboard?.id != null && dashboard.id !== widget.dashboardId) {
      throw new Error(`${widget.name} isn't on ${dashboard.name}. Pick the widget again.`);
    }
    const dashboards = await this.getFromHomey('/api/manager/dashboards/dashboard');
    const board = dashboards[widget.dashboardId];
    const found = (board?.columns ?? []).flatMap((column) => column.widgets).find((candidate) => candidate.id === widget.id);
    if (found == null) throw new Error(`${widget.name} is no longer on its dashboard. Pick the widget again.`);

    const highlight = {
      id: crypto.randomBytes(8).toString('hex'),
      target,
      dashboardId: board.id,
      widgetId: widget.id,
      // The card keeps the name the widget had when it was picked; a title given since is the better one.
      name: found.title || widget.name,
      dashboardName: board.name,
      size: size === 'fullscreen' ? 'fullscreen' : 'large',
    };
    // A new highlight replaces what those screens showed without counting as closing it.
    const replaced = new Set([...this.highlights.values()].map((shown) => shown.id));
    if (target === ALL_SCREENS) {
      this.highlights.clear();
      for (const id of [ALL_SCREENS, ...Object.keys(this.screens())]) this.highlights.set(id, highlight);
    } else {
      this.highlights.set(target, highlight);
    }
    // The timer of a highlight no screen shows any more has nothing left to close.
    const still = new Set([...this.highlights.values()].map((shown) => shown.id));
    for (const id of replaced) {
      if (!still.has(id)) this.dropHighlightTimer(id);
    }
    if (seconds > 0) this.highlightTimers.set(highlight.id, this.homey.setTimeout(() => this.closeHighlight(highlight.id, 'timer'), seconds * 1000));
    this.log(`Highlight ${widget.name} on ${board.name} (${highlight.size}) on ${this.screenLabel(target)}`);
    this.announceHighlights();
  }

  dropHighlightTimer(id) {
    this.homey.clearTimeout(this.highlightTimers.get(id));
    this.highlightTimers.delete(id);
  }

  // Closes a highlight on every screen showing it. closedBy: 'flow', 'timer' or 'screen'.
  closeHighlight(id, closedBy) {
    const closing = [...this.highlights].filter(([, highlight]) => highlight.id === id);
    if (closing.length === 0) return;
    const [, closed] = closing[0];
    for (const [screenId] of closing) this.highlights.delete(screenId);
    this.dropHighlightTimer(id);
    this.log(`Highlight of ${closed.name} closed (${closedBy})`);
    this.announceHighlights();
    this.highlightClosed.trigger({
      widget: closed.name, dashboard: closed.dashboardName, screen: this.screenLabel(closed.target), closed_by: closedBy,
    }).catch(this.error);
  }

  // Public route: a dashboard asks on load and after reconnecting. A browser without a known screen id gets the
  // highlight for all screens.
  getHighlight(screenId) {
    const known = validScreenId(screenId) && this.screens()[screenId] != null;
    return { highlight: this.highlights.get(known ? screenId : ALL_SCREENS) ?? null };
  }

  // Public route, because a dashboard's key can't reach the app's other routes. It acts only on the highlight that
  // screen showed, not on one that replaced it meanwhile.
  async closeHighlightFromScreen({ token, id }) {
    await this.checkKey(token);
    if (this.getDashboardAccess().isBrokerToken(token)) {
      const session = this.getDashboardAccess().authorize(token);
      if (this.getHighlight(session.screenId).highlight?.id !== id) return {};
    }
    if (id != null) this.closeHighlight(id, 'screen');
    return {};
  }

  // The dashboards listen for this on homey:app:<app id> and each picks its own.
  announceHighlights() {
    this.homey.api.realtime('highlight', { highlights: Object.fromEntries(this.highlights) });
  }
};
