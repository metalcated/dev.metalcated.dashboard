import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/web/js/layout-drag.js', import.meta.url), 'utf8');
const clone = (value) => structuredClone(value);
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
};

async function harness({ editing = true, editable = true, save = async () => {} } = {}) {
  const listeners = new Map();
  const windowListeners = new Map();
  const frames = new Map();
  const observers = [];
  const moves = [];
  const toasts = [];
  const scrolls = [];
  let frameId = 0;
  const document = { activeElement: null, visibilityState: 'visible' };
  const addListener = (collection, type, listener) => {
    if (!collection.has(type)) collection.set(type, new Set());
    collection.get(type).add(listener);
  };
  class Element {
    constructor(tagName = 'div', className = '', text = '') {
      this.tagName = tagName;
      this.className = className;
      this.textContent = text;
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this.attributes = new Map();
      this.style = {};
      this.hidden = false;
      this.scrollLeft = 0;
      this.pointerCapture = null;
      this.rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
      this.classList = {
        add: (name) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), name])].join(' '); },
        remove: (name) => { this.className = this.className.split(/\s+/).filter((entry) => entry !== name).join(' '); },
        contains: (name) => this.className.split(/\s+/).includes(name),
      };
    }
    get isConnected() { return this === document.documentElement || Boolean(this.parentElement?.isConnected); }
    append(...nodes) { for (const node of nodes) { node.remove(); this.children.push(node); node.parentElement = this; } }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
      this.parentElement = null;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    matches(selector) {
      if (selector === 'dialog[open]') return this.tagName === 'dialog' && this.open;
      if (selector === '.widget[data-widget-id]') return this.classList.contains('widget') && this.dataset.widgetId != null;
      if (selector === '.column[data-column-id]') return this.classList.contains('column') && this.dataset.columnId != null;
      return selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : this.tagName === selector;
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    focus() { document.activeElement = this; }
    setPointerCapture(id) { this.pointerCapture = id; }
    hasPointerCapture(id) { return this.pointerCapture === id; }
    releasePointerCapture() { this.pointerCapture = null; }
    getBoundingClientRect() { return { ...this.rect }; }
    scrollIntoView(options) { scrolls.push({ node: this, options }); }
  }
  const rect = (element, left, top, width, height) => { element.rect = { left, top, width, height, right: left + width, bottom: top + height }; return element; };
  document.documentElement = new Element('html');
  document.body = new Element('body'); document.documentElement.append(document.body);
  const board = rect(new Element('main'), 20, 100, 768, 650);
  document.body.append(board);
  document.querySelector = (selector) => document.documentElement.querySelector(selector);
  document.getElementById = (id) => id === 'board' ? board : document.documentElement.querySelectorAll('div').find((node) => node.id === id) ?? null;
  document.addEventListener = (type, handler) => addListener(listeners, type, handler);
  document.removeEventListener = (type, handler) => listeners.get(type)?.delete(handler);
  const window = {
    innerWidth: 1000, innerHeight: 800,
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    scrollBy(x, y) { scrolls.push({ x, y }); },
    addEventListener: (type, handler) => addListener(windowListeners, type, handler),
    removeEventListener: (type, handler) => windowListeners.get(type)?.delete(handler),
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const state = { client: { id: 'current' }, dashboardId: 'board', highlighted: null, dashboards: {
    board: { id: 'board', name: 'Board', columns: [
      { id: 'one', widgets: [{ id: 'a', title: 'Weather', type: 'weather' }, { id: 'b', title: 'Camera', type: 'device_camera_live' }] },
      { id: 'two', widgets: [{ id: 'c', title: 'Batteries', type: 'batteries_devices' }] },
      { id: 'three', widgets: [] },
    ] },
  } };
  const nodes = new Map();
  for (const [columnIndex, column] of state.dashboards.board.columns.entries()) {
    const left = 20 + columnIndex * 264;
    const columnNode = rect(new Element('div', 'column'), left, 100, 240, 600);
    columnNode.dataset.columnId = column.id;
    board.append(columnNode); nodes.set(column.id, columnNode);
    for (const [index, widget] of column.widgets.entries()) {
      const section = rect(new Element('section', 'widget'), left, 160 + index * 124, 240, 100);
      section.dataset.widgetId = widget.id; section.dataset.dashboardId = 'board';
      const title = new Element('h2', 'widget-title', widget.title);
      const media = new Element(widget.id === 'b' ? 'video' : 'div', 'media');
      const handle = rect(new Element('button', 'widget-drag-handle'), left, 160 + index * 124, 40, 40);
      section.append(title, media, handle); columnNode.append(section);
      nodes.set(widget.id, section); nodes.set(`handle-${widget.id}`, handle); nodes.set(`media-${widget.id}`, media);
    }
    const add = rect(new Element('button', 'column-add-widget'), left, 160 + column.widgets.length * 124, 240, 60);
    columnNode.append(add);
  }
  const imports = {
    './dashboard-save.js': { canEditDashboards: () => editable, moveDashboardWidget: async (...args) => { moves.push(args); return save(...args); } },
    './dom.js': { el: (...args) => new Element(...args), toast: (message) => toasts.push(message) },
    './state.js': { state },
  };
  const context = vm.createContext({ document, window, MutationObserver, Math });
  const module = new vm.SourceTextModule(source, { context });
  await module.link((specifier) => new vm.SyntheticModule(Object.keys(imports[specifier]), function () {
    for (const [key, value] of Object.entries(imports[specifier])) this.setExport(key, value);
  }, { context }));
  await module.evaluate();
  const controller = module.namespace.initLayoutDrag({ isEditing: () => editing });
  const emit = async (type, options = {}) => {
    const event = { type, target: nodes.get('handle-a'), button: 0, isPrimary: true, pointerId: 5, clientX: 40, clientY: 180,
      defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...options };
    await Promise.all([...(listeners.get(type) ?? [])].map((handler) => handler(event)));
    return event;
  };
  return { state, nodes, document, window, board, controller, moves, toasts, scrolls, frames, observers, emit,
    setEditing(on) { editing = on; }, setEditable(on) { editable = on; },
    mutate() { for (const observer of observers) if (!observer.disconnected) observer.callback([]); },
    frame() { const [id, callback] = frames.entries().next().value ?? []; if (callback) { frames.delete(id); callback(); } },
    windowEmit(type) { for (const handler of windowListeners.get(type) ?? []) handler(); },
    live: () => document.getElementById('layout-drag-status')?.textContent,
    count: (selector) => document.querySelector(selector) == null ? 0 : document.documentElement.querySelectorAll(selector).length,
  };
}

test('pointer movement snaps into a native empty column without moving or cloning live widget DOM', async () => {
  const view = await harness();
  const sourceParent = view.nodes.get('a').parentElement;
  const camera = view.nodes.get('media-b');
  await view.emit('pointerdown');
  await view.emit('pointermove', { clientX: 600, clientY: 250 });
  assert.equal(view.controller.isDragging(), true);
  assert.equal(view.nodes.get('a').parentElement, sourceParent);
  assert.equal(view.nodes.get('media-b'), camera);
  assert.equal(view.count('video'), 1, 'the moving label must not clone media elements');
  assert.equal(view.count('.layout-drag-ghost'), 1);
  assert.equal(view.nodes.get('three').classList.contains('is-layout-drop-target'), true);
  assert.deepEqual(view.moves, [], 'pointer motion itself never writes Homey');
  await view.emit('pointerup', { clientX: 600, clientY: 250 });
  assert.deepEqual(view.moves, [['board', 'a', 'three', null]]);
  assert.equal(view.controller.isDragging(), false);
  assert.equal(view.nodes.get('handle-a').pointerCapture, null);
  assert.equal(view.count('.layout-drag-ghost'), 0);
  assert.equal(view.count('.layout-drop-marker'), 0);
  assert.equal(view.nodes.get('a').classList.contains('is-layout-dragging'), false);
  assert.equal(view.live(), 'Weather moved.');
});

test('pointer release hit-tests its latest position and records the before-widget anchor', async () => {
  const view = await harness();
  await view.emit('pointerdown');
  await view.emit('pointermove', { clientX: 600, clientY: 250 });
  await view.emit('pointerup', { clientX: 350, clientY: 170 });
  assert.deepEqual(view.moves, [['board', 'a', 'two', 'c']]);
});

test('a tap, a same-position drop, and an outside-board drop do not save', async () => {
  const view = await harness();
  await view.emit('pointerdown'); await view.emit('pointerup');
  await view.emit('pointerdown'); await view.emit('pointermove', { clientX: 60, clientY: 190 }); await view.emit('pointerup', { clientX: 60, clientY: 190 });
  await view.emit('pointerdown'); await view.emit('pointermove', { clientX: 900, clientY: 190 }); await view.emit('pointerup', { clientX: 900, clientY: 190 });
  assert.deepEqual(view.moves, []);
  assert.equal(view.count('.layout-drop-marker'), 0);
  assert.equal(view.frames.size, 0);
});

test('touch and mouse use the same pointer path while secondary pointers and widget content are left alone', async () => {
  const view = await harness();
  for (const options of [{ button: 2 }, { isPrimary: false }, { target: view.nodes.get('media-b') }]) {
    const event = await view.emit('pointerdown', options);
    assert.equal(event.defaultPrevented, false);
    assert.equal(view.controller.isDragging(), false);
  }
  await view.emit('pointerdown', { pointerType: 'touch' });
  await view.emit('pointermove', { pointerType: 'touch', pointerId: 9, clientX: 600, clientY: 250 });
  assert.equal(view.count('.layout-drag-ghost'), 0, 'an unrelated pointer must not move the gesture');
  await view.emit('pointermove', { pointerType: 'touch', clientX: 350, clientY: 350 });
  await view.emit('pointerup', { pointerType: 'touch', clientX: 350, clientY: 350 });
  assert.deepEqual(view.moves, [['board', 'a', 'two', null]]);
});

test('Escape and pointer cancellation remove indicators and do not save', async () => {
  for (const type of ['pointercancel', 'lostpointercapture', 'keydown']) {
    const view = await harness();
    await view.emit('pointerdown'); await view.emit('pointermove', { clientX: 600, clientY: 250 });
    await view.emit(type, type === 'keydown' ? { key: 'Escape' } : {});
    assert.deepEqual(view.moves, []);
    assert.equal(view.count('.layout-drag-ghost'), 0);
    assert.equal(view.count('.layout-drop-marker'), 0);
    assert.equal(view.controller.isDragging(), false);
    assert.equal(view.document.activeElement, view.nodes.get('handle-a'));
  }
});

test('keyboard movement uses native positions and announces its intended column', async () => {
  const view = await harness();
  const pickup = await view.emit('keydown', { key: ' ' });
  assert.equal(pickup.defaultPrevented, true);
  assert.match(view.live(), /Column 1, position 1/);
  await view.emit('keydown', { key: 'ArrowDown' });
  assert.match(view.live(), /Column 1, position 2/);
  await view.emit('keydown', { key: 'ArrowRight' });
  assert.match(view.live(), /Column 2, position 2/);
  assert.deepEqual(view.moves, []);
  await view.emit('keydown', { key: 'Enter' });
  assert.deepEqual(view.moves, [['board', 'a', 'two', null]]);
  assert.equal(view.nodes.get('handle-a').getAttribute('aria-pressed'), 'false');
});

test('keyboard pickup without a move is a no-op and Tab cancels without hijacking normal focus navigation', async () => {
  const view = await harness();
  await view.emit('keydown', { key: 'Enter' }); await view.emit('keydown', { key: 'Enter' });
  assert.deepEqual(view.moves, []);
  await view.emit('keydown', { key: 'Enter' });
  const tab = await view.emit('keydown', { key: 'Tab' });
  assert.equal(tab.defaultPrevented, false);
  assert.equal(view.controller.isDragging(), false);
  await view.emit('keydown', { key: 'Enter' });
  const input = { closest: () => null };
  view.document.activeElement = input;
  const typing = await view.emit('keydown', { target: input, key: 'ArrowLeft' });
  assert.equal(typing.defaultPrevented, false);
  assert.equal(view.document.activeElement, input, 'leaving a drag must not steal focus from another input');
  assert.equal(view.controller.isDragging(), false);
  assert.deepEqual(view.moves, []);
});

test('read-only, locked layouts, highlighted widgets, and open dialogs cannot start a drag', async () => {
  for (const state of ['read-only', 'locked', 'highlighted', 'modal']) {
    const view = await harness({ editing: state !== 'locked', editable: state !== 'read-only' });
    if (state === 'highlighted') view.state.highlighted = { id: 'a' };
    if (state === 'modal') {
      const dialog = { tagName: 'dialog', open: true, matches: (selector) => selector === 'dialog[open]', querySelectorAll: () => [], remove() {} };
      view.document.body.append(dialog);
    }
    await view.emit('pointerdown'); await view.emit('keydown', { key: 'Enter' });
    assert.equal(view.controller.isDragging(), false, state);
    assert.deepEqual(view.moves, []);
  }
});

test('connection, dashboard, permission, highlight, source removal, and Done changes cancel before saving', async () => {
  for (const mutate of [
    (view) => { view.state.client = {}; },
    (view) => { view.state.dashboardId = 'another'; },
    (view) => { view.setEditable(false); },
    (view) => { view.setEditing(false); },
    (view) => { view.state.highlighted = { id: 'a' }; },
    (view) => { view.nodes.get('a').remove(); },
    (view) => { view.state.dashboards.board.columns[0].widgets.shift(); },
  ]) {
    const view = await harness();
    await view.emit('pointerdown'); await view.emit('pointermove', { clientX: 600, clientY: 250 });
    mutate(view); view.mutate();
    await view.emit('pointerup', { clientX: 600, clientY: 250 });
    assert.deepEqual(view.moves, []);
    assert.equal(view.controller.isDragging(), false);
    assert.equal(view.count('.layout-drag-ghost'), 0);
  }
});

test('a vanished insertion anchor cancels rather than saving against a stale position', async () => {
  const view = await harness();
  await view.emit('keydown', { key: 'Enter' }); await view.emit('keydown', { key: 'ArrowRight' });
  view.state.dashboards.board.columns[1].widgets = [];
  await view.emit('keydown', { key: 'Enter' });
  assert.deepEqual(view.moves, []);
  assert.equal(view.controller.isDragging(), false);
});

test('opening a modal during a keyboard move cancels its indicators without saving', async () => {
  const view = await harness();
  await view.emit('keydown', { key: 'Enter' });
  const dialog = { tagName: 'dialog', open: true, matches: (selector) => selector === 'dialog[open]', querySelectorAll: () => [], remove() {} };
  view.document.body.append(dialog);
  view.mutate();
  assert.equal(view.controller.isDragging(), false);
  assert.equal(view.count('.layout-drop-marker'), 0);
  assert.deepEqual(view.moves, []);
});

test('pending drops prevent duplicate moves and a failure leaves the original media DOM available for retry', async () => {
  const pending = deferred();
  const view = await harness({ save: () => pending.promise });
  const parent = view.nodes.get('a').parentElement;
  await view.emit('keydown', { key: 'Enter' }); await view.emit('keydown', { key: 'ArrowRight' });
  const dropping = view.emit('keydown', { key: 'Enter' });
  await view.emit('keydown', { key: 'Enter' });
  assert.equal(view.moves.length, 1);
  assert.equal(view.controller.isDragging(), false);
  assert.equal(view.nodes.get('a').parentElement, parent);
  pending.reject(new Error('Homey refused this move.')); await dropping;
  assert.deepEqual(view.toasts, ['Homey refused this move.']);
  assert.equal(view.live(), 'Homey refused this move.');
  await view.emit('keydown', { key: 'Enter' });
  assert.equal(view.controller.isDragging(), true, 'a refused save must leave the editor usable');
  view.controller.cancel();
});

test('late move completion from an old connection cannot focus or announce in its replacement', async () => {
  const pending = deferred();
  const view = await harness({ save: () => pending.promise });
  await view.emit('keydown', { key: 'Enter' }); await view.emit('keydown', { key: 'ArrowRight' });
  const dropping = view.emit('keydown', { key: 'Enter' });
  view.state.client = {};
  pending.resolve({ id: 'board' }); await dropping;
  assert.equal(view.live(), 'Saving Weather…');
  assert.deepEqual(view.toasts, []);
});

test('edge scrolling is bounded to an active drag and all observers/listeners stop on destroy', async () => {
  const view = await harness();
  await view.emit('pointerdown'); await view.emit('pointermove', { clientX: 780, clientY: 250 });
  const before = view.board.scrollLeft;
  view.frame();
  assert.ok(view.board.scrollLeft > before);
  view.controller.destroy();
  assert.equal(view.frames.size, 0);
  assert.equal(view.count('.layout-drag-status'), 0);
  assert.equal(view.observers.every((observer) => observer.disconnected), true);
  const click = await view.emit('pointerdown');
  assert.equal(click.defaultPrevented, false);
  assert.equal(view.controller.isDragging(), false);
});

test('window blur and hiding the page cancel a gesture without changing a layout', async () => {
  const view = await harness();
  await view.emit('pointerdown'); await view.emit('pointermove', { clientX: 600, clientY: 250 });
  view.windowEmit('blur');
  assert.equal(view.controller.isDragging(), false);
  await view.emit('pointerdown'); await view.emit('pointermove', { clientX: 600, clientY: 250 });
  view.document.visibilityState = 'hidden'; await view.emit('visibilitychange');
  assert.equal(view.controller.isDragging(), false);
  assert.deepEqual(view.moves, []);
});
