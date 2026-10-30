'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { DashboardAccess } = require('../lib/dashboard-access');

const APP_ID = 'dev.schweiger.dashboard';
const SCREEN = 'screen-12345678';
const DAY = 24 * 60 * 60 * 1000;
const clone = (value) => value === undefined ? undefined : structuredClone(value);

function fixture() {
  const saved = new Map();
  const calls = [];
  const topics = new Map();
  const released = new Map();
  const timers = new Map();
  let nextTimer = 0;
  let now = 1000000;
  let ownerCalls = 0;
  let answer = null;
  const homey = {
    setInterval(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
    settings: { get: (key) => clone(saved.get(key)), set: (key, value) => saved.set(key, clone(value)), unset: (key) => saved.delete(key) },
    api: {
      getLocalUrl: async () => 'http://127.0.0.1:4859',
      getOwnerApiToken: async () => `server-only-owner-${++ownerCalls}`,
      getApi: async (uri) => {
        if (!topics.has(uri)) {
          const api = new EventEmitter();
          api.unregister = async () => {
            await Promise.resolve();
            released.set(uri, (released.get(uri) ?? 0) + 1);
          };
          topics.set(uri, api);
        }
        return topics.get(uri);
      },
      realtime() {},
    },
  };
  const data = {
    '/api/manager/dashboards/dashboard': { board: { id: 'board', name: 'House', columns: [{ id: 'column', widgets: [
      { id: 'widget-12345678', type: 'app_webview', data: { appWidgetId: 'catalog' } },
      { id: 'note-12345678', type: 'note' },
    ] }] } },
    '/api/manager/dashboards/appwidget': { catalog: { id: 'catalog', ownerUri: 'homey:app:com.example.widget', ownerId: 'clock' } },
  };
  const app = {
    manifest: { id: APP_ID, version: '1.4.0' },
    screenHello: async (body) => ({ name: body.name }),
    widgetModes: () => ({ 'widget-12345678': 'sandboxed' }),
    setWidgetMode: async (id, body) => ({ id, mode: body.mode }),
    getHighlight: (id) => ({ highlight: { id: 'highlight', target: id } }),
    closeHighlightFromScreen: async () => ({}),
  };
  const access = new DashboardAccess({ homey, app, appId: APP_ID, now: () => now,
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (answer) return answer(url, options, calls.length);
      return { ok: true, status: 200, json: async () => clone(data[new URL(url).pathname] ?? { success: true }) };
    },
  });
  return { homey, app, access, saved, calls, topics, released, timers, data,
    tickTimers: async () => { for (const callback of [...timers.values()]) await callback(); },
    advance: (amount) => { now += amount; }, ownerCalls: () => ownerCalls,
    respond: (fn) => { answer = fn; },
  };
}

const request = (access, token, method, route, body) => access.request({ token, method, path: route, body });
const denied = (status) => (error) => error.status === status && error.statusCode === status;

test('connections are lazy, opaque, hashed, persistent, bounded, and revocable by screen', async () => {
  const f = fixture();
  const native = f.access.issue({ screenId: SCREEN });
  const secondTab = f.access.issue({ screenId: SCREEN });
  const paired = f.access.issue({ screenId: SCREEN, kind: 'paired' });
  assert.equal(native.transport, 'broker');
  assert.match(native.token, /^wd_[a-f0-9]{64}$/);
  assert.equal(native.expiresAt, 1000000 + DAY);
  assert.equal(paired.expiresAt, 1000000 + 30 * DAY);
  assert.equal(f.ownerCalls(), 0);
  assert.equal(JSON.stringify([...f.saved]).includes(native.token), false);
  assert.equal(JSON.stringify([...f.saved]).includes(paired.token), false);
  const restarted = new DashboardAccess({ homey: f.homey, app: f.app, appId: APP_ID, now: () => 1000000 });
  assert.equal(restarted.authorize(native.token).screenId, SCREEN);
  assert.equal(restarted.authorize(secondTab.token).screenId, SCREEN);
  await f.access.revokeScreen(SCREEN);
  assert.throws(() => restarted.authorize(native.token), denied(401));
  assert.throws(() => restarted.authorize(secondTab.token), denied(401));
  assert.throws(() => restarted.authorize(paired.token), denied(401));
  for (let i = 0; i < 80; i += 1) f.access.issue({ screenId: `screen-${String(i).padStart(8, '0')}` });
  assert.equal(Object.keys(f.homey.settings.get('workspaceSessions')).length, 64);
});

test('expired sessions fail before any owner authentication or network request', async () => {
  const f = fixture();
  const { token } = f.access.issue({ screenId: SCREEN });
  f.advance(DAY);
  await assert.rejects(request(f.access, token, 'GET', '/api/manager/devices/device'), denied(401));
  assert.equal(f.calls.length, 0);
  assert.equal(f.ownerCalls(), 0);
});

test('automatic connect validates Homey access and never returns the owner credential', async () => {
  const f = fixture();
  const result = await f.access.connect({ screenId: SCREEN });
  assert.equal(f.ownerCalls(), 1);
  assert.equal(result.screenId, SCREEN);
  assert.equal(JSON.stringify(result).includes('server-only-owner'), false);
  assert.equal(JSON.stringify([...f.saved]).includes('server-only-owner'), false);
  assert.equal(f.calls[0].headers.Authorization, 'Bearer server-only-owner-1');
  assert.equal(f.calls[0].redirect, 'error');
  const scopes = await request(f.access, result.token, 'GET', '/api/manager/sessions/session/me');
  assert.ok(scopes.scopes.includes('homey.dashboard'));
  assert.equal(scopes.scopes.includes('homey'), false);
  assert.equal(f.calls.length, 1);
});

test('the broker admits the existing dashboard reads and selected controls', async () => {
  const f = fixture();
  const { token } = f.access.issue({ screenId: SCREEN });
  for (const route of [
    '/api/manager/devices/device', '/api/manager/zones/zone', '/api/manager/flow/flow',
    '/api/manager/flow/advancedflow', '/api/manager/flow/flowfolder', '/api/manager/moods/mood',
    '/api/manager/notifications/notification', '/api/manager/notifications/owner', '/api/manager/logic/variable',
    '/api/manager/users/user/me', '/api/manager/system/', '/api/manager/weather/weather',
    '/api/manager/dashboards/dashboard/board', '/api/manager/dashboards/appwidget/catalog/autocomplete?settingId=x&query=hello&settings=%7B%7D',
    '/api/manager/dashboards/widgetstore/note-12345678/state',
    '/api/manager/insights/log/homey%3Adevice%3Adevice-1/homey%3Adevice%3Adevice-1%3Ameasure_power/entry?resolution=lastHour',
    '/api/manager/energy/live?zone=living-room', '/api/manager/energy/price/electricity/dynamic?date=2026-10-29',
    '/api/manager/apps/app/com.example.widget/locale',
  ]) await request(f.access, token, 'GET', route);
  for (const [method, route, body] of [
    ['PUT', '/api/manager/devices/device/device-1/capability/onoff', { value: true }],
    ['PUT', '/api/manager/devices/device/device-1/capability/target_temperature', { value: 21 }],
    ['POST', '/api/manager/flow/flow/flow-1/trigger', {}],
    ['POST', '/api/manager/flow/advancedflow/flow-2/trigger', {}],
    ['POST', '/api/manager/moods/mood/evening/set', {}],
    ['PUT', '/api/manager/dashboards/dashboard/board', { columns: [], name: 'House' }],
    ['PUT', '/api/manager/presence/me/present', { value: true }],
    ['POST', '/api/manager/videos/video/camera-1/offer', { offer: 'v=0' }],
    ['POST', '/api/manager/videos/video/camera-1/keep-alive', { streamId: 'stream-1' }],
    ['GET', '/api/app/com.example.widget/widget/clock/widget-12345678/data', undefined],
    ['GET', '/api/app/com.example.widget/widget/clock/widget-12345678/', undefined],
  ]) await request(f.access, token, method, route, body);
  assert.equal(f.ownerCalls(), 1);
  const metadata = await request(f.access, token, 'GET', `/api/manager/apps/app/${APP_ID}`);
  assert.deepEqual(metadata, { id: APP_ID, version: '1.4.0' });
});

test('admin routes, malformed URLs, traversal, unrelated widgets, deletes and extra body fields are rejected', async () => {
  const f = fixture();
  const { token } = f.access.issue({ screenId: SCREEN });
  for (const route of [
    'http://attacker.invalid/api/manager/devices/device', '//attacker.invalid/api/manager/devices/device',
    '/api/manager/devices/device/../users/user', '/api/manager/devices/device/%2e%2e/users/user',
    '/api/manager/devices/device/%252e%252e/users/user', '/api/manager/devices/device/%2Fadmin',
    '/api/manager/devices\\device', '/api/manager/devices/device#fragment',
    '/api/manager/system/reboot', '/api/manager/sessions/session', '/api/manager/api/key',
    '/api/manager/apps/app/com.other.app', `/api/app/${APP_ID}/api-key`,
    `/api/app/${APP_ID}/workspace/connect`, '/api/app/com.example.widget/settings',
    '/api/app/com.example.widget/widget/clock/unknown-instance/data',
    '/api/manager/dashboards/widgetstore/unknown-instance/state',
    '/api/manager/devices/device?admin=true',
  ]) await assert.rejects(request(f.access, token, 'GET', route), denied(403), route);
  await assert.rejects(request(f.access, token, 'DELETE', '/api/manager/dashboards/dashboard/board'), denied(403));
  await assert.rejects(request(f.access, token, 'PUT', '/api/manager/devices/device/device-1/capability/onoff', { value: true, admin: true }), denied(400));
  await assert.rejects(request(f.access, token, 'PUT', '/api/manager/presence/somebody-else/present', { value: true }), denied(403));
  await assert.rejects(request(f.access, token, 'PUT', '/api/manager/dashboards/dashboard/board', { columns: [], permissions: ['homey'] }), denied(400));
  await assert.rejects(request(f.access, token, 'GET', '/api/manager/devices/device', { value: true }), denied(400));
});

test('401 renews once; ambiguous write failures and other errors are never replayed', async () => {
  const f = fixture();
  const { token } = f.access.issue({ screenId: SCREEN });
  f.respond(async (_url, _options, count) => count === 1
    ? { status: 401, ok: false } : { status: 200, ok: true, json: async () => ({ success: true }) });
  await request(f.access, token, 'PUT', '/api/manager/devices/device/device-1/capability/onoff', { value: true });
  assert.equal(f.ownerCalls(), 2);
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].headers.Authorization, f.calls[1].headers.Authorization);
  const before = f.calls.length;
  f.respond(async () => { throw new Error('connection timed out'); });
  await assert.rejects(request(f.access, token, 'PUT', '/api/manager/devices/device/device-1/capability/onoff', { value: false }), denied(502));
  assert.equal(f.calls.length, before + 1);
  f.respond(async () => ({ status: 500, ok: false }));
  await assert.rejects(request(f.access, token, 'PUT', '/api/manager/devices/device/device-1/capability/onoff', { value: false }), denied(500));
  assert.equal(f.calls.length, before + 2);
});

test('widget responses cannot echo the backend credential', async () => {
  const f = fixture();
  const { token } = f.access.issue({ screenId: SCREEN });
  f.respond(async (_url, options) => ({ status: 200, ok: true, json: async () => ({ echo: options.headers.Authorization }) }));
  const result = await request(f.access, token, 'GET', '/api/manager/devices/device');
  assert.equal(result.echo, 'Bearer [redacted]');
});

test('own app methods retain screen association and cannot reach app administration', async () => {
  const f = fixture();
  const { token } = f.access.issue({ screenId: SCREEN });
  const prefix = `/api/app/${APP_ID}`;
  assert.deepEqual(await request(f.access, token, 'POST', `${prefix}/screen-hello`, { token: 'ignored', id: SCREEN, name: 'Desktop' }), { name: 'Desktop' });
  await assert.rejects(request(f.access, token, 'POST', `${prefix}/screen-hello`, { id: 'other-12345678' }), denied(403));
  await assert.rejects(request(f.access, token, 'GET', `${prefix}/highlight?screen=other-12345678`), denied(403));
  assert.equal((await request(f.access, token, 'GET', `${prefix}/highlight`)).highlight.target, SCREEN);
  assert.equal((await request(f.access, token, 'PUT', `${prefix}/widget-modes/widget-12345678`, { mode: 'storage' })).mode, 'storage');
  await assert.rejects(request(f.access, token, 'POST', `${prefix}/pairings/secret/approve`, {}), denied(403));
});

test('realtime polls subscribe once, filter events, detach, survive restart, and detect lost history', async () => {
  const f = fixture();
  const { token } = f.access.issue({ screenId: SCREEN });
  const subscriptions = [{ uri: 'homey:manager:dashboards', event: 'dashboard.update' }, { uri: `homey:app:${APP_ID}`, event: 'show-dashboard' }];
  const [first] = await Promise.all([f.access.events({ token, subscriptions }), f.access.events({ token, subscriptions })]);
  assert.equal(f.topics.get('homey:manager:dashboards').listenerCount('realtime'), 1);
  assert.equal(f.ownerCalls(), 0);
  f.topics.get('homey:manager:dashboards').emit('realtime', 'dashboard.update', { id: 'board', name: 'Renamed' });
  f.topics.get('homey:manager:dashboards').emit('realtime', 'dashboard.delete', { id: 'other' });
  f.topics.get(`homey:app:${APP_ID}`).emit('realtime', 'show-dashboard', { dashboardId: 'board', screenId: 'other-12345678' });
  const next = await f.access.events({ token, subscriptions, cursor: first.cursor });
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].data.name, 'Renamed');
  await assert.rejects(f.access.events({ token, subscriptions: [{ uri: `homey:app:${APP_ID}`, event: 'pairings' }] }), denied(403));
  await assert.rejects(f.access.events({ token, subscriptions: [{ uri: 'homey:manager:settings', event: 'settings.set' }] }), denied(403));
  for (let i = 0; i < 300; i += 1) f.access.record('homey:manager:dashboards', 'dashboard.update', { id: String(i) });
  assert.equal((await f.access.events({ token, subscriptions, cursor: first.cursor })).reset, true);
  const restarted = new DashboardAccess({ homey: f.homey, app: f.app, appId: APP_ID, now: () => 1000000 });
  assert.equal((await restarted.events({ token, subscriptions: [], cursor: next.cursor })).reset, true);
  await f.access.events({ token, subscriptions: [] });
  assert.equal(f.topics.get('homey:manager:dashboards').listenerCount('realtime'), 0);
  assert.equal(f.released.get('homey:manager:dashboards'), 1);
  assert.equal(f.released.get(`homey:app:${APP_ID}`), 1);
  await f.access.revokeScreen(SCREEN);
  await assert.rejects(f.access.events({ token, subscriptions }), denied(401));
  await f.access.close();
});

test('shutdown awaits owned API unregister calls, handles failures, and releases an in-flight registration', async () => {
  const f = fixture();
  const { token } = f.access.issue({ screenId: SCREEN });
  const subscriptions = [{ uri: 'homey:manager:dashboards', event: 'dashboard.update' }, { uri: 'homey:manager:users', event: 'user.update' }];
  await f.access.events({ token, subscriptions });
  f.topics.get('homey:manager:dashboards').unregister = async () => { throw new Error('SDK shutting down'); };
  await f.access.close();
  assert.equal(f.topics.get('homey:manager:dashboards').listenerCount('realtime'), 0);
  assert.equal(f.topics.get('homey:manager:users').listenerCount('realtime'), 0);
  assert.equal(f.released.get('homey:manager:users'), 1);
  await f.access.close();
  assert.equal(f.released.get('homey:manager:users'), 1);

  const pending = fixture();
  const issued = pending.access.issue({ screenId: SCREEN });
  let provideApi;
  let acquired;
  const started = new Promise((resolve) => { acquired = resolve; });
  pending.homey.api.getApi = async () => {
    acquired();
    return new Promise((resolve) => { provideApi = resolve; });
  };
  let unregisters = 0;
  const api = new EventEmitter();
  api.unregister = async () => { await Promise.resolve(); unregisters += 1; };
  const polling = pending.access.events({ token: issued.token, subscriptions: [subscriptions[0]] });
  await started;
  const closing = pending.access.close();
  provideApi(api);
  await Promise.all([polling, closing]);
  assert.equal(unregisters, 1);
  assert.equal(api.listenerCount('realtime'), 0);
  await assert.rejects(pending.access.events({ token: issued.token, subscriptions: [] }), denied(503));
});

test('the final closed screen and expired sessions release subscriptions without another client poll', async () => {
  const subscription = { uri: 'homey:manager:dashboards', event: 'dashboard.update' };
  const stale = fixture();
  const staleSession = stale.access.issue({ screenId: SCREEN });
  await stale.access.events({ token: staleSession.token, subscriptions: [subscription] });
  assert.equal(stale.timers.size, 1);
  stale.advance(120001);
  await stale.tickTimers();
  assert.equal(stale.released.get(subscription.uri), 1);
  assert.equal(stale.topics.get(subscription.uri).listenerCount('realtime'), 0);
  assert.equal(stale.access.pollers.size, 0);
  assert.equal(stale.timers.size, 0);

  const expired = fixture();
  const expiring = expired.access.issue({ screenId: SCREEN });
  await expired.access.events({ token: expiring.token, subscriptions: [subscription] });
  expired.advance(DAY - 100);
  await expired.access.events({ token: expiring.token, subscriptions: [subscription] });
  expired.advance(100);
  await expired.tickTimers();
  assert.equal(expired.released.get(subscription.uri), 1);
  assert.equal(expired.timers.size, 0);
});

test('screen revocation releases only unused registrations immediately and shutdown stops the pruning timer', async () => {
  const f = fixture();
  const first = f.access.issue({ screenId: SCREEN });
  const second = f.access.issue({ screenId: 'screen-second-tab' });
  const subscriptions = [{ uri: 'homey:manager:dashboards', event: 'dashboard.update' }];
  await f.access.events({ token: first.token, subscriptions });
  await f.access.events({ token: second.token, subscriptions });
  await f.access.revokeScreen(SCREEN);
  assert.equal(f.released.has(subscriptions[0].uri), false);
  assert.equal(f.topics.get(subscriptions[0].uri).listenerCount('realtime'), 1);
  await f.access.revokeScreen(second.screenId);
  assert.equal(f.released.get(subscriptions[0].uri), 1);
  assert.equal(f.timers.size, 0);

  const active = f.access.issue({ screenId: SCREEN });
  await f.access.events({ token: active.token, subscriptions });
  assert.equal(f.timers.size, 1);
  await f.access.close();
  assert.equal(f.timers.size, 0);
  assert.equal(f.released.get(subscriptions[0].uri), 2);
});

test('app pairing no longer needs manual keys and preserves the separate legacy key path', async () => {
  const f = fixture();
  const filename = path.resolve(__dirname, '../app.js');
  const appRequire = createRequire(filename);
  const context = { module: { exports: {} }, require: (id) => id === 'homey' ? { App: class {} } : appRequire(id), URL, fetch };
  vm.runInNewContext(readFileSync(filename, 'utf8'), context, { filename });
  const app = new context.module.exports();
  Object.assign(app, { homey: f.homey, manifest: { id: APP_ID }, pairings: new Map(), highlights: new Map(), log() {}, dashboardAccess: f.access });
  f.access.app = app;
  const pending = app.requestPairing({ name: 'Desktop', screenId: SCREEN });
  assert.equal(f.ownerCalls(), 0);
  assert.equal(app.getPairing(pending.id).status, 'waiting');
  app.approvePairing(pending.id, { name: 'Living room' });
  const approved = app.getPairing(pending.id);
  assert.equal(approved.transport, 'broker');
  assert.match(approved.token, /^wd_[a-f0-9]{64}$/);
  assert.equal(app.getPairing(pending.id).status, 'expired');
  assert.equal(f.ownerCalls(), 0);
  await app.checkKey(approved.token);
  await app.forgetScreen(SCREEN);
  await assert.rejects(app.checkKey(approved.token), denied(401));
  let checked = null;
  app.keyScopes = async (token) => { checked = token; return ['homey.device.control']; };
  await app.checkKey('existing-manual-key', 'homey.device.control');
  assert.equal(checked, 'existing-manual-key');
  assert.equal((await app.getApiKeyStatus()).automatic, true);
  const old = app.requestPairing({ name: 'Expired', screenId: SCREEN });
  app.pairings.get(old.id).createdAt = 0;
  assert.throws(() => app.approvePairing(old.id), /no longer waiting/);
});

test('app lifecycle events retain update/reinstall signals without exposing settings or credentials', async () => {
  const f = fixture();
  const { token } = f.access.issue({ screenId: SCREEN });
  const subscriptions = ['app.create', 'app.update'].map((event) => ({ uri: 'homey:manager:apps', event }));
  const first = await f.access.events({ token, subscriptions });
  const app = { id: APP_ID, version: '1.4.1', state: 'running', origin: 'devkit:install',
    settings: { apiKey: 'private' }, token: 'private', permissions: ['homey'] };
  f.topics.get('homey:manager:apps').emit('realtime', 'app.create', app);
  f.topics.get('homey:manager:apps').emit('realtime', 'app.update', app);
  f.topics.get('homey:manager:apps').emit('realtime', 'app.update', { ...app, state: { private: true }, origin: ['private'] });
  const result = await f.access.events({ token, subscriptions, cursor: first.cursor });
  assert.deepEqual(result.events.slice(0, 2).map((event) => event.data), [
    { id: APP_ID, version: '1.4.1', state: 'running', origin: 'devkit:install' },
    { id: APP_ID, version: '1.4.1', state: 'running', origin: 'devkit:install' },
  ]);
  assert.deepEqual(result.events[2].data, { id: APP_ID, version: '1.4.1' });
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('automatic connect stays protected and both manifests declare only the expected permission', () => {
  for (const filename of ['../app.json', '../.homeycompose/app.json']) {
    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, filename), 'utf8'));
    assert.ok(manifest.permissions.includes('homey:manager:api'));
    assert.equal(manifest.api.connectWorkspace.public, undefined);
    assert.equal(manifest.api.requestWorkspace.public, true);
    assert.equal(manifest.api.workspaceEvents.public, true);
    assert.equal(manifest.id, APP_ID);
  }
});

test('startup waits for the confirmed dashboard address before exposing a ready app', async () => {
  const f = fixture();
  const filename = path.resolve(__dirname, '../app.js');
  const appRequire = createRequire(filename);
  const context = { module: { exports: {} }, require: (id) => id === 'homey' ? { App: class {} } : appRequire(id), URL, fetch };
  vm.runInNewContext(readFileSync(filename, 'utf8'), context, { filename });
  const app = new context.module.exports();
  f.homey.cloud = { getLocalAddress: async () => '192.168.1.50:4859' };
  Object.assign(app, { homey: f.homey, manifest: { id: APP_ID }, dashboardAccess: f.access, error() {} });
  let finishAddress;
  const address = new Promise((resolve) => { finishAddress = resolve; });
  let cardsReady = false;
  app.setSecureUrl = async () => { await address; };
  app.initHighlightCards = () => { cardsReady = true; };
  app.initShowDashboardCard = () => {};
  const starting = app.onInit();
  await Promise.resolve();
  assert.equal(cardsReady, false);
  finishAddress();
  await starting;
  assert.equal(cardsReady, true);
  assert.equal(f.ownerCalls(), 0);
});
