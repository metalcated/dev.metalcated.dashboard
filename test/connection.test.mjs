import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function load(name, globals = {}, imports = {}) {
  const context = vm.createContext({ URL, URLSearchParams, structuredClone, setTimeout, clearTimeout, AbortController, console, ...globals });
  const source = await readFile(new URL(`../assets/web/js/${name}`, import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context });
  await module.link((specifier) => {
    assert.ok(Object.hasOwn(imports, specifier), `unexpected dependency ${specifier}`);
    return new vm.SyntheticModule(Object.keys(imports[specifier]), function () {
      for (const [key, value] of Object.entries(imports[specifier])) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

const opaque = `wd_${'a'.repeat(64)}`;
const location = { pathname: '/app/test.dashboard/assets/web/index.html', origin: 'http://homey.local:4859', search: '?embedded=1' };

test('broker controls go through the app with an opaque session and never send an owner Authorization header', async () => {
  const requests = [];
  const { createClient } = await load('homey-api.js', {
    location,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ id: 'native-dashboard', columns: [] }));
    },
  });
  const client = createClient({ homeyUrl: location.origin, token: opaque, transport: 'broker' });
  const saved = await client.api('PUT', '/api/manager/dashboards/dashboard/native-dashboard', { columns: [] });

  assert.equal(saved.id, 'native-dashboard');
  assert.equal(requests[0].url, `${location.origin}/api/app/test.dashboard/workspace/request`);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    token: opaque, method: 'PUT', path: '/api/manager/dashboards/dashboard/native-dashboard', body: { columns: [] },
  });
  await client.api('GET', '/api/manager/dashboards/dashboard', {});
  assert.equal(Object.hasOwn(JSON.parse(requests[1].options.body), 'body'), false, 'GET widget calls must match direct transport semantics');
});

test('broker errors preserve the HTTP status used to revoke a browser connection', async () => {
  const { createClient } = await load('homey-api.js', {
    location,
    fetch: async () => new Response(JSON.stringify({ error: 'Connection revoked' }), { status: 401 }),
  });
  const client = createClient({ homeyUrl: location.origin, token: opaque, transport: 'broker' });
  await assert.rejects(client.api('GET', '/api/manager/dashboards/dashboard'), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.message, 'Connection revoked');
    return true;
  });
});

test('existing direct connections retain the native HTTP authentication path', async () => {
  let request;
  const { createClient } = await load('homey-api.js', {
    location,
    fetch: async (url, options) => { request = { url, options }; return new Response('{}'); },
  });
  await createClient({ homeyUrl: location.origin, token: 'legacy-test-key' }).api('GET', '/api/manager/devices/device');
  assert.equal(request.url, `${location.origin}/api/manager/devices/device`);
  assert.equal(request.options.headers.Authorization, 'Bearer legacy-test-key');
});

function embeddedBrowser(referrer = 'https://my.homey.app/settings') {
  const windowEvents = new Map();
  const documentEvents = new Map();
  const sent = [];
  const parent = { postMessage: (message, origin) => sent.push({ message, origin }) };
  const window = { parent, addEventListener: (type, handler) => windowEvents.set(type, handler) };
  const document = { referrer, visibilityState: 'visible', addEventListener: (type, handler) => documentEvents.set(type, handler) };
  return { window, document, sent, parent, windowEvents, documentEvents };
}

test('embedded connections accept only the expected parent and its exact origin, and reject another Homey address', async () => {
  const browser = embeddedBrowser();
  const api = await load('embedded.js', { ...browser, location });
  const pending = api.waitForEmbeddedConfig();
  const connection = { homeyUrl: location.origin, token: opaque, transport: 'broker', screenId: 'approved-screen' };
  const send = (changes = {}) => browser.windowEvents.get('message')({
    source: browser.parent,
    origin: 'https://my.homey.app',
    data: { type: 'dashboard:connect', config: connection },
    ...changes,
  });
  let resolved = false;
  pending.then(() => { resolved = true; });
  send({ source: {} });
  send({ origin: 'https://another.example' });
  send({ data: { type: 'dashboard:connect', config: { ...connection, homeyUrl: 'https://another.example' } } });
  send({ data: { type: 'dashboard:connect', config: { ...connection, transport: 'direct' } } });
  await Promise.resolve();
  assert.equal(resolved, false);
  send();
  assert.deepEqual(structuredClone(await pending), connection);
  assert.deepEqual(structuredClone(browser.sent), [{ message: { type: 'dashboard:ready' }, origin: 'https://my.homey.app' }]);
});

test('embedded visibility is controlled by the trusted parent and the document together', async () => {
  const browser = embeddedBrowser();
  const api = await load('embedded.js', { ...browser, location });
  const seen = [];
  const unsubscribe = api.subscribeDashboardVisibility((visible) => seen.push(visible));
  browser.windowEvents.get('message')({ source: {}, origin: 'https://my.homey.app', data: { type: 'dashboard:visibility', visible: false } });
  assert.equal(api.isDashboardVisible(), true);
  browser.windowEvents.get('message')({ source: browser.parent, origin: 'https://my.homey.app', data: { type: 'dashboard:visibility', visible: false } });
  assert.equal(api.isDashboardVisible(), false);
  browser.document.visibilityState = 'hidden';
  browser.windowEvents.get('message')({ source: browser.parent, origin: 'https://my.homey.app', data: { type: 'dashboard:visibility', visible: true } });
  assert.equal(api.isDashboardVisible(), false);
  browser.document.visibilityState = 'visible';
  browser.documentEvents.get('visibilitychange')();
  assert.equal(api.isDashboardVisible(), true);
  unsubscribe();
  assert.deepEqual(seen, [false, false, true]);
});

test('an embedded frame with no verifiable parent fails closed; a stalled connection reports a retryable error', async () => {
  const missing = embeddedBrowser('');
  const noParent = await load('embedded.js', { ...missing, location });
  await assert.rejects(noParent.waitForEmbeddedConfig(), /Open this dashboard from its Homey app view/);
  assert.equal(missing.sent.length, 0);

  const stalled = embeddedBrowser();
  const api = await load('embedded.js', { ...stalled, location });
  await assert.rejects(api.waitForEmbeddedConfig({ timeout: 1 }), /Retry/);
  assert.equal(stalled.sent.at(-1).message.type, 'dashboard:error');
  assert.equal(stalled.sent.at(-1).origin, 'https://my.homey.app');
});

test('legacy browser configuration migrates to the database without modifying localStorage', async () => {
  const migrated = [];
  const connection = { token: 'legacy-test-key' };
  const api = await load('config.js', {
    location,
    localStorage: { getItem: () => JSON.stringify(connection), setItem: () => assert.fail('must not write localStorage') },
  }, {
    './state.js': { STORAGE_KEY: 'legacy-key' },
    './connection-storage.js': { readConnection: async () => null, writeConnection: async (value) => { migrated.push(value); return true; } },
    './embedded.js': { embedded: false, waitForEmbeddedConfig: () => assert.fail('standalone should not wait for a parent') },
  });
  const result = await api.loadConfig();
  assert.equal(result.homeyUrl, location.origin);
  assert.equal(result.token, connection.token);
  assert.deepEqual(structuredClone(migrated), [connection]);
});

test('a saved disconnect prevents a legacy key being loaded again', async () => {
  const api = await load('config.js', {
    location,
    localStorage: { getItem: () => assert.fail('database tombstone must suppress legacy credentials') },
  }, {
    './state.js': { STORAGE_KEY: 'legacy-key' },
    './connection-storage.js': { readConnection: async () => ({}), writeConnection: () => assert.fail('must not overwrite the database') },
    './embedded.js': { embedded: false, waitForEmbeddedConfig: () => assert.fail('not embedded') },
  });
  assert.equal((await api.loadConfig()).token, undefined);
});

test('embedded configuration stays in memory and bypasses browser credential storage entirely', async () => {
  const connection = { token: opaque, transport: 'broker', homeyUrl: location.origin };
  const api = await load('config.js', { location }, {
    './state.js': { STORAGE_KEY: 'legacy-key' },
    './connection-storage.js': { readConnection: () => assert.fail('embedded must not read credentials'), writeConnection: () => assert.fail('embedded must not persist credentials') },
    './embedded.js': { embedded: true, waitForEmbeddedConfig: async () => connection },
  });
  assert.equal(await api.loadConfig(), connection);
  assert.equal(await api.writeStoredConfig(connection), false);
});

test('a browser denying database access still keeps a connection for the current page only', async () => {
  const storage = await load('connection-storage.js');
  const connection = { token: opaque, transport: 'broker' };
  assert.equal(await storage.readConnection(), null);
  assert.equal(await storage.writeConnection(connection), false);
  connection.token = 'changed-after-save';
  assert.equal((await storage.readConnection()).token, opaque);
  await storage.writeConnection({});
  assert.deepEqual(structuredClone(await storage.readConnection()), {});
});

async function relayHarness(broker) {
  let nextTimer = 0;
  const timers = new Map();
  const pageEvents = new Map();
  const visibility = { visible: true, listener: null };
  const statuses = [];
  const callbacks = { reconnects: 0, unauthorized: 0 };
  const api = await load('realtime.js', {
    setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
    window: {
      addEventListener: (type, listener) => pageEvents.set(type, listener),
      removeEventListener: (type) => pageEvents.delete(type),
      io: () => assert.fail('broker sessions must not open a direct owner socket'),
    },
  }, {
    './state.js': { state: {} },
    './embedded.js': {
      isDashboardVisible: () => visibility.visible,
      subscribeDashboardVisibility: (listener) => { visibility.listener = listener; return () => { visibility.listener = null; }; },
    },
  });
  const realtime = api.createRealtime({ transport: 'broker', broker }, {
    onStatus: (state) => statuses.push(state),
    onReconnect: () => { callbacks.reconnects += 1; },
    onUnauthorized: () => { callbacks.unauthorized += 1; },
  });
  const next = () => {
    const [id, callback] = timers.entries().next().value;
    timers.delete(id);
    return callback();
  };
  return { realtime, timers, next, pageEvents, visibility, statuses, callbacks };
}

test('broker realtime deduplicates subscriptions, dispatches matching events, and resyncs after a reset', async () => {
  const requests = [];
  const relay = await relayHarness(async (route, payload) => {
    requests.push({ route, payload });
    return requests.length === 1
      ? { cursor: 'epoch:1', events: [] }
      : { cursor: 'epoch:2', reset: true, events: [{ uri: 'homey:manager:dashboards', event: 'dashboard.update', data: { id: 'office' } }] };
  });
  const seen = [];
  const firstOff = relay.realtime.on('homey:manager:dashboards', 'dashboard.update', (data) => seen.push(['first', data.id]));
  relay.realtime.on('homey:manager:dashboards', 'dashboard.update', (data) => seen.push(['second', data.id]));
  relay.realtime.on('homey:manager:devices', 'device.update', () => assert.fail('wrong event subscriber'));
  await relay.next();
  assert.equal(requests[0].route, 'events');
  assert.equal(requests[0].payload.subscriptions.length, 2);
  assert.equal(requests[0].payload.cursor, undefined);
  firstOff();
  await relay.next();
  assert.equal(requests[1].payload.cursor, 'epoch:1');
  assert.deepEqual(seen, [['second', 'office']]);
  assert.equal(relay.callbacks.reconnects, 1);
  relay.realtime.close();
  assert.equal(relay.timers.size, 0);
});

test('broker polling never overlaps, pauses while hidden, and aborts on pagehide', async () => {
  let finish;
  let signal;
  let calls = 0;
  const relay = await relayHarness(async (route, payload, options) => {
    calls += 1;
    signal = options.signal;
    return new Promise((resolve) => { finish = resolve; });
  });
  const inFlight = relay.next();
  relay.realtime.on('homey:manager:dashboards', 'dashboard.update', () => {});
  assert.equal(relay.timers.size, 0, 'a new subscription must not start a parallel poll');
  relay.visibility.visible = false;
  relay.visibility.listener(false);
  assert.equal(signal.aborted, true);
  finish({ cursor: 'epoch:1', events: [] });
  await inFlight;
  assert.equal(relay.timers.size, 0);
  relay.visibility.visible = true;
  relay.visibility.listener(true);
  const resumed = relay.next();
  assert.equal(calls, 2);
  relay.pageEvents.get('pagehide')();
  assert.equal(signal.aborted, true);
  finish({ cursor: 'epoch:2', events: [] });
  await resumed;
  assert.equal(relay.timers.size, 0);
  assert.equal(relay.visibility.listener, null);
});

test('revoked broker sessions stop polling and request re-pairing without a direct-key fallback', async () => {
  const relay = await relayHarness(async () => { throw Object.assign(new Error('Revoked'), { status: 401 }); });
  await relay.next();
  assert.equal(relay.callbacks.unauthorized, 1);
  assert.deepEqual(relay.statuses, ['offline']);
  assert.equal(relay.timers.size, 0);
  assert.equal(relay.pageEvents.has('pagehide'), false);
});

test('reconnecting after a temporary relay outage refreshes native dashboards once', async () => {
  let calls = 0;
  const relay = await relayHarness(async () => {
    calls += 1;
    if (calls === 2) throw new Error('Temporary network error');
    return { cursor: `epoch:${calls}`, events: [] };
  });
  await relay.next();
  await relay.next();
  await relay.next();
  assert.deepEqual(relay.statuses, ['live', 'offline', 'live']);
  assert.equal(relay.callbacks.reconnects, 1);
  relay.realtime.close();
});
