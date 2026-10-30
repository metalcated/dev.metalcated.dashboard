'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../settings/workspace.js'), 'utf8');
const ADDRESS = 'https://192-168-1-20.homey.homeylocal.com:4860/app/dev.schweiger.dashboard/assets/web/index.html';
const ORIGIN = new URL(ADDRESS).origin;

// A small app-view host: tests run the actual controller and observe its security boundary, asynchronous connection
// callbacks, and visibility events. It intentionally has no browser storage or real network implementation.
function workspace({ settingsUrl = 'https://my.homey.app/', opaqueOrigin = false } = {}) {
  const timers = new Map();
  const calls = [];
  const sent = [];
  const opened = [];
  let lastPort = null;
  let nextTimer = 1;
  let document;

  class Target {
    constructor() {
      this.listeners = new Map();
      this.attributes = new Map();
      this.dataset = {};
      this.hidden = false;
      this.disabled = true;
      this.textContent = '';
    }
    addEventListener(name, handler) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(handler);
    }
    emit(name, payload = {}) {
      for (const handler of this.listeners.get(name) ?? []) handler(payload);
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    set src(value) { this.setAttribute('src', value); }
    get src() { return this.getAttribute('src'); }
    focus() { document.activeElement = this; }
  }

  const nodes = new Map([
    'workspace-frame', 'workspace-status', 'dashboard-tab', 'connection-tab', 'dashboard-panel', 'connection-panel',
    'workspace-reload', 'workspace-expand', 'workspace-open',
  ].map((id) => {
    const node = new Target();
    node.id = id;
    return [id, node];
  }));
  const node = (id) => nodes.get(id);
  for (const name of ['dashboard', 'connection']) {
    node(`${name}-tab`).setAttribute('aria-controls', `${name}-panel`);
    node(`${name}-tab`).setAttribute('aria-selected', String(name === 'dashboard'));
    node(`${name}-tab`).tabIndex = name === 'dashboard' ? 0 : -1;
  }
  node('connection-panel').hidden = true;
  const frame = node('workspace-frame');
  frame.hidden = true;
  frame.contentWindow = { postMessage(message, origin) { sent.push({ message, origin }); } };
  document = new Target();
  document.visibilityState = 'visible';
  document.getElementById = node;
  const window = new Target();
  window.location = new URL(settingsUrl);
  window.origin = opaqueOrigin ? 'null' : window.location.origin;
  let nextNonce = 1;
  window.crypto = { getRandomValues(bytes) { bytes.fill(nextNonce++); return bytes; } };
  const Homey = {
    api(method, route, body, callback) { calls.push({ method, route, body, callback }); },
    openURL(url) { opened.push(url); },
  };
  const context = {
    window, document, URL,
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'settings/workspace.js' });
  const controller = context.createDashboardWorkspace(Homey);
  return {
    controller, node, frame, window, document, calls, sent, opened, timers,
    ready(extra = {}) {
      const nonce = new URLSearchParams(new URL(frame.src).hash.slice(1)).get('bridge');
      lastPort = extra.ports?.[0] ?? {
        postMessage(message) { sent.push({ message, origin: new URL(controller.address()).origin }); },
        start() {}, close() {},
      };
      window.emit('message', { source: frame.contentWindow, origin: ORIGIN, data: { type: 'dashboard:ready', nonce }, ports: [lastPort], ...extra });
    },
    error(message) { lastPort?.onmessage?.({ data: { type: 'dashboard:error', message } }); },
    runTimer(delay) {
      const found = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(found, `expected ${delay} ms timer`);
      timers.delete(found[0]);
      found[1].callback();
    },
  };
}

const approved = { token: 'opaque-preview-connection', transport: 'broker', screenId: 'screen-preview' };
const connections = (host) => host.sent.filter(({ message }) => message.type === 'dashboard:connect');

test('only the expected dashboard frame and exact origin can request automatic connection', () => {
  const host = workspace();
  host.controller.setAddress(ADDRESS);
  host.ready({ source: {} });
  host.ready({ origin: 'https://attacker.example' });
  host.ready({ origin: 'null' });
  host.ready({ data: { type: 'dashboard:ready' }, ports: [] });
  assert.equal(host.calls.length, 0);
  host.ready();
  assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0].method, 'POST');
  assert.equal(host.calls[0].route, '/workspace/connect');
  host.calls[0].callback(null, approved);

  assert.equal(connections(host).length, 1);
  const sent = connections(host)[0];
  assert.equal(sent.origin, ORIGIN);
  assert.equal(sent.message.config.token, 'embedded-channel');
  assert.equal(sent.message.config.screenId, approved.screenId);
  assert.equal(sent.message.config.homeyUrl, ORIGIN);
  assert.equal(new URL(host.frame.src).searchParams.get('embedded'), '1');
  assert.match(new URL(host.frame.src).searchParams.get('visit'), /^\d+$/);
  assert.ok(!host.frame.src.includes(approved.token), 'credentials must never enter a URL');
  assert.equal(host.node('workspace-status').hidden, true);
});

test('a timed out connection ignores its late callback and a reload can connect successfully', () => {
  const host = workspace();
  host.controller.setAddress(ADDRESS);
  host.ready();
  host.runTimer(12000);
  const status = host.node('workspace-status');
  assert.equal(status.dataset.error, 'true');
  assert.match(status.textContent, /Reload/);
  host.calls[0].callback(null, approved);
  assert.equal(connections(host).length, 0);
  assert.equal(status.hidden, false);

  host.node('workspace-reload').emit('click');
  host.ready();
  host.calls[1].callback(null, approved);
  assert.equal(connections(host).length, 1);
  assert.equal(status.hidden, true);
  assert.equal(host.timers.size, 0);
});

test('a frame error invalidates an in-flight response instead of hiding the failure', () => {
  const host = workspace();
  host.controller.setAddress(ADDRESS);
  host.ready();
  host.error('Connection expired. Reload to reconnect.');
  host.calls[0].callback(null, approved);
  assert.equal(connections(host).length, 0);
  assert.equal(host.node('workspace-status').hidden, false);
  assert.match(host.node('workspace-status').textContent, /Connection expired/);
});

test('reload invalidates a response for the previous iframe visit', () => {
  const host = workspace();
  host.controller.setAddress(ADDRESS);
  host.ready();
  host.node('workspace-reload').emit('click');
  host.calls[0].callback(null, approved);
  assert.equal(connections(host).length, 0);
  host.ready();
  host.calls[1].callback(null, approved);
  assert.equal(connections(host).length, 1);
});

test('connection failures and malformed responses keep an actionable error without sending credentials', () => {
  for (const [error, connection] of [[new Error('Homey permission required'), null], [null, { token: 'raw-owner-key' }]]) {
    const host = workspace();
    host.controller.setAddress(ADDRESS);
    host.ready();
    host.calls[0].callback(error, connection);
    assert.equal(connections(host).length, 0);
    assert.equal(host.node('workspace-status').hidden, false);
    assert.equal(host.node('workspace-status').dataset.error, 'true');
  }
});

test('tab and document visibility are forwarded so hidden camera widgets can pause', () => {
  const host = workspace();
  host.controller.setAddress(ADDRESS);
  host.node('connection-tab').emit('click');
  assert.equal(host.node('dashboard-panel').hidden, true);
  assert.equal(host.node('connection-panel').hidden, false);
  assert.equal(host.sent.at(-1).message.type, 'dashboard:visibility');
  assert.equal(host.sent.at(-1).message.visible, false);

  let prevented = false;
  host.node('connection-tab').emit('keydown', { key: 'Home', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(host.document.activeElement, host.node('dashboard-tab'));
  assert.equal(host.node('dashboard-tab').getAttribute('aria-selected'), 'true');
  assert.equal(host.node('connection-tab').tabIndex, -1);
  assert.equal(host.sent.at(-1).message.visible, true);

  host.document.visibilityState = 'hidden';
  host.document.emit('visibilitychange');
  assert.equal(host.sent.at(-1).message.visible, false);
});

test('invalid protocols, credentials, queries and unrelated pages cannot become dashboard destinations', () => {
  const invalid = [
    'javascript:alert(1)',
    'data:text/html,preview',
    'not an address',
    ADDRESS.replace('https://', 'https://user:password@'),
    `${ADDRESS}?token=secret`,
    `${ADDRESS}#secret`,
    'https://attacker.example/login',
    ADDRESS.replace('192-168-1-20.homey.homeylocal.com:4860', 'attacker.example'),
    ADDRESS.replace('dev.schweiger.dashboard', 'another.app'),
    ADDRESS.replace('192-168-1-20.homey.homeylocal.com', '192-168-1-20.evil.example'),
  ];
  for (const value of invalid) {
    const host = workspace();
    host.controller.setAddress(value);
    assert.equal(host.controller.address(), null, value);
    assert.equal(host.frame.hasAttribute('src'), false, value);
    assert.equal(host.calls.length, 0, value);
  }
});

test('separate-screen opening uses a clean dashboard address rather than an embedded connection URL', () => {
  const host = workspace();
  host.controller.setAddress(ADDRESS);
  host.node('workspace-open').emit('click');
  assert.deepEqual(host.opened, [ADDRESS]);
});

test('a working LAN app-settings origin avoids the generated DNS name and keeps connection delivery exact', () => {
  const origin = 'http://192.168.80.87:4859';
  const host = workspace({ settingsUrl: `${origin}/app/dev.schweiger.dashboard/settings/` });
  host.controller.setAddress('https://192-168-80-87.homey.homeylocal.com:4860/app/dev.schweiger.dashboard/assets/web/index.html');
  assert.equal(host.controller.address(), `${origin}/app/dev.schweiger.dashboard/assets/web/index.html`);
  assert.equal(new URL(host.frame.src).origin, origin);
  assert.equal(new URL(host.frame.src).searchParams.get('embedded'), '1');
  host.ready(); // The failed generated hostname is no longer an accepted sender.
  assert.equal(host.calls.length, 0);
  host.ready({ origin });
  assert.equal(host.calls.length, 1);
  host.calls[0].callback(null, approved);
  assert.equal(connections(host)[0].origin, origin);
  assert.equal(connections(host)[0].message.config.homeyUrl, origin);
  assert.ok(!host.frame.src.includes(approved.token));
  host.node('workspace-open').emit('click');
  assert.deepEqual(host.opened, [host.controller.address()]);
});

test('reusing an already loaded HTTPS Homey settings origin preserves HTTPS and its actual port', () => {
  const origin = 'https://192-168-80-87.homey.homeylocal.com:4443';
  const host = workspace({ settingsUrl: `${origin}/app/dev.schweiger.dashboard/settings/index.html` });
  host.controller.setAddress('http://192.168.80.87:4859/app/dev.schweiger.dashboard/assets/web/index.html');
  assert.equal(new URL(host.controller.address()).origin, origin);
  assert.equal(new URL(host.frame.src).protocol, 'https:');
});

test('cloud settings and unrelated/private-origin pages cannot change the validated dashboard destination', () => {
  for (const settingsUrl of [
    'https://my.homey.app/app/dev.schweiger.dashboard/settings/',
    'https://attacker.example/app/dev.schweiger.dashboard/settings/',
    'http://192.168.80.87:4859/app/another.app/settings/',
    'http://192.168.80.87:4859/app/dev.schweiger.dashboard/assets/web/index.html',
    'http://192.168.80.87:4859/app/dev.schweiger.dashboard/settings-untrusted/',
  ]) {
    const host = workspace({ settingsUrl });
    host.controller.setAddress(ADDRESS);
    assert.equal(host.controller.address(), ADDRESS, settingsUrl);
    assert.equal(new URL(host.frame.src).protocol, 'https:', settingsUrl);
  }
  const host = workspace({ settingsUrl: 'http://192.168.80.87:4859/app/dev.schweiger.dashboard/settings/' });
  host.controller.setAddress('https://attacker.example/app/dev.schweiger.dashboard/assets/web/index.html');
  assert.equal(host.controller.address(), null, 'the source address must still pass the original destination checks');
  assert.equal(host.frame.hasAttribute('src'), false);
});

function openChannel(host, changes = {}) {
  const port = {
    sent: [], closed: false,
    postMessage(message) { this.sent.push(message); },
    start() { this.started = true; },
    close() { this.closed = true; },
    emit(data) { this.onmessage?.({ data }); },
  };
  const nonce = new URLSearchParams(new URL(host.frame.src).hash.slice(1)).get('bridge');
  host.ready({ origin: 'null', data: { type: 'dashboard:ready', nonce }, ports: [port], ...changes });
  return port;
}

test('an opaque Homey settings view binds only its current iframe and nonce to a private channel', () => {
  const host = workspace({ opaqueOrigin: true });
  host.controller.setAddress(ADDRESS);
  const nonce = new URLSearchParams(new URL(host.frame.src).hash.slice(1)).get('bridge');
  assert.match(nonce, /^[a-f0-9]{32}$/);
  openChannel(host, { source: {} });
  openChannel(host, { data: { type: 'dashboard:ready', nonce: 'a'.repeat(32) } });
  openChannel(host, { origin: 'https://attacker.example' });
  host.ready({ origin: 'null', data: { type: 'dashboard:ready' }, ports: [] });
  assert.equal(host.calls.length, 0);
  const port = openChannel(host);
  assert.equal(host.calls.length, 1);
  host.calls[0].callback(null, approved);
  const connection = port.sent.find((message) => message.type === 'dashboard:connect');
  assert.equal(connection.config.token, 'embedded-channel', 'the real broker credential stays in the signed-in settings frame');
  assert.ok(!JSON.stringify(port.sent).includes(approved.token));
  assert.equal(host.sent.length, 0, 'opaque-origin connections never send credentials using window.postMessage');
  assert.equal(port.started, true);

  const normal = workspace();
  normal.controller.setAddress(ADDRESS);
  openChannel(normal);
  assert.equal(normal.calls.length, 0, 'a normal-origin parent must not accept opaque-origin senders');
});

test('the private channel forwards only bounded broker requests with the parent session and preserves errors', () => {
  const host = workspace({ opaqueOrigin: true });
  host.controller.setAddress(ADDRESS);
  const port = openChannel(host);
  host.calls[0].callback(null, approved);
  port.emit({ type: 'dashboard:request', id: 1, route: 'request', body: { method: 'GET', path: '/api/manager/dashboards/dashboard', token: 'injected-key' } });
  assert.equal(host.calls[1].route, '/workspace/request');
  assert.equal(host.calls[1].body.token, approved.token);
  host.calls[1].callback(null, { dashboard: 'shared-mobile-layout' });
  assert.equal(port.sent.at(-1).value.dashboard, 'shared-mobile-layout');
  port.emit({ type: 'dashboard:request', id: 2, route: 'events', body: { subscriptions: [] } });
  host.calls[2].callback(Object.assign(new Error('Connection revoked'), { statusCode: 401 }));
  assert.equal(port.sent.at(-1).error.status, 401);
  assert.equal(port.sent.at(-1).error.message, 'Connection revoked');
  for (const request of [
    { id: 3, route: '/api-key', body: {} },
    { id: 4, route: 'request', body: [] },
    { id: 5, route: 'request', body: { text: 'x'.repeat(1024 * 1024) } },
  ]) port.emit({ type: 'dashboard:request', ...request });
  assert.equal(host.calls.length, 3, 'invalid calls never enter the signed Homey SDK channel');
  assert.equal(port.sent.at(-1).error.status, 400);
  host.node('connection-tab').emit('click');
  assert.equal(port.sent.at(-1).type, 'dashboard:visibility');
  assert.equal(port.sent.at(-1).visible, false);
});

test('reload closes the old port, changes its nonce, and ignores old request replies', () => {
  const host = workspace({ opaqueOrigin: true });
  host.controller.setAddress(ADDRESS);
  const first = openChannel(host);
  host.calls[0].callback(null, approved);
  const oldNonce = new URL(host.frame.src).hash;
  const oldDocumentUrl = host.frame.src.split('#')[0];
  first.emit({ type: 'dashboard:request', id: 1, route: 'request', body: { method: 'GET', path: '/api/manager/dashboards/dashboard' } });
  const oldRequest = host.calls[1];
  host.node('workspace-reload').emit('click');
  assert.equal(first.closed, true);
  assert.notEqual(new URL(host.frame.src).hash, oldNonce);
  assert.notEqual(host.frame.src.split('#')[0], oldDocumentUrl, 'Reload must navigate beyond the fragment to recreate the document');
  oldRequest.callback(null, { stale: true });
  assert.equal(first.sent.some((message) => message.type === 'dashboard:response'), false);
  const second = openChannel(host);
  host.calls[2].callback(null, approved);
  second.emit({ type: 'dashboard:request', id: 1, route: 'events', body: { subscriptions: [] } });
  host.runTimer(25000);
  assert.equal(second.sent.at(-1).error.status, 504);
  const replies = second.sent.length;
  host.calls[3].callback(null, { late: true });
  assert.equal(second.sent.length, replies);
  host.window.emit('pagehide');
  assert.equal(second.closed, true);
});

test('opaque connection-list refresh pauses outside its tab and disposes with the app view', () => {
  const host = workspace({ opaqueOrigin: true });
  let refreshed = 0;
  host.controller.keepConnectionsUpdated(() => refreshed++);
  host.runTimer(3000);
  assert.equal(refreshed, 0);
  host.node('connection-tab').emit('click');
  host.runTimer(3000);
  assert.equal(refreshed, 1);
  host.document.visibilityState = 'hidden';
  host.runTimer(3000);
  assert.equal(refreshed, 1);
  host.window.emit('pagehide');
  assert.equal(host.timers.size, 0);
  const normal = workspace();
  normal.controller.keepConnectionsUpdated(() => assert.fail('native realtime must remain in use'));
  assert.equal(normal.timers.size, 0);
});
