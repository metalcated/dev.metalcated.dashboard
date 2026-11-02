'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { DashboardAccess } = require('../lib/dashboard-access');
const Sizes = require('../lib/widget-sizes');
const api = require('../api');

const APP_ID = 'dev.schweiger.dashboard';
const SCREEN = 'resize-screen-12345678';
const FIRST = 'widget-12345678';
const SECOND = 'widget-87654321';
const SIZE = { width: 240, height: 320 };
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const status = (code) => (error) => error.status === code && error.statusCode === code;
const sourceFile = path.resolve(__dirname, '../app.js');
const source = readFileSync(sourceFile, 'utf8');
const appRequire = createRequire(sourceFile);

function fixture({ saved = new Map(), native } = {}) {
  const calls = [], events = [], writes = [];
  let scopeResponse = { scopes: ['homey'], intersectedScopes: ['homey.dashboard'] };
  let manualScopes = ['homey.dashboard'];
  let hook = null;
  let dashboards = native ?? { board: { id: 'board', columns: [{ id: 'column', widgets: [
    { id: FIRST, type: 'device_camera_live', data: { deviceId: 'camera', deviceVideoId: 'main', autoplay: true } },
    { id: SECOND, type: 'app_webview', data: { appWidgetId: 'example', settings: { untouched: true } } },
  ] }] } };
  const homey = {
    cloud: { getHomeyId: async () => '1234567890abcdef12345678' },
    settings: {
      get: (key) => clone(saved.get(key)),
      set: (key, value) => { writes.push({ key, value: clone(value) }); saved.set(key, clone(value)); },
      unset: (key) => saved.delete(key),
    },
    api: {
      getLocalUrl: async () => 'http://127.0.0.1:4859',
      getOwnerApiToken: async () => 'generated-owner-key',
      realtime: (event, value) => events.push({ event, value: clone(value) }),
    },
  };
  if (!saved.has('apiKey')) saved.set('apiKey', 'server-only-owner-key');
  const fetchImpl = async (url, options) => {
    const route = new URL(url).pathname;
    const token = options.headers.Authorization.slice('Bearer '.length);
    calls.push({ route, method: options.method ?? 'GET', token });
    const response = await hook?.({ route, token, options });
    if (response !== undefined) return response;
    if (route === '/api/manager/sessions/session/me') {
      if (token === 'manual-dashboard-key') return new Response(JSON.stringify({ scopes: manualScopes }), { status: 200 });
      if (token !== saved.get('apiKey') && token !== 'generated-owner-key') return new Response('{}', { status: 401 });
      return new Response(JSON.stringify(scopeResponse), { status: 200 });
    }
    if (route === '/api/manager/dashboards/dashboard') return new Response(JSON.stringify(dashboards), { status: 200 });
    assert.fail(`unexpected backend route ${route}`);
  };
  const context = { module: { exports: {} }, require: (id) => id === 'homey' ? { App: class {} } : appRequire(id),
    URL, fetch: fetchImpl, AbortSignal };
  vm.runInNewContext(source, context, { filename: sourceFile });
  const app = new context.module.exports();
  app.homey = homey;
  app.manifest = { id: APP_ID };
  app.dashboardAccess = new DashboardAccess({ homey, app, appId: APP_ID, fetchImpl });
  const issued = app.dashboardAccess.issue({ screenId: SCREEN, kind: 'paired' });
  return {
    app, homey, saved, calls, events, writes, token: issued.token,
    get dashboards() { return dashboards; }, set dashboards(value) { dashboards = value; },
    ownerScopes(value) { scopeResponse = value; }, manualScopes(value) { manualScopes = value; },
    intercept(callback) { hook = callback; },
    sizeWrites() { return writes.filter(({ key }) => key === Sizes.SETTINGS_KEY); },
    request(method, suffix, body) { return app.dashboardAccess.request({ token: issued.token, method, path: `/api/app/${APP_ID}${suffix}`, body }); },
  };
}

test('the strict size schema accepts grid boundaries and refuses coercion, malformed fields, and prototype IDs', () => {
  assert.deepEqual(Sizes.normalizeSize({ width: 120, height: 80 }), { width: 120, height: 80 });
  assert.deepEqual(Sizes.normalizeSize({ width: 360, height: 1440 }), { width: 360, height: 1440 });
  assert.equal(Sizes.normalizeSize(null), null);
  for (const value of [undefined, [], '240x320', {}, { width: 240 }, { width: 240, height: 320, extra: 1 },
    { width: '240', height: 320 }, { width: 121, height: 320 }, { width: 240, height: 81 },
    { width: 100, height: 320 }, { width: 380, height: 320 }, { width: 240, height: 60 },
    { width: 240, height: 1460 }, { width: Infinity, height: 320 }, { width: 240, height: NaN }]) {
    assert.throws(() => Sizes.normalizeSize(value), status(400));
  }
  for (const id of ['__proto__', 'constructor', 'prototype', '../widget', 'x', `${FIRST}/other`]) assert.equal(Sizes.validWidgetId(id), false);
});

test('broker size writes verify effective permissions and persist separately from native layout, returning a full bounded map', async () => {
  const f = fixture();
  const original = clone(f.dashboards);
  const result = await f.request('PUT', `/widget-sizes/${FIRST}`, { token: 'must-be-ignored', size: SIZE });
  assert.deepEqual(result, { [FIRST]: SIZE });
  assert.deepEqual(f.saved.get('widgetSizes'), result);
  assert.deepEqual(f.dashboards, original, 'the native dashboard definitions and camera fields remain untouched');
  assert.deepEqual(f.events, [{ event: 'widget-sizes', value: result }]);
  assert.equal(f.calls.every(({ method }) => method === 'GET'), true, 'web sizes are not written into native widget data');
  assert.equal(f.calls.filter(({ route }) => route === '/api/manager/sessions/session/me').length, 3);
  assert.equal(JSON.stringify(result).includes('owner'), false);
});

test('read-only effective owner scopes reject a valid broker resize even when its broader token scope is homey', async () => {
  const f = fixture();
  f.ownerScopes({ scopes: ['homey'], intersectedScopes: ['homey.dashboard.readonly'] });
  await assert.rejects(f.request('PUT', `/widget-sizes/${FIRST}`, { size: SIZE }), status(403));
  assert.equal(f.sizeWrites().length, 0);
  assert.deepEqual(f.events, []);
  assert.equal(f.calls.some(({ route }) => route.includes('/dashboards/')), false);
  f.saved.set('widgetSizes', { [FIRST]: SIZE });
  assert.deepEqual(await f.request('GET', '/widget-sizes'), { [FIRST]: SIZE }, 'the same connection may read the web layout');
});

test('the direct legacy route accepts an existing editing key and rejects invalid or read-only keys', async () => {
  const f = fixture();
  const result = await api.setWidgetSize({ homey: { app: f.app }, params: { id: FIRST }, body: { token: 'manual-dashboard-key', size: SIZE } });
  assert.deepEqual(result, { [FIRST]: SIZE });
  f.manualScopes(['homey.dashboard.readonly']);
  await assert.rejects(api.setWidgetSize({ homey: { app: f.app }, params: { id: FIRST }, body: { token: 'manual-dashboard-key', size: null } }), status(403));
  await assert.rejects(f.app.setWidgetSize(FIRST, { token: 'unrecognized-key', size: SIZE }), status(401));
  assert.equal(f.sizeWrites().length, 1);
  const directRead = await api.getWidgetSizes({ homey: { app: f.app } });
  assert.deepEqual(directRead, { [FIRST]: SIZE });
});

test('stored dimensions survive an app instance restart and null reset is shared without deleting native content', async () => {
  const f = fixture();
  await f.app.setWidgetSize(FIRST, { token: f.token, size: SIZE });
  const restarted = fixture({ saved: f.saved, native: clone(f.dashboards) });
  assert.deepEqual(await restarted.app.widgetSizes(), { [FIRST]: SIZE });
  assert.deepEqual(await restarted.app.setWidgetSize(FIRST, { token: restarted.token, size: null }), {});
  assert.deepEqual(restarted.saved.get('widgetSizes'), {});
  assert.equal(restarted.dashboards.board.columns[0].widgets[0].id, FIRST);
  assert.deepEqual(restarted.events.at(-1), { event: 'widget-sizes', value: {} });
});

test('read maps drop stale, corrupt, null, extra-field and prototype entries without exposing or mutating saved data', async () => {
  const f = fixture();
  const stored = JSON.parse(`{"${FIRST}":{"width":240,"height":320},"${SECOND}":{"width":240,"height":320,"token":"private"},"stale-12345678":{"width":240,"height":320},"__proto__":{"width":240,"height":320}}`);
  f.saved.set('widgetSizes', stored);
  assert.deepEqual(await f.app.widgetSizes(), { [FIRST]: SIZE });
  assert.deepEqual(f.saved.get('widgetSizes'), stored, 'GET stays read-only');
  assert.equal(f.sizeWrites().length, 0);
  await f.app.setWidgetSize(SECOND, { token: f.token, size: { width: 360, height: 400 } });
  assert.deepEqual(f.saved.get('widgetSizes'), { [FIRST]: SIZE, [SECOND]: { width: 360, height: 400 } });
});

test('unknown native widget IDs and strict malformed public or broker request bodies never grow saved state', async () => {
  const f = fixture();
  await assert.rejects(f.app.setWidgetSize('unknown-12345678', { token: f.token, size: SIZE }), status(404));
  for (const body of [{ token: f.token }, { token: f.token, size: SIZE, settings: {} }, [], null]) {
    await assert.rejects(api.setWidgetSize({ homey: { app: f.app }, params: { id: FIRST }, body }), status(400));
  }
  await assert.rejects(f.request('PUT', `/widget-sizes/${FIRST}`, { size: SIZE, other: true }), status(400));
  await assert.rejects(f.request('PUT', `/widget-sizes/${FIRST}`, {}), status(400));
  await assert.rejects(f.request('GET', '/widget-sizes', { size: SIZE }), status(400));
  await assert.rejects(f.request('GET', '/widget-sizes?all=true'), status(403));
  for (const id of ['__proto__', 'constructor', 'prototype', '']) await assert.rejects(f.app.setWidgetSize(id, { token: f.token, size: SIZE }), status(400));
  assert.equal(f.sizeWrites().length, 0);
  assert.deepEqual(f.events, []);
});

test('queued resizes merge the latest saved dimensions rather than overwriting another widget resize', async () => {
  const f = fixture();
  let release;
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let held = false;
  f.intercept(async ({ route }) => {
    if (route !== '/api/manager/dashboards/dashboard' || held) return;
    held = true; started(); await gate;
  });
  const first = f.app.setWidgetSize(FIRST, { token: f.token, size: SIZE });
  await reading;
  const body = { token: f.token, size: { width: 360, height: 400 } };
  const second = f.app.setWidgetSize(SECOND, body);
  body.size.height = 800;
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], { [FIRST]: SIZE });
  assert.deepEqual(results[1], { [FIRST]: SIZE, [SECOND]: { width: 360, height: 400 } });
  assert.deepEqual(f.saved.get('widgetSizes'), results[1]);
  assert.equal(f.sizeWrites().length, 2);
});

test('a widget removed while queued is refused and a later valid resize still succeeds', async () => {
  const f = fixture();
  f.dashboards.board.columns[0].widgets = f.dashboards.board.columns[0].widgets.filter(({ id }) => id !== FIRST);
  await assert.rejects(f.app.setWidgetSize(FIRST, { token: f.token, size: SIZE }), status(404));
  await f.app.setWidgetSize(SECOND, { token: f.token, size: SIZE });
  assert.deepEqual(f.saved.get('widgetSizes'), { [SECOND]: SIZE });
});

test('revocation or scope restriction during the native inventory read prevents a late settings write', async () => {
  for (const reason of ['revoked', 'read-only', 'shutdown']) {
    const f = fixture();
    let release;
    let started;
    const reading = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    f.intercept(async ({ route }) => { if (route === '/api/manager/dashboards/dashboard') { started(); await gate; } });
    const pending = f.app.setWidgetSize(FIRST, { token: f.token, size: SIZE });
    await reading;
    if (reason === 'revoked') await f.app.dashboardAccess.revokeScreen(SCREEN);
    else if (reason === 'read-only') f.ownerScopes({ scopes: ['homey'], intersectedScopes: ['homey.dashboard.readonly'] });
    else await f.app.onUninit();
    release();
    await assert.rejects(pending, status(reason === 'revoked' ? 401 : reason === 'read-only' ? 403 : 503));
    assert.equal(f.sizeWrites().length, 0, reason);
    assert.deepEqual(f.events, [], reason);
  }
});

test('failed inventory and unusable effective grants preserve the previous dimensions', async () => {
  const f = fixture();
  f.saved.set('widgetSizes', { [FIRST]: SIZE });
  f.dashboards = null;
  await assert.rejects(f.app.setWidgetSize(FIRST, { token: f.token, size: null }), status(502));
  assert.deepEqual(f.saved.get('widgetSizes'), { [FIRST]: SIZE });
  f.ownerScopes({ scopes: ['homey'], intersectedScopes: [] });
  await assert.rejects(f.app.setWidgetSize(FIRST, { token: f.token, size: null }), status(403));
  assert.equal(f.sizeWrites().length, 0);
});

test('size maps and realtime payloads remain bounded to registered widget instances', async () => {
  const entries = Array.from({ length: Sizes.MAX_WIDGET_SIZES + 1 }, (_, index) => [`widget-${String(index).padStart(8, '0')}`, SIZE]);
  const f = fixture({ native: { board: { columns: [{ widgets: entries.map(([id]) => ({ id })) }] } } });
  f.saved.set('widgetSizes', Object.fromEntries(entries.slice(0, -1)));
  await assert.rejects(f.app.setWidgetSize(entries.at(-1)[0], { token: f.token, size: SIZE }), status(409));
  assert.equal(f.sizeWrites().length, 0);
  await f.app.setWidgetSize(entries[0][0], { token: f.token, size: null });
  const result = await f.app.setWidgetSize(entries.at(-1)[0], { token: f.token, size: SIZE });
  assert.equal(Object.keys(result).length, Sizes.MAX_WIDGET_SIZES);
  assert.ok(Buffer.byteLength(JSON.stringify(f.events.at(-1))) < 128 * 1024);
});

test('broker realtime accepts widget-sizes while administrative routes remain blocked and events are redacted', async () => {
  const f = fixture();
  const subscription = { uri: `homey:app:${APP_ID}`, event: 'widget-sizes' };
  await f.app.dashboardAccess.validateSubscription(subscription);
  await assert.rejects(f.app.dashboardAccess.validateSubscription({ ...subscription, event: 'settings' }), status(403));
  for (const [method, suffix] of [['DELETE', `/widget-sizes/${FIRST}`], ['PUT', '/widget-sizes'], ['GET', `/widget-sizes/${FIRST}`], ['PUT', '/api-key']]) {
    await assert.rejects(f.request(method, suffix, {}), status(403));
  }
  // The real event serializer retains only safe numeric sizes from the app's sanitized map. Even a hostile echo
  // from a provider cannot turn the generic event relay into a way to read its known backend credential.
  f.app.dashboardAccess.rememberCredential('server-only-owner-key');
  f.app.dashboardAccess.record(subscription.uri, subscription.event, { [FIRST]: SIZE, hostile: 'server-only-owner-key' });
  assert.equal(JSON.stringify(f.app.dashboardAccess.buffer).includes('server-only-owner-key'), false);
});

test('both manifests keep size reads protected and only the authenticated size setter is public', () => {
  for (const filename of ['../app.json', '../.homeycompose/app.json']) {
    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, filename), 'utf8'));
    assert.equal(manifest.api.getWidgetSizes.method, 'GET');
    assert.equal(manifest.api.getWidgetSizes.path, '/widget-sizes');
    assert.equal(manifest.api.getWidgetSizes.public, undefined);
    assert.equal(manifest.api.setWidgetSize.method, 'PUT');
    assert.equal(manifest.api.setWidgetSize.path, '/widget-sizes/:id');
    assert.equal(manifest.api.setWidgetSize.public, true);
    assert.deepEqual(manifest.permissions, ['homey:manager:api']);
  }
});
