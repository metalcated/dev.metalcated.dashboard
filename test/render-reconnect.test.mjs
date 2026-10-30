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
    './edit-mode.js': { addEditTools: () => {} },
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
