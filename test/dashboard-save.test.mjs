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

function gridDashboard() {
  const dashboard = nativeDashboard();
  dashboard.columns[0].widgets.push({ id: 'camera', type: 'device_camera_live', title: 'Camera', titleHidden: false,
    data: { deviceId: 'camera-device', deviceVideoId: 'main', autoplay: true, futureSetting: { keep: true } } });
  dashboard.columns.push({ id: 'second-column', nativeColumnData: { keep: true }, widgets: [
    { id: 'second-note', type: 'note', data: { color: 'blue' } },
    { id: 'third-note', type: 'note', data: { color: 'yellow' } },
  ] }, { id: 'empty-column', widgets: [] });
  return dashboard;
}

async function gridHarness({ initial = gridDashboard(), intercept } = {}) {
  let server = clone(initial);
  const save = await harness(async (method, path, body) => {
    assert.equal(path, dashboardPath);
    const result = await intercept?.({ method, body, get server() { return server; }, set server(value) { server = value; } });
    if (result !== undefined) return result;
    if (method === 'GET') return clone(server);
    assert.equal(method, 'PUT');
    server = { ...server, ...clone(body) };
    return clone(server);
  }, initial);
  return { ...save, get server() { return server; }, editMobile(mutate) { mutate(server); } };
}

const widgetIds = (dashboard, columnId) => dashboard.columns.find((column) => column.id === columnId)?.widgets.map((widget) => widget.id);

test('a grid drop follows current column identities and preserves camera identity, unknown fields, and mobile edits', async () => {
  const save = await gridHarness();
  const camera = clone(save.server.columns[0].widgets[2]);
  const unknown = clone(save.server.columns[0].widgets[1]);
  save.editMobile((server) => {
    server.name = 'Renamed on phone during drag';
    server.columns.reverse();
    server.columns.find((column) => column.id === 'second-column').widgets.unshift({ id: 'mobile-first', type: 'future', retained: true });
    server.columns.find((column) => column.id === 'native-column').widgets[0].title = 'Mobile temperature';
  });

  await save.moveDashboardWidget(dashboardId, 'camera', 'second-column', 'third-note');

  assert.deepEqual(widgetIds(save.server, 'second-column'), ['mobile-first', 'second-note', 'camera', 'third-note']);
  assert.deepEqual(widgetIds(save.server, 'native-column'), ['temperature', 'future-widget']);
  const actualCamera = save.server.columns.find((column) => column.id === 'second-column').widgets[2];
  assert.deepEqual(actualCamera, camera, 'moving never generates a new widget/store identity or edits camera playback');
  assert.equal(save.server.name, 'Renamed on phone during drag');
  assert.deepEqual(save.server.mobileMetadata, { preserve: true });
  assert.deepEqual(save.server.columns.find((column) => column.id === 'native-column').widgets[1], unknown);
  assert.equal(save.server.columns.find((column) => column.id === 'native-column').widgets[0].title, 'Mobile temperature');
  assert.deepEqual(save.server.columns.find((column) => column.id === 'second-column').nativeColumnData, { keep: true });
  nativeOnly(save.calls);
});

test('same-column drops reorder in both directions and append correctly without stale index arithmetic', async () => {
  const save = await gridHarness();
  await save.moveDashboardWidget(dashboardId, 'camera', 'native-column', 'temperature');
  assert.deepEqual(widgetIds(save.server, 'native-column'), ['camera', 'temperature', 'future-widget']);
  await save.moveDashboardWidget(dashboardId, 'camera', 'native-column', 'future-widget');
  assert.deepEqual(widgetIds(save.server, 'native-column'), ['temperature', 'camera', 'future-widget']);
  await save.moveDashboardWidget(dashboardId, 'temperature', 'native-column');
  assert.deepEqual(widgetIds(save.server, 'native-column'), ['camera', 'future-widget', 'temperature']);
  assert.equal(save.calls.filter(({ method }) => method === 'PUT').length, 3);
  nativeOnly(save.calls);
});

test('dropping on itself, its existing next sibling, or the existing end does not write', async () => {
  const save = await gridHarness();
  const original = clone(save.server);
  await save.moveDashboardWidget(dashboardId, 'temperature', 'native-column', 'temperature');
  await save.moveDashboardWidget(dashboardId, 'temperature', 'native-column', 'future-widget');
  await save.moveDashboardWidget(dashboardId, 'camera', 'native-column');
  assert.deepEqual(save.server, original);
  assert.deepEqual(save.calls.map(({ method }) => method), ['GET', 'GET', 'GET']);
  assert.equal(save.isSaving(dashboardId), false);
});

test('a camera drops into an empty column without duplicating or changing any widget instance', async () => {
  const save = await gridHarness();
  const originalWidgets = save.server.columns.flatMap((column) => column.widgets);
  await save.moveDashboardWidget(dashboardId, 'camera', 'empty-column');
  assert.deepEqual(widgetIds(save.server, 'empty-column'), ['camera']);
  const resultingWidgets = save.server.columns.flatMap((column) => column.widgets);
  assert.equal(resultingWidgets.length, originalWidgets.length);
  assert.equal(new Set(resultingWidgets.map(({ id }) => id)).size, originalWidgets.length);
  for (const original of originalWidgets) assert.deepEqual(resultingWidgets.find(({ id }) => id === original.id), original);
});

test('missing drag source, target, or moved anchor refuses the drop and leaves subsequent saves usable', async () => {
  const save = await gridHarness();
  await assert.rejects(save.moveDashboardWidget(dashboardId, 'removed-widget', 'second-column'), /widget was removed/);
  await assert.rejects(save.moveDashboardWidget(dashboardId, 'camera', 'removed-column'), /destination column was removed/);
  await assert.rejects(save.moveDashboardWidget(dashboardId, 'camera', 'second-column', 'missing-anchor'), /drop position moved or was removed/);
  await assert.rejects(save.moveDashboardWidget(dashboardId, 'camera', 'second-column', 'camera'), /drop position moved or was removed/);
  assert.equal(save.calls.filter(({ method }) => method === 'PUT').length, 0);
  await save.moveDashboardWidget(dashboardId, 'camera', 'second-column', 'second-note');
  assert.deepEqual(widgetIds(save.server, 'second-column'), ['camera', 'second-note', 'third-note']);
  assert.equal(save.isSaving(dashboardId), false);
});

test('queued drops resolve their positions after preceding saves and retain intervening mobile widgets', async () => {
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  let writes = 0;
  const save = await gridHarness({ intercept: async (request) => {
    if (request.method !== 'PUT') return;
    writes += 1;
    if (writes === 1) {
      firstStarted();
      await gate;
      request.server = { ...request.server, ...clone(request.body) };
      request.server.columns.find((column) => column.id === 'second-column').widgets.push({ id: 'phone-new', type: 'future', data: { keep: true } });
      return clone(request.server);
    }
  } });
  const first = save.moveDashboardWidget(dashboardId, 'camera', 'second-column');
  await started;
  const second = save.moveDashboardWidget(dashboardId, 'temperature', 'second-column', 'camera');
  assert.deepEqual(save.calls.map(({ method }) => method), ['GET', 'PUT']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(widgetIds(save.server, 'second-column'), ['second-note', 'third-note', 'temperature', 'camera', 'phone-new']);
  assert.deepEqual(save.calls.map(({ method }) => method), ['GET', 'PUT', 'GET', 'PUT']);
  assert.deepEqual(save.events, [save.server], 'only the last queued native state is announced');
});

test('a drop refusal can be explicitly retried and an ambiguous completed drop is never automatically replayed', async () => {
  let denied = true;
  const save = await gridHarness({ intercept: async ({ method }) => {
    if (method === 'PUT' && denied) throw Object.assign(new Error('Forbidden'), { status: 403 });
  } });
  await assert.rejects(save.moveDashboardWidget(dashboardId, 'camera', 'second-column'), { message: save.NO_EDIT_PERMISSION });
  assert.equal(save.calls.filter(({ method }) => method === 'PUT').length, 1);
  assert.deepEqual(widgetIds(save.server, 'native-column'), ['temperature', 'future-widget', 'camera']);
  denied = false;
  await save.moveDashboardWidget(dashboardId, 'camera', 'second-column');
  assert.equal(save.calls.filter(({ method }) => method === 'PUT').length, 2);

  const ambiguous = await gridHarness({ intercept: async (request) => {
    if (request.method !== 'PUT') return;
    request.server = { ...request.server, ...clone(request.body) };
    throw Object.assign(new Error('Response lost after save'), { status: 504 });
  } });
  await assert.rejects(ambiguous.moveDashboardWidget(dashboardId, 'camera', 'second-column'), /Response lost/);
  assert.equal(ambiguous.calls.filter(({ method }) => method === 'PUT').length, 1);
  await ambiguous.moveDashboardWidget(dashboardId, 'camera', 'second-column');
  assert.equal(ambiguous.calls.filter(({ method }) => method === 'PUT').length, 1, 'retry recognizes the completed position from a fresh read');
  assert.equal(widgetIds(ambiguous.server, 'second-column').filter((id) => id === 'camera').length, 1);
});

test('a confirmed empty column removes only that column and retains every native widget', async () => {
  const save = await gridHarness();
  const original = clone(save.server);
  await save.removeDashboardColumn(dashboardId, 'empty-column', { expectedWidgetIds: [] });
  assert.deepEqual(save.server.columns, original.columns.slice(0, 2));
  assert.deepEqual(save.server.mobileMetadata, original.mobileMetadata);
  nativeOnly(save.calls);
});

test('removing a populated column appends its latest widgets intact to the chosen column', async () => {
  const save = await gridHarness();
  const confirmed = widgetIds(save.server, 'native-column');
  save.editMobile((server) => {
    server.columns[0].widgets.reverse();
    server.columns[0].widgets[0].data.updatedOnPhone = 'retained';
    server.columns[1].widgets.push({ id: 'phone-addition', type: 'future', unknown: { keep: true } });
  });
  const expectedSourceWidgets = clone(save.server.columns[0].widgets);
  const targetBefore = clone(save.server.columns[1]);
  await save.removeDashboardColumn(dashboardId, 'native-column', { targetColumnId: 'second-column', expectedWidgetIds: confirmed });
  assert.equal(save.server.columns.some(({ id }) => id === 'native-column'), false);
  const target = save.server.columns.find(({ id }) => id === 'second-column');
  assert.deepEqual(target.widgets, [...targetBefore.widgets, ...expectedSourceWidgets]);
  assert.deepEqual(target.nativeColumnData, targetBefore.nativeColumnData);
  assert.deepEqual(save.server.mobileMetadata, { preserve: true });
  assert.equal(new Set(save.server.columns.flatMap(({ widgets }) => widgets.map(({ id }) => id))).size, 6);
  nativeOnly(save.calls);
});

test('column membership changes require a new confirmation, including a formerly empty column receiving a widget', async () => {
  const save = await gridHarness();
  const confirmed = widgetIds(save.server, 'native-column');
  save.editMobile((server) => server.columns[0].widgets.push({ id: 'phone-camera', type: 'device_camera_live', data: { autoplay: true } }));
  await assert.rejects(save.removeDashboardColumn(dashboardId, 'native-column', { targetColumnId: 'second-column', expectedWidgetIds: confirmed }), /widgets in this column changed/);
  save.editMobile((server) => server.columns.find(({ id }) => id === 'empty-column').widgets.push({ id: 'phone-note', type: 'note' }));
  await assert.rejects(save.removeDashboardColumn(dashboardId, 'empty-column', { expectedWidgetIds: [] }), /widgets in this column changed/);
  assert.equal(save.calls.filter(({ method }) => method === 'PUT').length, 0);
  assert.equal(save.isSaving(dashboardId), false);
});

test('column removal rejects vanished columns, missing or self destinations, and the last remaining column', async () => {
  const save = await gridHarness();
  const confirmed = widgetIds(save.server, 'native-column');
  await assert.rejects(save.removeDashboardColumn(dashboardId, 'gone', { expectedWidgetIds: [] }), /column was removed/);
  for (const targetColumnId of [null, 'gone', 'native-column']) {
    await assert.rejects(save.removeDashboardColumn(dashboardId, 'native-column', { targetColumnId, expectedWidgetIds: confirmed }), /Choose another existing column/);
  }
  assert.equal(save.calls.filter(({ method }) => method === 'PUT').length, 0);
  const last = await gridHarness({ initial: nativeDashboard() });
  await assert.rejects(last.removeDashboardColumn(dashboardId, 'native-column', { targetColumnId: 'other', expectedWidgetIds: ['temperature', 'future-widget'] }), /Keep at least one column/);
  assert.equal(last.calls.filter(({ method }) => method === 'PUT').length, 0);
});

test('column removal snapshots confirmation arguments and recovers after a denied save without losing widgets', async () => {
  let denied = true;
  const save = await gridHarness({ intercept: async ({ method }) => {
    if (method === 'PUT' && denied) throw Object.assign(new Error('Forbidden'), { status: 403 });
  } });
  const expectedWidgetIds = widgetIds(save.server, 'native-column');
  const refused = save.removeDashboardColumn(dashboardId, 'native-column', { targetColumnId: 'second-column', expectedWidgetIds });
  expectedWidgetIds.length = 0;
  await assert.rejects(refused, { message: save.NO_EDIT_PERMISSION });
  assert.equal(save.server.columns.length, 3);
  assert.equal(save.calls.filter(({ method }) => method === 'PUT').length, 1, 'caller mutation does not alter the confirmed set');
  denied = false;
  await save.removeDashboardColumn(dashboardId, 'native-column', { targetColumnId: 'second-column', expectedWidgetIds: widgetIds(save.server, 'native-column') });
  assert.deepEqual(widgetIds(save.server, 'second-column'), ['second-note', 'third-note', 'temperature', 'future-widget', 'camera']);
  assert.equal(save.isSaving(dashboardId), false);
});

test('layout moves and removals reject read-only permissions and invalid confirmations before any writes', async () => {
  const save = await harness(async () => ({ scopes: ['homey.dashboard.readonly'] }));
  await save.loadKeyScopes();
  assert.throws(() => save.moveDashboardWidget(dashboardId, 'camera', 'second-column'), { message: save.NO_EDIT_PERMISSION });
  assert.throws(() => save.removeDashboardColumn(dashboardId, 'empty-column', { expectedWidgetIds: [] }), { message: save.NO_EDIT_PERMISSION });
  assert.equal(save.calls.length, 1);
  const editable = await gridHarness();
  assert.throws(() => editable.moveDashboardWidget(dashboardId, '', 'second-column'), /Choose a widget/);
  assert.throws(() => editable.moveDashboardWidget(dashboardId, 'camera', 'second-column', ''), /Choose a widget/);
  assert.throws(() => editable.removeDashboardColumn(dashboardId, 'empty-column'), /Reopen Remove column/);
  assert.throws(() => editable.removeDashboardColumn(dashboardId, 'empty-column', { expectedWidgetIds: ['camera', 'camera'] }), /Reopen Remove column/);
  assert.equal(editable.calls.length, 0);
});

test('pending layout mutations never write or announce after the Homey connection changes', async () => {
  for (const action of ['move', 'remove']) {
    let finishRead;
    let started;
    const reading = new Promise((resolve) => { started = resolve; });
    const save = await gridHarness({ intercept: async ({ method }) => {
      assert.equal(method, 'GET');
      started();
      return new Promise((resolve) => { finishRead = resolve; });
    } });
    const saving = action === 'move' ? save.moveDashboardWidget(dashboardId, 'camera', 'second-column')
      : save.removeDashboardColumn(dashboardId, 'empty-column', { expectedWidgetIds: [] });
    await reading;
    save.state.client = { api: () => assert.fail('old layout operation must not use a replacement connection') };
    finishRead(gridDashboard());
    await assert.rejects(saving, /connection changed/);
    assert.equal(save.calls.length, 1);
    assert.deepEqual(save.events, []);
    assert.equal(save.isSaving(dashboardId), false);
  }
});

test('an anchor moved to another column during a drag cancels that stale drop', async () => {
  const save = await gridHarness();
  save.editMobile((server) => {
    const moved = server.columns[1].widgets.pop();
    server.columns[2].widgets.push(moved);
  });
  const latest = clone(save.server);
  await assert.rejects(save.moveDashboardWidget(dashboardId, 'camera', 'second-column', 'third-note'), /drop position moved or was removed/);
  assert.deepEqual(save.server, latest);
  assert.equal(save.calls.filter(({ method }) => method === 'PUT').length, 0);
});

test('permissions revoked while a layout read is pending prevent the resulting write', async () => {
  let finishRead;
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  const save = await harness(async (method, path) => {
    if (path === '/api/manager/sessions/session/me') return { scopes: ['homey.dashboard.readonly'] };
    assert.equal(path, dashboardPath);
    assert.equal(method, 'GET', 'a newly refused layout operation must not reach PUT');
    started();
    return new Promise((resolve) => { finishRead = resolve; });
  }, gridDashboard());
  const moving = save.moveDashboardWidget(dashboardId, 'camera', 'second-column');
  await reading;
  await save.loadKeyScopes();
  finishRead(gridDashboard());
  await assert.rejects(moving, { message: save.NO_EDIT_PERMISSION });
  assert.equal(save.calls.filter(({ method }) => method === 'PUT').length, 0);
  assert.equal(save.isSaving(dashboardId), false);
  assert.deepEqual(save.events, []);
});

test('an uncertain completed column removal never retries the write or loses its transferred widgets', async () => {
  const save = await gridHarness({ intercept: async (request) => {
    if (request.method !== 'PUT') return;
    request.server = { ...request.server, ...clone(request.body) };
    throw Object.assign(new Error('Response lost after removal'), { status: 504 });
  } });
  const original = save.server.columns.flatMap(({ widgets }) => clone(widgets));
  const options = { targetColumnId: 'second-column', expectedWidgetIds: widgetIds(save.server, 'native-column') };
  await assert.rejects(save.removeDashboardColumn(dashboardId, 'native-column', options), /Response lost after removal/);
  assert.equal(save.calls.filter(({ method }) => method === 'PUT').length, 1);
  assert.equal(save.server.columns.some(({ id }) => id === 'native-column'), false);
  const remaining = save.server.columns.flatMap(({ widgets }) => widgets);
  for (const widget of original) assert.deepEqual(remaining.find(({ id }) => id === widget.id), widget);
  await assert.rejects(save.removeDashboardColumn(dashboardId, 'native-column', options), /column was removed/);
  assert.equal(save.calls.filter(({ method }) => method === 'PUT').length, 1);
  assert.equal(save.isSaving(dashboardId), false);
});
