import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Run the real save module with an isolated browser state for each test. No Homey,
// network, browser storage, or installed packages are needed.
const source = await readFile(new URL('../assets/web/js/dashboard-save.js', import.meta.url), 'utf8');
const clone = (value) => structuredClone(value);
const dashboardId = 'room/office ?';
const dashboardPath = `/api/manager/dashboards/dashboard/${encodeURIComponent(dashboardId)}`;

function nativeDashboard() {
  return {
    id: dashboardId,
    name: 'Office',
    mobileMetadata: { preserve: true },
    columns: [{
      id: 'native-column',
      mobileColumnOption: 'keep',
      widgets: [
        { id: 'temperature', type: 'sensors_selection', title: 'Temperature', data: { sensors: ['device:temperature'] } },
        { id: 'future-widget', type: 'future_mobile_widget', futureOption: { nested: ['keep', 42] } },
      ],
    }],
  };
}

async function harness(api, dashboard = nativeDashboard()) {
  const events = [];
  const calls = [];
  const state = {
    dashboards: { [dashboardId]: clone(dashboard) },
    client: {
      async api(method, path, body) {
        calls.push({ method, path, ...(body === undefined ? {} : { body: clone(body) }) });
        return api(method, path, body);
      },
    },
  };
  const context = vm.createContext({
    structuredClone,
    crypto: webcrypto,
    CustomEvent: class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    document: {
      dispatchEvent(event) {
        assert.equal(event.type, 'dashboard-saved');
        events.push(clone(event.detail));
      },
    },
  });
  const stateModule = new vm.SyntheticModule(['state'], function () {
    this.setExport('state', state);
  }, { context });
  const saveModule = new vm.SourceTextModule(source, { context });
  await saveModule.link((specifier) => {
    assert.equal(specifier, './state.js');
    return stateModule;
  });
  await saveModule.evaluate();
  return { ...saveModule.namespace, state, calls, events };
}

function nativeOnly(calls) {
  for (const call of calls) {
    assert.equal(call.path, dashboardPath, 'dashboard edits must use the native Homey object');
    assert.ok(['GET', 'PUT'].includes(call.method));
    if (call.method === 'PUT') {
      assert.deepEqual(Object.keys(call.body), ['columns'], 'do not replace names or other dashboard metadata');
    }
  }
}

test('edits the latest mobile layout and preserves unknown widgets, column fields, and dashboard metadata', async () => {
  let server = nativeDashboard();
  const originalBrowserView = clone(server);
  server.name = 'Office renamed on mobile';
  server.columns[0].widgets[0].data.mobileOption = { units: 'celsius' };
  server.columns.push({ id: 'added-on-phone', widgets: [{ id: 'phone-note', type: 'note', data: { text: 'From mobile' } }] });
  const savedNativeWidget = clone(server.columns[0].widgets[1]);
  const savedMobileColumn = clone(server.columns[1]);
  const save = await harness(async (method, path, body) => {
    assert.equal(path, dashboardPath);
    if (method === 'GET') return clone(server);
    server = { ...server, ...clone(body) };
    return clone(server);
  }, originalBrowserView);

  const result = await save.updateDashboard(dashboardId, (columns) => {
    save.locateWidget(columns, 'temperature').widget.title = 'Office temperature';
  });

  assert.equal(result.name, 'Office renamed on mobile');
  assert.deepEqual(result.mobileMetadata, { preserve: true });
  assert.equal(result.columns[0].mobileColumnOption, 'keep');
  assert.deepEqual(result.columns[0].widgets[0].data.mobileOption, { units: 'celsius' });
  assert.deepEqual(result.columns[0].widgets[1], savedNativeWidget);
  assert.deepEqual(result.columns[1], savedMobileColumn);
  assert.equal(originalBrowserView.columns[0].widgets[0].title, 'Temperature');
  assert.deepEqual(save.events, [result]);
  assert.equal(save.isSaving(dashboardId), false);
  nativeOnly(save.calls);
});

test('serializes quick edits and reads mobile changes made between saves', async () => {
  let server = nativeDashboard();
  let releaseFirstWrite;
  let firstWriteStarted;
  const firstWrite = new Promise((resolve) => { firstWriteStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirstWrite = resolve; });
  let writes = 0;
  const save = await harness(async (method, path, body) => {
    if (method === 'GET') return clone(server);
    writes += 1;
    if (writes === 1) {
      firstWriteStarted();
      await gate;
    }
    server = { ...server, ...clone(body) };
    if (writes === 1) {
      server.columns[0].widgets.push({ id: 'mobile-addition', type: 'note', data: { text: 'Added between edits' } });
    }
    return clone(server);
  });

  const first = save.updateDashboard(dashboardId, (columns) => {
    save.locateWidget(columns, 'temperature').widget.title = 'First edit';
  });
  await firstWrite;
  const second = save.updateDashboard(dashboardId, (columns) => {
    save.locateWidget(columns, 'temperature').widget.title += ' then second edit';
  });
  assert.equal(save.isSaving(dashboardId), true);
  assert.deepEqual(save.calls.map(({ method }) => method), ['GET', 'PUT']);
  releaseFirstWrite();
  await Promise.all([first, second]);

  assert.equal(server.columns[0].widgets[0].title, 'First edit then second edit');
  assert.equal(server.columns[0].widgets.at(-1).id, 'mobile-addition');
  assert.deepEqual(save.calls.map(({ method }) => method), ['GET', 'PUT', 'GET', 'PUT']);
  assert.deepEqual(save.events, [server], 'only announce the final queued layout');
  assert.equal(save.isSaving(dashboardId), false);
  nativeOnly(save.calls);
});

test('permission failure rolls an optimistic edit back to Homey and a later authorized retry succeeds', async () => {
  let server = nativeDashboard();
  let allowed = false;
  const save = await harness(async (method, path, body) => {
    if (method === 'GET') return clone(server);
    if (!allowed) {
      server.columns[0].widgets[0].title = 'Updated in mobile while denied';
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    }
    server = { ...server, ...clone(body) };
    return clone(server);
  });

  await assert.rejects(save.updateDashboard(dashboardId, (columns) => {
    columns[0].widgets[0].title = 'Unapproved edit';
  }, { optimistic: true }), { message: save.NO_EDIT_PERMISSION });

  assert.equal(save.events[0].columns[0].widgets[0].title, 'Unapproved edit');
  assert.deepEqual(save.events[1], server, 'rollback uses current Homey data, not a stale browser copy');
  assert.equal(save.state.dashboards[dashboardId].columns[0].widgets[0].title, 'Temperature');
  assert.equal(save.isSaving(dashboardId), false);

  allowed = true;
  const retry = await save.updateDashboard(dashboardId, (columns) => {
    columns[0].widgets[0].title += ' and retried';
  });
  assert.equal(retry.columns[0].widgets[0].title, 'Updated in mobile while denied and retried');
  assert.deepEqual(save.events.at(-1), server);
  nativeOnly(save.calls);
});

test('a dashboard removed on mobile reports deletion without recreating it', async () => {
  const save = await harness(async () => {
    throw Object.assign(new Error('Not found'), { status: 404 });
  });

  await assert.rejects(save.updateDashboard(dashboardId, () => {}), { message: 'This dashboard was deleted meanwhile.' });

  assert.equal(save.calls.length, 1);
  assert.equal(save.calls[0].method, 'GET');
  assert.deepEqual(save.events, []);
  assert.equal(save.isSaving(dashboardId), false);
  nativeOnly(save.calls);
});

test('a widget removed on mobile cancels that edit and leaves the save queue usable', async () => {
  let server = nativeDashboard();
  server.columns[0].widgets = server.columns[0].widgets.filter(({ id }) => id !== 'temperature');
  const save = await harness(async (method, path, body) => {
    if (method === 'GET') return clone(server);
    server = { ...server, ...clone(body) };
    return clone(server);
  });

  await assert.rejects(save.updateDashboard(dashboardId, (columns) => {
    save.locateWidget(columns, 'temperature').widget.title = 'Stale widget';
  }), { message: 'This widget was removed from the dashboard meanwhile.' });
  assert.equal(save.calls.filter(({ method }) => method === 'PUT').length, 0);
  assert.equal(save.isSaving(dashboardId), false);

  await save.updateDashboard(dashboardId, (columns) => {
    save.locateWidget(columns, 'future-widget').widget.title = 'Still available';
  });
  assert.equal(server.columns[0].widgets[0].title, 'Still available');
  nativeOnly(save.calls);
});

test('editing availability uses effective session permissions rather than broader token scopes', async () => {
  let session = { scopes: ['homey'], intersectedScopes: ['homey.dashboard.readonly'] };
  const save = await harness(async (method, path) => {
    assert.equal(method, 'GET');
    assert.equal(path, '/api/manager/sessions/session/me');
    return session;
  });

  await save.loadKeyScopes();
  assert.equal(save.canEditDashboards(), false);
  session = { scopes: ['homey.dashboard'] };
  await save.loadKeyScopes();
  assert.equal(save.canEditDashboards(), true);
  session = { scopes: ['homey'] };
  await save.loadKeyScopes();
  assert.equal(save.canEditDashboards(), true);
  assert.equal(save.calls.every(({ method }) => method === 'GET'), true);
});

test('a pending edit cannot write with a replacement connection or announce stale data', async () => {
  let finishRead;
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  const save = await harness(async (method) => {
    assert.equal(method, 'GET', 'the obsolete connection must never reach a write');
    started();
    return new Promise((resolve) => { finishRead = resolve; });
  });
  const editing = save.updateDashboard(dashboardId, (columns) => { columns[0].widgets[0].title = 'Old session edit'; });
  await reading;
  save.state.client = { api: () => assert.fail('an old edit must never use the new connection') };
  finishRead(nativeDashboard());
  await assert.rejects(editing, /connection changed/);
  assert.equal(save.events.length, 0);
  assert.equal(save.isSaving(dashboardId), false);
});

test('a write completed after disconnection cannot announce or roll back over the new session', async () => {
  let finishWrite;
  let started;
  const writing = new Promise((resolve) => { started = resolve; });
  const save = await harness(async (method) => {
    if (method === 'GET') return nativeDashboard();
    started();
    return new Promise((resolve) => { finishWrite = resolve; });
  });
  const editing = save.updateDashboard(dashboardId, (columns) => { columns[0].widgets[0].title = 'Old edit'; }, { optimistic: true });
  await writing;
  save.state.client = { api: () => assert.fail('stale rollback must not read the new session') };
  finishWrite(nativeDashboard());
  await assert.rejects(editing, /connection changed/);
  assert.equal(save.events.length, 1, 'only the initial optimistic event was emitted before the session changed');
  assert.equal(save.isSaving(dashboardId), false);
});

test('delayed permissions from an older connection cannot enable editing in a replacement read-only session', async () => {
  let finishOldScopes;
  const save = await harness(async () => new Promise((resolve) => { finishOldScopes = resolve; }));
  const previous = save.loadKeyScopes();
  save.state.client = { api: async () => ({ scopes: ['homey.dashboard.readonly'] }) };
  await save.loadKeyScopes();
  finishOldScopes({ scopes: ['homey'] });
  await previous;
  assert.equal(save.canEditDashboards(), false);
});

const dashboardsPath = '/api/manager/dashboards/dashboard';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const created = (body) => ({ id: 'new-native-dashboard', ...clone(body) });

test('creates a native blank dashboard with a unique empty column and no browser-owned state', async () => {
  const save = await harness(async (method, path, body) => {
    assert.equal(method, 'POST'); assert.equal(path, dashboardsPath);
    return created(body);
  });
  const result = await save.createDashboard({ name: '  New room  ' });
  assert.equal(result.name, 'New room');
  assert.deepEqual(Object.keys(save.calls[0].body), ['name', 'columns']);
  assert.equal(result.columns.length, 1);
  assert.match(result.columns[0].id, uuid);
  assert.deepEqual(result.columns[0].widgets, []);
  assert.deepEqual(save.events, [result]);
});

test('copy reads the latest source and changes only column/widget identities while preserving native fields', async () => {
  const source = nativeDashboard();
  source.columns[0].widgets.push({
    id: 'shortcut-widget', type: 'dashboards_shortcuts', data: { dashboardIds: [dashboardId, 'another-dashboard'] },
  }, { id: 'app-instance', type: 'app_webview', data: { appWidgetId: 'catalog-id', deviceIds: ['device-id'], settings: { custom: 42 } } });
  source.columns.push({ id: 'mobile-column', option: { retain: true }, widgets: [] });
  const before = clone(source);
  const save = await harness(async (method, path, body) => {
    if (method === 'GET') { assert.equal(path, dashboardPath); return source; }
    assert.equal(method, 'POST'); assert.equal(path, dashboardsPath);
    return created(body);
  });
  const result = await save.createDashboard({ name: 'Copy of Office', sourceId: dashboardId });
  assert.deepEqual(source, before, 'fresh native source is not mutated');
  assert.equal(result.mobileMetadata, undefined, 'only the allowed native creation fields are posted');
  const ids = result.columns.flatMap((column) => [column.id, ...column.widgets.map((widget) => widget.id)]);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, uuid);
  const stripped = (columns) => columns.map(({ id, widgets, ...rest }) => ({
    ...rest, widgets: widgets.map(({ id: ignored, ...widget }) => widget),
  }));
  assert.deepEqual(stripped(result.columns), stripped(before.columns));
  assert.deepEqual(result.columns[0].widgets[2].data.dashboardIds, [dashboardId, 'another-dashboard'], 'shortcut targets remain explicit existing dashboards');
  assert.deepEqual(save.calls.map(({ method }) => method), ['GET', 'POST'], 'copy does not widen widget-store writes');
  assert.deepEqual(save.events, [result]);
});

test('known read-only scopes stop creation and additions before any writes', async () => {
  const save = await harness(async () => ({ scopes: ['homey.dashboard.readonly'] }));
  await save.loadKeyScopes();
  assert.throws(() => save.createDashboard({ name: 'Read only' }), { message: save.NO_EDIT_PERMISSION });
  assert.throws(() => save.addDashboardColumn(dashboardId), { message: save.NO_EDIT_PERMISSION });
  assert.throws(() => save.addDashboardWidget(dashboardId, 'native-column', { type: 'note' }), { message: save.NO_EDIT_PERMISSION });
  assert.equal(save.calls.length, 1);
});

test('definite create refusal allows a later explicit retry but never replays a request automatically', async () => {
  let allowed = false;
  const save = await harness(async (method, path, body) => {
    assert.equal(method, 'POST'); assert.equal(path, dashboardsPath);
    if (!allowed) throw Object.assign(new Error('Forbidden'), { status: 403 });
    return created(body);
  });
  await assert.rejects(save.createDashboard({ name: 'New room' }), { message: save.NO_EDIT_PERMISSION });
  assert.equal(save.calls.length, 1);
  allowed = true;
  const result = await save.createDashboard({ name: 'New room' });
  assert.equal(save.calls.length, 2);
  assert.deepEqual(save.events, [result]);
});

test('a lost create response reconciles the unique column identity and never posts a duplicate', async () => {
  let server;
  const save = await harness(async (method, path, body) => {
    assert.equal(path, dashboardsPath);
    if (method === 'POST') {
      server = created(body);
      throw new Error('Response lost after creation');
    }
    assert.equal(method, 'GET');
    return { other: { id: 'unrelated', name: 'Same name', columns: [] }, [server.id]: clone(server) };
  });
  const result = await save.createDashboard({ name: 'Same name' });
  assert.deepEqual(result, server);
  assert.deepEqual(save.calls.map(({ method }) => method), ['POST', 'GET']);
  assert.deepEqual(save.events, [server]);
});

test('unconfirmed creation remains blocked on retry and can later reconcile without a second POST', async () => {
  let server;
  let visible = false;
  const save = await harness(async (method, path, body) => {
    assert.equal(path, dashboardsPath);
    if (method === 'POST') {
      server = created(body);
      throw Object.assign(new Error('Gateway timed out'), { status: 504 });
    }
    return visible ? { [server.id]: clone(server) } : {};
  });
  await assert.rejects(save.createDashboard({ name: 'Maybe created' }), (error) => error.creationUncertain === true);
  await assert.rejects(save.createDashboard({ name: 'Maybe created' }), (error) => error.creationUncertain === true);
  assert.deepEqual(save.calls.map(({ method }) => method), ['POST', 'GET', 'GET']);
  assert.deepEqual(save.events, []);
  visible = true;
  const result = await save.createDashboard({ name: 'Maybe created' });
  assert.deepEqual(result, server);
  assert.equal(save.calls.filter(({ method }) => method === 'POST').length, 1);
  assert.deepEqual(save.events, [server]);
});

test('concurrent submissions share one creation and late replies cannot affect a replacement connection', async () => {
  let finishPost;
  let started;
  const posting = new Promise((resolve) => { started = resolve; });
  const save = await harness(async (method, path, body) => {
    assert.equal(method, 'POST'); assert.equal(path, dashboardsPath);
    started();
    return new Promise((resolve) => { finishPost = () => resolve(created(body)); });
  });
  const first = save.createDashboard({ name: 'Once' });
  const second = save.createDashboard({ name: 'Once' });
  assert.equal(first, second);
  await posting;
  save.state.client = { api: () => assert.fail('old creation must not use the new connection') };
  finishPost();
  await assert.rejects(first, /connection changed/);
  assert.equal(save.calls.length, 1);
  assert.deepEqual(save.events, []);
});

test('a missing or disconnected copy source cannot create a stale dashboard and a later retry remains usable', async () => {
  let missing = true;
  const save = await harness(async (method, path, body) => {
    if (method === 'GET') {
      if (missing) throw Object.assign(new Error('Not found'), { status: 404 });
      return nativeDashboard();
    }
    return created(body);
  });
  await assert.rejects(save.createDashboard({ name: 'Copy', sourceId: dashboardId }), /deleted meanwhile/);
  assert.equal(save.calls.filter(({ method }) => method === 'POST').length, 0);
  missing = false;
  const result = await save.createDashboard({ name: 'Copy', sourceId: dashboardId });
  assert.equal(result.name, 'Copy');

  let finishRead;
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  const other = await harness(async () => { started(); return new Promise((resolve) => { finishRead = resolve; }); });
  const copying = other.createDashboard({ name: 'Abandoned copy', sourceId: dashboardId });
  await reading;
  other.state.client = null;
  finishRead(nativeDashboard());
  await assert.rejects(copying, /connection changed/);
  assert.equal(other.calls.length, 1);
  assert.deepEqual(other.events, []);
});

test('column and widget additions serialize latest native layouts and keep caller templates independent', async () => {
  let server = nativeDashboard();
  const save = await harness(async (method, path, body) => {
    assert.equal(path, dashboardPath);
    if (method === 'GET') return clone(server);
    server = { ...server, ...clone(body) };
    server.name = 'Mobile renamed';
    return clone(server);
  });
  const template = { id: 'must-not-share', type: 'note', title: 'New', data: { color: 'blue', future: { keep: true } } };
  const addingColumn = save.addDashboardColumn(dashboardId);
  const addingWidget = save.addDashboardWidget(dashboardId, 'native-column', template);
  template.data.future.keep = false;
  await Promise.all([addingColumn, addingWidget]);
  assert.equal(server.name, 'Mobile renamed');
  assert.equal(server.columns.length, 2);
  assert.match(server.columns[1].id, uuid);
  assert.deepEqual(server.columns[1].widgets, []);
  const widget = server.columns[0].widgets.at(-1);
  assert.match(widget.id, uuid);
  assert.deepEqual(widget.data.future, { keep: true });
  assert.equal(template.id, 'must-not-share');
  assert.deepEqual(save.calls.map(({ method }) => method), ['GET', 'PUT', 'GET', 'PUT']);
  assert.deepEqual(save.events, [server]);
  nativeOnly(save.calls);
});

test('a removed target column cancels widget addition and leaves the queue ready for a new column', async () => {
  let server = nativeDashboard();
  server.columns[0].id = 'changed-on-mobile';
  const save = await harness(async (method, path, body) => {
    if (method === 'GET') return clone(server);
    server = { ...server, ...clone(body) };
    return clone(server);
  });
  await assert.rejects(save.addDashboardWidget(dashboardId, 'native-column', { type: 'note', data: {} }), /column was removed/);
  assert.equal(save.calls.filter(({ method }) => method === 'PUT').length, 0);
  await save.addDashboardColumn(dashboardId);
  assert.equal(server.columns.length, 2);
  assert.equal(save.isSaving(dashboardId), false);
  nativeOnly(save.calls);
});
