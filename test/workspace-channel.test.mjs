import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const parentSource = await readFile(new URL('../settings/workspace.js', import.meta.url), 'utf8');
const moduleSources = new Map(await Promise.all(['embedded.js', 'homey-api.js'].map(async (name) => [
  name, await readFile(new URL(`../assets/web/js/${name}`, import.meta.url), 'utf8'),
])));
const origin = 'http://192.168.80.87:4859';
const address = `${origin}/app/dev.schweiger.dashboard/assets/web/index.html`;
const session = { token: `wd_${'c'.repeat(64)}`, transport: 'broker', screenId: 'native-channel-screen' };
const drain = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

class Target {
  listeners = new Map();
  attributes = new Map();
  dataset = {};
  hidden = false;
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(handler);
  }
  removeEventListener(name, handler) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((value) => value !== handler));
  }
  emit(name, event = {}) { for (const handler of this.listeners.get(name) ?? []) handler(event); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  set src(value) { this.setAttribute('src', value); }
  get src() { return this.getAttribute('src'); }
  focus() {}
}

function clock() {
  let serial = 0;
  const timers = new Map();
  return {
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    expire(delay) {
      for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
    },
  };
}

// Ports preserve the browser's asynchronous delivery and closure behavior. Crucially, both ends execute actual
// production modules; neither side supplies a stubbed protocol implementation that could hide ID/shape mismatches.
class Port {
  closed = false;
  messages = [];
  start() {}
  close() { this.closed = true; }
  postMessage(message) {
    if (this.closed) throw new Error('Port closed');
    const value = structuredClone(message);
    this.messages.push(value);
    queueMicrotask(() => { if (!this.peer.closed) this.peer.onmessage?.({ data: value }); });
  }
}

function host() {
  const calls = [];
  const parentClock = clock();
  const nodes = new Map([
    'workspace-frame', 'workspace-status', 'dashboard-tab', 'connection-tab', 'dashboard-panel', 'connection-panel',
    'workspace-reload', 'workspace-expand', 'workspace-open',
  ].map((id) => [id, new Target()]));
  for (const name of ['dashboard', 'connection']) nodes.get(`${name}-tab`).setAttribute('aria-controls', `${name}-panel`);
  const frame = nodes.get('workspace-frame');
  const window = new Target();
  window.location = new URL(`${origin}/app/dev.schweiger.dashboard/settings/`);
  window.origin = 'null';
  window.crypto = webcrypto;
  const document = new Target();
  document.visibilityState = 'visible';
  document.getElementById = (id) => nodes.get(id);
  const Homey = {
    api(method, route, body, callback) { calls.push({ method, route, body: structuredClone(body), callback }); },
    openURL() {},
  };
  const context = vm.createContext({ window, document, URL, Uint8Array, ...parentClock });
  vm.runInContext(parentSource, context, { filename: 'settings/workspace.js' });
  const controller = context.createDashboardWorkspace(Homey);
  controller.setAddress(address);
  return { calls, frame, nodes, window, controller, clock: parentClock };
}

async function child(parent, { referrer = '' } = {}) {
  const childClock = clock();
  const challenges = [];
  const channels = [];
  const window = new Target();
  const location = new URL(parent.frame.src);
  const parentProxy = {
    postMessage(message, target, ports) {
      challenges.push({ message, target });
      // Opaque origins only receive wildcard window messages, regardless of their URL-shaped referrer.
      if (target !== '*') return;
      parent.window.emit('message', { source: window, origin: 'null', data: structuredClone(message), ports });
    },
  };
  Object.defineProperty(parentProxy, 'location', { get() { throw new Error('Opaque parent access denied'); } });
  window.parent = parentProxy;
  window.postMessage = () => assert.fail('nonce-bearing connections must not receive raw window credentials');
  parent.frame.contentWindow = window;
  const document = new Target();
  document.referrer = referrer;
  document.visibilityState = 'visible';
  class MessageChannel {
    constructor() {
      this.port1 = new Port(); this.port2 = new Port();
      this.port1.peer = this.port2; this.port2.peer = this.port1;
      channels.push(this);
    }
  }
  const context = vm.createContext({
    window, document, location, URL, URLSearchParams, MessageChannel, ...childClock,
    fetch: () => assert.fail('embedded API traffic must use the signed-in parent, not fetch'),
  });
  const loaded = new Map();
  function load(name) {
    if (!loaded.has(name)) loaded.set(name, new vm.SourceTextModule(moduleSources.get(name), { context, identifier: name }));
    return loaded.get(name);
  }
  const module = load('homey-api.js');
  await module.link((specifier) => load(specifier.replace('./', '')));
  await module.evaluate();
  const embedded = loaded.get('embedded.js').namespace;
  return { embedded, createClient: module.namespace.createClient, channels, challenges, clock: childClock, window };
}

async function connected({ referrer = '' } = {}) {
  const parent = host();
  const view = await child(parent, { referrer });
  const waiting = view.embedded.waitForEmbeddedConfig();
  assert.equal(parent.calls.length, 1, 'the real transferred-port handshake must reach the SDK');
  assert.equal(parent.calls[0].route, '/workspace/connect');
  parent.calls[0].callback(null, session);
  const config = await waiting;
  const client = view.createClient(config);
  return { parent, view, config, client };
}

test('coupled parent and child bound concurrent controls and recover after their request timeouts', async () => {
  const { parent, view, client } = await connected();
  const pending = Array.from({ length: 32 }, (_, i) => client.api('POST', `/api/manager/flow/flow/preview-${i}/trigger`, {})
    .then((value) => ({ value }), (error) => ({ error })));
  await drain();
  assert.equal(parent.calls.length, 33, 'only the approved connect and 32 active controls reach the SDK');
  assert.ok(parent.calls.slice(1).every((call) => call.route === '/workspace/request' && call.body.token === session.token));
  await assert.rejects(client.api('GET', '/api/manager/dashboards/dashboard'), (error) => error.status === 429);
  assert.equal(parent.calls.length, 33);

  view.clock.expire(20000);
  const outcomes = await Promise.all(pending);
  assert.ok(outcomes.every(({ error }) => error?.status === 504));
  parent.clock.expire(25000);
  await drain();
  // A late response to an already timed-out physical command must neither settle another request nor trigger a retry.
  parent.calls[1].callback(null, { tooLate: true });
  await drain();
  assert.equal(parent.calls.length, 33);

  const resumed = client.broker('events', { subscriptions: [] });
  await drain();
  assert.equal(parent.calls.length, 34);
  assert.equal(parent.calls.at(-1).route, '/workspace/events');
  parent.calls.at(-1).callback(null, { cursor: 'epoch:1', events: [] });
  assert.deepEqual(structuredClone(await resumed), { cursor: 'epoch:1', events: [] });
  const childRequests = view.channels[0].port1.messages.filter((message) => message.type === 'dashboard:request');
  assert.ok(childRequests.every((message) => Number.isSafeInteger(message.id)));
  assert.ok(!JSON.stringify(childRequests).includes(session.token));
});

test('reload closes the prior channel and stale SDK replies cannot enter the replacement connection', async () => {
  const { parent, view, client } = await connected();
  const waiting = client.api('GET', '/api/manager/dashboards/dashboard');
  await drain();
  const oldRequest = parent.calls.at(-1);
  const oldNonce = view.challenges[0].message.nonce;
  const oldPort = view.channels[0].port2;
  parent.nodes.get('workspace-reload').emit('click');
  assert.equal(oldPort.closed, true);
  assert.notEqual(new URLSearchParams(new URL(parent.frame.src).hash.slice(1)).get('bridge'), oldNonce);
  oldRequest.callback(null, { stale: true });
  await drain();
  assert.equal(oldPort.messages.some((message) => message.type === 'dashboard:response'), false);
  view.clock.expire(20000);
  await assert.rejects(waiting, (error) => error.status === 504);

  const replacement = await child(parent);
  const configReady = replacement.embedded.waitForEmbeddedConfig();
  parent.calls.at(-1).callback(null, { ...session, token: `wd_${'d'.repeat(64)}` });
  const config = await configReady;
  assert.equal(config.token, 'embedded-channel');
});
