import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/web/js/column-editor.js', import.meta.url), 'utf8');
const NO_EDIT_PERMISSION = 'This connection can only view dashboards.';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
};
const nativeDashboard = () => ({ id: 'board', name: 'Rooms', columns: [
  { id: 'left', widgets: [{ id: 'camera', type: 'device_camera_live', data: { autoplay: true } }, { id: 'note', type: 'note' }] },
  { id: 'right', widgets: [{ id: 'lamp', type: 'devices_custom' }] },
  { id: 'empty', widgets: [] },
] });

async function harness({ editable = true, read = async () => nativeDashboard(), remove = async () => ({ id: 'board' }) } = {}) {
  const document = { activeElement: null };
  class Element {
    constructor(tag = 'div', className = '', text = '') {
      this.tagName = tag; this.className = className ?? ''; this.textContent = text; this.value = '';
      this.children = []; this.listeners = new Map(); this.attributes = new Map();
      this.hidden = false; this.disabled = false; this.open = false;
    }
    append(...nodes) { for (const node of nodes) { this.children.push(node); node.parent = this; } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); this.parent = null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    emit(type, target = this) {
      const event = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      return { event, completion: Promise.all((this.listeners.get(type) ?? []).map((listener) => listener(event))) };
    }
    click() { return this.disabled ? Promise.resolve() : this.emit('click').completion; }
    showModal() { this.open = true; }
    close() { if (this.open) { this.open = false; return this.emit('close').completion; } }
    focus() { document.activeElement = this; }
    find(predicate) { return predicate(this) ? this : this.children.map((node) => node.find(predicate)).find(Boolean); }
    querySelector(tag) { return this.find((node) => node.tagName === tag) ?? null; }
  }
  document.body = new Element('body');
  const calls = [], removals = [], toasts = [];
  const client = { async api(method, path) { calls.push({ method, path }); return read(); } };
  const state = { client, dashboardId: 'board', dashboards: { board: { id: 'board', columns: [] } } };
  const imports = {
    './dashboard-save.js': {
      NO_EDIT_PERMISSION, canEditDashboards: () => editable,
      removeDashboardColumn(...args) { removals.push(structuredClone(args)); return remove(...args); },
    },
    './dom.js': { el: (...args) => new Element(...args), toast: (message) => toasts.push(message) },
    './state.js': { state },
  };
  const context = vm.createContext({ document, encodeURIComponent });
  const module = new vm.SourceTextModule(source, { context });
  await module.link((specifier) => {
    assert.ok(imports[specifier], `unexpected column editor dependency ${specifier}`);
    return new vm.SyntheticModule(Object.keys(imports[specifier]), function () {
      for (const [key, value] of Object.entries(imports[specifier])) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const controls = () => {
    const dialog = document.body.querySelector('dialog');
    if (!dialog) return null;
    return {
      dialog, form: dialog.querySelector('form'),
      title: dialog.find((node) => node.id === 'column-remove-title'),
      details: dialog.find((node) => node.className.includes('column-remove-details')),
      destination: dialog.find((node) => node.id === 'column-remove-destination'),
      error: dialog.find((node) => node.className === 'dashboard-create-error'),
      cancel: dialog.find((node) => node.tagName === 'button' && node.textContent === 'Cancel'),
      submit: dialog.find((node) => node.tagName === 'button' && node.type === 'submit'),
    };
  };
  const start = (columnId = 'left') => {
    const completion = module.namespace.openRemoveColumn('board', columnId);
    return { completion, ...controls() };
  };
  const open = async (columnId = 'left') => { const form = start(columnId); await form.completion; return form.dialog ? form : null; };
  return { document, state, calls, removals, toasts, start, open, controls, setEditable: (value) => { editable = value; } };
}

test('removal confirms a fresh native column snapshot and cancellation performs no mutation', async () => {
  const view = await harness();
  const form = await view.open();
  assert.deepEqual(view.calls, [{ method: 'GET', path: '/api/manager/dashboards/dashboard/board' }]);
  assert.equal(form.title.textContent, 'Remove column 1');
  assert.match(form.details.textContent, /contains 2 widgets/);
  assert.match(form.details.textContent, /settings and saved content will be kept/);
  assert.equal(form.destination.hidden, false);
  assert.deepEqual(form.destination.children.map((option) => [option.value, option.textContent]), [
    ['right', 'Column 2 · 1 widget'], ['empty', 'Column 3 · 0 widgets'],
  ]);
  assert.equal(form.submit.textContent, 'Move widgets and remove column');
  await form.cancel.click();
  assert.deepEqual(view.removals, []);
  assert.equal(view.document.body.children.length, 0);
});

test('a populated column sends only its reviewed identities and chosen destination after confirmation', async () => {
  const view = await harness();
  const form = await view.open();
  form.destination.value = 'empty';
  const submission = form.form.emit('submit');
  await submission.completion;
  assert.equal(submission.event.defaultPrevented, true);
  assert.deepEqual(view.removals, [['board', 'left', { targetColumnId: 'empty', expectedWidgetIds: ['camera', 'note'] }]]);
  assert.equal(form.dialog.open, false);
});

test('an empty column removes only that column and does not require a destination', async () => {
  const view = await harness();
  const form = await view.open('empty');
  assert.equal(form.title.textContent, 'Remove column 3');
  assert.equal(form.destination.hidden, true);
  assert.equal(form.submit.textContent, 'Remove column');
  assert.match(form.details.textContent, /column is empty/);
  await form.form.emit('submit').completion;
  assert.deepEqual(view.removals, [['board', 'empty', { targetColumnId: null, expectedWidgetIds: [] }]]);
});

test('the final column cannot be removed, including a forced submit event', async () => {
  const dashboard = nativeDashboard(); dashboard.columns = [dashboard.columns[0]];
  const view = await harness({ read: async () => dashboard });
  const form = await view.open();
  assert.match(form.details.textContent, /Keep at least one column/);
  assert.equal(form.submit.hidden, true);
  assert.equal(form.submit.disabled, true);
  await form.form.emit('submit').completion;
  assert.deepEqual(view.removals, []);
  await form.cancel.click();
  assert.equal(view.document.body.children.length, 0);
});

test('Cancel while loading cannot reopen the modal or populate a new draft with an old response', async () => {
  const pending = deferred();
  let reads = 0;
  const view = await harness({ read: () => ++reads === 1 ? pending.promise : Promise.resolve(nativeDashboard()) });
  const first = view.start();
  assert.equal(first.submit.hidden, true);
  await first.cancel.click();
  const second = await view.open('empty');
  pending.resolve(nativeDashboard());
  await first.completion;
  assert.equal(first.dialog.open, false);
  assert.equal(second.dialog.open, true);
  assert.equal(second.title.textContent, 'Remove column 3');
  assert.equal(view.document.body.children.length, 1);
  assert.deepEqual(view.removals, []);
});

test('a pending save blocks duplicate submit, Cancel, Escape, and backdrop dismissal', async () => {
  const pending = deferred();
  const view = await harness({ remove: () => pending.promise });
  const form = await view.open();
  const submission = form.form.emit('submit');
  await form.form.emit('submit').completion;
  await form.cancel.click();
  await form.dialog.emit('click').completion;
  assert.equal(form.dialog.emit('cancel').event.defaultPrevented, true);
  assert.equal(form.dialog.open, true);
  assert.equal(form.dialog.getAttribute('aria-busy'), 'true');
  for (const button of [form.cancel, form.submit, form.destination]) assert.equal(button.disabled, true);
  assert.equal(view.removals.length, 1);
  pending.resolve({ id: 'board' });
  await submission.completion;
  assert.equal(form.dialog.open, false);
});

test('a refused save retains the chosen destination for an explicit successful retry', async () => {
  let refused = true;
  const view = await harness({ remove: async () => {
    if (refused) throw new Error('The destination could not be saved.');
    return { id: 'board' };
  } });
  const form = await view.open(); form.destination.value = 'empty';
  await form.form.emit('submit').completion;
  assert.equal(form.dialog.open, true);
  assert.equal(form.error.textContent, 'The destination could not be saved.');
  assert.equal(form.error.hidden, false);
  assert.equal(form.destination.value, 'empty');
  assert.equal(form.submit.textContent, 'Move widgets and remove column');
  assert.equal(form.dialog.getAttribute('aria-busy'), null);
  for (const button of [form.cancel, form.submit, form.destination]) assert.equal(button.disabled, false);
  refused = false;
  await form.form.emit('submit').completion;
  assert.equal(view.removals.length, 2);
  assert.deepEqual(view.removals[1], view.removals[0]);
  assert.equal(form.dialog.open, false);
});

test('changed source membership is not silently reconfirmed or retried', async () => {
  const view = await harness({ remove: async () => { throw new Error('The widgets in this column changed meanwhile. Reopen Remove column to review them.'); } });
  const form = await view.open();
  await form.form.emit('submit').completion;
  assert.equal(form.dialog.open, true);
  assert.match(form.error.textContent, /Reopen Remove column/);
  assert.equal(view.calls.length, 1, 'a failed confirmation must not load and approve a different membership automatically');
  assert.deepEqual(view.removals[0][2].expectedWidgetIds, ['camera', 'note']);
  await form.cancel.click();
  assert.equal(view.document.body.children.length, 0);
});

test('read-only and disconnected connections cannot open or submit removal', async () => {
  const readonly = await harness({ editable: false });
  assert.equal(await readonly.open(), null);
  assert.deepEqual(readonly.toasts, [NO_EDIT_PERMISSION]);
  assert.deepEqual(readonly.calls, []);
  const disconnected = await harness(); disconnected.state.client = null;
  assert.equal(await disconnected.open(), null);
  assert.deepEqual(disconnected.calls, []);
  const revoked = await harness(); const form = await revoked.open(); revoked.setEditable(false);
  await form.form.emit('submit').completion;
  assert.equal(form.error.textContent, NO_EDIT_PERMISSION);
  assert.deepEqual(revoked.removals, []);
});

test('a removed source or failed initial read offers no removal action', async () => {
  for (const read of [async () => ({ columns: [] }), async () => { throw new Error('Homey is unavailable.'); }]) {
    const view = await harness({ read }); const form = await view.open();
    assert.equal(form.error.hidden, false);
    assert.equal(form.submit.hidden, true);
    assert.equal(form.submit.disabled, true);
    await form.form.emit('submit').completion;
    assert.deepEqual(view.removals, []);
  }
});

test('replaced connections and dashboard switches discard late reads and old confirmations', async () => {
  for (const change of [(state) => { state.client = {}; }, (state) => { state.dashboardId = 'other'; }]) {
    const pending = deferred(); const view = await harness({ read: () => pending.promise });
    const loading = view.start(); change(view.state); pending.resolve(nativeDashboard()); await loading.completion;
    assert.equal(loading.dialog.open, false);
    assert.equal(view.document.body.children.length, 0);
    assert.deepEqual(view.removals, []);
    const ready = await harness(); const form = await ready.open(); change(ready.state);
    await form.form.emit('submit').completion;
    assert.equal(form.dialog.open, false);
    assert.deepEqual(ready.removals, []);
  }
});

test('a late save result cannot display an old failure after the connection changes', async () => {
  for (const outcome of ['success', 'failure']) {
    const pending = deferred(); const view = await harness({ remove: () => pending.promise }); const form = await view.open();
    const submission = form.form.emit('submit'); view.state.client = {};
    if (outcome === 'success') pending.resolve({ id: 'board' }); else pending.reject(new Error('Old failure.'));
    await submission.completion;
    assert.equal(form.error.hidden, true);
    assert.deepEqual(view.toasts, []);
  }
});

test('repeated Remove column taps share one modal and one fresh read', async () => {
  const pending = deferred(); const view = await harness({ read: () => pending.promise });
  const first = view.start(); const duplicate = view.start();
  await duplicate.completion;
  assert.equal(view.calls.length, 1);
  assert.equal(view.document.body.children.length, 1);
  assert.equal(view.document.activeElement, first.cancel);
  pending.resolve(nativeDashboard()); await first.completion;
  assert.equal(view.document.body.children.length, 1);
});
