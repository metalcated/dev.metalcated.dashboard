import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const sources = new Map(await Promise.all(['layout-resize.js', 'widget-sizes.js'].map(async (name) => [
  name, await readFile(new URL(`../assets/web/js/${name}`, import.meta.url), 'utf8'),
])));
const clone = (value) => structuredClone(value);
const deferred = () => { let resolve; let reject; const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse; }); return { promise, resolve, reject }; };

async function harness({ stored = { width: 240, height: 180 }, save = async () => {}, editable = true, editing = true,
  columnWidth = 360, innerWidth = columnWidth } = {}) {
  const listeners = new Map(), windowListeners = new Map(), frames = new Map(), subscriptions = [], observers = [];
  const writes = [], toasts = [], started = [];
  let frameId = 0, server = stored == null ? {} : { camera: clone(stored) };
  const document = { activeElement: null, visibilityState: 'visible' };
  class Element {
    constructor(tagName = 'div', className = '', text = '') {
      this.tagName = tagName; this.className = className; this.textContent = text; this.children = []; this.parentElement = null;
      this.dataset = {}; this.attributes = new Map(); this.styles = new Map(); this.rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
      this.classList = { add: (name) => { if (!this.className.split(' ').includes(name)) this.className += ` ${name}`; },
        remove: (name) => { this.className = this.className.split(' ').filter((value) => value !== name).join(' '); },
        contains: (name) => this.className.split(' ').includes(name),
        toggle: (name, on) => on ? this.classList.add(name) : this.classList.remove(name) };
      this.style = { setProperty: (name, value) => this.styles.set(name, value), removeProperty: (name) => this.styles.delete(name) };
      this.style = new Proxy(this.style, { set: (target, name, value) => { target[name] = value; return true; } });
    }
    get isConnected() { return this === document.documentElement || Boolean(this.parentElement?.isConnected); }
    append(...nodes) { for (const node of nodes) { node.remove(); this.children.push(node); node.parentElement = this; } }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this); this.parentElement = null; }
    matches(selector) {
      if (selector === 'dialog[open]') return this.tagName === 'dialog' && this.open;
      if (selector === '.widget[data-widget-id]') return this.classList.contains('widget') && this.dataset.widgetId;
      if (selector === '.column[data-column-id]') return this.classList.contains('column') && this.dataset.columnId;
      return selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : this.tagName === selector;
    }
    querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
    contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return { ...this.rect }; }
    setPointerCapture(id) { this.pointerCapture = id; }
    hasPointerCapture(id) { return this.pointerCapture === id; }
    releasePointerCapture() { this.pointerCapture = null; }
  }
  const rect = (node, left, top, width, height) => { node.rect = { left, top, width, height, right: left + width, bottom: top + height }; return node; };
  document.documentElement = new Element('html'); document.body = new Element('body'); document.documentElement.append(document.body);
  const board = rect(new Element('main'), 20, 100, 760, 650); board.scrollLeft = 0;
  const column = rect(new Element('div', 'column'), 20, 100, columnWidth, 650); column.dataset.columnId = 'column';
  const section = rect(new Element('section', 'widget'), 20, 160, stored ? stored.width / 360 * innerWidth : innerWidth, stored?.height ?? 180);
  section.dataset.widgetId = 'camera'; section.dataset.dashboardId = 'board';
  const body = rect(new Element('div', 'widget-body'), 20, 190, stored?.width ?? 360, stored?.height ?? 180);
  const media = new Element('video'); body.append(media);
  const title = new Element('h2', 'widget-title', 'Office'); const handle = new Element('button', 'widget-resize-handle');
  const addWidget = rect(new Element('button', 'column-add-widget'), 32, 500, innerWidth, 60);
  section.append(title, body, handle); column.append(section, addWidget); board.append(column); document.body.append(board);
  document.querySelector = (selector) => document.documentElement.querySelector(selector);
  document.getElementById = (id) => id === 'board' ? board : document.documentElement.querySelectorAll('div').find((node) => node.id === id) ?? null;
  const add = (map, type, handler) => { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(handler); };
  document.addEventListener = (type, handler) => add(listeners, type, handler);
  document.removeEventListener = (type, handler) => listeners.get(type)?.delete(handler);
  const window = { innerWidth: 1000, innerHeight: 800, scrollBy() {},
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener: (type, handler) => add(windowListeners, type, handler), removeEventListener: (type, handler) => windowListeners.get(type)?.delete(handler) };
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {} disconnect() { this.disconnected = true; }
  }
  const state = { config: {}, client: { token: 'fixture', async api(method, path, data) {
    if (method === 'GET') return clone(server);
    writes.push({ method, path, body: clone(data) });
    await save(method, path, data);
    if (data.size == null) delete server.camera; else server.camera = clone(data.size);
    return clone(server);
  } }, dashboardId: 'board', highlighted: null, dashboards: { board: { columns: [{ id: 'column', widgets: [{ id: 'camera', type: 'device_camera_live' }] }] } } };
  const synthetic = {
    'config.js': { APP_ID: 'dev.schweiger.dashboard' },
    'dashboard-save.js': { NO_EDIT_PERMISSION: 'Read-only.', canEditDashboards: () => editable },
    'dom.js': { el: (...args) => new Element(...args), toast: (message) => toasts.push(message) },
    'state.js': { state }, 'realtime.js': { subscribe(uri, event, callback) { subscriptions.push(callback); return () => {}; } },
  };
  const context = vm.createContext({ document, window, MutationObserver, Math });
  const modules = new Map();
  function load(name) {
    if (!modules.has(name)) modules.set(name, sources.has(name) ? new vm.SourceTextModule(sources.get(name), { context, identifier: name })
      : new vm.SyntheticModule(Object.keys(synthetic[name]), function () { for (const [key, value] of Object.entries(synthetic[name])) this.setExport(key, value); }, { context, identifier: name }));
    return modules.get(name);
  }
  const module = load('layout-resize.js');
  await module.link((specifier) => load(specifier.replace('./', ''))); await module.evaluate();
  const sizes = modules.get('widget-sizes.js').namespace;
  await sizes.loadWidgetSizes(); sizes.applyWidgetSize(section, 'camera');
  sizes.watchWidgetSizes(() => sizes.applyWidgetSize(section, 'camera'));
  const controller = module.namespace.initLayoutResize({ isEditing: () => editing, onStart: () => started.push(true) });
  const emit = async (type, options = {}) => {
    const event = { target: handle, pointerId: 4, button: 0, isPrimary: true, clientX: 260, clientY: 370,
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...options };
    await Promise.all([...(listeners.get(type) ?? [])].map((listener) => listener(event))); return event;
  };
  return { controller, state, board, column, section, handle, media, document, sizes, writes, toasts, started, frames, emit,
    live: () => document.getElementById('layout-resize-status')?.textContent,
    mutate() { for (const observer of observers) if (!observer.disconnected) observer.callback([]); },
    remote(size) { for (const callback of subscriptions) callback({ camera: size }); },
    setEditing(value) { editing = value; }, setEditable(value) { editable = value; },
    windowEmit(type) { for (const callback of windowListeners.get(type) ?? []) callback(); },
    count: (selector) => document.documentElement.querySelectorAll(selector).length,
  };
}

test('corner dragging previews snapped dimensions in place and saves only on release', async () => {
  const view = await harness();
  const media = view.media, parent = view.section.parentElement;
  await view.emit('pointerdown'); await view.emit('pointermove', { clientX: 313, clientY: 417, pointerType: 'touch' });
  assert.equal(view.controller.isResizing(), true);
  assert.equal(view.section.styles.get('--web-widget-ratio'), '300 / 220');
  assert.equal(view.media, media); assert.equal(view.section.parentElement, parent);
  assert.equal(view.count('video'), 1);
  assert.equal(view.count('.layout-resize-label'), 1);
  assert.equal(view.writes.length, 0);
  await view.emit('pointerup', { clientX: 313, clientY: 417 });
  assert.deepEqual(view.writes[0].body.size, { width: 300, height: 220 });
  assert.equal(view.writes[0].path, '/api/app/dev.schweiger.dashboard/widget-sizes/camera');
  assert.deepEqual(clone(view.sizes.widgetSize('camera')), { width: 300, height: 220 });
  assert.equal(view.live(), 'Office resized for the web.');
  assert.equal(view.started.length, 1, 'resizing informs the editor to cancel any drag');
  assert.equal(view.count('.layout-resize-label'), 0);
});

test('resizing clamps within the native column and a 20-unit grid at its minimum and maximum dimensions', async () => {
  const view = await harness();
  await view.emit('pointerdown'); await view.emit('pointermove', { clientX: 1600, clientY: 2300 });
  assert.equal(view.section.styles.get('--web-widget-width'), '100%');
  assert.equal(view.section.styles.get('--web-widget-ratio'), '360 / 1440');
  await view.emit('pointerup', { clientX: -100, clientY: -100 });
  assert.deepEqual(view.writes[0].body.size, { width: 120, height: 80 });
});

test('a vertical resize keeps a full-width widget at 360 units when editor padding narrows its column content', async () => {
  const view = await harness({ stored: null, columnWidth: 440, innerWidth: 414 });
  await view.emit('pointerdown');
  await view.emit('pointermove', { clientX: 260, clientY: 420 });
  await view.emit('pointerup', { clientX: 260, clientY: 420 });
  assert.equal(view.writes[0].body.size.width, 360);
  assert.equal(view.section.styles.get('--web-widget-width'), '100%');
});

test('keyboard arrows resize and announce dimensions; Escape restores the last saved style without a write', async () => {
  const view = await harness();
  await view.emit('keydown', { key: 'Enter' });
  await view.emit('keydown', { key: 'ArrowRight' }); await view.emit('keydown', { key: 'ArrowDown' });
  assert.match(view.live(), /260 × 200 px/);
  assert.equal(view.section.styles.get('--web-widget-ratio'), '260 / 200');
  await view.emit('keydown', { key: 'Escape' });
  assert.equal(view.section.styles.get('--web-widget-ratio'), '240 / 180');
  assert.equal(view.writes.length, 0);
  await view.emit('keydown', { key: ' ' }); await view.emit('keydown', { key: 'ArrowLeft' }); await view.emit('keydown', { key: 'Enter' });
  assert.deepEqual(view.writes[0].body.size, { width: 220, height: 180 });
});

test('a tap, no-change keyboard completion, and pointer cancellation do not create a web override', async () => {
  const view = await harness({ stored: null });
  await view.emit('pointerdown'); await view.emit('pointerup');
  await view.emit('keydown', { key: 'Enter' }); await view.emit('keydown', { key: 'Enter' });
  await view.emit('pointerdown'); await view.emit('pointermove', { clientX: 200, clientY: 420 }); await view.emit('pointercancel');
  assert.equal(view.writes.length, 0);
  assert.equal(view.section.classList.contains('has-web-size'), false);
  assert.equal(view.section.styles.size, 0);
});

test('read-only, locked, modal, and highlighted layouts cannot be resized', async () => {
  for (const condition of ['read-only', 'locked', 'highlighted', 'modal']) {
    const view = await harness({ editable: condition !== 'read-only', editing: condition !== 'locked' });
    if (condition === 'highlighted') view.state.highlighted = { id: 'camera' };
    if (condition === 'modal') {
      const original = view.document.querySelector;
      view.document.querySelector = (selector) => selector === 'dialog[open]' ? {} : original(selector);
    }
    await view.emit('pointerdown'); await view.emit('keydown', { key: 'Enter' });
    assert.equal(view.controller.isResizing(), false, condition);
    assert.equal(view.writes.length, 0);
  }
});

test('Done, connection changes, removed widgets, and another browser’s resize cancel stale previews', async () => {
  for (const change of [
    (view) => view.setEditing(false), (view) => { view.state.client = {}; },
    (view) => { view.state.dashboards.board.columns[0].widgets = []; },
    (view) => { view.remote({ width: 320, height: 260 }); },
  ]) {
    const view = await harness();
    await view.emit('pointerdown'); await view.emit('pointermove', { clientX: 300, clientY: 410 });
    change(view); view.mutate();
    assert.equal(view.controller.isResizing(), false);
    assert.equal(view.writes.length, 0);
    assert.equal(view.count('.layout-resize-label'), 0);
  }
});

test('a failed save restores the persisted size, prevents duplicate writes, and permits an explicit retry', async () => {
  const pending = deferred(); let fail = true;
  const view = await harness({ save: () => fail ? pending.promise : Promise.resolve() });
  await view.emit('keydown', { key: 'Enter' }); await view.emit('keydown', { key: 'ArrowRight' });
  const dropping = view.emit('keydown', { key: 'Enter' });
  await view.emit('keydown', { key: 'Enter' });
  await Promise.resolve();
  assert.equal(view.writes.length, 1);
  pending.reject(new Error('Homey refused this web size.')); await dropping;
  assert.equal(view.section.styles.get('--web-widget-ratio'), '240 / 180');
  assert.match(view.toasts.at(-1), /refused/);
  fail = false;
  await view.emit('keydown', { key: 'Enter' }); await view.emit('keydown', { key: 'ArrowDown' }); await view.emit('keydown', { key: 'Enter' });
  assert.equal(view.writes.length, 2);
  assert.equal(view.section.styles.get('--web-widget-ratio'), '240 / 200');
});

test('Tab and typing in other fields cancel a keyboard resize without trapping input focus', async () => {
  const view = await harness();
  await view.emit('keydown', { key: 'Enter' });
  const input = { closest: () => null }; view.document.activeElement = input;
  const event = await view.emit('keydown', { target: input, key: 'ArrowLeft' });
  assert.equal(event.defaultPrevented, false);
  assert.equal(view.document.activeElement, input);
  assert.equal(view.controller.isResizing(), false);
  await view.emit('keydown', { key: 'Enter' });
  const tab = await view.emit('keydown', { key: 'Tab' });
  assert.equal(tab.defaultPrevented, false);
  assert.equal(view.controller.isResizing(), false);
});

test('window blur, viewport changes, and disposal restore styles and release every gesture resource', async () => {
  const view = await harness();
  for (const type of ['blur', 'resize']) {
    await view.emit('pointerdown'); await view.emit('pointermove', { clientX: 300, clientY: 410 });
    view.windowEmit(type);
    assert.equal(view.controller.isResizing(), false);
    assert.equal(view.section.styles.get('--web-widget-ratio'), '240 / 180');
  }
  await view.emit('pointerdown'); await view.emit('pointermove', { clientX: 300, clientY: 410 });
  view.controller.destroy();
  assert.equal(view.frames.size, 0);
  assert.equal(view.count('.layout-resize-label'), 0);
  assert.equal(view.count('.layout-resize-status'), 0);
  assert.equal(view.handle.pointerCapture, null);
  await view.emit('pointerdown');
  assert.equal(view.controller.isResizing(), false);
});
