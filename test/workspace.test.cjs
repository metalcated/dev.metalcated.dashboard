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
function workspace() {
  const timers = new Map();
  const calls = [];
  const sent = [];
  const opened = [];
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
    ready(extra = {}) { window.emit('message', { source: frame.contentWindow, origin: ORIGIN, data: { type: 'dashboard:ready' }, ...extra }); },
    error(message) { window.emit('message', { source: frame.contentWindow, origin: ORIGIN, data: { type: 'dashboard:error', message } }); },
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
  assert.equal(host.calls.length, 0);
  host.ready();
  assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0].method, 'POST');
  assert.equal(host.calls[0].route, '/workspace/connect');
  host.calls[0].callback(null, approved);

  assert.equal(connections(host).length, 1);
  const sent = connections(host)[0];
  assert.equal(sent.origin, ORIGIN);
  assert.equal(sent.message.config.token, approved.token);
  assert.equal(sent.message.config.screenId, approved.screenId);
  assert.equal(sent.message.config.homeyUrl, ORIGIN);
  assert.equal(new URL(host.frame.src).search, '?embedded=1');
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
