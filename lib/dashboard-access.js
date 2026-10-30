'use strict';

const crypto = require('node:crypto');

const SESSION_KEY = 'workspaceSessions';
const DAY = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 64;
const MAX_SUBSCRIPTIONS = 128;
const MAX_TOPICS = 256;
const MAX_EVENTS = 256;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const POLLER_IDLE_MS = 120000;
const SESSION_TOKEN = /^wd_[a-f0-9]{64}$/;
const SCREEN_ID = /^[\w-]{8,64}$/;
const SAFE_SEGMENT = /^[\w:@.-]+$/;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

function failure(message, status = 403) {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  return error;
}

// Validate the raw path before URL resolution can normalize away traversal. A decoded segment is never decoded
// again; encoded slashes, percent signs, fragments and alternate origins cannot enter the owner's request.
function parsePath(value) {
  if (typeof value !== 'string' || value.length > 12000 || !value.startsWith('/api/') || /[\\#\s]/.test(value)
      || value.includes('//')) throw failure('This dashboard request is not allowed.');
  const question = value.indexOf('?');
  const path = question < 0 ? value : value.slice(0, question);
  const query = new URLSearchParams(question < 0 ? '' : value.slice(question + 1));
  const segments = path.replace(/\/$/, '').slice(1).split('/').map((part) => {
    let decoded;
    try { decoded = decodeURIComponent(part); } catch { throw failure('Invalid dashboard request.', 400); }
    if (!SAFE_SEGMENT.test(decoded) || decoded === '.' || decoded === '..' || decoded.length > 512) {
      throw failure('This dashboard request is not allowed.');
    }
    return decoded;
  });
  return { path, query, segments, decoded: `/${segments.join('/')}` };
}

function allowedQuery(query, names) {
  for (const key of query.keys()) {
    if (!names.includes(key) || query.getAll(key).length !== 1 || query.get(key).length > 8000) {
      throw failure('This dashboard query is not allowed.');
    }
  }
}

function bodyKeys(body, keys) {
  if (!object(body) || Object.keys(body).some((key) => !keys.includes(key))) throw failure('Invalid dashboard request body.', 400);
}

function isCameraOffer(method, path, body) {
  return method === 'POST' && typeof path === 'string'
    && /^\/api\/manager\/videos\/video\/[\w:@.-]+\/offer$/.test(path)
    && object(body) && Object.keys(body).length === 1 && own(body, 'offer')
    && typeof body.offer === 'string' && body.offer.length > 0 && body.offer.length <= 256000;
}

const READ_COLLECTIONS = new Set([
  '/api/manager/devices/device', '/api/manager/zones/zone', '/api/manager/flow/flow',
  '/api/manager/flow/advancedflow', '/api/manager/flow/flowfolder', '/api/manager/moods/mood',
  '/api/manager/notifications/notification', '/api/manager/notifications/owner', '/api/manager/logic/variable',
  '/api/manager/users/user', '/api/manager/users/user/me', '/api/manager/weather/weather', '/api/manager/system',
]);
const MANAGER_EVENTS = {
  dashboards: ['dashboard.create', 'dashboard.update', 'dashboard.delete'],
  users: ['user.update'], images: ['image.update'], zones: ['zone.update'],
  notifications: ['notification.create', 'notification.delete'], logic: ['variable.update'],
  apps: ['app.create', 'app.update'],
};
const APP_EVENTS = ['show-dashboard', 'widget-modes', 'highlight', 'screens'];
const BROKER_SCOPES = ['homey.dashboard.readonly', 'homey.dashboard', 'homey.device.readonly', 'homey.device.control',
  'homey.flow.readonly', 'homey.flow.start', 'homey.mood.readonly', 'homey.mood.set', 'homey.presence.self'];
const grants = (scopes, scope) => scope.split('.').some((_, index, parts) => scopes.includes(parts.slice(0, index + 1).join('.')));

// This is an app-owned capability boundary, not a general proxy for the owner's API. Owner credentials are only
// used on this side. Sessions persist as hashes in Homey's settings database and survive app restarts.
class DashboardAccess {
  constructor({ homey, app, appId, fetchImpl = fetch, now = Date.now }) {
    this.homey = homey;
    this.app = app;
    this.appId = appId;
    this.fetch = fetchImpl;
    this.now = now;
    this.ownerToken = null;
    this.ownerCredentials = new Set();
    this.ownerPromise = null;
    this.epoch = crypto.randomBytes(8).toString('hex');
    this.sequence = 0;
    this.buffer = [];
    this.bufferBytes = 0;
    this.topics = new Map();
    this.topicGeneration = 0;
    this.pollers = new Map();
    this.inventory = null;
  }

  isBrokerToken(token) { return typeof token === 'string' && SESSION_TOKEN.test(token); }

  hash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

  sessions() {
    const saved = this.homey.settings.get(SESSION_KEY);
    return object(saved) ? { ...saved } : {};
  }

  issue({ screenId, kind = 'native' } = {}) {
    const token = `wd_${crypto.randomBytes(32).toString('hex')}`;
    const id = SCREEN_ID.test(screenId ?? '') ? screenId : `native-${crypto.randomBytes(12).toString('hex')}`;
    const createdAt = this.now();
    const expiresAt = createdAt + (kind === 'paired' ? 30 * DAY : DAY);
    const sessions = this.sessions();
    for (const [hash, session] of Object.entries(sessions)) {
      if (!object(session) || session.expiresAt <= createdAt
          || (kind === 'paired' && session.screenId === id && session.kind === kind)) delete sessions[hash];
    }
    const oldest = Object.entries(sessions).sort(([, a], [, b]) => a.createdAt - b.createdAt);
    for (const [hash] of oldest.slice(0, Math.max(0, oldest.length - MAX_SESSIONS + 1))) delete sessions[hash];
    sessions[this.hash(token)] = { screenId: id, kind, createdAt, expiresAt };
    this.homey.settings.set(SESSION_KEY, sessions);
    return { token, transport: 'broker', screenId: id, expiresAt };
  }

  authorize(token) {
    if (!this.isBrokerToken(token)) throw failure('Connect this screen to Homey again.', 401);
    const session = this.sessions()[this.hash(token)];
    if (!object(session) || !SCREEN_ID.test(session.screenId ?? '') || !Number.isFinite(session.expiresAt)
        || session.expiresAt <= this.now()) throw failure('This screen connection expired or was revoked. Connect it again.', 401);
    return session;
  }

  async revokeScreen(screenId) {
    const sessions = this.sessions();
    for (const [hash, session] of Object.entries(sessions)) {
      if (session.screenId === screenId) {
        delete sessions[hash];
        this.pollers.delete(hash);
      }
    }
    this.homey.settings.set(SESSION_KEY, sessions);
    if (!this.closed) await this.syncTopics();
  }

  async connect({ screenId } = {}) {
    // A signed-in settings view requested this connection. No owner token is requested merely by installing the app
    // or by an unknown browser asking for a pairing code.
    try {
      await this.ownerRequest('GET', '/api/manager/dashboards/dashboard');
    } catch (error) {
      if (error.status === 403 && /Missing\s*Scopes/i.test(error.message)) {
        throw failure('Native dashboard access needs authorization. Authorize the dedicated dashboard key, then reload this view.', 403);
      }
      throw error;
    }
    return this.issue({ screenId });
  }

  rememberCredential(token) {
    this.ownerCredentials.add(token);
    while (this.ownerCredentials.size > 4) this.ownerCredentials.delete(this.ownerCredentials.values().next().value);
  }

  configuredToken() {
    const value = this.homey.settings.get('apiKey');
    const token = typeof value === 'string' && value.trim() ? value.trim() : null;
    if (token !== this.lastConfiguredToken) {
      this.lastConfiguredToken = token;
      this.inventory = null;
    }
    if (token) this.rememberCredential(token);
    return token;
  }

  async getOwnerCredential() {
    const configured = this.configuredToken();
    if (configured) return { token: configured, source: 'configured' };
    const generated = await this.getGeneratedOwnerToken();
    // A settings change while the SDK was responding takes effect before a request is sent.
    const latest = this.configuredToken();
    return latest ? { token: latest, source: 'configured' } : { token: generated, source: 'generated' };
  }

  async getOwnerToken() { return (await this.getOwnerCredential()).token; }

  async getGeneratedOwnerToken() {
    if (this.ownerToken) return this.ownerToken;
    if (!this.ownerPromise) {
      this.ownerPromise = Promise.resolve().then(() => this.homey.api.getOwnerApiToken()).then((token) => {
        if (typeof token !== 'string' || token.length === 0) throw new Error('Missing Homey credential.');
        this.ownerToken = token;
        this.rememberCredential(token);
        return token;
      }).catch(() => { throw failure('Automatic Homey connection is unavailable. Reopen the app configuration and connect again.', 503); })
        .finally(() => { this.ownerPromise = null; });
    }
    return this.ownerPromise;
  }

  async ownerRequest(method, path, body) {
    // Camera startup can wait for its source. Other reads and controls retain
    // their existing limit; callers cannot supply a timeout override.
    const cameraOffer = isCameraOffer(method, path, body);
    const timeout = cameraOffer ? 45000 : 15000;
    const local = await this.homey.api.getLocalUrl();
    const base = new URL(local);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw failure('Homey returned an invalid local address.', 503);
    // Match Homey's official app API client: the local server validates its identity header as well as the bearer
    // session. Resolve this from the SDK, never from a browser request or a hardcoded installation address.
    this.homeyId ??= await this.homey.cloud.getHomeyId();
    if (typeof this.homeyId !== 'string' || !this.homeyId) throw failure('Homey could not confirm its local identity.', 503);
    let response;
    let requestToken;
    let requestSignal;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { token, source } = await this.getOwnerCredential();
      requestToken = token;
      requestSignal = AbortSignal.timeout(timeout);
      try {
        response = await this.fetch(`${base.origin}${path}`, {
          method, redirect: 'error', signal: requestSignal,
          headers: { Authorization: `Bearer ${token}`, 'X-Homey-ID': this.homeyId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        if (cameraOffer && requestSignal.aborted) throw failure('The camera did not finish connecting. Tap to retry.', 504);
        throw failure('Homey could not be reached. Try again.', 502);
      }
      // A configured key is an explicit access choice. Its rejection must remain visible rather than switching to
      // another credential or replaying a command. Only the SDK-generated session may renew once after a 401.
      if (response.status !== 401 || attempt === 1 || source === 'configured') break;
      // Only a refused credential gets another attempt. A timeout, ambiguous write, or any other failure never
      // repeats a physical command. Concurrent 401s do not invalidate a credential that another request renewed.
      if (this.ownerToken === token) this.ownerToken = null;
    }
    if (!response.ok) {
      let detail = '';
      try {
        const error = this.redact(await response.json(), [requestToken]);
        const reason = error?.error_description ?? error?.message ?? error?.error?.message ?? error?.error;
        if (typeof reason === 'string') detail = reason.replace(/[\r\n\t]/g, ' ').slice(0, 240);
      } catch { /* A non-JSON refusal still retains its status without exposing a raw response. */ }
      throw failure(`Homey refused this dashboard request (${response.status}).${detail ? ` ${detail}` : ''}`, response.status);
    }
    if (response.status === 204) return null;
    let result;
    try { result = await response.json(); } catch {
      if (cameraOffer && requestSignal.aborted) throw failure('The camera did not finish connecting. Tap to retry.', 504);
      throw failure('Homey returned an unreadable response.', 502);
    }
    // Even a widget that echoes its request must not turn the broker into a way to retrieve its owner credential.
    return this.redact(result, [requestToken]);
  }

  redact(value, extraCredentials = []) {
    let serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    for (const token of new Set([...this.ownerCredentials, ...extraCredentials])) {
      if (typeof token === 'string' && token) serialized = serialized.split(token).join('[redacted]');
    }
    return JSON.parse(serialized);
  }

  async widgetInventory() {
    if (this.inventory && this.inventory.expiresAt > this.now()) return this.inventory;
    const [dashboards, definitions] = await Promise.all([
      this.ownerRequest('GET', '/api/manager/dashboards/dashboard'),
      this.ownerRequest('GET', '/api/manager/dashboards/appwidget'),
    ]);
    const widgets = new Map();
    const stores = new Set();
    const apps = new Set();
    for (const dashboard of Object.values(dashboards ?? {})) {
      for (const column of dashboard.columns ?? []) {
        for (const widget of column.widgets ?? []) {
          stores.add(widget.id);
          const definition = definitions?.[widget.data?.appWidgetId];
          if (widget.type !== 'app_webview' || !definition?.ownerUri?.startsWith('homey:app:')) continue;
          const appId = definition.ownerUri.slice('homey:app:'.length);
          apps.add(appId);
          widgets.set(`${appId}/${definition.ownerId}/${widget.id}`, definition);
        }
      }
    }
    this.inventory = { widgets, stores, apps, expiresAt: this.now() + 15000 };
    return this.inventory;
  }

  async request({ token, method, path, body } = {}) {
    const session = this.authorize(token);
    if (typeof method !== 'string' || !['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw failure('This dashboard method is not allowed.');
    if (body !== undefined && Buffer.byteLength(JSON.stringify(body) ?? '') > 1024 * 1024) throw failure('Dashboard request is too large.', 413);
    const parsed = parsePath(path);
    const { decoded, segments, query } = parsed;
    const ownBase = `/api/app/${this.appId}`;
    if (decoded === '/api/manager/sessions/session/me' && method === 'GET') {
      allowedQuery(query, []);
      // The renderer checks edit permission here. Intersect the backend credential's actual effective scopes with
      // our supported controls, without forwarding session credentials, user information, or administrative scopes.
      const session = await this.ownerRequest('GET', '/api/manager/sessions/session/me');
      const effective = session?.intersectedScopes ?? session?.scopes;
      const actual = Array.isArray(effective) ? effective.filter((scope) => typeof scope === 'string') : [];
      const scopes = BROKER_SCOPES.filter((scope) => grants(actual, scope));
      return { scopes, intersectedScopes: scopes };
    }
    if (decoded.startsWith(`${ownBase}/`)) return this.ownRequest(session, token, method, parsed, body);

    let permitted = false;
    let queries = [];
    if (method === 'GET') {
      permitted = READ_COLLECTIONS.has(decoded)
        || /^\/api\/manager\/dashboards\/dashboard(?:\/[\w:@.-]+)?$/.test(decoded)
        || /^\/api\/manager\/dashboards\/appwidget(?:\/[\w:@.-]+)?$/.test(decoded)
        || /^\/api\/manager\/insights\/log(?:\/[\w:@.-]+)?$/.test(decoded);
      if (/^\/api\/manager\/insights\/log\/[\w:@.-]+\/[\w:@.-]+\/entry$/.test(decoded)) {
        permitted = true; queries = ['resolution'];
      }
      if (decoded === '/api/manager/energy/live') { permitted = true; queries = ['zone']; }
      if (decoded === '/api/manager/energy/price/electricity/type') permitted = true;
      if (decoded === '/api/manager/energy/price/electricity/dynamic') { permitted = true; queries = ['date']; }
      if (/^\/api\/manager\/dashboards\/appwidget\/[\w:@.-]+\/autocomplete$/.test(decoded)) {
        permitted = true; queries = ['settingId', 'query', 'settings'];
      }
      if (/^\/api\/manager\/dashboards\/widgetstore\/[\w:@.-]+\/state$/.test(decoded)) {
        permitted = (await this.widgetInventory()).stores.has(segments[4]);
      }
      if (decoded === `/api/manager/apps/app/${this.appId}`) {
        allowedQuery(query, []);
        return { id: this.appId, version: this.app.manifest?.version };
      }
      if (/^\/api\/manager\/apps\/app\/[\w:@.-]+\/locale$/.test(decoded)) {
        permitted = (await this.widgetInventory()).apps.has(segments[4]);
      }
      if (body !== undefined && body !== null) throw failure('GET requests cannot change data.', 400);
    } else if (method === 'PUT' && /^\/api\/manager\/devices\/device\/[\w:@.-]+\/capability\/[\w:@.-]+$/.test(decoded)) {
      bodyKeys(body, ['value']);
      if (!own(body, 'value') || !['boolean', 'number', 'string'].includes(typeof body.value)
          || (typeof body.value === 'number' && !Number.isFinite(body.value))) throw failure('Invalid device control value.', 400);
      permitted = true;
    } else if (method === 'POST' && /^\/api\/manager\/(?:flow\/(?:flow|advancedflow)\/[\w:@.-]+\/trigger|moods\/mood\/[\w:@.-]+\/set)$/.test(decoded)) {
      bodyKeys(body ?? {}, []); permitted = true;
    } else if (method === 'PUT' && /^\/api\/manager\/dashboards\/dashboard\/[\w:@.-]+$/.test(decoded)) {
      bodyKeys(body, ['name', 'columns']);
      if ((!own(body, 'name') && !own(body, 'columns')) || (own(body, 'name') && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200))
          || (own(body, 'columns') && (!Array.isArray(body.columns) || body.columns.length > 50))) throw failure('Invalid dashboard layout.', 400);
      permitted = true;
      this.inventory = null;
    } else if (method === 'PUT' && /^\/api\/manager\/presence\/me\/(?:present|asleep)$/.test(decoded)) {
      bodyKeys(body, ['value']);
      if (typeof body.value !== 'boolean') throw failure('Invalid presence value.', 400);
      permitted = true;
    } else if (method === 'POST' && /^\/api\/manager\/videos\/video\/[\w:@.-]+\/(?:offer|keep-alive)$/.test(decoded)) {
      const key = segments[5] === 'offer' ? 'offer' : 'streamId';
      bodyKeys(body, [key]);
      if (typeof body[key] !== 'string' || !body[key] || body[key].length > 256000) throw failure('Invalid camera request.', 400);
      permitted = true;
    }

    if (segments[0] === 'api' && segments[1] === 'app' && segments[3] === 'widget' && segments.length >= 6) {
      const inventory = await this.widgetInventory();
      const definition = inventory.widgets.get(`${segments[2]}/${segments[4]}/${segments[5]}`);
      if (definition) {
        // App-widget API access is restricted to an instance actually used on a dashboard. The widget API is a
        // different namespace from app settings/admin APIs, and traversal was rejected before matching it.
        permitted = true;
        queries = [...query.keys()];
      }
    }
    if (!permitted) throw failure('This action is outside dashboard access.');
    allowedQuery(query, queries);
    return this.ownerRequest(method, path, body);
  }

  async ownRequest(session, token, method, { decoded, query }, body) {
    const prefix = `/api/app/${this.appId}`;
    const suffix = decoded.slice(prefix.length);
    if (suffix === '/screen-hello' && method === 'POST') {
      allowedQuery(query, []); bodyKeys(body, ['token', 'id', 'name']);
      if (body.id !== session.screenId) throw failure('A screen can only register its own connection.');
      return this.app.screenHello({ ...body, token });
    }
    if (suffix === '/widget-modes' && method === 'GET') { allowedQuery(query, []); return this.app.widgetModes(); }
    if (/^\/widget-modes\/[\w-]+$/.test(suffix) && method === 'PUT') {
      allowedQuery(query, []); bodyKeys(body, ['token', 'mode']);
      return this.app.setWidgetMode(suffix.split('/')[2], { token, mode: body.mode });
    }
    if (suffix === '/highlight' && method === 'GET') {
      allowedQuery(query, ['screen']);
      if (query.has('screen') && query.get('screen') !== session.screenId) throw failure('A screen can only read its own highlight.');
      return this.app.getHighlight(session.screenId);
    }
    if (suffix === '/highlight/close' && method === 'POST') {
      allowedQuery(query, []); bodyKeys(body, ['token', 'id']);
      return this.app.closeHighlightFromScreen({ token, id: body.id });
    }
    throw failure('App administration is unavailable to dashboard screens.');
  }

  async validateSubscription({ uri, event } = {}) {
    if (typeof uri !== 'string' || uri.length > 200 || typeof event !== 'string' || event.length > 100) throw failure('Invalid realtime subscription.', 400);
    const manager = /^homey:manager:(\w+)$/.exec(uri)?.[1];
    if (manager && MANAGER_EVENTS[manager]?.includes(event)) return;
    if (/^homey:device:[\w-]+$/.test(uri) && event === 'capability') return;
    if (uri === `homey:app:${this.appId}` && APP_EVENTS.includes(event)) return;
    if (/^homey:widgetstore:[\w-]+$/.test(uri) && event === 'state' && (await this.widgetInventory()).stores.has(uri.slice('homey:widgetstore:'.length))) return;
    if (/^homey:app:[\w.-]+$/.test(uri) && uri !== `homey:app:${this.appId}`
        && (await this.widgetInventory()).apps.has(uri.slice('homey:app:'.length))) return;
    throw failure('This realtime subscription is outside dashboard access.');
  }

  record(uri, event, data) {
    if (uri === 'homey:manager:apps') {
      data = Object.fromEntries(['id', 'version', 'state', 'origin']
        .filter((key) => typeof data?.[key] === 'string').map((key) => [key, data[key]]));
    }
    let serialized;
    try { serialized = JSON.stringify(this.redact({ uri, event, data })); } catch { return; }
    const bytes = Buffer.byteLength(serialized);
    if (bytes > MAX_EVENT_BYTES / 2) return;
    const copy = JSON.parse(serialized);
    this.buffer.push({ sequence: ++this.sequence, bytes, ...copy });
    this.bufferBytes += bytes;
    while (this.buffer.length > MAX_EVENTS || this.bufferBytes > MAX_EVENT_BYTES) this.bufferBytes -= this.buffer.shift().bytes;
    if (uri === 'homey:manager:dashboards') this.inventory = null;
  }

  async events({ token, subscriptions = [], cursor } = {}) {
    const session = this.authorize(token);
    if (!Array.isArray(subscriptions) || subscriptions.length > MAX_SUBSCRIPTIONS) throw failure('Too many realtime subscriptions.', 400);
    const selected = new Set();
    for (const subscription of subscriptions) {
      if (!object(subscription)) throw failure('Invalid realtime subscription.', 400);
      await this.validateSubscription(subscription);
      selected.add(`${subscription.uri}\n${subscription.event}`);
    }
    const hash = this.hash(token);
    const previous = this.pollers.get(hash);
    // An unchanged event cursor cannot reveal updates missed while no API topic was registered. Check coverage
    // before refreshing lastSeen or registering topics, including topics another screen opened since this poller.
    const observationGap = !previous || this.now() - previous.lastSeen > POLLER_IDLE_MS
      || [...selected].some((subscription) => {
        const topic = this.topics.get(subscription.split('\n')[0]);
        return !topic || topic.generation > previous.topicGeneration;
      });
    const poller = { subscriptions: selected, lastSeen: this.now(), topicGeneration: this.topicGeneration };
    this.pollers.set(hash, poller);
    try { await this.syncTopics(); } catch (error) {
      if (previous) this.pollers.set(hash, previous);
      else this.pollers.delete(hash);
      throw error;
    }
    poller.topicGeneration = this.topicGeneration;
    this.ensurePruneTimer();
    const current = `${this.epoch}:${this.sequence}`;
    if (cursor == null) return { cursor: current, events: [] };
    const match = typeof cursor === 'string' && /^([a-f0-9]{16}):(\d{1,16})$/.exec(cursor);
    const since = match ? Number(match[2]) : -1;
    if (observationGap || !match || match[1] !== this.epoch || since > this.sequence || since < (this.buffer[0]?.sequence ?? this.sequence + 1) - 1) {
      return { cursor: current, events: [], reset: true };
    }
    const events = this.buffer.filter((entry) => entry.sequence > since && selected.has(`${entry.uri}\n${entry.event}`))
      .map(({ uri, event, data }) => {
        if (uri === `homey:app:${this.appId}` && event === 'highlight') {
          data = { highlights: { [session.screenId]: data?.highlights?.[session.screenId] ?? null, all: data?.highlights?.all ?? null } };
        }
        return { uri, event, data };
      }).filter(({ uri, event, data }) => uri !== `homey:app:${this.appId}` || event !== 'show-dashboard'
        || data?.screenId === 'all' || data?.screenId === session.screenId);
    return { cursor: current, events };
  }

  syncTopics() {
    if (this.closed) return Promise.reject(failure('The dashboard app is restarting. Reconnect shortly.', 503));
    const work = (this.topicSync ?? Promise.resolve()).then(() => this.updateTopics());
    this.topicSync = work.catch(() => {});
    return work;
  }

  ensurePruneTimer() {
    if (this.closed || this.pruneTimer != null || this.pollers.size === 0) return;
    // The last screen may close without another request. A Homey-managed timer releases its subscriptions even
    // when no browser remains to trigger a poll, and is itself stopped once no pollers remain.
    this.pruneTimer = this.homey.setInterval(() => this.syncTopics().catch(() => {}), 30000);
  }

  stopPruneTimer() {
    if (this.pruneTimer == null) return;
    this.homey.clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  async updateTopics() {
    if (this.closed) return;
    const needed = new Set();
    const sessions = this.sessions();
    for (const [hash, poller] of this.pollers) {
      if (this.now() - poller.lastSeen > POLLER_IDLE_MS || !sessions[hash] || sessions[hash].expiresAt <= this.now()) { this.pollers.delete(hash); continue; }
      for (const subscription of poller.subscriptions) needed.add(subscription.split('\n')[0]);
    }
    if (this.pollers.size === 0) this.stopPruneTimer();
    if (needed.size > MAX_TOPICS) throw failure('Too many active dashboard subscriptions.', 429);
    for (const [uri, topic] of this.topics) {
      if (!needed.has(uri)) {
        this.topics.delete(uri);
        await this.releaseTopic(topic);
      }
    }
    for (const uri of needed) {
      if (this.topics.has(uri)) continue;
      const api = await this.homey.api.getApi(uri);
      const listener = (event, data) => this.record(uri, event, data);
      const topic = { api, listener };
      if (this.closed) { await this.releaseTopic(topic); return; }
      try {
        api.on('realtime', listener);
        topic.generation = ++this.topicGeneration;
        this.topics.set(uri, topic);
      } catch (error) {
        await this.releaseTopic(topic);
        throw error;
      }
    }
  }

  async releaseTopic(topic) {
    // Only release the exact API reference acquired for this topic. Removing the listener alone leaves the SDK's
    // registration alive. Both SDK variants (synchronous and Promise-returning unregister) are awaited safely.
    try { topic.api.removeListener?.('realtime', topic.listener); } catch { /* Continue releasing the registration. */ }
    try { await topic.api.unregister(); } catch { /* Shutdown must still release every other owned reference. */ }
  }

  close() {
    if (!this.closing) {
      this.closed = true;
      this.stopPruneTimer();
      this.closing = (async () => {
        // A getApi already in progress owns a registration too; updateTopics releases it as soon as it arrives.
        await this.topicSync;
        for (const topic of this.topics.values()) await this.releaseTopic(topic);
        this.topics.clear(); this.pollers.clear(); this.ownerToken = null; this.ownerCredentials.clear();
        this.lastConfiguredToken = null;
      })();
    }
    return this.closing;
  }
}

module.exports = { DashboardAccess, failure };
