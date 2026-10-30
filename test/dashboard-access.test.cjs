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

function fixture({ Access = DashboardAccess } = {}) {
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
    cloud: { getHomeyId: async () => '1234567890abcdef12345678' },
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
    '/api/manager/sessions/session/me': { scopes: ['homey'] },
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
  const access = new Access({ homey, app, appId: APP_ID, now: () => now,
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

function requestClock() {
  let now = 0;
  const timers = [];
  const filename = path.resolve(__dirname, '../lib/dashboard-access.js');
  const context = { module: { exports: {} }, require: createRequire(filename), URL, URLSearchParams, Buffer,
    AbortSignal: { timeout(delay) {
      const controller = new AbortController();
      timers.push({ controller, delay, at: now + delay });
      return controller.signal;
    } },
  };
  vm.runInNewContext(readFileSync(filename, 'utf8'), context, { filename });
  return {
    Access: context.module.exports.DashboardAccess, timers,
    advance(amount) {
      now += amount;
      for (const timer of timers) if (timer.at <= now && !timer.controller.signal.aborted) {
        timer.controller.abort(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }));
      }
    },
  };
}

test('a camera offer survives the old backend timeout and has one bounded 45-second attempt', async () => {
  for (const finish of ['answer', 'timeout']) {
    const clock = requestClock();
    const f = fixture(clock);
    f.homey.settings.set('apiKey', 'configured-camera-key');
    const { token } = f.access.issue({ screenId: SCREEN });
    let respond;
    f.respond((_url, { signal }) => new Promise((resolve, reject) => {
      respond = resolve;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    let settled = false;
    const pending = request(f.access, token, 'POST', '/api/manager/videos/video/camera-1/offer', { offer: 'v=0' })
      .then((value) => { settled = true; return { value }; }, (error) => { settled = true; return { error }; });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(f.calls.length, 1);
    assert.equal(clock.timers[0].delay, 45000);
    clock.advance(15000); await Promise.resolve();
    assert.equal(f.calls[0].signal.aborted, false);
    assert.equal(settled, false, 'the original 15-second budget must not terminate a valid camera offer');
    clock.advance(29999);
    assert.equal(f.calls[0].signal.aborted, false);
    if (finish === 'answer') respond({ ok: true, status: 200, json: async () => ({ answerSdp: 'camera-answer' }) });
    else clock.advance(1);
    const outcome = await pending;
    if (finish === 'answer') assert.equal(outcome.value.answerSdp, 'camera-answer');
    else {
      assert.equal(outcome.error.status, 504);
      assert.equal(outcome.error.message, 'The camera did not finish connecting. Tap to retry.');
    }
    assert.equal(f.calls.length, 1, 'an ambiguous camera failure is not replayed');
  }
});

test('controls and camera-offer near misses keep the normal backend budget or fail validation', async () => {
  const clock = requestClock();
  const f = fixture(clock);
  const { token } = f.access.issue({ screenId: SCREEN });
  for (const [method, route, body] of [
    ['PUT', '/api/manager/devices/device/device-1/capability/onoff', { value: true }],
    ['POST', '/api/manager/flow/flow/flow-1/trigger', {}],
    ['POST', '/api/manager/videos/video/camera-1/keep-alive', { streamId: 'stream' }],
    ['POST', '/api/manager/videos/video/camera-1/offer/', { offer: 'v=0' }],
    ['POST', '/api/manager/videos/video/camera%2D1/offer', { offer: 'v=0' }],
    ['POST', '/api/manager/videos/video/camera-1/offer?', { offer: 'v=0' }],
  ]) {
    await f.access.request({ token, method, path: route, body, timeout: 999999 });
    assert.equal(clock.timers.at(-1).delay, 15000, `${method} ${route}`);
  }
  const calls = f.calls.length;
  for (const [method, route, body] of [
    ['GET', '/api/manager/videos/video/camera-1/offer', undefined],
    ['POST', '/api/manager/videos/video/camera-1/offer?extra=true', { offer: 'v=0' }],
    ['POST', '/api/manager/videos/video/camera-1/offer', { offer: 'v=0', timeout: 999999 }],
    ['POST', '/api/manager/videos/video/camera-1/offer', { offer: '' }],
    ['POST', '/api/manager/videos/video/camera-1/offer', { offer: 'x'.repeat(256001) }],
    ['POST', '/api/manager/videos/video/camera-1/offer', ['v=0']],
  ]) await assert.rejects(request(f.access, token, method, route, body), (error) => [400, 403].includes(error.status));
  assert.equal(f.calls.length, calls, 'invalid near misses cannot become owner requests');
});

test('only expiry of the camera request signal becomes a camera-specific 504, including a stalled response body', async () => {
  for (const phase of ['fetch', 'json']) {
    const clock = requestClock(); const f = fixture(clock);
    f.homey.settings.set('apiKey', 'configured-camera-key');
    const { token } = f.access.issue({ screenId: SCREEN });
    f.respond((_url, { signal }) => {
      const blocked = () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return phase === 'fetch' ? blocked() : { ok: true, status: 200, json: blocked };
    });
    const pending = request(f.access, token, 'POST', '/api/manager/videos/video/camera-1/offer', { offer: 'v=0' }).catch((error) => error);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    clock.advance(45000);
    const error = await pending;
    assert.equal(error.status, 504, phase);
    assert.equal(error.message, 'The camera did not finish connecting. Tap to retry.');
    assert.equal(f.calls.length, 1);
  }

  const clock = requestClock(); const f = fixture(clock);
  const { token } = f.access.issue({ screenId: SCREEN });
  f.respond(async () => { throw Object.assign(new Error('network closed'), { name: 'TimeoutError' }); });
  await assert.rejects(request(f.access, token, 'POST', '/api/manager/videos/video/camera-1/offer', { offer: 'v=0' }),
    (error) => error.status === 502 && error.message === 'Homey could not be reached. Try again.');
  assert.equal(clock.timers[0].controller.signal.aborted, false, 'an error name alone is not the broker deadline');
  f.respond((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const normal = request(f.access, token, 'PUT', '/api/manager/devices/device/device-1/capability/onoff', { value: true }).catch((error) => error);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  clock.advance(15000);
  const error = await normal;
  assert.equal(error.status, 502, 'ordinary control timeout status remains unchanged');
  assert.equal(error.message, 'Homey could not be reached. Try again.');
  assert.equal(f.calls.length, 2, 'neither failure is replayed');
});

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
  assert.equal(f.calls.length, 2);
});

test('broker permissions reflect effective configured-key scopes and never expose the underlying session', async () => {
  const f = fixture();
  const key = 'configured-readonly-dashboard-key';
  f.homey.settings.set('apiKey', key);
  const { token } = f.access.issue({ screenId: SCREEN });
  f.data['/api/manager/sessions/session/me'] = {
    intersectedScopes: ['homey.dashboard.readonly', 'homey.device.readonly'], scopes: ['homey'],
    token: key, user: { name: 'Private owner' }, id: 'private-session-id',
  };
  const readonly = await request(f.access, token, 'GET', '/api/manager/sessions/session/me');
  assert.deepEqual(readonly.scopes, ['homey.dashboard.readonly', 'homey.device.readonly']);
  assert.equal(readonly.scopes.includes('homey.dashboard'), false);
  assert.equal(f.ownerCalls(), 0);
  assert.equal(JSON.stringify(readonly).includes('Private owner'), false);
  assert.equal(JSON.stringify(readonly).includes(key), false);
  assert.equal(JSON.stringify(readonly).includes('private-session-id'), false);

  f.data['/api/manager/sessions/session/me'] = { scopes: ['homey.dashboard'] };
  const editable = await request(f.access, token, 'GET', '/api/manager/sessions/session/me');
  assert.deepEqual(editable.scopes, ['homey.dashboard.readonly', 'homey.dashboard']);
  f.data['/api/manager/sessions/session/me'] = { intersectedScopes: [], scopes: ['homey'] };
  assert.deepEqual((await request(f.access, token, 'GET', '/api/manager/sessions/session/me')).scopes, []);
  f.data['/api/manager/sessions/session/me'] = { scopes: ['homey'] };
  const owner = await request(f.access, token, 'GET', '/api/manager/sessions/session/me');
  assert.equal(owner.scopes.includes('homey.dashboard'), true);
  assert.equal(owner.scopes.includes('homey.dashboard.readonly'), true);
  assert.equal(owner.scopes.includes('homey'), false);
  assert.equal(owner.scopes.includes('homey.app.control'), false);
  assert.equal(owner.scopes.includes('homey.device'), false);
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

test('a server-configured scoped key handles dashboard read/edit without generating or exposing an owner session', async () => {
  const f = fixture();
  const key = 'server-configured-scoped-dashboard-key';
  f.homey.settings.set('apiKey', key);
  const connection = await f.access.connect({ screenId: SCREEN });
  await request(f.access, connection.token, 'PUT', '/api/manager/dashboards/dashboard/board', { name: 'Updated', columns: [] });
  assert.equal(f.ownerCalls(), 0);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((call) => call.headers.Authorization === `Bearer ${key}`));
  assert.equal(JSON.stringify(connection).includes(key), false);
  assert.equal(JSON.stringify(f.homey.settings.get('workspaceSessions')).includes(key), false);
  f.respond(async (_url, options) => ({ ok: true, status: 200, json: async () => ({ echo: options.headers.Authorization }) }));
  assert.equal((await request(f.access, connection.token, 'GET', '/api/manager/devices/device')).echo, 'Bearer [redacted]');
});

test('a rejected configured key never falls back to generated access or repeats a control', async () => {
  const f = fixture();
  await f.access.getOwnerToken(); // There is even an available generated session that must not be used as fallback.
  const key = 'revoked-server-configured-dashboard-key';
  f.homey.settings.set('apiKey', key);
  const { token } = f.access.issue({ screenId: SCREEN });
  f.respond(async () => ({ ok: false, status: 401, json: async () => ({ error: `Rejected ${key}` }) }));
  await assert.rejects(request(f.access, token, 'PUT', '/api/manager/devices/device/device-1/capability/onoff', { value: true }),
    (error) => error.status === 401 && !error.message.includes(key) && error.message.includes('[redacted]'));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers.Authorization, `Bearer ${key}`);
  assert.equal(f.ownerCalls(), 1);
  await assert.rejects(request(f.access, token, 'GET', '/api/manager/dashboards/dashboard'), denied(401));
  assert.equal(f.calls.length, 2);
  assert.equal(f.ownerCalls(), 1);
});

test('configured key rotation/removal is observed on demand and a mid-request removal cannot trigger fallback', async () => {
  const f = fixture();
  const { token } = f.access.issue({ screenId: SCREEN });
  f.homey.settings.set('apiKey', 'server-configured-first-key');
  await request(f.access, token, 'GET', '/api/manager/dashboards/dashboard');
  f.homey.settings.set('apiKey', 'server-configured-second-key');
  await request(f.access, token, 'GET', '/api/manager/dashboards/dashboard');
  assert.equal(f.calls[1].headers.Authorization, 'Bearer server-configured-second-key');
  assert.equal(f.ownerCalls(), 0);
  f.respond(async () => {
    f.homey.settings.unset('apiKey');
    return { ok: false, status: 401 };
  });
  await assert.rejects(request(f.access, token, 'PUT', '/api/manager/devices/device/device-1/capability/onoff', { value: false }), denied(401));
  assert.equal(f.calls.length, 3);
  assert.equal(f.ownerCalls(), 0);
  f.respond(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }));
  await request(f.access, token, 'GET', '/api/manager/devices/device');
  assert.equal(f.ownerCalls(), 1, 'a later explicit settings removal permits generated access on a new request');
});

test('a configured key saved during SDK authentication wins, and remembered redaction credentials remain bounded', async () => {
  const f = fixture();
  let finish;
  f.homey.api.getOwnerApiToken = () => new Promise((resolve) => { finish = resolve; });
  const pending = f.access.getOwnerToken();
  await Promise.resolve();
  f.homey.settings.set('apiKey', 'new-server-key-during-sdk-request');
  finish('generated-session-that-was-already-pending');
  assert.equal(await pending, 'new-server-key-during-sdk-request');
  for (let i = 0; i < 10; i += 1) {
    f.homey.settings.set('apiKey', `server-key-rotation-${i}`);
    assert.equal(await f.access.getOwnerToken(), `server-key-rotation-${i}`);
  }
  assert.equal(f.access.ownerCredentials.size, 4);
  assert.equal(f.access.redact({ key: 'server-key-rotation-9' }).key, '[redacted]');
});

test('widget responses cannot echo the backend credential', async () => {
  const f = fixture();
  const { token } = f.access.issue({ screenId: SCREEN });
  f.respond(async (_url, options) => ({ status: 200, ok: true, json: async () => ({ echo: options.headers.Authorization }) }));
  const result = await request(f.access, token, 'GET', '/api/manager/devices/device');
  assert.equal(result.echo, 'Bearer [redacted]');
});

test('owner requests include the SDK Homey identity header required by its local API client', async () => {
  const f = fixture();
  let identityReads = 0;
  f.homey.cloud.getHomeyId = async () => { identityReads++; return 'abcdef1234567890abcdef12'; };
  const connection = await f.access.connect();
  await request(f.access, connection.token, 'GET', '/api/manager/devices/device');
  assert.equal(identityReads, 1);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((call) => call.headers['X-Homey-ID'] === 'abcdef1234567890abcdef12'));
  assert.equal(Object.hasOwn(connection, 'homeyId'), false);
  const missing = fixture();
  missing.homey.cloud.getHomeyId = async () => null;
  await assert.rejects(missing.access.connect(), denied(503));
  assert.equal(missing.calls.length, 0);
});

test('Homey refusal details remain useful without echoing its backend credential', async () => {
  const f = fixture();
  f.respond(async (_url, options) => ({ ok: false, status: 403, json: async () => ({ error: `Missing scope; ${options.headers.Authorization}` }) }));
  await assert.rejects(f.access.connect(), (error) => {
    assert.equal(error.status, 403);
    assert.match(error.message, /Missing scope/);
    assert.match(error.message, /Bearer \[redacted\]/);
    assert.ok(!error.message.includes('server-only-owner'));
    return true;
  });
  assert.equal(f.calls.length, 1, 'a refusal never automatically repeats a request');
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

test('resuming after final-topic pruning resets even when no event advanced the cursor', async () => {
  const f = fixture();
  const { token } = f.access.issue({ screenId: SCREEN });
  const subscriptions = [{ uri: 'homey:manager:dashboards', event: 'dashboard.update' }];
  const first = await f.access.events({ token, subscriptions });
  assert.equal(first.reset, undefined, 'a first poll without a cursor starts normally');
  assert.deepEqual(first.events, []);
  const healthy = await f.access.events({ token, subscriptions, cursor: first.cursor });
  assert.equal(healthy.reset, undefined, 'an active poll with unchanged coverage does not reset');
  f.advance(120001);
  await f.tickTimers();
  assert.equal(f.access.pollers.size, 0);
  assert.equal(f.access.topics.size, 0);
  const resumed = await f.access.events({ token, subscriptions, cursor: healthy.cursor });
  assert.equal(resumed.cursor, first.cursor, 'the event sequence alone cannot reveal the observation gap');
  assert.equal(resumed.reset, true);
  assert.deepEqual(resumed.events, []);
  assert.equal(f.topics.get(subscriptions[0].uri).listenerCount('realtime'), 1);
  assert.equal((await f.access.events({ token, subscriptions, cursor: resumed.cursor })).reset, undefined,
    'the replacement registration establishes coverage for following polls');
  await f.access.close();
});

test('a stale poller resets before its lastSeen is refreshed even if pruning has not run', async () => {
  const f = fixture();
  const { token } = f.access.issue({ screenId: SCREEN });
  const subscriptions = [{ uri: 'homey:manager:dashboards', event: 'dashboard.update' }];
  const first = await f.access.events({ token, subscriptions });
  f.advance(120001);
  assert.equal(f.access.pollers.size, 1, 'the timer has not pruned the stale record yet');
  const resumed = await f.access.events({ token, subscriptions, cursor: first.cursor });
  assert.equal(resumed.reset, true);
  assert.equal(f.released.has(subscriptions[0].uri), false, 'resetting the cursor does not tear down an existing shared topic');
  await f.access.close();
});

test('adding a previously unobserved topic resets even when another screen just registered it', async () => {
  const f = fixture();
  const first = f.access.issue({ screenId: SCREEN });
  const second = f.access.issue({ screenId: 'screen-second-tab' });
  const dashboards = { uri: 'homey:manager:dashboards', event: 'dashboard.update' };
  const users = { uri: 'homey:manager:users', event: 'user.update' };
  const initial = await f.access.events({ token: first.token, subscriptions: [dashboards] });
  await f.access.events({ token: second.token, subscriptions: [users] });
  const expanded = await f.access.events({ token: first.token, subscriptions: [dashboards, users], cursor: initial.cursor });
  assert.equal(expanded.cursor, initial.cursor);
  assert.equal(expanded.reset, true, 'the new topic was not observed throughout the first screen’s cursor interval');
  assert.equal(f.topics.get(users.uri).listenerCount('realtime'), 1, 'screens still share one registered listener');
  assert.equal((await f.access.events({ token: first.token, subscriptions: [dashboards, users], cursor: expanded.cursor })).reset, undefined);
  await f.access.close();
});

test('different active pollers preserve shared history and continuously observed new subscriptions', async () => {
  const f = fixture();
  const first = f.access.issue({ screenId: SCREEN });
  const second = f.access.issue({ screenId: 'screen-second-tab' });
  const dashboards = { uri: 'homey:manager:dashboards', event: 'dashboard.update' };
  const users = { uri: 'homey:manager:users', event: 'user.update' };
  const secondStart = await f.access.events({ token: second.token, subscriptions: [dashboards, users] });
  const firstStart = await f.access.events({ token: first.token, subscriptions: [dashboards] });
  f.advance(60000);
  const secondNext = await f.access.events({ token: second.token, subscriptions: [dashboards, users], cursor: secondStart.cursor });
  assert.equal(secondNext.reset, undefined);
  f.topics.get(users.uri).emit('realtime', 'user.update', { id: 'user-123', present: true });
  const expanded = await f.access.events({ token: first.token, subscriptions: [dashboards, users], cursor: firstStart.cursor });
  assert.equal(expanded.reset, undefined, 'another active screen observed this topic before the first screen’s cursor');
  assert.deepEqual(expanded.events, [{ uri: users.uri, event: users.event, data: { id: 'user-123', present: true } }]);
  await f.access.events({ token: first.token, subscriptions: [dashboards], cursor: expanded.cursor });
  assert.equal(f.released.has(users.uri), false, 'the second screen still owns its subscriptions');
  assert.equal(f.topics.get(users.uri).listenerCount('realtime'), 1);
  assert.equal((await f.access.events({ token: second.token, subscriptions: [dashboards, users], cursor: secondNext.cursor })).reset, undefined);
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
  const restricted = await app.getApiKeyStatus();
  assert.equal(restricted.automatic, false);
  assert.match(restricted.reason, /does not grant native dashboard access/);
  app.keyScopes = async () => ['homey.dashboard'];
  assert.equal((await app.getApiKeyStatus()).automatic, true);
  f.homey.settings.set('apiKey', 'server-only-configured-key');
  assert.equal((await app.getApiKeyStatus()).set, true, 'configured status comes from the actual stored key');
  const old = app.requestPairing({ name: 'Expired', screenId: SCREEN });
  app.pairings.get(old.id).createdAt = 0;
  assert.throws(() => app.approvePairing(old.id), /no longer waiting/);
});

test('owner-approved setup atomically refuses an existing key, including a concurrent manual save', async () => {
  const f = fixture();
  const filename = path.resolve(__dirname, '../app.js');
  const appRequire = createRequire(filename);
  const context = { module: { exports: {} }, require: (id) => id === 'homey' ? { App: class {} } : appRequire(id), URL, fetch };
  vm.runInNewContext(readFileSync(filename, 'utf8'), context, { filename });
  const app = new context.module.exports();
  Object.assign(app, { homey: f.homey, log() {}, getApiKeyStatus: async () => ({ set: true }) });
  let calls = 0;
  let concurrent = false;
  app.callHomey = async (route) => {
    calls++;
    if (concurrent && route.includes('/dashboards/')) f.homey.settings.set('apiKey', 'key-saved-in-another-view');
    return { ok: true, status: 200, json: async () => ({ name: 'Owner' }) };
  };
  f.homey.settings.set('apiKey', 'existing-user-key');
  await assert.rejects(app.setApiKey('new-setup-key', { onlyIfUnset: true }), denied(409));
  assert.equal(calls, 0);
  assert.equal(f.homey.settings.get('apiKey'), 'existing-user-key');
  f.homey.settings.unset('apiKey');
  concurrent = true;
  await assert.rejects(app.setApiKey('new-setup-key', { onlyIfUnset: true }), denied(409));
  assert.equal(f.homey.settings.get('apiKey'), 'key-saved-in-another-view');
  concurrent = false;
  await app.setApiKey('explicit-manual-replacement');
  assert.equal(f.homey.settings.get('apiKey'), 'explicit-manual-replacement', 'the existing manual Change key path remains supported');
  const api = require('../api');
  let received;
  await api.setApiKey({ homey: { app: { setApiKey: (...args) => { received = args; } } }, body: { key: 'setup-key', onlyIfUnset: true } });
  assert.equal(received[1].onlyIfUnset, true);
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
