import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const clone = (value) => structuredClone(value);
const sources = new Map(await Promise.all(['sheets/widget-settings.js', 'dashboard-save.js', 'widgets/camera-live.js'].map(async name => [
  name, await readFile(new URL(`../assets/web/js/${name}`, import.meta.url), 'utf8'),
])));

class Element {
  constructor(tag = 'div', className = '', text = '') {
    this.tagName = tag; this.className = className; this._text = text; this.children = []; this.attributes = new Map();
    this.listeners = new Map(); this.style = {}; this.dataset = {}; this.open = false; this.hidden = false;
    const classes = new Set(className.split(/\s+/).filter(Boolean));
    this.classList = { add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name), toggle: (name, on) => on ? classes.add(name) : classes.delete(name) };
  }
  get textContent() { return String(this._text ?? '') + this.children.map(node => node.textContent ?? node).join(''); }
  set textContent(value) { this._text = value; this.replaceChildren(); }
  append(...nodes) { for (const node of nodes) { this.children.push(node); if (node instanceof Element) node.parent = this; } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  async emit(type, detail = {}) { await Promise.all([...(this.listeners.get(type) ?? [])].map(listener => listener({ target: this, ...detail }))); }
  click() { return this.emit('click'); }
  insertAdjacentHTML() {}
  showModal() { this.open = true; }
  close() { this.open = false; return this.emit('close'); }
  find(predicate) { if (predicate(this)) return this; return this.children.filter(node => node instanceof Element).map(node => node.find(predicate)).find(Boolean); }
  querySelector(selector) { return this.find(node => selector === `dialog.${node.className}` && node.tagName === 'dialog') ?? null; }
}

async function harness({ autoplay = false, omitAutoplay = false, type = 'device_camera_live' } = {}) {
  const initial = { id: 'board', name: 'Cameras', nativeMetadata: { keep: true }, columns: [{ id: 'camera-column', nativeColumn: 'keep', widgets: [
    { id: 'camera', type, title: 'Office', titleHidden: false, data: { deviceId: 'office', deviceVideoId: 'live', mobileOption: { keep: true },
      ...(!omitAutoplay ? { autoplay } : {}) } },
    { id: 'other', type: 'future_mobile_widget', data: { untouched: true } },
  ] }] };
  let server = clone(initial), denied = false;
  const calls = [], events = [], toasts = [], peers = [], timers = new Map();
  const document = new Element('document'); document.body = new Element('body'); document.append(document.body);
  document.querySelector = selector => document.body.querySelector(selector);
  document.dispatchEvent = event => { events.push(clone(event.detail)); state.dashboards[event.detail.id] = clone(event.detail); };
  const device = { id: 'office', name: 'Office camera', videos: [{ id: 'live', title: 'Live', videoObj: { id: 'office-live' } }], images: [] };
  const state = { dashboards: { board: clone(initial) }, data: { devices: { office: device } }, client: {
    base: 'https://homey.test', async api(method, path, body) {
      calls.push({ method, path, ...(body ? { body: clone(body) } : {}) });
      assert.equal(path, '/api/manager/dashboards/dashboard/board');
      if (method === 'GET') return clone(server);
      assert.equal(method, 'PUT');
      if (denied) throw Object.assign(Error('Forbidden'), { status: 403 });
      server = { ...server, ...clone(body) }; return clone(server);
    },
  } };
  const icons = ['BELL_ICON', 'CHECK_ICON', 'CHEVRON_LEFT', 'CHEVRON_RIGHT', 'CLOSE_ICON', 'DASHBOARD_ICON', 'DRAG_ICON', 'PENCIL_ICON',
    'PLAY_ICON', 'PLUS_CIRCLE_ICON', 'SEARCH_ICON', 'SHIELD_ICON', 'COLLAPSE_ICON', 'EXPAND_ICON'];
  const noop = () => {};
  const synthetic = {
    'state.js': { state },
    'data.js': { loadData: async () => ({ data: {}, errors: {} }) },
    'devices.js': { deviceIcon: () => new Element(), isClass: () => false, findDevice: () => device },
    'dom.js': { el: (...args) => new Element(...args), maskIcon: () => new Element(), toast: text => toasts.push(text), note: () => {} },
    'icons.js': Object.fromEntries(icons.map(name => [name, ''])),
    'mood-orb.js': { moodOrb: () => new Element() },
    'widgets/note.js': { NOTE_COLORS: { yellow: '#ffee55' } },
    'widgets/sensors.js': { sensorStyle: () => ({}) },
    'widget-modes.js': { WIDGET_MODES: [], canChooseWidgetMode: () => false, widgetMode: () => 'sandboxed',
      saveWidgetMode: () => assert.fail('camera settings must not create app-specific preferences') },
    'zones.js': { zoneIcon: () => new Element(), zoneOrder: () => [] },
    'embedded.js': { isDashboardVisible: () => true, subscribeDashboardVisibility: () => noop },
  };
  let timerId = 0;
  class Peer extends Element {
    constructor() { super(); this.closed = false; peers.push(this); }
    addTransceiver() {}
    createOffer() { return new Promise(() => {}); }
    close() { this.closed = true; }
  }
  const context = vm.createContext({ document, structuredClone, console, AbortController, RTCPeerConnection: Peer,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearInterval: id => timers.delete(id),
  });
  const modules = new Map();
  function load(name) {
    if (!modules.has(name)) {
      const module = sources.has(name) ? new vm.SourceTextModule(sources.get(name), { context, identifier: name })
        : new vm.SyntheticModule(Object.keys(synthetic[name] ?? {}), function () {
          assert.ok(synthetic[name], `unexpected editor dependency ${name}`);
          for (const [key, value] of Object.entries(synthetic[name])) this.setExport(key, value);
        }, { context, identifier: name });
      modules.set(name, module);
    }
    return modules.get(name);
  }
  async function ready(name) {
    const module = load(name);
    if (module.status === 'unlinked') await module.link((specifier, referring) => {
      const resolved = new URL(specifier, `https://fixture/${referring.identifier}`).pathname.slice(1);
      return load(resolved);
    });
    if (module.status !== 'evaluated') await module.evaluate();
    return module.namespace;
  }
  const editor = await ready('sheets/widget-settings.js');
  return {
    state, document, calls, events, toasts, peers, timers,
    get server() { return server; },
    deny(value) { denied = value; },
    editServer(mutate) { mutate(server); },
    async open() {
      await editor.openWidgetSettings('board', state.dashboards.board.columns[0].widgets[0], 'Office');
      return document.querySelector('dialog.widget-settings');
    },
    control(dialog, label) { return dialog.find(node => node.getAttribute('aria-label') === label); },
    async mountSavedCamera() {
      const camera = await ready('widgets/camera-live.js');
      const body = new Element();
      const cleanup = camera.mountCameraLive({ body, widget: clone(server.columns[0].widgets[0]) });
      return { body, cleanup };
    },
  };
}

test('live camera edit saves the native autoplay choice, preserves mobile changes, and reopens with it', async () => {
  const h = await harness();
  const dialog = await h.open();
  const toggle = h.control(dialog, 'Auto start stream');
  assert.equal(toggle.getAttribute('role'), 'switch');
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  await toggle.click();
  assert.equal(h.calls.length, 0, 'changing the draft does not start a stream or save prematurely');
  h.editServer(server => {
    server.name = 'Renamed on mobile';
    server.columns[0].widgets[0].titleHidden = true;
    server.columns[0].widgets[0].data.mobileChange = 'preserved';
  });
  await h.control(dialog, 'Save').click();
  assert.equal(dialog.open, false);
  assert.equal(h.server.columns[0].widgets[0].data.autoplay, true);
  assert.equal(h.server.columns[0].widgets[0].data.mobileChange, 'preserved');
  assert.equal(h.server.columns[0].widgets[0].titleHidden, true, 'an autoplay edit does not overwrite a newer mobile title choice');
  assert.equal(h.server.name, 'Renamed on mobile');
  assert.deepEqual(h.server.columns[0].widgets[1], { id: 'other', type: 'future_mobile_widget', data: { untouched: true } });
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'PUT']);
  assert.deepEqual(Object.keys(h.calls[1].body), ['columns']);
  assert.equal(h.control(await h.open(), 'Auto start stream').getAttribute('aria-checked'), 'true');
});

test('saving false uses the same field that makes actual camera playback wait for a click', async () => {
  const h = await harness({ autoplay: true });
  const dialog = await h.open();
  await h.control(dialog, 'Auto start stream').click();
  await h.control(dialog, 'Save').click();
  assert.equal(h.server.columns[0].widgets[0].data.autoplay, false);
  const manual = await h.mountSavedCamera();
  assert.equal(h.peers.length, 0);
  assert.equal(manual.body.find(node => node.className === 'camera-status').textContent, 'Play live video');
  manual.cleanup();
  const reopened = await h.open();
  await h.control(reopened, 'Auto start stream').click();
  await h.control(reopened, 'Save').click();
  const automatic = await h.mountSavedCamera();
  assert.equal(h.peers.length, 1, 'saving true enables the existing automatic camera path');
  automatic.cleanup();
  assert.equal(h.peers[0].closed, true);
  assert.equal(h.timers.size, 0);
});

test('an omitted autoplay value stays enabled and remains omitted after a round trip or another setting saves', async () => {
  const h = await harness({ omitAutoplay: true });
  const dialog = await h.open();
  assert.equal(h.control(dialog, 'Auto start stream').getAttribute('aria-checked'), 'true');
  await h.control(dialog, 'Auto start stream').click();
  await h.control(dialog, 'Auto start stream').click();
  await h.control(dialog, 'Show Title').click();
  assert.equal(h.control(dialog, 'Auto start stream').getAttribute('aria-checked'), 'true', 'page rerender retains the chosen effective value');
  await h.control(dialog, 'Save').click();
  assert.equal(Object.hasOwn(h.server.columns[0].widgets[0].data, 'autoplay'), false);
  assert.equal(h.server.columns[0].widgets[0].titleHidden, true);
});

test('closing a camera edit cancels the draft and reopening reads the saved native setting', async () => {
  const h = await harness();
  const dialog = await h.open();
  await h.control(dialog, 'Auto start stream').click();
  await h.control(dialog, 'Close').click();
  assert.equal(h.calls.length, 0);
  assert.equal(h.server.columns[0].widgets[0].data.autoplay, false);
  assert.equal(h.control(await h.open(), 'Auto start stream').getAttribute('aria-checked'), 'false');
});

test('snapshot and app widgets do not acquire a live-camera autoplay control or alter their data', async () => {
  for (const type of ['device_camera_snapshot', 'app_webview']) {
    const h = await harness({ type });
    const original = clone(h.server);
    const dialog = await h.open();
    assert.equal(h.control(dialog, 'Auto start stream'), undefined);
    await h.control(dialog, 'Save').click();
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.server, original);
  }
});

test('a refused save keeps the camera draft open and a later authorized retry saves exactly that choice', async () => {
  const h = await harness(); h.deny(true);
  const dialog = await h.open();
  await h.control(dialog, 'Auto start stream').click();
  await h.control(dialog, 'Save').click();
  assert.equal(dialog.open, true);
  assert.equal(h.server.columns[0].widgets[0].data.autoplay, false);
  assert.match(h.toasts[0], /Dashboards permission/);
  assert.equal(h.control(dialog, 'Auto start stream').getAttribute('aria-checked'), 'true');
  h.deny(false);
  await h.control(dialog, 'Save').click();
  assert.equal(dialog.open, false);
  assert.equal(h.server.columns[0].widgets[0].data.autoplay, true);
});
