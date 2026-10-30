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
  let now = 0;
  const timers = new Map();
  return {
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    count(delay) { return [...timers.values()].filter((timer) => timer.delay === delay).length; },
    advance(amount) {
      now += amount;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
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

const cameraOffer = { method: 'POST', path: '/api/manager/videos/video/camera-1/offer', body: { offer: 'v=0' } };

test('a real camera offer crosses the actual parent/child channel beyond all old budgets and returns its answer', async () => {
  const { parent, view, client } = await connected();
  let settled = false;
  const pending = client.api(cameraOffer.method, cameraOffer.path, cameraOffer.body).finally(() => { settled = true; });
  await drain();
  assert.equal(parent.clock.count(50000), 1);
  assert.equal(view.clock.count(55000), 1);
  for (const amount of [15000, 5000, 5000, 15000]) {
    parent.clock.advance(amount); view.clock.advance(amount); await drain();
    assert.equal(settled, false, 'the old 15/20/25-second budgets must not terminate a camera offer');
  }
  assert.equal(parent.calls.length, 2);
  assert.equal(parent.calls[1].body.token, session.token);
  parent.calls[1].callback(null, { answerSdp: 'after-forty-seconds', streamId: 'camera-stream' });
  assert.deepEqual(structuredClone(await pending), { answerSdp: 'after-forty-seconds', streamId: 'camera-stream' });
  assert.equal(parent.clock.count(50000), 0);
  assert.equal(view.clock.count(55000), 0);
  assert.equal(parent.calls.length, 2, 'a slow offer must not be replayed');
});

test('parent camera expiry reaches the actual child once, ignores a late answer and permits a normal follow-up', async () => {
  const { parent, view, client } = await connected();
  const pending = client.api(cameraOffer.method, cameraOffer.path, cameraOffer.body).catch((error) => error);
  await drain();
  const old = parent.calls[1];
  parent.clock.advance(50000); view.clock.advance(50000); await drain();
  assert.equal((await pending).status, 504);
  assert.equal(view.clock.count(55000), 0);
  const replies = view.channels[0].port2.messages.length;
  old.callback(null, { answerSdp: 'expired-answer' }); await drain();
  assert.equal(view.channels[0].port2.messages.length, replies);
  assert.equal(parent.calls.length, 2);
  const followup = client.api('GET', '/api/manager/dashboards/dashboard');
  await drain();
  assert.equal(parent.clock.count(25000), 1);
  assert.equal(view.clock.count(20000), 1);
  parent.calls.at(-1).callback(null, { dashboard: 'still-connected' });
  assert.equal((await followup).dashboard, 'still-connected');
});

test('the child camera guard expires at 55 seconds and ignores a late parent answer without closing the channel', async () => {
  const { parent, view, client } = await connected();
  const pending = client.api(cameraOffer.method, cameraOffer.path, cameraOffer.body).catch((error) => error);
  await drain();
  view.clock.advance(25000); await drain();
  assert.equal(view.clock.count(55000), 1);
  view.clock.advance(30000);
  assert.equal((await pending).status, 504);
  parent.calls[1].callback(null, { answerSdp: 'late-parent-answer' }); await drain();
  assert.equal(parent.calls.length, 2);
  const followup = client.api('GET', '/api/manager/dashboards/dashboard');
  await drain();
  parent.calls.at(-1).callback(null, { dashboard: 'fresh-response' });
  assert.equal((await followup).dashboard, 'fresh-response');
});

test('camera-like requests and controls retain ordinary child and parent guards with no timeout override', async () => {
  for (const [route, body] of [
    ['request', { method: 'PUT', path: '/api/manager/devices/device/device-1/capability/onoff', body: { value: true }, timeout: 999999 }],
    ['request', { ...cameraOffer, method: 'GET' }],
    ['request', { ...cameraOffer, path: `${cameraOffer.path}/` }],
    ['request', { ...cameraOffer, path: `${cameraOffer.path}?extra=true` }],
    ['request', { ...cameraOffer, path: '/api/manager/videos/video/camera%2D1/offer' }],
    ['request', { ...cameraOffer, body: { offer: 'v=0', timeout: 999999 } }],
    ['request', { ...cameraOffer, body: { offer: '' } }],
    ['request', { ...cameraOffer, body: { offer: 'x'.repeat(256001) } }],
    ['request', { ...cameraOffer, body: ['v=0'] }],
    ['events', { ...cameraOffer, timeout: 999999 }],
  ]) {
    const { parent, view, client } = await connected();
    const pending = client.broker(route, body, { timeout: 999999 }).catch((error) => error);
    await drain();
    assert.equal(parent.clock.count(25000), 1, `${route} ${body.path}`);
    assert.equal(view.clock.count(20000), 1, `${route} ${body.path}`);
    assert.equal(parent.clock.count(50000), 0);
    assert.equal(view.clock.count(55000), 0);
    view.clock.advance(20000);
    assert.equal((await pending).status, 504);
    parent.clock.advance(25000); await drain();
    assert.equal(parent.calls.length, 2, 'timed-out near misses are not replayed');
  }
});

test('disposing a child with a pending extended camera request rejects it and drops the late SDK response', async () => {
  const { parent, view, client } = await connected();
  const pending = client.api(cameraOffer.method, cameraOffer.path, cameraOffer.body).catch((error) => error);
  await drain();
  view.window.emit('pagehide');
  assert.equal((await pending).status, 401);
  assert.equal(view.channels[0].port1.closed, true);
  assert.equal(view.clock.count(55000), 0);
  parent.calls[1].callback(null, { answerSdp: 'late-after-dispose' }); await drain();
  assert.equal(parent.calls.length, 2);
  await assert.rejects(client.api(cameraOffer.method, cameraOffer.path, cameraOffer.body), (error) => error.status === 401);
});

test('the camera backend timeout reaches the real child with its useful status and message before outer guards', async () => {
  const { parent, view, client } = await connected();
  const pending = client.api(cameraOffer.method, cameraOffer.path, cameraOffer.body).catch((error) => error);
  await drain();
  parent.clock.advance(45000); view.clock.advance(45000);
  parent.calls[1].callback(Object.assign(new Error('The camera did not finish connecting. Tap to retry.'), { statusCode: 504 }));
  const error = await pending;
  assert.equal(error.status, 504);
  assert.equal(error.message, 'The camera did not finish connecting. Tap to retry.');
  assert.equal(parent.clock.count(50000), 0);
  assert.equal(view.clock.count(55000), 0);
  assert.equal(parent.calls.length, 2, 'a camera-specific timeout does not replay the offer');
});
