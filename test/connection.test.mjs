import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function load(name, globals = {}, imports = {}) {
  if (name === 'homey-api.js' && !imports['./embedded.js']) {
    imports['./embedded.js'] = { usesEmbeddedBroker: () => false, requestEmbeddedBroker: () => assert.fail('not an embedded connection') };
  }
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

test('an empty referrer can use the browser-verified same-origin settings parent for this app', async () => {
  const browser = embeddedBrowser('');
  browser.parent.location = { href: `${location.origin}/app/test.dashboard/settings/index.html` };
  const api = await load('embedded.js', { ...browser, location });
  const pending = api.waitForEmbeddedConfig();
  const connection = { homeyUrl: location.origin, token: opaque, transport: 'broker', screenId: 'native-screen' };
  browser.windowEvents.get('message')({
    source: browser.parent, origin: location.origin,
    data: { type: 'dashboard:connect', config: connection },
  });
  assert.deepEqual(structuredClone(await pending), connection);
  assert.equal(browser.sent[0].message.type, 'dashboard:ready');
  assert.equal(browser.sent[0].origin, location.origin);
});

test('the empty-referrer fallback rejects other apps, unrelated paths, and another origin', async () => {
  const cases = [
    `${location.origin}/app/another.dashboard/settings/index.html`,
    `${location.origin}/web/settings`,
    `${location.origin}/app/test.dashboard/settings/nested/index.html`,
    'https://another.example/app/test.dashboard/settings/index.html',
    'http://homey.local:9999/app/test.dashboard/settings/index.html',
    'http://user:password@homey.local:4859/app/test.dashboard/settings/index.html',
  ];
  for (const href of cases) {
    const browser = embeddedBrowser('');
    browser.parent.location = { href };
    const api = await load('embedded.js', { ...browser, location });
    await assert.rejects(api.waitForEmbeddedConfig(), /Open this dashboard from its Homey app view/, href);
    assert.equal(browser.sent.length, 0);
  }
});

test('the fallback cannot bypass a cross-origin location access denial or a malformed nonempty referrer', async () => {
  const crossOrigin = embeddedBrowser('');
  Object.defineProperty(crossOrigin.parent, 'location', { get() { throw new Error('Cross-origin access denied'); } });
  const blocked = await load('embedded.js', { ...crossOrigin, location });
  await assert.rejects(blocked.waitForEmbeddedConfig(), /Open this dashboard from its Homey app view/);

  const malformed = embeddedBrowser('not-a-valid-referrer');
  malformed.parent.location = { href: `${location.origin}/app/test.dashboard/settings/index.html` };
  const invalid = await load('embedded.js', { ...malformed, location });
  await assert.rejects(invalid.waitForEmbeddedConfig(), /Open this dashboard from its Homey app view/);
});

function channels() {
  const pairs = [];
  class Port {
    constructor() { this.closed = false; this.sent = []; }
    start() {}
    close() { this.closed = true; }
    postMessage(message) {
      if (this.closed) throw new Error('Port closed');
      const copy = structuredClone(message);
      this.sent.push(copy);
      queueMicrotask(() => { if (!this.peer.closed) this.peer.onmessage?.({ data: copy }); });
    }
  }
  class MessageChannel {
    constructor() {
      this.port1 = new Port();
      this.port2 = new Port();
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
      pairs.push(this);
    }
  }
  return { MessageChannel, pairs };
}

async function channelFrame(extraGlobals = {}) {
  const browser = embeddedBrowser('http://homey.local:4859/app/test.dashboard/settings/index.html');
  browser.window.origin = 'null';
  const channel = channels();
  let transferred;
  browser.parent.postMessage = (message, origin, ports) => {
    browser.sent.push({ message, origin });
    transferred = ports[0];
  };
  const api = await load('embedded.js', { ...browser, ...channel, location: { ...location, hash: `#bridge=${'b'.repeat(32)}` }, ...extraGlobals });
  const waiting = api.waitForEmbeddedConfig();
  const connection = { homeyUrl: location.origin, token: 'embedded-channel', transport: 'broker', screenId: 'native-channel' };
  transferred.postMessage({ type: 'dashboard:connect', config: connection });
  await waiting;
  return { ...browser, api, port: transferred, pairs: channel.pairs, connection };
}

test('opaque settings use only a wildcard noncredential challenge and keep configuration and events on the transferred port', async () => {
  const frame = await channelFrame();
  assert.equal(frame.api.usesEmbeddedBroker(), true);
  assert.deepEqual(structuredClone(frame.sent), [{ message: { type: 'dashboard:ready', nonce: 'b'.repeat(32) }, origin: '*' }]);
  assert.equal(JSON.stringify(frame.sent).includes('embedded-channel'), false);
  frame.api.notifyEmbedded('connected');
  assert.equal(frame.pairs[0].port1.sent.at(-1).type, 'dashboard:connected');
  frame.port.postMessage({ type: 'dashboard:visibility', visible: false });
  await new Promise(setImmediate);
  assert.equal(frame.api.isDashboardVisible(), false);
  frame.windowEvents.get('message')({ source: frame.parent, origin: location.origin, data: { type: 'dashboard:visibility', visible: true } });
  assert.equal(frame.api.isDashboardVisible(), false, 'window messages cannot bypass the private channel');
});

test('nonce-bearing frames fail closed for malformed or duplicate fragments and missing MessageChannel', async () => {
  for (const hash of ['#bridge=short', `#bridge=${'c'.repeat(32)}&bridge=${'d'.repeat(32)}`]) {
    const browser = embeddedBrowser();
    const api = await load('embedded.js', { ...browser, ...channels(), location: { ...location, hash } });
    await assert.rejects(api.waitForEmbeddedConfig(), /connection is unavailable/);
    assert.equal(browser.sent.length, 0);
  }
  const browser = embeddedBrowser();
  const api = await load('embedded.js', { ...browser, location: { ...location, hash: `#bridge=${'c'.repeat(32)}` } });
  await assert.rejects(api.waitForEmbeddedConfig(), /connection is unavailable/);
  assert.equal(browser.sent.length, 0);
});

test('private-channel requests use numeric IDs, drop claimed tokens, preserve errors, and ignore aborted responses', async () => {
  const frame = await channelFrame();
  const seen = [];
  frame.port.onmessage = ({ data }) => {
    seen.push(data);
    if (data.body.path === '/denied') frame.port.postMessage({ type: 'dashboard:response', id: data.id, ok: false, error: { message: 'Denied', status: 403 } });
    else if (data.body.path !== '/abort') frame.port.postMessage({ type: 'dashboard:response', id: data.id, ok: true, value: { saved: true } });
  };
  const result = await frame.api.requestEmbeddedBroker('request', { method: 'GET', path: '/native', token: 'spoofed' });
  assert.equal(result.saved, true);
  assert.equal(Number.isSafeInteger(seen[0].id), true);
  assert.equal(seen[0].id > 0, true);
  assert.equal(Object.hasOwn(seen[0].body, 'token'), false);
  await assert.rejects(frame.api.requestEmbeddedBroker('request', { method: 'GET', path: '/denied' }), (error) => error.status === 403 && error.message === 'Denied');
  const abort = new AbortController();
  const request = frame.api.requestEmbeddedBroker('request', { method: 'GET', path: '/abort' }, { signal: abort.signal });
  const rejected = assert.rejects(request, (error) => error.name === 'AbortError');
  await new Promise(setImmediate);
  const abortedId = seen.at(-1).id;
  abort.abort();
  await rejected;
  frame.port.postMessage({ type: 'dashboard:response', id: abortedId, ok: true, value: { stale: true } });
  assert.equal((await frame.api.requestEmbeddedBroker('request', { method: 'GET', path: '/native' })).saved, true);
});

test('private-channel requests have a bounded timeout and never fall back to fetch', async () => {
  let timeout;
  const frame = await channelFrame({
    setTimeout(callback, delay) { if (delay === 20000) { timeout = callback; return 1; } return setTimeout(callback, delay); },
    clearTimeout(id) { if (id !== 1) clearTimeout(id); },
  });
  const request = frame.api.requestEmbeddedBroker('events', { subscriptions: [] });
  const rejected = assert.rejects(request, (error) => error.status === 504 && /Check the device/.test(error.message));
  timeout();
  await rejected;
  frame.windowEvents.get('pagehide')();
  await assert.rejects(frame.api.requestEmbeddedBroker('request', { method: 'GET', path: '/native' }), (error) => error.status === 401);
});

test('actual child broker requests are accepted by the actual opaque Homey settings controller', async () => {
  const origin = 'http://192.168.1.20:4859';
  const appId = 'dev.schweiger.dashboard';
  const nodes = new Map();
  class Target {
    constructor() { this.listeners = new Map(); this.attributes = new Map(); this.dataset = {}; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    set src(value) { this.setAttribute('src', value); }
    get src() { return this.getAttribute('src'); }
  }
  const node = (id) => { if (!nodes.has(id)) { const item = new Target(); item.id = id; nodes.set(id, item); } return nodes.get(id); };
  for (const name of ['dashboard', 'connection']) node(`${name}-tab`).setAttribute('aria-controls', `${name}-panel`);
  const browser = embeddedBrowser(`${origin}/app/${appId}/settings/index.html`);
  const parent = new Target();
  parent.location = new URL(`${origin}/app/${appId}/settings/index.html`);
  parent.origin = 'null';
  parent.crypto = { getRandomValues: (bytes) => { bytes.fill(0x5a); return bytes; } };
  parent.postMessage = (data, target, ports) => {
    assert.equal(target, '*', 'opaque parents cannot receive messages targeted at their URL-shaped referrer');
    parent.listeners.get('message')({ source: browser.window, origin: 'null', data, ports });
  };
  browser.window.parent = parent;
  const parentDocument = { getElementById: node, visibilityState: 'visible', addEventListener() {} };
  node('workspace-frame').contentWindow = browser.window;
  const calls = [];
  const parentContext = vm.createContext({ window: parent, document: parentDocument, URL, setTimeout, clearTimeout });
  const controllerSource = await readFile(new URL('../settings/workspace.js', import.meta.url), 'utf8');
  vm.runInContext(controllerSource, parentContext);
  const controller = parentContext.createDashboardWorkspace({
    api(method, route, body, callback) {
      calls.push({ method, route, body });
      if (route === '/workspace/connect') callback(null, { token: 'parent-only-session', transport: 'broker', screenId: 'native-parent' });
      else callback(null, { id: 'actual-native-dashboard' });
    },
  });
  controller.setAddress(`${origin}/app/${appId}/assets/web/index.html`);
  const childUrl = new URL(node('workspace-frame').src);
  const childLocation = { origin: childUrl.origin, pathname: childUrl.pathname, search: childUrl.search, hash: childUrl.hash };
  const child = await load('embedded.js', { ...browser, ...channels(), location: childLocation });
  const config = await child.waitForEmbeddedConfig();
  assert.equal(config.token, 'embedded-channel');
  const { createClient } = await load('homey-api.js', { location: childLocation, fetch: () => assert.fail('embedded channel must never fetch') }, {
    './embedded.js': { usesEmbeddedBroker: child.usesEmbeddedBroker, requestEmbeddedBroker: child.requestEmbeddedBroker },
  });
  const dashboard = await createClient(config).api('GET', '/api/manager/dashboards/dashboard');
  assert.equal(dashboard.id, 'actual-native-dashboard');
  assert.equal(calls.at(-1).route, '/workspace/request');
  assert.equal(calls.at(-1).body.token, 'parent-only-session');
  assert.equal(calls.at(-1).body.path, '/api/manager/dashboards/dashboard');
  parent.listeners.get('pagehide')();
  browser.windowEvents.get('pagehide')();
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
