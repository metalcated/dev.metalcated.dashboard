import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the real modal's handlers without a Homey connection or persistent browser state.
const source = await readFile(new URL('../assets/web/js/dashboard-editor.js', import.meta.url), 'utf8');
const NO_EDIT_PERMISSION = 'This connection can only view dashboards.';
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
};

async function harness({ editable = true, create = async () => ({ id: 'new-board', name: 'New board', columns: [] }) } = {}) {
  const document = { activeElement: null };
  class Element {
    constructor(tag = 'div', className = '', text = '') {
      this.tagName = tag;
      this.className = className ?? '';
      this.textContent = text;
      this.value = '';
      this.children = [];
      this.listeners = new Map();
      this.attributes = new Map();
      this.hidden = false;
      this.disabled = false;
      this.open = false;
    }
    append(...nodes) { for (const node of nodes) { this.children.push(node); node.parent = this; } }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
      this.parent = null;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    emit(type) {
      const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      const completion = Promise.all((this.listeners.get(type) ?? []).map((listener) => listener(event)));
      return { event, completion };
    }
    click() { return this.disabled ? Promise.resolve() : this.emit('click').completion; }
    showModal() { this.open = true; }
    close() { if (this.open) { this.open = false; return this.emit('close').completion; } }
    focus() { document.activeElement = this; }
    find(predicate) { return predicate(this) ? this : this.children.map((node) => node.find(predicate)).find(Boolean); }
    querySelector(selector) { return this.find((node) => node.tagName === selector) ?? null; }
  }
  document.body = new Element('body');
  const nodes = new Map(['new-dashboard-button', 'sidebar-new-dashboard'].map((id) => [id, new Element('button')]));
  const state = { client: { id: 'connected' }, dashboards: {
    cameras: { id: 'cameras', name: 'Cameras', columns: [] },
    batteries: { id: 'batteries', name: 'Batteries', columns: [] },
  } };
  const calls = [];
  const selected = [];
  const toasts = [];
  const imports = {
    './dashboard-save.js': {
      NO_EDIT_PERMISSION, canEditDashboards: () => editable,
      createDashboard(args) { calls.push(structuredClone(args)); return create(args); },
    },
    './dom.js': { $: (id) => nodes.get(id), el: (...args) => new Element(...args), toast: (message) => toasts.push(message) },
    './state.js': { state },
  };
  const context = vm.createContext({ document });
  const module = new vm.SourceTextModule(source, { context });
  await module.link((specifier) => {
    assert.ok(imports[specifier], `unexpected editor dependency ${specifier}`);
    return new vm.SyntheticModule(Object.keys(imports[specifier]), function () {
      for (const [key, value] of Object.entries(imports[specifier])) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const editor = module.namespace;
  const controls = (dialog) => ({
    form: dialog.querySelector('form'),
    name: dialog.find((node) => node.id === 'dashboard-create-name'),
    source: dialog.find((node) => node.id === 'dashboard-create-source'),
    hint: dialog.find((node) => node.className === 'dashboard-create-hint'),
    error: dialog.find((node) => node.className === 'dashboard-create-error'),
    cancel: dialog.find((node) => node.tagName === 'button' && node.textContent === 'Cancel'),
    submit: dialog.find((node) => node.tagName === 'button' && node.type === 'submit'),
  });
  const open = () => {
    editor.openNewDashboard((saved) => selected.push(saved));
    const dialog = document.body.querySelector('dialog');
    return dialog ? { dialog, ...controls(dialog) } : null;
  };
  return { editor, open, nodes, document, state, calls, selected, toasts };
}

test('cancel closes an unsaved dashboard and reopening starts with an independent blank draft', async () => {
  const view = await harness();
  const first = view.open();
  first.name.value = 'Unfinished';
  first.source.value = 'cameras';
  await first.source.emit('change').completion;
  assert.equal(first.hint.hidden, false);
  await first.cancel.click();
  assert.equal(view.document.body.children.length, 0);
  assert.deepEqual(view.calls, []);
  assert.deepEqual(view.selected, []);
  const second = view.open();
  assert.notEqual(second.dialog, first.dialog);
  assert.equal(second.name.value, '');
  assert.equal(second.source.value, '');
  assert.equal(second.hint.hidden, true);
  assert.equal(view.document.activeElement, second.name);
});

test('an empty or whitespace name stays in the modal without a write', async () => {
  const view = await harness();
  const form = view.open();
  for (const value of ['', '  ']) {
    form.name.value = value;
    const submission = form.form.emit('submit');
    await submission.completion;
    assert.equal(submission.event.defaultPrevented, true);
    assert.equal(form.error.hidden, false);
    assert.match(form.error.textContent, /Enter a dashboard name/);
    assert.equal(form.dialog.open, true);
    assert.equal(view.document.activeElement, form.name);
  }
  assert.deepEqual(view.calls, []);
});

test('blank creation submits the trimmed native name and waits for acknowledgement before selecting it', async () => {
  const pending = deferred();
  const view = await harness({ create: () => pending.promise });
  const form = view.open();
  form.name.value = '  Living room  ';
  const submission = form.form.emit('submit');
  assert.deepEqual(view.calls, [{ name: 'Living room', sourceId: null }]);
  assert.equal(form.dialog.getAttribute('aria-busy'), 'true');
  for (const control of [form.name, form.source, form.cancel, form.submit]) assert.equal(control.disabled, true);
  assert.deepEqual(view.selected, []);
  await form.form.emit('submit').completion;
  await form.cancel.click();
  assert.equal(view.calls.length, 1, 'a second event cannot duplicate the in-flight submission');
  assert.equal(form.dialog.open, true, 'cancel cannot imply the acknowledged write was cancelled');
  assert.equal(form.dialog.emit('cancel').event.defaultPrevented, true, 'Escape cannot dismiss a pending write');
  const saved = { id: 'new-board', name: 'Living room', columns: [] };
  pending.resolve(saved);
  await submission.completion;
  assert.deepEqual(view.selected, [saved]);
  assert.equal(view.document.body.children.length, 0);
});

test('copy submits the selected native dashboard identity and explains the separate saved content', async () => {
  const saved = { id: 'copy-board', name: 'My cameras', columns: [] };
  const view = await harness({ create: async () => saved });
  const form = view.open();
  assert.deepEqual(form.source.children.map((option) => option.textContent), ['Blank dashboard', 'Copy Batteries', 'Copy Cameras']);
  form.name.value = 'My cameras';
  form.source.value = 'cameras';
  await form.source.emit('change').completion;
  assert.equal(form.hint.hidden, false);
  assert.match(form.hint.textContent, /Note text, app widget saved content, and web-only sizes start fresh/);
  await form.form.emit('submit').completion;
  assert.deepEqual(view.calls, [{ name: 'My cameras', sourceId: 'cameras' }]);
  assert.deepEqual(view.selected, [saved]);
});

test('an uncertain result keeps the draft and Check creation repeats its identity only after another submit', async () => {
  let attempts = 0;
  const saved = { id: 'eventually-confirmed', name: 'Cameras copy', columns: [] };
  const view = await harness({ create: async () => {
    if (++attempts === 1) throw Object.assign(new Error('Homey may have created this dashboard.'), { creationUncertain: true });
    return saved;
  } });
  const form = view.open();
  form.name.value = 'Cameras copy';
  form.source.value = 'cameras';
  await form.form.emit('submit').completion;
  assert.equal(view.calls.length, 1, 'the modal does not automatically replay creation');
  assert.equal(form.dialog.open, true);
  assert.equal(form.submit.textContent, 'Check creation');
  assert.equal(form.error.hidden, false);
  assert.equal(form.name.value, 'Cameras copy');
  assert.equal(form.source.value, 'cameras');
  assert.equal(form.name.disabled, true, 'an uncertain creation cannot be renamed into a second create attempt');
  assert.equal(form.source.disabled, true, 'checking creation retains the original copy source identity');
  assert.equal(form.cancel.disabled, false, 'an uncertain response may still be dismissed');
  assert.equal(form.submit.disabled, false);
  await form.form.emit('submit').completion;
  assert.deepEqual(view.calls, [{ name: 'Cameras copy', sourceId: 'cameras' }, { name: 'Cameras copy', sourceId: 'cameras' }]);
  assert.deepEqual(view.selected, [saved]);
});

test('a definite refusal keeps editable draft fields and an explicit retry can complete', async () => {
  let refused = true;
  const view = await harness({ create: async () => {
    if (refused) throw new Error(NO_EDIT_PERMISSION);
    return { id: 'approved', name: 'Room', columns: [] };
  } });
  const form = view.open();
  form.name.value = 'Room';
  await form.form.emit('submit').completion;
  assert.equal(form.error.textContent, NO_EDIT_PERMISSION);
  assert.equal(form.error.hidden, false);
  assert.equal(form.submit.textContent, 'Create dashboard');
  assert.equal(form.dialog.getAttribute('aria-busy'), null);
  for (const control of [form.name, form.source, form.cancel, form.submit]) assert.equal(control.disabled, false);
  assert.deepEqual(view.selected, []);
  refused = false;
  await form.form.emit('submit').completion;
  assert.equal(view.selected[0].id, 'approved');
  assert.equal(view.calls.length, 2);
});

test('read-only or disconnected views never open a creation modal', async () => {
  const readonly = await harness({ editable: false });
  assert.equal(readonly.open(), null);
  assert.deepEqual(readonly.toasts, [NO_EDIT_PERMISSION]);
  assert.deepEqual(readonly.calls, []);
  const disconnected = await harness();
  disconnected.state.client = null;
  assert.equal(disconnected.open(), null);
  assert.deepEqual(disconnected.calls, []);
});

test('a connection change before submission refuses the old draft without a create', async () => {
  const view = await harness();
  const form = view.open();
  form.name.value = 'Old connection';
  view.state.client = { id: 'replacement' };
  await form.form.emit('submit').completion;
  assert.deepEqual(view.calls, []);
  assert.deepEqual(view.selected, []);
  assert.equal(form.error.hidden, false);
  assert.match(form.error.textContent, /connection changed/);
});

test('a late success or refusal cannot select a dashboard or show an old error after a connection change', async () => {
  for (const outcome of ['success', 'failure']) {
    const pending = deferred();
    const view = await harness({ create: () => pending.promise });
    const form = view.open();
    form.name.value = 'Old draft';
    const submission = form.form.emit('submit');
    view.state.client = { id: 'replacement' };
    if (outcome === 'success') pending.resolve({ id: 'old-result', name: 'Old draft', columns: [] });
    else pending.reject(new Error('Old connection refused'));
    await submission.completion;
    assert.deepEqual(view.selected, []);
    assert.equal(form.error.hidden, true);
    assert.equal(form.error.textContent, '');
    assert.deepEqual(view.toasts, []);
  }
});

test('both New dashboard controls share one modal and reflect current connection permissions', async () => {
  const view = await harness();
  view.editor.initDashboardEditor((saved) => view.selected.push(saved));
  view.editor.syncDashboardEditor();
  for (const button of view.nodes.values()) {
    assert.equal(button.hidden, false);
    assert.equal(button.disabled, false);
    await button.click();
  }
  assert.equal(view.document.body.children.length, 1);
  const name = view.document.body.find((node) => node.id === 'dashboard-create-name');
  assert.equal(view.document.activeElement, name);
  view.state.client = null;
  view.editor.syncDashboardEditor();
  for (const button of view.nodes.values()) assert.equal(button.hidden, true);
  const readonly = await harness({ editable: false });
  readonly.editor.syncDashboardEditor();
  for (const button of readonly.nodes.values()) {
    assert.equal(button.disabled, true);
    assert.equal(button.title, NO_EDIT_PERMISSION);
  }
});
