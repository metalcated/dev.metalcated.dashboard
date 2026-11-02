import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/web/js/widget-sizes.js', import.meta.url), 'utf8');
const clone = (value) => structuredClone(value);
const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
};

async function harness({ api, editable = true, stored = {} } = {}) {
  let server = clone(stored);
  const calls = [], listeners = [], changes = [];
  const state = { config: { appId: 'dev.schweiger.dashboard' }, client: null, dashboards: {
    board: { id: 'board', columns: [{ id: 'column', widgets: [{ id: 'camera' }, { id: 'note' }] }] },
  } };
  const defaultApi = async (method, path, body) => {
    if (method === 'GET') return clone(server);
    const id = decodeURIComponent(path.split('/').at(-1));
    if (body.size == null) delete server[id]; else server[id] = clone(body.size);
    return clone(server);
  };
  const client = { token: 'opaque-fixture-session', async api(method, path, body) {
    calls.push({ method, path, body: body == null ? body : clone(body) });
    return (api ?? defaultApi)(method, path, body);
  } };
  state.client = client;
  const imports = {
    './config.js': { APP_ID: null },
    './dashboard-save.js': { NO_EDIT_PERMISSION: 'Read-only dashboard.', canEditDashboards: () => editable },
    './realtime.js': { subscribe(uri, event, callback) {
      const listener = { uri, event, callback, closed: false }; listeners.push(listener);
      return () => { listener.closed = true; };
    } },
    './state.js': { state },
  };
  const context = vm.createContext({});
  const module = new vm.SourceTextModule(source, { context });
  await module.link((specifier) => new vm.SyntheticModule(Object.keys(imports[specifier]), function () {
    for (const [key, value] of Object.entries(imports[specifier])) this.setExport(key, value);
  }, { context }));
  await module.evaluate();
  const sizes = module.namespace;
  const stop = sizes.watchWidgetSizes((ids) => changes.push([...ids]));
  return { sizes, state, client, calls, changes, listeners, stop,
    get server() { return server; },
    setEditable(value) { editable = value; },
    announce(next) { for (const listener of listeners) if (!listener.closed) listener.callback(clone(next)); },
  };
}

test('sizes load from Homey and realtime updates announce only changed widget identities', async () => {
  const view = await harness({ stored: { camera: { width: 240, height: 180 } } });
  assert.equal(await view.sizes.loadWidgetSizes(), true);
  assert.deepEqual(clone(view.sizes.widgetSize('camera')), { width: 240, height: 180 });
  assert.deepEqual(view.calls.map(({ method, path }) => [method, path]), [['GET', '/api/app/dev.schweiger.dashboard/widget-sizes']]);
  assert.equal(view.listeners[0].uri, 'homey:app:dev.schweiger.dashboard');
  assert.equal(view.listeners[0].event, 'widget-sizes');
  assert.deepEqual(view.changes, [['camera']]);
  view.announce({ camera: { width: 240, height: 180 } });
  assert.equal(view.changes.length, 1);
  view.announce({ camera: { width: 360, height: 280 }, note: { width: 200, height: 200 } });
  assert.deepEqual(view.changes.at(-1), ['camera', 'note']);
  view.announce({ note: { width: 200, height: 200 } });
  assert.deepEqual(view.changes.at(-1), ['camera']);
});

test('malformed remote sizes never become CSS dimensions and returned values cannot mutate the cache', async () => {
  const view = await harness({ stored: {
    camera: { width: 240, height: 180 }, note: { width: '100%', height: 200 }, bad: { width: 999, height: 100 },
    negative: { width: -20, height: 180 }, fractional: { width: 241, height: 180 },
  } });
  await view.sizes.loadWidgetSizes();
  assert.equal(view.sizes.widgetSize('note'), null);
  assert.equal(view.sizes.widgetSize('bad'), null);
  assert.equal(view.sizes.widgetSize('negative'), null);
  assert.equal(view.sizes.widgetSize('fractional'), null);
  const camera = view.sizes.widgetSize('camera'); camera.width = 120;
  assert.equal(view.sizes.widgetSize('camera').width, 240);
});

test('preview styling changes only section properties and restores native size without remounting content', async () => {
  const view = await harness({ stored: { camera: { width: 240, height: 180 } } });
  await view.sizes.loadWidgetSizes();
  const classes = new Set(); const styles = new Map(); const video = {};
  const section = { children: [video], classList: { toggle(name, value) { value ? classes.add(name) : classes.delete(name); } },
    style: { setProperty: (name, value) => styles.set(name, value), removeProperty: (name) => styles.delete(name) } };
  view.sizes.applyWidgetSize(section, 'camera');
  assert.equal(classes.has('has-web-size'), true);
  assert.ok(Math.abs(parseFloat(styles.get('--web-widget-width')) - 66.6666667) < 0.0001);
  assert.equal(styles.get('--web-widget-ratio'), '240 / 180');
  view.sizes.applyWidgetSize(section, 'camera', { width: 300, height: 220 });
  assert.equal(styles.get('--web-widget-ratio'), '300 / 220');
  assert.equal(view.sizes.widgetSize('camera').width, 240, 'a preview is not a saved preference');
  view.sizes.applyWidgetSize(section, 'camera', null);
  assert.equal(classes.has('has-web-size'), false);
  assert.equal(styles.size, 0);
  assert.equal(section.children[0], video);
  assert.equal(view.calls.length, 1, 'applying CSS does not issue writes');
});

test('saving snaps and clamps to the web grid through the scoped endpoint, and reset removes the override', async () => {
  const view = await harness();
  await view.sizes.loadWidgetSizes();
  await view.sizes.saveWidgetSize('camera', { width: 477, height: 97 });
  assert.deepEqual(view.calls.at(-1), { method: 'PUT', path: '/api/app/dev.schweiger.dashboard/widget-sizes/camera',
    body: { token: 'opaque-fixture-session', size: { width: 360, height: 100 } } });
  assert.deepEqual(clone(view.sizes.widgetSize('camera')), { width: 360, height: 100 });
  assert.deepEqual(view.changes.at(-1), ['camera']);
  await view.sizes.saveWidgetSize('camera', null);
  assert.equal(view.calls.at(-1).body.size, null);
  assert.equal(view.sizes.hasCustomWidgetSize('camera'), false);
});

test('readonly, missing widgets, and invalid dimensions fail before any preference write', async () => {
  const view = await harness();
  view.setEditable(false);
  assert.throws(() => view.sizes.saveWidgetSize('camera', { width: 200, height: 200 }), /Read-only/);
  view.setEditable(true);
  assert.throws(() => view.sizes.saveWidgetSize('missing', { width: 200, height: 200 }), /removed/);
  for (const size of [undefined, [], { width: NaN, height: 200 }, { width: '200', height: 200 }]) {
    assert.throws(() => view.sizes.saveWidgetSize('camera', size), /valid widget size/);
  }
  assert.equal(view.calls.length, 0);
});

test('queued saves serialize their latest acknowledgement and remain usable after a refused save', async () => {
  const pending = deferred(); let attempts = 0;
  const view = await harness({ api: async (method, path, body) => {
    if (++attempts === 1) return pending.promise;
    return { camera: body.size };
  } });
  const first = view.sizes.saveWidgetSize('camera', { width: 200, height: 200 });
  const second = view.sizes.saveWidgetSize('camera', { width: 280, height: 220 });
  await Promise.resolve();
  assert.equal(view.calls.length, 1);
  pending.reject(new Error('Homey refused this size.'));
  await assert.rejects(first, /refused/); await second;
  assert.equal(view.calls.length, 2);
  assert.deepEqual(clone(view.sizes.widgetSize('camera')), { width: 280, height: 220 });
});

test('loading and event replies from a replaced connection cannot expose old preferences', async () => {
  const pending = deferred();
  const view = await harness({ api: () => pending.promise });
  const loading = view.sizes.loadWidgetSizes();
  view.state.client = { token: 'replacement' };
  pending.resolve({ camera: { width: 240, height: 180 } });
  assert.equal(await loading, false);
  view.announce({ camera: { width: 240, height: 180 } });
  assert.equal(view.sizes.widgetSize('camera'), null);
  assert.deepEqual(view.changes, []);
});

test('a delayed initial read cannot erase a newer realtime size map on the same connection', async () => {
  const pending = deferred();
  const view = await harness({ api: () => pending.promise });
  const loading = view.sizes.loadWidgetSizes();
  view.announce({ camera: { width: 280, height: 220 } });
  pending.resolve({});
  assert.equal(await loading, true);
  assert.deepEqual(clone(view.sizes.widgetSize('camera')), { width: 280, height: 220 });
  assert.deepEqual(view.changes, [['camera']]);
});

test('an older PUT full map is reconciled without erasing another browser’s observed preference', async () => {
  const pending = deferred();
  const authoritative = { camera: { width: 280, height: 220 }, note: { width: 200, height: 180 } };
  const view = await harness({ api: async (method) => method === 'PUT' ? pending.promise : clone(authoritative) });
  const saving = view.sizes.saveWidgetSize('camera', authoritative.camera);
  await Promise.resolve();
  view.announce(authoritative);
  pending.resolve({ camera: authoritative.camera });
  await saving;
  assert.deepEqual(clone(view.sizes.widgetSize('note')), authoritative.note);
  assert.deepEqual(view.calls.map((call) => call.method), ['PUT', 'GET']);
  assert.equal(view.calls.filter((call) => call.method === 'PUT').length, 1, 'reconciliation only reads; it never repeats a write');
});

test('a realtime event arriving during post-save reconciliation also wins over the older read', async () => {
  const pendingPut = deferred(), pendingRead = deferred();
  const view = await harness({ api: (method) => method === 'PUT' ? pendingPut.promise : pendingRead.promise });
  const saving = view.sizes.saveWidgetSize('camera', { width: 280, height: 220 });
  await Promise.resolve();
  view.announce({ camera: { width: 280, height: 220 }, note: { width: 200, height: 180 } });
  pendingPut.resolve({ camera: { width: 280, height: 220 } });
  while (view.calls.length < 2) await Promise.resolve();
  const newest = { camera: { width: 280, height: 220 }, note: { width: 320, height: 260 } };
  view.announce(newest);
  pendingRead.resolve({ camera: { width: 280, height: 220 }, note: { width: 200, height: 180 } });
  await saving;
  assert.deepEqual(clone(view.sizes.widgetSize('note')), newest.note);
});

test('a connection replacement or removed widget cannot apply a pending saved size or issue its queued write', async () => {
  const pending = deferred();
  const view = await harness({ api: () => pending.promise });
  const first = view.sizes.saveWidgetSize('camera', { width: 240, height: 180 });
  const second = view.sizes.saveWidgetSize('note', { width: 200, height: 200 });
  await Promise.resolve();
  view.state.client = {};
  pending.resolve({ camera: { width: 240, height: 180 } });
  await assert.rejects(first, /connection changed/);
  await assert.rejects(second, /connection changed/);
  assert.equal(view.calls.length, 1);
  assert.equal(view.sizes.widgetSize('camera'), null);
});

test('unsubscribing a size watcher stops its announcements without touching the persisted preferences', async () => {
  const view = await harness({ stored: { camera: { width: 240, height: 180 } } });
  await view.sizes.loadWidgetSizes();
  view.stop();
  view.announce({ camera: { width: 300, height: 300 } });
  assert.deepEqual(clone(view.sizes.widgetSize('camera')), { width: 240, height: 180 });
  assert.equal(view.changes.length, 1);
});
