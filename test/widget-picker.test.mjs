import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const catalogSource = await readFile(new URL('../assets/web/js/widget-catalog.js', import.meta.url), 'utf8');
const pickerSource = await readFile(new URL('../assets/web/js/sheets/widget-picker.js', import.meta.url), 'utf8');
const clone = value => structuredClone(value);

class Element {
  constructor(tag = 'div', className = '', text = '') {
    this.tagName = tag; this.className = className ?? ''; this._text = text; this.children = []; this.attributes = new Map();
    this.listeners = new Map(); this.open = false; this.value = ''; this.hidden = false;
  }
  get textContent() { return String(this._text ?? '') + this.children.map(node => node.textContent ?? node).join(''); }
  set textContent(value) { this._text = value; this.replaceChildren(); }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parent = this; } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); }
  async emit(name, extra = {}) { await Promise.all((this.listeners.get(name) ?? []).map(fn => fn({ target: this, ...extra }))); }
  click() { return this.emit('click'); }
  insertAdjacentHTML() {}
  showModal() { this.open = true; }
  close() { this.open = false; return this.emit('close'); }
  find(predicate) { if (predicate(this)) return this; return this.children.map(child => child.find?.(predicate)).find(Boolean); }
}

async function catalog() {
  const context = vm.createContext({ crypto: webcrypto, Uint8Array, structuredClone });
  const module = new vm.SourceTextModule(catalogSource, { context });
  await module.link(() => assert.fail('catalog must not perform external requests'));
  await module.evaluate();
  return module.namespace;
}

async function harness({ allowed = true, load = async () => ({ data: {}, errors: {} }) } = {}) {
  const document = { body: new Element('body') };
  document.querySelector = selector => selector === 'dialog.widget-settings'
    ? document.body.find(node => node.tagName === 'dialog' && node.className.split(' ').includes('widget-settings')) ?? null : null;
  const state = { client: { name: 'original' }, data: {} };
  const calls = [], opened = [], toasts = [];
  const mocks = {
    '../dashboard-save.js': { NO_EDIT_PERMISSION: 'View only', canEditDashboards: () => allowed,
      addDashboardWidget: async (...args) => { calls.push(clone(args)); return { id: 'board', saved: true }; } },
    '../data.js': { loadData: keys => load(keys) },
    '../dom.js': { el: (...args) => new Element(...args), toast: text => toasts.push(text) },
    '../icons.js': { CHEVRON_RIGHT: '', CLOSE_ICON: '', SEARCH_ICON: '' },
    '../state.js': { state },
    './widget-settings.js': { openWidgetSettings: async (...args) => { opened.push(args); } },
  };
  const context = vm.createContext({ crypto: webcrypto, Uint8Array, structuredClone, document });
  const actualCatalog = new vm.SourceTextModule(catalogSource, { context });
  const picker = new vm.SourceTextModule(pickerSource, { context });
  await picker.link(specifier => {
    if (specifier === '../widget-catalog.js') return actualCatalog;
    assert.ok(mocks[specifier], specifier);
    return new vm.SyntheticModule(Object.keys(mocks[specifier]), function () {
      for (const [key, value] of Object.entries(mocks[specifier])) this.setExport(key, value);
    }, { context });
  });
  await picker.evaluate();
  return {
    state, calls, opened, toasts, document,
    open: () => picker.namespace.openWidgetPicker('board', 'column'),
    get dialog() { return document.querySelector('dialog.widget-settings'); },
    row(name) { return document.body.find(node => node.tagName === 'button' && node.className.includes('widget-picker-item') && node.textContent === name); },
  };
}

test('the creation catalogue covers the registered built-in renderers and creates independent native UUID entries', async () => {
  const api = await catalog();
  const renderer = await readFile(new URL('../assets/web/js/widgets/index.js', import.meta.url), 'utf8');
  const registered = [...renderer.slice(renderer.indexOf('export const WIDGETS =')).matchAll(/^  ([a-z_]+):/gm)].map(match => match[1]);
  assert.deepEqual([...api.WIDGET_CATALOG].map(entry => entry.type).sort(), registered.filter(type => type !== 'app_webview').sort());
  const entry = api.WIDGET_CATALOG.find(candidate => candidate.type === 'devices_custom');
  const first = api.createWidgetDraft(entry), second = api.createWidgetDraft(entry);
  assert.match(first.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(first.id, second.id);
  first.data.deviceIds.push('one');
  assert.deepEqual(clone(second.data), { deviceIds: [] });
  assert.deepEqual(clone(entry.data), { deviceIds: [] });
  assert.equal(first.titleModified, false);
});

test('app widget drafts use registered definition IDs, independent declared settings, and fresh instance identities', async () => {
  const api = await catalog();
  const definitions = { okay: { id: 'registered', ownerUri: 'homey:app:example.app', ownerId: 'clock', name: 'Clock',
    settings: [{ id: 'color', value: { name: 'Blue' } }, { id: 'unset' }] }, bad: { id: 'bad', ownerUri: 'https://example.test', ownerId: 'unknown' },
    old: { id: 'old', ownerUri: 'homey:app:example.app', ownerId: 'old', deprecated: true } };
  const entries = api.appWidgetEntries(definitions);
  assert.equal(entries.length, 1);
  const draft = api.createWidgetDraft(entries[0]);
  assert.equal(draft.type, 'app_webview');
  assert.equal(draft.data.appWidgetId, 'registered');
  draft.data.settings.color.name = 'Red';
  assert.equal(definitions.okay.settings[0].value.name, 'Blue');
  assert.equal(entries[0].data.settings.color.name, 'Blue');
});

test('searching and choosing a widget opens an unsaved settings draft; only its Add callback writes', async () => {
  const view = await harness();
  await view.open();
  const search = view.dialog.find(node => node.getAttribute('aria-label') === 'Search widgets');
  search.value = 'camera';
  await search.emit('input');
  assert.ok(view.row('Live camera'));
  assert.ok(view.row('Camera snapshot'));
  assert.equal(view.row('Favorite devices'), undefined);
  const selected = view.row('Live camera');
  await selected.click();
  await selected.click();
  assert.equal(view.opened.length, 1);
  assert.equal(view.calls.length, 0);
  const [dashboardId, widget, name, options] = view.opened[0];
  assert.equal(dashboardId, 'board');
  assert.equal(name, 'Live camera');
  assert.equal(options.creating, true);
  assert.equal(options.actionLabel, 'Add widget');
  assert.equal(widget.data.autoplay, false, 'new battery camera widgets do not start without a deliberate play choice');
  const result = await options.onSave({ ...widget, data: { ...widget.data, deviceId: 'camera', deviceVideoId: 'main' } });
  assert.deepEqual(result, { id: 'board', saved: true });
  assert.equal(view.calls.length, 1);
  assert.deepEqual(view.calls[0].slice(0, 2), ['board', 'column']);
});

test('cancel and view-only permission create no widgets or settings drafts', async () => {
  const view = await harness();
  await view.open();
  await view.dialog.find(node => node.getAttribute('aria-label') === 'Close').click();
  assert.equal(view.dialog, null);
  assert.equal(view.opened.length, 0);
  assert.equal(view.calls.length, 0);
  const denied = await harness({ allowed: false });
  await denied.open();
  assert.equal(denied.dialog, null);
  assert.deepEqual(denied.toasts, ['View only']);
});

test('late app-widget inventory cannot update another connection or reopen a cancelled picker', async () => {
  let finish;
  const view = await harness({ load: () => new Promise(resolve => { finish = resolve; }) });
  const opening = view.open();
  view.state.client = { name: 'replacement' };
  finish({ data: { appWidgets: { secret: { id: 'one', ownerUri: 'homey:app:one', ownerId: 'one' } } }, errors: {} });
  await opening;
  assert.deepEqual(view.state.data, {});
  assert.equal(view.row('one'), undefined);
  await view.row('Live camera').click();
  assert.equal(view.opened.length, 0);
});

test('registered app widgets are listed and the draft callback refuses a replacement connection', async () => {
  const view = await harness({ load: async () => ({ data: { appWidgets: { a: { id: 'clock', ownerUri: 'homey:app:clock.app', ownerId: 'clock', name: 'My clock' } } }, errors: {} }) });
  await view.open();
  await view.row('My clock').click();
  assert.equal(view.opened[0][1].data.appWidgetId, 'clock');
  view.state.client = { name: 'replacement' };
  await assert.rejects(view.opened[0][3].onSave(view.opened[0][1]), /connection changed/);
  assert.equal(view.calls.length, 0);
});
