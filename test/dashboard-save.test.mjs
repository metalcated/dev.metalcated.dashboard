import assert from 'node:assert/strict';
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
