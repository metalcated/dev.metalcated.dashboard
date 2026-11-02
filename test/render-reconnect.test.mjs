import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function moduleUnderTest(name, globals, imports, accessors = '') {
  const context = vm.createContext(globals);
  const source = await readFile(new URL(`../assets/web/js/${name}`, import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source + accessors, { context });
  await module.link((specifier) => {
    assert.ok(imports[specifier], `unexpected dependency ${specifier}`);
    return new vm.SyntheticModule(Object.keys(imports[specifier]), function () {
      for (const [key, value] of Object.entries(imports[specifier])) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

const dashboard = { id: 'old', name: 'Old dashboard', columns: [{ widgets: [{ id: 'old-widget', type: 'note' }] }] };
const stateForTest = () => ({
  client: { id: 'old-client' },
  dashboards: { old: structuredClone(dashboard) },
  dashboardId: 'old',
  highlighted: null,
  data: { existing: { keep: true } },
  dataErrors: {},
});

test('an existing render cannot merge old data or mount old widgets after the connection changes', async () => {
  const pending = deferred();
  const state = stateForTest();
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, { replaceChildren() {}, textContent: '' });
    return nodes.get(id);
  };
  let mounts = 0;
  let fits = 0;
  const render = await moduleUnderTest('render.js', { document: {} }, {
    './data.js': { loadData: () => pending.promise },
    './dom.js': { $, el: () => assert.fail('old render must not build elements'), note: () => {} },
    './edit-mode.js': { addColumnTools: () => {}, addEditTools: () => {} },
    './fit.js': { fitBoard: () => { fits += 1; } },
    './state.js': { state },
    './widgets/index.js': { WIDGETS: { note: { needs: ['devices'], mount: () => { mounts += 1; } } }, widgetTypeName: () => 'Note' },
  });

  const rendering = render.renderDashboard();
  state.client = { id: 'new-client' };
  pending.resolve({ data: { devices: { privateOldDevice: {} } }, errors: {} });
  await rendering;

  assert.deepEqual(state.data, { existing: { keep: true } });
  assert.deepEqual(state.dataErrors, {});
  assert.equal(mounts, 0);
  assert.equal(fits, 0);
});

test('an in-flight highlight cannot merge old data or reopen old media in a replacement connection', async () => {
  const pending = deferred();
  const state = stateForTest();
  let mounts = 0;
  let opened = 0;
  const element = () => ({
    classList: { toggle() {}, remove() {} },
    setAttribute() {},
    showPopover: () => { opened += 1; },
    matches: () => false,
  });
  const highlight = await moduleUnderTest('highlight.js', {
    ResizeObserver: class { observe() {} unobserve() {} },
  }, {
    './config.js': { APP_ID: 'test.dashboard', servedByHomey: true },
    './data.js': { loadData: () => pending.promise },
    './dom.js': { $: element, el: element },
    './icons.js': { CLOSE_ICON: '' },
    './realtime.js': { subscribe: () => {} },
    './render.js': { drawnWidget: () => null, holdBoard: () => {}, renderWidget: () => { mounts += 1; return { section: element() }; } },
    './screen.js': { screenId: () => 'screen' },
    './state.js': { state },
    './widgets/index.js': { WIDGETS: { note: { needs: ['devices'] } } },
  }, '\nexport const setCurrentForTest = (value) => { current = value; };');

  highlight.setCurrentForTest({ dashboardId: 'old', widgetId: 'old-widget', size: 'large' });
  const showing = highlight.showHighlight();
  state.client = { id: 'new-client' };
  pending.resolve({ data: { devices: { privateOldCamera: {} } }, errors: {} });
  await showing;

  assert.deepEqual(state.data, { existing: { keep: true } });
  assert.deepEqual(state.dataErrors, {});
  assert.equal(state.highlighted, null);
  assert.equal(mounts, 0);
  assert.equal(opened, 0);
});

class RenderElement {
  constructor(tagName = 'div', className = '', text = '') {
    this.tagName = tagName;
    this.className = className;
    this.textContent = text;
    this.children = [];
    this.dataset = {};
    this.moves = [];
    this.classList = { add() {} };
  }
  get nextSibling() {
    return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null;
  }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, before) {
    const wasAttached = node.parentNode != null;
    node.remove();
    const position = before == null ? this.children.length : this.children.indexOf(before);
    assert.ok(position >= 0, 'the insertion anchor must belong to this parent');
    this.children.splice(position, 0, node);
    node.parentNode = this;
    if (wasAttached) this.moves.push(node);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this);
    this.parentNode = null;
  }
  replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this.append(...nodes); }
  querySelector(selector) {
    const selectors = selector.split(',').map((part) => part.trim());
    const matches = (node) => selectors.some((part) => part.startsWith('.')
      ? node.className.split(/\s+/).includes(part.slice(1)) : node.tagName === part);
    for (const child of this.children) {
      if (matches(child)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
}

async function authoringRender() {
  const board = new RenderElement('main');
  const title = new RenderElement('span');
  const document = {};
  const columns = [{ id: 'first-column', widgets: [
    { id: 'note-a', type: 'note' }, { id: 'camera-b', type: 'camera' },
  ] }, { id: 'second-column', widgets: [] }];
  const state = { client: {}, dashboardId: 'board', dashboards: { board: { id: 'board', name: 'Board', columns } },
    data: {}, dataErrors: {}, highlighted: null };
  const mounts = [];
  const cleanups = [];
  const widget = (type) => ({ title: type, mount({ body, widget: item }) {
    mounts.push(item.id);
    if (type === 'camera') body.append(new RenderElement('video'));
    return () => cleanups.push(item.id);
  } });
  const render = await moduleUnderTest('render.js', { document }, {
    './data.js': { loadData: async () => ({ data: {}, errors: {} }) },
    './dom.js': { $: (id) => id === 'board' ? board : title,
      el: (...args) => new RenderElement(...args), note: () => {} },
    './edit-mode.js': {
      addEditTools(section, info) { section.dataset.widgetId = info.widgetId; },
      addColumnTools(column, dashboardId, columnId) {
        const add = new RenderElement('button', 'column-add-widget');
        add.dataset.dashboardId = dashboardId;
        add.dataset.columnId = columnId;
        column.append(add);
      },
    },
    './fit.js': { fitBoard() {} },
    './state.js': { state },
    './widgets/index.js': { WIDGETS: { note: widget('note'), camera: widget('camera') }, widgetTypeName: (type) => type },
  }, '\nexport { arrange };');
  return { render, board, state, mounts, cleanups };
}

test('reordering widgets keeps the Add widget control last and leaves the heavier live widget in place', async () => {
  const view = await authoringRender();
  await view.render.renderDashboard();
  const column = view.board.children[0];
  const [note, camera, add] = column.children;
  const video = camera.querySelector('video');
  column.moves = [];
  view.render.arrange(column, [camera, note]);
  assert.deepEqual(column.children, [camera, note, add]);
  assert.deepEqual(column.moves, [note], 'the existing video section is not moved or remounted');
  assert.equal(camera.querySelector('video'), video);
  assert.deepEqual(view.mounts, ['note-a', 'camera-b']);
  assert.deepEqual(view.cleanups, []);
});

test('repeated widget additions and moves preserve live sections and one trailing Add widget control', async () => {
  const view = await authoringRender();
  await view.render.renderDashboard();
  const column = view.board.children[0];
  const camera = column.children[1];
  const native = view.state.dashboards.board.columns[0];
  native.widgets.reverse();
  view.render.updateBoard();
  for (const id of ['note-c', 'note-d']) {
    native.widgets.push({ id, type: 'note' });
    view.render.updateBoard();
    assert.deepEqual(column.children.filter((node) => node.className === 'widget').map((node) => node.dataset.widgetId),
      native.widgets.map((item) => item.id));
    assert.equal(column.children.at(-1).className, 'column-add-widget');
    assert.equal(column.children.filter((node) => node.className === 'column-add-widget').length, 1);
    assert.equal(column.children[0], camera);
  }
  assert.deepEqual(view.mounts, ['note-a', 'camera-b', 'note-c', 'note-d']);
  assert.deepEqual(view.cleanups, []);
});

test('reordered or replaced column identities refresh Add widget targets even when the column count is unchanged', async () => {
  const view = await authoringRender();
  await view.render.renderDashboard();
  const native = view.state.dashboards.board;
  native.columns.reverse();
  view.render.updateBoard();
  await new Promise(setImmediate);
  assert.deepEqual(view.board.children.map((column) => column.querySelector('.column-add-widget').dataset.columnId),
    ['second-column', 'first-column']);
  assert.equal(view.board.children[0].children.length, 1, 'the empty native column still has its own add control');
  native.columns[0] = { id: 'replacement-column', widgets: [] };
  view.render.updateBoard();
  await new Promise(setImmediate);
  assert.deepEqual(view.board.children.map((column) => column.querySelector('.column-add-widget').dataset.columnId),
    ['replacement-column', 'first-column']);
  for (const column of view.board.children) {
    const control = column.querySelector('.column-add-widget');
    assert.equal(control.dataset.dashboardId, 'board');
    assert.equal(column.children.at(-1), control);
  }
});
